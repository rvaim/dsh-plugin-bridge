import { isAbsolute, normalize } from 'node:path'
import type { CompatPath } from '../../types/path.js'

const pluginPattern = /^\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|CODEX_PLUGIN_ROOT)\}(?:[\\/](.*))?$/
const workspacePattern = /^\$\{(?:CLAUDE_PROJECT_DIR|CODEX_PROJECT_DIR|PROJECT_ROOT|WORKSPACE_ROOT)\}(?:[\\/](.*))?$/

function cleanRelative(value: string): string {
  const normalized = normalize(value).replaceAll('\\', '/')
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`路径包含上级逃逸：${value}`)
  return normalized === '.' ? '' : normalized
}

/** MCP cwd 等路径转为结构化表示，真正绝对化推迟到运行阶段。 */
export function parseCompatPath(value: string, defaultBase: 'plugin' | 'workspace' = 'plugin'): CompatPath {
  const plugin = pluginPattern.exec(value)
  if (plugin !== null) return { type: 'plugin', path: cleanRelative(plugin[1] ?? '') }
  const workspace = workspacePattern.exec(value)
  if (workspace !== null) return { type: 'workspace', path: cleanRelative(workspace[1] ?? '') }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return { type: 'absolute', path: normalize(value) }
  return { type: defaultBase, path: cleanRelative(value) }
}
