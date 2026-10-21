import type { CompatWebCategory, CompatWebPlugin, CompatWebUpdateInfo } from '../../types/web.js'
import type { PluginBridgeLocaleKey } from './locales.js'
import type { ResolveText } from './types.js'

export type PluginFilter = 'all' | 'enabled' | 'disabled' | 'attention' | 'updates'
export type Translate = (key: PluginBridgeLocaleKey, values?: Record<string, string | number>) => string
export type CategoryInventory = CompatWebCategory & { count: number }

export function displayName(plugin: Pick<CompatWebPlugin, 'id' | 'name'>): string {
  return plugin.name.trim() === '' ? plugin.id : plugin.name
}

/** Format IDs and category IDs share the parser's registered identity. */
export function formatLabel(format: string, categories: readonly CompatWebCategory[], resolveText: ResolveText): string {
  const category = categories.find(item => item.id === format)
  return category === undefined ? format : resolveText(category.label)
}

export function uniquePlugins(plugins: readonly CompatWebPlugin[]): CompatWebPlugin[] {
  return [...new Map(plugins.map(plugin => [plugin.id, plugin])).values()]
}

/** Count complete inventory; query and status never change navigation counts. */
export function categoryInventory(categories: readonly CompatWebCategory[], plugins: readonly CompatWebPlugin[]): CategoryInventory[] {
  const inventory = uniquePlugins(plugins)
  return [...categories]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(category => ({ ...category, count: inventory.filter(plugin => plugin.formats.includes(category.id)).length }))
}

export function inCategory(plugin: CompatWebPlugin, selectedId: string | null): boolean {
  return selectedId === null || plugin.formats.includes(selectedId)
}

export function needsAttention(plugin: CompatWebPlugin, update?: CompatWebUpdateInfo): boolean {
  return plugin.errors > 0 || plugin.warnings > 0 || plugin.runtimeStatus === 'failed'
    || plugin.runtimeStatus === 'degraded' || update?.error !== undefined
}

/** Filtering only projects the current list; it never changes the Host state. */
export function filterPlugins(
  plugins: readonly CompatWebPlugin[], query: string, filter: PluginFilter,
  updates: Readonly<Record<string, CompatWebUpdateInfo>>, selectedId: string | null = null,
): CompatWebPlugin[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return uniquePlugins(plugins).filter(plugin => {
    if (!inCategory(plugin, selectedId)) return false
    if (filter === 'enabled' && !plugin.enabled) return false
    if (filter === 'disabled' && plugin.enabled) return false
    if (filter === 'attention' && !needsAttention(plugin, updates[plugin.id])) return false
    if (filter === 'updates' && updates[plugin.id]?.available !== true) return false
    const text = [plugin.name, plugin.id, plugin.sourceId, ...plugin.formats].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}
