import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { findCapabilityConflicts, stripConflictDiagnostics } from './conflicts.js'
import { PARSER_VERSION, parseCompatPlugin, withAdditionalDiagnostics } from '../parser/normalize.js'
import { parseCompatSource, validateSourceDirectory } from '../parser/source/index.js'
import type { SourcePluginCandidate } from '../parser/source/types.js'
import { normalizeManagementId } from '../parser/shared/id.js'
import { copyPluginDirectory } from '../source/directory.js'
import { hashDirectory } from '../source/snapshot.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import type { CompatPlugin, InstallMetadata, PluginState, ScanCache } from '../types/plugin.js'
import type { InstallSource, SourceMetadata } from '../types/source.js'
import { readJsonFile } from '../store/json.js'
import type { CompatLayout } from '../store/layout.js'
import { readInstalledPlugin, readInstalledSource, writeInstalledPlugin, writeInstalledSource } from '../store/metadata.js'
import { commitDirectory, createTransactionDir, removeDirectoryTransactionally } from '../store/transaction.js'
import { cleanAcquisition } from './acquire.js'

interface LegacyInstallMetadata {
  schemaVersion: 1
  id: string
  source: InstallSource
  installedAt: string
  updatedAt?: string
}

interface LegacyScanCache {
  plugin?: {
    id?: string
    name?: string
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function legacyPluginDirectories(layout: CompatLayout): Promise<string[]> {
  try {
    const entries = await readdir(layout.legacyPlugins, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function revisionFor(origin: InstallSource, contentHash: string): { origin: InstallSource; revision: string } {
  if (origin.type === 'git' && origin.commit !== undefined) {
    return { origin, revision: `git:${origin.commit}` }
  }
  if (origin.type === 'archive' && origin.sha256 !== undefined) {
    return { origin, revision: `archive:${origin.sha256}` }
  }
  if (origin.type === 'directory') {
    return {
      origin: { ...origin, contentHash },
      revision: `directory:${contentHash}`,
    }
  }
  // 旧版本可能没有记录不可变 Git commit 或归档 SHA。迁移不伪造这些值，
  // 仅用当前完整快照哈希使 scan.json 具备可靠失效依据。
  return { origin, revision: `legacy:${contentHash}` }
}

function selectLegacyCandidate(
  candidates: readonly SourcePluginCandidate[],
  preferredIds: readonly (string | undefined)[],
): SourcePluginCandidate {
  if (candidates.length === 1) return candidates[0]!
  const normalized = new Set<string>()
  for (const value of preferredIds) {
    if (value === undefined) continue
    try {
      normalized.add(normalizeManagementId(value, 'plugin'))
    } catch {
      // 旧字段只作为候选定位提示；非法值不应覆盖明确的 Marketplace ID。
    }
  }
  const matches = candidates.filter(candidate => normalized.has(candidate.id))
  if (matches.length === 1) return matches[0]!
  throw new Error(
    `旧安装包含 ${candidates.length} 个 Source Plugin，无法无歧义确定原安装对象；`
    + '旧目录已保留，请使用新版本显式添加 Source 并选择 Plugin',
  )
}

function scanOf(plugin: CompatPlugin, sourceRevision: string): ScanCache {
  return {
    schemaVersion: 1,
    parserVersion: PARSER_VERSION,
    sourceRevision,
    scannedAt: new Date().toISOString(),
    plugin,
  }
}

function validateLegacyState(value: PluginState, pluginId: string): PluginState {
  if (
    value?.schemaVersion !== 1
    || typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.priority)
  ) {
    throw new Error(`旧插件 ${pluginId} 的 state.json 无效；旧目录已保留`)
  }
  return value
}

async function finalizeCompletedMigration(
  layout: CompatLayout,
  legacyRoot: string,
  pluginId: string,
  sourceId: string,
): Promise<boolean> {
  if (!await exists(layout.pluginRoot(pluginId)) || !await exists(layout.sourceRoot(sourceId))) return false
  try {
    const [plugin, source] = await Promise.all([
      readInstalledPlugin(layout, pluginId),
      readInstalledSource(layout, sourceId),
    ])
    if (plugin.install.sourceId !== sourceId || source.source.id !== sourceId) return false
  } catch {
    return false
  }
  // 进程可能在两个新目录均提交后、删除旧目录前退出。此时新记录已经是
  // 完整事实真源，只需完成最后的旧目录清理，不重复解析或覆盖 data。
  await removeDirectoryTransactionally(layout, legacyRoot, `legacy-cleanup-${pluginId}`)
  return true
}

async function migrateOneLegacyPlugin(layout: CompatLayout, legacyDirectoryName: string): Promise<void> {
  const legacyRoot = join(layout.legacyPlugins, legacyDirectoryName)
  const legacyInstall = await readJsonFile<LegacyInstallMetadata>(join(legacyRoot, 'install.json'))
  if (
    legacyInstall?.schemaVersion !== 1
    || typeof legacyInstall.id !== 'string'
    || legacyInstall.source === undefined
    || typeof legacyInstall.installedAt !== 'string'
  ) {
    throw new Error(`旧插件目录 ${legacyDirectoryName} 的 install.json 无效；未执行迁移`)
  }

  const pluginId = normalizeManagementId(legacyInstall.id || legacyDirectoryName, 'plugin')
  const sourceId = normalizeManagementId(`legacy-${pluginId}`, 'source')
  if (await finalizeCompletedMigration(layout, legacyRoot, pluginId, sourceId)) return
  if (await exists(layout.pluginRoot(pluginId)) || await exists(layout.sourceRoot(sourceId))) {
    throw new Error(
      `旧插件 ${pluginId} 的迁移目标已部分存在；为避免覆盖数据，已停止迁移。`
      + `请检查 ${layout.pluginRoot(pluginId)} 与 ${layout.sourceRoot(sourceId)}`,
    )
  }

  const legacyPackage = join(legacyRoot, 'package')
  const legacyState = validateLegacyState(
    await readJsonFile<PluginState>(join(legacyRoot, 'state.json')),
    pluginId,
  )
  let legacyScan: LegacyScanCache | undefined
  try {
    legacyScan = await readJsonFile<LegacyScanCache>(join(legacyRoot, 'scan.json'))
  } catch {
    // scan.json 从来不是事实真源；迁移时始终从旧 package/ 重新解析。
  }

  const transaction = await createTransactionDir(layout, `legacy-migrate-${pluginId}`)
  const stagedSource = join(transaction, 'source')
  const stagedPlugin = join(transaction, 'installed')
  const completedLegacy = join(transaction, 'legacy-original')
  let sourceCommitted = false
  let pluginCommitted = false
  let legacyMoved = false

  try {
    await Promise.all([
      mkdir(join(stagedSource, 'package'), { recursive: true, mode: 0o700 }),
      mkdir(join(stagedSource, 'cache'), { recursive: true, mode: 0o700 }),
      mkdir(join(stagedPlugin, 'cache'), { recursive: true, mode: 0o700 }),
    ])
    await copyPluginDirectory(legacyPackage, join(stagedSource, 'package'))
    const stagedPackage = join(stagedSource, 'package')
    const contentHash = await hashDirectory(stagedPackage)
    const versioned = revisionFor(legacyInstall.source, contentHash)
    const discovery = await parseCompatSource(stagedPackage, {
      sourceId,
      suggestedPluginId: pluginId,
    })
    const candidate = selectLegacyCandidate(discovery.candidates, [
      legacyInstall.id,
      legacyScan?.plugin?.id,
      legacyScan?.plugin?.name,
      legacyDirectoryName,
    ])
    if (!candidate.installable || hasErrorDiagnostics(candidate.diagnostics)) {
      throw new Error(`旧插件 ${pluginId} 的 Source 定位存在兼容错误；未执行迁移`)
    }
    if (candidate.location.type !== 'source-path') {
      throw new Error(
        `旧插件 ${pluginId} 在 Marketplace 中指向 ${candidate.location.type}；`
        + '0.1.x 未记录独立外部内容，无法无损自动迁移',
      )
    }
    const pluginPath = await validateSourceDirectory(stagedPackage, candidate.location.path)
    let plugin = stripConflictDiagnostics(await parseCompatPlugin(
      resolve(stagedPackage, pluginPath === '.' ? '' : pluginPath),
      {
        sourceId,
        sourcePluginId: candidate.id,
        suggestedId: pluginId,
        asId: pluginId,
        ...(candidate.displayName === undefined ? {} : { displayName: candidate.displayName }),
        marketplaceDefinitions: candidate.definitions,
      },
    ))
    plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
    plugin = withAdditionalDiagnostics(plugin, await findCapabilityConflicts(layout, plugin))

    const sourceMetadata: SourceMetadata = {
      schemaVersion: 1,
      id: sourceId,
      ...(discovery.name === undefined ? {} : { name: discovery.name }),
      origin: versioned.origin,
      ownership: 'implicit',
      revision: versioned.revision,
      createdAt: legacyInstall.installedAt,
      ...(legacyInstall.updatedAt === undefined ? {} : { updatedAt: legacyInstall.updatedAt }),
    }
    const install: InstallMetadata = {
      schemaVersion: 1,
      pluginId,
      sourceId,
      sourcePluginId: candidate.id,
      pluginPath,
      location: { type: 'source-path', path: pluginPath },
      installedAt: legacyInstall.installedAt,
      ...(legacyInstall.updatedAt === undefined ? {} : { updatedAt: legacyInstall.updatedAt }),
    }
    const state: PluginState = hasErrorDiagnostics(plugin.diagnostics)
      ? { ...legacyState, enabled: false }
      : legacyState

    const legacyData = join(legacyRoot, 'data')
    if (await exists(legacyData)) {
      await cp(legacyData, join(stagedPlugin, 'data'), {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      })
    } else {
      await mkdir(join(stagedPlugin, 'data'), { recursive: true, mode: 0o700 })
    }
    await Promise.all([
      writeInstalledSource(stagedSource, sourceMetadata, discovery.scan),
      writeInstalledPlugin(stagedPlugin, install, state, scanOf(plugin, versioned.revision)),
    ])

    await commitDirectory(stagedSource, layout.sourceRoot(sourceId))
    sourceCommitted = true
    await commitDirectory(stagedPlugin, layout.pluginRoot(pluginId))
    pluginCommitted = true
    await rename(legacyRoot, completedLegacy)
    legacyMoved = true
    await rm(completedLegacy, { recursive: true, force: true })
    legacyMoved = false
  } catch (error) {
    let rollbackError: unknown
    try {
      if (pluginCommitted) await rm(layout.pluginRoot(pluginId), { recursive: true, force: true })
      if (sourceCommitted) await rm(layout.sourceRoot(sourceId), { recursive: true, force: true })
      if (legacyMoved && !await exists(legacyRoot)) await rename(completedLegacy, legacyRoot)
    } catch (restoreFailure) {
      rollbackError = restoreFailure
    }
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        `旧插件 ${pluginId} 迁移失败，且回滚未完全成功；恢复材料位于 ${transaction}`,
      )
    }
    throw error
  } finally {
    if (!legacyMoved) await cleanAcquisition(transaction)
  }
}

/**
 * 把 0.1.x 的 plugins/<pluginId>/ 单插件布局迁移到 Source/Plugin 分离模型。
 *
 * 旧模型无法可靠证明多个安装是否共享同一来源，因此迁移采用一个旧 Plugin
 * 对应一个 implicit Source 的保守策略，绝不猜测合并或删除其他旧目录。
 */
export async function migrateLegacyRepository(layout: CompatLayout): Promise<void> {
  for (const legacyDirectoryName of await legacyPluginDirectories(layout)) {
    await migrateOneLegacyPlugin(layout, legacyDirectoryName)
  }
}
