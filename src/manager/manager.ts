import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CompatParserEngine, CompatCategory } from '../parser/contracts.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../types/catalog.js'
import { normalizeManagementId } from '../shared/id.js'
import { copyPluginDirectory } from '../source/directory.js'
import { pathExists } from '../source/filesystem.js'
import { resolveInstallSource } from '../source/resolver.js'
import { CompatLayout, isStorageId } from '../store/layout.js'
import { withPluginLock, withPluginLocks, withRepositoryLock, withSourceLock } from '../store/lock.js'
import { listPluginIds, listSourceIds, readInstalledPlugin, readInstalledSource, scanPluginSourceReferences, writeInstalledPlugin, writeInstalledSource } from '../store/metadata.js'
import { writeJsonAtomic } from '../store/json.js'
import { commitDirectory, createTransactionDir, removeDirectoryTransactionally } from '../store/transaction.js'
import { hasErrorDiagnostics, uniqueDiagnostics } from '../types/diagnostic.js'
import { withAdditionalDiagnostics } from '../parser/model.js'
import type { InstalledPluginRecord } from '../types/plugin.js'
import type { PluginRuntimeSnapshot } from '../types/runtime.js'
import type { InstalledSourceRecord, ResolvedInstallSource, SourceMetadata, SourceOwnership } from '../types/source.js'
import type { CompatRuntimeManager } from '../runtime/manager.js'
import { sha256File } from '../source/archive.js'
import { isUploadedArchive, retainUploadedArchive } from './uploaded-archive.js'
import { acquireSource, cleanAcquisition } from './acquire.js'
import { CompatibilityError, ParserSelectionRequiredError, SharedSourceUpdateError } from './errors.js'
import { asCompatSource, compareInstalledPriority, externalDirectoryName, latestRevisionFor, resolvedFromStored, runtimeDisabled } from './helpers.js'
import { CompatRepository } from './repository.js'
import { buildParsedCandidates, inspectPreparedParsers, preparePluginContent, resolveParserSelections } from './plugin-preparation.js'
import { updateSourceUnlocked } from './source-update.js'
import type { InstallCompletion, PluginInstallSelection, PreparedPlugin, InstallOptions, InstallPreparation, InstallResult, ParsedInstallCandidate, PluginInspection, PluginInstallResult, PluginListEntry, SourceAddOptions, SourceInspection, SourceListEntry, SourceUpdateCheck, SourceUpdateOptions, SourceUpdateResult, UpdateOptions } from './types.js'
import { createSourceScan, resolveInstalledPluginPackageRoot } from './plugin-loader.js'

interface SourceSnapshot {
  sourceId: string
  identity: string
  createdAt: string
  revision: string
  origin: SourceMetadata['origin']
}

interface PreparedSource {
  snapshot: SourceSnapshot
  cleanupSource: boolean
  preparations: Set<string>
}

interface PreparedSelection {
  transaction: string
  pluginIds: string[]
  contents: PreparedPlugin[]
}

export interface CompatManagerOptions {
  /** Read-only origin probe; injection keeps lock and race tests deterministic. */
  probeRevision?: (source: ResolvedInstallSource) => Promise<string>
  /** 临时目录回收；注入仅用于确定性验证提交后的清理失败。 */
  cleanupTemporary?: (path: string) => Promise<void>
}

class RuntimeSynchronizationError extends Error {
  constructor(readonly pluginId: string, cause: unknown) {
    super(`插件 ${pluginId} 运行状态同步失败：${String(cause)}`, { cause })
    this.name = 'RuntimeSynchronizationError'
  }
}

export class CompatManager {
  private readonly preparations = new Map<string, PreparedSource>()
  private readonly preparedSelections = new Map<string, PreparedSelection>()
  private readonly preparedSources = new Set<PreparedSource>()
  private readonly pendingCleanups = new Set<string>()

  constructor(
    readonly layout: CompatLayout,
    readonly runtime: CompatRuntimeManager | undefined,
    readonly parsers: CompatParserEngine,
    private readonly options: CompatManagerOptions = {},
  ) {
    this.repository = new CompatRepository(layout, parsers)
  }

