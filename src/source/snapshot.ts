import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { DEFAULT_EXTRACTION_LIMITS } from './safety.js'

/**
 * 计算目录快照的稳定 SHA-256。哈希包含相对路径、条目类型、可执行位、
 * 符号链接目标和普通文件内容，不读取目录外数据。
 */
export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256')
  let entries = 0
  let totalBytes = 0

  const add = (kind: string, path: string, extra = ''): void => {
    hash.update(kind)
    hash.update('\0')
    hash.update(path.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(extra)
    hash.update('\0')
  }

  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = resolve(directory, name)
      const rel = relative(root, path).replaceAll('\\', '/')
      const stat = await lstat(path)
      entries += 1
      if (entries > DEFAULT_EXTRACTION_LIMITS.maxEntries) {
        throw new Error(`目录文件数量超过限制：${DEFAULT_EXTRACTION_LIMITS.maxEntries}`)
      }
      if (stat.isDirectory()) {
        add('directory', rel)
        await walk(path)
        continue
      }
      if (stat.isSymbolicLink()) {
        add('symlink', rel, await readlink(path))
        continue
      }
      if (!stat.isFile()) throw new Error(`目录包含不支持的特殊文件：${rel}`)
      if (stat.size > DEFAULT_EXTRACTION_LIMITS.maxFileBytes) throw new Error(`文件过大：${rel}`)
      totalBytes += stat.size
      if (totalBytes > DEFAULT_EXTRACTION_LIMITS.maxTotalBytes) {
        throw new Error(`目录总大小超过限制：${DEFAULT_EXTRACTION_LIMITS.maxTotalBytes}`)
      }
      add('file', rel, String(stat.mode & 0o111))
      hash.update(await readFile(path))
      hash.update('\0')
    }
  }

  await walk(resolve(root))
  return hash.digest('hex')
}
