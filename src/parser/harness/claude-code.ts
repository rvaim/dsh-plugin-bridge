import { resolve } from 'node:path'
import type { MarketplacePluginDefinition } from '../source/types.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { pathExists } from '../shared/fs.js'
import {
  collectMergedConfigSources,
  declaredPathList,
  loadManifest,
  normalizeDeclaredPaths,
} from './common.js'
import type { HarnessDescriptor } from './types.js'

const COMPONENT_FIELDS = [
  'skills',
  'commands',
  'agents',
  'workflows',
  'hooks',
  'mcpServers',
  'outputStyles',
  'lspServers',
  'experimental',
  'userConfig',
  'channels',
  'dependencies',
] as const

type UnsupportedClaudeCapability = {
  field: string
  code: string
  level: 'error' | 'warning'
  message: string
}

const UNSUPPORTED_COMPONENTS: UnsupportedClaudeCapability[] = [
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
    { path: 'workflows', item: UNSUPPORTED_COMPONENTS[0] },
    { path: 'output-styles', item: UNSUPPORTED_COMPONENTS[1] },
    { path: '.lsp.json', item: UNSUPPORTED_COMPONENTS[2] },
    { path: 'themes', item: { field: 'themes', code: 'CLAUDE_THEMES_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Theme，但当前 DSH 没有等价主题适配器；该能力暂不注册' } },
    { path: 'monitors/monitors.json', item: { field: 'monitors', code: 'CLAUDE_MONITORS_UNSUPPORTED', level: 'warning', message: '已识别 Claude Code Monitor，但当前 DSH 没有等价生命周期适配器；不会启动后台监控命令' } },
    { path: 'bin', item: { field: 'bin', code: 'CLAUDE_BIN_PATH_UNSUPPORTED', level: 'warning', message: '插件包含 Claude Code bin/ 可执行目录；当前不会修改 DSH Shell 的 PATH' } },
    { path: 'settings.json', item: { field: 'settings', code: 'CLAUDE_SETTINGS_UNSUPPORTED', level: 'warning', message: '插件包含 Claude Code settings.json；当前不会把旧插件设置写入 DSH 全局配置' } },
  ]
  for (const entry of defaults) {
    if (await pathExists(resolve(packageRoot, entry.path))) add(entry.item, entry.path)
  }
}

function combinedPathValue(manifestValue: unknown, definitionValue: unknown): unknown {
  if (manifestValue === undefined) return definitionValue
  if (definitionValue === undefined) return manifestValue
  const left = Array.isArray(manifestValue) ? manifestValue : [manifestValue]
  const right = Array.isArray(definitionValue) ? definitionValue : [definitionValue]
  return [...left, ...right]
}

export async function parseClaudeHarness(
  packageRoot: string,
  collector: DiagnosticCollector,
  implicit = false,
  definition?: MarketplacePluginDefinition,
): Promise<HarnessDescriptor> {
  const manifestPath = '.claude-plugin/plugin.json'
  const hasManifest = await pathExists(resolve(packageRoot, manifestPath))
  const manifest = hasManifest ? await loadManifest(packageRoot, manifestPath, collector) : {}
  if (implicit && definition === undefined) {
    collector.add('warning', 'PLUGIN_FORMAT_INFERRED', 'plugin', '未找到显式插件清单，按 Claude Code 目录约定解析')
  }

  const strict = definition?.strict ?? true
  if (!strict && hasManifest) {
    const conflicts = COMPONENT_FIELDS.filter(field => manifest[field] !== undefined)
    if (conflicts.length > 0) {
      collector.add(
        'error',
        'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT',
        'plugin',
        `Claude Marketplace strict=false 时，plugin.json 不得同时声明能力字段：${conflicts.join(', ')}`,
        definition?.file,
      )
    }
  }
  const componentManifest = strict ? manifest : {}
  await diagnoseUnsupportedClaudeCapabilities(
    packageRoot,
    componentManifest,
    hasManifest ? manifestPath : undefined,
    definition,
    collector,
    strict,
  )
  const skillValue = combinedPathValue(componentManifest.skills, definition?.skills)
  const commandValue = combinedPathValue(componentManifest.commands, definition?.commands)
  const agentValue = combinedPathValue(componentManifest.agents, definition?.agents)
  const skillPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(skillValue, collector, 'skill', 'skills', hasManifest ? manifestPath : definition?.file), collector, 'skill', hasManifest ? manifestPath : definition?.file)
  const commandPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(commandValue, collector, 'command', 'commands', hasManifest ? manifestPath : definition?.file), collector, 'command', hasManifest ? manifestPath : definition?.file)
  const agentPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(agentValue, collector, 'agent', 'agents', hasManifest ? manifestPath : definition?.file), collector, 'agent', hasManifest ? manifestPath : definition?.file)

  // 当多个 Marketplace 条目都以 Source 根目录为插件根时，条目中显式列出的
  // 能力路径必须是该 Plugin 的边界。继续扫描根目录默认路径会把其他条目的
  // Skill/Command/Agent 一并装入，破坏 Source 与 Plugin 的分离。
  const defaultCapabilityPaths = {
    // strict=false 表示 Marketplace 条目是完整能力定义。即使 package/ 中恰好
    // 存在默认目录，也不能回退扫描，否则会把条目未声明的能力偷偷加载进来。
    skills: strict && !(definition?.sourcePathIsRoot === true && definition.skills !== undefined),
    commands: strict && !(definition?.sourcePathIsRoot === true && definition.commands !== undefined),
    agents: strict && !(definition?.sourcePathIsRoot === true && definition.agents !== undefined),
  }

  const definitionPointer = definition?.pointer
  return {
    format: 'claude-code',
    ...(hasManifest ? { manifestPath } : definition === undefined ? {} : { manifestPath: definition.file }),
    manifest,
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : definition === undefined ? {} : { name: definition.name }),
    ...(typeof manifest.displayName === 'string' && manifest.displayName.trim() !== '' ? { displayName: manifest.displayName.trim() } : {}),
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : definition?.version === undefined ? {} : { version: definition.version }),
    skillPaths,
    commandPaths,
    agentPaths,
    defaultCapabilityPaths,
    hookSources: await collectMergedConfigSources(
      packageRoot,
      hasManifest ? manifestPath : undefined,
      strict ? componentManifest.hooks : [],
      definition?.hooks === undefined || definitionPointer === undefined ? undefined : { file: definition.file, pointer: definitionPointer, value: definition.hooks },
      'hooks/hooks.json',
      'hooks',
      collector,
      'hook',
    ),
    mcpSources: await collectMergedConfigSources(
      packageRoot,
      hasManifest ? manifestPath : undefined,
      strict ? componentManifest.mcpServers : [],
      definition?.mcpServers === undefined || definitionPointer === undefined ? undefined : { file: definition.file, pointer: definitionPointer, value: definition.mcpServers },
      '.mcp.json',
      'mcpServers',
      collector,
      'mcp',
    ),
  }
}
