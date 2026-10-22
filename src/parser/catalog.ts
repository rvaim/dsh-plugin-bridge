import { readdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import { diagnostic, hasErrorDiagnostics, sortDiagnostics, uniqueDiagnostics } from '../types/diagnostic.js'
import type { CompatSourcePlugin, SourceScanCache } from '../types/source.js'
import { locationKey, normalizeRelativeSourcePath, validateSourceDirectory } from '../shared/source-path.js'
import { normalizeManagementId } from '../shared/id.js'
import { inspectContainedPath } from '../shared/contained-path.js'
import type { ParseSourceOptions, ParserSignature } from './contracts.js'
import { ParserRegistry, pathPresent } from './registry.js'
import { DiagnosticCollector } from '../shared/diagnostics.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../types/catalog.js'
import { SOURCE_PARSER_VERSION } from './version.js'

function publicCandidate(candidate: SourcePluginCandidate): CompatSourcePlugin {
  const { definitions: _definitions, locationKey: _locationKey, ...value } = candidate
  return value
}
function missingParser(candidate: SourcePluginCandidate): boolean { return candidate.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error') }

function mergeCandidates(candidates: SourcePluginCandidate[], diagnostics: CompatDiagnostic[]): SourcePluginCandidate[] {
  const map = new Map<string, SourcePluginCandidate>()
  for (const candidate of candidates) {
    const previous = map.get(candidate.id)
    if (previous === undefined) { map.set(candidate.id, { ...candidate }); continue }
    // 未解析的同名 catalog 可能携带权限或阻断策略，只阻断该候选，不影响其他 id。
    if (missingParser(previous) || missingParser(candidate)) {
      const available = missingParser(previous) ? candidate : previous
      map.set(candidate.id, { ...available, formats: [...new Set([...previous.formats, ...candidate.formats])].sort(),
        definitions: [...previous.definitions, ...candidate.definitions], installable: false,
        diagnostics: sortDiagnostics([...previous.diagnostics, ...candidate.diagnostics]) })
      continue
    }
    const sameMarketplace = previous.definitions.some(left => candidate.definitions.some(right => left.format === right.format && left.file === right.file))
    const conflict = (code: string, message: string, file?: string): void => {
      const item = diagnostic('error', code, 'source', message, file)
      previous.installable = false
      previous.diagnostics = sortDiagnostics([...previous.diagnostics, ...candidate.diagnostics, item])
      diagnostics.push(item)
    }
    if (sameMarketplace) { conflict('SOURCE_PLUGIN_ID_DUPLICATE', `同一 Marketplace 中插件 ID ${candidate.id} 重复；不会静默覆盖或合并`, candidate.definitions[0]?.file); continue }
    if (previous.definitions.some(left => candidate.definitions.some(right => left.format === right.format))) {
      conflict('SOURCE_PLUGIN_MARKETPLACE_CONFLICT', `不同 Marketplace 的同格式插件 ID ${candidate.id} 重复；不能静默选择其中一份配置`, candidate.definitions[0]?.file)
      continue
    }
    if (previous.locationKey !== candidate.locationKey) { conflict('SOURCE_PLUGIN_ID_CONFLICT', `同一 Source 中插件 ID ${candidate.id} 指向不同位置；不会猜测、改名或自动合并`); continue }
    const inconsistent: string[] = []
    if (previous.name !== candidate.name) inconsistent.push(`name: ${previous.name} / ${candidate.name}`)
    if (previous.version !== undefined && candidate.version !== undefined && previous.version !== candidate.version) inconsistent.push(`version: ${previous.version} / ${candidate.version}`)
    if (previous.defaultEnabled !== undefined && candidate.defaultEnabled !== undefined && previous.defaultEnabled !== candidate.defaultEnabled) inconsistent.push(`defaultEnabled: ${previous.defaultEnabled} / ${candidate.defaultEnabled}`)
    if (inconsistent.length > 0) { conflict('SOURCE_PLUGIN_METADATA_CONFLICT', `同一真实 Plugin 的 Marketplace 语义不一致，不能静默选择一方：${inconsistent.join('；')}`); continue }
    for (const field of ['displayName', 'description'] as const) {
      if (previous[field] !== undefined && candidate[field] !== undefined && previous[field] !== candidate[field]) {
        const item = diagnostic('warning', 'SOURCE_PLUGIN_PRESENTATION_CONFLICT', 'source', `同一真实 Plugin 的 ${field} 在不同 Marketplace 中不一致；保留首个值并公开此差异`)
        previous.diagnostics.push(item); diagnostics.push(item)
      }
    }
    previous.formats = [...new Set([...previous.formats, ...candidate.formats])].sort()
    previous.definitions = [...previous.definitions, ...candidate.definitions]
    previous.diagnostics = sortDiagnostics([...previous.diagnostics, ...candidate.diagnostics])
    previous.installable = previous.installable && candidate.installable
    previous.displayName ??= candidate.displayName
    previous.description ??= candidate.description
    previous.version ??= candidate.version
    previous.defaultEnabled ??= candidate.defaultEnabled
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function safeName(root: string, file: string): Promise<string | undefined> {
  const location = await inspectContainedPath(root, file, 'file')
  if (location.status !== 'ok') return undefined
  try {
    const value = JSON.parse(await readFile(location.path, 'utf8')) as { name?: unknown }
    return typeof value?.name === 'string' && value.name.trim() !== '' ? value.name.trim() : undefined
  } catch { return undefined }
}
async function singleCandidate(registry: ParserRegistry, sourceRoot: string, rawPath: string, index: number, suggested?: string): Promise<SourcePluginCandidate> {
  let path: string
  try {
    path = normalizeRelativeSourcePath(rawPath || '.')
    const controls = registry.signatures.flatMap(signature => signature.marketplacePaths.map(file => dirname(file).replaceAll('\\', '/')))
    if (controls.some(control => path === control || path.startsWith(`${control}/`))) throw new Error('插件位置不能指向 Marketplace 控制目录')
    path = await validateSourceDirectory(sourceRoot, path)
  } catch (error) {
    return { id: `invalid-${index + 1}`, name: rawPath, formats: [], location: { type: 'source-path', path: rawPath || '.' }, installable: false,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_INVALID', 'source', String(error))], definitions: [], locationKey: `invalid:${rawPath}` }
  }
  const root = resolve(sourceRoot, path)
  const collector = new DiagnosticCollector()
  const detected = await registry.detect(root, collector)
  let name: string | undefined
  for (const item of detected) {
    const parser = item.parser
    if (parser === undefined) continue
    try {
      if (parser.preflight !== undefined) {
        const preflight = await parser.preflight(root)
        collector.items.push(...preflight.diagnostics)
        name ??= preflight.name
      } else if (parser.inferName !== undefined) name ??= await parser.inferName(root)
    } catch {
      collector.add('error', 'PARSER_PREFLIGHT_FAILED', 'plugin', `解析器 ${parser.id} 的清单预检失败`, undefined, { parserId: parser.id })
    }
  }
  if (name === undefined && !detected.some(item => item.signature.exclusive) && detected.some(item => item.parser !== undefined)) name = await safeName(root, 'package.json')
  // 根候选使用来源种子；物理暂存/存储目录不能参与插件身份。
  name ??= path === '.' ? suggested ?? 'plugin' : basename(path)
  let id: string
  try { id = normalizeManagementId(name) } catch { collector.add('error', 'SOURCE_PLUGIN_ID_INVALID', 'source', '插件名称不能生成安全的管理标识'); id = `invalid-${index + 1}` }
  const location = { type: 'source-path' as const, path }
  return { id, name, formats: detected.map(item => item.signature.id), location,
    installable: detected.length > 0 && !hasErrorDiagnostics(collector.items), diagnostics: sortDiagnostics(collector.items), definitions: [], locationKey: locationKey(location) }
}

/** 缺失实现时只读取装配声明的名称索引，不解释任何组件、来源或权限配置。 */
async function unavailableCatalog(root: string, signature: ParserSignature, file: string): Promise<{ candidates: SourcePluginCandidate[]; diagnostics: CompatDiagnostic[]; unknownScope: boolean }> {
  const item = diagnostic('warning', 'PARSER_UNAVAILABLE', 'source', `目录格式 ${signature.id} 的解析器未注册；其条目暂不可安装`, file, { parserId: signature.id })
  const location = await inspectContainedPath(root, file, 'file')
  if (location.status !== 'ok' || signature.catalogIndex === undefined) return { candidates: [], diagnostics: [item], unknownScope: true }
  try {
    const raw = JSON.parse(await readFile(location.path, 'utf8')) as Record<string, unknown>
    const entries = raw[signature.catalogIndex.entriesField]
    if (!Array.isArray(entries)) throw new Error('索引不可用')
    const candidates: SourcePluginCandidate[] = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') throw new Error('条目无名称')
      const name = (entry as Record<string, unknown>)[signature.catalogIndex.nameField]
      if (typeof name !== 'string' || name.trim() === '') throw new Error('条目无名称')
      const id = normalizeManagementId(name)
      candidates.push({ id, name, formats: [signature.id], location: { type: 'unsupported', sourceType: 'parser-unavailable' }, installable: false, definitions: [],
        diagnostics: [diagnostic('error', 'PARSER_UNAVAILABLE', 'source', `插件 ${id} 的目录声明需要未注册的解析器 ${signature.id}`, file, { parserId: signature.id })], locationKey: `unavailable:${signature.id}:${id}` })
    }
    return { candidates, diagnostics: [item], unknownScope: false }
  } catch { return { candidates: [], diagnostics: [item], unknownScope: true } }
}

interface LocatedMarketplace { signature: ParserSignature; file: string }

/** 只寻找解析器声明的市场清单，不把未列出的插件目录猜成市场条目。 */
async function locateMarketplaces(registry: ParserRegistry, root: string, explicitPlugin: boolean): Promise<LocatedMarketplace[]> {
  const at = async (base: string, depth: number): Promise<LocatedMarketplace[]> => {
    const result: LocatedMarketplace[] = []
    for (const signature of registry.signatures) {
      if (depth > (signature.marketplaceSearchDepth ?? 0)) continue
      for (const marker of signature.marketplacePaths) {
        const file = base === '.' ? marker : `${base}/${marker}`
        if (await pathPresent(root, file)) result.push({ signature, file })
      }
    }
    return result
  }
  const direct = await at('.', 0)
  // 根市场及显式插件拥有自己的边界，不能被下层示例或依赖接管。
  if (direct.length > 0 || explicitPlugin) return direct
  const maxDepth = Math.max(0, ...registry.signatures.map(signature => signature.marketplaceSearchDepth ?? 0))
  const ignored = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv',
    ...registry.signatures.flatMap(signature => signature.marketplacePaths.map(path => path.split('/')[0]))])
  const found: LocatedMarketplace[] = []
  const queue = [{ path: '.', depth: 0 }]
  for (let index = 0; index < queue.length; index += 1) {
    if (index >= 4096) throw new Error('市场发现超过 4096 个目录，请直接指定市场所在的子目录')
    const current = queue[index]
    if (current.depth > 0) {
      const markets = await at(current.path, current.depth)
      found.push(...markets)
      if (markets.length > 0 || (await registry.explicit(resolve(root, current.path))).length > 0) continue
    }
    if (current.depth >= maxDepth) continue
    const entries = await readdir(resolve(root, current.path), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // 不沿目录符号链接发现市场，防止循环或越过 Source 真实边界。
      if (!entry.isDirectory() || ignored.has(entry.name)) continue
      queue.push({ path: current.path === '.' ? entry.name : `${current.path}/${entry.name}`, depth: current.depth + 1 })
    }
  }
  return found
}

async function scanRoot(registry: ParserRegistry, root: string, options: ParseSourceOptions): Promise<SourceDiscovery> {
  const diagnostics: CompatDiagnostic[] = []
  const marketplaceFiles: string[] = []
  const fromCatalog: SourcePluginCandidate[] = []
  const explicit = await registry.explicit(root)
  const exclusive = explicit.some(signature => signature.exclusive)
  let name: string | undefined
  let unknownScope = false
  if (!exclusive) {
    const located = await locateMarketplaces(registry, root, explicit.length > 0 || options.paths !== undefined)
    for (const { signature, file } of located) {
      marketplaceFiles.push(file)
      const location = await inspectContainedPath(root, file, 'file')
      if (location.status !== 'ok') {
        diagnostics.push(diagnostic('error', 'SOURCE_MARKETPLACE_PATH_INVALID', 'source', '市场清单不可读取、类型不正确或逃逸来源目录', file))
        unknownScope = true
        continue
      }
      const parser = registry.getParser(signature.id)
      if (parser === undefined) {
        const skipped = await unavailableCatalog(root, signature, file)
        diagnostics.push(...skipped.diagnostics); fromCatalog.push(...skipped.candidates); unknownScope ||= skipped.unknownScope
        continue
      }
      try {
        const parsed = await parser.discoverSource(root, file)
        if (parsed === undefined) { unknownScope = true; continue }
        name ??= parsed.marketplaceName
        fromCatalog.push(...parsed.candidates)
        diagnostics.push(...parsed.diagnostics)
      } catch {
        diagnostics.push(diagnostic('error', 'PARSER_SOURCE_FAILED', 'source', `解析器 ${parser.id} 的目录发现失败`, file))
        unknownScope = true
      }
    }
  }
  const paths = exclusive ? undefined : options.paths
  let discovery: SourceScanCache['discovery']
  let candidates: SourcePluginCandidate[]
  let manualPaths: string[] | undefined
  if (marketplaceFiles.length > 0) {
    discovery = 'marketplace'
    candidates = mergeCandidates(fromCatalog, diagnostics)
    if (paths?.length) diagnostics.push(diagnostic('warning', 'SOURCE_MANUAL_PATHS_IGNORED', 'source', 'Source 已包含 Marketplace；paths 仅作为无 Marketplace 时的兜底，因此本次未使用'))
    if (candidates.length === 0) diagnostics.push(diagnostic('error', 'MARKETPLACE_EMPTY', 'source', '已发现 Marketplace，但没有可识别的插件条目'))
    if (unknownScope) {
      const error = diagnostic('error', 'PARSER_UNAVAILABLE', 'source', '部分目录缺少可用解析器或名称索引，无法确认策略声明影响范围')
      diagnostics.push(error)
      candidates = candidates.map(candidate => ({ ...candidate, installable: false, diagnostics: sortDiagnostics([...candidate.diagnostics, error]) }))
    }
  } else if (paths?.length) {
    discovery = 'manual-paths'
    manualPaths = [...new Set(paths.map(path => normalizeRelativeSourcePath(path)))].sort()
    candidates = []
    for (const [index, path] of manualPaths.entries()) candidates.push(await singleCandidate(registry, root, path, index, options.suggestedPluginId))
    candidates = mergeCandidates(candidates, diagnostics)
  } else {
    discovery = 'single-plugin'
    candidates = [await singleCandidate(registry, root, '.', 0, options.suggestedPluginId)]
  }
  const scan: SourceScanCache = { parserVersion: SOURCE_PARSER_VERSION, parserSnapshot: registry.snapshot,
    scannedAt: new Date().toISOString(), formats: [...new Set(candidates.flatMap(candidate => candidate.formats))].sort(),
    plugins: candidates.map(publicCandidate), diagnostics: sortDiagnostics(uniqueDiagnostics(diagnostics)),
    marketplaceFiles: [...new Set(marketplaceFiles)].sort(), discovery,
    ...(options.suggestedPluginId === undefined ? {} : { suggestedPluginId: options.suggestedPluginId }),
    ...(manualPaths === undefined ? {} : { manualPaths }) }
  return { root, ...(name === undefined ? {} : { name }), scan, candidates }
}

export async function discoverSource(registry: ParserRegistry, root: string, options: ParseSourceOptions = {}): Promise<SourceDiscovery> {
  const direct = await scanRoot(registry, root, options)
  if (direct.scan.marketplaceFiles.length || direct.candidates.some(candidate => candidate.formats.length) || options.paths !== undefined || !options.allowSingleWrapper) return direct
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return direct
  const wrapped = await scanRoot(registry, resolve(root, entries[0].name), options)
  return wrapped.scan.marketplaceFiles.length || wrapped.candidates.some(candidate => candidate.formats.length) ? wrapped : direct
}
