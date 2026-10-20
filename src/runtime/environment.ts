import type { CompatPluginEnvironmentBindings } from '../types/environment.js'

/** 显式 env 的覆盖优先级由调用方决定。空地图表示不注入任何路径变量。 */
export function buildPluginEnvironment(
  bindings: CompatPluginEnvironmentBindings | undefined,
  pluginRoot: string,
  dataRoot: string,
  workspaceRoot: string,
): Record<string, string> {
  const paths = { 'plugin-root': pluginRoot, 'plugin-data': dataRoot, 'workspace-root': workspaceRoot }
  return Object.fromEntries(Object.entries(bindings ?? {}).map(([name, binding]) => [name, paths[binding]]))
}
