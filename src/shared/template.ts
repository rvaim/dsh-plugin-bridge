import type { CompatPluginEnvironmentBindings } from '../types/environment.js'
import type { CompatDeferredJsonValue, CompatRuntimeValue, CompatTemplate, CompatTemplatePart } from '../types/path.js'

/** Parse the shared interpolation grammar using only the caller's path bindings. */
export function parseTemplate(value: string, bindings: CompatPluginEnvironmentBindings = {}): CompatTemplate {
  const parts: CompatTemplatePart[] = []
  const pattern = /\$\{([^}]*)\}/g
  let start = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    const literal = value.slice(start, index)
    if (literal.includes('${')) throw new Error('模板变量未闭合或嵌套，DSH 尚未适配')
    if (literal !== '') parts.push({ type: 'text', value: literal })
    const variable = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?$/.exec(match[1])
    if (variable === null) throw new Error('模板引用语法尚未适配')
    const [, name, fallback] = variable
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined
    if (fallback !== undefined && binding !== undefined) throw new Error('DSH 路径变量不支持环境变量默认值语法')
    if (binding !== undefined) parts.push({ type: binding })
    else parts.push({ type: 'env', name, ...(fallback === undefined ? {} : { fallback }) })
    start = index + match[0].length
  }
  if (value.slice(start).includes('${')) throw new Error('模板变量未闭合，DSH 尚未适配')
  if (start < value.length) parts.push({ type: 'text', value: value.slice(start) })
  if (parts.length === 0) parts.push({ type: 'text', value })
  return { type: 'template', parts }
}

export function deferredJson(file: string, pointer: string, sensitive = false): CompatDeferredJsonValue {
  return { type: 'deferred-json', file, pointer, ...(sensitive ? { sensitive: true } : {}) }
}

/** 敏感字面量和所有 fallback 留在包内；运行时才读取和解析。 */
export function parsePotentialSecretValue(
  value: unknown,
  file: string,
  pointer: string,
  sensitive = true,
  bindings: CompatPluginEnvironmentBindings = {},
): CompatRuntimeValue {
  if (typeof value !== 'string' || !value.includes('${')) return deferredJson(file, pointer, sensitive)
  const template = parseTemplate(value, bindings)
  if (template.parts.some(part => part.type === 'env' && part.fallback !== undefined)
    || (sensitive && template.parts.some(part => part.type === 'text' && part.value !== ''))) {
    return { ...deferredJson(file, pointer, sensitive), templateSyntax: 'environment', templateBindings: { ...bindings } }
  }
  return template
}

export function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
