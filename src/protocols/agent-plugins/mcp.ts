import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CompatMcpServer } from '../../types/mcp.js'
import type { CompatDeferredJsonValue, CompatRuntimeValue } from '../../types/path.js'
import {
  assertConfiguredHeadersSupported, parseAnchoredCwd, resolveContainedCommand,
  validateExecutableToken, validateCwdAtScan, validateProcessEnvironment,
  validateHttpHeaders, validateEndpointUrl,
} from '../../shared/mcp-execution.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { deferredPluginValue, escapeJsonPointer, PATH_BINDINGS } from './template.js'
import { inspectContainedPath } from '../../shared/contained-path.js'
import { validateAgentMcpEnvelope, validateAgentMcpServer } from './schema.js'

const MCP_FILE = 'mcp.json'
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Keep all package values out of scan.json, including opaque args and URLs. */
function deferred(pointer: string, expansion: 'exact-plugin-vars' | 'none'): CompatDeferredJsonValue {
  return deferredPluginValue(MCP_FILE, pointer, expansion)
}

/** Agent Plugins 1.0.0 has a fixed location and independent failure boundaries. */
export async function parseAgentPluginMcp(root: string, collector: DiagnosticCollector): Promise<CompatMcpServer[]> {
  const warning = (code: string, message: string, serverName?: string): void => collector.add(
    'warning', code, 'mcp', message, MCP_FILE, serverName === undefined ? undefined : { serverName },
  )
  try {
    if (!(await readdir(root)).includes(MCP_FILE)) return []
  } catch {
    warning('AGENT_PLUGINS_MCP_LOCATION_INVALID', 'Agent Plugins MCP 根目录无法读取；仅禁用 MCP')
    return []
  }
  const location = await inspectContainedPath(root, resolve(root, MCP_FILE), 'file')
  if (location.status === 'missing') return []
  if (location.status !== 'ok') {
    warning('AGENT_PLUGINS_MCP_LOCATION_INVALID', 'Agent Plugins mcp.json 必须解析为插件根目录内的实际文件；仅禁用 MCP')
    return []
  }
  let raw: unknown
  try { raw = JSON.parse(await readFile(location.path, 'utf8')) as unknown } catch {
    warning('AGENT_PLUGINS_MCP_JSON_INVALID', 'Agent Plugins mcp.json 无法读取或不是有效 JSON；仅禁用 MCP')
    return []
  }
  if (!validateAgentMcpEnvelope(raw)) {
    warning('AGENT_PLUGINS_MCP_ENVELOPE_INVALID', 'Agent Plugins mcp.json 顶层字段或 $schema 不符合 1.0.0；仅禁用 MCP')
    return []
  }
  const servers: CompatMcpServer[] = []
  const map = (raw as { mcpServers: Record<string, unknown> }).mcpServers
  for (const [serverName, value] of Object.entries(map)) {
    if (!validateAgentMcpServer(value)) {
      warning('AGENT_PLUGINS_MCP_SERVER_INVALID', 'Agent Plugins MCP entry 不符合声明 transport 的封闭 schema；跳过此 entry', serverName)
      continue
    }
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      warning('AGENT_PLUGINS_MCP_SERVER_NAME_UNSUPPORTED', 'Agent Plugins MCP entry 名称不符合 DSH serverName 约束；跳过此 entry', serverName)
      continue
    }
    const config = value as {
      type: 'stdio' | 'streamable-http' | 'sse'; command?: string; args?: string[];
      env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>
    }
    const pointer = `/mcpServers/${escapeJsonPointer(serverName)}`
    const common = { serverName, sourceFormat: 'agent-plugins', sourceFile: MCP_FILE, environmentBindings: { ...PATH_BINDINGS }, executionProfile: { mode: 'contained' } } as const
    if (config.type === 'stdio') {
      try {
        const commandBase = validateExecutableToken(config.command!)
        await resolveContainedCommand(root, config.command!)
        validateProcessEnvironment(config.env ?? {}, PATH_BINDINGS)
        const cwd = parseAnchoredCwd(config.cwd, PATH_BINDINGS)
        await validateCwdAtScan(root, cwd, PATH_BINDINGS)
        const env: Record<string, CompatRuntimeValue> = Object.fromEntries(Object.keys(config.env ?? {}).map(name => [name, deferred(`${pointer}/env/${escapeJsonPointer(name)}`, 'exact-plugin-vars')]))
        servers.push({
          ...common, transport: 'stdio', command: deferred(`${pointer}/command`, 'none'),
          ...(commandBase === 'plugin' ? { commandBase: 'plugin' } : {}),
          args: (config.args ?? []).map((_value, index) => deferred(`${pointer}/args/${index}`, 'exact-plugin-vars')),
          env, cwd,
        })
      } catch {
        warning('AGENT_PLUGINS_MCP_STDIO_INVALID', 'Agent Plugins stdio command、cwd 或 env 无效或逃逸声明根目录；跳过此 entry', serverName)
      }
      continue
    }
    try {
      validateEndpointUrl(config.url!)
      validateHttpHeaders(config.headers ?? {})
    } catch {
      warning('AGENT_PLUGINS_MCP_HTTP_INVALID', 'Agent Plugins MCP URL 或 HTTP headers 不符合 portable 要求；跳过此 entry', serverName)
      continue
    }
    if (config.type === 'sse') {
      warning('AGENT_PLUGINS_MCP_TRANSPORT_UNSUPPORTED', 'Agent Plugins sse transport 合法，但当前 DSH MCP client 尚未支持；跳过此 entry', serverName)
      continue
    }
    try { assertConfiguredHeadersSupported(config.headers ?? {}) } catch {
      warning('AGENT_PLUGINS_MCP_HEADERS_UNSUPPORTED', '此 Agent Plugins HTTP entry 的 configured headers 合法，但当前 DSH 无跨 origin 重定向控制；暂不运行此 entry', serverName)
      continue
    }
    servers.push({ ...common, transport: 'streamable-http', url: deferred(`${pointer}/url`, 'none'), headers: {} })
  }
  return servers
}
