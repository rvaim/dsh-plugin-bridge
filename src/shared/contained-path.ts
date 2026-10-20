import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

type InvalidReason = 'escape' | 'kind' | 'unreadable'

export type ContainedPathInspection =
  | { status: 'ok'; path: string }
  | { status: 'missing' }
  | { status: 'invalid'; reason: InvalidReason }

class ContainedPathError extends Error {
  constructor(readonly reason: InvalidReason) {
    super('Contained package path is invalid')
  }
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/**
 * 检查真实文件系统 containment。不存在的末尾逐级解析最近的真实父目录；
 * dangling symlink 和循环链接失败关闭，不能把它们误当成不存在的普通目录。
 * 仅检查路径，不创建目录、不执行文件，不把输入或底层错误写入诊断。
 */
export async function resolveContainedPath(root: string, target: string): Promise<string> {
  try {
    if (target.includes('\0')) throw new ContainedPathError('unreadable')
    const rootAbsolute = resolve(root)
    const rootReal = await realpath(rootAbsolute)
    const absolute = resolve(rootAbsolute, target)
    if (!contains(rootAbsolute, absolute) && !contains(rootReal, absolute)) throw new ContainedPathError('escape')
    let ancestor = absolute
    const missing: string[] = []
    while (true) {
      try {
        const ancestorReal = await realpath(ancestor)
        const result = resolve(ancestorReal, ...missing)
        if (!contains(rootReal, ancestorReal) || !contains(rootReal, result)) throw new ContainedPathError('escape')
        return result
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // realpath 对 dangling symlink 返回 ENOENT；lstat 可识别并拒绝它。
        try {
          await lstat(ancestor)
          throw new ContainedPathError('unreadable')
        } catch (entryError) {
          if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) throw new ContainedPathError('unreadable')
        missing.unshift(basename(ancestor))
        ancestor = parent
      }
    }
  } catch (error) {
    if (error instanceof ContainedPathError) throw error
    throw new ContainedPathError('unreadable')
  }
}

/** 缺少固定组件不是错误；存在的 wrong kind、不可读或逃逸路径单独诊断。 */
export async function inspectContainedPath(root: string, target: string, expectedKind: 'file' | 'directory'): Promise<ContainedPathInspection> {
  try {
    const path = await resolveContainedPath(root, target)
    try {
      const info = await stat(path)
      if (expectedKind === 'file' ? info.isFile() : info.isDirectory()) return { status: 'ok', path }
      return { status: 'invalid', reason: 'kind' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      return { status: 'invalid', reason: 'unreadable' }
    }
  } catch (error) {
    return { status: 'invalid', reason: error instanceof ContainedPathError ? error.reason : 'unreadable' }
  }
}
