import { Service } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import {
  CompatManager,
  type InstallOptions,
  type InstallResult,
  type PluginInspection,
  type PluginListEntry,
  type SourceAddOptions,
  type SourceInspection,
  type SourceListEntry,
  type SourceUpdateOptions,
  type SourceUpdateResult,
  type UpdateOptions,
} from './manager/manager.js'
import { CompatRuntimeManager } from './runtime/manager.js'
import type { DshContextLike } from './runtime/context.js'
import { CompatLayout } from './store/layout.js'

/** 暴露给其他 DSH 插件使用的 dsh-compat 服务。 */
export class CompatService extends Service {
  readonly layout: CompatLayout
  readonly runtime: CompatRuntimeManager
  readonly manager: CompatManager

  constructor(readonly ctx: DshContextLike, readonly config: Config = {}) {
    super(ctx, 'compat')
    this.layout = new CompatLayout(config.harnessHome)
    this.runtime = new CompatRuntimeManager(ctx, this.layout, {
      ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
      ...(config.hookDefaultTimeoutMs === undefined ? {} : { hookDefaultTimeoutMs: config.hookDefaultTimeoutMs }),
      ...(config.hookStderrSummaryMaxChars === undefined ? {} : { hookStderrSummaryMaxChars: config.hookStderrSummaryMaxChars }),
      ...(config.codexModel === undefined ? {} : { codexModel: config.codexModel }),
    })
    this.manager = new CompatManager(this.layout, this.runtime)
  }

  async start(): Promise<void> {
    await this.layout.ensure()
    if (this.config.autoStart ?? true) await this.manager.reconcile()
  }

  async stop(): Promise<void> {
    await this.runtime.stopAll()
  }

  sourceAdd(source: string, options?: SourceAddOptions): Promise<SourceInspection> {
    return this.manager.sourceAdd(source, options)
  }

  sourceRemove(sourceId: string): Promise<void> {
    return this.manager.sourceRemove(sourceId)
  }

  sourceUpdate(sourceId: string, options?: SourceUpdateOptions): Promise<SourceUpdateResult> {
    return this.manager.sourceUpdate(sourceId, options)
  }

  sourceList(): Promise<SourceListEntry[]> {
    return this.manager.sourceList()
  }

  sourceInspect(sourceId: string): Promise<SourceInspection> {
    return this.manager.sourceInspect(sourceId)
  }

  install(source: string, options?: InstallOptions): Promise<InstallResult> {
    return this.manager.install(source, options)
  }

  update(pluginId: string, options?: UpdateOptions): Promise<PluginInspection> {
    return this.manager.update(pluginId, options)
  }

  enable(pluginId: string): Promise<PluginInspection> {
    return this.manager.enable(pluginId)
  }

  disable(pluginId: string): Promise<PluginInspection> {
    return this.manager.disable(pluginId)
  }

  uninstall(pluginId: string): Promise<void> {
    return this.manager.uninstall(pluginId)
  }

  list(): Promise<PluginListEntry[]> {
    return this.manager.list()
  }

  inspect(pluginId: string): Promise<PluginInspection> {
    return this.manager.inspect(pluginId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compat: CompatService
  }
}
