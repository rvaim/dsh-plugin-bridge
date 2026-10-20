import { resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { isPathInside } from '../../source/safety.js'
import { pathExists, readJson, toPluginRelative } from '../../shared/fs.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { asObject } from '../../shared/object.js'
import type { ConfigSource } from '../../types/protocol.js'

export function declaredPathList(
  value: unknown,
  collector: DiagnosticCollector,
  capability: 'skill' | 'command' | 'agent',
  fieldName: string,
  manifestPath?: string,
): string[] {
  if (value === undefined) return []
  const items = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const [index, item] of items.entries()) {
    if (typeof item === 'string' && item.trim() !== '') result.push(item)
    else collector.add('error', 'DECLARED_PATH_INVALID', capability, `${fieldName}${Array.isArray(value) ? ` 第 ${index + 1} 项` : ''}必须是非空路径字符串`, manifestPath)
  }
  return result
}

export async function loadManifest(packageRoot: string, relativePath: string, collector: DiagnosticCollector): Promise<Record<string, unknown>> {
  try {
    if (!await containedPath(packageRoot, relativePath)) throw new Error('清单真实路径位于插件目录外')
    const object = asObject(await readJson(resolve(packageRoot, relativePath)))
    if (object === undefined) throw new Error('清单顶层必须是对象')
    return object
  } catch (error) {
    collector.add('error', 'PLUGIN_MANIFEST_INVALID', 'plugin', `插件清单无法解析：${String(error)}`, relativePath)
    return {}
  }
}

/** 上游组件路径语法；存在性不影响 Codex 是否选择默认值。 */
export function manifestRelativePath(raw: string, allowRoot = false): string | undefined {
  if (allowRoot && (raw === '.' || raw === './')) return ''
  if (!raw.startsWith('./') || raw.length === 2 || raw.includes('\0')) return undefined
  const portable = raw.slice(2).replaceAll('\\', '/')
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable) || portable.split('/').includes('..')) return undefined
  return portable
}

async function containedPath(packageRoot: string, path: string): Promise<boolean> {
  const absolute = resolve(packageRoot, path)
  if (!isPathInside(packageRoot, absolute)) return false
  if (!await pathExists(absolute)) return true
  const [rootReal, pathReal] = await Promise.all([realpath(packageRoot), realpath(absolute)])
  return isPathInside(rootReal, pathReal)
}

export async function normalizeDeclaredPaths(
  packageRoot: string,
  values: string[],
  collector: DiagnosticCollector,
  capability: 'skill' | 'command' | 'agent',
  manifestPath?: string,
  options: { kind?: 'file' | 'directory'; requireExists?: boolean } = {},
): Promise<string[]> {
  const result: string[] = []
  for (const raw of values) {
    const normalized = manifestRelativePath(raw, capability === 'skill')
    if (normalized === undefined) {
      collector.add('error', /(?:^|[/\\])\.\.(?:[/\\]|$)|\0/.test(raw) ? 'DECLARED_PATH_ESCAPE' : 'DECLARED_PATH_INVALID', capability, `组件路径必须以 ./ 开头且位于插件目录内：${raw}`, manifestPath)
      continue
    }
    if (!await containedPath(packageRoot, normalized)) {
      collector.add('error', 'DECLARED_PATH_ESCAPE', capability, `清单路径或符号链接逃逸插件目录：${raw}`, manifestPath)
      continue
    }
    const absolute = resolve(packageRoot, normalized)
    if (options.requireExists === true && !await pathExists(absolute)) {
      collector.add('error', 'DECLARED_PATH_MISSING', capability, `清单声明的路径不存在：${raw}`, manifestPath)
      continue
    }
    if (await pathExists(absolute) && options.kind !== undefined) {
      const info = await stat(absolute)
      if (!(options.kind === 'file' ? info.isFile() && normalized.endsWith('.md') : info.isDirectory())) {
        collector.add('error', 'DECLARED_PATH_KIND_INVALID', capability, `${capability} 路径必须是${options.kind === 'file' ? ' Markdown 文件' : '目录'}：${raw}`, manifestPath)
        continue
      }
    }
    result.push(normalized)
  }
  return result
}

