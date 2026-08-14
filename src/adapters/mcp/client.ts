import type { CompatMcpServer } from '../../types/mcp.js'
import type { CompatRuntimeValue } from '../../types/path.js'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CapabilityRuntimeHealth } from '../../types/runtime.js'
import type { DshContextLike, FiberLike } from '../../runtime/context.js'
import type { RuntimeDependencies } from '../../runtime/dependencies.js'
import { buildPluginEnvironment } from '../../runtime/environment.js'
import { redactSensitiveText } from '../../runtime/redaction.js'
import { resolveCompatPath, resolveRuntimeValue } from '../../runtime/value.js'

export interface McpMountResult {
  fibers: FiberLike[]
  health: CapabilityRuntimeHealth[]
}

interface BuiltMcpConfig {
  config: Record<string, unknown>
  sensitiveValues: Set<string>
}

async function buildMcpConfig(
  ctx: DshContextLike,
  server: CompatMcpServer,
  packageRoot: string,
  dataRoot: string,
  workspaceRoot: string,
  sensitiveValues: Set<string>,
): Promise<BuiltMcpConfig> {
  const common = {
    transport: server.transport,
    serverName: server.serverName,
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? 60_000,
    failOnStartupError: server.failOnStartupError ?? false,
    ...(server.reconnect === undefined ? {} : { reconnect: server.reconnect }),
  }
  const resolveValues = async (values: Record<string, CompatRuntimeValue>) => Object.fromEntries(
    await Promise.all(Object.entries(values).map(async ([key, value]) => [
      key,
      await resolveRuntimeValue(ctx, value, packageRoot, dataRoot, workspaceRoot, sensitiveValues),
    ] as const)),
  )
  if (server.transport === 'stdio') {
    return {
      sensitiveValues,
      config: {
        ...common,
        command: await resolveRuntimeValue(ctx, server.command, packageRoot, dataRoot, workspaceRoot, sensitiveValues),
        args: await Promise.all(server.args.map(value => resolveRuntimeValue(ctx, value, packageRoot, dataRoot, workspaceRoot, sensitiveValues))),
        env: {
          ...buildPluginEnvironment(server.environmentMode, packageRoot, dataRoot, workspaceRoot),
          ...await resolveValues(server.env),
        },
        cwd: server.cwd === undefined ? '' : resolveCompatPath(server.cwd, packageRoot, workspaceRoot),
      },
    }
  }
  return {
    sensitiveValues,
    config: {
      ...common,
      url: await resolveRuntimeValue(ctx, server.url, packageRoot, dataRoot, workspaceRoot, sensitiveValues),
      headers: await resolveValues(server.headers),
    },
  }
}

/** 一个 CompatMcpServer 对应一个 dsh-mcp-client 子插件实例。 */
export async function mountMcpServers(
  ctx: DshContextLike,
  plugin: CompatPlugin,
  packageRoot: string,
  dataRoot: string,
  workspaceRoot: string,
  dependencies: RuntimeDependencies,
): Promise<McpMountResult> {
  const fibers: FiberLike[] = []
  const health: CapabilityRuntimeHealth[] = []
  if (plugin.mcpServers.length === 0) return { fibers, health }
  if (ctx.plugin === undefined) throw new Error('Cordis ctx.plugin 不可用，无法挂载 MCP 子插件')
  const mcpModule = await dependencies.loadMcpClient()
  for (const server of plugin.mcpServers) {
    const sensitiveValues = new Set<string>()
    try {
      const built = await buildMcpConfig(ctx, server, packageRoot, dataRoot, workspaceRoot, sensitiveValues)
      const fiber = ctx.plugin(mcpModule, built.config)
      await Promise.resolve(fiber)
      fibers.push(fiber)
      health.push({ capability: 'mcp', name: server.serverName, status: 'running' })
    } catch (error) {
      const message = redactSensitiveText(String(error), sensitiveValues)
      health.push({ capability: 'mcp', name: server.serverName, status: 'failed', message })
      ctx.logger.warn(`dsh-compat: MCP ${plugin.id}/${server.serverName} 启动失败：${message}`)
    }
  }
  return { fibers, health }
}
