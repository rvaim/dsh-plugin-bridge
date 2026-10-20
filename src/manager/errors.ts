import type { CompatDiagnostic } from '../types/diagnostic.js'

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
