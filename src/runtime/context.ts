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

export interface DshContextLike {
  logger: LoggerLike
  skills?: SkillRegistryLike
  shell?: unknown
  /** Optional direct argv execution service; no shell fallback for exec-form Hooks. */
  subprocess?: {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
    spawn(spec: {
      argv: readonly string[]
      cwd: string
      stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
      graceMs: number
      signal?: AbortSignal
      env?: Record<string, string>
    }): {
      done: Promise<{ exitCode: number | null; signal?: string | null }>
      collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }; stderr?: { readFrom(offset: number): { text: string; lossy: boolean } } }
      terminate(): void
      waitForExit(signal?: AbortSignal): Promise<boolean>
    }
  }
  credentials?: CredentialsLike
  plugin?(plugin: unknown, config?: unknown): FiberLike
  on?(event: string, listener: (...args: any[]) => unknown): unknown
  effect?(setup: () => void | (() => unknown), label?: string): unknown
  get?(name: string): any
}
