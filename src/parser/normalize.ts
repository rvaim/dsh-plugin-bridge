import { resolve } from 'node:path'
import type { CompatAgent } from '../types/agent.js'
import type { CompatCommand } from '../types/command.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import { sortDiagnostics } from '../types/diagnostic.js'
import type { CompatHook } from '../types/hook.js'
import type { CompatMcpServer } from '../types/mcp.js'
import type { CompatFormat, CompatPlugin } from '../types/plugin.js'
import type { InstallSource } from '../types/source.js'
import type { CompatSkill } from '../types/skill.js'
import { parseAgentsForHarness } from './agents/common.js'
import { parseCommandsForHarness } from './commands/common.js'
import { detectPluginFormat } from './detect.js'
import { parseClaudeHarness } from './harness/claude-code.js'
import { parseCodexHarness } from './harness/codex.js'
import type { HarnessDescriptor } from './harness/types.js'
import { parseHooksForHarness } from './hooks/common.js'
import { parseMcpForHarness } from './mcp/common.js'
import { DiagnosticCollector } from './shared/diagnostics.js'
import { pathExists, readJson } from './shared/fs.js'
import { normalizeManagementId } from './shared/id.js'
import type { MarketplacePluginDefinition } from './source/types.js'
import { parseSkillsForHarness } from './skills/common.js'
import { PARSER_VERSION } from './version.js'
export { PARSER_VERSION } from './version.js'


export interface ParsePluginOptions {
  /** @deprecated 仅用于 0.1.x 调用兼容；新管理层使用 sourceId/sourcePluginId。 */
  source?: InstallSource
  sourceId?: string
  sourcePluginId?: string
  suggestedId?: string
  asId?: string
  displayName?: string
  marketplaceDefinitions?: MarketplacePluginDefinition[]
}

interface DuplicatePolicy<T> {
  /** 两个不同旧生态对同一运行能力作等价声明时，允许 parser 显式合并。 */
  equivalentAcrossFormats?: (left: T, right: T) => boolean
  mergeAcrossFormats?: (left: T, right: T) => T
}

function deDuplicate<T>(
  items: T[],
  keyOf: (item: T) => string,
  capability: 'skill' | 'mcp' | 'hook' | 'command' | 'agent',
  code: string,
  collector: DiagnosticCollector,
  policy: DuplicatePolicy<T> = {},
): T[] {
  const map = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    const previous = map.get(key)
    if (previous === undefined) {
      map.set(key, item)
      continue
    }
    if (JSON.stringify(previous) === JSON.stringify(item)) continue
    if (policy.equivalentAcrossFormats?.(previous, item) === true) {
      map.set(key, policy.mergeAcrossFormats?.(previous, item) ?? previous)
      collector.add(
        'info',
        'CAPABILITY_FORMAT_ALIAS_MERGED',
        capability,
        `同一 ${capability} 能力由 Claude Code 与 Codex 等价声明，已合并为一个运行能力：${key}`,
      )
      continue
    }
    collector.add('error', code, capability, `${capability} 名称/标识在同一插件内重复，且不会自动改名：${key}`)
  }
  return [...map.values()]
}

function withoutKeys<T extends Record<string, unknown>>(value: T, keys: readonly string[]): Record<string, unknown> {
  const result = { ...value }
  for (const key of keys) delete result[key]
  return result
}

function equivalentDocumentCapability(
  left: CompatSkill | CompatCommand | CompatAgent,
  right: CompatSkill | CompatCommand | CompatAgent,
): boolean {
  if (left.sourceFormat === right.sourceFormat) return false
  return JSON.stringify(withoutKeys(left as unknown as Record<string, unknown>, ['sourceFormat']))
    === JSON.stringify(withoutKeys(right as unknown as Record<string, unknown>, ['sourceFormat']))
}

