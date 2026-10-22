import type { CompatDiagnostic } from '../types/diagnostic.js'
import type { ParserChoiceRequest } from './types.js'

export class ParserSelectionRequiredError extends Error {
  constructor(readonly plugins: ParserChoiceRequest[]) {
    super('插件匹配多个解析器，请为每个插件明确选择 parserId')
    this.name = 'ParserSelectionRequiredError'
  }
}

export class CompatibilityError extends Error {
  constructor(message: string, readonly diagnostics: CompatDiagnostic[]) {
    super(message)
    this.name = 'CompatibilityError'
  }
}

export class SharedSourceUpdateError extends Error {
  constructor(readonly sourceId: string, readonly pluginIds: readonly string[]) {
    super(`更新该插件实际会更新共享 Source ${sourceId}；同时受影响：${pluginIds.join(', ')}`)
    this.name = 'SharedSourceUpdateError'
  }
}
