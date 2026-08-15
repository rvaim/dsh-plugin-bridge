import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { acquireSource, cleanAcquisition, materializeExternalPlugin } from './acquire.js'
import { findCapabilityConflicts, findCapabilityConflictsWithin, stripConflictDiagnostics } from './conflicts.js'
import { PARSER_VERSION, parseCompatPlugin, withAdditionalDiagnostics } from '../parser/normalize.js'
import { normalizeManagementId } from '../parser/shared/id.js'
import { parseCompatSource, validateSourceDirectory } from '../parser/source/index.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../parser/source/types.js'
import { SOURCE_PARSER_VERSION } from '../parser/version.js'
import { copyPluginDirectory } from '../source/directory.js'
import { pathExists } from '../source/filesystem.js'
import { resolveInstallSource } from '../source/resolver.js'
import { CompatLayout, isStorageId } from '../store/layout.js'
import { withPluginLock, withPluginLocks, withRepositoryLock, withSourceLock } from '../store/lock.js'
import {
  listPluginIds,
  listSourceIds,
  readInstalledPlugin,
  readInstalledSource,
  scanPluginSourceReferences,
  writeInstalledPlugin,
  writeInstalledSource,
} from '../store/metadata.js'
import { writeJsonAtomic } from '../store/json.js'
import { commitDirectory, createTransactionDir, removeDirectoryTransactionally } from '../store/transaction.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import type {
  CompatPlugin,
  InstallMetadata,
  InstalledPluginRecord,
  PluginMaterialization,
  PluginState,
  ScanCache,
} from '../types/plugin.js'
import type { PluginRuntimeSnapshot, PluginRuntimeStatus } from '../types/runtime.js'
import type {
  CompatPluginLocation,
  CompatSource,
  CompatSourcePlugin,
  InstalledSourceRecord,
  InstallSource,
  ResolvedInstallSource,
  SourceMetadata,
  SourceOwnership,
} from '../types/source.js'
import type { CompatRuntimeManager } from '../runtime/manager.js'
import { resolveInstalledPluginPackageRoot } from '../runtime/loader.js'

export interface InstallOptions {
  cwd?: string
  /** 单插件安装时覆盖 dsh-compat 管理 ID；不会改写插件内部名称。 */
  as?: string
  /** 新建隐式 Source 时覆盖 Source ID。 */
  sourceAs?: string
  /** 非交互选择一个或多个 Source Plugin。 */
  plugins?: string[]
  /** 无 Marketplace 时的显式插件子目录。 */
  paths?: string[]
  enable?: boolean
  priority?: number
}

export interface SourceAddOptions {
  cwd?: string
  as?: string
  paths?: string[]
}

/** Web 等分步前端完成选择前持有的一份已固定 Source 快照。 */
export interface InstallPreparation {
  sourceId: string
  sourceCreated: boolean
  plugins: CompatSourcePlugin[]
}

export interface SourceUpdateOptions {
  source?: string
  cwd?: string
}

export interface UpdateOptions extends SourceUpdateOptions {
  /** 共享 Source 更新需要调用方显式确认影响范围。 */
  confirmShared?: boolean
}

export interface PluginInstallResult {
  plugin: CompatPlugin
  enabled: boolean
  runtime: PluginRuntimeSnapshot
  install: InstallMetadata
}

export interface InstallResult {
  source: SourceInspection
  plugins: PluginInstallResult[]
}

export interface PluginListEntry {
  id: string
  name: string
  version?: string
  sourceId: string
  enabled: boolean
  priority: number
  runtimeStatus: PluginRuntimeStatus | 'pending-restart'
  formats: string[]
  skills: number
  mcpServers: number
  hooks: number
  errors: number
  warnings: number
  /** 列表前端可按需展开的 error/warning；info 不进入摘要。 */
  diagnostics: CompatDiagnostic[]
}

export interface PluginInspection extends InstalledPluginRecord {
  packageRoot: string
  runtime: PluginRuntimeSnapshot
}

export interface SourceListEntry {
  id: string
  name?: string
  ownership: SourceOwnership
  originType: InstallSource['type']
  formats: string[]
  availablePlugins: number
  installedPlugins: number
  errors: number
  warnings: number
}

export interface SourceInspection extends InstalledSourceRecord {
  compat: CompatSource
  installedPlugins: Array<{ pluginId: string; sourcePluginId: string }>
  /** install.json 无法读取，无法安全判断 Source 归属的安装目录。 */
  unreadablePluginIds: string[]
}

export interface SourceUpdateResult {
  source: SourceInspection
  plugins: PluginInspection[]
}

export class CompatibilityError extends Error {
  constructor(message: string, readonly diagnostics: CompatDiagnostic[]) {
    super(message)
    this.name = 'CompatibilityError'
  }
}

export class SharedSourceUpdateError extends Error {
  constructor(readonly sourceId: string, readonly pluginIds: readonly string[]) {
    super(`更新该插件实际会更新共享 Source ${sourceId}；同时受影响：${pluginIds.join(', ')}`)
    this.name = 'SharedSourceUpdateError'
  }
}

function scanOf(plugin: CompatPlugin, sourceRevision: string): ScanCache {
  return {
    parserVersion: PARSER_VERSION,
    sourceRevision,
    scannedAt: new Date().toISOString(),
    plugin,
  }
}

function stateOf(enabled: boolean, priority = 0): PluginState {
  if (!Number.isInteger(priority)) throw new Error('priority 必须是整数')
  return { enabled, priority }
}

function compareInstalledPriority(left: InstalledPluginRecord, right: InstalledPluginRecord): number {
  return left.state.priority - right.state.priority
    || left.install.pluginId.localeCompare(right.install.pluginId)
}

function runtimeDisabled(pluginId: string): PluginRuntimeSnapshot {
  return { pluginId, status: 'disabled', capabilities: [] }
}

function resolvedFromStored(source: InstallSource): ResolvedInstallSource {
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

function originMatches(left: InstallSource, right: InstallSource): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'directory' && right.type === 'directory') return left.path === right.path
  if (left.type === 'archive' && right.type === 'archive') {
    return left.path === right.path
      || (left.sha256 !== undefined && right.sha256 !== undefined && left.sha256 === right.sha256)
  }
  if (left.type === 'git' && right.type === 'git') return left.url === right.url && left.ref === right.ref
  return false
}

function asCompatSource(record: InstalledSourceRecord): CompatSource {
  return {
    ...record.source,
    formats: record.scan.formats,
    plugins: record.scan.plugins,
    diagnostics: record.scan.diagnostics,
    marketplaceFiles: record.scan.marketplaceFiles,
    discovery: record.scan.discovery,
  }
}

function candidateBySelector(
  candidates: readonly SourcePluginCandidate[],
  selector: string,
): SourcePluginCandidate | undefined {
  return candidates.find(item => item.id === selector || item.name === selector || item.displayName === selector)
}

function isConflictDiagnostic(item: CompatDiagnostic): boolean {
  return item.code.endsWith('_CONFLICT')
}

function hasNonConflictErrors(plugin: CompatPlugin): boolean {
  return plugin.diagnostics.some(item => item.level === 'error' && !isConflictDiagnostic(item))
}

function candidateWantsEnable(item: ParsedInstallCandidate, requestedEnable?: boolean): boolean {
  return requestedEnable ?? item.prepared.candidate.defaultEnabled ?? true
}

