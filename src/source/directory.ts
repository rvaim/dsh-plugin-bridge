import { copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isPathInside, validateSymlinkTarget, verifyExtractedTree } from './safety.js'

/**
 * 安全复制本地插件目录。不会执行脚本，也不会跟随指向目录外的符号链接。
 */
export async function copyPluginDirectory(source: string, destination: string): Promise<void> {
  const sourceRoot = await realpath(source)
  await mkdir(destination, { recursive: true, mode: 0o700 })

  const copyEntry = async (from: string, to: string): Promise<void> => {
    const stat = await lstat(from)
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true, mode: stat.mode & 0o777 })
      const entries = await readdir(from)
      for (const name of entries.sort()) await copyEntry(resolve(from, name), resolve(to, name))
      return
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(from)
      validateSymlinkTarget(sourceRoot, from, target)
      let targetReal: string
      try {
        targetReal = await realpath(from)
      } catch {
        throw new Error(`本地插件包含悬空符号链接：${relative(sourceRoot, from)}`)
      }
      if (!isPathInside(sourceRoot, targetReal)) {
        throw new Error(`本地插件符号链接逃逸目录：${relative(sourceRoot, from)}`)
      }
      await mkdir(dirname(to), { recursive: true, mode: 0o700 })
      await symlink(target, to)
      return
    }
    if (!stat.isFile()) throw new Error(`本地插件包含不支持的特殊文件：${relative(sourceRoot, from)}`)
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    await copyFile(from, to)
  }

  for (const name of (await readdir(sourceRoot)).sort()) {
    await copyEntry(resolve(sourceRoot, name), resolve(destination, name))
  }
  await verifyExtractedTree(destination)
}
