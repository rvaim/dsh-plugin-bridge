import { resolve } from 'node:path'
import type { CompatMcpReconnect, CompatMcpServer } from '../../types/mcp.js'
import type { CompatRuntimeValue } from '../../types/path.js'
import type { HarnessDescriptor } from '../harness/types.js'
import { asObject } from '../harness/common.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { readJson } from '../shared/fs.js'
import { parseCompatPath } from '../shared/path.js'
import { escapeJsonPointer, parsePotentialSecretValue } from '../shared/template.js'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseReconnect(value: unknown): CompatMcpReconnect | undefined {
  const object = asObject(value)
  if (object === undefined) return undefined
  return {
    ...(typeof object.enabled === 'boolean' ? { enabled: object.enabled } : {}),
    ...(finiteNumber(object.maxAttempts) === undefined ? {} : { maxAttempts: finiteNumber(object.maxAttempts) }),
    ...(finiteNumber(object.initialDelayMs) === undefined ? {} : { initialDelayMs: finiteNumber(object.initialDelayMs) }),
    ...(finiteNumber(object.maxDelayMs) === undefined ? {} : { maxDelayMs: finiteNumber(object.maxDelayMs) }),
  }
}

function parseToolTimeout(
  config: Record<string, unknown>,
  collector: DiagnosticCollector,
  sourceFile: string,
  serverName: string,
): number | undefined {
  const milliseconds = finiteNumber(config.toolCallTimeoutMs)
  const seconds = finiteNumber(config.tool_timeout_sec)
  const value = milliseconds ?? (seconds === undefined ? undefined : seconds * 1_000)
  if (value !== undefined && value <= 0) {
    collector.add('error', 'MCP_TOOL_TIMEOUT_INVALID', 'mcp', `MCP ${serverName} 的工具超时必须为正数`, sourceFile)
    return undefined
  }
  return value
}

function environmentReference(name: string): CompatRuntimeValue {
  return { type: 'template', parts: [{ type: 'env', name }] }
}

function parseEnvironment(
  config: Record<string, unknown>,
  sourceFile: string,
  pointer: string,
  collector: DiagnosticCollector,
  serverName: string,
): Record<string, CompatRuntimeValue> {
  const envObject = asObject(config.env) ?? {}
  const env: Record<string, CompatRuntimeValue> = {}
  for (const [key, envValue] of Object.entries(envObject)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      collector.add('error', 'MCP_ENV_NAME_INVALID', 'mcp', `MCP ${serverName} 的环境变量名无效：${key}`, sourceFile)
      continue
    }
    env[key] = parsePotentialSecretValue(envValue, sourceFile, `${pointer}/env/${escapeJsonPointer(key)}`)
  }

  const inherited = config.env_vars ?? config.envVars
  if (inherited !== undefined) {
    if (!Array.isArray(inherited) || inherited.some(item => typeof item !== 'string')) {
      collector.add('error', 'MCP_ENV_VARS_INVALID', 'mcp', `MCP ${serverName} 的 env_vars 必须是字符串数组`, sourceFile)
    } else {
      for (const name of inherited) {
        if (!ENV_NAME_PATTERN.test(name)) {
          collector.add('error', 'MCP_ENV_NAME_INVALID', 'mcp', `MCP ${serverName} 的 env_vars 名称无效：${name}`, sourceFile)
          continue
        }
        if (env[name] === undefined) env[name] = environmentReference(name)
      }
    }
  }
  return env
}