function externalDirectoryName(sourcePluginId: string): string {
  return normalizeManagementId(sourcePluginId, 'plugin')
}

interface PreparedPlugin {
  candidate: SourcePluginCandidate
  packageRoot: string
  location: CompatPluginLocation
  materialization?: PluginMaterialization
  newlyMaterializedExternal?: string
}

interface ParsedInstallCandidate {
  prepared: PreparedPlugin
  plugin: CompatPlugin
  install: InstallMetadata
  state: PluginState
  scan: ScanCache
}

interface FreshPlugin {
  plugin: CompatPlugin
  scan: ScanCache
  packageRoot: string
  candidate: SourcePluginCandidate
}

export class CompatManager {
  constructor(
    readonly layout: CompatLayout,
    readonly runtime?: CompatRuntimeManager,
  ) {}

  /** 所有管理操作共享同一个仓库锁，避免 Source/Plugin 事务交叉。 */
  private async withManagedRepository<T>(operation: () => Promise<T>): Promise<T> {
    return await withRepositoryLock(this.layout, operation)
  }

  private runtimeSnapshot(pluginId: string, enabled: boolean): PluginRuntimeSnapshot {
    if (this.runtime !== undefined) return this.runtime.get(pluginId)
    return enabled
      ? { pluginId, status: 'disabled', capabilities: [], error: '离线管理模式：将在 DSH 下次加载时启用' }
      : runtimeDisabled(pluginId)
  }

  private async findSourceByOrigin(origin: InstallSource): Promise<InstalledSourceRecord | undefined> {
    for (const sourceId of await listSourceIds(this.layout)) {
      try {
        const record = await readInstalledSource(this.layout, sourceId)
        if (originMatches(record.source.origin, origin)) return record
      } catch {
        // 损坏 Source 不参与自动复用，避免把新来源错误绑定到未知记录。
      }
    }
    return undefined
  }

  private async parseStoredSource(sourceId: string, record: InstalledSourceRecord): Promise<SourceDiscovery> {
    return await parseCompatSource(this.layout.sourcePackageDir(sourceId), {
      ...(record.scan.manualPaths === undefined ? {} : { paths: record.scan.manualPaths }),
    })
  }

  private async readCurrentSourceRecord(sourceId: string): Promise<InstalledSourceRecord> {
    const record = await readInstalledSource(this.layout, sourceId)
    if (record.scan.parserVersion === SOURCE_PARSER_VERSION) return record

    const discovery = await this.parseStoredSource(sourceId, record)
    await writeJsonAtomic(this.layout.sourceScanFile(sourceId), discovery.scan)
    return { source: record.source, scan: discovery.scan }
  }

  private async parseAndCheck(
    packageRoot: string,
    sourceId: string,
    sourcePluginId: string,
    suggestedId: string | undefined,
    asId: string | undefined,
    excludePluginIds: readonly string[] = [],
    candidate?: SourcePluginCandidate,
  ): Promise<CompatPlugin> {
    const parsed = stripConflictDiagnostics(await parseCompatPlugin(packageRoot, {
      sourceId,
      sourcePluginId,
      ...(suggestedId === undefined ? {} : { suggestedId }),
      ...(asId === undefined ? {} : { asId }),
      ...(candidate?.displayName === undefined ? {} : { displayName: candidate.displayName }),
      ...(candidate === undefined ? {} : { marketplaceDefinitions: candidate.definitions }),
    }))
    const conflicts = await findCapabilityConflicts(this.layout, parsed, excludePluginIds)
    return withAdditionalDiagnostics(parsed, conflicts)
  }

  private async parseInstalledFresh(
    record: InstalledPluginRecord,
    sourceRecord?: InstalledSourceRecord,
  ): Promise<FreshPlugin> {
    const source = sourceRecord ?? await this.readCurrentSourceRecord(record.install.sourceId)
    const discovery = await this.parseStoredSource(record.install.sourceId, source)
    const candidate = discovery.candidates.find(item => item.id === record.install.sourcePluginId)
    if (candidate === undefined) {
      throw new Error(`Source ${record.install.sourceId} 中已找不到已安装插件 ${record.install.sourcePluginId}`)
    }
    const packageRoot = await resolveInstalledPluginPackageRoot(this.layout, record.install)
    let plugin = await this.parseAndCheck(
      packageRoot,
      record.install.sourceId,
      record.install.sourcePluginId,
      record.install.pluginId,
      record.install.pluginId,
      [record.install.pluginId],
      candidate,
    )
    plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
    return {
      plugin,
      packageRoot,
      candidate,
      scan: scanOf(plugin, source.source.revision),
    }
  }

  /** scan.json 不是事实真源；parser 或 Source 版本变化时自动重建。 */
  private async readCurrentRecord(pluginId: string): Promise<InstalledPluginRecord> {
    const record = await readInstalledPlugin(this.layout, pluginId)
    const source = await this.readCurrentSourceRecord(record.install.sourceId)
    if (
      record.scan.parserVersion === PARSER_VERSION
      && record.scan.sourceRevision === source.source.revision
    ) return record

    const fresh = await this.parseInstalledFresh(record, source)
    await writeJsonAtomic(this.layout.scanFile(pluginId), fresh.scan)
    return { ...record, scan: fresh.scan }
  }

  private async inspectSourceUnlocked(sourceId: string): Promise<SourceInspection> {
    const record = await this.readCurrentSourceRecord(sourceId)
    const referenceScan = await scanPluginSourceReferences(this.layout)
    const installedPlugins = referenceScan.references
      .filter(item => item.sourceId === sourceId)
      .map(item => ({ pluginId: item.pluginId, sourcePluginId: item.sourcePluginId }))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    return {
      ...record,
      compat: asCompatSource(record),
      installedPlugins,
      unreadablePluginIds: referenceScan.unreadablePluginIds,
    }
  }

  /** Source 变更必须能完整读取所有引用它的 Plugin；损坏记录时拒绝猜测。 */
  private async readSourcePluginRecordsStrict(sourceId: string): Promise<InstalledPluginRecord[]> {
    const referenceScan = await scanPluginSourceReferences(this.layout)
    if (referenceScan.unreadablePluginIds.length > 0) {
      throw new Error(
        `存在无法读取 install.json 的插件目录，不能安全修改 Source ${sourceId}：${referenceScan.unreadablePluginIds.join(', ')}`,
      )
    }
    const references = referenceScan.references.filter(item => item.sourceId === sourceId)
    const records: InstalledPluginRecord[] = []
    for (const reference of references) {
      try {
        records.push(await readInstalledPlugin(this.layout, reference.pluginId))
      } catch (error) {
        throw new Error(`插件 ${reference.pluginId} 的状态或扫描缓存损坏，不能安全修改 Source ${sourceId}：${String(error)}`)
      }
    }
    return records.sort((left, right) => left.install.pluginId.localeCompare(right.install.pluginId))
  }

