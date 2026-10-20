import type {
  CommandHook,
  DetachedRuns,
  HookOutput,
  MergedHookOutcome,
  RunHookOptions,
  RunHookResult,
} from '@deepseek-ai/dsh-hook-protocol'

export type HookOutputLike = HookOutput
export type MergedHookOutcomeLike = MergedHookOutcome

export interface HookProtocolLike {
  DEFAULT_HOOK_TIMEOUT_MS?: number
  DEFAULT_STDERR_SUMMARY_MAX_CHARS?: number
  createDetachedRuns(): DetachedRuns
  appendHookInvoked?(session: unknown, data: Record<string, unknown>): void
  appendHookResult?(session: unknown, data: Record<string, unknown>): void
  runHook(
    shell: unknown,
    hook: CommandHook & { args?: readonly string[] },
    options: RunHookOptions,
    now: () => number,
  ): Promise<RunHookResult>
  mergeHookOutputs(outputs: HookOutputLike[]): MergedHookOutcomeLike
}

export interface RuntimeDependencies {
  loadMcpClient(): Promise<unknown>
  loadHookProtocol(): Promise<HookProtocolLike>
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  async loadMcpClient(): Promise<unknown> {
    return await import('@deepseek-ai/dsh-mcp-client')
  },
  async loadHookProtocol(): Promise<HookProtocolLike> {
    return await import('@deepseek-ai/dsh-hook-protocol') as unknown as HookProtocolLike
  },
}
