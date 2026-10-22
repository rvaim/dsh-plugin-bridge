import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { DEFAULT_EXTRACTION_LIMITS } from './safety.js'

/** 路径、类型、可执行位、链接及内容共同组成稳定快照；文件逐块读取。 */
export async function hashDirectory(root: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  let entries = 0
  let totalBytes = 0
  const add = (kind: string, path: string, extra = ''): void => {
    hash.update(kind).update('\0').update(path.replaceAll('\\', '/')).update('\0').update(extra).update('\0')
  }
  const walk = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted()
      const path = resolve(directory, name)
      const rel = relative(root, path).replaceAll('\\', '/')
      const stat = await lstat(path)
      signal?.throwIfAborted()
      if (++entries > DEFAULT_EXTRACTION_LIMITS.maxEntries) throw new Error(`目录文件数量超过限制：${DEFAULT_EXTRACTION_LIMITS.maxEntries}`)
      if (stat.isDirectory()) { add('directory', rel); await walk(path); continue }
      if (stat.isSymbolicLink()) { add('symlink', rel, await readlink(path)); continue }
      if (!stat.isFile()) throw new Error(`目录包含不支持的特殊文件：${rel}`)
      if (stat.size > DEFAULT_EXTRACTION_LIMITS.maxFileBytes) throw new Error(`文件过大：${rel}`)
      totalBytes += stat.size
      if (totalBytes > DEFAULT_EXTRACTION_LIMITS.maxTotalBytes) throw new Error(`目录总大小超过限制：${DEFAULT_EXTRACTION_LIMITS.maxTotalBytes}`)
      add('file', rel, String(stat.mode & 0o111))
      let size = 0
      for await (const chunk of createReadStream(path, { signal })) {
        signal?.throwIfAborted()
        size += chunk.length
        if (size > DEFAULT_EXTRACTION_LIMITS.maxFileBytes) throw new Error(`文件过大：${rel}`)
        hash.update(chunk)
      }
      totalBytes += size - stat.size
      if (totalBytes > DEFAULT_EXTRACTION_LIMITS.maxTotalBytes) throw new Error(`目录总大小超过限制：${DEFAULT_EXTRACTION_LIMITS.maxTotalBytes}`)
      hash.update('\0')
    }
  }
  await walk(resolve(root))
  signal?.throwIfAborted()
  return hash.digest('hex')
}
