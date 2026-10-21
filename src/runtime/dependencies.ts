import type { HookOutput, MergedHookOutcome } from '@deepseek-ai/dsh-hook-protocol'

export type HookOutputLike = HookOutput
export type MergedHookOutcomeLike = MergedHookOutcome

export type HookProtocolLike = Pick<typeof import('@deepseek-ai/dsh-hook-protocol'),
  'DEFAULT_HOOK_TIMEOUT_MS' | 'DEFAULT_STDERR_SUMMARY_MAX_CHARS' | 'createDetachedRuns'
  | 'runHook' | 'mergeHookOutputs'>

export interface RuntimeDependencies {
  loadMcpClient(): Promise<unknown>
  loadHookProtocol(): Promise<HookProtocolLike>
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  async loadMcpClient(): Promise<unknown> {
    return await import('@deepseek-ai/dsh-mcp-client')
  },
  async loadHookProtocol(): Promise<HookProtocolLike> {
    return await import('@deepseek-ai/dsh-hook-protocol')
  },
}
