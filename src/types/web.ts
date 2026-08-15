import type { CompatCapability } from './diagnostic.js'

/** Web 页面可安全展示的阻断错误或兼容性警告。 */
export interface CompatWebDiagnostic {
  level: 'error' | 'warning'
  code: string
  capability: CompatCapability
  message: string
  file?: string
}

/** Web 设置页展示的一条兼容插件记录。 */
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
}

/** 插件列表 RPC 的业务结果；预期错误保留可展示文案。 */
export type CompatWebListResult =
  | { kind: 'ready'; plugins: CompatWebPlugin[] }
  | { kind: 'error'; message: string }

/** 添加来源 RPC 的业务结果。 */
export type CompatWebAddResult =
  | { kind: 'installed'; plugins: CompatWebPlugin[] }
  | { kind: 'selection'; requestId: string; candidates: CompatWebCandidate[] }
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
