import { resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic, sortDiagnostics } from '../../types/diagnostic.js'
import { pathExists, readJson } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'
import { createCandidate, parseMarketplaceLocation, stringField } from './source-common.js'
import type { SourceParserResult } from '../../types/catalog.js'

export const CLAUDE_MARKETPLACE_FILE = '.claude-plugin/marketplace.json'

export async function parseClaudeMarketplace(sourceRoot: string): Promise<SourceParserResult | undefined> {
  const file = resolve(sourceRoot, CLAUDE_MARKETPLACE_FILE)
  if (!await pathExists(file)) return undefined
  const diagnostics: CompatDiagnostic[] = []
  let root: Record<string, unknown>
  try {
    const value = await readJson(file)
    const object = asObject(value)
    if (object === undefined) throw new Error('顶层必须是对象')
    root = object
  } catch (error) {
    return {
      marketplaceFile: CLAUDE_MARKETPLACE_FILE,
      candidates: [],
      diagnostics: [diagnostic('error', 'CLAUDE_MARKETPLACE_INVALID', 'source', `Claude Marketplace 无法解析：${String(error)}`, CLAUDE_MARKETPLACE_FILE)],
    }
  }

  for (const key of Object.keys(root)) {
    if (!['$schema', 'name', 'owner', 'plugins', 'metadata'].includes(key)) diagnostics.push(diagnostic('warning', 'CLAUDE_MARKETPLACE_UNKNOWN_FIELD', 'source', `未识别的 Claude Marketplace 顶层字段已忽略：${key}`, CLAUDE_MARKETPLACE_FILE))
  }
  const marketplaceName = stringField(root, 'name')
  const fatalDiagnostics: CompatDiagnostic[] = []
  if (marketplaceName === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_NAME_MISSING', 'source', 'Claude Marketplace 缺少 name', CLAUDE_MARKETPLACE_FILE)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const owner = asObject(root.owner)
  if (owner === undefined || stringField(owner, 'name') === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_OWNER_INVALID', 'source', 'Claude Marketplace 缺少 owner.name', CLAUDE_MARKETPLACE_FILE)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const rawPlugins = root.plugins
  if (!Array.isArray(rawPlugins)) {
    diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGINS_INVALID', 'source', 'Claude Marketplace plugins 必须是数组', CLAUDE_MARKETPLACE_FILE))
    return { marketplaceFile: CLAUDE_MARKETPLACE_FILE, ...(marketplaceName === undefined ? {} : { marketplaceName }), candidates: [], diagnostics }
  }
  const metadata = asObject(root.metadata)
  if (root.metadata !== undefined && metadata === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_METADATA_INVALID', 'source', 'Claude Marketplace metadata 必须是对象', CLAUDE_MARKETPLACE_FILE)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const pluginRootValue = metadata?.pluginRoot
  const pluginRoot = typeof pluginRootValue === 'string' && pluginRootValue.trim() !== '' ? pluginRootValue.trim() : undefined
  if (pluginRootValue !== undefined && pluginRoot === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_ROOT_INVALID', 'source', 'metadata.pluginRoot 必须是非空路径字符串', CLAUDE_MARKETPLACE_FILE)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }

  const candidates: import('../../types/catalog.js').SourcePluginCandidate[] = []
  for (const [index, rawEntry] of rawPlugins.entries()) {
    const entry = asObject(rawEntry)
    if (entry === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_ENTRY_INVALID', 'source', `plugins 第 ${index + 1} 项必须是对象`, CLAUDE_MARKETPLACE_FILE))
      continue
    }
    if (stringField(entry, 'name') === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_NAME_MISSING', 'source', `plugins 第 ${index + 1} 项缺少 name`, CLAUDE_MARKETPLACE_FILE))
      continue
    }
    if (entry.source === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_SOURCE_MISSING', 'source', `插件 ${String(entry.name)} 缺少 source`, CLAUDE_MARKETPLACE_FILE))
      continue
    }
    const parsed = await parseMarketplaceLocation({
      sourceRoot,
      raw: entry.source,
      marketplaceFile: CLAUDE_MARKETPLACE_FILE,
      format: 'claude-code',
      ...(pluginRoot === undefined ? {} : { pluginRoot }),
    })
    const candidate = createCandidate({
      format: 'claude-code',
      marketplaceFile: CLAUDE_MARKETPLACE_FILE,
      pointer: `/plugins/${index}`,
      entry,
      location: parsed.location,
      locationKey: parsed.key,
      installable: parsed.installable && fatalDiagnostics.length === 0,
      diagnostics: [...parsed.diagnostics, ...fatalDiagnostics],
      fallbackId: `invalid-${index + 1}`,
    })
    candidates.push(candidate)
  }
  return {
    marketplaceFile: CLAUDE_MARKETPLACE_FILE,
    ...(marketplaceName === undefined ? {} : { marketplaceName }),
    candidates,
    diagnostics: sortDiagnostics(diagnostics),
  }
}
