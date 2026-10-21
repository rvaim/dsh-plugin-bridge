import type { CompatWebPlugin, CompatWebUpdateInfo } from '../../types/web.js'
import type { PluginBridgeLocaleKey } from './locales.js'

export type PluginFilter = 'all' | 'enabled' | 'disabled' | 'attention' | 'updates'
export type Translate = (key: PluginBridgeLocaleKey, values?: Record<string, string | number>) => string

export function displayName(plugin: Pick<CompatWebPlugin, 'id' | 'name'>): string {
  return plugin.name.trim() === '' ? plugin.id : plugin.name
}

export function formatLabel(format: string, t: Translate): string {
  return format === 'agent-plugins' ? t('formatAgentPlugins')
    : format === 'codex' ? t('formatCodex') : format === 'claude-code' ? t('formatClaude') : format
}

export function needsAttention(plugin: CompatWebPlugin, update?: CompatWebUpdateInfo): boolean {
  return plugin.errors > 0 || plugin.warnings > 0 || plugin.runtimeStatus === 'failed'
    || plugin.runtimeStatus === 'degraded' || update?.error !== undefined
}

/** Filtering only projects the current list; it never changes the Host state. */
export function filterPlugins(
  plugins: readonly CompatWebPlugin[], query: string, filter: PluginFilter,
  updates: Readonly<Record<string, CompatWebUpdateInfo>>,
): CompatWebPlugin[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return plugins.filter(plugin => {
    if (filter === 'enabled' && !plugin.enabled) return false
    if (filter === 'disabled' && plugin.enabled) return false
    if (filter === 'attention' && !needsAttention(plugin, updates[plugin.id])) return false
    if (filter === 'updates' && updates[plugin.id]?.available !== true) return false
    const text = [plugin.name, plugin.id, plugin.sourceId, ...plugin.formats].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}
