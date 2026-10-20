import { resolve } from 'node:path'
import type { CompatAgent } from '../types/agent.js'
import type { CompatCommand } from '../types/command.js'
import type { CompatHook } from '../types/hook.js'
import type { CompatMcpServer } from '../types/mcp.js'
import type { CompatPlugin } from '../types/plugin.js'
import type { CompatSkill } from '../types/skill.js'
import { sortDiagnostics } from '../types/diagnostic.js'
import { normalizeManagementId } from '../shared/id.js'
import type { ParsePluginOptions, ProtocolParseResult } from './contracts.js'
import { ParserRegistry } from './registry.js'
import { DiagnosticCollector } from '../shared/diagnostics.js'
import { pathExists, readJson } from '../shared/fs.js'

function comparable(value: object, omitted: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))))
}
function unique<T>(values: T[], keyOf: (value: T) => string, capability: 'skill' | 'mcp' | 'hook' | 'command' | 'agent', code: string,
  collector: DiagnosticCollector, equivalent?: (a: T, b: T) => boolean, merge?: (a: T, b: T) => T): T[] {
  const result = new Map<string, T>()
  for (const value of values) {
    const key = keyOf(value)
    const previous = result.get(key)
    if (previous === undefined) result.set(key, value)
    else if (JSON.stringify(previous) === JSON.stringify(value)) continue
    else if (equivalent?.(previous, value)) {
      result.set(key, merge?.(previous, value) ?? previous)
      collector.add('info', 'CAPABILITY_FORMAT_ALIAS_MERGED', capability, `同一 ${capability} 能力由不同格式等价声明，已合并为一个运行能力：${key}`)
    } else collector.add('error', code, capability, `${capability} 名称/标识在同一插件内重复，且不会自动改名：${key}`)
  }
  return [...result.values()]
}
function documentAlias(a: CompatSkill | CompatAgent | CompatCommand, b: CompatSkill | CompatAgent | CompatCommand): boolean {
  return a.sourceFormat !== b.sourceFormat && comparable(a, ['sourceFormat']) === comparable(b, ['sourceFormat'])
}
function mcpAlias(a: CompatMcpServer, b: CompatMcpServer): boolean {
  const ignored = ['sourceFormat', 'sourceFile', 'environmentBindings']
  if (a.sourceFormat === b.sourceFormat || comparable(a, ignored) !== comparable(b, ignored)) return false
  for (const [name, value] of Object.entries(a.environmentBindings ?? {})) {
    const other = b.environmentBindings?.[name]
    if (other !== undefined && other !== value) return false
  }
  return true
}
function mergeMcp(a: CompatMcpServer, b: CompatMcpServer): CompatMcpServer {
  return { ...a, environmentBindings: { ...a.environmentBindings, ...b.environmentBindings } }
}
function diagnoseHookAliases(hooks: CompatHook[], collector: DiagnosticCollector): void {
  const found = new Map<string, CompatHook>()
  for (const hook of hooks) {
    const key = JSON.stringify({ event: hook.event, matcher: hook.matcher, commands: hook.commands })
    const previous = found.get(key)
    if (previous === undefined) found.set(key, hook)
    else if (previous.dialect !== hook.dialect) collector.add('error', 'HOOK_DIALECT_CONFLICT', 'hook',
      `同一 Hook 存在不同运行语义，无法在不改变插件语义的前提下自动选择：${hook.event}`, hook.sourceFile)
  }
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

/** 只编排注入的协议输出；没有任何平台名称、清单路径或实现导入。 */
export async function compilePlugin(registry: ParserRegistry, root: string, options: ParsePluginOptions = {}): Promise<CompatPlugin> {
  const collector = new DiagnosticCollector()
  const inputDefinitions = options.marketplaceDefinitions ?? []
  const detected = await registry.detect(root, collector, inputDefinitions)
  const manifestOnly = detected.some(item => item.signature.exclusive)
  const definitions = manifestOnly ? [] : inputDefinitions
  if (manifestOnly && inputDefinitions.length > 0) collector.add('warning', 'PARSER_CATALOG_METADATA_IGNORED', 'plugin', '独占根清单不接受其他格式目录条目的核心配置覆盖')
  const results: ProtocolParseResult[] = []
  for (const item of detected) {
    if (item.parser === undefined) continue
    try {
      const result = await item.parser.parsePlugin({ root, implicit: item.implicit, definition: definitions.find(definition => definition.format === item.parser!.id) })
      if (result.format !== item.parser.id) throw new Error('解析器返回格式与注册身份不一致')
      results.push(result)
      collector.items.push(...result.diagnostics)
    } catch {
      collector.add('error', 'PARSER_PARSE_FAILED', 'plugin', `解析器 ${item.parser.id} 执行失败`, undefined, { parserId: item.parser.id })
    }
  }
  const strictMetadata = manifestOnly || results.some(result => result.metadataPolicy === 'manifest-only')
  const metadata = strictMetadata ? {} : await packageMetadata(root, collector)
  const objectField = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (objectField(metadata[key]) && Object.keys(metadata[key]).length > 0) {
      collector.add('warning', 'NODE_DEPENDENCIES_NOT_INSTALLED', 'plugin', `package.json 声明了 ${key}；安装阶段不会执行依赖安装，插件必须自带运行依赖或由用户显式准备环境`, 'package.json')
      break
    }
  }
  const firstName = results.map(result => result.name).find(value => typeof value === 'string' && value.trim() !== '')
  const catalogName = definitions.map(definition => definition.name).find(value => value.trim() !== '')
  const metadataName = typeof metadata.name === 'string' ? metadata.name : undefined
  const requestedId = options.asId ?? options.sourcePluginId ?? firstName ?? catalogName ?? metadataName ?? options.suggestedId ?? 'legacy-plugin'
  let id: string
  try { id = normalizeManagementId(requestedId) } catch {
    collector.add('error', 'PLUGIN_ID_INVALID', 'plugin', '插件管理标识无效')
    id = 'invalid-plugin'
  }
  if (id !== requestedId) collector.add('info', 'PLUGIN_ID_NORMALIZED', 'plugin', `管理标识已规范化为 ${id}；插件内部能力名称保持不变`)
  const name = (strictMetadata ? firstName : options.displayName)
    ?? definitions.map(definition => definition.displayName).find(value => typeof value === 'string')
    ?? results.map(result => result.displayName).find(value => typeof value === 'string')
    ?? firstName ?? catalogName ?? metadataName ?? options.suggestedId ?? id
  const version = results.map(result => result.version).find(value => typeof value === 'string')
    ?? definitions.map(definition => definition.version).find(value => typeof value === 'string')
    ?? (typeof metadata.version === 'string' ? metadata.version : undefined)
  const defaultEnabled = definitions.map(definition => definition.defaultEnabled).find(value => typeof value === 'boolean')
    ?? results.map(result => result.defaultEnabled).find(value => typeof value === 'boolean')
  const skills = unique(results.flatMap(result => result.skills), value => value.name, 'skill', 'SKILL_NAME_DUPLICATE', collector, documentAlias)
  const mcpServers = unique(results.flatMap(result => result.mcpServers), value => value.serverName, 'mcp', 'MCP_SERVER_NAME_DUPLICATE', collector, mcpAlias, mergeMcp)
  const allHooks = results.flatMap(result => result.hooks)
  diagnoseHookAliases(allHooks, collector)
  const hooks = unique(allHooks, value => value.id, 'hook', 'HOOK_DUPLICATE', collector)
  const commands = unique(results.flatMap(result => result.commands), value => value.name, 'command', 'COMMAND_NAME_DUPLICATE', collector, documentAlias)
  const agents = unique(results.flatMap(result => result.agents), value => value.name, 'agent', 'AGENT_NAME_DUPLICATE', collector, documentAlias)
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
  const protocol = results.find(result => result.protocol !== undefined)?.protocol
  return { id, name, ...(version === undefined ? {} : { version }), ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    sourceId: options.sourceId ?? 'legacy-source', sourcePluginId: options.sourcePluginId ?? options.suggestedId ?? id,
    formats: detected.map(item => item.signature.id), ...(protocol === undefined ? {} : { protocol }),
    skills, mcpServers, hooks, commands, agents, diagnostics: sortDiagnostics(collector.items),
    manifestFiles: [...new Set(results.flatMap(result => result.manifestFiles))] }
}
