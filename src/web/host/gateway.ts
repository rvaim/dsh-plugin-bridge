import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  type InstallPreparation,
  type InstallCompletion,
  type PluginInstallSelection,
  type PluginInstallResult,
  type PluginListEntry,
} from '../../manager/manager.js'
import type { CompatService } from '../../service.js'
import type { CompatSourcePlugin } from '../../types/source.js'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import type {
  CompatWebAddResult,
  CompatWebCancelAddResult,
  CompatWebCandidate,
  CompatWebCheckUpdatesResult,
  CompatWebDiagnostic,
  CompatWebListResult,
  CompatWebPlugin,
  CompatWebSetEnabledResult,
  CompatWebUninstallResult,
  CompatWebUpdateInfo,
  CompatWebUpdateResult,
} from '../../types/web.js'

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { ArchiveUploads } from './archive-uploads.js'
import { PLUGIN_ARCHIVE_UPLOAD_PATH } from '../../types/upload.js'
import { InstallRequests } from './install-requests.js'

type CompatAdminTarget = Pick<
  CompatService,
  'checkUpdates' | 'completeInstallPreparation' | 'disable' | 'enable' | 'list' | 'listCategories' | 'prepareArchiveInstall' | 'prepareInstall' | 'releaseInstallPreparation' | 'uninstall' | 'update'
>

const ADD_REQUEST_TTL_MS = 10 * 60 * 1000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function webDiagnostics(items: readonly CompatDiagnostic[]): CompatWebDiagnostic[] {
  return items.flatMap((item) => {
    if (item.level === 'info') return []
    return [{
      level: item.level,
      code: item.code,
      capability: item.capability,
      message: item.message,
      ...(item.file === undefined ? {} : { file: item.file }),
      ...(item.details === undefined ? {} : { details: JSON.stringify(item.details, null, 2) }),
    }]
  })
}

function webPlugin(entry: PluginListEntry): CompatWebPlugin {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.version === undefined ? {} : { version: entry.version }),
    sourceId: entry.sourceId,
    enabled: entry.enabled,
    priority: entry.priority,
    runtimeStatus: entry.runtimeStatus,
    formats: [...entry.formats],
    skills: entry.skills,
    mcpServers: entry.mcpServers,
    hooks: entry.hooks,
    errors: entry.errors,
    warnings: entry.warnings,
    diagnostics: webDiagnostics(entry.diagnostics),
  }
}

function candidateSource(location: CompatSourcePlugin['location']): string {
  switch (location.type) {
    case 'source-path': return location.path === '.' ? './' : `./${location.path}`
    case 'git':
    case 'git-subdir': {
      const revision = location.sha ?? location.ref
      const selector = revision === undefined ? '' : `#${revision}`
      return `${location.url}${selector}${location.type === 'git-subdir' ? `:${location.path}` : ''}`
    }
    case 'npm': return `${location.package}${location.version ? `@${location.version}` : ''}`
    case 'archive': return location.url
    case 'unsupported': return location.sourceType
  }
}

function webCandidate(candidate: CompatSourcePlugin): CompatWebCandidate {
  return {
    id: candidate.id,
    name: candidate.name,
    ...(candidate.displayName === undefined ? {} : { displayName: candidate.displayName }),
    ...(candidate.description === undefined ? {} : { description: candidate.description }),
    ...(candidate.version === undefined ? {} : { version: candidate.version }),
    formats: [...candidate.formats],
    installable: candidate.installable,
    errors: candidate.diagnostics.filter(item => item.level === 'error').length,
    warnings: candidate.diagnostics.filter(item => item.level === 'warning').length,
    source: candidateSource(candidate.location),
    diagnostics: webDiagnostics(candidate.diagnostics),
  }
}

function webInstalledPlugin(item: PluginInstallResult): CompatWebPlugin {
  const runtimeStatus = item.enabled && item.runtime.status === 'disabled'
    ? 'pending-restart'
    : item.runtime.status
  return {
    id: item.plugin.id,
    name: item.plugin.name,
    ...(item.plugin.version === undefined ? {} : { version: item.plugin.version }),
    sourceId: item.plugin.sourceId,
    enabled: item.enabled,
    priority: 0,
    runtimeStatus,
    formats: [...item.plugin.formats],
    skills: item.plugin.skills.length,
    mcpServers: item.plugin.mcpServers.length,
    hooks: item.plugin.hooks.length,
    errors: item.plugin.diagnostics.filter(diagnostic => diagnostic.level === 'error').length,
    warnings: item.plugin.diagnostics.filter(diagnostic => diagnostic.level === 'warning').length,
    diagnostics: webDiagnostics(item.plugin.diagnostics),
  }
}

/** 把现有 CompatService 生命周期映射为 Web 管理页面需要的窄接口。 */
export class CompatWebOperations {
  private readonly installRequests: InstallRequests

