import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CompatParserEngine, ParserSnapshot } from '../parser/contracts.js'
import { selectCandidateParser, withAdditionalDiagnostics } from '../parser/model.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../types/catalog.js'
import { PARSER_VERSION, SOURCE_PARSER_VERSION } from '../parser/version.js'
import { normalizeManagementId } from '../shared/id.js'
import { validateSourceDirectory } from '../shared/source-path.js'
import { isPathInside } from '../source/safety.js'
import { writeJsonAtomic } from '../store/json.js'
import type { CompatLayout } from '../store/layout.js'
import { readInstalledPlugin, readInstalledSource } from '../store/metadata.js'
import { diagnostic } from '../types/diagnostic.js'
import type { CompatPlugin, InstallMetadata, InstalledPluginRecord, ScanCache } from '../types/plugin.js'
import type { InstalledSourceRecord, SourceScanCache } from '../types/source.js'

/** Cache snapshots are values: later registry edits must not rewrite earlier scans. */
export function copyParserSnapshot(engine: CompatParserEngine): ParserSnapshot {
  return {
    fingerprint: engine.snapshot.fingerprint,
    parsers: engine.snapshot.parsers.map(parser => ({ ...parser })),
  }
}

export function createPluginScan(plugin: CompatPlugin, sourceRevision: string, engine: CompatParserEngine): ScanCache {
  return {
    parserVersion: PARSER_VERSION,
    parserSnapshot: copyParserSnapshot(engine),
    sourceRevision,
    scannedAt: new Date().toISOString(),
    plugin,
  }
}

export function createSourceScan(scan: SourceScanCache, sourceRevision: string, engine: CompatParserEngine): SourceScanCache {
  return {
    ...scan,
    parserVersion: SOURCE_PARSER_VERSION,
    parserSnapshot: copyParserSnapshot(engine),
    sourceRevision,
  }
}

export function isPluginScanCurrent(scan: ScanCache, sourceRevision: string, engine: CompatParserEngine, parserId: string): boolean {
  return scan.parserVersion === PARSER_VERSION
    && scan.plugin.formats.length === 1 && scan.plugin.formats[0] === parserId
    && scan.sourceRevision === sourceRevision
    && scan.parserSnapshot?.fingerprint === engine.snapshot.fingerprint
}

export function isSourceScanCurrent(scan: SourceScanCache, sourceRevision: string, engine: CompatParserEngine): boolean {
  return scan.parserVersion === SOURCE_PARSER_VERSION
    && scan.sourceRevision === sourceRevision
    && scan.parserSnapshot?.fingerprint === engine.snapshot.fingerprint
}

export async function resolveInstalledPluginPackageRoot(layout: CompatLayout, install: InstallMetadata): Promise<string> {
  if (install.location.type === 'source-path') {
    const path = await validateSourceDirectory(layout.sourcePackageDir(install.sourceId), install.location.path)
    return resolve(layout.sourcePackageDir(install.sourceId), path === '.' ? '' : path)
  }
  if (install.location.type === 'git' || install.location.type === 'git-subdir') {
    const repositoryRoot = layout.sourceExternalPackageDir(
      install.sourceId,
      normalizeManagementId(install.sourcePluginId, 'plugin'),
    )
    const path = await validateSourceDirectory(repositoryRoot, install.location.type === 'git' ? '.' : install.location.path)
    const [rootReal, targetReal] = await Promise.all([realpath(repositoryRoot), realpath(resolve(repositoryRoot, path))])
    if (!isPathInside(rootReal, targetReal)) throw new Error(`外部插件路径逃逸缓存目录：${install.pluginId}`)
    return targetReal
  }
  throw new Error(`插件 ${install.pluginId} 的来源类型 ${install.location.type} 当前不能运行`)
}

export async function parseStoredSource(
  layout: CompatLayout,
  sourceId: string,
  record: InstalledSourceRecord,
  engine: CompatParserEngine,
): Promise<SourceDiscovery> {
  const discovery = await engine.parseSource(layout.sourcePackageDir(sourceId), {
    suggestedPluginId: record.scan.suggestedPluginId,
    ...(record.scan.manualPaths === undefined ? {} : { paths: record.scan.manualPaths }),
  })
  return { ...discovery, scan: createSourceScan(discovery.scan, record.source.revision, engine) }
}

