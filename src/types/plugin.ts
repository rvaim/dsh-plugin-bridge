import type { ParserSnapshot } from './parser.js'
import type { CompatAgent } from './agent.js'
import type { CompatCommand } from './command.js'
import type { CompatDiagnostic } from './diagnostic.js'
import type { CompatHook } from './hook.js'
import type { CompatMcpServer } from './mcp.js'
import type { CompatSkill } from './skill.js'
import type { CompatPluginLocation } from './source.js'

export type CompatFormat = string

export interface PluginInstallSelection {
  pluginId: string
  /** 省略时仅允许唯一匹配；多匹配必须明确选择。 */
  parserId?: string
}

/** parser 产出的统一插件结构；不携带 Claude Code/Codex 原始配置。 */
export interface CompatPlugin {
  id: string
  name: string
  version?: string
  /** 仅在上游显式声明时存在；Marketplace 优先于插件清单。 */
  defaultEnabled?: boolean
  sourceId: string
  sourcePluginId: string
  formats: CompatFormat[]
  protocol?: { format: CompatFormat; version: string; schema?: string }
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
  pluginId: string
  sourceId: string
  sourcePluginId: string
  /** 本安装实例唯一采用的解析器；不从其他格式推断或迁移。 */
  parserId: string
  location: CompatPluginLocation
  materialization?: PluginMaterialization
  installedAt: string
  updatedAt?: string
}

export interface PluginState {
  enabled: boolean
  priority: number
}

export interface ScanCache {
  parserVersion: string
  parserSnapshot: ParserSnapshot
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
