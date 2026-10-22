import type { CompatParserEngine, ParsePluginOptions, ParseSourceOptions, ParserSignature, PluginParser } from './contracts.js'
import { ParserCategoryRegistry, ParserRegistry, parserMatch } from './registry.js'
import { DiagnosticCollector } from '../shared/diagnostics.js'
import type { MarketplacePluginDefinition } from '../types/catalog.js'
import { compilePlugin } from './plugin.js'
import { discoverSource } from './catalog.js'

/** 独立核心；构造时显式注入实现及保留边界，没有全局注册副作用。 */
export class ParserEngine extends ParserRegistry implements CompatParserEngine {
  constructor(
    modules: readonly PluginParser[],
    signatures: readonly ParserSignature[] = modules.map(module => module.signature),
    categories?: ParserCategoryRegistry,
  ) { super(modules, signatures, categories) }
  async matchPlugin(root: string, options: { marketplaceDefinitions?: MarketplacePluginDefinition[] } = {}) {
    return (await this.detect(root, new DiagnosticCollector(), options.marketplaceDefinitions)).map(parserMatch)
  }
  parsePlugin(root: string, options: ParsePluginOptions = {}) { return compilePlugin(this, root, options) }
  parseSource(root: string, options: ParseSourceOptions = {}) { return discoverSource(this, root, options) }
}
