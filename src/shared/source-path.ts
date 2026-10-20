import { lstat, realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { CompatPluginLocation } from '../types/source.js'
import { isPathInside } from '../source/safety.js'

export function normalizeRelativeSourcePath(raw: string): string {
  if (raw.includes('\0')) throw new Error('路径包含 NUL 字符')
  const portable = raw.replaceAll('\\', '/')
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) throw new Error(`插件位置必须是 Source 内相对路径：${raw}`)
  const parts = portable.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error(`插件位置不能逃逸 Source：${raw}`)
  return parts.join('/') || '.'
}

/** 通用目录 containment；协议控制目录的保留规则由相应解析器单独检查。 */
export async function validateSourceDirectory(sourceRoot: string, rawPath: string): Promise<string> {
  const path = normalizeRelativeSourcePath(rawPath)
  const target = resolve(sourceRoot, path)
  let info
  try { info = await lstat(target) } catch { throw new Error(`插件目录不存在：${path}`) }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`插件位置不是目录：${path}`)
  const [rootReal, targetReal] = await Promise.all([realpath(sourceRoot), realpath(target)])
  if (!isPathInside(rootReal, targetReal)) throw new Error(`插件目录逃逸 Source：${path}`)
  if (!(await stat(targetReal)).isDirectory()) throw new Error(`插件位置的真实目标不是目录：${path}`)
  return relative(rootReal, targetReal).replaceAll('\\', '/') || '.'
}

export function locationKey(location: CompatPluginLocation): string {
  switch (location.type) {
    case 'source-path': return `source-path:${location.path}`
    case 'git': return `git:${location.url}#${location.sha ?? location.ref ?? ''}`
    case 'git-subdir': return `git-subdir:${location.url}#${location.sha ?? location.ref ?? ''}:${location.path}`
    case 'npm': return `npm:${location.package}@${location.version ?? ''}:${location.registry ?? ''}`
    case 'archive': return `archive:${location.url}#${location.sha256 ?? ''}`
    case 'unsupported': return `unsupported:${location.sourceType}`
  }
}
