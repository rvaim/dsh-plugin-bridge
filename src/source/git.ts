import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type { InstallSource } from '../types/source.js'
import { writeExclusive } from './filesystem.js'
import { runProcess, runProcessBuffer } from './process.js'
import { ProcessReader, runStreamingProcess, writeProcessInput } from './process-stream.js'
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

function parseTree(buffer: Buffer, signal?: AbortSignal): GitTreeEntry[] {
  const entries: GitTreeEntry[] = []
  let offset = 0
  while (offset < buffer.length) {
    signal?.throwIfAborted()
    const end = buffer.indexOf(0, offset)
    if (end < 0) throw new Error('Git ls-tree 输出缺少 NUL 分隔符')
    if (end === offset) { offset += 1; continue }
    const record = buffer.subarray(offset, end)
    offset = end + 1
    const tab = record.indexOf(0x09)
    if (tab < 0) throw new Error('Git ls-tree 记录缺少路径分隔符')
    const header = record.subarray(0, tab).toString('ascii').split(' ')
    if (header.length !== 3 || !/^[0-9a-f]{40,64}$/.test(header[2])) throw new Error('Git ls-tree 记录头无效')
    let path: string
    try { path = utf8.decode(record.subarray(tab + 1)) } catch {
      throw new Error('Git 仓库包含非 UTF-8 路径，当前无法安全安装')
    }
    entries.push({ mode: header[0], type: header[1], object: header[2], path })
    if (entries.length > DEFAULT_EXTRACTION_LIMITS.maxEntries) throw new Error(`Git 文件数量超过限制：${DEFAULT_EXTRACTION_LIMITS.maxEntries}`)
  }
  return entries
}