  private readonly repository: CompatRepository

  /** 仅包含当前装配实例的解析器分类，不读取安装记录或格式边界。 */
  listCategories(): CompatCategory[] {
    return this.parsers.categories.map(category => structuredClone(category))
  }

  private async synchronizeRuntime(record: InstalledPluginRecord): Promise<void> {
    if (this.runtime === undefined) return
    const pluginId = record.install.pluginId
    try {
      const status = this.runtime.get(pluginId).status
      if (status !== 'running' && status !== 'degraded' && status !== 'starting') return
      if (hasErrorDiagnostics(record.scan.plugin.diagnostics)) {
        await this.runtime.stop(pluginId)
        this.runtime.noteFailure(pluginId, '插件存在兼容 error，已阻止运行；启用意愿已保留')
      } else if (record.state.enabled) {
        const packageRoot = await resolveInstalledPluginPackageRoot(this.layout, record.install)
        if (!this.runtime.isCurrent(record.scan.plugin, packageRoot)) await this.runtime.start(record.scan.plugin, packageRoot)
      } else await this.runtime.stop(pluginId)
    } catch (error) {
      throw new RuntimeSynchronizationError(pluginId, error)
    }
  }

  private async readAndSynchronizeRecord(pluginId: string): Promise<InstalledPluginRecord> {
    const record = await this.repository.readCurrentRecord(pluginId)
    await this.synchronizeRuntime(record)
    return record
  }

