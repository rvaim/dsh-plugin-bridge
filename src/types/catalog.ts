import type { CompatDiagnostic } from './diagnostic.js'
import type { CompatFormat } from './plugin.js'
import type { CompatSourcePlugin, SourceScanCache } from './source.js'

/** 仅在内存传递的目录声明；原始配置不进入持久化扫描缓存。 */
export interface MarketplacePluginDefinition {
  format: CompatFormat
  file: string
  pointer: string
  name: string
  /** 该平台目录条目的策略；不能由其他平台的可安装状态覆盖。 */
  installable: boolean
  diagnostics: CompatDiagnostic[]
  displayName?: string
  description?: string
  version?: string
  strict?: boolean
  defaultEnabled?: boolean
  sourcePathIsRoot: boolean
  manifestFields: Record<string, unknown>
  skills?: unknown
  commands?: unknown
  agents?: unknown
  hooks?: unknown
  mcpServers?: unknown
}
export interface SourcePluginCandidate extends CompatSourcePlugin {
  definitions: MarketplacePluginDefinition[]
  locationKey: string
}
export interface SourceParserResult {
  marketplaceFile: string
  marketplaceName?: string
  candidates: SourcePluginCandidate[]
  diagnostics: CompatDiagnostic[]
}
export interface SourceDiscovery {
  root: string
  name?: string
  scan: SourceScanCache
  candidates: SourcePluginCandidate[]
}
