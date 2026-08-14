import { resolve } from 'node:path'
import type { MarketplacePluginDefinition } from '../source/types.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { pathExists } from '../shared/fs.js'
import { asObject } from '../shared/object.js'
import {
  collectConfigSources,
  declaredPathList,
  loadManifest,
  normalizeDeclaredPaths,
} from './common.js'
import type { HarnessDescriptor } from './types.js'

function combinedPathValue(...values: unknown[]): unknown {
  const present = values.filter(value => value !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return present.flatMap(value => Array.isArray(value) ? value : [value])
}

function manifestPointer(definition: MarketplacePluginDefinition | undefined, field: string): string | undefined {
  return definition === undefined ? undefined : `${definition.pointer}/${field}`
}

async function collectCodexConfigSources(options: {
  packageRoot: string
  manifestPath: string | undefined
  manifestValue: unknown
  manifestField: string
  definition: MarketplacePluginDefinition | undefined
  definitionValue: unknown
  definitionField: string
  defaultFile: string
  capability: 'mcp' | 'hook'
  collector: DiagnosticCollector
  includeDefault: boolean
}): Promise<Array<{ file: string; inline?: unknown; pointer?: string }>> {
  const result: Array<{ file: string; inline?: unknown; pointer?: string }> = []
  if (options.includeDefault) {
    result.push(...await collectConfigSources(
      options.packageRoot,
      options.manifestPath,
      undefined,
      options.defaultFile,
      options.manifestField,
      options.collector,
      options.capability,
    ))
  }
  if (options.manifestValue !== undefined) {
    result.push(...await collectConfigSources(
      options.packageRoot,
      options.manifestPath,
      options.manifestValue,
      options.defaultFile,
      options.manifestField,
      options.collector,
      options.capability,
    ))
  }
  const definition = options.definition
  if (definition !== undefined && options.definitionValue !== undefined) {
    const sources = await collectConfigSources(
      options.packageRoot,
      definition.file,
      options.definitionValue,
      options.defaultFile,
      options.definitionField,
      options.collector,
      options.capability,
    )
    const base = manifestPointer(definition, options.definitionField)
    result.push(...sources.map(source => ({
      ...source,
      pointer: source.pointer === undefined
        ? base
        : `${definition.pointer}${source.pointer}`,
    })))
  }
  return [...new Map(result.map(item => [`${item.file}:${item.pointer ?? ''}`, item])).values()]
}

/**
 * Codex 插件清单使用顶层 skills/hooks/mcpServers/apps 字段。Marketplace 条目
 * 只有在插件目录缺少 plugin.json 时才作为回退清单；存在真实清单时不叠加
 * Marketplace 的清单字段，保持与 Codex 当前加载顺序一致。
 */
export async function parseCodexHarness(
  packageRoot: string,
  collector: DiagnosticCollector,
  definition?: MarketplacePluginDefinition,
): Promise<HarnessDescriptor> {
  const manifestPath = '.codex-plugin/plugin.json'
  const hasManifest = await pathExists(resolve(packageRoot, manifestPath))
  const fallbackManifest = definition?.manifestFields ?? {}
  const manifest = hasManifest
    ? await loadManifest(packageRoot, manifestPath, collector)
    : fallbackManifest
  if (!hasManifest && definition === undefined) {
    collector.add('error', 'CODEX_PLUGIN_MANIFEST_MISSING', 'plugin', 'Codex 插件缺少必需的 .codex-plugin/plugin.json，且 Marketplace 未提供回退清单', manifestPath)
  } else if (!hasManifest) {
    collector.add('info', 'CODEX_MARKETPLACE_MANIFEST_FALLBACK', 'plugin', '未找到 .codex-plugin/plugin.json，使用 Codex Marketplace 条目中的清单字段', definition?.file)
  }

  if (manifest.paths !== undefined) {
    collector.add(
      'error',
      'CODEX_PLUGIN_PATHS_UNSUPPORTED',
      'plugin',
      'Codex 插件 JSON 不支持 paths 包装字段；请使用顶层 skills、hooks、mcpServers 或 apps。该字段不会被猜测执行',
      hasManifest ? manifestPath : definition?.file,
    )
  }
  if (hasManifest && definition?.manifestFields.paths !== undefined) {
    collector.add(
      'error',
      'CODEX_MARKETPLACE_PATHS_UNSUPPORTED',
      'plugin',
      'Codex Marketplace 回退清单不支持 paths 包装字段；存在真实 plugin.json 时该字段也不会覆盖或叠加真实清单',
      definition.file,
    )
  }

  const sourceFile = hasManifest ? manifestPath : definition?.file
  const skillValue = combinedPathValue(manifest.skills)
  const commandValue = combinedPathValue(manifest.commands)
  const agentValue = combinedPathValue(manifest.agents)
  const skillPaths = await normalizeDeclaredPaths(
    packageRoot,
    declaredPathList(skillValue, collector, 'skill', 'skills', sourceFile),
    collector,
    'skill',
    sourceFile,
  )
  const commandPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(commandValue, collector, 'command', 'commands', sourceFile), collector, 'command', sourceFile)
  const agentPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(agentValue, collector, 'agent', 'agents', sourceFile), collector, 'agent', sourceFile)

  const manifestMcpField = manifest.mcpServers !== undefined ? 'mcpServers' : 'mcp_servers'
  const manifestMcpValue = manifest.mcpServers ?? manifest.mcp_servers
  const manifestHookField = 'hooks'
  const manifestHookValue = manifest.hooks

  const apps = manifest.apps
  if (apps !== undefined) {
    collector.add(
      'warning',
      'CODEX_APPS_UNSUPPORTED',
      'plugin',
      '已识别 Codex apps 能力，但当前 DSH 没有等价适配器；该能力不会执行，也不会静默丢失此差异',
      sourceFile,
    )
  }

  const defaultCapabilityPaths = {
    skills: !(definition?.sourcePathIsRoot === true && skillValue !== undefined),
    commands: !(definition?.sourcePathIsRoot === true && commandValue !== undefined),
    agents: !(definition?.sourcePathIsRoot === true && agentValue !== undefined),
  }
  const interfaceValue = asObject(manifest.interface)
  const displayName = interfaceValue === undefined
    ? undefined
    : typeof interfaceValue.displayName === 'string'
      ? interfaceValue.displayName.trim()
      : typeof interfaceValue.display_name === 'string'
        ? interfaceValue.display_name.trim()
        : undefined

  return {
    format: 'codex',
    ...(hasManifest ? { manifestPath } : definition === undefined ? {} : { manifestPath: definition.file }),
    manifest,
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : definition === undefined ? {} : { name: definition.name }),
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : definition?.version === undefined ? {} : { version: definition.version }),
    ...(displayName === undefined ? {} : { displayName }),
    skillPaths,
    commandPaths,
    agentPaths,
    defaultCapabilityPaths,
    hookSources: await collectCodexConfigSources({
      packageRoot,
      manifestPath: hasManifest ? manifestPath : undefined,
      manifestValue: hasManifest ? manifestHookValue : undefined,
      manifestField: manifestHookField,
      definition,
      definitionValue: hasManifest ? undefined : manifestHookValue,
      definitionField: manifestHookField,
      defaultFile: 'hooks/hooks.json',
      capability: 'hook',
      collector,
      includeDefault: !(definition?.sourcePathIsRoot === true && manifestHookValue !== undefined),
    }),
    mcpSources: await collectCodexConfigSources({
      packageRoot,
      manifestPath: hasManifest ? manifestPath : undefined,
      manifestValue: hasManifest ? manifestMcpValue : undefined,
      manifestField: manifestMcpField,
      definition,
      definitionValue: hasManifest ? undefined : manifestMcpValue,
      definitionField: manifestMcpField,
      defaultFile: '.mcp.json',
      capability: 'mcp',
      collector,
      includeDefault: !(definition?.sourcePathIsRoot === true && manifestMcpValue !== undefined),
    }),
  }
}