export async function collectConfigSources(
  packageRoot: string,
  manifestPath: string | undefined,
  value: unknown,
  defaultFile: string,
  fieldName: string,
  collector: DiagnosticCollector,
  capability: 'mcp' | 'hook',
  format: 'claude-code' | 'codex' = 'claude-code',
): Promise<ConfigSource[]> {
  const result: ConfigSource[] = []
  const addPath = async (raw: string, isDefault = false): Promise<void> => {
    if (format === 'claude-code' && capability === 'mcp' && (/^https:\/\//.test(raw) || /\.(?:mcpb|dxt)$/i.test(raw))) {
      collector.add('error', 'MCP_BUNDLE_UNSUPPORTED', 'mcp', '已识别 MCP bundle 来源，但当前没有安全解包与运行适配器', manifestPath)
      return
    }
    const normalized = isDefault ? raw : manifestRelativePath(raw)
    if (normalized === undefined || !await containedPath(packageRoot, normalized)) {
      collector.add('error', 'DECLARED_PATH_ESCAPE', capability, `配置路径必须以 ./ 开头且真实目标位于插件目录内：${raw}`, manifestPath)
      return
    }
    const absolute = resolve(packageRoot, normalized)
    if (!await pathExists(absolute)) {
      if (!isDefault) collector.add('error', 'DECLARED_PATH_MISSING', capability, `清单声明的文件不存在：${raw}`, manifestPath)
      return
    }
    if (!(await stat(absolute)).isFile()) {
      collector.add('error', 'DECLARED_CONFIG_NOT_FILE', capability, `清单声明的配置不是文件：${raw}`, manifestPath)
      return
    }
    if (format === 'claude-code' && !normalized.endsWith('.json')) {
      collector.add('error', 'DECLARED_CONFIG_EXTENSION_INVALID', capability, `配置必须是 .json 文件：${raw}`, manifestPath)
      return
    }
    result.push({ file: toPluginRelative(packageRoot, absolute) })
  }
  if (value === undefined) {
    await addPath(defaultFile, true)
    return result
  }
  const items = Array.isArray(value) ? value : [value]
  for (const [index, item] of items.entries()) {
    if (typeof item === 'string') {
      await addPath(item)
      continue
    }
    const inline = asObject(item)
    if (inline !== undefined && manifestPath !== undefined) {
      result.push({ file: manifestPath, inline, pointer: Array.isArray(value) ? `/${fieldName}/${index}` : `/${fieldName}` })
      continue
    }
    collector.add('error', 'DECLARED_CONFIG_INVALID', capability, `${fieldName}${Array.isArray(value) ? ` 第 ${index + 1} 项` : ''}必须是路径或对象`, manifestPath)
  }
  return result
}

/** Claude：默认文件先读，然后清单和 Marketplace 声明顺序合并。 */
export async function collectMergedConfigSources(
  packageRoot: string,
  manifestPath: string | undefined,
  manifestValue: unknown,
  definition: { file: string; pointer: string; value: unknown } | undefined,
  defaultFile: string,
  fieldName: string,
  collector: DiagnosticCollector,
  capability: 'mcp' | 'hook',
): Promise<ConfigSource[]> {
  const result = await collectConfigSources(packageRoot, manifestPath, undefined, defaultFile, fieldName, collector, capability)
  if (manifestValue !== undefined) result.push(...await collectConfigSources(packageRoot, manifestPath, manifestValue, defaultFile, fieldName, collector, capability))
  if (definition !== undefined) {
    const sources = await collectConfigSources(packageRoot, definition.file, definition.value, defaultFile, fieldName, collector, capability)
    result.push(...sources.map(source => source.inline === undefined ? source : { ...source, pointer: `${definition.pointer}${source.pointer ?? ''}` }))
  }
  return result
}

export function validateMetadata(
  value: Record<string, unknown>,
  collector: DiagnosticCollector,
  file: string | undefined,
  format: 'claude-code' | 'codex',
  marketplace = false,
): void {
  const known = new Set([
    '$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata',
    'skills', 'commands', 'agents', 'hooks', 'mcpServers',
    ...(format === 'claude-code' ? ['defaultEnabled', 'dependencies', 'settings', 'userConfig', 'types', 'channels', 'lspServers', 'outputStyles', 'workflows', 'experimental', 'themes', 'monitors', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl'] : ['interface', 'apps', 'extensions', 'mcp_servers', 'paths']),
    ...(marketplace ? ['source', 'strict', 'category', 'tags', 'policy', 'defaultEnabled'] : []),
  ])
  for (const key of Object.keys(value)) {
    if (!known.has(key)) collector.add('warning', 'PLUGIN_MANIFEST_UNKNOWN_FIELD', 'plugin', `未识别的 ${format} 顶层字段已忽略：${key}`, file)
  }
  for (const key of ['name', 'displayName', 'version', 'description', '$schema', 'homepage', 'repository', 'license', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']) {
    if (format === 'codex' && value[key] === null && ['version', 'description'].includes(key)) continue
    if (value[key] !== undefined && typeof value[key] !== 'string') collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', `${key} 必须是字符串`, file)
  }
  for (const key of ['metadata', 'author']) {
    if (value[key] !== undefined && asObject(value[key]) === undefined) collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', `${key} 必须是对象`, file)
  }
  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.some(item => typeof item !== 'string'))) collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', 'keywords 必须是字符串数组', file)
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== 'boolean') collector.add('error', 'PLUGIN_DEFAULT_ENABLED_INVALID', 'plugin', 'defaultEnabled 必须是布尔值', file)
  if (format === 'claude-code' && typeof value.homepage === 'string') {
    try { new URL(value.homepage) } catch { collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', 'homepage 必须是合法 URL', file) }
  }
  const author = asObject(value.author)
  if (format === 'claude-code' && author !== undefined && (typeof author.name !== 'string' || author.name.trim() === '')) collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', 'author.name 必须是非空字符串', file)
  if (format !== 'claude-code') return
  const invalid = (key: string, expected: string): void => collector.add('error', 'PLUGIN_MANIFEST_FIELD_INVALID', 'plugin', `${key} 必须是${expected}`, file)
  if (typeof value.name === 'string' && (value.name.trim() === '' || /[\s@:/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.name))) invalid('name', '非空且不含空格、路径分隔符、@、冒号或控制字符的名称')
  for (const key of ['settings', 'userConfig']) if (value[key] !== undefined && asObject(value[key]) === undefined) invalid(key, '对象')
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.some(item => typeof item !== 'string' && asObject(item) === undefined))) invalid('dependencies', '字符串或对象数组')
  if (value.channels !== undefined && (!Array.isArray(value.channels) || value.channels.some(item => asObject(item) === undefined))) invalid('channels', '对象数组')
  for (const key of ['outputStyles', 'workflows', 'themes', 'types']) {
    if (value[key] === undefined) continue
    const paths = Array.isArray(value[key]) && key !== 'types' ? value[key] as unknown[] : [value[key]]
    for (const path of paths) {
      if (typeof path !== 'string') invalid(key, '组件路径字符串或路径数组')
      else if (manifestRelativePath(path) === undefined) collector.add('error', 'DECLARED_PATH_ESCAPE', 'plugin', `${key} 路径必须以 ./ 开头且位于插件目录内`, file)
    }
  }
}
