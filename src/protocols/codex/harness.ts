import { resolve } from 'node:path'
import type { MarketplacePluginDefinition } from '../../types/catalog.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { pathExists } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'
import { collectConfigSources, declaredPathList, loadManifest, manifestRelativePath, normalizeDeclaredPaths, validateMetadata } from './harness-common.js'
import type { ConfigSource, HarnessDescriptor } from '../../types/protocol.js'

/** Legacy resolver 会把空、类型不匹配或语法无效的路径解析为 None/空列表。 */
function codexPaths(value: unknown, field: string, collector: DiagnosticCollector, file?: string): string[] {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : []
  const valid = items.filter(item => manifestRelativePath(item) !== undefined)
  if (value !== undefined && (valid.length === 0 || valid.length !== items.length)) {
    collector.add('warning', 'CODEX_COMPONENT_DEFAULT_FALLBACK', field === 'skills' ? 'skill' : field === 'commands' ? 'command' : 'hook', `${field} 的空值、无效类型或不以 ./ 开头的路径被传统 Codex 忽略；无有效声明时回退默认位置`, file)
  }
  return valid
}

async function codexConfigSources(
  packageRoot: string,
  manifestPath: string | undefined,
  value: unknown,
  field: string,
  defaultFile: string,
  capability: 'hook' | 'mcp',
  collector: DiagnosticCollector,
  definition?: MarketplacePluginDefinition,
): Promise<ConfigSource[]> {
  let explicit: unknown
  if (capability === 'mcp') {
    if (asObject(value) !== undefined) explicit = value
    else if (typeof value === 'string' && manifestRelativePath(value) !== undefined) explicit = value
  } else if (typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'))) {
    const paths = codexPaths(value, field, collector, manifestPath)
    if (paths.length > 0) explicit = typeof value === 'string' ? paths[0] : paths
  } else if (asObject(value) !== undefined) explicit = value
  else if (Array.isArray(value) && value.length > 0 && value.every(item => asObject(item) !== undefined)) explicit = value
  if (value !== undefined && explicit === undefined && !(capability === 'hook' && (typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string')))) {
    collector.add('warning', 'CODEX_COMPONENT_DEFAULT_FALLBACK', capability, `${field} 的空值或无效声明被传统 Codex 忽略，回退默认配置；mcpServers 只接受路径或对象，hooks 数组不能混用路径和对象`, manifestPath)
  }
  const sources = await collectConfigSources(packageRoot, manifestPath, explicit, defaultFile, field, collector, capability, 'codex')
  return definition === undefined ? sources : sources.map(source => source.inline === undefined ? source : { ...source, pointer: `${definition.pointer}${source.pointer ?? ''}` })
}

function diagnoseCodexMetadata(manifest: Record<string, unknown>, collector: DiagnosticCollector, file?: string): void {
  const object = asObject(manifest.interface)
  if (manifest.interface !== undefined && manifest.interface !== null && object === undefined) collector.add('error', 'CODEX_INTERFACE_INVALID', 'plugin', 'interface 必须是对象', file)
  if (object !== undefined) {
    const strings = ['displayName', 'display_name', 'shortDescription', 'longDescription', 'developerName', 'category', 'websiteUrl', 'websiteURL', 'privacyPolicyUrl', 'privacyPolicyURL', 'termsOfServiceUrl', 'termsOfServiceURL', 'brandColor', 'composerIcon', 'logo', 'logoDark']
    for (const key of strings) {
      if (object[key] !== undefined && object[key] !== null && typeof object[key] !== 'string') collector.add('error', 'CODEX_INTERFACE_FIELD_INVALID', 'plugin', `interface.${key} 必须是字符串`, file)
    }
    for (const key of ['screenshots', 'capabilities']) {
      if (object[key] !== undefined && (!Array.isArray(object[key]) || object[key].some(item => typeof item !== 'string'))) collector.add('error', 'CODEX_INTERFACE_FIELD_INVALID', 'plugin', `interface.${key} 必须是字符串数组`, file)
    }
    const prompts = object.defaultPrompt
    if (prompts !== undefined && prompts !== null) {
      const list = typeof prompts === 'string' ? [prompts] : Array.isArray(prompts) ? prompts : [prompts]
      const valid = list.filter(item => typeof item === 'string' && item.trim() !== '' && [...item.trim().replace(/\s+/g, ' ')].length <= 128)
      if (valid.length !== list.length || valid.length > 3) collector.add('warning', 'CODEX_DEFAULT_PROMPT_INVALID', 'plugin', 'interface.defaultPrompt 仅识别最多三个非空且不超过128字符的字符串；无效展示提示不执行', file)
    }
    for (const key of ['composerIcon', 'logo', 'logoDark']) {
      const value = object[key]
      if (typeof value === 'string' && value !== '' && manifestRelativePath(value) === undefined) collector.add('warning', 'CODEX_INTERFACE_ASSET_PATH_INVALID', 'plugin', `interface.${key} 的资源路径无效，应位于插件目录内并以 ./ 开头`, file)
    }
    collector.add('info', 'CODEX_INTERFACE_METADATA_RECOGNIZED', 'plugin', '已识别 Codex interface 展示元数据；当前不注册上游展示界面、默认提示或品牌资源', file)
  }
  if (manifest.apps !== undefined && manifest.apps !== null) {
    if (typeof manifest.apps !== 'string') collector.add('error', 'CODEX_APPS_INVALID', 'plugin', '传统 Codex apps 必须是配置文件路径字符串', file)
    else {
      if (manifest.apps !== '' && manifestRelativePath(manifest.apps) === undefined) collector.add('warning', 'CODEX_APPS_PATH_INVALID', 'plugin', 'apps 路径无效，应以 ./ 开头并位于插件目录内', file)
      collector.add('warning', 'CODEX_APPS_UNSUPPORTED', 'plugin', '已识别 Codex apps 配置；当前没有等价连接器适配器，不执行该能力', file)
    }
  }
  const extensions = asObject(manifest.extensions)
  const openai = asObject(extensions?.['com.openai'])
  const onboarding = openai?.onboardingSkill
  if (onboarding !== undefined) {
    if (typeof onboarding !== 'string' || manifestRelativePath(`./${onboarding.replace(/^\.\//, '')}`) === undefined) collector.add('warning', 'CODEX_ONBOARDING_PATH_INVALID', 'plugin', 'extensions["com.openai"].onboardingSkill 必须是插件内相对路径', file)
    else collector.add('warning', 'CODEX_ONBOARDING_UNSUPPORTED', 'plugin', '已识别传统 Codex onboardingSkill 扩展；当前不执行上游首次启用流程', file)
  }
}

export async function parseCodexHarness(packageRoot: string, collector: DiagnosticCollector, definition?: MarketplacePluginDefinition): Promise<HarnessDescriptor> {
  const manifestPath = '.codex-plugin/plugin.json'
  const hasManifest = await pathExists(resolve(packageRoot, manifestPath))
  const manifest = hasManifest ? await loadManifest(packageRoot, manifestPath, collector) : definition?.manifestFields ?? {}
  const sourceFile = hasManifest ? manifestPath : definition?.file
  if (!hasManifest && definition === undefined) collector.add('error', 'CODEX_PLUGIN_MANIFEST_MISSING', 'plugin', 'Codex 插件缺少必需的 .codex-plugin/plugin.json，且 Marketplace 未提供回退清单', manifestPath)
  else if (!hasManifest) collector.add('info', 'CODEX_MARKETPLACE_MANIFEST_FALLBACK', 'plugin', '未找到 .codex-plugin/plugin.json，使用 Codex Marketplace 条目中的清单字段', definition?.file)
  validateMetadata(manifest, collector, sourceFile, 'codex', !hasManifest && definition !== undefined)
  diagnoseCodexMetadata(manifest, collector, sourceFile)
  if ((manifest.apps === undefined || manifest.apps === null || typeof manifest.apps === 'string' && manifestRelativePath(manifest.apps) === undefined) && await pathExists(resolve(packageRoot, '.app.json'))) collector.add('warning', 'CODEX_APPS_UNSUPPORTED', 'plugin', '已识别传统 Codex 默认 .app.json 配置；当前没有等价连接器适配器，不执行该能力', '.app.json')
  if (manifest.paths !== undefined) collector.add('error', 'CODEX_PLUGIN_PATHS_UNSUPPORTED', 'plugin', '传统 Codex 插件 JSON 不支持 paths 包装字段；Agent Plugins 1.0.0 是独立且不在本兼容范围的协议', sourceFile)
  if (hasManifest && definition?.manifestFields.paths !== undefined) collector.add('error', 'CODEX_MARKETPLACE_PATHS_UNSUPPORTED', 'plugin', 'Codex Marketplace 回退清单的 paths 字段不会覆盖真实清单，也不会被猜测执行', definition.file)
  if (manifest.mcp_servers !== undefined) collector.add('warning', 'CODEX_LEGACY_MCP_ALIAS', 'mcp', 'mcp_servers 按早期兼容别名解析；传统官方清单字段为 mcpServers', sourceFile)
  if (manifest.mcpServers !== undefined && manifest.mcp_servers !== undefined) collector.add('warning', 'CODEX_MCP_ALIAS_SHADOWED', 'mcp', 'mcpServers 优先，mcp_servers 别名不再叠加', sourceFile)
  const skillValue = codexPaths(manifest.skills, 'skills', collector, sourceFile)
  const commandValue = codexPaths(manifest.commands, 'commands', collector, sourceFile)
  const skillPaths = await normalizeDeclaredPaths(packageRoot, skillValue, collector, 'skill', sourceFile)
  const commandPaths = await normalizeDeclaredPaths(packageRoot, commandValue, collector, 'command', sourceFile)
  const agentPaths = await normalizeDeclaredPaths(packageRoot, declaredPathList(manifest.agents, collector, 'agent', 'agents', sourceFile), collector, 'agent', sourceFile)
  const mcpField = manifest.mcpServers !== undefined ? 'mcpServers' : 'mcp_servers'
  const mcpValue = manifest[mcpField]
  const interfaceValue = asObject(manifest.interface)
  const displayName = interfaceValue?.displayName ?? interfaceValue?.display_name
  return {
    format: 'codex',
    ...(sourceFile === undefined ? {} : { manifestPath: sourceFile }),
    manifest,
    ...(typeof manifest.name === 'string' && manifest.name.trim() !== '' ? { name: manifest.name } : definition === undefined ? {} : { name: definition.name }),
    ...(typeof manifest.version === 'string' && manifest.version.trim() !== '' ? { version: manifest.version.trim() } : definition?.version === undefined ? {} : { version: definition.version }),
    ...(typeof displayName === 'string' && displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
    skillPaths,
    commandPaths,
    agentPaths,
    defaultCapabilityPaths: { skills: skillValue.length === 0, commands: manifest.commands === undefined, agents: manifest.agents === undefined },
    hookSources: await codexConfigSources(packageRoot, sourceFile, manifest.hooks, 'hooks', 'hooks/hooks.json', 'hook', collector, hasManifest ? undefined : definition),
    mcpSources: await codexConfigSources(packageRoot, sourceFile, mcpValue, mcpField, '.mcp.json', 'mcp', collector, hasManifest ? undefined : definition),
  }
}
