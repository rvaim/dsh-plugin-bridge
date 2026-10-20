import type { CompatPluginEnvironmentBindings } from '../../types/environment.js'
import type { CompatDeferredJsonValue } from '../../types/path.js'
import { deferredJson } from '../../shared/template.js'

export { escapeJsonPointer } from '../../shared/template.js'

/** The specification recognizes only these two exact path placeholders. */
export const PATH_BINDINGS: CompatPluginEnvironmentBindings = { PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data' }

export function deferredPluginValue(
  file: string, pointer: string, expansion: 'exact-plugin-vars' | 'none', sensitive = true,
): CompatDeferredJsonValue {
  return { ...deferredJson(file, pointer, sensitive), expansion,
    ...(expansion === 'exact-plugin-vars' ? { templateBindings: { ...PATH_BINDINGS } } : {}) }
}
