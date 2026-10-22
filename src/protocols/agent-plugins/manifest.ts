import { readdir, readFile } from 'node:fs/promises'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { asObject } from '../../shared/object.js'
import { inspectContainedPath } from '../../shared/contained-path.js'
import { validateAgentPluginManifest } from './schema.js'

const MANIFEST_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions',
])

/** 先验证唯一核心 manifest；任何致命错误都不返回组件发现描述符。 */
export async function parseAgentPluginsHarness(root: string, collector: DiagnosticCollector): Promise<HarnessDescriptor | undefined> {
  const file = 'plugin.json'
  const invalid = (code = 'AGENT_PLUGIN_MANIFEST_INVALID', message = 'Agent Plugins plugin.json 必须满足本地支持的 1.0.0 清单规范'): undefined => {
    collector.add('error', code, 'plugin', message, file)
    return undefined
  }
  let entries: string[]
  try { entries = await readdir(root) } catch { return invalid() }
  // 在大小写不敏感文件系统上同样只接受规范的精确文件名。
  if (!entries.includes(file)) return invalid()
  const location = await inspectContainedPath(root, file, 'file')
  if (location.status !== 'ok') return invalid('AGENT_PLUGIN_MANIFEST_PATH_INVALID', 'Agent Plugins plugin.json 必须是插件真实根目录内的普通文件')
  let value: Record<string, unknown> | undefined
  try { value = asObject(JSON.parse(await readFile(location.path, 'utf8')) as unknown) } catch { return invalid() }
  if (value === undefined) return invalid()

  const portable: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(value)) {
    if (!MANIFEST_FIELDS.has(field)) {
      collector.add('warning', 'AGENT_PLUGIN_MANIFEST_UNKNOWN_FIELD', 'plugin', `Agent Plugins 未知顶层字段已忽略：${field}`, file, { field })
      continue
    }
    if (field === 'extensions') {
      const extensions = asObject(item)
      if (extensions === undefined) {
        collector.add('warning', 'AGENT_PLUGIN_EXTENSIONS_INVALID', 'plugin', 'Agent Plugins extensions 不是对象，已忽略', file)
      } else if (Object.keys(extensions).length > 0) {
        // §8.1：未实现任何 namespace，不验证其 value，亦不保留敏感原值。
        const namespaces = Object.keys(extensions).sort()
        collector.add('warning', 'AGENT_PLUGIN_EXTENSIONS_IGNORED', 'plugin',
          `Agent Plugins 未实现的扩展命名空间已忽略：${namespaces.join('、')}`, file, { namespaces })
      }
      continue
    }
    Object.defineProperty(portable, field, { value: item, enumerable: true, configurable: true, writable: true })
  }
  if (!validateAgentPluginManifest(portable)) return invalid()
  const legacyEntries = entries
    .filter(entry => ['.claude-plugin', '.codex-plugin', '.mcp.json', 'hooks', 'commands', 'agents'].includes(entry))
    .sort()
  if (legacyEntries.length > 0) {
    collector.add('warning', 'AGENT_PLUGIN_LEGACY_COMPONENTS_IGNORED', 'plugin',
      `Agent Plugins 仅从固定 skills/ 与 mcp.json 发现组件；已忽略这些旧格式文件或目录：${legacyEntries.join('、')}`, file,
      { entries: legacyEntries })
  }
  return {
    format: 'agent-plugins',
    manifestPath: file,
    manifest: portable,
    name: portable.name as string,
    ...(portable.version === undefined ? {} : { version: portable.version as string }),
    skillPaths: ['skills'],
    commandPaths: [],
    agentPaths: [],
    defaultCapabilityPaths: { skills: false, commands: false, agents: false },
    hookSources: [],
    mcpSources: [{ file: 'mcp.json' }],
  }
}
