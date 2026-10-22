import type { CompatDiagnostic } from '../types/diagnostic.js'
import type { CompatPlugin, InstallMetadata, InstalledPluginRecord, PluginMaterialization, PluginState, ScanCache } from '../types/plugin.js'
import type { PluginRuntimeSnapshot, PluginRuntimeStatus } from '../types/runtime.js'
import type { CompatPluginLocation, CompatSource, CompatSourcePlugin, InstalledSourceRecord, InstallSource, SourceOwnership } from '../types/source.js'
import type { SourcePluginCandidate } from '../types/catalog.js'

export interface InstallOptions {
  signal?: AbortSignal
  cwd?: string
  /** 单插件安装时覆盖 plugin-bridge 管理 ID；不会改写插件内部名称。 */
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
  signal?: AbortSignal
  cwd?: string
  as?: string
  paths?: string[]
}

/** Web 等分步前端完成选择前持有的一份已固定 Source 快照。 */
export interface InstallPreparation {
  /** Manager-owned preparation; complete or release this exact session. */
  preparationId: string
  sourceId: string
  sourceCreated: boolean
  /** 市场或多候选来源必须显式选择，前端不得按候选数量绕过。 */
  selectionRequired: boolean
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

export interface SourceUpdateCheck {
  sourceId: string
  updateAvailable: boolean
  currentRevision: string
  latestRevision?: string
  /** 引用该 Source 的全部已安装 Plugin；任一更新都会整体更新 Source。 */
  affectedPluginIds: string[]
  error?: string
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

export interface PreparedPlugin {
  candidate: SourcePluginCandidate
  packageRoot: string
  location: CompatPluginLocation
  materialization?: PluginMaterialization
  newlyMaterializedExternal?: string
}

export interface ParsedInstallCandidate {
  prepared: PreparedPlugin
  plugin: CompatPlugin
  install: InstallMetadata
  state: PluginState
  scan: ScanCache
}