  /**
   * 同时撤下 Source 原始内容和其 Marketplace 外部 Git 缓存。
   *
   * 两个正式目录先统一 rename 到同一事务目录，之后再删除。这样即使删除
   * 过程中进程退出，运行层也不会观察到“Source 已删除但 external 仍在”
   * 或相反的半删除状态。
   */
  private async removeSourceStorage(sourceId: string, prefix: string): Promise<void> {
    const transaction = await createTransactionDir(this.layout, prefix)
    const sourceRoot = this.layout.sourceRoot(sourceId)
    const externalRoot = this.layout.sourceExternalRoot(sourceId)
    const stagedSource = join(transaction, 'source')
    const stagedExternal = join(transaction, 'external')
    let sourceMoved = false
    let externalMoved = false
    let preserveTransaction = false

    try {
      await rename(sourceRoot, stagedSource)
      sourceMoved = true
      if (await pathExists(externalRoot)) {
        await rename(externalRoot, stagedExternal)
        externalMoved = true
      }
    } catch (error) {
      let rollbackError: unknown
      try {
        if (externalMoved && !await pathExists(externalRoot)) await rename(stagedExternal, externalRoot)
        if (sourceMoved && !await pathExists(sourceRoot)) await rename(stagedSource, sourceRoot)
      } catch (restoreFailure) {
        // 尚未恢复的 Source 或 external 仍位于事务目录。此时必须保留恢复
        // 材料，不能为了清理临时目录而把最后一份完整内容删掉。
        preserveTransaction = sourceMoved || externalMoved
        rollbackError = restoreFailure
      }
      if (!preserveTransaction) await cleanAcquisition(transaction)
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [error, rollbackError],
          `移除 Source ${sourceId} 失败，且目录回滚未完全成功；恢复材料已保留在 ${transaction}`,
        )
      }
      throw error
    }

    try {
      await Promise.all([
        rm(stagedSource, { recursive: true, force: true }),
        externalMoved ? rm(stagedExternal, { recursive: true, force: true }) : Promise.resolve(),
      ])
    } finally {
      await cleanAcquisition(transaction)
    }
  }

  private chooseCandidates(
    sourceId: string,
    candidates: readonly SourcePluginCandidate[],
    selectors: readonly string[],
  ): SourcePluginCandidate[] {
    if (candidates.length === 0) throw new Error(`Source ${sourceId} 没有可定位的插件`)
    let requested = [...selectors]
    if (requested.length === 0 && candidates.length === 1) requested = [candidates[0].id]
    if (requested.length === 0) {
      throw new Error(
        `Source ${sourceId} 包含多个插件，必须通过 plugins 显式选择：${candidates.map(item => item.id).join(', ')}`,
      )
    }

    const selected: SourcePluginCandidate[] = []
    for (const selector of [...new Set(requested)]) {
      const candidate = candidateBySelector(candidates, selector)
      if (candidate === undefined) {
        throw new Error(`Source ${sourceId} 不包含插件 ${selector}；可选：${candidates.map(item => item.id).join(', ')}`)
      }
      if (!candidate.installable || hasErrorDiagnostics(candidate.diagnostics)) {
        throw new CompatibilityError(
          `插件 ${candidate.id} 的 Marketplace 位置存在错误或来源类型不受支持，不能安装`,
          candidate.diagnostics,
        )
      }
      selected.push(candidate)
    }
    return selected
  }

  private async preparePluginContent(
    sourceRoot: string,
    candidate: SourcePluginCandidate,
    transactionRoot: string,
    existingExternalRoot?: string,
  ): Promise<PreparedPlugin> {
    if (candidate.location.type === 'source-path') {
      const path = await validateSourceDirectory(join(sourceRoot, 'package'), candidate.location.path)
      return {
        candidate,
        packageRoot: resolve(sourceRoot, 'package', path),
        location: { type: 'source-path', path },
      }
    }

    if (candidate.location.type !== 'git' && candidate.location.type !== 'git-subdir') {
      throw new CompatibilityError(`插件 ${candidate.id} 的来源类型 ${candidate.location.type} 当前不支持`, candidate.diagnostics)
    }

    const key = externalDirectoryName(candidate.id)
    const official = existingExternalRoot === undefined ? undefined : join(existingExternalRoot, key)
    if (official !== undefined && await pathExists(join(official, 'package'))) {
      const packageRoot = candidate.location.type === 'git'
        ? join(official, 'package')
        : resolve(official, 'package', candidate.location.path)
      await validateSourceDirectory(join(official, 'package'), candidate.location.type === 'git' ? '.' : candidate.location.path)
      return {
        candidate,
        packageRoot,
        location: candidate.location,
        ...(candidate.location.sha === undefined ? {} : { materialization: { commit: candidate.location.sha } }),
      }
    }

    const staged = join(transactionRoot, 'materialized-external', key)
    const materialized = await materializeExternalPlugin(candidate.location, staged)
    const packageRoot = materialized.location.type === 'git'
      ? materialized.packageRoot
      : resolve(materialized.packageRoot, materialized.location.path)
    await validateSourceDirectory(
      materialized.packageRoot,
      materialized.location.type === 'git' ? '.' : materialized.location.path,
    )
    return {
      candidate,
      packageRoot,
      location: materialized.location,
      materialization: { commit: materialized.location.sha },
      newlyMaterializedExternal: staged,
    }
  }

  private async buildParsedCandidates(
    sourceId: string,
    sourceRoot: string,
    candidates: readonly SourcePluginCandidate[],
    sourceRevision: string,
    transactionRoot: string,
    options: InstallOptions,
    existingExternalRoot?: string,
  ): Promise<ParsedInstallCandidate[]> {
    if (options.as !== undefined && candidates.length !== 1) throw new Error('--as 只能用于一次安装一个插件')
    const parsed: ParsedInstallCandidate[] = []

    for (const candidate of candidates) {
      const prepared = await this.preparePluginContent(sourceRoot, candidate, transactionRoot, existingExternalRoot)
      let plugin = await this.parseAndCheck(
        prepared.packageRoot,
        sourceId,
        candidate.id,
        candidate.id,
        options.as,
        [],
        candidate,
      )
      plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
      const install: InstallMetadata = {
        pluginId: plugin.id,
        sourceId,
        sourcePluginId: candidate.id,
        location: prepared.location,
        ...(prepared.materialization === undefined ? {} : { materialization: prepared.materialization }),
        installedAt: new Date().toISOString(),
      }
      parsed.push({
        prepared,
        plugin,
        install,
        state: stateOf(false, options.priority ?? 0),
        scan: scanOf(plugin, sourceRevision),
      })
    }

    const duplicate = parsed.find((item, index) =>
      parsed.findIndex(other => other.plugin.id === item.plugin.id) !== index)
    if (duplicate !== undefined) throw new Error(`一次安装中产生重复 pluginId：${duplicate.plugin.id}`)

    // 只有本次确实准备启用的 Plugin 才形成活动能力冲突。--no-enable 或
    // Marketplace 默认禁用的 Plugin 仍可整体安装，之后 enable 时重新检查。
    const within = findCapabilityConflictsWithin(
      parsed
        .filter(item => candidateWantsEnable(item, options.enable) && !hasNonConflictErrors(item.plugin))
        .map(item => item.plugin),
    )
    for (const item of parsed) {
      const diagnostics = within.get(item.plugin.id) ?? []
      if (diagnostics.length > 0) {
        item.plugin = withAdditionalDiagnostics(item.plugin, diagnostics)
        item.scan = scanOf(item.plugin, sourceRevision)
      }
    }
    return parsed
  }

  private async startInstalledCandidates(
    items: ParsedInstallCandidate[],
    requestedEnable?: boolean,
  ): Promise<PluginInstallResult[]> {
    const results: PluginInstallResult[] = []
    for (const item of items) {
      let state = item.state
      let runtime = runtimeDisabled(item.plugin.id)
      const shouldEnable = requestedEnable ?? item.prepared.candidate.defaultEnabled ?? true
      if (shouldEnable && !hasErrorDiagnostics(item.plugin.diagnostics)) {
        if (this.runtime === undefined) {
          state = { ...state, enabled: true }
          await writeJsonAtomic(this.layout.stateFile(item.plugin.id), state)
          runtime = this.runtimeSnapshot(item.plugin.id, true)
        } else {
          try {
            runtime = await this.runtime.start(item.plugin, await resolveInstalledPluginPackageRoot(this.layout, item.install))
          } catch (error) {
            runtime = this.runtime.noteFailure(item.plugin.id, `插件父实例启动异常：${String(error)}`)
          }
          if (runtime.status === 'running' || runtime.status === 'degraded') {
            state = { ...state, enabled: true }
            try {
              await writeJsonAtomic(this.layout.stateFile(item.plugin.id), state)
            } catch (error) {
              try {
                await this.runtime.stop(item.plugin.id)
              } catch (stopError) {
                throw new AggregateError(
                  [error, stopError],
                  `插件 ${item.plugin.id} 已启动，但写入启用状态失败，且父实例停止失败`,
                )
              }
              throw error
            }
          }
        }
      }
      results.push({ plugin: item.plugin, enabled: state.enabled, runtime, install: item.install })
    }
    return results
  }

  private async createSourceRecord(
    resolved: ResolvedInstallSource,
    ownership: SourceOwnership,
    options: { as?: string; paths?: string[] },
    transaction: string,
  ): Promise<{
    sourceId: string
    recordRoot: string
    record: InstalledSourceRecord
    discovery: SourceDiscovery
  }> {
    const acquired = await acquireSource(resolved, join(transaction, 'source-acquire'))
    const provisional = normalizeManagementId(options.as ?? resolved.suggestedId ?? 'source', 'source')
    const discovery = await parseCompatSource(acquired.acquiredRoot, {
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      allowSingleWrapper: acquired.allowSingleWrapper,
      suggestedPluginId: resolved.suggestedId,
    })
    const sourceId = normalizeManagementId(
      options.as ?? discovery.name ?? resolved.suggestedId ?? provisional,
      'source',
    )
    const recordRoot = join(transaction, 'source-record')
    await Promise.all([
      mkdir(join(recordRoot, 'package'), { recursive: true, mode: 0o700 }),
      mkdir(join(recordRoot, 'cache'), { recursive: true, mode: 0o700 }),
    ])
    await copyPluginDirectory(discovery.root, join(recordRoot, 'package'))
    const source: SourceMetadata = {
      id: sourceId,
      ...(discovery.name === undefined ? {} : { name: discovery.name }),
      origin: acquired.origin,
      ownership,
      revision: acquired.revision,
      createdAt: new Date().toISOString(),
    }
    await writeInstalledSource(recordRoot, source, discovery.scan)
    return {
      sourceId,
      recordRoot,
      record: { source, scan: discovery.scan },
      discovery,
    }
  }

  private async ensureStoredSource(
    input: string,
    options: SourceAddOptions,
    ownership: SourceOwnership,
  ): Promise<{ source: SourceInspection; created: boolean }> {
    const resolved = await resolveInstallSource(input, options.cwd)
    const existing = await this.findSourceByOrigin(resolved.source)
    if (existing !== undefined) {
      const source = await withSourceLock(this.layout, existing.source.id, async () => {
        if (options.as !== undefined && normalizeManagementId(options.as, 'source') !== existing.source.id) {
          throw new Error(`该来源已登记为 Source ${existing.source.id}，不能再以 ${options.as} 重复登记`)
        }
        if ((options.paths?.length ?? 0) > 0) {
          const oldPaths = [...(existing.scan.manualPaths ?? [])].sort()
          const newPaths = [...new Set(options.paths)].sort()
          if (JSON.stringify(oldPaths) !== JSON.stringify(newPaths)) {
            throw new Error('该来源已登记，不能用不同 paths 重新定义；请先移除 Source')
          }
        }
        if (ownership === 'explicit' && existing.source.ownership === 'implicit') {
          await writeJsonAtomic(this.layout.sourceFile(existing.source.id), {
            ...existing.source,
            ownership: 'explicit' as const,
          })
        }
        return await this.inspectSourceUnlocked(existing.source.id)
      })
      return { source, created: false }
    }

    const transaction = await createTransactionDir(this.layout, 'source-add')
    try {
      const created = await this.createSourceRecord(resolved, ownership, options, transaction)
      const source = await withSourceLock(this.layout, created.sourceId, async () => {
        const destination = this.layout.sourceRoot(created.sourceId)
        if (await pathExists(destination)) throw new Error(`Source ${created.sourceId} 已存在；请使用 --as 指定其他 ID`)
        await commitDirectory(created.recordRoot, destination)
        return await this.inspectSourceUnlocked(created.sourceId)
      })
      return { source, created: true }
    } finally {
      await cleanAcquisition(transaction)
    }
  }

  async sourceAdd(input: string, options: SourceAddOptions = {}): Promise<SourceInspection> {
    return await this.withManagedRepository(async () =>
      (await this.ensureStoredSource(input, options, 'explicit')).source)
  }

  /**
   * 拉取并固定一次 Source，供需要先展示候选再安装的前端使用。
   * 新 Source 保持 implicit；调用方取消时应通过 sourceRemove 回收它。
   */
  async prepareInstall(input: string, options: SourceAddOptions = {}): Promise<InstallPreparation> {
    return await this.withManagedRepository(async () => {
      const prepared = await this.ensureStoredSource(input, options, 'implicit')
      return {
        sourceId: prepared.source.source.id,
        sourceCreated: prepared.created,
        plugins: prepared.source.compat.plugins,
      }
    })
  }

  async sourceList(): Promise<SourceListEntry[]> {
    return await this.withManagedRepository( async () => {
      const result: SourceListEntry[] = []
      for (const sourceId of await listSourceIds(this.layout)) {
        try {
          const inspection = await this.inspectSourceUnlocked(sourceId)
          result.push({
            id: sourceId,
            ...(inspection.source.name === undefined ? {} : { name: inspection.source.name }),
            ownership: inspection.source.ownership,
            originType: inspection.source.origin.type,
            formats: inspection.scan.formats,
            availablePlugins: inspection.scan.plugins.length,
            installedPlugins: inspection.installedPlugins.length,
            errors: inspection.scan.diagnostics.filter(item => item.level === 'error').length,
            warnings: inspection.scan.diagnostics.filter(item => item.level === 'warning').length
              + (inspection.unreadablePluginIds.length > 0 ? 1 : 0),
          })
        } catch {
          result.push({
            id: sourceId,
            ownership: 'explicit',
            originType: 'directory',
            formats: [],
            availablePlugins: 0,
            installedPlugins: 0,
            errors: 1,
            warnings: 0,
          })
        }
      }
      return result.sort((left, right) => left.id.localeCompare(right.id))
    })
  }

  async sourceInspect(sourceId: string): Promise<SourceInspection> {
    return await this.withManagedRepository( () =>
      withSourceLock(this.layout, sourceId, () => this.inspectSourceUnlocked(sourceId)))
  }

  async sourceRemove(sourceId: string): Promise<void> {
    await this.withManagedRepository( () => withSourceLock(this.layout, sourceId, async () => {
      await readInstalledSource(this.layout, sourceId)
      const referenceScan = await scanPluginSourceReferences(this.layout)
      if (referenceScan.unreadablePluginIds.length > 0) {
        throw new Error(
          `存在无法读取 install.json 的插件目录，不能安全删除 Source ${sourceId}：${referenceScan.unreadablePluginIds.join(', ')}`,
        )
      }
      const references = referenceScan.references.filter(item => item.sourceId === sourceId)
      if (references.length > 0) {
        throw new Error(
          `Source ${sourceId} 仍被以下已安装插件使用：${references.map(item => item.pluginId).sort().join(', ')}`,
        )
      }
      await this.removeSourceStorage(sourceId, `deleting-source-${sourceId}`)
    }))
  }

  private async resolveInstallInput(
    input: string,
    options: InstallOptions,
  ): Promise<{ sourceId?: string; forcedPlugin?: string; resolved?: ResolvedInstallSource }> {
    if (isStorageId(input) && await pathExists(this.layout.sourceRoot(input))) return { sourceId: input }
    const separator = input.lastIndexOf('@')
    if (separator > 0) {
      const plugin = input.slice(0, separator)
      const sourceId = input.slice(separator + 1)
      if (isStorageId(sourceId) && await pathExists(this.layout.sourceRoot(sourceId))) return { sourceId, forcedPlugin: plugin }
    }
    const resolved = await resolveInstallSource(input, options.cwd)
    const existing = await this.findSourceByOrigin(resolved.source)
    return existing === undefined ? { resolved } : { sourceId: existing.source.id }
  }

  async install(input: string, options: InstallOptions = {}): Promise<InstallResult> {
    return await this.withManagedRepository( async () => {
      const reference = await this.resolveInstallInput(input, options)
      const transaction = await createTransactionDir(this.layout, 'install')
      let committedNewSourceId: string | undefined
      const committedPluginIds: string[] = []
      const committedExternalPaths: string[] = []
      try {
        let sourceId: string
        let sourceRecord: InstalledSourceRecord
        let discovery: SourceDiscovery
        let stagedSourceRoot: string | undefined
        let newSource = false

        if (reference.sourceId !== undefined) {
          sourceId = reference.sourceId
          if (
            options.sourceAs !== undefined
            && normalizeManagementId(options.sourceAs, 'source') !== sourceId
          ) {
            throw new Error(
              `该来源已登记为 Source ${sourceId}，--source-as ${options.sourceAs} 不会被静默忽略`,
            )
          }
          sourceRecord = await this.readCurrentSourceRecord(sourceId)
          discovery = await this.parseStoredSource(sourceId, sourceRecord)
          if ((options.paths?.length ?? 0) > 0) {
            const oldPaths = [...(sourceRecord.scan.manualPaths ?? [])].sort()
            const newPaths = [...new Set(options.paths)].sort()
            if (JSON.stringify(oldPaths) !== JSON.stringify(newPaths)) {
              throw new Error('已有 Source 的 paths 定义不能在 install 时改变；请更新或重新添加 Source')
            }
          }
        } else {
          const created = await this.createSourceRecord(reference.resolved!, 'implicit', {
            ...(options.sourceAs === undefined ? {} : { as: options.sourceAs }),
            ...(options.paths === undefined ? {} : { paths: options.paths }),
          }, transaction)
          sourceId = created.sourceId
          sourceRecord = created.record
          discovery = created.discovery
          stagedSourceRoot = created.recordRoot
          newSource = true
          if (await pathExists(this.layout.sourceRoot(sourceId))) {
            throw new Error(`Source ${sourceId} 已存在；请使用 --source-as 指定其他 ID`)
          }
        }

        const selectors = reference.forcedPlugin === undefined
          ? options.plugins ?? []
          : [reference.forcedPlugin, ...(options.plugins ?? [])]
        const selected = this.chooseCandidates(sourceId, discovery.candidates, selectors)
        const referenceScan = await scanPluginSourceReferences(this.layout)
        if (referenceScan.unreadablePluginIds.length > 0) {
          throw new Error(
            `存在无法读取 install.json 的插件目录，不能安全判断重复安装：${referenceScan.unreadablePluginIds.join(', ')}`,
          )
        }
        for (const candidate of selected) {
          const existing = referenceScan.references.find(item =>
            item.sourceId === sourceId && item.sourcePluginId === candidate.id)
          if (existing !== undefined) {
            throw new Error(
              `Source ${sourceId} 中的 Plugin ${candidate.id} 已安装为 ${existing.pluginId}；一个具体 Plugin 不能重复安装`,
            )
          }
        }
        const sourceRoot = stagedSourceRoot ?? this.layout.sourceRoot(sourceId)
        const parsed = await this.buildParsedCandidates(
          sourceId,
          sourceRoot,
          selected,
          sourceRecord.source.revision,
          transaction,
          options,
          newSource ? undefined : this.layout.sourceExternalRoot(sourceId),
        )

        for (const item of parsed) {
          if (await pathExists(this.layout.pluginRoot(item.plugin.id))) {
            throw new Error(`插件 ${item.plugin.id} 已安装；请使用 update`)
          }
        }

        return await withSourceLock(this.layout, sourceId, () => withPluginLocks(
          this.layout,
          parsed.map(item => item.plugin.id),
          async () => {
            const stagedRecords = join(transaction, 'installed-records')
            await mkdir(stagedRecords, { recursive: true, mode: 0o700 })
            for (const item of parsed) {
              const root = join(stagedRecords, item.plugin.id)
              await Promise.all([
                mkdir(join(root, 'data'), { recursive: true, mode: 0o700 }),
                mkdir(join(root, 'cache'), { recursive: true, mode: 0o700 }),
              ])
              await writeInstalledPlugin(root, item.install, item.state, item.scan)
            }

            try {
              if (newSource) {
                await commitDirectory(sourceRoot, this.layout.sourceRoot(sourceId))
                committedNewSourceId = sourceId
              }

              // Marketplace 外部 Git Plugin 统一保存在顶层 external/<sourceId>/，
              // 不混入 Source 原始快照。提交失败时与 Source、Plugin 记录一起回滚。
              for (const item of parsed) {
                const staged = item.prepared.newlyMaterializedExternal
                if (staged === undefined) continue
                const destination = this.layout.sourceExternalPluginRoot(
                  sourceId,
                  externalDirectoryName(item.prepared.candidate.id),
                )
                await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
                if (await pathExists(destination)) {
                  throw new Error(`外部插件缓存目录已存在但未被当前安装记录复用：${destination}`)
                }
                await commitDirectory(staged, destination)
                committedExternalPaths.push(destination)
              }

              for (const item of parsed) {
                await commitDirectory(join(stagedRecords, item.plugin.id), this.layout.pluginRoot(item.plugin.id))
                committedPluginIds.push(item.plugin.id)
              }
            } catch (error) {
              for (const pluginId of committedPluginIds.reverse()) {
                await rm(this.layout.pluginRoot(pluginId), { recursive: true, force: true })
              }
              if (committedNewSourceId !== undefined) {
                await rm(this.layout.sourceRoot(committedNewSourceId), { recursive: true, force: true })
                await rm(this.layout.sourceExternalRoot(committedNewSourceId), { recursive: true, force: true })
              } else {
                for (const path of committedExternalPaths.reverse()) {
                  await rm(path, { recursive: true, force: true })
                }
              }
              throw error
            }

            let results: PluginInstallResult[]
            try {
              results = await this.startInstalledCandidates(parsed, options.enable)
            } catch (error) {
              let stopError: unknown
              if (this.runtime !== undefined) {
                for (const item of [...parsed].reverse()) {
                  try {
                    await this.runtime.stop(item.plugin.id)
                  } catch (failure) {
                    stopError ??= failure
                  }
                }
              }
              if (stopError !== undefined) {
                throw new AggregateError(
                  [error, stopError],
                  '安装提交后的启用阶段失败，且运行实例未能完全停止；为避免删除仍在使用的源码，安装记录已保留',
                )
              }
              for (const pluginId of [...committedPluginIds].reverse()) {
                await rm(this.layout.pluginRoot(pluginId), { recursive: true, force: true })
              }
              if (committedNewSourceId !== undefined) {
                await rm(this.layout.sourceRoot(committedNewSourceId), { recursive: true, force: true })
                await rm(this.layout.sourceExternalRoot(committedNewSourceId), { recursive: true, force: true })
              } else {
                for (const path of [...committedExternalPaths].reverse()) {
                  await rm(path, { recursive: true, force: true })
                }
              }
              throw error
            }
            if (results.length === 0) throw new Error('安装事务未产生插件结果')
            return {
              source: await this.inspectSourceUnlocked(sourceId),
              plugins: results,
            }
          },
        ))
      } finally {
        await cleanAcquisition(transaction)
      }
    })
  }

  async enable(pluginId: string): Promise<PluginInspection> {
    return await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      return await withSourceLock(this.layout, initial.install.sourceId, () =>
        withPluginLock(this.layout, pluginId, async () => {
          const record = await readInstalledPlugin(this.layout, pluginId)
          const source = await this.readCurrentSourceRecord(record.install.sourceId)
          const fresh = await this.parseInstalledFresh(record, source)
          await writeJsonAtomic(this.layout.scanFile(pluginId), fresh.scan)
          if (hasErrorDiagnostics(fresh.plugin.diagnostics)) {
            if (record.state.enabled && this.runtime !== undefined) await this.runtime.stop(pluginId)
            const state = { ...record.state, enabled: false }
            await writeJsonAtomic(this.layout.stateFile(pluginId), state)
            throw new CompatibilityError(`插件 ${pluginId} 存在兼容错误，不能启用`, fresh.plugin.diagnostics)
          }

          let runtime = this.runtimeSnapshot(pluginId, true)
          if (this.runtime !== undefined) {
            try {
              runtime = await this.runtime.start(fresh.plugin, fresh.packageRoot)
            } catch (error) {
              await writeJsonAtomic(this.layout.stateFile(pluginId), { ...record.state, enabled: false })
              this.runtime.noteFailure(pluginId, `插件父实例启动异常：${String(error)}`)
              throw error
            }
            if (runtime.status !== 'running' && runtime.status !== 'degraded') {
              await writeJsonAtomic(this.layout.stateFile(pluginId), { ...record.state, enabled: false })
              throw new Error(`插件 ${pluginId} 运行实例启动失败：${runtime.error ?? '未知错误'}`)
            }
          }
          const state = { ...record.state, enabled: true }
          try {
            await writeJsonAtomic(this.layout.stateFile(pluginId), state)
          } catch (error) {
            if (this.runtime !== undefined) {
              try {
                await this.runtime.stop(pluginId)
              } catch (stopError) {
                throw new AggregateError(
                  [error, stopError],
                  `插件 ${pluginId} 已启动，但写入启用状态失败，且父实例停止失败`,
                )
              }
            }
            throw error
          }
          return { install: record.install, state, scan: fresh.scan, packageRoot: fresh.packageRoot, runtime }
        }))
    })
  }

  async disable(pluginId: string): Promise<PluginInspection> {
    return await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      return await withSourceLock(this.layout, initial.install.sourceId, () =>
        withPluginLock(this.layout, pluginId, async () => {
          const record = await this.readCurrentRecord(pluginId)
          let runtime = this.runtimeSnapshot(pluginId, false)
          if (this.runtime !== undefined) runtime = await this.runtime.stop(pluginId)
          const state = { ...record.state, enabled: false }
          await writeJsonAtomic(this.layout.stateFile(pluginId), state)
          return {
            ...record,
            state,
            packageRoot: await resolveInstalledPluginPackageRoot(this.layout, record.install),
            runtime,
          }
        }))
    })
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      await withSourceLock(this.layout, initial.install.sourceId, () =>
        withPluginLock(this.layout, pluginId, async () => {
          const record = await readInstalledPlugin(this.layout, pluginId)
          // dispose 失败时禁止先删文件，确保仍可检查和恢复。
          if (this.runtime !== undefined) await this.runtime.stop(pluginId)
          await removeDirectoryTransactionally(this.layout, this.layout.pluginRoot(pluginId), `deleting-${pluginId}`)

          const referenceScan = await scanPluginSourceReferences(this.layout)
          const remainingReferences = referenceScan.references.filter(item => item.sourceId === record.install.sourceId)
          const source = await readInstalledSource(this.layout, record.install.sourceId)
          if (
            remainingReferences.length === 0
            && referenceScan.unreadablePluginIds.length === 0
            && source.source.ownership === 'implicit'
          ) {
            await this.removeSourceStorage(
              record.install.sourceId,
              `deleting-source-${record.install.sourceId}`,
            )
            return
          }

          if (record.install.location.type === 'git' || record.install.location.type === 'git-subdir') {
            const stillUsed = remainingReferences.some(item => item.sourcePluginId === record.install.sourcePluginId)
            const externalRoot = this.layout.sourceExternalPluginRoot(
              record.install.sourceId,
              externalDirectoryName(record.install.sourcePluginId),
            )
            if (!stillUsed && await pathExists(externalRoot)) {
              await removeDirectoryTransactionally(
                this.layout,
                externalRoot,
                `deleting-external-${record.install.sourcePluginId}`,
              )
            }
          }
        }))
    })
  }

  private async updateSourceUnlocked(
    sourceId: string,
    options: SourceUpdateOptions,
  ): Promise<SourceUpdateResult> {
    const oldSource = await this.readCurrentSourceRecord(sourceId)
    const installed = await this.readSourcePluginRecordsStrict(sourceId)
    const pluginIds = installed.map(item => item.install.pluginId).sort()
    const resolved = options.source === undefined
      ? resolvedFromStored(oldSource.source.origin)
      : await resolveInstallSource(options.source, options.cwd)
    const transaction = await createTransactionDir(this.layout, `source-update-${sourceId}`)
    const stagedSource = join(transaction, 'new-source')
    const stagedExternal = join(transaction, 'new-external')
    const backupSource = join(transaction, 'backup-source')
    const backupExternal = join(transaction, 'backup-external')
    const officialSource = this.layout.sourceRoot(sourceId)
    const officialExternal = this.layout.sourceExternalRoot(sourceId)
    let oldSourceMoved = false
    let oldExternalMoved = false
    let newSourceInstalled = false
    let newExternalInstalled = false
    let recordsMayHaveChanged = false
    let preserveTransaction = false
    const stoppedOldPluginIds = new Set<string>()
    const attemptedNewPluginIds = new Set<string>()

    try {
      const acquired = await acquireSource(resolved, join(transaction, 'source-acquire'))
      const discovery = await parseCompatSource(acquired.acquiredRoot, {
        ...(oldSource.scan.manualPaths === undefined ? {} : { paths: oldSource.scan.manualPaths }),
        allowSingleWrapper: acquired.allowSingleWrapper,
      })
      await Promise.all([
        mkdir(join(stagedSource, 'package'), { recursive: true, mode: 0o700 }),
        mkdir(join(stagedSource, 'cache'), { recursive: true, mode: 0o700 }),
        mkdir(stagedExternal, { recursive: true, mode: 0o700 }),
      ])
      await copyPluginDirectory(discovery.root, join(stagedSource, 'package'))
      const newSourceMetadata: SourceMetadata = {
        ...oldSource.source,
        ...(discovery.name === undefined ? {} : { name: discovery.name }),
        origin: acquired.origin,
        revision: acquired.revision,
        updatedAt: new Date().toISOString(),
      }

      const newPlugins: Array<{
        old: InstalledPluginRecord
        prepared: PreparedPlugin
        plugin: CompatPlugin
        install: InstallMetadata
        scan: ScanCache
      }> = []

      for (const old of installed) {
        const candidate = discovery.candidates.find(item => item.id === old.install.sourcePluginId)
        if (candidate === undefined) {
          throw new Error(`Source 更新后已安装插件 ${old.install.sourcePluginId} 消失；拒绝更新`)
        }
        if (!candidate.installable || hasErrorDiagnostics(candidate.diagnostics)) {
          throw new CompatibilityError(`Source 更新后插件 ${candidate.id} 的位置无效`, candidate.diagnostics)
        }

        // Source 更新必须重新获取 Marketplace 外部 Git 内容，不能复用正式缓存，
        // 否则 Source 元数据与外部 Plugin 可能落在不同版本。
        const prepared = await this.preparePluginContent(stagedSource, candidate, transaction)
        let plugin = await this.parseAndCheck(
          prepared.packageRoot,
          sourceId,
          candidate.id,
          old.install.pluginId,
          old.install.pluginId,
          pluginIds,
          candidate,
        )
        plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
        if (hasNonConflictErrors(plugin)) {
          throw new CompatibilityError(
            `Source ${sourceId} 的新版插件 ${old.install.pluginId} 存在静态兼容错误，更新未提交`,
            plugin.diagnostics,
          )
        }
        const install: InstallMetadata = {
          ...old.install,
          sourcePluginId: candidate.id,

          location: prepared.location,
          ...(prepared.materialization === undefined
            ? { materialization: undefined }
            : { materialization: prepared.materialization }),
          updatedAt: new Date().toISOString(),
        }
        newPlugins.push({
          old,
          prepared,
          plugin,
          install,
          scan: scanOf(plugin, acquired.revision),
        })
      }

      const within = findCapabilityConflictsWithin(
        newPlugins.filter(item => item.old.state.enabled).map(item => item.plugin),
      )
      for (const item of newPlugins) {
        const extra = within.get(item.plugin.id) ?? []
        if (extra.length > 0) {
          item.plugin = withAdditionalDiagnostics(item.plugin, extra)
          item.scan = scanOf(item.plugin, acquired.revision)
        }
        if (item.old.state.enabled && hasErrorDiagnostics(item.plugin.diagnostics)) {
          throw new CompatibilityError(
            `Source ${sourceId} 的新版插件 ${item.plugin.id} 存在兼容错误，更新未提交`,
            item.plugin.diagnostics,
          )
        }
      }

      // 外部 Git 内容与 Source 原始内容分别暂存，但在同一锁和回滚边界中切换。
      for (const item of newPlugins) {
        const materialized = item.prepared.newlyMaterializedExternal
        if (materialized === undefined) continue
        const destination = join(stagedExternal, externalDirectoryName(item.prepared.candidate.id))
        if (await pathExists(destination)) {
          throw new Error(`Source ${sourceId} 的外部插件缓存键重复：${item.prepared.candidate.id}`)
        }
        await commitDirectory(materialized, destination)
      }
      await writeInstalledSource(stagedSource, newSourceMetadata, discovery.scan)

      for (const item of installed
        .filter(entry => entry.state.enabled)
        .sort(compareInstalledPriority)) {
        if (this.runtime !== undefined) {
          await this.runtime.stop(item.install.pluginId)
          stoppedOldPluginIds.add(item.install.pluginId)
        }
      }

      await rename(officialSource, backupSource)
      oldSourceMoved = true
      if (await pathExists(officialExternal)) {
        await rename(officialExternal, backupExternal)
        oldExternalMoved = true
      }
      await rename(stagedSource, officialSource)
      newSourceInstalled = true
      await rename(stagedExternal, officialExternal)
      newExternalInstalled = true

      recordsMayHaveChanged = true
      for (const item of newPlugins) {
        await Promise.all([
          writeJsonAtomic(this.layout.installFile(item.install.pluginId), item.install),
          writeJsonAtomic(this.layout.scanFile(item.install.pluginId), item.scan),
          rm(this.layout.cacheDir(item.install.pluginId), { recursive: true, force: true })
            .then(() => mkdir(this.layout.cacheDir(item.install.pluginId), { recursive: true, mode: 0o700 })),
        ])
      }

      for (const item of newPlugins
        .filter(entry => entry.old.state.enabled)
        .sort((left, right) => left.old.state.priority - right.old.state.priority
          || left.install.pluginId.localeCompare(right.install.pluginId))) {
        if (this.runtime === undefined) continue
        attemptedNewPluginIds.add(item.install.pluginId)
        const runtime = await this.runtime.start(
          item.plugin,
          await resolveInstalledPluginPackageRoot(this.layout, item.install),
        )
        if (runtime.status !== 'running' && runtime.status !== 'degraded') {
          throw new Error(`新版插件 ${item.plugin.id} 运行实例启动失败：${runtime.error ?? '未知错误'}`)
        }
      }

      return {
        source: await this.inspectSourceUnlocked(sourceId),
        plugins: await Promise.all(pluginIds.map(pluginId => this.inspectUnlocked(pluginId))),
      }
    } catch (error) {
      // 静态检查阶段失败时没有停止旧实例，也没有切换目录；直接返回原错误。
      const needsRollback = stoppedOldPluginIds.size > 0
        || oldSourceMoved
        || oldExternalMoved
        || newSourceInstalled
        || newExternalInstalled
        || recordsMayHaveChanged
      if (!needsRollback) throw error

      let rollbackError: unknown
      try {
        if (this.runtime !== undefined) {
          const stopFailures: unknown[] = []
          for (const pluginId of attemptedNewPluginIds) {
            try {
              await this.runtime.stop(pluginId)
            } catch (stopFailure) {
              stopFailures.push(new Error(
                `无法停止新版插件 ${pluginId}；为避免删除仍在使用的 Source，已中止文件回滚`,
                { cause: stopFailure },
              ))
            }
          }
          if (stopFailures.length > 0) {
            preserveTransaction = oldSourceMoved
              || oldExternalMoved
              || newSourceInstalled
              || newExternalInstalled
            throw new AggregateError(stopFailures, '一个或多个新版运行实例无法安全停止')
          }
        }

        if (newExternalInstalled) {
          await rm(officialExternal, { recursive: true, force: true })
          newExternalInstalled = false
        }
        if (oldExternalMoved) {
          await rename(backupExternal, officialExternal)
          oldExternalMoved = false
        }
        if (newSourceInstalled) {
          await rm(officialSource, { recursive: true, force: true })
          newSourceInstalled = false
        }
        if (oldSourceMoved) {
          await rename(backupSource, officialSource)
          oldSourceMoved = false
        }

        if (recordsMayHaveChanged) {
          for (const record of installed) {
            await Promise.all([
              writeJsonAtomic(this.layout.installFile(record.install.pluginId), record.install),
              writeJsonAtomic(this.layout.scanFile(record.install.pluginId), record.scan),
              writeJsonAtomic(this.layout.stateFile(record.install.pluginId), record.state),
            ])
          }
          recordsMayHaveChanged = false
        }

        if (this.runtime !== undefined) {
          for (const record of installed
            .filter(item => item.state.enabled && stoppedOldPluginIds.has(item.install.pluginId))
            .sort(compareInstalledPriority)) {
            const restored = await this.runtime.start(
              record.scan.plugin,
              await resolveInstalledPluginPackageRoot(this.layout, record.install),
            )
            if (restored.status !== 'running' && restored.status !== 'degraded') {
              throw new Error(
                `旧插件 ${record.install.pluginId} 恢复后启动失败：${restored.error ?? '未知错误'}`,
              )
            }
          }
        }
      } catch (restoreFailure) {
        // backup-source / backup-external 位于事务目录内。只要其中之一尚未
        // 恢复，就必须保留整个事务目录，禁止 finally 清理最后的恢复材料。
        preserveTransaction = preserveTransaction || oldSourceMoved || oldExternalMoved
        rollbackError = restoreFailure
      }

      if (rollbackError !== undefined) {
        const recoveryHint = preserveTransaction
          ? `；恢复材料已保留在 ${transaction}`
          : ''
        throw new AggregateError(
          [error, rollbackError],
          `更新 Source ${sourceId} 失败，且回滚未完全成功${recoveryHint}`,
        )
      }
      throw error
    } finally {
      if (!preserveTransaction) await cleanAcquisition(transaction)
    }
  }
  async sourceUpdate(sourceId: string, options: SourceUpdateOptions = {}): Promise<SourceUpdateResult> {
    return await this.withManagedRepository( async () => {
      const records = await this.readSourcePluginRecordsStrict(sourceId)
      return await withSourceLock(this.layout, sourceId, () => withPluginLocks(
        this.layout,
        records.map(item => item.install.pluginId),
        () => this.updateSourceUnlocked(sourceId, options),
      ))
    })
  }

  async update(pluginId: string, options: UpdateOptions = {}): Promise<PluginInspection> {
    return await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      const affected = await this.readSourcePluginRecordsStrict(initial.install.sourceId)
      if (affected.length > 1 && !options.confirmShared) {
        throw new SharedSourceUpdateError(
          initial.install.sourceId,
          affected.map(item => item.install.pluginId).sort(),
        )
      }
      return await withSourceLock(this.layout, initial.install.sourceId, () => withPluginLocks(
        this.layout,
        affected.map(item => item.install.pluginId),
        async () => {
          await this.updateSourceUnlocked(initial.install.sourceId, options)
          return await this.inspectUnlocked(pluginId)
        },
      ))
    })
  }

  async list(): Promise<PluginListEntry[]> {
    return await this.withManagedRepository( async () => {
      const entries: PluginListEntry[] = []
      for (const pluginId of await listPluginIds(this.layout)) {
        try {
          const record = await this.readCurrentRecord(pluginId)
          const plugin = record.scan.plugin
          const snapshot = this.runtimeSnapshot(pluginId, record.state.enabled)
          entries.push({
            id: plugin.id,
            name: plugin.name,
            ...(plugin.version === undefined ? {} : { version: plugin.version }),
            sourceId: record.install.sourceId,
            enabled: record.state.enabled,
            priority: record.state.priority,
            runtimeStatus: record.state.enabled && this.runtime === undefined ? 'pending-restart' : snapshot.status,
            formats: plugin.formats,
            skills: plugin.skills.length,
            mcpServers: plugin.mcpServers.length,
            hooks: plugin.hooks.length,
            errors: plugin.diagnostics.filter(item => item.level === 'error').length,
            warnings: plugin.diagnostics.filter(item => item.level === 'warning').length,
            diagnostics: plugin.diagnostics.flatMap((item) => {
              if (item.level === 'info') return []
              return [{
                level: item.level,
                code: item.code,
                capability: item.capability,
                message: item.message,
                ...(item.file === undefined ? {} : { file: item.file }),
              }]
            }),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          entries.push({
            id: pluginId,
            name: pluginId,
            sourceId: '(损坏)',
            enabled: false,
            priority: 0,
            runtimeStatus: 'failed',
            formats: [],
            skills: 0,
            mcpServers: 0,
            hooks: 0,
            errors: 1,
            warnings: 0,
            diagnostics: [{
              level: 'error',
              code: 'INSTALLED_PLUGIN_READ_FAILED',
              capability: 'plugin',
              message: `无法读取插件安装记录：${message}`,
            }],
          })
        }
      }
      return entries.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    })
  }

  private async inspectUnlocked(pluginId: string): Promise<PluginInspection> {
    const record = await this.readCurrentRecord(pluginId)
    return {
      ...record,
      packageRoot: await resolveInstalledPluginPackageRoot(this.layout, record.install),
      runtime: this.runtimeSnapshot(pluginId, record.state.enabled),
    }
  }

  async inspect(pluginId: string): Promise<PluginInspection> {
    return await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      return await withSourceLock(this.layout, initial.install.sourceId, () =>
        withPluginLock(this.layout, pluginId, () => this.inspectUnlocked(pluginId)))
    })
  }

  /** DSH 启动时按 priority/pluginId 恢复整插件父实例。 */
  async reconcile(): Promise<void> {
    await this.withManagedRepository( async () => {
      const records: InstalledPluginRecord[] = []
      for (const pluginId of await listPluginIds(this.layout)) {
        try {
          const record = await this.readCurrentRecord(pluginId)
          if (record.state.enabled) records.push(record)
        } catch (error) {
          if (this.runtime !== undefined) {
            this.runtime.noteFailure(pluginId, `加载安装记录失败：${String(error)}`)
          }
        }
      }
      records.sort(compareInstalledPriority)

      for (const record of records) {
        const plugin = record.scan.plugin
        if (hasErrorDiagnostics(plugin.diagnostics)) {
          await writeJsonAtomic(this.layout.stateFile(plugin.id), { ...record.state, enabled: false })
          if (this.runtime !== undefined) this.runtime.noteFailure(plugin.id, '插件存在兼容 error，已阻止自动启用')
          continue
        }
        if (this.runtime !== undefined) {
          const result = await this.runtime.start(plugin, await resolveInstalledPluginPackageRoot(this.layout, record.install))
          if (result.status !== 'running' && result.status !== 'degraded') {
            this.runtime.noteFailure(plugin.id, result.error ?? '启动失败')
          }
        }
      }
    })
  }
}
