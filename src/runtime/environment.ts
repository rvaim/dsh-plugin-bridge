import type { CompatPluginEnvironmentMode } from '../types/environment.js'

/**
 * 构造旧插件子进程可见的标准路径变量。
 * 显式插件配置中的同名 env 会在 adapter 中覆盖这些默认值。
 */
export function buildPluginEnvironment(
  mode: CompatPluginEnvironmentMode,
  pluginRoot: string,
  dataRoot: string,
  workspaceRoot: string,
): Record<string, string> {
  if (mode === 'claude-plugin') {
    return {
      CLAUDE_PROJECT_DIR: workspaceRoot,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: dataRoot,
    }
  }
  // Codex 与双格式插件都获得两套兼容变量。combined-plugin 仅由 parser 在
  // 确认同一 MCP 配置被两种生态等价声明后生成，adapter 不再判断来源格式。
  return {
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: dataRoot,
    CODEX_PLUGIN_ROOT: pluginRoot,
    CODEX_PLUGIN_DATA: dataRoot,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: dataRoot,
    CLAUDE_PROJECT_DIR: workspaceRoot,
  }
}
