import { resolve } from 'node:path'
import type { PluginParser } from '../../parser/contracts.js'
import { DiagnosticCollector } from '../../shared/diagnostics.js'
import { pathExists } from '../../shared/fs.js'
import { parseClaudeHarness } from './harness.js'
import { loadManifest } from './harness-common.js'
import { parseClaudeMarketplace } from './source.js'
import { parseSkillsForHarness } from './skills.js'
import { parseMcpForHarness } from './mcp.js'
import { parseHooksForHarness } from './hooks.js'
import { parseCommandsForHarness } from './commands.js'
import { parseAgentsForHarness } from './agents.js'

export const claudeCodeParser: PluginParser = {
  id: 'claude-code',
  version: '1.1.0',
  category: { label: { default: 'Claude Code', en: 'Claude Code', zh: 'Claude Code' }, order: 20 },
  signature: { id: 'claude-code', manifestPaths: ['.claude-plugin/plugin.json'], marketplacePaths: ['.claude-plugin/marketplace.json'] },
  async detect(root) {
    if (await pathExists(resolve(root, '.claude-plugin/plugin.json'))) return { matched: true }
    const conventional = await Promise.all(['skills', 'commands', 'agents', 'hooks/hooks.json', '.mcp.json', 'SKILL.md'].map(path => pathExists(resolve(root, path))))
    return conventional.some(Boolean) ? { matched: true, implicit: true } : { matched: false }
  },
  discoverSource: parseClaudeMarketplace,
  async inferName(root) {
    const manifest = await loadManifest(root, '.claude-plugin/plugin.json', new DiagnosticCollector())
    return typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : undefined
  },
  async parsePlugin({ root, implicit, definition }) {
    const collector = new DiagnosticCollector()
    const descriptor = await parseClaudeHarness(root, collector, implicit, definition)
    const skills = await parseSkillsForHarness(root, descriptor, collector)
    const mcp = new Map<string, Awaited<ReturnType<typeof parseMcpForHarness>>[number]>()
    for (const server of await parseMcpForHarness(root, descriptor, collector)) {
      if (mcp.has(server.serverName)) collector.add('info', 'MCP_SERVER_DECLARATION_REPLACED', 'mcp', `同一 claude-code 插件内后声明的 MCP Server 已替换先声明值：${server.serverName}`, server.sourceFile)
      mcp.set(server.serverName, server)
    }
    const hooks = await parseHooksForHarness(root, descriptor, collector)
    const commands = await parseCommandsForHarness(root, descriptor, collector)
    const agents = await parseAgentsForHarness(root, descriptor, collector)
    return {
      format: 'claude-code',
      ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
      ...(descriptor.displayName === undefined ? {} : { displayName: descriptor.displayName }),
      ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
      ...(descriptor.defaultEnabled === undefined ? {} : { defaultEnabled: descriptor.defaultEnabled }),
      manifestFiles: descriptor.manifestPath === undefined ? [] : [descriptor.manifestPath],
      skills, mcpServers: [...mcp.values()], hooks, commands, agents, diagnostics: collector.items,
    }
  },
}

export * from './harness.js'
export * from './source.js'
export * from './skills.js'
export * from './mcp.js'
export * from './hooks.js'
export * from './events.js'
export * from './commands.js'
export * from './agents.js'
