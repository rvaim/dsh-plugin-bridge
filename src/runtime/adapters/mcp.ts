import type { CompatMcpServer } from '../../types/mcp.js'
import type { CompatRuntimeValue } from '../../types/path.js'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CapabilityRuntimeHealth } from '../../types/runtime.js'
import type { DshContextLike, FiberLike } from '../context.js'
import type { RuntimeDependencies } from '../dependencies.js'
import { buildPluginEnvironment } from '../environment.js'
import { redactSensitiveText } from '../redaction.js'
import { resolveCompatPath, resolveRuntimeValue } from '../value.js'
import {
  assertConfiguredHeadersSupported, buildProcessEnvironment, prepareExecutionRoots,
  resolveContainedCommand, resolveAnchoredCwd, validateProcessEnvironment, validateEndpointUrl,
} from '../../shared/mcp-execution.js'

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
  sourceRoot?: string,
): Promise<BuiltMcpConfig> {
  const common = {
    transport: server.transport,
    serverName: server.serverName,
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? 60_000,
    failOnStartupError: server.failOnStartupError ?? false,
    ...(server.reconnect === undefined ? {} : { reconnect: server.reconnect }),
  }
  if (server.executionProfile?.mode === 'contained') {
    const containedValue = async (value: CompatRuntimeValue, root = packageRoot, data = dataRoot): Promise<string> => {
      if (value.type !== 'deferred-json' || value.base !== undefined) throw new Error('受限 MCP 值必须来自插件内的延迟 JSON pointer')
      return await resolveRuntimeValue(ctx, value, root, data, workspaceRoot, sensitiveValues)
    }
    if (server.transport === 'stdio') {
      const roots = await prepareExecutionRoots(packageRoot, dataRoot)
      const command = await containedValue(server.command, roots.pluginRoot, roots.dataRoot)
      const env = Object.fromEntries(await Promise.all(Object.entries(server.env).map(async ([name, value]) => [
        name, await containedValue(value, roots.pluginRoot, roots.dataRoot),
      ])))
      validateProcessEnvironment(env, server.environmentBindings)
      return {
        sensitiveValues,
        config: {
          ...common, failOnStartupError: true,
          command: await resolveContainedCommand(roots.pluginRoot, command),
          args: await Promise.all(server.args.map(value => containedValue(value, roots.pluginRoot, roots.dataRoot))),
          env: buildProcessEnvironment(env,
            buildPluginEnvironment(server.environmentBindings, roots.pluginRoot, roots.dataRoot, workspaceRoot)),
          cwd: await resolveAnchoredCwd(server.cwd, roots.pluginRoot, roots.dataRoot, server.environmentBindings),
        },
      }
    }
    assertConfiguredHeadersSupported(server.headers)
    if (server.envHeaders !== undefined || server.bearerToken !== undefined) throw new Error('受限 MCP 不支持配置之外的认证字段')
    const url = await containedValue(server.url)
    validateEndpointUrl(url)
    return { sensitiveValues, config: { ...common, failOnStartupError: true, url, headers: {} } }
  }
  const resolveValues = async (values: Record<string, CompatRuntimeValue>) => Object.fromEntries(
    await Promise.all(Object.entries(values).map(async ([key, value]) => [
      key,
      await resolveRuntimeValue(ctx, value, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot),
    ] as const)),
  )
  if (server.transport === 'stdio') {
    return {
      sensitiveValues,
      config: {
        ...common,
        command: await resolveRuntimeValue(ctx, server.command, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot),
        args: await Promise.all(server.args.map(value => resolveRuntimeValue(ctx, value, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot))),
        env: {
          ...buildPluginEnvironment(server.environmentBindings, packageRoot, dataRoot, workspaceRoot),
          ...await resolveValues(server.env),
        },
        cwd: server.cwd === undefined ? '' : resolveCompatPath(server.cwd, packageRoot, workspaceRoot),
      },
    }
  }
  const headers = new Headers(Object.entries(await resolveValues(server.headers)))
  if (server.envHeaders !== undefined) {
    for (const [key, value] of Object.entries(await resolveValues(server.envHeaders))) {
      if (value.trim() !== '') headers.set(key, value)
    }
  }
  if (server.bearerToken !== undefined) {
    const token = await resolveRuntimeValue(ctx, server.bearerToken, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot)
    headers.set('authorization', `Bearer ${token}`)
  }
  return {
    sensitiveValues,
    config: {
      ...common,
      url: await resolveRuntimeValue(ctx, server.url, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot),
      headers: Object.fromEntries(headers.entries()),
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
  sourceRoot?: string,
): Promise<McpMountResult> {
  const fibers: FiberLike[] = []
  const health: CapabilityRuntimeHealth[] = []
  if (plugin.mcpServers.length === 0) return { fibers, health }
  if (ctx.plugin === undefined) throw new Error('Cordis ctx.plugin 不可用，无法挂载 MCP 子插件')
  const mcpModule = await dependencies.loadMcpClient()
  for (const server of plugin.mcpServers) {
    const sensitiveValues = new Set<string>()
    let fiber: FiberLike | undefined
    try {
      if ((server.runtimeUnsupported?.length ?? 0) > 0) throw new Error(`MCP 运行语义尚未适配：${server.runtimeUnsupported!.join(', ')}`)
      const built = await buildMcpConfig(ctx, server, packageRoot, dataRoot, workspaceRoot, sensitiveValues, sourceRoot)
      fiber = ctx.plugin(mcpModule, built.config)
      await Promise.resolve(fiber)
      fibers.push(fiber)
      health.push({ capability: 'mcp', name: server.serverName, status: 'running' })
    } catch (error) {
      let cleanupError: unknown
      if (fiber !== undefined) {
        try { await fiber.dispose() } catch (failure) { cleanupError = failure }
      }
      const message = redactSensitiveText(`${String(error)}${cleanupError === undefined ? '' : `；失败连接清理未完成：${String(cleanupError)}`}`, sensitiveValues)
      health.push({ capability: 'mcp', name: server.serverName, status: 'failed', message })
      ctx.logger.warn(`plugin-bridge: MCP ${plugin.id}/${server.serverName} 启动失败：${message}`)
    }
  }
  return { fibers, health }
}