export async function readCurrentSourceRecord(
  layout: CompatLayout,
  sourceId: string,
  engine: CompatParserEngine,
): Promise<InstalledSourceRecord> {
  const record = await readInstalledSource(layout, sourceId)
  if (isSourceScanCurrent(record.scan, record.source.revision, engine)) return record
  const discovery = await parseStoredSource(layout, sourceId, record, engine)
  await writeJsonAtomic(layout.sourceScanFile(sourceId), discovery.scan)
  return { source: record.source, scan: discovery.scan }
}

export interface FreshInstalledPlugin {
  plugin: CompatPlugin
  scan: ScanCache
  packageRoot: string
  candidate?: SourcePluginCandidate
}

/** Re-read current catalog policy before parsing installed content, including missing candidates. */
export async function parseInstalledPluginFresh(
  layout: CompatLayout,
  record: InstalledPluginRecord,
  engine: CompatParserEngine,
  sourceRecord?: InstalledSourceRecord,
): Promise<FreshInstalledPlugin> {
  const source = sourceRecord ?? await readCurrentSourceRecord(layout, record.install.sourceId, engine)
  const discovery = await parseStoredSource(layout, record.install.sourceId, source, engine)
  const candidate = discovery.candidates.find(item => item.id === record.install.sourcePluginId)
  const selected = candidate === undefined ? undefined : selectCandidateParser(candidate, record.install.parserId)
  const packageRoot = await resolveInstalledPluginPackageRoot(layout, record.install)
  let plugin = await engine.parsePlugin(packageRoot, {
    parserId: record.install.parserId,
    sourceId: record.install.sourceId,
    sourcePluginId: record.install.sourcePluginId,
    suggestedId: record.install.pluginId,
    asId: record.install.pluginId,
    ...(selected?.displayName === undefined ? {} : { displayName: selected.displayName }),
    ...(selected === undefined ? {} : { marketplaceDefinitions: selected.definitions }),
  })
  if (selected !== undefined) {
    plugin = withAdditionalDiagnostics(plugin, selected.diagnostics)
    if (!selected.installable && !selected.diagnostics.some(item => item.level === 'error')) {
      plugin = withAdditionalDiagnostics(plugin, [diagnostic('error', 'SOURCE_PLUGIN_UNAVAILABLE', 'source',
        `Source ${record.install.sourceId} 中的插件 ${record.install.sourcePluginId} 当前不可安装或运行`)])
    }
  } else {
    const unavailable = discovery.scan.diagnostics.filter(item => item.code === 'PARSER_UNAVAILABLE')
    const missing = diagnostic('error', unavailable.length > 0 ? 'PARSER_UNAVAILABLE' : 'SOURCE_PLUGIN_MISSING', 'plugin',
      `Source ${record.install.sourceId} 当前无法识别已安装插件 ${record.install.sourcePluginId}；安装记录和启用意愿已保留，运行已阻止`)
    // Cached metadata is useful for inspection, but cached capabilities and catalog policy
    // must never provide an implicit fallback when their owning parser disappears.
    plugin = withAdditionalDiagnostics({
      ...plugin,
      name: record.scan.plugin.name,
      ...(plugin.version === undefined && record.scan.plugin.version !== undefined ? { version: record.scan.plugin.version } : {}),
      formats: [record.install.parserId],
      skills: [], mcpServers: [], hooks: [], commands: [], agents: [],
    }, [...unavailable, missing])
  }
  return { plugin, packageRoot, candidate, scan: createPluginScan(plugin, source.source.revision, engine) }
}

/** No default registry or format implementation is reachable through this loader. */
export async function loadInstalledPluginForRuntime(
  layout: CompatLayout,
  pluginId: string,
  engine: CompatParserEngine,
): Promise<InstalledPluginRecord> {
  const record = await readInstalledPlugin(layout, pluginId)
  const source = await readCurrentSourceRecord(layout, record.install.sourceId, engine)
  if (isPluginScanCurrent(record.scan, source.source.revision, engine, record.install.parserId)) return record
  const fresh = await parseInstalledPluginFresh(layout, record, engine, source)
  await writeJsonAtomic(layout.scanFile(pluginId), fresh.scan)
  return { ...record, scan: fresh.scan }
}