function equivalentMcpAcrossFormats(left: CompatMcpServer, right: CompatMcpServer): boolean {
  if (left.sourceFormat === right.sourceFormat) return false
  return JSON.stringify(withoutKeys(left as unknown as Record<string, unknown>, [
    'sourceFormat',
    'sourceFile',
    'environmentMode',
  ])) === JSON.stringify(withoutKeys(right as unknown as Record<string, unknown>, [
    'sourceFormat',
    'sourceFile',
    'environmentMode',
  ]))
}

function mergeMcpAcrossFormats(left: CompatMcpServer, right: CompatMcpServer): CompatMcpServer {
  if (left.transport !== right.transport) return left
  return { ...left, environmentMode: 'combined-plugin' }
}

/**
 * 同一逻辑 Hook 若被两个旧方言同时声明，不能把两套 payload/matcher 语义同时执行。
 * parser 不猜测优先级，而是保留诊断并阻止自动启用。
 */
function diagnoseCrossFormatHookAliases(hooks: readonly CompatHook[], collector: DiagnosticCollector): void {
  const map = new Map<string, CompatHook>()
  for (const hook of hooks) {
    const key = JSON.stringify({
      event: hook.event,
      matcher: hook.matcher,
      commands: hook.commands,
    })
    const previous = map.get(key)
    if (previous === undefined) {
      map.set(key, hook)
      continue
    }
    if (previous.dialect === hook.dialect) continue
    collector.add(
      'error',
      'HOOK_DIALECT_CONFLICT',
      'hook',
      `同一 Hook 同时存在 Claude Code 与 Codex 运行语义，无法在不改变插件语义的前提下自动选择：${hook.event}`,
      hook.sourceFile,
    )
  }
}

async function loadPackageMetadata(packageRoot: string, collector: DiagnosticCollector): Promise<Record<string, unknown>> {
  const file = resolve(packageRoot, 'package.json')
  if (!await pathExists(file)) return {}
  try {
    const value = await readJson(file)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('顶层不是对象')
    return value as Record<string, unknown>
  } catch (error) {
    collector.add('warning', 'PACKAGE_JSON_INVALID', 'plugin', `package.json 无法解析，仅忽略其元数据：${String(error)}`, 'package.json')
    return {}
  }
}

function firstDefinition(definitions: readonly MarketplacePluginDefinition[], format: CompatFormat): MarketplacePluginDefinition | undefined {
  return definitions.find(item => item.format === format)
}