/** 对象导出不创建 checkout，不执行仓库脚本、smudge 或归档过滤器。 */
async function exportCommittedTree(repository: string, destination: string, revision: string, signal?: AbortSignal): Promise<void> {
  const treeOutput = await runProcessBuffer('git', ['-C', repository, 'ls-tree', '-rz', '--full-tree', revision], {
    timeoutMs: 120_000, maxOutputBytes: 64 * 1024 * 1024, signal,
  })
  const entries = parseTree(treeOutput.stdout, signal)
  const seen = new Set<string>()
  for (const entry of entries) {
    signal?.throwIfAborted()
    entry.path = normalizeArchivePath(entry.path)
    if (entry.path === '' || seen.has(entry.path)) throw new Error(`Git 树包含无效或重复路径：${entry.path}`)
    seen.add(entry.path)
    if (entry.type === 'commit' || entry.mode === '160000') throw new Error(`Git 子模块不会自动执行或递归获取，当前不能完整安装：${entry.path}`)
    if (entry.type !== 'blob') throw new Error(`Git 树包含不支持的对象类型 ${entry.type}：${entry.path}`)
    if (!['120000', '100644', '100755'].includes(entry.mode)) throw new Error(`Git 文件模式不受支持 ${entry.mode}：${entry.path}`)
  }

  const links: Array<{ path: string; target: string }> = []
  let totalBytes = 0
  // 每次只发送一个对象；流消费和落盘形成背压，重复对象也按对应文件计入预算。
  await runStreamingProcess('git', ['-C', repository, 'cat-file', '--batch'], { timeoutMs: 120_000, signal }, async ({ stdin, stdout, signal: taskSignal }) => {
    const reader = new ProcessReader(stdout, taskSignal)
    for (const entry of entries) {
      taskSignal.throwIfAborted()
      await writeProcessInput(stdin, `${entry.object}\n`)
      const header = await reader.line()
      const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header)
      if (match === null || match[1] !== entry.object) throw new Error(`Git batch 对象响应无效：${entry.path}`)
      const size = Number(match[2])
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Git 对象大小无效：${entry.path}`)
      if (size > DEFAULT_EXTRACTION_LIMITS.maxFileBytes) throw new Error(`Git 文件过大：${entry.path}`)
      totalBytes += size
      if (totalBytes > DEFAULT_EXTRACTION_LIMITS.maxTotalBytes) throw new Error(`Git 导出总大小超过限制：${DEFAULT_EXTRACTION_LIMITS.maxTotalBytes}`)
      const outputPath = resolve(destination, entry.path)
      if (entry.mode === '120000') {
        if (size > 64 * 1024) throw new Error(`Git 符号链接目标过长：${entry.path}`)
        const chunks: Buffer[] = []
        for await (const chunk of reader.chunks(size)) chunks.push(chunk)
        let target: string
        try { target = utf8.decode(Buffer.concat(chunks, size)) } catch {
          throw new Error(`Git 符号链接目标不是 UTF-8：${entry.path}`)
        }
        validateSymlinkTarget(destination, outputPath, target)
        links.push({ path: outputPath, target })
      } else {
        await writeExclusive(outputPath, reader.chunks(size), entry.mode === '100755' ? 0o700 : 0o600, taskSignal)
      }
      await reader.separator()
    }
    stdin.end()
    await reader.finish()
  })
  for (const link of links) {
    signal?.throwIfAborted()
    await mkdir(dirname(link.path), { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    await symlink(link.target, link.path)
  }
  await verifyExtractedTree(destination, signal)
}

/** 只解析远端提交，不导出工作树。 */
export async function probeGitSource(url: string, ref?: string, signal?: AbortSignal): Promise<Extract<InstallSource, { type: 'git' }>> {
  signal?.throwIfAborted()
  const safeRef = ref === undefined ? undefined : validateGitRef(ref)
  const wanted = safeRef ?? 'HEAD'
  const result = await runProcess('git', ['ls-remote', '--', url, wanted], { timeoutMs: 120_000, signal })
  let commit: string | undefined
  for (const line of result.stdout.trim().split('\n')) {
    signal?.throwIfAborted()
    const [sha, name] = line.trim().split(/\s+/, 2)
    if (sha === undefined || name === undefined || !/^[0-9a-f]{40,64}$/i.test(sha)) continue
    if (safeRef === undefined) { if (name === 'HEAD') commit = sha; continue }
    if (name === `${safeRef}^{}`) { commit = sha; break }
    if (name === safeRef || name === `refs/heads/${safeRef}` || name === `refs/tags/${safeRef}`) commit = sha
  }
  if (commit === undefined) throw new Error(`Git 来源未解析到提交 SHA：${wanted}`)
  return { type: 'git', url, ...(safeRef === undefined ? {} : { ref: safeRef }), commit }
}

/** Git 获取只读取已提交内容；失败或取消时等待进程退出再清理本次创建的目录。 */
export async function cloneGitPlugin(url: string, destination: string, ref?: string, signal?: AbortSignal): Promise<GitFetchResult> {
  signal?.throwIfAborted()
  const safeRef = ref === undefined ? undefined : validateGitRef(ref)
  // Git 会在 staging 内创建很深的 .git/objects 路径；Windows 下不能放在安装事务目录里。
  const staging = resolve(tmpdir(), `dsh-git-${randomUUID()}`)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  signal?.throwIfAborted()
  await mkdir(destination, { mode: 0o700 })
  try {
    signal?.throwIfAborted()
    await runProcess('git', ['clone', '--no-tags', '--no-checkout', '--depth', '1', '--', url, staging], { timeoutMs: 120_000, signal })
    const revision = safeRef === undefined ? 'HEAD' : 'FETCH_HEAD'
    if (safeRef !== undefined) await runProcess('git', ['-C', staging, 'fetch', '--depth', '1', '--no-tags', '--', 'origin', safeRef], { timeoutMs: 120_000, signal })
    const commit = (await runProcess('git', ['-C', staging, 'rev-parse', `${revision}^{commit}`], { timeoutMs: 30_000, signal })).stdout.trim()
    await exportCommittedTree(staging, destination, commit, signal)
    signal?.throwIfAborted()
    return { source: { type: 'git', url, ...(safeRef === undefined ? {} : { ref: safeRef }), commit } }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
