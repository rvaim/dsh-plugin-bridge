import { basename } from 'node:path'
import { CAPABILITY_CONFLICT_CODES } from './conflicts.js'
import { normalizeManagementId } from '../shared/id.js'
import { sha256File } from '../source/archive.js'
import { probeGitSource } from '../source/git.js'
import { hashDirectory } from '../source/snapshot.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import type { CompatPlugin, InstalledPluginRecord, PluginState } from '../types/plugin.js'
import type { PluginRuntimeSnapshot } from '../types/runtime.js'
import type { CompatSource, InstalledSourceRecord, InstallSource, ResolvedInstallSource } from '../types/source.js'
import type { ParsedInstallCandidate } from './types.js'

export function stateOf(enabled: boolean, priority = 0): PluginState {
  if (!Number.isInteger(priority)) throw new Error('priority 必须是整数')
  return { enabled, priority }
}

export function compareInstalledPriority(left: InstalledPluginRecord, right: InstalledPluginRecord): number {
  return left.state.priority - right.state.priority
    || left.install.pluginId.localeCompare(right.install.pluginId)
}

export function runtimeDisabled(pluginId: string): PluginRuntimeSnapshot {
  return { pluginId, status: 'disabled', capabilities: [] }
}

export function resolvedFromStored(source: InstallSource): ResolvedInstallSource {
  if (source.type === 'directory') {
    return { source: { type: 'directory', path: source.path }, display: source.path, suggestedId: basename(source.path) }
  }
  if (source.type === 'archive') {
    return { source: { type: 'archive', path: source.path }, display: source.path, suggestedId: basename(source.path) }
  }
  return {
    source: { type: 'git', url: source.url, ...(source.ref === undefined ? {} : { ref: source.ref }) },
    display: source.url,
    suggestedId: source.url.replace(/\.git$/i, '').split('/').at(-1),
  }
}

/** 用安装阶段相同的 revision 规则探测来源当前版本，不下载完整 Source 内容。 */
export async function latestRevisionFor(resolved: ResolvedInstallSource): Promise<string> {
  if (resolved.source.type === 'directory') {
    return `directory:${await hashDirectory(resolved.source.path)}`
  }
  if (resolved.source.type === 'archive') {
    return `archive:${await sha256File(resolved.source.path)}`
  }
  const probed = await probeGitSource(resolved.source.url, resolved.source.ref)
  return `git:${probed.commit ?? ''}`
}

export function originMatches(left: InstallSource, right: InstallSource): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'directory' && right.type === 'directory') return left.path === right.path
  if (left.type === 'archive' && right.type === 'archive') {
    return left.path === right.path
      || (left.sha256 !== undefined && right.sha256 !== undefined && left.sha256 === right.sha256)
  }
  if (left.type === 'git' && right.type === 'git') return left.url === right.url && left.ref === right.ref
  return false
}

export function asCompatSource(record: InstalledSourceRecord): CompatSource {
  return {
    ...record.source,
    formats: record.scan.formats,
    plugins: record.scan.plugins,
    diagnostics: record.scan.diagnostics,
    marketplaceFiles: record.scan.marketplaceFiles,
    discovery: record.scan.discovery,
  }
}

function isConflictDiagnostic(item: CompatDiagnostic): boolean {
  return CAPABILITY_CONFLICT_CODES.has(item.code)
}

export function hasNonConflictErrors(plugin: CompatPlugin): boolean {
  return plugin.diagnostics.some(item => item.level === 'error' && !isConflictDiagnostic(item))
}

export function candidateWantsEnable(item: ParsedInstallCandidate, requestedEnable?: boolean): boolean {
  return requestedEnable ?? item.prepared.candidate.defaultEnabled ?? item.plugin.defaultEnabled ?? true
}

export function externalDirectoryName(sourcePluginId: string): string {
  return normalizeManagementId(sourcePluginId, 'plugin')
}
