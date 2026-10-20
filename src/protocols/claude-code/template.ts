import type { CompatPluginEnvironmentBindings } from '../../types/environment.js'
import type { CompatRuntimeValue, CompatTemplate } from '../../types/path.js'
import { parsePotentialSecretValue as parseSecret, parseTemplate as parseGrammar } from '../../shared/template.js'

export { deferredJson, escapeJsonPointer } from '../../shared/template.js'

/** This protocol owns the names mapped into neutral path parts. */
export const TEMPLATE_BINDINGS: CompatPluginEnvironmentBindings = {
  CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root',
  CODEX_PLUGIN_ROOT: 'plugin-root', CODEX_PLUGIN_DATA: 'plugin-data', CODEX_PROJECT_DIR: 'workspace-root',
  PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data', PROJECT_ROOT: 'workspace-root', WORKSPACE_ROOT: 'workspace-root',
}

export function parseTemplate(value: string): CompatTemplate {
  return parseGrammar(value, TEMPLATE_BINDINGS)
}

export function parsePotentialSecretValue(value: unknown, file: string, pointer: string, sensitive = true): CompatRuntimeValue {
  return parseSecret(value, file, pointer, sensitive, TEMPLATE_BINDINGS)
}
