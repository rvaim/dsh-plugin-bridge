import { resolve } from 'node:path'
import type { MarketplacePluginDefinition } from '../../types/catalog.js'
import { DiagnosticCollector } from '../../shared/diagnostics.js'
import { pathExists, readJson } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'
import { escapeJsonPointer } from './template.js'
import {
  collectConfigSources,
  collectMergedConfigSources,
  declaredPathList,
  loadManifest,
  normalizeDeclaredPaths,
  validateMetadata,
} from './harness-common.js'
import type { HarnessDescriptor } from '../../types/protocol.js'

const COMPONENT_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'outputStyles', 'themes'] as const

type UnsupportedClaudeCapability = {
  field: string
  code: string
  level: 'error' | 'warning'
  message: string
}

const UNSUPPORTED_COMPONENTS: UnsupportedClaudeCapability[] = [
  { field: 'settings', code: 'CLAUDE_SETTINGS_UNSUPPORTED', level: 'error', message: '插件声明了 Claude Code settings；当前无法复现 agent/subagentStatusLine 启用语义，已阻止自动启用' },
  { field: 'workflows', code: 'CLAUDE_WORKFLOWS_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Workflow，但当前 DSH 没有等价适配器；该能力暂不执行' },
  { field: 'outputStyles', code: 'CLAUDE_OUTPUT_STYLES_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Output Style，但当前 DSH 没有等价适配器；该能力暂不执行' },
  { field: 'lspServers', code: 'CLAUDE_LSP_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code LSP Server，但当前 DSH 没有等价适配器；该能力暂不启动' },
  { field: 'userConfig', code: 'CLAUDE_USER_CONFIG_UNSUPPORTED', level: 'error', message: '插件声明了 Claude Code userConfig；当前无法安全复现启用时配置收集、敏感值存储及 ${user_config.*} 替换，已阻止自动启用' },
  { field: 'channels', code: 'CLAUDE_CHANNELS_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Channel，但当前 DSH 没有等价消息注入适配器；该能力暂不执行' },
  { field: 'dependencies', code: 'CLAUDE_PLUGIN_DEPENDENCIES_UNSUPPORTED', level: 'error', message: '插件声明了 Claude Code 插件依赖；当前不会自动安装、启用或校验依赖版本，已阻止自动启用以避免半兼容运行' },
]

async function diagnoseUnsupportedClaudeCapabilities(
  packageRoot: string,
  manifest: Record<string, unknown>,
  manifestFile: string | undefined,
  definition: MarketplacePluginDefinition | undefined,
  collector: DiagnosticCollector,
  scanDefaultLocations: boolean,
): Promise<void> {
  const emitted = new Set<string>()
  const add = (item: UnsupportedClaudeCapability, file?: string): void => {
    if (emitted.has(item.code)) return
    emitted.add(item.code)
    collector.add(item.level, item.code, 'plugin', item.message, file)
  }
  const inspect = (value: Record<string, unknown>, file?: string): void => {
    for (const item of UNSUPPORTED_COMPONENTS) {
      if (value[item.field] !== undefined) add(item, file)
    }
    const experimental = value.experimental
    if (experimental !== undefined && (experimental === null || typeof experimental !== 'object' || Array.isArray(experimental))) {
      collector.add('warning', 'CLAUDE_EXPERIMENTAL_INVALID', 'plugin', 'Claude Code experimental 字段不是对象；与上游行为一致，不把它当作可执行能力', file)
      return
    }
    const object = experimental as Record<string, unknown> | undefined
    if (object?.themes !== undefined || value.themes !== undefined) {
      add({ field: 'themes', code: 'CLAUDE_THEMES_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Theme，但当前 DSH 没有等价主题适配器；该能力暂不注册' }, file)
    }
    if (object?.monitors !== undefined || value.monitors !== undefined) {
      add({ field: 'monitors', code: 'CLAUDE_MONITORS_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Monitor，但当前 DSH 没有等价生命周期适配器；不会启动后台监控命令' }, file)
    }
  }
  inspect(manifest, manifestFile)
  if (definition !== undefined) inspect(definition.manifestFields, definition.file)

  if (!scanDefaultLocations) return
  const defaults: Array<{ path: string; item: UnsupportedClaudeCapability }> = [
    { path: 'workflows', item: UNSUPPORTED_COMPONENTS.find(item => item.field === 'workflows')! },
    { path: 'output-styles', item: UNSUPPORTED_COMPONENTS.find(item => item.field === 'outputStyles')! },
    { path: '.lsp.json', item: UNSUPPORTED_COMPONENTS.find(item => item.field === 'lspServers')! },
    { path: 'themes', item: { field: 'themes', code: 'CLAUDE_THEMES_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Theme，但当前 DSH 没有等价主题适配器；该能力暂不注册' } },
    { path: 'monitors/monitors.json', item: { field: 'monitors', code: 'CLAUDE_MONITORS_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Monitor，但当前 DSH 没有等价生命周期适配器；不会启动后台监控命令' } },
    { path: 'bin', item: { field: 'bin', code: 'CLAUDE_BIN_PATH_UNSUPPORTED', level: 'warning', message: '插件包含 Claude Code bin/ 可执行目录；当前不会修改 DSH Shell 的 PATH' } },
    { path: 'settings.json', item: UNSUPPORTED_COMPONENTS.find(item => item.field === 'settings')! },
  ]
  for (const entry of defaults) {
    if (await pathExists(resolve(packageRoot, entry.path))) add(entry.item, entry.path)
  }
}

