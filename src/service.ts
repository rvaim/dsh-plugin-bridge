import { Service, type Context as CordisContext } from '@deepseek-ai/cordis'
import { createBuiltinParserEngine } from './composition/defaults.js'
import type { Config } from './config.js'
import {
  CompatManager,
  type InstallPreparation,
  type InstallOptions,
  type InstallResult,
  type PluginInspection,
  type PluginListEntry,
  type SourceAddOptions,
  type SourceInspection,
  type SourceListEntry,
  type SourceUpdateCheck,
  type SourceUpdateOptions,
  type SourceUpdateResult,
  type UpdateOptions,
} from './manager/manager.js'
import { CompatRuntimeManager } from './runtime/manager.js'
import { CompatLayout } from './store/layout.js'

/** 暴露给其他 DSH 插件使用的插件桥服务。 */
export class CompatService extends Service {
  readonly layout: CompatLayout
  readonly runtime: CompatRuntimeManager
  readonly manager: CompatManager

  constructor(ctx: CordisContext, readonly config: Config = {}) {
    super(ctx, 'pluginBridge')
    this.layout = new CompatLayout(config.harnessHome)
    this.runtime = new CompatRuntimeManager(ctx, this.layout, {
      workspaceRoot: config.workspaceRoot,
      hookDefaultTimeoutMs: config.hookDefaultTimeoutMs,
      hookStderrSummaryMaxChars: config.hookStderrSummaryMaxChars,
      modelName: config.modelName,
    })
    this.manager = new CompatManager(this.layout, this.runtime, createBuiltinParserEngine(config.parsers))
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

  prepareInstall(source: string, options?: SourceAddOptions): Promise<InstallPreparation> {
    return this.manager.prepareInstall(source, options)
  }

  completeInstallPreparation(preparationId: string, plugins: string[]): Promise<InstallResult> {
    return this.manager.completeInstallPreparation(preparationId, plugins)
  }

  releaseInstallPreparation(preparationId: string): Promise<void> {
    return this.manager.releaseInstallPreparation(preparationId)
  }

  install(source: string, options?: InstallOptions): Promise<InstallResult> {
    return this.manager.install(source, options)
  }

  update(pluginId: string, options?: UpdateOptions): Promise<PluginInspection> {
    return this.manager.update(pluginId, options)
  }

  checkUpdates(): Promise<SourceUpdateCheck[]> {
    return this.manager.checkUpdates()
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
    pluginBridge: CompatService
  }
}
