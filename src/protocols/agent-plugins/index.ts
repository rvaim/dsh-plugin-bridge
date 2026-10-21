import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PluginParser } from '../../parser/contracts.js'
import { DiagnosticCollector } from '../../shared/diagnostics.js'
import { parseAgentPluginsHarness } from './manifest.js'
import { parseAgentPluginSkills } from './skills.js'
import { parseAgentPluginMcp } from './mcp.js'
import { AGENT_PLUGIN_SCHEMA_URI, AGENT_PLUGINS_VERSION } from './constants.js'

export const agentPluginsParser: PluginParser = {
  id: 'agent-plugins',
  version: '1.1.0',
  category: { label: { default: 'Agent Plugins', en: 'Agent Plugins', zh: 'Agent Plugins' }, order: 30 },
  signature: { id: 'agent-plugins', manifestPaths: ['plugin.json'], marketplacePaths: [], exclusive: true, priority: 100 },
  async detect(root) {
    const matched = await lstat(resolve(root, 'plugin.json')).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    return { matched }
  },
  async discoverSource() { return undefined },
  async inferName(root) {
    const descriptor = await parseAgentPluginsHarness(root, new DiagnosticCollector())
    return descriptor?.name
  },
  async parsePlugin({ root }) {
    const collector = new DiagnosticCollector()
    const descriptor = await parseAgentPluginsHarness(root, collector)
    if (descriptor === undefined) return {
      format: 'agent-plugins', metadataPolicy: 'manifest-only', manifestFiles: [],
      skills: [], mcpServers: [], hooks: [], commands: [], agents: [], diagnostics: collector.items,
    }
    const skills = await parseAgentPluginSkills(root, collector)
    const mcpServers = await parseAgentPluginMcp(root, collector)
    return {
      format: 'agent-plugins', metadataPolicy: 'manifest-only',
      name: descriptor.name,
      ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
      protocol: { format: 'agent-plugins', version: AGENT_PLUGINS_VERSION, schema: AGENT_PLUGIN_SCHEMA_URI },
      manifestFiles: descriptor.manifestPath === undefined ? [] : [descriptor.manifestPath],
      skills, mcpServers, hooks: [], commands: [], agents: [], diagnostics: collector.items,
    }
  },
}

export * from './constants.js'
export * from './schema.js'
export * from './manifest.js'
export * from './skills.js'
export * from './mcp.js'
