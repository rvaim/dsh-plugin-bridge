import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isPathInside, validateSymlinkTarget, verifyExtractedTree } from './safety.js'

/** 安全复制本地插件目录，不执行脚本，不跟随指向目录外的符号链接。 */
export async function copyPluginDirectory(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const sourceRoot = await realpath(source)
  signal?.throwIfAborted()
  await mkdir(destination, { recursive: true, mode: 0o700 })

  const copyEntry = async (from: string, to: string): Promise<void> => {
    signal?.throwIfAborted()
    const stat = await lstat(from)
    signal?.throwIfAborted()
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true, mode: stat.mode & 0o777 })
      for (const name of (await readdir(from)).sort()) await copyEntry(resolve(from, name), resolve(to, name))
      return
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(from)
      validateSymlinkTarget(sourceRoot, from, target)
      let targetReal: string
      try { targetReal = await realpath(from) } catch {
        throw new Error(`本地插件包含悬空符号链接：${relative(sourceRoot, from)}`)
      }
      if (!isPathInside(sourceRoot, targetReal)) throw new Error(`本地插件符号链接逃逸目录：${relative(sourceRoot, from)}`)
      signal?.throwIfAborted()
      await mkdir(dirname(to), { recursive: true, mode: 0o700 })
      signal?.throwIfAborted()
      await symlink(target, to)
      return
    }
    if (!stat.isFile()) throw new Error(`本地插件包含不支持的特殊文件：${relative(sourceRoot, from)}`)
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx', mode: stat.mode & 0o777 }), { signal })
  }

  for (const name of (await readdir(sourceRoot)).sort()) await copyEntry(resolve(sourceRoot, name), resolve(destination, name))
  await verifyExtractedTree(destination, signal)
}
