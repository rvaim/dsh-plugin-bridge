import type { Events } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'

export interface LoggerLike {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface FiberLike extends PromiseLike<unknown> {
  dispose(): Promise<unknown> | unknown
}

export interface SkillRegistryLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => SkillProviderLike): () => void
}

export interface SkillProviderLike {
  name: string
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown[]> | unknown[]
  get(candidate: unknown, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown> | unknown
}

export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

export type HookEventName = 'agent/created' | 'agent/pre-step' | 'agent/turn-stopping'
  | 'tools/pre-execute' | 'tools/post-execute' | 'subagent/start'

export interface RuntimeServices {
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  sessionProjections: Pick<SessionProjectionRegistry, 'register' | 'stateOf'>
  workingDirectory: Pick<WorkingDirectoryService, 'get'>
  agents: Pick<AgentRegistry, 'get'>
  credentials: CredentialsLike
}

export interface DshContextLike extends Partial<RuntimeServices> {
  logger: LoggerLike
  skills?: SkillRegistryLike
  shell?: Pick<ShellExecutor, 'resolve' | 'execute'>
  /** Optional direct argv execution service; exec-form Hooks require it. */
  subprocess?: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  sessionProjections?: Pick<SessionProjectionRegistry, 'register' | 'stateOf'>
  workingDirectory?: Pick<WorkingDirectoryService, 'get'>
  agents?: Pick<AgentRegistry, 'get'>
  credentials?: CredentialsLike
  plugin?(plugin: unknown, config?: unknown): FiberLike
  get?<K extends keyof RuntimeServices>(name: K): RuntimeServices[K] | undefined
  on?<K extends HookEventName>(event: K, listener: Events[K]): unknown
  effect?(setup: () => void | (() => unknown), label?: string): unknown
}
