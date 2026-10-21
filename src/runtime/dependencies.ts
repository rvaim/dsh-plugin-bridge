import type { Plugin } from '@deepseek-ai/cordis'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'
import type { HookOutput, MergedHookOutcome } from '@deepseek-ai/dsh-hook-protocol'

export type HookOutputLike = HookOutput
export type MergedHookOutcomeLike = MergedHookOutcome

export type HookProtocolLike = Pick<typeof import('@deepseek-ai/dsh-hook-protocol'),
  'DEFAULT_HOOK_TIMEOUT_MS' | 'DEFAULT_STDERR_SUMMARY_MAX_CHARS' | 'createDetachedRuns'
  | 'runHook' | 'mergeHookOutputs'>

/** Keep the SDK's exact apply/config schema together, including its declared schema output type. */
export type McpClientPlugin = Pick<typeof import('@deepseek-ai/dsh-mcp-client'), 'apply' | 'Config'>
  & Omit<Plugin.Object<McpConfig>, 'apply' | 'Config'>

export interface RuntimeDependencies {
  loadMcpClient(): Promise<McpClientPlugin>
  loadHookProtocol(): Promise<HookProtocolLike>
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  async loadMcpClient(): Promise<McpClientPlugin> {
    return await import('@deepseek-ai/dsh-mcp-client')
  },
  async loadHookProtocol(): Promise<HookProtocolLike> {
    return await import('@deepseek-ai/dsh-hook-protocol')
  },
}
