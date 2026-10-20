import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CompatParserEngine } from '../parser/contracts.js'
import { withAdditionalDiagnostics } from '../parser/model.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../types/catalog.js'
import { normalizeManagementId } from '../shared/id.js'
import { validateSourceDirectory } from '../shared/source-path.js'
import { copyPluginDirectory } from '../source/directory.js'
import { pathExists } from '../source/filesystem.js'
import { resolveInstallSource } from '../source/resolver.js'
import { CompatLayout, isStorageId } from '../store/layout.js'
import { withPluginLock, withPluginLocks, withRepositoryLock, withSourceLock } from '../store/lock.js'
import { listPluginIds, listSourceIds, readInstalledPlugin, readInstalledSource, scanPluginSourceReferences, writeInstalledPlugin, writeInstalledSource } from '../store/metadata.js'
import { writeJsonAtomic } from '../store/json.js'
import { commitDirectory, createTransactionDir, removeDirectoryTransactionally } from '../store/transaction.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import type { CompatPlugin, InstallMetadata, InstalledPluginRecord } from '../types/plugin.js'
import type { PluginRuntimeSnapshot } from '../types/runtime.js'
import type { InstalledSourceRecord, ResolvedInstallSource, SourceMetadata, SourceOwnership } from '../types/source.js'
import type { CompatRuntimeManager } from '../runtime/manager.js'
import { acquireSource, cleanAcquisition, materializeExternalPlugin } from './acquire.js'
import { findCapabilityConflicts, findCapabilityConflictsWithin, stripConflictDiagnostics } from './conflicts.js'
import { CompatibilityError, SharedSourceUpdateError } from './errors.js'
import { candidateBySelector, candidateWantsEnable, compareInstalledPriority, externalDirectoryName, hasNonConflictErrors, latestRevisionFor, resolvedFromStored, runtimeDisabled, stateOf } from './helpers.js'
import { CompatRepository } from './repository.js'
import { updateSourceUnlocked } from './source-update.js'
import type { InstallOptions, InstallPreparation, InstallResult, ParsedInstallCandidate, PluginInspection, PluginInstallResult, PluginListEntry, PreparedPlugin, SourceAddOptions, SourceInspection, SourceListEntry, SourceUpdateCheck, SourceUpdateOptions, SourceUpdateResult, UpdateOptions } from './types.js'
import { createPluginScan, createSourceScan, resolveInstalledPluginPackageRoot } from './plugin-loader.js'

export class CompatManager {
  constructor(
    readonly layout: CompatLayout,
    readonly runtime: CompatRuntimeManager | undefined,
    readonly parsers: CompatParserEngine,
  ) {
    this.repository = new CompatRepository(layout, parsers, async record => {
      if (this.runtime === undefined) return
      const status = this.runtime.get(record.install.pluginId).status
      if (status !== 'running' && status !== 'degraded' && status !== 'starting') return
      if (hasErrorDiagnostics(record.scan.plugin.diagnostics)) {
        await this.runtime.stop(record.install.pluginId)
        this.runtime.noteFailure(record.install.pluginId, '插件存在兼容 error，已阻止运行；启用意愿已保留')
      } else if (record.state.enabled) {
        const packageRoot = await resolveInstalledPluginPackageRoot(this.layout, record.install)
        const unchanged = this.runtime.isCurrent(record.scan.plugin, packageRoot)
        if (!unchanged) await this.runtime.start(record.scan.plugin, packageRoot)
      } else {
        await this.runtime.stop(record.install.pluginId)
      }
    })
  }

  private readonly repository: CompatRepository

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

  private async parseAndCheck(
    packageRoot: string,
    sourceId: string,
    sourcePluginId: string,
    suggestedId: string | undefined,
    asId: string | undefined,
    excludePluginIds: readonly string[] = [],
    candidate?: SourcePluginCandidate,
  ): Promise<CompatPlugin> {
    const parsed = stripConflictDiagnostics(await this.parsers.parsePlugin(packageRoot, {
      sourceId,
      sourcePluginId,
      ...(suggestedId === undefined ? {} : { suggestedId }),
      ...(asId === undefined ? {} : { asId }),
      ...(candidate?.displayName === undefined ? {} : { displayName: candidate.displayName }),
      ...(candidate === undefined ? {} : { marketplaceDefinitions: candidate.definitions }),
    }))
    const conflicts = await findCapabilityConflicts(this.layout, parsed, excludePluginIds, this.parsers)
    return withAdditionalDiagnostics(parsed, conflicts)
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
        scan: createPluginScan(plugin, sourceRevision, this.parsers),
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
        item.scan = createPluginScan(item.plugin, sourceRevision, this.parsers)
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
    const discovery = await this.parsers.parseSource(acquired.acquiredRoot, {
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
    options: SourceAddOptions,
    ownership: SourceOwnership,
  ): Promise<{ source: SourceInspection; created: boolean }> {
    const resolved = await resolveInstallSource(input, options.cwd)
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
        if (ownership === 'explicit' && existing.source.ownership === 'implicit') {
          await writeJsonAtomic(this.layout.sourceFile(existing.source.id), {
            ...existing.source,
            ownership: 'explicit' as const,
          })
        }
        return await this.repository.inspectSourceUnlocked(existing.source.id)
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
        return await this.repository.inspectSourceUnlocked(created.sourceId)
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
              source: await this.repository.inspectSourceUnlocked(sourceId),
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
      preparePluginContent: this.preparePluginContent.bind(this),
      parseAndCheck: this.parseAndCheck.bind(this),
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

  /** 探测每个已安装 Plugin 的 Source 远端/本地来源是否有新 revision。 */
  async checkUpdates(): Promise<SourceUpdateCheck[]> {
    return await this.withManagedRepository( async () => {
      const referenceScan = await scanPluginSourceReferences(this.layout)
      const checks: SourceUpdateCheck[] = []
      for (const sourceId of await listSourceIds(this.layout)) {
        const affectedPluginIds = referenceScan.references
          .filter(item => item.sourceId === sourceId)
          .map(item => item.pluginId)
          .sort()
        if (affectedPluginIds.length === 0) continue

        try {
          const record = await readInstalledSource(this.layout, sourceId)
          const currentRevision = record.source.revision
          const latestRevision = await latestRevisionFor(resolvedFromStored(record.source.origin))
          checks.push({
            sourceId,
            currentRevision,
            latestRevision,
            updateAvailable: latestRevision !== currentRevision,
            affectedPluginIds,
          })
        } catch (error) {
          checks.push({
            sourceId,
            updateAvailable: false,
            currentRevision: '',
            affectedPluginIds,
            error: error instanceof Error ? error.message : String(error),
          })
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
    const record = await this.repository.readCurrentRecord(pluginId)
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
          const record = await this.repository.readCurrentRecord(pluginId)
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