/** 将所有旧格式差异收敛为唯一的 CompatPlugin。 */
export async function parseCompatPlugin(packageRoot: string, options: ParsePluginOptions): Promise<CompatPlugin> {
  const collector = new DiagnosticCollector()
  const definitions = options.marketplaceDefinitions ?? []
  const detection = await detectPluginFormat(packageRoot, collector)
  const requestedFormats = [...new Set([...detection.formats, ...definitions.map(item => item.format)])].sort() as CompatFormat[]
  const descriptors: HarnessDescriptor[] = []
  if (requestedFormats.includes('claude-code')) {
    descriptors.push(await parseClaudeHarness(
      packageRoot,
      collector,
      detection.implicitClaude,
      firstDefinition(definitions, 'claude-code'),
    ))
  }
  if (requestedFormats.includes('codex')) {
    descriptors.push(await parseCodexHarness(packageRoot, collector, firstDefinition(definitions, 'codex')))
  }
  const packageMetadata = await loadPackageMetadata(packageRoot, collector)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const value = packageMetadata[field]
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0) {
      collector.add(
        'warning',
        'NODE_DEPENDENCIES_NOT_INSTALLED',
        'plugin',
        `package.json 声明了 ${field}；dsh-compat 安装阶段默认不执行 npm/pnpm/bun，插件必须自带可运行依赖或由用户显式准备运行环境`,
        'package.json',
      )
      break
    }
  }
  const firstDisplayName = descriptors.map(item => item.displayName).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const firstName = descriptors.map(item => item.name).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const marketplaceName = definitions.map(item => item.name).find((value): value is string => value.trim() !== '')
  const packageName = typeof packageMetadata.name === 'string' ? packageMetadata.name : undefined
  const requestedId = options.asId ?? options.sourcePluginId ?? firstName ?? marketplaceName ?? packageName ?? options.suggestedId ?? 'legacy-plugin'
  let id: string
  try {
    id = normalizeManagementId(requestedId, 'plugin')
  } catch (error) {
    collector.add('error', 'PLUGIN_ID_INVALID', 'plugin', String(error))
    id = 'invalid-plugin'
  }
  if (id !== requestedId) collector.add('info', 'PLUGIN_ID_NORMALIZED', 'plugin', `管理标识已规范化为 ${id}；插件内部能力名称保持不变`)
  const name = options.displayName
    ?? definitions.map(item => item.displayName).find((value): value is string => typeof value === 'string')
    ?? firstDisplayName
    ?? firstName
    ?? marketplaceName
    ?? packageName
    ?? options.suggestedId
    ?? id
  const version = descriptors.map(item => item.version).find((value): value is string => typeof value === 'string')
    ?? definitions.map(item => item.version).find((value): value is string => typeof value === 'string')
    ?? (typeof packageMetadata.version === 'string' ? packageMetadata.version : undefined)

  const skills: CompatSkill[] = []
  const mcpServers: CompatMcpServer[] = []
  const hooks: CompatHook[] = []
  const commands: CompatCommand[] = []
  const agents: CompatAgent[] = []
  for (const descriptor of descriptors) {
    skills.push(...await parseSkillsForHarness(packageRoot, descriptor, collector))
    mcpServers.push(...await parseMcpForHarness(packageRoot, descriptor, collector))
    hooks.push(...await parseHooksForHarness(packageRoot, descriptor, collector))
    commands.push(...await parseCommandsForHarness(packageRoot, descriptor, collector))
    agents.push(...await parseAgentsForHarness(packageRoot, descriptor, collector))
  }

  const normalizedSkills = deDuplicate(
    skills,
    item => item.name,
    'skill',
    'SKILL_NAME_DUPLICATE',
    collector,
    { equivalentAcrossFormats: equivalentDocumentCapability },
  )
  const normalizedMcp = deDuplicate(
    mcpServers,
    item => item.serverName,
    'mcp',
    'MCP_SERVER_NAME_DUPLICATE',
    collector,
    { equivalentAcrossFormats: equivalentMcpAcrossFormats, mergeAcrossFormats: mergeMcpAcrossFormats },
  )
  diagnoseCrossFormatHookAliases(hooks, collector)
  const normalizedHooks = deDuplicate(hooks, item => item.id, 'hook', 'HOOK_DUPLICATE', collector)
  const normalizedCommands = deDuplicate(
    commands,
    item => item.name,
    'command',
    'COMMAND_NAME_DUPLICATE',
    collector,
    { equivalentAcrossFormats: equivalentDocumentCapability },
  )
  const normalizedAgents = deDuplicate(
    agents,
    item => item.name,
    'agent',
    'AGENT_NAME_DUPLICATE',
    collector,
    { equivalentAcrossFormats: equivalentDocumentCapability },
  )

  return {
    schemaVersion: 1,
    id,
    name,
    ...(version === undefined ? {} : { version }),
    sourceId: options.sourceId ?? 'legacy-source',
    sourcePluginId: options.sourcePluginId ?? options.suggestedId ?? id,
    formats: requestedFormats,
    skills: normalizedSkills,
    mcpServers: normalizedMcp,
    hooks: normalizedHooks,
    commands: normalizedCommands,
    agents: normalizedAgents,
    diagnostics: sortDiagnostics(collector.items),
    manifestFiles: [...new Set(descriptors.map(item => item.manifestPath).filter((value): value is string => value !== undefined))],
  }
}

export function withAdditionalDiagnostics(plugin: CompatPlugin, diagnostics: CompatDiagnostic[]): CompatPlugin {
  return { ...plugin, diagnostics: sortDiagnostics([...plugin.diagnostics, ...diagnostics]) }
}
