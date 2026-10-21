import { resolve } from 'node:path'
import type { PluginParser } from '../../parser/contracts.js'
import { DiagnosticCollector } from '../../shared/diagnostics.js'
import { pathExists } from '../../shared/fs.js'
import { parseCodexHarness } from './harness.js'
import { loadManifest } from './harness-common.js'
import { parseCodexMarketplace } from './source.js'
import { parseSkillsForHarness } from './skills.js'
import { parseMcpForHarness } from './mcp.js'
import { parseHooksForHarness } from './hooks.js'
import { parseCommandsForHarness } from './commands.js'
import { parseAgentsForHarness } from './agents.js'

export const codexParser: PluginParser = {
  id: 'codex',
  version: '1.1.0',
  category: { label: { default: 'Codex', en: 'Codex', zh: 'Codex' }, order: 10 },
  signature: { id: 'codex', manifestPaths: ['.codex-plugin/plugin.json'], marketplacePaths: ['.agents/plugins/marketplace.json'] },
  async detect(root) { return { matched: await pathExists(resolve(root, '.codex-plugin/plugin.json')) } },
  discoverSource: parseCodexMarketplace,
  async inferName(root) {
    const manifest = await loadManifest(root, '.codex-plugin/plugin.json', new DiagnosticCollector())
    return typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : undefined
  },
  async parsePlugin({ root, definition }) {
    const collector = new DiagnosticCollector()
    const descriptor = await parseCodexHarness(root, collector, definition)
    const skills = await parseSkillsForHarness(root, descriptor, collector)
    const mcp = new Map<string, Awaited<ReturnType<typeof parseMcpForHarness>>[number]>()
    for (const server of await parseMcpForHarness(root, descriptor, collector)) {
      if (mcp.has(server.serverName)) collector.add('info', 'MCP_SERVER_DECLARATION_REPLACED', 'mcp', `同一 codex 插件内后声明的 MCP Server 已替换先声明值：${server.serverName}`, server.sourceFile)
      mcp.set(server.serverName, server)
    }
    const hooks = await parseHooksForHarness(root, descriptor, collector)
    const commands = await parseCommandsForHarness(root, descriptor, collector)
    const agents = await parseAgentsForHarness(root, descriptor, collector)
    return {
      format: 'codex',
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
