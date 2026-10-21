import type { CompatAgent } from '../types/agent.js'
import type { CompatCommand } from '../types/command.js'
import type { CompatDiagnostic } from '../types/diagnostic.js'
import type { CompatHook } from '../types/hook.js'
import type { CompatMcpServer } from '../types/mcp.js'
import type { CompatFormat, CompatPlugin } from '../types/plugin.js'
import type { CompatSkill } from '../types/skill.js'
import type { MarketplacePluginDefinition, SourceDiscovery, SourceParserResult } from '../types/catalog.js'

import type { CompatCategory, ParserCategoryContribution, ParserIdentity, ParserSnapshot } from '../types/parser.js'
export type { CompatCategory, ParserCategoryContribution, ParserIdentity, ParserSnapshot } from '../types/parser.js'

/** 无实现依赖的格式边界。未加载解析器时仍阻止被其他格式兜底接管。 */
export interface ParserSignature {
  id: string
  manifestPaths: readonly string[]
  marketplacePaths: readonly string[]
  catalogIndex?: { entriesField: string; nameField: string }
  exclusive?: boolean
  priority?: number
}

export interface ParsePluginOptions {
  sourceId?: string
  sourcePluginId?: string
  suggestedId?: string
  asId?: string
  displayName?: string
  marketplaceDefinitions?: MarketplacePluginDefinition[]
}
export interface ParseSourceOptions {
  paths?: string[]
  allowSingleWrapper?: boolean
  suggestedPluginId?: string
}
export interface ParserDetection { matched: boolean; implicit?: boolean }
export interface ProtocolParseInput {
  root: string
  implicit: boolean
  definition?: MarketplacePluginDefinition
}
export interface ProtocolParseResult {
  format: CompatFormat
  name?: string
  displayName?: string
  version?: string
  defaultEnabled?: boolean
  /** 禁止 catalog/package.json 补充或覆盖协议核心 metadata。 */
  metadataPolicy?: 'manifest-only'
  protocol?: CompatPlugin['protocol']
  manifestFiles: string[]
  skills: CompatSkill[]
  mcpServers: CompatMcpServer[]
  hooks: CompatHook[]
  commands: CompatCommand[]
  agents: CompatAgent[]
  diagnostics: CompatDiagnostic[]
}

/** 解析模块不引用其他模块或任何 DSH 运行实现。 */
export interface PluginParser extends ParserIdentity {
  category: ParserCategoryContribution
  signature: ParserSignature
  detect(root: string): Promise<ParserDetection>
  discoverSource(root: string): Promise<SourceParserResult | undefined>
  parsePlugin(input: ProtocolParseInput): Promise<ProtocolParseResult>
  inferName?(root: string): Promise<string | undefined>
}

/** 管理/加载层只接收该端口，不引用具体格式或默认装配。 */
export interface CompatParserEngine {
  readonly snapshot: ParserSnapshot
  readonly categories: readonly CompatCategory[]
  dispose(): void
  parsePlugin(root: string, options?: ParsePluginOptions): Promise<CompatPlugin>
  parseSource(root: string, options?: ParseSourceOptions): Promise<SourceDiscovery>
}