  constructor(private readonly compat: CompatAdminTarget, requestTtlMs = ADD_REQUEST_TTL_MS) {
    this.installRequests = new InstallRequests(compat, requestTtlMs)
  }

  /** 读取当前 profile 中由 plugin-bridge 管理的插件。 */
  async list(): Promise<CompatWebListResult> {
    try {
      const plugins = (await this.compat.list()).map(webPlugin)
      return { kind: 'ready', plugins, categories: this.compat.listCategories() }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 探测每个已安装插件所属 Source 是否有新 revision。 */
  async checkUpdates(): Promise<CompatWebCheckUpdatesResult> {
    try {
      const checks = await this.compat.checkUpdates()
      const updates: CompatWebUpdateInfo[] = checks.flatMap(source =>
        source.affectedPluginIds.map(pluginId => ({
          pluginId,
          sourceId: source.sourceId,
          available: source.updateAvailable,
          sharedSource: source.affectedPluginIds.length > 1,
          affectedPluginIds: source.affectedPluginIds,
          ...(source.error === undefined ? {} : { error: source.error }),
        })))
      return { kind: 'ready', updates, checkedAt: new Date().toISOString() }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 更新一个外部插件；共享 Source 需要调用方确认。 */
  async update(pluginId: string, confirmShared: boolean): Promise<CompatWebUpdateResult> {
    try {
      await this.compat.update(pluginId, { confirmShared })
      const plugins = (await this.compat.list()).map(webPlugin)
      const updated = plugins.find(item => item.id === pluginId)
      if (updated === undefined) throw new Error(`插件 ${pluginId} 更新后未出现在列表中`)
      const affectedPluginIds = plugins
        .filter(item => item.sourceId === updated.sourceId)
        .map(item => item.id)
        .sort()
      return { kind: 'updated', plugins, affectedPluginIds }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 拉取并固定一次来源；仅独立单插件可直接安装，市场始终返回选择请求。 */
  async beginAdd(source: string, signal: AbortSignal = new AbortController().signal): Promise<CompatWebAddResult> {
    let preparation: InstallPreparation | undefined
    try {
      signal.throwIfAborted()
      preparation = await this.installRequests.prepare(source, signal)
      if (preparation.plugins.length === 0) {
        throw new Error(`Source ${preparation.sourceId} 没有可定位的插件`)
      }
      signal.throwIfAborted()
      const only = preparation.plugins[0]
      if (!preparation.selectionRequired && preparation.plugins.length === 1 && only.installable) {
        const installed = await this.installRequests.complete(preparation.preparationId, [{ pluginId: only.id }], signal)
        return this.completionResult(preparation.preparationId, installed)
      }
      return {
        kind: 'selection',
        requestId: preparation.preparationId,
        selectionRequired: preparation.selectionRequired,
        candidates: preparation.plugins.map(webCandidate),
      }
    } catch (error) {
      if (preparation !== undefined) {
        try {
          await this.installRequests.cancel(preparation.preparationId)
        } catch (cleanupError) {
          return {
            kind: 'error',
            message: `${messageOf(error)}；安装准备释放失败：${messageOf(cleanupError)}`,
          }
        }
      }
      return { kind: 'error', message: signal.aborted ? '添加已取消' : messageOf(error) }
    }
  }

  /** Binary intake prepares only; the browser confirms/continues installation after transfer ends. */
  async prepareArchive(source: string, signal: AbortSignal): Promise<CompatWebAddResult> {
    let preparation: InstallPreparation | undefined
    try {
      signal.throwIfAborted()
      preparation = await this.installRequests.prepare(source, signal, (path, options) => this.compat.prepareArchiveInstall(path, options.signal))
      signal.throwIfAborted()
      if (preparation.plugins.length === 0) throw new Error('上传归档中没有可定位的插件')
      return { kind: 'selection', requestId: preparation.preparationId, selectionRequired: preparation.selectionRequired, candidates: preparation.plugins.map(webCandidate) }
    } catch (error) {
      if (preparation !== undefined) await this.installRequests.cancel(preparation.preparationId)
      return { kind: 'error', message: signal.aborted ? '文件上传已取消' : messageOf(error) }
    }
  }

  /** 使用 beginAdd 返回的同一份 Source 快照安装所选插件；失败后可重试。 */
  async completeAdd(requestId: string, plugins: PluginInstallSelection[], signal: AbortSignal = new AbortController().signal): Promise<CompatWebAddResult> {
    if (plugins.length === 0) return { kind: 'error', message: '请至少选择一个可安装插件' }
    try {
      return this.completionResult(requestId, await this.installRequests.complete(requestId, plugins, signal))
    } catch (error) {
      return { kind: 'error', message: signal.aborted ? '安装已取消' : messageOf(error) }
    }
  }

  /** 放弃多插件选择，由 manager 释放准备会话并判断 Source 是否可回收。 */
  async cancelAdd(requestId: string): Promise<CompatWebCancelAddResult> {
    try {
      await this.installRequests.cancel(requestId)
      return { kind: 'cancelled' }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 等待正在准备或安装的请求，再释放所有未完成会话；释放失败会报告给宿主。 */
  dispose(): Promise<void> {
    return this.installRequests.dispose()
  }

  /** 在当前进程中启用或停用一个插件并返回收敛后的列表记录。 */
  async setEnabled(pluginId: string, enabled: boolean): Promise<CompatWebSetEnabledResult> {
    try {
      if (enabled) await this.compat.enable(pluginId)
      else await this.compat.disable(pluginId)
      const plugin = (await this.compat.list()).find(item => item.id === pluginId)
      if (plugin === undefined) throw new Error(`插件 ${pluginId} 操作完成后未出现在列表中`)
      return { kind: 'updated', plugin: webPlugin(plugin) }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 停止当前运行实例并卸载一个外部插件。 */
  async uninstall(pluginId: string): Promise<CompatWebUninstallResult> {
    try {
      await this.compat.uninstall(pluginId)
      return { kind: 'removed', pluginId }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  private completionResult(requestId: string, completion: InstallCompletion): CompatWebAddResult {
    if (completion.kind === 'installed') {
      return { kind: 'installed', plugins: completion.result.plugins.map(webInstalledPlugin) }
    }
    return {
      kind: 'parser-selection',
      requestId,
      plugins: completion.plugins.map(plugin => ({
        pluginId: plugin.pluginId,
        name: plugin.name,
        matches: plugin.matches.map(match => ({
          parserId: match.parserId,
          label: { ...match.label },
          available: match.available,
          evidence: match.evidence.map(item => ({ ...item })),
          diagnostics: webDiagnostics(match.diagnostics),
        })),
      })),
    }
  }
}

/** 受 Typert 严格 schema 校验的 plugin-bridge Web 管理 RPC。 */
export class CompatWebGateway extends TypertRemoteService {
  private readonly operations: CompatWebOperations
  private readonly uploads = new ArchiveUploads()

  constructor(ctx: Context) {
    super(ctx, 'pluginBridgeAdmin')
    this.operations = new CompatWebOperations(ctx.pluginBridge)
    ctx.inject(['connection'], child => {
      const route: ConnectionFetchRoute = {
        path: PLUGIN_ARCHIVE_UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: request => this.uploads.handle(request, (path, signal) => this.operations.prepareArchive(path, signal)),
      }
      child.connection.fetch.register(route)
    })
  }

  /** @returns 当前外部插件列表或可展示错误。 */
  @Remote('list')
  list(): Promise<CompatWebListResult> {
    return this.operations.list()
  }

  /** @returns 每个已安装插件所属 Source 的更新检查结果。 */
  @Remote('checkUpdates')
  checkUpdates(): Promise<CompatWebCheckUpdatesResult> {
    return this.operations.checkUpdates()
  }

  /**
   * @param pluginId - plugin-bridge 管理 ID。
   * @param confirmShared - 共享 Source 是否确认整体更新。
   * @returns 更新后的插件列表或可展示错误。
   */
  @Remote('update')
  update(pluginId: string, confirmShared: boolean): Promise<CompatWebUpdateResult> {
    return this.operations.update(pluginId, confirmShared)
  }

  /** @param source - Git URL、github 简写、本地目录或归档位置。 */
  @Remote('beginAdd')
  beginAdd(source: string, signal: AbortSignal): Promise<CompatWebAddResult> {
    return this.operations.beginAdd(source, signal)
  }

  /**
   * @param requestId - beginAdd 返回的一次性请求 ID。
   * @param plugins - 完整的插件选择及可选解析器 ID。
   */
  @Remote('completeAdd')
  completeAdd(requestId: string, plugins: PluginInstallSelection[], signal: AbortSignal): Promise<CompatWebAddResult> {
    return this.operations.completeAdd(requestId, plugins, signal)
  }

  /** @param requestId - 需要放弃并清理的添加请求 ID。 */
  @Remote('cancelAdd')
  cancelAdd(requestId: string): Promise<CompatWebCancelAddResult> {
    return this.operations.cancelAdd(requestId)
  }

  /**
   * @param pluginId - plugin-bridge 管理 ID。
   * @param enabled - 目标启用状态。
   * @returns 收敛后的插件记录或可展示错误。
   */
  @Remote('setEnabled')
  setEnabled(pluginId: string, enabled: boolean): Promise<CompatWebSetEnabledResult> {
    return this.operations.setEnabled(pluginId, enabled)
  }

  /**
   * @param pluginId - plugin-bridge 管理 ID。
   * @returns 已删除 ID 或可展示错误。
   */
  @Remote('uninstall')
  uninstall(pluginId: string): Promise<CompatWebUninstallResult> {
    return this.operations.uninstall(pluginId)
  }

  async dispose(): Promise<void> {
    await this.uploads.dispose()
    await this.operations.dispose()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginBridgeAdmin: CompatWebGateway
  }
}
