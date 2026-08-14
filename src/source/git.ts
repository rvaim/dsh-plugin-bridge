import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type { InstallSource } from '../types/source.js'
import { writeExclusive } from './filesystem.js'
import { runProcess, runProcessBuffer } from './process.js'
import { validateGitRef } from './resolver.js'
import {
  DEFAULT_EXTRACTION_LIMITS,
  normalizeArchivePath,
  validateSymlinkTarget,
  verifyExtractedTree,
} from './safety.js'

export interface GitFetchResult {
  source: Extract<InstallSource, { type: 'git' }>
}

interface GitTreeEntry {
  mode: string
  type: string
  object: string
  path: string
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function parseTree(buffer: Buffer): GitTreeEntry[] {
  const entries: GitTreeEntry[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = buffer.indexOf(0, offset)
    if (end < 0) throw new Error('Git ls-tree 输出缺少 NUL 分隔符')
    if (end === offset) {
      offset += 1
      continue
    }
    const record = buffer.subarray(offset, end)
    offset = end + 1
    const tab = record.indexOf(0x09)
    if (tab < 0) throw new Error('Git ls-tree 记录缺少路径分隔符')
    const header = record.subarray(0, tab).toString('ascii').split(' ')
    if (header.length !== 3) throw new Error('Git ls-tree 记录头无效')
    let path: string
    try {
      path = utf8.decode(record.subarray(tab + 1))
    } catch {
      throw new Error('Git 仓库包含非 UTF-8 路径，当前无法安全安装')
    }
    entries.push({ mode: header[0], type: header[1], object: header[2], path })
  }
  return entries
}

async function readBlob(repository: string, object: string, name: string): Promise<Buffer> {
  const sizeText = (await runProcess('git', ['-C', repository, 'cat-file', '-s', object], {
    timeoutMs: 30_000,
  })).stdout.trim()
  const size = Number(sizeText)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Git 对象大小无效：${name}`)
  if (size > DEFAULT_EXTRACTION_LIMITS.maxFileBytes) throw new Error(`Git 文件过大：${name}`)
  const result = await runProcessBuffer('git', ['-C', repository, 'cat-file', 'blob', object], {
    timeoutMs: 120_000,
    maxOutputBytes: size + 1024 * 1024,
  })
  if (result.stdout.length !== size) throw new Error(`Git 对象大小不匹配：${name}`)
  return result.stdout
}

/**
 * 从 Git 对象数据库静态导出插件，不创建工作区 checkout。
 *
 * 不使用 checkout 或 git archive，是为了避免 .gitattributes 过滤器、smudge
 * 驱动或归档属性触发用户环境中的外部命令。导出后仍执行统一路径、符号链接、
 * 文件数量和体积限制检查。
 */
async function exportCommittedTree(repository: string, destination: string, revision: string): Promise<void> {
  const treeOutput = await runProcessBuffer('git', ['-C', repository, 'ls-tree', '-rz', '--full-tree', revision], {
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024 * 1024,
  })
  const entries = parseTree(treeOutput.stdout)
  if (entries.length > DEFAULT_EXTRACTION_LIMITS.maxEntries) {
    throw new Error(`Git 文件数量超过限制：${DEFAULT_EXTRACTION_LIMITS.maxEntries}`)
  }

  const seen = new Set<string>()
  const pendingLinks: Array<{ path: string; target: string }> = []
  let totalBytes = 0
  await mkdir(destination, { recursive: true, mode: 0o700 })

  for (const entry of entries) {
    const name = normalizeArchivePath(entry.path)
    if (name === '') continue
    if (seen.has(name)) throw new Error(`Git 树包含重复路径：${name}`)
    seen.add(name)
    if (entry.type === 'commit' || entry.mode === '160000') {
      throw new Error(`Git 子模块不会自动执行或递归获取，当前不能完整安装：${name}`)
    }
    if (entry.type !== 'blob') throw new Error(`Git 树包含不支持的对象类型 ${entry.type}：${name}`)

    const data = await readBlob(repository, entry.object, name)
    totalBytes += data.length
    if (totalBytes > DEFAULT_EXTRACTION_LIMITS.maxTotalBytes) {
      throw new Error(`Git 导出总大小超过限制：${DEFAULT_EXTRACTION_LIMITS.maxTotalBytes}`)
    }
    const outputPath = resolve(destination, name)
    if (entry.mode === '120000') {
      let target: string
      try {
        target = utf8.decode(data)
      } catch {
        throw new Error(`Git 符号链接目标不是 UTF-8：${name}`)
      }
      validateSymlinkTarget(destination, outputPath, target)
      pendingLinks.push({ path: outputPath, target })
    } else if (entry.mode === '100644' || entry.mode === '100755') {
      await writeExclusive(outputPath, data, entry.mode === '100755' ? 0o700 : 0o600)
    } else {
      throw new Error(`Git 文件模式不受支持 ${entry.mode}：${name}`)
    }
  }

  for (const link of pendingLinks) {
    await mkdir(dirname(link.path), { recursive: true, mode: 0o700 })
    await symlink(link.target, link.path)
  }
  await verifyExtractedTree(destination)
}

/** Git 获取只读取已提交内容，不运行 npm、构建脚本或仓库 checkout 过滤器。 */
export async function cloneGitPlugin(
  url: string,
  destination: string,
  ref?: string,
): Promise<GitFetchResult> {
  const staging = `${destination}.git-${randomUUID()}`
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  try {
    const safeRef = ref === undefined ? undefined : validateGitRef(ref)
    await runProcess('git', ['clone', '--no-tags', '--no-checkout', '--depth', '1', '--', url, staging], {
      timeoutMs: 120_000,
    })

    // clone --branch 只能可靠处理分支和标签；显式 fetch 还可解析远端允许获取的提交 SHA。
    const revision = safeRef === undefined ? 'HEAD' : 'FETCH_HEAD'
    if (safeRef !== undefined) {
      await runProcess('git', ['-C', staging, 'fetch', '--depth', '1', '--no-tags', '--', 'origin', safeRef], {
        timeoutMs: 120_000,
      })
    }
    const commit = (await runProcess('git', ['-C', staging, 'rev-parse', `${revision}^{commit}`])).stdout.trim()
    await exportCommittedTree(staging, destination, commit)
    return { source: { type: 'git', url, ...(safeRef === undefined ? {} : { ref: safeRef }), commit } }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
