/** 子进程变量对应的路径语义，不依赖插件来源或方言。 */
export type CompatPluginEnvironmentBinding = 'plugin-root' | 'plugin-data' | 'workspace-root'
export type CompatPluginEnvironmentBindings = Record<string, CompatPluginEnvironmentBinding>