export async function preflightClaudeHarness(packageRoot: string, definition?: MarketplacePluginDefinition) {
  const collector = new DiagnosticCollector()
  const manifestPath = '.claude-plugin/plugin.json'
  const hasManifest = await pathExists(resolve(packageRoot, manifestPath))
  const manifest = hasManifest ? await loadManifest(packageRoot, manifestPath, collector) : definition?.manifestFields ?? {}
  const file = hasManifest ? manifestPath : definition?.file
  validateMetadata(manifest, collector, file, 'claude-code', !hasManifest && definition !== undefined)
  if (hasManifest && definition !== undefined) validateMetadata(definition.manifestFields, collector, definition.file, 'claude-code', true)
  if (definition?.strict === false && hasManifest) {
    const conflicts = COMPONENT_FIELDS.filter(field => definition.manifestFields[field] !== undefined || (definition as unknown as Record<string, unknown>)[field] !== undefined)
    if (conflicts.length > 0) collector.add('error', 'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT', 'plugin', `Claude Marketplace strict=false 时，条目不能为已有 plugin.json 声明能力字段：${conflicts.join(', ')}`, definition.file)
  }
  await diagnoseUnsupportedClaudeCapabilities(packageRoot, manifest, file, definition, collector, false)
  const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : definition?.name
  return { name, diagnostics: collector.items }
}

