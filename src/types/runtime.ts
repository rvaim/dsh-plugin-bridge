export type PluginRuntimeStatus = 'disabled' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopping'

export interface CapabilityRuntimeHealth {
  capability: 'skill' | 'mcp' | 'hook' | 'command' | 'agent'
  name: string
  status: 'running' | 'degraded' | 'failed' | 'disabled'
  message?: string
}

export interface PluginRuntimeSnapshot {
  pluginId: string
  status: PluginRuntimeStatus
  startedAt?: string
  stoppedAt?: string
  error?: string
  capabilities: CapabilityRuntimeHealth[]
}
