export interface HookProtocolLike {
  DEFAULT_HOOK_TIMEOUT_MS?: number
  DEFAULT_STDERR_SUMMARY_MAX_CHARS?: number
  createDetachedRuns(): {
    readonly signal: AbortSignal
    track(run: Promise<unknown>): void
    drain(): Promise<void>
  }
  appendHookInvoked?(session: unknown, data: Record<string, unknown>): void
  appendHookResult?(session: unknown, data: Record<string, unknown>): void
  runHook(
    shell: unknown,
    hook: { command: string; timeoutSec?: number },
    options: {
      payload: unknown
      env?: Record<string, string>
      cwd?: string
      signal: AbortSignal
      trailingNewline: boolean
      defaultTimeoutMs: number
      expectedEventName?: string
    },
    now: () => number,
  ): Promise<{ output: HookOutputLike; durationMs: number }>
  matchesMatcher(matcher: string | undefined, query: string, mode: 'claude-code' | 'codex'): boolean
  mergeHookOutputs(outputs: HookOutputLike[]): MergedHookOutcomeLike
}

export interface HookOutputLike {
  exitCode?: number
  stderr?: string
  stdout?: string
  hookEventName?: string
  decision?: 'deny' | 'block' | 'ask' | 'approve' | 'allow'
  reason?: string
  continue?: boolean
  stopReason?: string
  additionalContext?: string
  systemMessage?: string
  updatedInput?: unknown
}

export interface MergedHookOutcomeLike {
  decision: 'deny' | 'ask' | 'allow' | 'none'
  reason?: string
  stop: boolean
  stopReason?: string
  additionalContext: string[]
  systemMessages: string[]
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
