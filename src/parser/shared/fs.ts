import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { isPathInside } from '../../source/safety.js'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function readUtf8(path: string): Promise<string> {
  return await readFile(path, 'utf8')
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readUtf8(path)) as unknown
}

/** 只返回根目录内的普通文件；遇到逃逸符号链接立即失败。 */
export async function walkFiles(root: string): Promise<string[]> {
  const rootReal = await realpath(root)
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (!isPathInside(rootReal, target)) throw new Error(`符号链接逃逸插件目录：${relative(root, path)}`)
        const stat = await lstat(target)
        if (stat.isDirectory()) await walk(target)
        else if (stat.isFile()) files.push(path)
      } else if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files.sort()
}

export function toPluginRelative(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path)).replaceAll('\\', '/')
  if (value === '..' || value.startsWith('../')) throw new Error(`路径位于插件目录外：${path}`)
  return value
}
