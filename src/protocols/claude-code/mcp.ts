import { resolve } from 'node:path'
import type { CompatMcpReconnect, CompatMcpServer } from '../../types/mcp.js'
import type { CompatRuntimeValue } from '../../types/path.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { readJson } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'
import { parseCompatPath } from './path.js'
import { escapeJsonPointer, parsePotentialSecretValue } from './template.js'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const EXTENSION_FIELDS = ['transport', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect', 'disabled']
const REJECTED_FIELDS = new Set(['command', 'args', 'env', 'env_vars', 'cwd', 'url', 'enabled', 'name', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'tool_timeout_sec', 'startup_timeout_sec', 'startup_timeout_ms', 'required', 'auth', 'oauth', 'oauth_resource', 'scopes', 'tools', 'default_tools_approval_mode', 'enabled_tools', 'disabled_tools', 'http_headers_helper', 'environment_id', 'startup_readiness', 'supports_parallel_tool_calls', 'tool_input_schema_max_bytes', 'omit_tools_from'])
const SERVER_FIELDS = new Set(['type', 'command', 'args', 'env', 'url', 'headers', 'headersHelper', 'oauth'])
const CRITICAL_FIELDS = new Set(['required', 'auth', 'oauth', 'oauth_resource', 'scopes', 'tools', 'default_tools_approval_mode', 'enabled_tools', 'disabled_tools', 'allowedTools', 'disallowedTools', 'allowed-tools', 'disallowed-tools', 'permissions', 'toolPermissions', 'headersHelper', 'http_headers_helper', 'environment_id', 'startup_readiness', 'omit_tools_from'])

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseReconnect(value: unknown): CompatMcpReconnect | undefined {
  const object = asObject(value)
  if (object === undefined) return undefined
  const maxAttempts = finiteNumber(object.maxAttempts)
  const initialDelayMs = finiteNumber(object.initialDelayMs)
  const maxDelayMs = finiteNumber(object.maxDelayMs)
  return {
    ...(typeof object.enabled === 'boolean' ? { enabled: object.enabled } : {}),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
  }
}

function parseServer(config: Record<string, unknown>, serverName: string, sourceFile: string, pointer: string, descriptor: HarnessDescriptor, collector: DiagnosticCollector): CompatMcpServer | undefined {
  const diagnosticStart = collector.items.length
  const fail = (code: string, message: string, field?: string): void => collector.add('error', code, 'mcp', `MCP ${serverName}：${message}`, sourceFile, field === undefined ? undefined : { field })
  for (const key of Object.keys(config)) {
    if (CRITICAL_FIELDS.has(key) || /auth|oauth|permission|approv|(?:allowed|disabled|enabled)[_-]?tools/i.test(key)) {
      // 显式认证和权限配置不能退化为 DSH 默认策略，包括空配置。
      fail(key.includes('tools') || /permission|approv|Tools/.test(key) ? 'MCP_TOOL_POLICY_UNSUPPORTED' : 'MCP_AUTH_OR_EXECUTION_UNSUPPORTED', `DSH 尚未适配字段 ${key} 的认证、权限或执行语义`, key)
    } else if (EXTENSION_FIELDS.includes(key) || key === 'cwd') {
      collector.add('warning', 'MCP_COMPAT_EXTENSION', 'mcp', `MCP ${serverName} 的 ${key} 作为 Plugin Bridge 扩展处理，不声明为 ${descriptor.format} 上游字段`, sourceFile, { field: key })
    } else if (!SERVER_FIELDS.has(key)) {
      const wrongPlatform = REJECTED_FIELDS.has(key)
      collector.add(wrongPlatform ? 'error' : 'warning', wrongPlatform ? 'MCP_PLATFORM_FIELD_UNSUPPORTED' : 'MCP_FIELD_UNSUPPORTED', 'mcp', `MCP ${serverName} 的字段 ${key} 不属于已适配的 ${descriptor.format} 配置`, sourceFile, { field: key })
    }
  }
  for (const key of ['enabled', 'disabled', 'required', 'failOnStartupError', 'supports_parallel_tool_calls']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') fail('MCP_FIELD_INVALID', `${key} 必须为 boolean`, key)
  }
  if (config.supports_parallel_tool_calls !== undefined || config.tool_input_schema_max_bytes !== undefined) {
    collector.add('warning', 'MCP_EXECUTION_HINT_UNSUPPORTED', 'mcp', `MCP ${serverName} 的并行/工具 schema 大小提示未适配`, sourceFile)
  }
  if (config.startup_timeout_sec !== undefined || config.startup_timeout_ms !== undefined) {
    for (const key of ['startup_timeout_sec', 'startup_timeout_ms']) {
      if (config[key] !== undefined && (finiteNumber(config[key]) === undefined || Number(config[key]) < 0)) fail('MCP_FIELD_INVALID', `${key} 必须为非负有限数值`, key)
    }
    collector.add('warning', 'MCP_STARTUP_TIMEOUT_UNSUPPORTED', 'mcp', `MCP ${serverName} 的启动超时无法精确映射到 dsh-mcp-client`, sourceFile)
  }
  const milliseconds = finiteNumber(config.toolCallTimeoutMs)
  if (config.toolCallTimeoutMs !== undefined && milliseconds === undefined) fail('MCP_TOOL_TIMEOUT_INVALID', 'toolCallTimeoutMs 必须为有限数值')
  const toolCallTimeoutMs = milliseconds
  if (toolCallTimeoutMs !== undefined && toolCallTimeoutMs <= 0) fail('MCP_TOOL_TIMEOUT_INVALID', '工具超时必须为正数')
  const transport = typeof config.transport === 'string' ? config.transport : typeof config.type === 'string' ? config.type : typeof config.url === 'string' ? 'streamable-http' : 'stdio'
  for (const key of ['transport', 'type']) if (config[key] !== undefined && typeof config[key] !== 'string') fail('MCP_FIELD_INVALID', `${key} 必须为 string`, key)
  const reconnect = parseReconnect(config.reconnect)
  const common = {
    serverName, sourceFormat: descriptor.format, sourceFile,
    environmentBindings: { CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root' },
    executionProfile: { mode: 'standard' },
    ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
    ...(typeof config.failOnStartupError === 'boolean' ? { failOnStartupError: config.failOnStartupError } : {}),
    ...(reconnect === undefined ? {} : { reconnect }),
  } as const
  const protect = (server: CompatMcpServer): CompatMcpServer => {
    const codes = collector.items.slice(diagnosticStart).filter(item => item.level === 'error').map(item => item.code)
    return codes.length === 0 ? server : { ...server, runtimeUnsupported: [...new Set(codes)] }
  }
  const runtimeValue = (value: string, fieldPointer: string, sensitive = true): CompatRuntimeValue => parsePotentialSecretValue(value, sourceFile, `${pointer}/${fieldPointer}`, sensitive)
  const stringMap = (field: string): Record<string, string> => {
    if (config[field] === undefined) return {}
    const object = asObject(config[field])
    if (object === undefined || Object.values(object).some(value => typeof value !== 'string')) {
      fail('MCP_MAP_INVALID', `${field} 必须为 string 到 string 的 map`, field)
      return {}
    }
    return object as Record<string, string>
  }
  if (transport === 'http' || transport === 'streamable-http' || transport === 'streamable_http') {
    if (typeof config.url !== 'string' || config.url.trim() === '') { fail('MCP_URL_MISSING', '缺少 url'); return undefined }
    for (const key of ['command', 'args', 'env', 'env_vars', 'cwd']) if (config[key] !== undefined) fail('MCP_TRANSPORT_FIELDS_INVALID', `HTTP transport 不支持 ${key}`, key)
    const headerField = 'headers'
    const headers: Record<string, CompatRuntimeValue> = Object.create(null)
    for (const [key, header] of Object.entries(stringMap(headerField))) {
      if (!HEADER_NAME_PATTERN.test(key) || /[\r\n\0]/.test(header)) { fail('MCP_HEADER_INVALID', 'HTTP Header 名称或值无效'); continue }
      const normalized = key.toLowerCase()
      if (headers[normalized] !== undefined) fail('MCP_HEADER_DUPLICATE', 'HTTP Header 名称存在大小写重复')
      headers[normalized] = runtimeValue(header, `${headerField}/${escapeJsonPointer(key)}`)
    }
    return protect({ ...common, transport: 'streamable-http', url: runtimeValue(config.url, 'url'), headers })
  }
  if (transport !== 'stdio') { fail('MCP_TRANSPORT_UNSUPPORTED', `transport ${transport} 尚未适配；dsh-mcp-client 只支持 stdio 与 streamable-http`); return undefined }
  for (const key of ['url', 'headers', 'http_headers', 'env_http_headers', 'bearer_token_env_var']) if (config[key] !== undefined) fail('MCP_TRANSPORT_FIELDS_INVALID', `stdio transport 不支持 ${key}`, key)
  if (typeof config.command !== 'string' || config.command.trim() === '') { fail('MCP_COMMAND_MISSING', '缺少 command'); return undefined }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(item => typeof item !== 'string'))) { fail('MCP_ARGS_INVALID', 'args 必须是字符串数组'); return undefined }
  const env: Record<string, CompatRuntimeValue> = Object.create(null)
  for (const [key, value] of Object.entries(stringMap('env'))) {
    if (!ENV_NAME_PATTERN.test(key)) { fail('MCP_ENV_NAME_INVALID', '环境变量名无效'); continue }
    env[key] = runtimeValue(value, `env/${escapeJsonPointer(key)}`)
  }
  let cwd
  if (config.cwd !== undefined && typeof config.cwd !== 'string') fail('MCP_CWD_INVALID', 'cwd 必须为字符串')
  try { cwd = typeof config.cwd === 'string' ? parseCompatPath(config.cwd, 'plugin') : undefined } catch { fail('MCP_CWD_INVALID', 'cwd 无法映射到 DSH 路径'); return undefined }
  return protect({ ...common, transport: 'stdio', command: runtimeValue(config.command, 'command', false),
    args: (config.args as string[] | undefined ?? []).map((arg, index) => runtimeValue(arg, `args/${index}`, false)), env,
    ...(cwd === undefined ? {} : { cwd }) })
}

