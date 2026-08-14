import type { CompatPluginEnvironmentMode } from './environment.js'
import type { CompatPath, CompatRuntimeValue } from './path.js'

export interface CompatMcpReconnect {
  enabled?: boolean
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export interface CompatMcpBase {
  serverName: string
  sourceFormat: 'claude-code' | 'codex'
  sourceFile: string
  environmentMode: CompatPluginEnvironmentMode
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: CompatMcpReconnect
}

export interface CompatMcpStdio extends CompatMcpBase {
  transport: 'stdio'
  command: CompatRuntimeValue
  args: CompatRuntimeValue[]
  env: Record<string, CompatRuntimeValue>
  cwd?: CompatPath
}

export interface CompatMcpHttp extends CompatMcpBase {
  transport: 'streamable-http'
  url: CompatRuntimeValue
  headers: Record<string, CompatRuntimeValue>
}

export type CompatMcpServer = CompatMcpStdio | CompatMcpHttp
