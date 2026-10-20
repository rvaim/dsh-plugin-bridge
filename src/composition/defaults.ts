import type { ParsePluginOptions, ParseSourceOptions } from '../parser/contracts.js'
import { ParserEngine } from '../parser/engine.js'
import { builtInParsers } from './builtins.js'
import { knownParserSignatures } from './signatures.js'

/** 运行配置只选择显式装配的实现，不加载第三方包或插件代码。 */
export function createBuiltinParserEngine(ids?: readonly string[]): ParserEngine {
  if (ids !== undefined) {
    for (const id of ids) if (!knownParserSignatures.some(signature => signature.id === id)) throw new Error(`未知解析器标识：${id}`)
  }
  const modules = ids === undefined ? builtInParsers : builtInParsers.filter(parser => ids.includes(parser.id))
  return new ParserEngine(modules, knownParserSignatures)
}
let defaultEngine: ParserEngine | undefined
export function getDefaultParserEngine(): ParserEngine { return defaultEngine ??= createBuiltinParserEngine() }
export function parseCompatPlugin(root: string, options: ParsePluginOptions = {}) { return getDefaultParserEngine().parsePlugin(root, options) }
export function parseCompatSource(root: string, options: ParseSourceOptions = {}) { return getDefaultParserEngine().parseSource(root, options) }
