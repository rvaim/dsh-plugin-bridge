import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  type InstallOptions,
  type InstallPreparation,
  type InstallResult,
  type PluginInstallResult,
  type PluginListEntry,
} from '../manager/manager.js'
import type { CompatService } from '../service.js'
import type { CompatSourcePlugin } from '../types/source.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
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
} from '../types/web.js'

type CompatAdminTarget = Pick<
  CompatService,
  'checkUpdates' | 'disable' | 'enable' | 'install' | 'list' | 'prepareInstall' | 'sourceRemove' | 'uninstall' | 'update'
>

interface PendingAdd {
  preparation: InstallPreparation
  cleanupSource: boolean
  timer: ReturnType<typeof setTimeout>
}

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
  private readonly pendingAdds = new Map<string, PendingAdd>()

  constructor(
    private readonly compat: CompatAdminTarget,
    private readonly requestTtlMs = ADD_REQUEST_TTL_MS,
  ) {}

  /** 读取当前 profile 中由 dsh-compat 管理的插件。 */
  async list(): Promise<CompatWebListResult> {
    try {
      return { kind: 'ready', plugins: (await this.compat.list()).map(webPlugin) }
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

  /** 更新一个兼容插件；共享 Source 需要调用方确认。 */
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

  /** 拉取并固定一次来源；单插件直接安装，多插件返回一次性选择请求。 */
  async beginAdd(source: string): Promise<CompatWebAddResult> {
    let preparation: InstallPreparation | undefined
    try {
      preparation = await this.compat.prepareInstall(source)
      if (preparation.plugins.length === 0) {
        throw new Error(`Source ${preparation.sourceId} 没有可定位的插件`)
      }
      if (preparation.plugins.length === 1) {
        const installed = await this.compat.install(preparation.sourceId, {
          plugins: [preparation.plugins[0].id],
        })
        return this.installedResult(installed)
      }

      const requestId = randomUUID()
      const timer = setTimeout(() => { void this.cancelAdd(requestId) }, this.requestTtlMs)
      timer.unref?.()
      this.pendingAdds.set(requestId, {
        preparation,
        cleanupSource: preparation.sourceCreated,
        timer,
      })
      return {
        kind: 'selection',
        requestId,
        candidates: preparation.plugins.map(webCandidate),
      }
    } catch (error) {
      if (preparation?.sourceCreated === true) {
        try {
          await this.compat.sourceRemove(preparation.sourceId)
        } catch (cleanupError) {
          return {
            kind: 'error',
            message: `${messageOf(error)}；临时 Source 清理失败：${messageOf(cleanupError)}`,
          }
        }
      }
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 使用 beginAdd 返回的同一份 Source 快照安装所选插件。 */
  async completeAdd(requestId: string, plugins: string[]): Promise<CompatWebAddResult> {
    if (plugins.length === 0) return { kind: 'error', message: '请至少选择一个可安装插件' }
    const pending = this.pendingAdds.get(requestId)
    if (pending === undefined) return { kind: 'error', message: '该添加请求已过期，请重新拉取来源' }
    try {
      const options: InstallOptions = { plugins }
      const installed = await this.compat.install(pending.preparation.sourceId, options)
      for (const request of this.pendingAdds.values()) {
        if (request.preparation.sourceId === pending.preparation.sourceId) request.cleanupSource = false
      }
      this.finishRequest(requestId)
      return this.installedResult(installed)
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 放弃多插件选择并回收本次新建、尚未被引用的隐式 Source。 */
  async cancelAdd(requestId: string): Promise<CompatWebCancelAddResult> {
    const pending = this.pendingAdds.get(requestId)
    if (pending === undefined) return { kind: 'cancelled' }
    const sibling = [...this.pendingAdds.entries()].find(([id, request]) =>
      id !== requestId && request.preparation.sourceId === pending.preparation.sourceId)
    if (sibling !== undefined) {
      if (pending.cleanupSource) sibling[1].cleanupSource = true
      this.finishRequest(requestId)
      return { kind: 'cancelled' }
    }
    if (!pending.cleanupSource) {
      this.finishRequest(requestId)
      return { kind: 'cancelled' }
    }
    try {
      await this.compat.sourceRemove(pending.preparation.sourceId)
      this.finishRequest(requestId)
      return { kind: 'cancelled' }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** 清理由已关闭浏览器页面遗留的选择请求。 */
  async dispose(): Promise<void> {
    const requestIds = [...this.pendingAdds.keys()]
    await Promise.allSettled(requestIds.map(requestId => this.cancelAdd(requestId)))
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

  /** 停止当前运行实例并卸载一个兼容插件。 */
  async uninstall(pluginId: string): Promise<CompatWebUninstallResult> {
    try {
      await this.compat.uninstall(pluginId)
      return { kind: 'removed', pluginId }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  private installedResult(result: InstallResult): CompatWebAddResult {
    return { kind: 'installed', plugins: result.plugins.map(webInstalledPlugin) }
  }

  private finishRequest(requestId: string): void {
    const pending = this.pendingAdds.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingAdds.delete(requestId)
  }
}

/** 受 Typert 严格 schema 校验的 dsh-compat Web 管理 RPC。 */
export class CompatWebGateway extends TypertRemoteService {
  private readonly operations: CompatWebOperations

  constructor(ctx: Context) {
    super(ctx, 'compatAdmin')
    this.operations = new CompatWebOperations(ctx.compat)
  }

  /** @returns 当前兼容插件列表或可展示错误。 */
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
   * @param pluginId - dsh-compat 管理 ID。
   * @param confirmShared - 共享 Source 是否确认整体更新。
   * @returns 更新后的插件列表或可展示错误。
   */
  @Remote('update')
  update(pluginId: string, confirmShared: boolean): Promise<CompatWebUpdateResult> {
    return this.operations.update(pluginId, confirmShared)
  }

  /** @param source - Git URL、github 简写、本地目录或归档位置。 */
  @Remote('beginAdd')
  beginAdd(source: string): Promise<CompatWebAddResult> {
    return this.operations.beginAdd(source)
  }

  /**
   * @param requestId - beginAdd 返回的一次性请求 ID。
   * @param plugins - 多插件来源中明确选中的候选 ID。
   */
  @Remote('completeAdd')
  completeAdd(requestId: string, plugins: string[]): Promise<CompatWebAddResult> {
    return this.operations.completeAdd(requestId, plugins)
  }

  /** @param requestId - 需要放弃并清理的添加请求 ID。 */
  @Remote('cancelAdd')
  cancelAdd(requestId: string): Promise<CompatWebCancelAddResult> {
    return this.operations.cancelAdd(requestId)
  }

  /**
   * @param pluginId - dsh-compat 管理 ID。
   * @param enabled - 目标启用状态。
   * @returns 收敛后的插件记录或可展示错误。
   */
  @Remote('setEnabled')
  setEnabled(pluginId: string, enabled: boolean): Promise<CompatWebSetEnabledResult> {
    return this.operations.setEnabled(pluginId, enabled)
  }

  /**
   * @param pluginId - dsh-compat 管理 ID。
   * @returns 已删除 ID 或可展示错误。
   */
  @Remote('uninstall')
  uninstall(pluginId: string): Promise<CompatWebUninstallResult> {
    return this.operations.uninstall(pluginId)
  }

  dispose(): Promise<void> {
    return this.operations.dispose()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compatAdmin: CompatWebGateway
  }
}
