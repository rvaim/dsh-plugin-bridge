import { resolve } from 'node:path'
import type { CompatPlugin } from '../types/plugin.js'
import { sortDiagnostics, uniqueDiagnostics } from '../types/diagnostic.js'
import { normalizeManagementId } from '../shared/id.js'
import type { ParsePluginOptions, ProtocolParseResult } from './contracts.js'
import { ParserRegistry, parserMatch } from './registry.js'
import { DiagnosticCollector } from '../shared/diagnostics.js'
import { pathExists, readJson } from '../shared/fs.js'

function unique<T>(values: T[], keyOf: (value: T) => string, capability: 'skill' | 'mcp' | 'hook' | 'command' | 'agent', code: string,
  collector: DiagnosticCollector): T[] {
  const result = new Map<string, T>()
  for (const value of values) {
    const key = keyOf(value)
    const previous = result.get(key)
    if (previous === undefined) result.set(key, value)
    else if (JSON.stringify(previous) !== JSON.stringify(value)) collector.add('error', code, capability, `${capability} 名称/标识在同一插件内重复，且不会自动改名：${key}`)
  }
  return [...result.values()]
}
async function packageMetadata(root: string, collector: DiagnosticCollector): Promise<Record<string, unknown>> {
  if (!await pathExists(resolve(root, 'package.json'))) return {}
  try {
    const value = await readJson(resolve(root, 'package.json'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('顶层不是对象')
    return value as Record<string, unknown>
  } catch {
    collector.add('warning', 'PACKAGE_JSON_INVALID', 'plugin', 'package.json 无法解析，仅忽略其元数据', 'package.json')
    return {}
  }
}

/** 选定一个协议后才扫描能力；其他匹配的清单、目录策略和元数据均不进入结果。 */
export async function compilePlugin(registry: ParserRegistry, root: string, options: ParsePluginOptions = {}): Promise<CompatPlugin> {
  const detectionCollector = new DiagnosticCollector()
  const inputDefinitions = options.marketplaceDefinitions ?? []
  const detected = await registry.detect(root, detectionCollector, inputDefinitions)
  const collector = new DiagnosticCollector()
  const empty = (formats = detected.map(item => item.signature.id)): CompatPlugin => {
    const requestedId = options.asId ?? options.sourcePluginId ?? options.suggestedId ?? 'legacy-plugin'
    let id: string
    try { id = normalizeManagementId(requestedId) } catch { id = 'invalid-plugin' }
    return { id, name: options.displayName ?? options.suggestedId ?? id,
      sourceId: options.sourceId ?? 'legacy-source', sourcePluginId: options.sourcePluginId ?? options.suggestedId ?? id,
      formats, skills: [], mcpServers: [], hooks: [], commands: [], agents: [], manifestFiles: [],
      diagnostics: sortDiagnostics(uniqueDiagnostics(collector.items)) }
  }
  if (options.parserId === undefined && detected.length > 1) {
    collector.add('error', 'PARSER_SELECTION_REQUIRED', 'plugin', '插件匹配多个解析器，请选择一个平台后再安装', undefined,
      { parserIds: detected.map(item => item.signature.id) })
    return empty()
  }
  const selected = options.parserId === undefined ? detected[0] : detected.find(item => item.signature.id === options.parserId)
  if (selected === undefined) {
    if (options.parserId !== undefined) {
      const available = registry.getParser(options.parserId) !== undefined
      collector.add('error', available ? 'PARSER_MISMATCH' : 'PARSER_UNAVAILABLE', 'plugin',
        available ? `解析器 ${options.parserId} 不匹配插件声明` : `解析器 ${options.parserId} 未注册`, undefined, { parserId: options.parserId })
    } else collector.items.push(...detectionCollector.items)
    return empty(options.parserId === undefined ? [] : [options.parserId])
  }
  collector.items.push(...selected.diagnostics)
  if (!parserMatch(selected).available || selected.parser === undefined) return empty([selected.signature.id])
  const manifestOnly = selected.signature.exclusive === true
  const definitions = manifestOnly ? [] : inputDefinitions.filter(definition => definition.format === selected.signature.id)
  let result: ProtocolParseResult
  try {
    result = await selected.parser.parsePlugin({ root, implicit: selected.implicit, definition: definitions[0] })
    if (result.format !== selected.parser.id) throw new Error('解析器返回格式与注册身份不一致')
    const resultDiagnostics = new Set(result.diagnostics.map(item => JSON.stringify(item)))
    collector.items.splice(0, collector.items.length, ...collector.items.filter(item => !resultDiagnostics.has(JSON.stringify(item))), ...result.diagnostics)
  } catch {
    collector.add('error', 'PARSER_PARSE_FAILED', 'plugin', `解析器 ${selected.parser.id} 执行失败`, undefined, { parserId: selected.parser.id })
    return empty([selected.signature.id])
  }
  const strictMetadata = manifestOnly || result.metadataPolicy === 'manifest-only'
  const metadata = strictMetadata ? {} : await packageMetadata(root, collector)
  const objectField = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (objectField(metadata[key]) && Object.keys(metadata[key]).length > 0) {
      collector.add('warning', 'NODE_DEPENDENCIES_NOT_INSTALLED', 'plugin', `package.json 声明了 ${key}；安装阶段不会执行依赖安装，插件必须自带运行依赖或由用户显式准备环境`, 'package.json')
      break
    }
  }
  const firstName = typeof result.name === 'string' && result.name.trim() !== '' ? result.name : undefined
  const definition = definitions[0]
  const catalogName = definition?.name
  const metadataName = typeof metadata.name === 'string' ? metadata.name : undefined
  const requestedId = options.asId ?? options.sourcePluginId ?? firstName ?? catalogName ?? metadataName ?? options.suggestedId ?? 'legacy-plugin'
  let id: string
  try { id = normalizeManagementId(requestedId) } catch {
    collector.add('error', 'PLUGIN_ID_INVALID', 'plugin', '插件管理标识无效')
    id = 'invalid-plugin'
  }
  if (id !== requestedId) collector.add('info', 'PLUGIN_ID_NORMALIZED', 'plugin', `管理标识已规范化为 ${id}；插件内部能力名称保持不变`)
  const name = (strictMetadata ? firstName : options.displayName) ?? definition?.displayName ?? result.displayName
    ?? firstName ?? catalogName ?? metadataName ?? options.suggestedId ?? id
  const version = result.version ?? definition?.version ?? (typeof metadata.version === 'string' ? metadata.version : undefined)
  const defaultEnabled = definition?.defaultEnabled ?? result.defaultEnabled
  const skills = unique(result.skills, value => value.name, 'skill', 'SKILL_NAME_DUPLICATE', collector)
  const mcpServers = unique(result.mcpServers, value => value.serverName, 'mcp', 'MCP_SERVER_NAME_DUPLICATE', collector)
  const hooks = unique(result.hooks, value => value.id, 'hook', 'HOOK_DUPLICATE', collector)
  const commands = unique(result.commands, value => value.name, 'command', 'COMMAND_NAME_DUPLICATE', collector)
  const agents = unique(result.agents, value => value.name, 'agent', 'AGENT_NAME_DUPLICATE', collector)
  const markSourceReferences = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(markSourceReferences); return }
    if (value === null || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (object.type === 'deferred-json' && typeof object.file === 'string' && typeof object.pointer === 'string'
      && definitions.some(definition => definition.file === object.file && (object.pointer as string).startsWith(`${definition.pointer}/`))) object.base = 'source'
    Object.values(object).forEach(markSourceReferences)
  }
  markSourceReferences(mcpServers)
  markSourceReferences(hooks)
  return { id, name, ...(version === undefined ? {} : { version }), ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    sourceId: options.sourceId ?? 'legacy-source', sourcePluginId: options.sourcePluginId ?? options.suggestedId ?? id,
    formats: [selected.signature.id], ...(result.protocol === undefined ? {} : { protocol: result.protocol }),
    skills, mcpServers, hooks, commands, agents, diagnostics: sortDiagnostics(collector.items),
    manifestFiles: [...new Set(result.manifestFiles)] }
}