export async function parseMcpForHarness(packageRoot: string, descriptor: HarnessDescriptor, collector: DiagnosticCollector): Promise<CompatMcpServer[]> {
  const servers: CompatMcpServer[] = []
  for (const source of descriptor.mcpSources) {
    if (/\.(?:mcpb|dxt)(?:[?#].*)?$/i.test(source.file)) {
      collector.add('error', 'MCP_BUNDLE_UNSUPPORTED', 'mcp', 'DSH 尚未适配 Claude Code MCP bundle 路径或 URL', source.file)
      continue
    }
    let raw: unknown
    try { raw = source.inline ?? await readJson(resolve(packageRoot, source.file)) } catch {
      collector.add('error', 'MCP_CONFIG_INVALID', 'mcp', 'MCP 配置无法读取或不是有效 JSON', source.file)
      continue
    }
    const root = asObject(raw)
    if (root === undefined) { collector.add('error', 'MCP_CONFIG_INVALID', 'mcp', 'MCP 配置顶层必须是对象', source.file); continue }
    if ('resources' in root) collector.add('warning', 'MCP_RESOURCE_UNSUPPORTED', 'mcp', '当前只接入 MCP Tool，资源声明不会注册', source.file)
    if ('prompts' in root) collector.add('warning', 'MCP_PROMPT_UNSUPPORTED', 'mcp', '当前只接入 MCP Tool，Prompt 声明不会注册', source.file)
    const camel = asObject(root.mcpServers)
    const snake = asObject(root.mcp_servers)
    if ((root.mcpServers !== undefined && camel === undefined) || (root.mcp_servers !== undefined && snake === undefined)) {
      collector.add('error', 'MCP_WRAPPER_INVALID', 'mcp', 'MCP server wrapper 必须为 map', source.file)
      continue
    }
    if (camel !== undefined && snake !== undefined) { collector.add('error', 'MCP_WRAPPER_AMBIGUOUS', 'mcp', 'MCP 配置不能同时声明 mcpServers 与 mcp_servers', source.file); continue }
    const wrapperName = camel !== undefined ? 'mcpServers' : snake !== undefined ? 'mcp_servers' : undefined
    const map = camel ?? snake ?? root
    const basePointer = `${source.pointer ?? ''}${wrapperName === undefined ? '' : `/${wrapperName}`}`
    for (const [serverName, value] of Object.entries(map)) {
      if (!SERVER_NAME_PATTERN.test(serverName)) { collector.add('error', 'MCP_SERVER_NAME_DSH_UNSUPPORTED', 'mcp', 'MCP serverName 不符合 DSH 约束且不会自动改名', source.file); continue }
      const config = asObject(value)
      if (config === undefined) { collector.add('error', 'MCP_SERVER_CONFIG_INVALID', 'mcp', `MCP ${serverName} 配置必须是对象`, source.file); continue }
      if (config.disabled === true) {
        collector.add('info', 'MCP_SERVER_DISABLED_BY_SOURCE', 'mcp', `MCP ${serverName} 在原配置中已禁用，跳过注册`, source.file)
        continue
      }
      try {
        const server = parseServer(config, serverName, source.file, `${basePointer}/${escapeJsonPointer(serverName)}`, descriptor, collector)
        if (server !== undefined) {
          servers.push(server)
          collector.add('info', 'MCP_SERVER_DISCOVERED', 'mcp', `发现 MCP：${serverName}（${server.transport}）`, source.file)
        }
      } catch {
        collector.add('error', 'MCP_TEMPLATE_UNSUPPORTED', 'mcp', `MCP ${serverName} 包含 DSH 未适配的模板引用`, source.file)
      }
    }
  }
  return servers
}
