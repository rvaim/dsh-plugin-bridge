import type { CompatDiagnostic } from '../types/diagnostic.js'
import { hasErrorDiagnostics, sortDiagnostics, uniqueDiagnostics } from '../types/diagnostic.js'
import type { SourcePluginCandidate } from '../types/catalog.js'
import type { CompatPlugin } from '../types/plugin.js'
export { PARSER_VERSION, SOURCE_PARSER_VERSION } from './version.js'

export function withAdditionalDiagnostics(plugin: CompatPlugin, diagnostics: readonly CompatDiagnostic[]): CompatPlugin {
  return { ...plugin, diagnostics: sortDiagnostics(uniqueDiagnostics([...plugin.diagnostics, ...diagnostics])) }
}

/** 投影已匹配平台的策略；调用方先用 matchPlugin 验证，候选结构冲突始终保留。 */
export function selectCandidateParser(candidate: SourcePluginCandidate, parserId: string): SourcePluginCandidate {
  const definitions = candidate.definitions.filter(definition => definition.format === parserId)
  const policyDiagnostics = new Set(candidate.definitions.flatMap(definition => definition.diagnostics).map(item => JSON.stringify(item)))
  const sharedDiagnostics = candidate.diagnostics.filter(item => !policyDiagnostics.has(JSON.stringify(item))
    && (typeof item.details?.parserId !== 'string' || item.details.parserId === parserId)).map(item => {
      if (item.details?.parserId !== parserId) return item
      const { details: _details, ...base } = item
      const { parserId: _parserId, ...details } = item.details
      return Object.keys(details).length === 0 ? base : { ...base, details }
    })
  const diagnostics = sortDiagnostics(uniqueDiagnostics([
    ...sharedDiagnostics,
    ...definitions.flatMap(definition => definition.diagnostics),
  ]))
  const { displayName: _displayName, description: _description, version: _version, defaultEnabled: _defaultEnabled, ...base } = candidate
  const definition = definitions[0]
  return {
    ...base, formats: [parserId], definitions, diagnostics,
    name: definition?.name ?? candidate.name,
    ...(definition?.displayName === undefined ? {} : { displayName: definition.displayName }),
    ...(definition?.description === undefined ? {} : { description: definition.description }),
    ...(definition?.version === undefined ? {} : { version: definition.version }),
    ...(definition?.defaultEnabled === undefined ? {} : { defaultEnabled: definition.defaultEnabled }),
    installable: !hasErrorDiagnostics(diagnostics)
      && (definitions.length === 0 || definitions.every(item => item.installable)),
  }
}