export async function parseClaudeHarness(
  packageRoot: string,
  collector: DiagnosticCollector,
  implicit = false,
  definition?: MarketplacePluginDefinition,
): Promise<HarnessDescriptor> {
  const manifestPath = '.claude-plugin/plugin.json'
  const hasManifest = await pathExists(resolve(packageRoot, manifestPath))
  const manifest = hasManifest ? await loadManifest(packageRoot, manifestPath, collector) : definition?.manifestFields ?? {}
  const sourceFile = hasManifest ? manifestPath : definition?.file
  validateMetadata(manifest, collector, sourceFile, 'claude-code', !hasManifest && definition !== undefined)
  if (hasManifest && definition !== undefined) validateMetadata(definition.manifestFields, collector, definition.file, 'claude-code', true)
  if (implicit && definition === undefined) collector.add('warning', 'PLUGIN_FORMAT_INFERRED', 'plugin', '未找到显式插件清单，按 Claude Code 目录约定解析')

  const strict = definition?.strict ?? true
  if (!strict && hasManifest && definition !== undefined) {
    const conflicts = COMPONENT_FIELDS.filter(field => definition.manifestFields[field] !== undefined || (definition as unknown as Record<string, unknown>)[field] !== undefined)
    if (conflicts.length > 0) collector.add('error', 'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT', 'plugin', `Claude Marketplace strict=false 时，条目不能为已有 plugin.json 声明能力字段：${conflicts.join(', ')}`, definition.file)
  }
  await diagnoseUnsupportedClaudeCapabilities(packageRoot, manifest, sourceFile, definition, collector, true)

  const entries: Array<{ value: Record<string, unknown>; file: string | undefined; pointer: string }> = [
    { value: manifest, file: sourceFile, pointer: hasManifest ? '' : definition?.pointer ?? '' },
  ]
  if (hasManifest && strict && definition !== undefined) entries.push({ value: { ...definition.manifestFields, skills: definition.skills, commands: definition.commands, agents: definition.agents }, file: definition.file, pointer: definition.pointer })
  const skillPaths: string[] = []
  const commandPaths: string[] = []
  const agentPaths: string[] = []
  const commandDefinitions: NonNullable<HarnessDescriptor['commandDefinitions']> = []
  for (const entry of entries) {
    skillPaths.push(...await normalizeDeclaredPaths(packageRoot, declaredPathList(entry.value.skills, collector, 'skill', 'skills', entry.file), collector, 'skill', entry.file, { kind: 'directory', requireExists: true }))
    agentPaths.push(...await normalizeDeclaredPaths(packageRoot, declaredPathList(entry.value.agents, collector, 'agent', 'agents', entry.file), collector, 'agent', entry.file, { kind: 'file', requireExists: true }))
    const commandMap = asObject(entry.value.commands)
    if (commandMap !== undefined && entry.file !== undefined) {
      for (const [name, value] of Object.entries(commandMap)) commandDefinitions.push({ name, value, file: entry.file, pointer: `${entry.pointer}/commands/${escapeJsonPointer(name)}` })
    } else {
      commandPaths.push(...await normalizeDeclaredPaths(packageRoot, declaredPathList(entry.value.commands, collector, 'command', 'commands', entry.file), collector, 'command', entry.file, { requireExists: true }))
    }
  }

  const entryHooks = definition?.hooks
  let hookSources: HarnessDescriptor['hookSources']
  if (!hasManifest) {
    // 缺少 plugin.json 时，Marketplace 的 hooks 目前仅支持内联对象。
    if (entryHooks !== undefined && asObject(entryHooks) === undefined) {
      collector.add('error', 'CLAUDE_MARKETPLACE_HOOKS_FORM_UNSUPPORTED', 'hook', '无 plugin.json 的 Marketplace 条目 hooks 仅支持内联对象；文件路径或数组尚未适配', definition?.file)
      hookSources = await collectConfigSources(packageRoot, sourceFile, undefined, 'hooks/hooks.json', 'hooks', collector, 'hook')
    } else {
      hookSources = await collectMergedConfigSources(packageRoot, undefined, undefined, definition === undefined || entryHooks === undefined ? undefined : { file: definition.file, pointer: definition.pointer, value: entryHooks }, 'hooks/hooks.json', 'hooks', collector, 'hook')
    }
  } else {
    hookSources = await collectMergedConfigSources(packageRoot, manifestPath, manifest.hooks, undefined, 'hooks/hooks.json', 'hooks', collector, 'hook')
    if (strict && definition !== undefined && entryHooks !== undefined) {
      const added = await collectConfigSources(packageRoot, definition.file, entryHooks, 'hooks/hooks.json', 'hooks', collector, 'hook')
      const replacements: string[] = []
      for (const source of added) {
        try {
          const root = asObject(source.inline ?? await readJson(resolve(packageRoot, source.file)))
          const events = asObject(root?.hooks) ?? root
          if (events !== undefined) replacements.push(...Object.keys(events).filter(key => key !== 'description'))
        } catch {
          // 具体 JSON 错误由 Hook parser 诊断。
        }
      }
      if (replacements.length > 0) hookSources = hookSources.map(source => ({ ...source, excludedEvents: [...new Set(replacements)] }))
      hookSources.push(...added.map(source => source.inline === undefined ? source : { ...source, pointer: `${definition.pointer}${source.pointer ?? ''}` }))
    }
  }
  const mcpSources = await collectMergedConfigSources(
    packageRoot,
    hasManifest ? manifestPath : undefined,
    hasManifest ? manifest.mcpServers : undefined,
    definition?.mcpServers === undefined ? undefined : { file: definition.file, pointer: definition.pointer, value: definition.mcpServers },
    '.mcp.json', 'mcpServers', collector, 'mcp',
  )
  const defaultEnabled = definition?.defaultEnabled ?? manifest.defaultEnabled
  const displayName = definition?.displayName ?? manifest.displayName
  return {
    format: 'claude-code',
    ...(sourceFile === undefined ? {} : { manifestPath: sourceFile }),
    manifest,
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : definition === undefined ? {} : { name: definition.name }),
    ...(typeof displayName === 'string' && displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : definition?.version === undefined ? {} : { version: definition.version }),
    ...(typeof defaultEnabled === 'boolean' ? { defaultEnabled } : {}),
    skillPaths,
    commandPaths,
    agentPaths,
    ...(commandDefinitions.length === 0 ? {} : { commandDefinitions }),
    defaultCapabilityPaths: {
      skills: !(definition?.sourcePathIsRoot === true && definition.skills !== undefined),
      commands: entries.every(entry => entry.value.commands === undefined),
      agents: entries.every(entry => entry.value.agents === undefined),
    },
    hookSources,
    mcpSources,
  }
}
