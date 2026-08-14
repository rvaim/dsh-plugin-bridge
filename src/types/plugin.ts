import type { CompatAgent } from './agent.js'
import type { CompatCommand } from './command.js'
import type { CompatDiagnostic } from './diagnostic.js'
import type { CompatHook } from './hook.js'
import type { CompatMcpServer } from './mcp.js'
import type { CompatSkill } from './skill.js'
import type { CompatPluginLocation } from './source.js'

export type CompatFormat = 'claude-code' | 'codex'

/** parser 产出的统一插件结构；不携带 Claude Code/Codex 原始配置。 */
export interface CompatPlugin {
  schemaVersion: 1
  id: string
  name: string
  version?: string
  sourceId: string
  sourcePluginId: string
  formats: CompatFormat[]
  skills: CompatSkill[]
  mcpServers: CompatMcpServer[]
  hooks: CompatHook[]
  commands: CompatCommand[]
  agents: CompatAgent[]
  diagnostics: CompatDiagnostic[]
  manifestFiles: string[]
}

/** 外部 Git 插件实际取得的版本；不包含凭据。 */
export interface PluginMaterialization {
  commit?: string
}

/** installed/<pluginId>/install.json。 */
export interface InstallMetadata {
  schemaVersion: 1
  pluginId: string
  sourceId: string
  sourcePluginId: string
  /** Source package/ 内的规范化插件路径；主要用于 source-path。 */
  pluginPath?: string
  location: CompatPluginLocation
  materialization?: PluginMaterialization
  installedAt: string
  updatedAt?: string
}

export interface PluginState {
  schemaVersion: 1
  enabled: boolean
  priority: number
}

export interface ScanCache {
  schemaVersion: 1
  parserVersion: string
  /** 生成本缓存时对应的 Source 内容版本。 */
  sourceRevision: string
  scannedAt: string
  plugin: CompatPlugin
}

export interface InstalledPluginRecord {
  install: InstallMetadata
  state: PluginState
  scan: ScanCache
}
