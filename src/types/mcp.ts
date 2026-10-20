import type { CompatPluginEnvironmentBindings } from './environment.js'
import type { CompatFormat } from './plugin.js'
import type { CompatPath, CompatRuntimeValue } from './path.js'

export interface CompatMcpReconnect {
  enabled?: boolean
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export interface CompatMcpExecutionProfile {
  /** contained 校验真实根、限制命令与 URL，并仅展开精确路径变量。 */
  mode: 'contained' | 'standard'
}

export interface CompatMcpBase {
  serverName: string
  /** 来源仅用于元数据与诊断，不参与运行决策。 */
  sourceFormat: CompatFormat
  sourceFile: string
  /** 解析协议显式提供路径变量绑定；省略时不注入任何路径变量。 */
  environmentBindings?: CompatPluginEnvironmentBindings
  /** 省略时使用标准执行语义，不从 sourceFormat 推断。 */
  executionProfile?: CompatMcpExecutionProfile
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: CompatMcpReconnect
  /** 扫描已发现无法兑现的认证/权限语义，挂载时必须拒绝。 */
  runtimeUnsupported?: string[]
}

export interface CompatMcpStdio extends CompatMcpBase {
  transport: 'stdio'
  command: CompatRuntimeValue
  commandBase?: 'plugin'
  args: CompatRuntimeValue[]
  env: Record<string, CompatRuntimeValue>
  cwd?: CompatPath
}

export interface CompatMcpHttp extends CompatMcpBase {
  transport: 'streamable-http'
  url: CompatRuntimeValue
  headers: Record<string, CompatRuntimeValue>
  /** 非空的环境 Header 值覆盖静态 Header。 */
  envHeaders?: Record<string, CompatRuntimeValue>
  /** 最后覆盖 Authorization 的 bearer token 引用。 */
  bearerToken?: CompatRuntimeValue
}

export type CompatMcpServer = CompatMcpStdio | CompatMcpHttp
