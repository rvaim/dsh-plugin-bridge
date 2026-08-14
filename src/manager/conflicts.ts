import type { CompatLayout } from '../store/layout.js'
import { listPluginIds } from '../store/metadata.js'
import { loadInstalledPluginForRuntime } from '../runtime/loader.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import { diagnostic } from '../types/diagnostic.js'
import type { CompatPlugin } from '../types/plugin.js'

interface CapabilityNames {
  skills: Set<string>
  mcp: Set<string>
  commands: Set<string>
  agents: Set<string>
}

function names(plugin: CompatPlugin): CapabilityNames {
  return {
    skills: new Set(plugin.skills.map(item => item.name)),
    mcp: new Set(plugin.mcpServers.map(item => item.serverName)),
    commands: new Set(plugin.commands.map(item => item.name)),
    agents: new Set(plugin.agents.map(item => item.name)),
  }
}

function intersections(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter(value => right.has(value)).sort()
}

function pairDiagnostics(candidate: CompatPlugin, other: CompatPlugin, otherPluginId: string): CompatDiagnostic[] {
  const result: CompatDiagnostic[] = []
  const candidateNames = names(candidate)
  const existingNames = names(other)
  for (const value of intersections(candidateNames.mcp, existingNames.mcp)) {
    result.push(diagnostic('error', 'MCP_SERVER_NAME_CONFLICT', 'mcp', `MCP serverName ${value} 已由启用插件 ${otherPluginId} 使用；不会自动改名`, undefined, { otherPluginId, name: value }))
  }
  for (const value of intersections(candidateNames.skills, existingNames.skills)) {
    result.push(diagnostic('error', 'SKILL_NAME_CONFLICT', 'skill', `Skill ${value} 已由启用插件 ${otherPluginId} 提供；不会静默覆盖`, undefined, { otherPluginId, name: value }))
  }
  for (const value of intersections(candidateNames.commands, existingNames.commands)) {
    result.push(diagnostic('error', 'COMMAND_NAME_CONFLICT', 'command', `Command ${value} 已由启用插件 ${otherPluginId} 提供；不会自动改名`, undefined, { otherPluginId, name: value }))
  }
  for (const value of intersections(candidateNames.agents, existingNames.agents)) {
    result.push(diagnostic('error', 'AGENT_NAME_CONFLICT', 'agent', `Agent ${value} 已由启用插件 ${otherPluginId} 提供；不会自动改名`, undefined, { otherPluginId, name: value }))
  }
  return result
}

export function stripConflictDiagnostics(plugin: CompatPlugin): CompatPlugin {
  return {
    ...plugin,
    diagnostics: plugin.diagnostics.filter(item => !item.code.endsWith('_CONFLICT')),
  }
}

/** 能力名称保持原样；发现冲突时明确报错并阻止启用。 */
export async function findCapabilityConflicts(
  layout: CompatLayout,
  candidate: CompatPlugin,
  excludePluginIds: string | readonly string[] = [],
): Promise<CompatDiagnostic[]> {
  const excluded = new Set(typeof excludePluginIds === 'string' ? [excludePluginIds] : excludePluginIds)
  const result: CompatDiagnostic[] = []
  for (const pluginId of await listPluginIds(layout)) {
    if (excluded.has(pluginId)) continue
    let existing
    try {
      existing = await loadInstalledPluginForRuntime(layout, pluginId)
    } catch {
      continue
    }
    if (!existing.state.enabled) continue
    result.push(...pairDiagnostics(candidate, existing.scan.plugin, pluginId))
  }
  return result
}

/** 一次安装或更新多个插件时，额外检查候选插件之间的冲突。 */
export function findCapabilityConflictsWithin(
  candidates: readonly CompatPlugin[],
): Map<string, CompatDiagnostic[]> {
  const result = new Map<string, CompatDiagnostic[]>()
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left]
      const b = candidates[right]
      const aDiagnostics = pairDiagnostics(a, b, b.id)
      const bDiagnostics = pairDiagnostics(b, a, a.id)
      if (aDiagnostics.length > 0) result.set(a.id, [...(result.get(a.id) ?? []), ...aDiagnostics])
      if (bDiagnostics.length > 0) result.set(b.id, [...(result.get(b.id) ?? []), ...bDiagnostics])
    }
  }
  return result
}
