import { basename, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { isPathInside } from '../source/safety.js'
import type { DiagnosticCollector } from './diagnostics.js'
import { pathExists, toPluginRelative, walkFiles } from './fs.js'

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '')
  let expression = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else expression += '[^/]*'
    } else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

export async function discoverCapabilityFiles(options: {
  packageRoot: string
  declaredPaths: string[]
  defaultPaths: string[]
  predicate(relativePath: string): boolean
  collector: DiagnosticCollector
  capability: 'skill' | 'command' | 'agent'
}): Promise<string[]> {
  const allFiles = await walkFiles(options.packageRoot)
  const allRelative = allFiles.map(path => toPluginRelative(options.packageRoot, path))
  const selected = new Set<string>()
  const candidates = [...options.defaultPaths, ...options.declaredPaths]

  for (const raw of candidates) {
    const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (normalized.includes('*') || normalized.includes('?')) {
      const regex = globToRegExp(normalized)
      for (const relativePath of allRelative) {
        if (regex.test(relativePath) && options.predicate(relativePath)) selected.add(relativePath)
      }
      continue
    }
    const absolute = resolve(options.packageRoot, normalized)
    if (!isPathInside(options.packageRoot, absolute)) {
      options.collector.add('error', 'CAPABILITY_PATH_ESCAPE', options.capability, `能力路径逃逸插件目录：${raw}`)
      continue
    }
    if (!await pathExists(absolute)) {
      if (options.declaredPaths.includes(raw)) {
        options.collector.add('warning', 'CAPABILITY_PATH_MISSING', options.capability, `清单声明的路径不存在：${raw}`)
      }
      continue
    }
    const info = await lstat(absolute)
    if (info.isFile()) {
      const relativePath = toPluginRelative(options.packageRoot, absolute)
      if (options.predicate(relativePath)) selected.add(relativePath)
    } else if (info.isDirectory()) {
      const prefix = normalized === '' ? '' : `${normalized}/`
      for (const relativePath of allRelative) {
        if (relativePath.startsWith(prefix) && options.predicate(relativePath)) selected.add(relativePath)
      }
    } else {
      options.collector.add('warning', 'CAPABILITY_SPECIAL_FILE', options.capability, `忽略特殊文件：${raw}`)
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b))
}

export function isSkillFile(path: string): boolean {
  return basename(path).toLowerCase() === 'skill.md'
}

export function isMarkdownFile(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}
