import type { CompatDiagnostic } from '../types/diagnostic.js'
import { sortDiagnostics, uniqueDiagnostics } from '../types/diagnostic.js'
import type { CompatPlugin } from '../types/plugin.js'
export { PARSER_VERSION, SOURCE_PARSER_VERSION } from './version.js'

export function withAdditionalDiagnostics(plugin: CompatPlugin, diagnostics: readonly CompatDiagnostic[]): CompatPlugin {
  return { ...plugin, diagnostics: sortDiagnostics(uniqueDiagnostics([...plugin.diagnostics, ...diagnostics])) }
}
