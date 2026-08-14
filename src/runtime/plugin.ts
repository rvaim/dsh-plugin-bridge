import { registerHooks } from '../adapters/hooks/register.js'
import { mountMcpServers } from '../adapters/mcp/client.js'
import { registerSkillProvider } from '../adapters/skills/provider.js'
import type { CompatPlugin } from '../types/plugin.js'
import type { CapabilityRuntimeHealth, PluginRuntimeStatus } from '../types/runtime.js'
import type { DshContextLike } from './context.js'
import type { RuntimeDependencies } from './dependencies.js'

export interface LegacyRuntimePluginConfig {
  plugin: CompatPlugin
  packageRoot: string
  dataRoot: string
  workspaceRoot: string
  dependencies: RuntimeDependencies
  hookDefaultTimeoutMs?: number
  hookStderrSummaryMaxChars?: number
  codexModel?: string
  report(health: CapabilityRuntimeHealth[], status: PluginRuntimeStatus): void
}

function statusFromHealth(health: readonly CapabilityRuntimeHealth[]): PluginRuntimeStatus {
  const runtimeHealth = health.filter(item => item.status !== 'disabled')
  if (runtimeHealth.length === 0) return 'running'
  const failed = runtimeHealth.filter(item => item.status === 'failed').length
  if (failed === 0) return runtimeHealth.some(item => item.status === 'degraded') ? 'degraded' : 'running'
  return failed === runtimeHealth.length ? 'failed' : 'degraded'
}

/** 构造一个 Cordis 父插件；所有兼容能力都注册在该父 Fiber 的上下文中。 */
export function createLegacyRuntimePlugin(pluginId: string): {
  name: string
  apply(ctx: DshContextLike, config: LegacyRuntimePluginConfig): Promise<void>
} {
  return {
    name: `dsh-compat-runtime-${pluginId}`,
    async apply(ctx, config): Promise<void> {
      const health: CapabilityRuntimeHealth[] = []
      if (config.plugin.skills.length > 0) {
        try {
          registerSkillProvider(ctx, config.plugin, config.packageRoot)
          health.push(...config.plugin.skills.map(skill => ({ capability: 'skill' as const, name: skill.name, status: 'running' as const })))
        } catch (error) {
          health.push(...config.plugin.skills.map(skill => ({ capability: 'skill' as const, name: skill.name, status: 'failed' as const, message: String(error) })))
          ctx.logger.warn(`dsh-compat: ${pluginId} Skill Provider 注册失败：${String(error)}`)
        }
      }
      try {
        health.push(...await registerHooks(ctx, config.plugin, config.packageRoot, config.dataRoot, config.dependencies, {
          workspaceRoot: config.workspaceRoot,
          defaultTimeoutMs: config.hookDefaultTimeoutMs,
          stderrSummaryMaxChars: config.hookStderrSummaryMaxChars,
          codexModel: config.codexModel,
        }))
      } catch (error) {
        health.push(...config.plugin.hooks.map(hook => ({ capability: 'hook' as const, name: hook.id, status: 'failed' as const, message: String(error) })))
        ctx.logger.warn(`dsh-compat: ${pluginId} Hook 注册失败：${String(error)}`)
      }
      try {
        const mounted = await mountMcpServers(
          ctx,
          config.plugin,
          config.packageRoot,
          config.dataRoot,
          config.workspaceRoot,
          config.dependencies,
        )
        health.push(...mounted.health)
      } catch (error) {
        health.push(...config.plugin.mcpServers.map(server => ({ capability: 'mcp' as const, name: server.serverName, status: 'failed' as const, message: String(error) })))
        ctx.logger.warn(`dsh-compat: ${pluginId} MCP 注册失败：${String(error)}`)
      }
      health.push(...config.plugin.commands.map(command => ({
        capability: 'command' as const,
        name: command.name,
        status: 'disabled' as const,
        message: '第一版仅识别，不注册运行',
      })))
      health.push(...config.plugin.agents.map(agent => ({
        capability: 'agent' as const,
        name: agent.name,
        status: 'disabled' as const,
        message: '第一版仅识别，不注册运行',
      })))
      config.report(health, statusFromHealth(health))
    },
  }
}
