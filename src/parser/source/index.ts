import { lstat, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic, hasErrorDiagnostics, sortDiagnostics } from '../../types/diagnostic.js'
import type { CompatFormat } from '../../types/plugin.js'
import type { CompatSourcePlugin, SourceScanCache } from '../../types/source.js'
import { detectPluginFormat } from '../detect.js'
import { DiagnosticCollector } from '../shared/diagnostics.js'
import { pathExists, readJson } from '../shared/fs.js'
import { normalizeManagementId } from '../shared/id.js'
import { SOURCE_PARSER_VERSION } from '../version.js'
import { CLAUDE_MARKETPLACE_FILE, parseClaudeMarketplace } from './claude-code.js'
import { CODEX_MARKETPLACE_FILE, parseCodexMarketplace } from './codex.js'
import { locationKey, normalizeRelativeSourcePath, validateSourceDirectory } from './common.js'
import type { SourceDiscovery, SourcePluginCandidate } from './types.js'

export * from './types.js'
export * from './claude-code.js'
export * from './codex.js'
export { validateSourceDirectory } from './common.js'

export interface ParseSourceOptions {
  /** --path 兜底目录；只在没有 Marketplace 时生效。 */
  paths?: string[]
  /** 仅归档来源允许剥离一层普通包装目录。 */
  allowSingleWrapper?: boolean
  /** 单插件 Source 无清单名称时采用的稳定候选 ID。 */
  suggestedPluginId?: string
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function publicCandidate(candidate: SourcePluginCandidate): CompatSourcePlugin {
  const { definitions: _definitions, locationKey: _locationKey, ...publicValue } = candidate
  return publicValue
}

function mergeCandidates(
  candidates: SourcePluginCandidate[],
  diagnostics: CompatDiagnostic[],
): SourcePluginCandidate[] {
  const map = new Map<string, SourcePluginCandidate>()
  for (const candidate of candidates) {
    const previous = map.get(candidate.id)
    if (previous === undefined) {
      map.set(candidate.id, { ...candidate })
      continue
    }
    const sameMarketplace = previous.definitions.some(left =>
      candidate.definitions.some(right => left.format === right.format && left.file === right.file))
    if (sameMarketplace) {
      const duplicate = diagnostic(
        'error',
        'SOURCE_PLUGIN_ID_DUPLICATE',
        'source',
        `同一 Marketplace 中插件 ID ${candidate.id} 重复；不会静默覆盖或合并`,
        candidate.definitions[0]?.file,
      )
      previous.installable = false
      previous.diagnostics = sortDiagnostics([...previous.diagnostics, duplicate])
      diagnostics.push(duplicate)
      continue
    }
    if (previous.locationKey !== candidate.locationKey) {
      const conflict = diagnostic(
        'error',
        'SOURCE_PLUGIN_ID_CONFLICT',
        'source',
        `同一 Source 中插件 ID ${candidate.id} 指向不同位置；不会猜测、改名或自动合并`,
        undefined,
        { first: previous.location, second: candidate.location },
      )
      previous.installable = false
      previous.diagnostics = sortDiagnostics([...previous.diagnostics, conflict])
      diagnostics.push(conflict)
      continue
    }

    const semanticConflicts: string[] = []
    if (previous.name !== candidate.name) semanticConflicts.push(`name: ${previous.name} / ${candidate.name}`)
    if (previous.version !== undefined && candidate.version !== undefined && previous.version !== candidate.version) {
      semanticConflicts.push(`version: ${previous.version} / ${candidate.version}`)
    }
    if (
      previous.defaultEnabled !== undefined
      && candidate.defaultEnabled !== undefined
      && previous.defaultEnabled !== candidate.defaultEnabled
    ) {
      semanticConflicts.push(`defaultEnabled: ${String(previous.defaultEnabled)} / ${String(candidate.defaultEnabled)}`)
    }
    if (semanticConflicts.length > 0) {
      const conflict = diagnostic(
        'error',
        'SOURCE_PLUGIN_METADATA_CONFLICT',
        'source',
        `同一真实 Plugin 的 Marketplace 语义不一致，不能静默选择一方：${semanticConflicts.join('；')}`,
        undefined,
      )
      previous.installable = false
      previous.diagnostics = sortDiagnostics([...previous.diagnostics, ...candidate.diagnostics, conflict])
      diagnostics.push(conflict)
      continue
    }
    for (const [field, left, right] of [
      ['displayName', previous.displayName, candidate.displayName],
      ['description', previous.description, candidate.description],
    ] as const) {
      if (left !== undefined && right !== undefined && left !== right) {
        const warning = diagnostic(
          'warning',
          'SOURCE_PLUGIN_PRESENTATION_CONFLICT',
          'source',
          `同一真实 Plugin 的 ${field} 在不同 Marketplace 中不一致；保留首个值并公开此差异`,
        )
        previous.diagnostics = sortDiagnostics([...previous.diagnostics, warning])
        diagnostics.push(warning)
      }
    }
    previous.formats = [...new Set([...previous.formats, ...candidate.formats])].sort() as CompatFormat[]
    previous.definitions = [...previous.definitions, ...candidate.definitions]
    previous.diagnostics = sortDiagnostics([...previous.diagnostics, ...candidate.diagnostics])
    previous.installable = previous.installable && candidate.installable
    previous.displayName ??= candidate.displayName
    previous.description ??= candidate.description
    previous.version ??= candidate.version
    previous.defaultEnabled ??= candidate.defaultEnabled
  }
  return [...map.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function inferSingleName(pluginRoot: string): Promise<string | undefined> {
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    const path = resolve(pluginRoot, file)
    if (!await pathExists(path)) continue
    try {
      const value = await readJson(path)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const name = (value as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim() !== '') return name.trim()
      }
    } catch {
      // 具体清单错误由 Plugin parser 产生；Source 层只尝试获取展示标识。
    }
  }
  const fallback = basename(pluginRoot)
  return fallback === '' || fallback === '.' ? undefined : fallback
}

async function singlePluginCandidate(
  sourceRoot: string,
  rawPath: string,
  index: number,
  suggestedPluginId?: string,
): Promise<SourcePluginCandidate> {
  let path: string
  try {
    path = normalizeRelativeSourcePath(rawPath === '' ? '.' : rawPath)
    path = await validateSourceDirectory(sourceRoot, path)
  } catch (error) {
    const invalidPath = rawPath === '' ? '.' : rawPath
    return {
      id: `invalid-${index + 1}`,
      name: invalidPath,
      formats: [],
      location: { type: 'source-path', path: invalidPath },
      installable: false,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_INVALID', 'source', String(error))],
      definitions: [],
      locationKey: `invalid:${invalidPath}`,
    }
  }

  const absolute = resolve(sourceRoot, path)
  if (!await isDirectory(absolute)) {
    return {
      id: `invalid-${index + 1}`,
      name: path,
      formats: [],
      location: { type: 'source-path', path },
      installable: false,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_MISSING', 'source', `指定插件目录不存在：${path}`)],
      definitions: [],
      locationKey: `missing:${path}`,
    }
  }

  const collector = new DiagnosticCollector()
  const detection = await detectPluginFormat(absolute, collector)
  const inferredName = await inferSingleName(absolute)
  // 单插件来源优先采用插件自身清单中的名称。来源目录名只在清单没有名称时兜底，
  // 避免把仓库目录名误当成 Plugin 管理 ID。
  const rawName = inferredName ?? suggestedPluginId ?? `plugin-${index + 1}`
  let id: string
  try {
    id = normalizeManagementId(rawName, 'plugin')
  } catch (error) {
    collector.add('error', 'SOURCE_PLUGIN_ID_INVALID', 'source', String(error))
    id = `invalid-${index + 1}`
  }
  const location = { type: 'source-path' as const, path }
  return {
    id,
    name: inferredName ?? rawName,
    formats: detection.formats,
    location,
    installable: detection.formats.length > 0 && !hasErrorDiagnostics(collector.items),
    diagnostics: sortDiagnostics(collector.items),
    definitions: [],
    locationKey: locationKey(location),
  }
}

async function scanAtRoot(
  sourceRoot: string,
  options: Omit<ParseSourceOptions, 'allowSingleWrapper'>,
): Promise<SourceDiscovery> {
  const diagnostics: CompatDiagnostic[] = []
  const marketplaceFiles: string[] = []
  const marketplaceCandidates: SourcePluginCandidate[] = []
  let sourceName: string | undefined

  const claude = await parseClaudeMarketplace(sourceRoot)
  if (claude !== undefined) {
    marketplaceFiles.push(CLAUDE_MARKETPLACE_FILE)
    sourceName ??= claude.marketplaceName
    marketplaceCandidates.push(...claude.candidates)
    diagnostics.push(...claude.diagnostics)
  }

  const codex = await parseCodexMarketplace(sourceRoot)
  if (codex !== undefined) {
    marketplaceFiles.push(CODEX_MARKETPLACE_FILE)
    sourceName ??= codex.marketplaceName
    marketplaceCandidates.push(...codex.candidates)
    diagnostics.push(...codex.diagnostics)
  }

  const requestedPaths = options.paths
  let discovery: SourceScanCache['discovery']
  let candidates: SourcePluginCandidate[]
  let manualPaths: string[] | undefined

  if (marketplaceFiles.length > 0) {
    discovery = 'marketplace'
    candidates = mergeCandidates(marketplaceCandidates, diagnostics)
    if ((requestedPaths?.length ?? 0) > 0) {
      diagnostics.push(diagnostic(
        'warning',
        'SOURCE_MANUAL_PATHS_IGNORED',
        'source',
        'Source 已包含受支持的 Marketplace；--path 仅作为无 Marketplace 时的兜底，因此本次未使用',
      ))
    }
    if (candidates.length === 0) {
      diagnostics.push(diagnostic('error', 'MARKETPLACE_EMPTY', 'source', '已发现 Marketplace，但没有可识别的插件条目'))
    }
  } else if ((requestedPaths?.length ?? 0) > 0) {
    discovery = 'manual-paths'
    manualPaths = [...new Set(requestedPaths!.map(path => normalizeRelativeSourcePath(path)))].sort()
    candidates = []
    for (const [index, path] of manualPaths.entries()) {
      candidates.push(await singlePluginCandidate(sourceRoot, path, index))
    }
    candidates = mergeCandidates(candidates, diagnostics)
  } else {
    discovery = 'single-plugin'
    candidates = [await singlePluginCandidate(sourceRoot, '.', 0, options.suggestedPluginId)]
  }

  const formats = [...new Set(candidates.flatMap(candidate => candidate.formats))].sort() as CompatFormat[]
  const sourceDiagnostics = sortDiagnostics([
    ...diagnostics,
    ...candidates.flatMap(candidate => candidate.diagnostics),
  ])
  const scan: SourceScanCache = {
    schemaVersion: 1,
    parserVersion: SOURCE_PARSER_VERSION,
    scannedAt: new Date().toISOString(),
    formats,
    plugins: candidates.map(publicCandidate),
    diagnostics: sourceDiagnostics,
    marketplaceFiles: marketplaceFiles.sort(),
    discovery,
    ...(manualPaths === undefined ? {} : { manualPaths }),
  }
  return {
    root: sourceRoot,
    ...(sourceName === undefined ? {} : { name: sourceName }),
    scan,
    candidates,
  }
}

/**
 * 解析 Source 中的 Marketplace 或单插件根目录。
 *
 * 不递归猜测插件。归档来源只有在直接根目录无法识别、且顶层恰好只有一个
 * 普通目录时，才允许剥离一层包装目录。
 */
export async function parseCompatSource(
  sourceRoot: string,
  options: ParseSourceOptions = {},
): Promise<SourceDiscovery> {
  const direct = await scanAtRoot(sourceRoot, options)
  const directRecognized = direct.scan.marketplaceFiles.length > 0
    || direct.candidates.some(candidate => candidate.formats.length > 0)
    || options.paths !== undefined
  if (directRecognized || options.allowSingleWrapper !== true) return direct

  const entries = await readdir(sourceRoot, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return direct
  const wrappedRoot = resolve(sourceRoot, entries[0].name)
  const wrapped = await scanAtRoot(wrappedRoot, options)
  const wrappedRecognized = wrapped.scan.marketplaceFiles.length > 0
    || wrapped.candidates.some(candidate => candidate.formats.length > 0)
  return wrappedRecognized ? wrapped : direct
}
