import type { CompatDeferredJsonValue, CompatRuntimeValue, CompatTemplate, CompatTemplatePart } from '../../types/path.js'

const PLUGIN_VARIABLES = new Set(['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT'])
const PLUGIN_DATA_VARIABLES = new Set(['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA', 'CODEX_PLUGIN_DATA'])
const WORKSPACE_VARIABLES = new Set(['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'PROJECT_ROOT', 'WORKSPACE_ROOT'])

export function parseTemplate(value: string): CompatTemplate {
  const parts: CompatTemplatePart[] = []
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let start = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > start) parts.push({ type: 'text', value: value.slice(start, index) })
    const name = match[1]
    if (PLUGIN_VARIABLES.has(name)) parts.push({ type: 'plugin-root' })
    else if (PLUGIN_DATA_VARIABLES.has(name)) parts.push({ type: 'plugin-data' })
    else if (WORKSPACE_VARIABLES.has(name)) parts.push({ type: 'workspace-root' })
    else parts.push({ type: 'env', name })
    start = index + match[0].length
  }
  if (start < value.length) parts.push({ type: 'text', value: value.slice(start) })
  if (parts.length === 0) parts.push({ type: 'text', value })
  return { type: 'template', parts }
}

export function deferredJson(file: string, pointer: string, sensitive = false): CompatDeferredJsonValue {
  return { type: 'deferred-json', file, pointer, ...(sensitive ? { sensitive: true } : {}) }
}

/**
 * 配置中的字面量延迟到 package/ 中读取，避免 Token、URL、命令参数等进入 scan.json。
 * 含变量模板时只保留文本片段和变量引用；真正的环境值仍到运行时解析。
 */
export function parsePotentialSecretValue(
  value: unknown,
  file: string,
  pointer: string,
  sensitive = true,
): CompatRuntimeValue {
  if (typeof value !== 'string') return deferredJson(file, pointer, sensitive)
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
    ? parseTemplate(value)
    : deferredJson(file, pointer, sensitive)
}

export function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
