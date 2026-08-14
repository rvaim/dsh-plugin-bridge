import { lstat, realpath, readdir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface ExtractionLimits {
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxArchiveBytes: number
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxEntries: 20_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 256 * 1024 * 1024,
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** 将归档成员名规范化为安全的 POSIX 风格相对路径。 */
export function normalizeArchivePath(raw: string): string {
  if (raw.includes('\0')) throw new Error('归档成员名包含 NUL 字符')
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized === '' || normalized === '.') return ''
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`归档包含绝对路径：${raw}`)
  }
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error(`归档路径试图逃逸目标目录：${raw}`)
  return parts.join('/')
}

export function validateSymlinkTarget(root: string, linkPath: string, target: string): void {
  if (target.includes('\0')) throw new Error(`符号链接目标包含 NUL：${target}`)
  const portable = target.replaceAll('\\', '/')
  if (portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`符号链接使用绝对目标：${target}`)
  }
  const resolved = resolve(dirname(linkPath), portable)
  if (!isPathInside(root, resolved)) throw new Error(`符号链接逃逸插件目录：${target}`)
}

/** 校验目录树中的所有符号链接最终仍位于根目录内。 */
export async function verifyExtractedTree(root: string): Promise<void> {
  const rootReal = await realpath(root)
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        const target = await readlink(path)
        validateSymlinkTarget(root, path, target)
        let targetReal: string
        try {
          targetReal = await realpath(path)
        } catch {
          throw new Error(`归档包含悬空符号链接：${relative(root, path)}`)
        }
        if (!isPathInside(rootReal, targetReal)) {
          throw new Error(`符号链接最终目标位于插件目录外：${relative(root, path)}`)
        }
      } else if (stat.isDirectory()) {
        await walk(path)
      } else if (!stat.isFile()) {
        throw new Error(`插件目录包含不支持的特殊文件：${relative(root, path)}`)
      }
    }
  }
  await walk(root)
}
