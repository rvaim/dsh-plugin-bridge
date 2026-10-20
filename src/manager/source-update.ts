import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompatParserEngine } from '../parser/contracts.js'
import { withAdditionalDiagnostics } from '../parser/model.js'
import type { SourcePluginCandidate } from '../types/catalog.js'
import { createPluginScan, createSourceScan, loadInstalledPluginForRuntime, resolveInstalledPluginPackageRoot } from './plugin-loader.js'
import type { CompatRuntimeManager } from '../runtime/manager.js'
import { copyPluginDirectory } from '../source/directory.js'
import { pathExists } from '../source/filesystem.js'
import { resolveInstallSource } from '../source/resolver.js'
import type { CompatLayout } from '../store/layout.js'
import { writeJsonAtomic } from '../store/json.js'
import { writeInstalledSource } from '../store/metadata.js'
import { commitDirectory, createTransactionDir } from '../store/transaction.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import type { CompatPlugin, InstallMetadata, InstalledPluginRecord, ScanCache } from '../types/plugin.js'
import type { SourceMetadata } from '../types/source.js'
import { acquireSource, cleanAcquisition } from './acquire.js'
import { findCapabilityConflictsWithin } from './conflicts.js'
import { CompatibilityError } from './errors.js'
import { compareInstalledPriority, externalDirectoryName, hasNonConflictErrors, resolvedFromStored } from './helpers.js'
import type { CompatRepository } from './repository.js'
import type { PluginInspection, PreparedPlugin, SourceUpdateOptions, SourceUpdateResult } from './types.js'

export interface SourceUpdateHost {
  layout: CompatLayout
  runtime?: CompatRuntimeManager
  parsers: CompatParserEngine
  repository: CompatRepository
  preparePluginContent(sourceRoot: string, candidate: SourcePluginCandidate, transactionRoot: string): Promise<PreparedPlugin>
  parseAndCheck(packageRoot: string, sourceId: string, sourcePluginId: string, suggestedId: string | undefined, asId: string | undefined, excluded: readonly string[], candidate?: SourcePluginCandidate): Promise<CompatPlugin>
  inspectPlugin(pluginId: string): Promise<PluginInspection>
}

export async function updateSourceUnlocked(
  host: SourceUpdateHost,
  sourceId: string,
  options: SourceUpdateOptions,
): Promise<SourceUpdateResult> {
  const oldSource = await host.repository.readCurrentSourceRecord(sourceId)
  const stored = await host.repository.readSourcePluginRecordsStrict(sourceId)
  const installed = await Promise.all(stored.map(record => host.repository.readCurrentRecord(record.install.pluginId)))
  const pluginIds = installed.map(item => item.install.pluginId).sort()
  const resolved = options.source === undefined
    ? resolvedFromStored(oldSource.source.origin)
    : await resolveInstallSource(options.source, options.cwd)
  const transaction = await createTransactionDir(host.layout, `source-update-${sourceId}`)
  const stagedSource = join(transaction, 'new-source')
  const stagedExternal = join(transaction, 'new-external')
  const backupSource = join(transaction, 'backup-source')
  const backupExternal = join(transaction, 'backup-external')
  const officialSource = host.layout.sourceRoot(sourceId)
  const officialExternal = host.layout.sourceExternalRoot(sourceId)
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
    const discovery = await host.parsers.parseSource(acquired.acquiredRoot, {
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
        const unavailable = discovery.scan.diagnostics.filter(item => item.code === 'PARSER_UNAVAILABLE')
        if (unavailable.length > 0) {
          throw new CompatibilityError(`Source 更新后无法解析已安装插件 ${old.install.sourcePluginId}；拒绝更新`, unavailable)
        }
        throw new Error(`Source 更新后已安装插件 ${old.install.sourcePluginId} 消失；拒绝更新`)
      }
      if (!candidate.installable || hasErrorDiagnostics(candidate.diagnostics)) {
        throw new CompatibilityError(`Source 更新后插件 ${candidate.id} 的位置无效`, candidate.diagnostics)
      }

      // Source 更新必须重新获取 Marketplace 外部 Git 内容，不能复用正式缓存，
      // 否则 Source 元数据与外部 Plugin 可能落在不同版本。
      const prepared = await host.preparePluginContent(stagedSource, candidate, transaction)
      let plugin = await host.parseAndCheck(
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
        scan: createPluginScan(plugin, acquired.revision, host.parsers),
      })
    }

    const within = findCapabilityConflictsWithin(
      newPlugins.filter(item => item.old.state.enabled).map(item => item.plugin),
    )
    for (const item of newPlugins) {
      const extra = within.get(item.plugin.id) ?? []
      if (extra.length > 0) {
        item.plugin = withAdditionalDiagnostics(item.plugin, extra)
        item.scan = createPluginScan(item.plugin, acquired.revision, host.parsers)
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
    await writeInstalledSource(stagedSource, newSourceMetadata, createSourceScan(discovery.scan, newSourceMetadata.revision, host.parsers))

    for (const item of installed
      .filter(entry => entry.state.enabled)
      .sort(compareInstalledPriority)) {
      if (host.runtime !== undefined) {
        await host.runtime.stop(item.install.pluginId)
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
        writeJsonAtomic(host.layout.installFile(item.install.pluginId), item.install),
        writeJsonAtomic(host.layout.scanFile(item.install.pluginId), item.scan),
        rm(host.layout.cacheDir(item.install.pluginId), { recursive: true, force: true })
          .then(() => mkdir(host.layout.cacheDir(item.install.pluginId), { recursive: true, mode: 0o700 })),
      ])
    }

    for (const item of newPlugins
      .filter(entry => entry.old.state.enabled)
      .sort((left, right) => left.old.state.priority - right.old.state.priority
        || left.install.pluginId.localeCompare(right.install.pluginId))) {
      if (host.runtime === undefined) continue
      attemptedNewPluginIds.add(item.install.pluginId)
      const runtime = await host.runtime.start(
        item.plugin,
        await resolveInstalledPluginPackageRoot(host.layout, item.install),
      )
      if (runtime.status !== 'running' && runtime.status !== 'degraded') {
        throw new Error(`新版插件 ${item.plugin.id} 运行实例启动失败：${runtime.error ?? '未知错误'}`)
      }
    }

    return {
      source: await host.repository.inspectSourceUnlocked(sourceId),
      plugins: await Promise.all(pluginIds.map(pluginId => host.inspectPlugin(pluginId))),
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
      if (host.runtime !== undefined) {
        const stopFailures: unknown[] = []
        for (const pluginId of attemptedNewPluginIds) {
          try {
            await host.runtime.stop(pluginId)
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
            writeJsonAtomic(host.layout.installFile(record.install.pluginId), record.install),
            writeJsonAtomic(host.layout.scanFile(record.install.pluginId), record.scan),
            writeJsonAtomic(host.layout.stateFile(record.install.pluginId), record.state),
          ])
        }
        recordsMayHaveChanged = false
      }

      if (host.runtime !== undefined) {
        for (const record of installed
          .filter(item => item.state.enabled && stoppedOldPluginIds.has(item.install.pluginId))
          .sort(compareInstalledPriority)) {
          const current = await loadInstalledPluginForRuntime(host.layout, record.install.pluginId, host.parsers)
          if (hasErrorDiagnostics(current.scan.plugin.diagnostics)) {
            host.runtime.noteFailure(record.install.pluginId, '旧插件存在兼容 error，已阻止回滚后自动启用')
            continue
          }
          const restored = await host.runtime.start(
            current.scan.plugin,
            await resolveInstalledPluginPackageRoot(host.layout, current.install),
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