  /** Serialize repository snapshots and mutations; slow read-only origin probes run outside it. */
  private async withManagedRepository<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return await withRepositoryLock(this.layout, async () => {
      for (const path of [...this.pendingCleanups]) {
        try {
          await this.removeTemporary(path)
          this.pendingCleanups.delete(path)
        } catch {
          // 安装结果已报告清理警告；保留责任供后续操作重试，不影响已提交状态。
        }
      }
      return await operation()
    }, { signal })
  }

  private async removeTemporary(path: string): Promise<void> {
    await (this.options.cleanupTemporary ?? cleanAcquisition)(path)
  }

  private async cleanupUncommitted(path: string): Promise<void> {
    try {
      await this.removeTemporary(path)
    } catch (error) {
      this.pendingCleanups.add(path)
      throw error
    }
  }

  private async cleanupCommitted(path: string, result: InstallResult, phase: string): Promise<void> {
    try {
      await this.removeTemporary(path)
    } catch {
      this.pendingCleanups.add(path)
      for (const item of result.plugins) {
        item.plugin = withAdditionalDiagnostics(item.plugin, [{ level: 'warning', code: 'TEMP_CLEANUP_FAILED', capability: 'plugin',
          message: '插件已安装成功，临时内容清理暂时失败；后续操作会重试清理', details: { phase } }])
      }
    }
  }

  private runtimeSnapshot(pluginId: string, enabled: boolean): PluginRuntimeSnapshot {
    if (this.runtime !== undefined) return this.runtime.get(pluginId)
    return enabled
      ? { pluginId, status: 'disabled', capabilities: [], error: '离线管理模式：将在 DSH 下次加载时启用' }
      : runtimeDisabled(pluginId)
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
    discovery: SourceDiscovery,
    selectors: readonly string[],
  ): SourcePluginCandidate[] {
    const candidates = discovery.candidates
    if (candidates.length === 0) throw new Error(`Source ${sourceId} 没有可定位的插件`)
    let requested = [...selectors]
    if (requested.length === 0 && discovery.scan.discovery === 'single-plugin' && candidates.length === 1) requested = [candidates[0].id]
    if (requested.length === 0) {
      throw new Error(
        `Source ${sourceId} 必须通过 plugins 显式选择：${candidates.map(item => item.id).join(', ')}`,
      )
    }

    const selected: SourcePluginCandidate[] = []
    for (const selector of [...new Set(requested)]) {
      const candidate = candidates.find(item => item.id === selector)
      if (candidate === undefined) {
        throw new Error(`Source ${sourceId} 不包含插件 ${selector}；可选：${candidates.map(item => item.id).join(', ')}`)
      }
      if (!candidate.installable) {
        throw new CompatibilityError(
          `插件 ${candidate.id} 的 Marketplace 位置存在错误或来源类型不受支持，不能安装`,
          candidate.diagnostics,
        )
      }
      selected.push(candidate)
    }
    return selected
  }

  private async startInstalledCandidates(
    items: ParsedInstallCandidate[],
    requestedEnable?: boolean,
  ): Promise<PluginInstallResult[]> {
    const results: PluginInstallResult[] = []
    for (const item of items) {
      let state = item.state
      let runtime = runtimeDisabled(item.plugin.id)
      const shouldEnable = requestedEnable ?? item.prepared.candidate.defaultEnabled ?? item.plugin.defaultEnabled ?? true
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
    options: SourceAddOptions & { retainArchive?: boolean },
    transaction: string,
  ): Promise<{
    sourceId: string
    recordRoot: string
    record: InstalledSourceRecord
    discovery: SourceDiscovery
  }> {
    const acquired = await acquireSource(resolved, join(transaction, 'source-acquire'), options.signal)
    const provisional = normalizeManagementId(options.as ?? resolved.suggestedId ?? 'source', 'source')
    const discovery = await this.parsers.parseSource(acquired.acquiredRoot, {
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      allowSingleWrapper: acquired.allowSingleWrapper,
      suggestedPluginId: resolved.suggestedId ?? provisional,
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
    await copyPluginDirectory(discovery.root, join(recordRoot, 'package'), options.signal)
    options.signal?.throwIfAborted()
    const source: SourceMetadata = {
      id: sourceId,
      ...(discovery.name === undefined ? {} : { name: discovery.name }),
      origin: options.retainArchive ? await retainUploadedArchive(this.layout, sourceId, acquired.origin, recordRoot) : acquired.origin,
      ownership,
      revision: acquired.revision,
      createdAt: new Date().toISOString(),
    }
    await writeInstalledSource(recordRoot, source, createSourceScan(discovery.scan, source.revision, this.parsers))
    return {
      sourceId,
      recordRoot,
      record: { source, scan: createSourceScan(discovery.scan, source.revision, this.parsers) },
      discovery,
    }
  }

  private async ensureStoredSource(
    input: string,
    options: SourceAddOptions & { retainArchive?: boolean },
    ownership: SourceOwnership,
  ): Promise<{ source: SourceInspection; created: boolean }> {
    options.signal?.throwIfAborted()
    const resolved = await resolveInstallSource(input, options.cwd)
    if (options.retainArchive) {
      if (resolved.source.type !== 'archive') throw new Error('上传来源必须是归档文件')
      resolved.source.sha256 = await sha256File(resolved.source.path, options.signal)
      resolved.suggestedId = `upload-${resolved.source.sha256.slice(0, 24)}`
    }
    const existing = await this.repository.findSourceByOrigin(resolved.source)
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
        options.signal?.throwIfAborted()
        let metadata = existing.source
        if (options.retainArchive && !isUploadedArchive(this.layout, metadata.id, metadata.origin)) {
          const origin = await retainUploadedArchive(this.layout, metadata.id, resolved.source, this.layout.sourceRoot(metadata.id))
          metadata = { ...metadata, origin }
        }
        if (ownership === 'explicit' && metadata.ownership === 'implicit') metadata = { ...metadata, ownership: 'explicit' }
        if (metadata !== existing.source) {
          await writeJsonAtomic(this.layout.sourceFile(metadata.id), metadata)
          const current = await this.sourceSnapshot(metadata)
          for (const group of this.preparedSources) {
            if (group.snapshot.sourceId === current.sourceId && group.snapshot.identity === current.identity
              && group.snapshot.createdAt === current.createdAt && group.snapshot.revision === current.revision
              && JSON.stringify(group.snapshot.origin) === JSON.stringify(existing.source.origin)) {
              // Only the location of the identical archived bytes changed; fixed content and cleanup ownership remain.
              group.snapshot.origin = structuredClone(current.origin)
            }
          }
        }
        return await this.repository.inspectSourceUnlocked(existing.source.id)
      }, { signal: options.signal })
      return { source, created: false }
    }

    const transaction = await createTransactionDir(this.layout, 'source-add')
    try {
      const created = await this.createSourceRecord(resolved, ownership, options, transaction)
      const source = await withSourceLock(this.layout, created.sourceId, async () => {
        const destination = this.layout.sourceRoot(created.sourceId)
        if (await pathExists(destination)) throw new Error(`Source ${created.sourceId} 已存在；请使用 --as 指定其他 ID`)
        options.signal?.throwIfAborted()
        await commitDirectory(created.recordRoot, destination)
        try {
          const inspection = await this.repository.inspectSourceUnlocked(created.sourceId)
          options.signal?.throwIfAborted()
          return inspection
        } catch (error) {
          // 新建来源尚未交给调用方，失败或取消时在持锁范围内回收。
          await rm(destination, { recursive: true, force: true })
          throw error
        }
      }, { signal: options.signal })
      return { source, created: true }
    } finally {
      await cleanAcquisition(transaction)
    }
  }

  async sourceAdd(input: string, options: SourceAddOptions = {}): Promise<SourceInspection> {
    return await this.withManagedRepository(async () =>
      (await this.ensureStoredSource(input, options, 'explicit')).source, options.signal)
  }

  private async sourceSnapshot(source: SourceMetadata): Promise<SourceSnapshot> {
    const info = await stat(this.layout.sourceRoot(source.id), { bigint: true })
    return {
      sourceId: source.id,
      identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
      createdAt: source.createdAt,
      revision: source.revision,
      origin: source.origin,
    }
  }

  private async snapshotIsCurrent(snapshot: SourceSnapshot): Promise<boolean> {
    if (!await pathExists(this.layout.sourceRoot(snapshot.sourceId))) return false
    const record = await readInstalledSource(this.layout, snapshot.sourceId)
    const current = await this.sourceSnapshot(record.source)
    return current.identity === snapshot.identity && current.createdAt === snapshot.createdAt
      && current.revision === snapshot.revision && JSON.stringify(current.origin) === JSON.stringify(snapshot.origin)
  }

  /** Prepare one fixed Source; callers complete or release this Manager-owned session. */
  async prepareInstall(input: string, options: SourceAddOptions = {}): Promise<InstallPreparation> {
    return await this.prepareSourceInstall(input, options)
  }

  /** Upload intake transfers the original archive into Source-owned storage. */
  async prepareArchiveInstall(input: string, signal?: AbortSignal): Promise<InstallPreparation> {
    return await this.prepareSourceInstall(input, { retainArchive: true, signal })
  }

  private async prepareSourceInstall(input: string, options: SourceAddOptions & { retainArchive?: boolean }): Promise<InstallPreparation> {
    return await this.withManagedRepository(async () => {
      const prepared = await this.ensureStoredSource(input, options, 'implicit')
      const snapshot = await this.sourceSnapshot(prepared.source.source)
      let group = [...this.preparedSources].find(item => item.snapshot.sourceId === snapshot.sourceId
        && item.snapshot.identity === snapshot.identity && item.snapshot.revision === snapshot.revision
        && item.snapshot.createdAt === snapshot.createdAt
        && JSON.stringify(item.snapshot.origin) === JSON.stringify(snapshot.origin))
      if (group === undefined) {
        group = { snapshot, cleanupSource: prepared.created, preparations: new Set() }
        this.preparedSources.add(group)
      }
      const preparationId = randomUUID()
      group.preparations.add(preparationId)
      this.preparations.set(preparationId, group)
      return {
        preparationId,
        sourceId: prepared.source.source.id,
        sourceCreated: prepared.created,
        selectionRequired: prepared.source.compat.discovery !== 'single-plugin' || prepared.source.compat.plugins.length !== 1,
        plugins: prepared.source.compat.plugins,
      }
    }, options.signal)
  }

  private finishPreparation(preparationId: string, group: PreparedSource): void {
    this.preparations.delete(preparationId)
    group.preparations.delete(preparationId)
    if (group.preparations.size === 0) this.preparedSources.delete(group)
  }

  /** 固定所选插件内容，解决解析器选择后才提交安装事务。 */
  async completeInstallPreparation(preparationId: string, plugins: PluginInstallSelection[], signal?: AbortSignal): Promise<InstallCompletion> {
    return await this.withManagedRepository(async () => {
      const group = this.preparations.get(preparationId)
      if (group === undefined) throw new Error('该添加请求已结束，请重新拉取来源')
      this.validateSelections(plugins)
      if (!await this.snapshotIsCurrent(group.snapshot)) throw new Error('准备安装的 Source 已变化，请重新拉取来源')
      const source = await this.repository.readCurrentSourceRecord(group.snapshot.sourceId)
      const discovery = await this.repository.parseStoredSource(group.snapshot.sourceId, source)
      const selected = this.chooseCandidates(group.snapshot.sourceId, discovery, plugins.map(item => item.pluginId))
      const ids = selected.map(item => item.id).sort()
      let staged = this.preparedSelections.get(preparationId)
      if (staged !== undefined && JSON.stringify(staged.pluginIds) !== JSON.stringify(ids)) {
        throw new Error('已固定的插件选择不能更改；请取消后重新准备安装')
      }
      if (staged === undefined) {
        const transaction = await createTransactionDir(this.layout, 'parser-selection')
        try {
          const contents: PreparedPlugin[] = []
          for (const candidate of selected) {
            signal?.throwIfAborted()
            contents.push(await preparePluginContent(this.layout.sourceRoot(group.snapshot.sourceId), candidate, transaction,
              this.layout.sourceExternalRoot(group.snapshot.sourceId), signal))
          }
          staged = { transaction, pluginIds: ids, contents }
          this.preparedSelections.set(preparationId, staged)
        } catch (error) {
          try { await this.cleanupUncommitted(transaction) } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '插件内容准备失败且临时清理暂时失败；后续操作会重试清理')
          }
          throw error
        }
      }
      signal?.throwIfAborted()
      const choices = await inspectPreparedParsers(this.parsers, staged.contents)
      let resolved: Map<string, string>
      try {
        resolved = resolveParserSelections(choices, plugins)
      } catch (error) {
        if (error instanceof ParserSelectionRequiredError) return { kind: 'parser-selection', plugins: error.plugins }
        throw error
      }
      const result = await this.installUnlocked(group.snapshot.sourceId, {
        plugins: plugins.map(item => ({ pluginId: item.pluginId, parserId: resolved.get(item.pluginId)! })), signal,
      }, staged.contents)
      this.preparedSelections.delete(preparationId)
      this.finishPreparation(preparationId, group)
      await this.cleanupCommitted(staged.transaction, result, 'parser-selection')
      return { kind: 'installed', result }
    }, signal)
  }

  private validateSelections(plugins: readonly PluginInstallSelection[]): void {
    if (plugins.length === 0) throw new Error('请至少选择一个可安装插件')
    const ids = new Set<string>()
    for (const item of plugins) {
      if (typeof item !== 'object' || item === null || typeof item.pluginId !== 'string' || item.pluginId.trim() === ''
        || (item.parserId !== undefined && (typeof item.parserId !== 'string' || item.parserId.trim() === ''))) {
        throw new Error('插件选择必须包含有效 pluginId，以及可选的 parserId')
      }
      if (ids.has(item.pluginId)) throw new Error(`插件 ${item.pluginId} 被重复选择`)
      ids.add(item.pluginId)
    }
  }

  /** Release only this session; the last owner may reclaim its original implicit Source. */
  async releaseInstallPreparation(preparationId: string): Promise<void> {
    await this.withManagedRepository(async () => {
      const group = this.preparations.get(preparationId)
      if (group === undefined) return
      const selection = this.preparedSelections.get(preparationId)
      if (selection !== undefined) {
        await this.cleanupUncommitted(selection.transaction)
        this.preparedSelections.delete(preparationId)
      }
      if (group.preparations.size === 1 && group.cleanupSource) {
        await withSourceLock(this.layout, group.snapshot.sourceId, async () => {
          if (!await this.snapshotIsCurrent(group.snapshot)) return
          const record = await readInstalledSource(this.layout, group.snapshot.sourceId)
          if (record.source.ownership !== 'implicit') return
          const scan = await scanPluginSourceReferences(this.layout)
          if (scan.unreadablePluginIds.length > 0) throw new Error('存在无法读取的插件引用，临时 Source 未清理')
          if (scan.references.some(item => item.sourceId === group.snapshot.sourceId)) return
          await this.removeSourceStorage(group.snapshot.sourceId, `releasing-source-${group.snapshot.sourceId}`)
        })
      }
      this.finishPreparation(preparationId, group)
    })
  }

  async sourceList(): Promise<SourceListEntry[]> {
    return await this.withManagedRepository( async () => {
      const result: SourceListEntry[] = []
      for (const sourceId of await listSourceIds(this.layout)) {
        try {
          const inspection = await this.repository.inspectSourceUnlocked(sourceId)
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
      withSourceLock(this.layout, sourceId, () => this.repository.inspectSourceUnlocked(sourceId)))
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
    const existing = await this.repository.findSourceByOrigin(resolved.source)
    return existing === undefined ? { resolved } : { sourceId: existing.source.id }
  }

  async install(input: string, options: InstallOptions = {}): Promise<InstallResult> {
    return await this.withManagedRepository(() => this.installUnlocked(input, options), options.signal)
  }

  private async installUnlocked(input: string, options: InstallOptions, preparedContents?: readonly PreparedPlugin[]): Promise<InstallResult> {
    options.signal?.throwIfAborted()
    if (options.plugins !== undefined && options.plugins.length > 0) this.validateSelections(options.plugins)
    const reference = await this.resolveInstallInput(input, options)
    const transaction = await createTransactionDir(this.layout, 'install')
    let committedNewSourceId: string | undefined
    const committedPluginIds: string[] = []
    const committedExternalPaths: string[] = []
    let committedResult: InstallResult | undefined
    let operationError: unknown
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
        sourceRecord = await this.repository.readCurrentSourceRecord(sourceId)
        discovery = await this.repository.parseStoredSource(sourceId, sourceRecord)
        if ((options.paths?.length ?? 0) > 0) {
          const oldPaths = [...(sourceRecord.scan.manualPaths ?? [])].sort()
          const newPaths = [...new Set(options.paths)].sort()
          if (JSON.stringify(oldPaths) !== JSON.stringify(newPaths)) {
            throw new Error('已有 Source 的 paths 定义不能在 install 时改变；请更新或重新添加 Source')
          }
        }
      } else {
        const created = await this.createSourceRecord(reference.resolved!, 'implicit', {
          signal: options.signal,
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

      options.signal?.throwIfAborted()
      const requestedPlugins = [...(options.plugins ?? [])]
      if (reference.forcedPlugin !== undefined && !requestedPlugins.some(item => item.pluginId === reference.forcedPlugin)) {
        requestedPlugins.unshift({ pluginId: reference.forcedPlugin })
      }
      const selected = this.chooseCandidates(sourceId, discovery, requestedPlugins.map(item => item.pluginId))
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
      const parsed = await buildParsedCandidates(
        this,
        sourceId,
        sourceRoot,
        selected,
        sourceRecord.source.revision,
        transaction,
        { ...options, plugins: requestedPlugins },
        newSource ? undefined : this.layout.sourceExternalRoot(sourceId),
        preparedContents,
      )

      for (const item of parsed) {
        if (await pathExists(this.layout.pluginRoot(item.plugin.id))) {
          throw new Error(`插件 ${item.plugin.id} 已安装；请使用 update`)
        }
      }

      committedResult = await withSourceLock(this.layout, sourceId, () => withPluginLocks(
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
            options.signal?.throwIfAborted()
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
            options.signal?.throwIfAborted()
            results = await this.startInstalledCandidates(parsed, options.enable)
            options.signal?.throwIfAborted()
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
            source: {
              ...sourceRecord,
              compat: asCompatSource(sourceRecord),
              installedPlugins: [
                ...referenceScan.references.filter(item => item.sourceId === sourceId).map(({ pluginId, sourcePluginId }) => ({ pluginId, sourcePluginId })),
                ...parsed.map(item => ({ pluginId: item.install.pluginId, sourcePluginId: item.install.sourcePluginId })),
              ].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
              unreadablePluginIds: [],
            },
            plugins: results,
          }
        },
      ))
      return committedResult
    } catch (error) {
      operationError = error
      throw error
    } finally {
      if (committedResult !== undefined) await this.cleanupCommitted(transaction, committedResult, 'install')
      else {
        try { await this.cleanupUncommitted(transaction) } catch (cleanupError) {
          throw new AggregateError([operationError, cleanupError], '安装未完成且临时清理暂时失败；后续操作会重试清理')
        }
      }
    }
  }

  async enable(pluginId: string): Promise<PluginInspection> {
    return await this.withManagedRepository( async () => {
      const initial = await readInstalledPlugin(this.layout, pluginId)
      return await withSourceLock(this.layout, initial.install.sourceId, () =>
        withPluginLock(this.layout, pluginId, async () => {
          const record = await readInstalledPlugin(this.layout, pluginId)
          const source = await this.repository.readCurrentSourceRecord(record.install.sourceId)
          const fresh = await this.repository.parseInstalledFresh(record, source)
          await writeJsonAtomic(this.layout.scanFile(pluginId), fresh.scan)
          if (hasErrorDiagnostics(fresh.plugin.diagnostics)) {
            if (record.state.enabled && this.runtime !== undefined) await this.runtime.stop(pluginId)
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
          const record = await this.repository.readCurrentRecord(pluginId)
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

  private async updateSourceUnlocked(sourceId: string, options: SourceUpdateOptions): Promise<SourceUpdateResult> {
    return await updateSourceUnlocked({
      layout: this.layout,
      runtime: this.runtime,
      parsers: this.parsers,
      repository: this.repository,
      readPluginRecord: this.readAndSynchronizeRecord.bind(this),
      inspectPlugin: this.inspectUnlocked.bind(this),
    }, sourceId, options)
  }

  async sourceUpdate(sourceId: string, options: SourceUpdateOptions = {}): Promise<SourceUpdateResult> {
    return await this.withManagedRepository( async () => {
      const records = await this.repository.readSourcePluginRecordsStrict(sourceId)
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
      const affected = await this.repository.readSourcePluginRecordsStrict(initial.install.sourceId)
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

  /** Capture under a short lock, probe origins without locks, then validate the snapshot. */
  async checkUpdates(): Promise<SourceUpdateCheck[]> {
    const captured = await this.withManagedRepository(async () => {
      const references = await scanPluginSourceReferences(this.layout)
      const checks: Array<{ check: SourceUpdateCheck; snapshot?: SourceSnapshot }> = []
      for (const sourceId of await listSourceIds(this.layout)) {
        const affectedPluginIds = references.references.filter(item => item.sourceId === sourceId)
          .map(item => item.pluginId).sort()
        if (affectedPluginIds.length === 0) continue
        const check: SourceUpdateCheck = { sourceId, currentRevision: '', affectedPluginIds, updateAvailable: false }
        try {
          const record = await readInstalledSource(this.layout, sourceId)
          check.currentRevision = record.source.revision
          checks.push({ check, snapshot: await this.sourceSnapshot(record.source) })
        } catch (error) {
          checks.push({ check: { ...check, error: error instanceof Error ? error.message : String(error) } })
        }
      }
      return checks
    })
    const probe = this.options.probeRevision ?? latestRevisionFor
    const completed = await Promise.all(captured.map(async ({ check, snapshot }) => {
      if (snapshot === undefined) return { check, snapshot }
      try {
        const latestRevision = await probe(resolvedFromStored(snapshot.origin))
        return { snapshot, check: { ...check, latestRevision, updateAvailable: latestRevision !== snapshot.revision } }
      } catch (error) {
        return { snapshot, check: { ...check, error: error instanceof Error ? error.message : String(error) } }
      }
    }))
    return await this.withManagedRepository(async () => {
      const references = await scanPluginSourceReferences(this.layout)
      const checks: SourceUpdateCheck[] = []
      for (const { check, snapshot } of completed) {
        if (snapshot === undefined) { checks.push(check); continue }
        const ids = references.references.filter(item => item.sourceId === check.sourceId).map(item => item.pluginId).sort()
        try {
          if (!await this.snapshotIsCurrent(snapshot) || JSON.stringify(ids) !== JSON.stringify(check.affectedPluginIds)) {
            checks.push({ sourceId: check.sourceId, currentRevision: check.currentRevision,
              affectedPluginIds: ids, updateAvailable: false, error: 'Source 或插件引用在更新检查期间已变化，请重新检查' })
          } else checks.push(check)
        } catch (error) {
          checks.push({ sourceId: check.sourceId, currentRevision: check.currentRevision,
            affectedPluginIds: ids, updateAvailable: false, error: `更新检查快照失效：${String(error)}` })
        }
      }
      return checks.sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    })
  }

  async list(): Promise<PluginListEntry[]> {
    return await this.withManagedRepository( async () => {
      const entries: PluginListEntry[] = []
      for (const pluginId of await listPluginIds(this.layout)) {
        try {
          const record = await this.repository.readCurrentRecord(pluginId)
          const plugin = record.scan.plugin
          let runtimeError: string | undefined
          try { await this.synchronizeRuntime(record) } catch (error) {
            if (!(error instanceof RuntimeSynchronizationError)) throw error
            runtimeError = error.message
          }
          const diagnostics = runtimeError === undefined ? plugin.diagnostics : [...plugin.diagnostics, {
            level: 'error' as const, code: 'PLUGIN_RUNTIME_SYNC_FAILED', capability: 'plugin' as const, message: runtimeError,
          }]
          const snapshot = this.runtimeSnapshot(pluginId, record.state.enabled)
          entries.push({
            id: plugin.id,
            name: plugin.name,
            ...(plugin.version === undefined ? {} : { version: plugin.version }),
            sourceId: record.install.sourceId,
            enabled: record.state.enabled,
            priority: record.state.priority,
            runtimeStatus: runtimeError !== undefined ? 'failed'
              : record.state.enabled && this.runtime === undefined ? 'pending-restart' : snapshot.status,
            formats: plugin.formats,
            skills: plugin.skills.length,
            mcpServers: plugin.mcpServers.length,
            hooks: plugin.hooks.length,
            errors: uniqueDiagnostics(diagnostics).filter(item => item.level === 'error').length,
            warnings: uniqueDiagnostics(diagnostics).filter(item => item.level === 'warning').length,
            diagnostics: uniqueDiagnostics(diagnostics).flatMap((item) => {
              if (item.level === 'info') return []
              return [{
                level: item.level,
                code: item.code,
                capability: item.capability,
                message: item.message,
                ...(item.file === undefined ? {} : { file: item.file }),
                ...(item.details === undefined ? {} : { details: item.details }),
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
    const record = await this.readAndSynchronizeRecord(pluginId)
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
          const record = await this.readAndSynchronizeRecord(pluginId)
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
          if (this.runtime !== undefined) {
            await this.runtime.stop(plugin.id)
            this.runtime.noteFailure(plugin.id, '插件存在兼容 error，已阻止自动启用')
          }
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

export * from './types.js'
export * from './errors.js'
