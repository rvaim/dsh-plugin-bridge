import type { CompatCapability } from './diagnostic.js'

/** Web 页面可安全展示的阻断错误或兼容性警告。 */
export interface CompatWebDiagnostic {
  level: 'error' | 'warning'
  code: string
  capability: CompatCapability
  message: string
  file?: string
  /** Host 预先格式化的结构化详情，供展示和复制。 */
  details?: string
}

/** Web 设置页展示的一条外部插件记录。 */
export interface CompatWebPlugin {
  id: string
  name: string
  version?: string
  sourceId: string
  enabled: boolean
  priority: number
  runtimeStatus: 'disabled' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopping' | 'pending-restart'
  formats: string[]
  skills: number
  mcpServers: number
  hooks: number
  errors: number
  warnings: number
  diagnostics: CompatWebDiagnostic[]
}

/** 多插件来源中供用户选择的一项。 */
export interface CompatWebCandidate {
  id: string
  name: string
  displayName?: string
  description?: string
  version?: string
  formats: string[]
  installable: boolean
  errors: number
  warnings: number
  /** 由 Host 规范化的插件位置；可区分来源内目录与外部仓库。 */
  source: string
  diagnostics: CompatWebDiagnostic[]
}

/** 已装配解析器提供的页内分类。 */
export interface CompatWebCategory {
  id: string
  label: { en: string; zh?: string }
  order: number
}

/** 插件列表 RPC 的业务结果；预期错误保留可展示文案。 */
export type CompatWebListResult =
  | { kind: 'ready'; plugins: CompatWebPlugin[]; categories: CompatWebCategory[] }
  | { kind: 'error'; message: string }

/** 添加来源 RPC 的业务结果。 */
export type CompatWebAddResult =
  | { kind: 'installed'; plugins: CompatWebPlugin[] }
  | { kind: 'selection'; requestId: string; selectionRequired: boolean; candidates: CompatWebCandidate[] }
  | { kind: 'error'; message: string }

/** 取消尚未完成的多插件选择。 */
export type CompatWebCancelAddResult =
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/** 启用或停用 RPC 的业务结果。 */
export type CompatWebSetEnabledResult =
  | { kind: 'updated'; plugin: CompatWebPlugin }
  | { kind: 'error'; message: string }

/** 卸载 RPC 的业务结果。 */
export type CompatWebUninstallResult =
  | { kind: 'removed'; pluginId: string }
  | { kind: 'error'; message: string }


/** 单个已安装插件所属 Source 的更新检查结果。 */
export interface CompatWebUpdateInfo {
  pluginId: string
  sourceId: string
  available: boolean
  sharedSource: boolean
  affectedPluginIds: string[]
  error?: string
}

/** 检查更新 RPC 的业务结果。 */
export type CompatWebCheckUpdatesResult =
  | { kind: 'ready'; updates: CompatWebUpdateInfo[]; checkedAt: string }
  | { kind: 'error'; message: string }

/** 更新插件 RPC 的业务结果。 */
export type CompatWebUpdateResult =
  | { kind: 'updated'; plugins: CompatWebPlugin[]; affectedPluginIds: string[] }
  | { kind: 'error'; message: string }
