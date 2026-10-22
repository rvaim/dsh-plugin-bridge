import { posix, resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic, sortDiagnostics } from '../../types/diagnostic.js'
import { readJson } from '../../shared/fs.js'
import { inspectContainedPath } from '../../shared/contained-path.js'
import { asObject } from '../../shared/object.js'
import { createCandidate, parseMarketplaceLocation, stringField } from './source-common.js'
import type { SourceParserResult } from '../../types/catalog.js'

export const CLAUDE_MARKETPLACE_FILE = '.claude-plugin/marketplace.json'

export async function parseClaudeMarketplace(sourceRoot: string, marketplaceFile = CLAUDE_MARKETPLACE_FILE): Promise<SourceParserResult | undefined> {
  marketplaceFile = marketplaceFile.replaceAll('\\', '/')
  const marketPrefix = marketplaceFile === CLAUDE_MARKETPLACE_FILE
    ? ''
    : marketplaceFile.endsWith(`/${CLAUDE_MARKETPLACE_FILE}`)
      ? marketplaceFile.slice(0, -CLAUDE_MARKETPLACE_FILE.length - 1)
      : undefined
  const invalid = (message: string): SourceParserResult => ({
    marketplaceFile,
    candidates: [],
    diagnostics: [diagnostic('error', 'CLAUDE_MARKETPLACE_INVALID', 'source', message, marketplaceFile)],
  })
  if (marketPrefix === undefined || marketplaceFile.includes('\0') || /^[A-Za-z]:\//.test(marketplaceFile)
    || marketplaceFile.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return invalid('Claude Marketplace 必须位于 Source 内的 .claude-plugin/marketplace.json')
  }
  const inspected = await inspectContainedPath(sourceRoot, marketplaceFile, 'file')
  if (inspected.status === 'missing') return undefined
  if (inspected.status !== 'ok') return invalid('Claude Marketplace 清单路径无效或逃逸 Source')
  const marketRoot = resolve(sourceRoot, marketPrefix)
  const diagnostics: CompatDiagnostic[] = []
  let root: Record<string, unknown>
  try {
    const value = await readJson(inspected.path)
    const object = asObject(value)
    if (object === undefined) throw new Error('顶层必须是对象')
    root = object
  } catch (error) {
    return invalid(`Claude Marketplace 无法解析：${String(error)}`)
  }

  for (const key of Object.keys(root)) {
    if (!['$schema', 'name', 'owner', 'plugins', 'metadata'].includes(key)) diagnostics.push(diagnostic('warning', 'CLAUDE_MARKETPLACE_UNKNOWN_FIELD', 'source', `未识别的 Claude Marketplace 顶层字段已忽略：${key}`, marketplaceFile))
  }
  const marketplaceName = stringField(root, 'name')
  const fatalDiagnostics: CompatDiagnostic[] = []
  if (marketplaceName === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_NAME_MISSING', 'source', 'Claude Marketplace 缺少 name', marketplaceFile)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const owner = asObject(root.owner)
  if (owner === undefined || stringField(owner, 'name') === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_OWNER_INVALID', 'source', 'Claude Marketplace 缺少 owner.name', marketplaceFile)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const rawPlugins = root.plugins
  if (!Array.isArray(rawPlugins)) {
    diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGINS_INVALID', 'source', 'Claude Marketplace plugins 必须是数组', marketplaceFile))
    return { marketplaceFile, ...(marketplaceName === undefined ? {} : { marketplaceName }), candidates: [], diagnostics }
  }
  const metadata = asObject(root.metadata)
  if (root.metadata !== undefined && metadata === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_METADATA_INVALID', 'source', 'Claude Marketplace metadata 必须是对象', marketplaceFile)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  const pluginRootValue = metadata?.pluginRoot
  const pluginRoot = typeof pluginRootValue === 'string' && pluginRootValue.trim() !== '' ? pluginRootValue.trim() : undefined
  if (pluginRootValue !== undefined && pluginRoot === undefined) {
    const item = diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_ROOT_INVALID', 'source', 'metadata.pluginRoot 必须是非空路径字符串', marketplaceFile)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }

  const candidates: import('../../types/catalog.js').SourcePluginCandidate[] = []
  for (const [index, rawEntry] of rawPlugins.entries()) {
    const entry = asObject(rawEntry)
    if (entry === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_ENTRY_INVALID', 'source', `plugins 第 ${index + 1} 项必须是对象`, marketplaceFile))
      continue
    }
    if (stringField(entry, 'name') === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_NAME_MISSING', 'source', `plugins 第 ${index + 1} 项缺少 name`, marketplaceFile))
      continue
    }
    if (entry.source === undefined) {
      diagnostics.push(diagnostic('error', 'CLAUDE_MARKETPLACE_PLUGIN_SOURCE_MISSING', 'source', `插件 ${String(entry.name)} 缺少 source`, marketplaceFile))
      continue
    }
    const parsed = await parseMarketplaceLocation({
      sourceRoot: marketRoot,
      raw: entry.source,
      marketplaceFile,
      format: 'claude-code',
      ...(pluginRoot === undefined ? {} : { pluginRoot }),
    })
    // 本地路径先以市场根解析，再恢复为整个 Source 内的路径；外部仓库不变。
    const location = parsed.location.type === 'source-path'
      ? { ...parsed.location, path: posix.join(marketPrefix, parsed.location.path) }
      : parsed.location
    const candidate = createCandidate({
      format: 'claude-code',
      marketplaceFile,
      pointer: `/plugins/${index}`,
      entry,
      location,
      locationKey: parsed.key,
      installable: parsed.installable && fatalDiagnostics.length === 0,
      diagnostics: [...parsed.diagnostics, ...fatalDiagnostics],
      fallbackId: `invalid-${index + 1}`,
    })
    candidates.push(candidate)
  }
  return {
    marketplaceFile,
    ...(marketplaceName === undefined ? {} : { marketplaceName }),
    candidates,
    diagnostics: sortDiagnostics(diagnostics),
  }
}
