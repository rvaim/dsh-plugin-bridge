import type { Context, Fiber, LoggerService } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SkillProvider, SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'

export type LoggerLike = Pick<LoggerService, 'warn'> & Partial<Pick<LoggerService, 'debug' | 'info' | 'error'>>
export type FiberLike = Pick<Fiber, 'dispose'> & PromiseLike<Fiber>
export type SkillRegistryLike = Pick<SkillRegistry, 'registerProvider'>
export type SkillProviderLike = SkillProvider
export type CredentialsLike = Pick<CredentialProvider, 'resolve'>

export type HookEventName = 'agent/created' | 'agent/pre-step' | 'agent/turn-stopping'
  | 'tools/pre-execute' | 'tools/post-execute' | 'subagent/start'

/** Only the SDK service members consumed by runtime adapters. */
export interface RuntimeServices {
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  sessionProjections: Pick<SessionProjectionRegistry, 'register' | 'stateOf'>
  workingDirectory: Pick<WorkingDirectoryService, 'get'>
  agents: Pick<AgentRegistry, 'get'>
  credentials: CredentialsLike
}

/** Cordis owns mounting, effects and typed optional-service lookup. */
export interface DshContextLike extends Pick<Context, 'plugin' | 'on' | 'effect'>, Partial<RuntimeServices> {
  logger: LoggerLike
  skills?: SkillRegistryLike
  shell?: Pick<ShellExecutor, 'resolve' | 'execute'>
  /** Narrow typed Context.get overload, without its untyped string-name fallback. */
  get<K extends keyof RuntimeServices>(name: K, strict?: Parameters<Context['get']>[1]): RuntimeServices[K] | undefined
}