export async function parseMcpForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatMcpServer[]> {
  const servers: CompatMcpServer[] = []
  for (const source of descriptor.mcpSources) {
    let raw: unknown
    try {
      raw = source.inline ?? await readJson(resolve(packageRoot, source.file))
    } catch (error) {
      collector.add('error', 'MCP_CONFIG_INVALID', 'mcp', `MCP 配置无法解析：${String(error)}`, source.file)
      continue
    }
    const root = asObject(raw)
    if (root === undefined) {
      collector.add('error', 'MCP_CONFIG_INVALID', 'mcp', 'MCP 配置顶层必须是对象', source.file)
      continue
    }
    if ('resources' in root) collector.add('warning', 'MCP_RESOURCE_UNSUPPORTED', 'mcp', '当前只接入 MCP Tool，资源声明不会注册', source.file)
    if ('prompts' in root) collector.add('warning', 'MCP_PROMPT_UNSUPPORTED', 'mcp', '当前只接入 MCP Tool，Prompt 声明不会注册', source.file)

    const camel = asObject(root.mcpServers)
    const snake = asObject(root.mcp_servers)
    if (camel !== undefined && snake !== undefined) {
      collector.add('error', 'MCP_WRAPPER_AMBIGUOUS', 'mcp', 'MCP 配置不能同时声明 mcpServers 与 mcp_servers', source.file)
      continue
    }
    const wrapperName = camel !== undefined ? 'mcpServers' : snake !== undefined ? 'mcp_servers' : undefined
    const map = camel ?? snake ?? root
    const basePointer = `${source.pointer ?? ''}${wrapperName === undefined ? '' : `/${wrapperName}`}`

    for (const [serverName, value] of Object.entries(map)) {
      if (!SERVER_NAME_PATTERN.test(serverName)) {
        collector.add('error', 'MCP_SERVER_NAME_INVALID', 'mcp', `MCP serverName 不符合 DSH 约束且不会自动改名：${serverName}`, source.file)
        continue
      }
      const config = asObject(value)
      if (config === undefined) {
        collector.add('error', 'MCP_SERVER_CONFIG_INVALID', 'mcp', `MCP ${serverName} 配置必须是对象`, source.file)
        continue
      }
      if (config.disabled === true || config.enabled === false) {
        collector.add('info', 'MCP_SERVER_DISABLED_BY_SOURCE', 'mcp', `MCP ${serverName} 在原配置中已禁用，跳过注册`, source.file)
        continue
      }
      const pointer = `${basePointer}/${escapeJsonPointer(serverName)}`
      const transport = typeof config.transport === 'string'
        ? config.transport
        : typeof config.type === 'string'
          ? config.type
          : typeof config.url === 'string'
            ? 'streamable-http'
            : 'stdio'
      const toolCallTimeoutMs = parseToolTimeout(config, collector, source.file, serverName)
      if (config.startup_timeout_sec !== undefined || config.startupTimeoutSec !== undefined) {
        collector.add('warning', 'MCP_STARTUP_TIMEOUT_UNSUPPORTED', 'mcp', `MCP ${serverName} 的启动超时当前无法精确映射到 dsh-mcp-client`, source.file)
      }
      if (config.default_tools_approval_mode !== undefined
        || config.enabled_tools !== undefined
        || config.disabled_tools !== undefined) {
        collector.add('warning', 'MCP_TOOL_POLICY_UNSUPPORTED', 'mcp', `MCP ${serverName} 的工具审批/白名单策略当前由 DSH 自身策略管理`, source.file)
      }
      const common = {
        serverName,
        sourceFormat: descriptor.format,
        sourceFile: source.file,
        environmentMode: descriptor.format === 'codex' ? 'codex-plugin' : 'claude-plugin',
        ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
        ...(typeof config.failOnStartupError === 'boolean' ? { failOnStartupError: config.failOnStartupError } : {}),
        ...(parseReconnect(config.reconnect) === undefined ? {} : { reconnect: parseReconnect(config.reconnect) }),
      } as const

      if (transport === 'sse') {
        collector.add('error', 'MCP_TRANSPORT_UNSUPPORTED', 'mcp', `MCP ${serverName} 使用 SSE；当前 dsh-mcp-client 仅适配 stdio 与 streamable-http`, source.file)
        continue
      }
      if (transport === 'http' || transport === 'streamable-http' || transport === 'streamable_http') {
        if (typeof config.url !== 'string' || config.url.trim() === '') {
          collector.add('error', 'MCP_URL_MISSING', 'mcp', `MCP ${serverName} 缺少 url`, source.file)
          continue
        }
        const headersObject = asObject(config.headers) ?? {}
        const headers = Object.fromEntries(Object.entries(headersObject).map(([key, header]) => [
          key,
          parsePotentialSecretValue(header, source.file, `${pointer}/headers/${escapeJsonPointer(key)}`),
        ]))
        servers.push({
          ...common,
          transport: 'streamable-http',
          url: parsePotentialSecretValue(config.url, source.file, `${pointer}/url`),
          headers,
        })
        collector.add('info', 'MCP_SERVER_DISCOVERED', 'mcp', `发现 MCP：${serverName}（streamable-http）`, source.file)
        continue
      }
      if (transport !== 'stdio') {
        collector.add('error', 'MCP_TRANSPORT_UNSUPPORTED', 'mcp', `MCP ${serverName} 使用不支持的 transport：${String(transport)}`, source.file)
        continue
      }
      if (typeof config.command !== 'string' || config.command.trim() === '') {
        collector.add('error', 'MCP_COMMAND_MISSING', 'mcp', `MCP ${serverName} 缺少 command`, source.file)
        continue
      }
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(item => typeof item !== 'string'))) {
        collector.add('error', 'MCP_ARGS_INVALID', 'mcp', `MCP ${serverName} 的 args 必须是字符串数组`, source.file)
        continue
      }
      const env = parseEnvironment(config, source.file, pointer, collector, serverName)
      let cwd
      try {
        cwd = typeof config.cwd === 'string' ? parseCompatPath(config.cwd, 'plugin') : undefined
      } catch (error) {
        collector.add('error', 'MCP_CWD_INVALID', 'mcp', `MCP ${serverName} 的 cwd 无效：${String(error)}`, source.file)
        continue
      }
      servers.push({
        ...common,
        transport: 'stdio',
        command: parsePotentialSecretValue(config.command, source.file, `${pointer}/command`, false),
        args: (config.args as string[] | undefined ?? []).map((arg, index) =>
          parsePotentialSecretValue(arg, source.file, `${pointer}/args/${index}`, false)),
        env,
        ...(cwd === undefined ? {} : { cwd }),
      })
      collector.add('info', 'MCP_SERVER_DISCOVERED', 'mcp', `发现 MCP：${serverName}（stdio）`, source.file)
    }
  }
  return servers
}
