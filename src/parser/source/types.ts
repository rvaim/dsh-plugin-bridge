import type { CompatDiagnostic } from '../../types/diagnostic.js'
import type { CompatFormat } from '../../types/plugin.js'
import type { CompatSourcePlugin, SourceScanCache } from '../../types/source.js'

/**
 * Marketplace 对一个插件格式的定义。
 *
 * 该结构只在 parser 内存中流转，不写入 scan.json。这样既能把 Marketplace
 * 内联能力交给具体 Plugin parser，又避免把旧配置中的凭据字面量持久化。
 */
export interface MarketplacePluginDefinition {
  format: CompatFormat
  file: string
  /** 该条目在 Marketplace JSON 中的 JSON Pointer。 */
  pointer: string
  name: string
  displayName?: string
  description?: string
  version?: string
  strict?: boolean
  sourcePathIsRoot: boolean
  /**
   * Marketplace 条目中可作为插件清单回退值的字段。
   *
   * Codex Marketplace 使用扁平的顶层 manifest 字段，并在插件目录没有
   * .codex-plugin/plugin.json 时把它们作为回退清单。该对象只在 parser
   * 内存中流转，绝不写入 scan.json，避免内联 MCP/Hook 中的凭据落盘。
   */
  manifestFields: Record<string, unknown>
  skills?: unknown
  commands?: unknown
  agents?: unknown
  hooks?: unknown
  mcpServers?: unknown
}

/** Source parser 的内存候选；definitions/locationKey 不进入持久缓存。 */
export interface SourcePluginCandidate extends CompatSourcePlugin {
  definitions: MarketplacePluginDefinition[]
  /** 用于合并混合 Marketplace 中指向同一实体的条目。 */
  locationKey: string
}

/** 一个 Marketplace parser 的结果。 */
export interface SourceParserResult {
  marketplaceFile: string
  marketplaceName?: string
  candidates: SourcePluginCandidate[]
  diagnostics: CompatDiagnostic[]
}

/** 完整 Source 发现结果。root 可能是归档剥离一层包装目录后的真实根。 */
export interface SourceDiscovery {
  root: string
  name?: string
  scan: SourceScanCache
  candidates: SourcePluginCandidate[]
}

/** 兼容早期内部命名。 */
export type SourceCatalogResult = SourceDiscovery
