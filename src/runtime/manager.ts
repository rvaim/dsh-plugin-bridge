import { mkdir } from 'node:fs/promises'
import type { CompatLayout } from '../store/layout.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import type { CompatPlugin } from '../types/plugin.js'
import type { CapabilityRuntimeHealth, PluginRuntimeSnapshot, PluginRuntimeStatus } from '../types/runtime.js'
import type { DshContextLike, FiberLike } from './context.js'
import { defaultRuntimeDependencies, type RuntimeDependencies } from './dependencies.js'
import { createLegacyRuntimePlugin } from './plugin.js'

interface RuntimeHandle {
  fiber: FiberLike
  snapshot: PluginRuntimeSnapshot
}

export interface CompatRuntimeManagerOptions {
  workspaceRoot?: string
  hookDefaultTimeoutMs?: number
  hookStderrSummaryMaxChars?: number
  codexModel?: string
  dependencies?: RuntimeDependencies
}

export class CompatRuntimeManager {
  private readonly handles = new Map<string, RuntimeHandle>()
  private readonly snapshots = new Map<string, PluginRuntimeSnapshot>()
  private readonly dependencies: RuntimeDependencies
  private readonly workspaceRoot: string

  constructor(
    private readonly ctx: DshContextLike,
    private readonly layout: CompatLayout,
    private readonly options: CompatRuntimeManagerOptions = {},
  ) {
    this.dependencies = options.dependencies ?? defaultRuntimeDependencies
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
  }

  get(pluginId: string): PluginRuntimeSnapshot {
    return this.snapshots.get(pluginId) ?? { pluginId, status: 'disabled', capabilities: [] }
  }

  list(): PluginRuntimeSnapshot[] {
    return [...this.snapshots.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  }

  private update(
    pluginId: string,
    status: PluginRuntimeStatus,
    capabilities: CapabilityRuntimeHealth[] = this.get(pluginId).capabilities,
    error?: string,
  ): PluginRuntimeSnapshot {
    const previous = this.get(pluginId)
    const snapshot: PluginRuntimeSnapshot = {
      pluginId,
      status,
      capabilities,
      ...(status === 'starting' || status === 'running' || status === 'degraded' || status === 'failed'
        ? { startedAt: previous.startedAt ?? new Date().toISOString() }
        : previous.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
      ...(status === 'disabled' ? { stoppedAt: new Date().toISOString() } : {}),
      ...(error === undefined ? {} : { error }),
    }
    this.snapshots.set(pluginId, snapshot)
    return snapshot
  }


  noteFailure(pluginId: string, error: string): PluginRuntimeSnapshot {
    return this.update(pluginId, 'failed', this.get(pluginId).capabilities, error)
  }

  async start(
    plugin: CompatPlugin,
    packageRoot = this.layout.packageDir(plugin.id),
  ): Promise<PluginRuntimeSnapshot> {
    if (hasErrorDiagnostics(plugin.diagnostics)) throw new Error(`插件 ${plugin.id} 存在 error 诊断，不能启用`)
    const existing = this.handles.get(plugin.id)
    if (existing !== undefined && ['running', 'degraded', 'starting'].includes(existing.snapshot.status)) return existing.snapshot
    if (this.ctx.plugin === undefined) throw new Error('Cordis ctx.plugin 不可用，无法创建旧插件父实例')
    this.update(plugin.id, 'starting', [])
    await mkdir(this.layout.dataDir(plugin.id), { recursive: true, mode: 0o700 })
    let reportedHealth: CapabilityRuntimeHealth[] = []
    let reportedStatus: PluginRuntimeStatus = 'starting'
    const module = createLegacyRuntimePlugin(plugin.id)
    let fiber: FiberLike
    try {
      fiber = this.ctx.plugin(module, {
        plugin,
        packageRoot,
        dataRoot: this.layout.dataDir(plugin.id),
        workspaceRoot: this.workspaceRoot,
        dependencies: this.dependencies,
        ...(this.options.hookDefaultTimeoutMs === undefined ? {} : { hookDefaultTimeoutMs: this.options.hookDefaultTimeoutMs }),
        ...(this.options.hookStderrSummaryMaxChars === undefined ? {} : { hookStderrSummaryMaxChars: this.options.hookStderrSummaryMaxChars }),
        ...(this.options.codexModel === undefined ? {} : { codexModel: this.options.codexModel }),
        report: (health: CapabilityRuntimeHealth[], status: PluginRuntimeStatus) => {
          reportedHealth = health
          reportedStatus = status
        },
      })
      await Promise.resolve(fiber)
      const snapshot = this.update(plugin.id, reportedStatus === 'starting' ? 'running' : reportedStatus, reportedHealth)
      if (snapshot.status === 'failed') {
        try {
          await fiber.dispose()
        } catch (disposeError) {
          const message = `启动失败后的父实例清理也失败：${String(disposeError)}`
          return this.update(plugin.id, 'failed', reportedHealth, message)
        }
        return snapshot
      }
      this.handles.set(plugin.id, { fiber, snapshot })
      return snapshot
    } catch (error) {
      const snapshot = this.update(plugin.id, 'failed', reportedHealth, String(error))
      this.ctx.logger.warn(`dsh-compat: 插件 ${plugin.id} 父实例启动失败：${String(error)}`)
      return snapshot
    }
  }

  async stop(pluginId: string): Promise<PluginRuntimeSnapshot> {
    const handle = this.handles.get(pluginId)
    if (handle === undefined) return this.update(pluginId, 'disabled', [])
    this.update(pluginId, 'stopping', handle.snapshot.capabilities)
    try {
      await handle.fiber.dispose()
      this.handles.delete(pluginId)
      return this.update(pluginId, 'disabled', [])
    } catch (error) {
      const snapshot = this.update(pluginId, 'failed', handle.snapshot.capabilities, `dispose 失败：${String(error)}`)
      throw Object.assign(new Error(snapshot.error), { snapshot })
    }
  }

  async stopAll(): Promise<void> {
    for (const pluginId of [...this.handles.keys()].sort()) {
      try {
        await this.stop(pluginId)
      } catch (error) {
        this.ctx.logger.warn(`dsh-compat: 停止 ${pluginId} 失败：${String(error)}`)
      }
    }
  }
}
