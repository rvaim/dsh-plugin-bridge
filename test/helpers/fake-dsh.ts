import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, pluginRecordOf, type PluginRecordMap, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as hookProtocol from '@deepseek-ai/dsh-hook-protocol'
import type { ShellExecSpec, ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { DshContextLike, FiberLike, LoggerLike, RuntimeServices, SkillProviderLike } from '../../src/runtime/context.js'
import type { HookOutputLike, RuntimeDependencies } from '../../src/runtime/dependencies.js'

const sessionRecords = new WeakMap<Session, SessionEvent[]>()

/** Real current SDK sessions without persistence, processes, or user state. */
export function createTestSession(cwd: string, id = 'session-1', turn = 1): Session {
  const ctx = new Context()
  new SessionStore(ctx)
  const records: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { records.push(event) })
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  sessionRecords.set(session, records)
  if (turn > 0) session.append('turn/start', { turn })
  return session
}

export function recordedSessionEvents(session: Session): readonly SessionEvent[] {
  return sessionRecords.get(session) ?? []
}

export function recordedPluginData<K extends keyof PluginRecordMap>(session: Session, type: K): PluginRecordMap[K][] {
  return recordedSessionEvents(session).map(pluginRecordOf)
    .filter(record => record?.type === type).map(record => record!.data as PluginRecordMap[K])
}

export function fakeShellResult(stdout = '', exitCode = 0): ShellRunResult {
  return { exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 600_000,
    stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
}

/** Deterministic Shell implementation using the current resolve/execute/result contract. */
export function createFakeShell(run: (spec: ShellExecSpec) => Promise<ShellRunResult>): Pick<ShellExecutor, 'resolve' | 'execute'> {
  return {
    resolve(request) {
      return { ...request, workdir: request.workdir ?? '/fixture', timeoutMs: request.timeoutMs ?? 600_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 1_048_576, onExpiry: request.onExpiry ?? 'kill', sandboxPolicy: request.sandboxPolicy }
    },
    async execute(spec) {
      let settled: ShellRunResult | undefined
      let failed = false
      const result = Promise.resolve().then(() => run(spec)).then(value => { settled = value; return value }, error => { failed = true; throw error })
      const read = (stream: 'stdout' | 'stderr', offset: number) => {
        const output = settled?.[stream]
        return { text: output?.text.slice(offset) ?? '', nextOffset: output?.text.length ?? offset, lossy: output?.truncated ?? false }
      }
      const execution: ShellExecution = {
        get status() { return failed || settled?.exitCode === null ? 'killed' : settled === undefined ? 'running' : 'completed' },
        get exitCode() { return settled?.exitCode ?? null },
        get signal() { return settled?.signal ?? null },
        done: result.then(() => {}, () => {}),
        observed: { stdout: { readFrom: offset => read('stdout', offset) }, stderr: { readFrom: offset => read('stderr', offset) } },
        readOutput() { return { delta: '', lossy: false } },
        kill() { return settled === undefined && !failed },
        result: () => result,
      }
      return execution
    },
  }
}

interface ListenerRecord {
  owner: FakeContext
  listener: (...args: any[]) => unknown
}

interface SharedState {
  listeners: Map<string, ListenerRecord[]>
  providers: Map<string, SkillProviderLike>
  providerControllers: Map<string, AbortController>
  logs: string[]
  credentials: Map<string, string>
  mcpConfigs: Map<string, Record<string, unknown>>
  tools: Set<string>
  hookRuns: Array<{ hook: hookProtocol.CommandHook; options: hookProtocol.RunHookOptions }>
  subprocessSpawns: SubprocessSpawnSpec[]
  agents: Map<SessionId, import('@deepseek-ai/dsh-agent').Agent>
}

class FakeFiber implements FiberLike {
  constructor(private readonly ready: Promise<unknown>, private readonly context: FakeContext) {}

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.ready.then(onfulfilled, onrejected)
  }

  async dispose(): Promise<void> {
    try { await this.ready } catch { /* Failed setup still needs to release its registrations. */ }
    await this.context.dispose()
  }
}

export class FakeContext implements DshContextLike {
  readonly logger: LoggerLike
  readonly shell = createFakeShell(async spec => resultForCommand(spec.command, spec.stdin))
  readonly sessionProjections = new SessionProjectionRegistry(new Context())
  readonly agents: SharedState['agents']
  readonly credentials: { resolve(ref: string): Promise<{ value: string; source: string } | undefined> }
  readonly skills: {
    registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => SkillProviderLike): () => void
  }
  readonly subprocess: NonNullable<DshContextLike['subprocess']>
  private readonly effects: Array<() => unknown> = []
  private readonly children: FakeFiber[] = []
  private disposed = false

  constructor(readonly shared: SharedState = createSharedState()) {
    this.agents = shared.agents
    this.logger = {
      warn: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      info: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      debug: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
    }
    this.credentials = {
      resolve: async ref => {
        const value = shared.credentials.get(ref)
        return value === undefined ? undefined : { value, source: 'fake' }
      },
    }
    this.subprocess = {
      async resolveExecutable(command) { return command },
      spawn(spec) {
        shared.subprocessSpawns.push(spec)
        const stdin = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined
        const result = resultForCommand(spec.argv[0], stdin)
        const read = (stream: 'stdout' | 'stderr', offset: number) => ({
          text: result[stream].text.slice(offset), nextOffset: result[stream].text.length, lossy: result[stream].truncated,
        })
        return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
          collected: { stdout: { readFrom: offset => read('stdout', offset) }, stderr: { readFrom: offset => read('stderr', offset) } },
          done: Promise.resolve({ exitCode: result.exitCode, signal: result.signal }),
          terminate() {}, async waitForExit() { return true } }
      },
    }
    this.skills = {
      registerProvider: create => {
        const controller = new AbortController()
        const provider = create({ signal: controller.signal, invalidate() {} })
        if (shared.providers.has(provider.name)) throw new Error(`重复 provider：${provider.name}`)
        shared.providers.set(provider.name, provider)
        shared.providerControllers.set(provider.name, controller)
        let active = true
        const dispose = (): void => {
          if (!active) return
          active = false
          shared.providers.delete(provider.name)
          shared.providerControllers.delete(provider.name)
          controller.abort(new Error('provider disposed'))
        }
        this.effects.push(dispose)
        return dispose
      },
    }
  }

  static create(): FakeContext { return new FakeContext() }

  plugin(plugin: unknown, config?: unknown): FiberLike {
    const child = new FakeContext(this.shared)
    const module = plugin as { apply?: (ctx: FakeContext, config: unknown) => unknown; default?: unknown }
    const actual = module.apply === undefined && module.default !== undefined ? module.default as typeof module : module
    const ready = Promise.resolve().then(async () => {
      if (typeof actual === 'function') await (actual as unknown as (ctx: FakeContext, config: unknown) => unknown)(child, config)
      else if (typeof actual.apply === 'function') await actual.apply(child, config)
      else throw new Error('伪 Cordis 收到无 apply 的插件模块')
    })
    const fiber = new FakeFiber(ready, child)
    this.children.push(fiber)
    return fiber
  }

  on(event: string, listener: (...args: any[]) => unknown): () => void {
    const list = this.shared.listeners.get(event) ?? []
    const record = { owner: this, listener }
    list.push(record)
    this.shared.listeners.set(event, list)
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      const current = this.shared.listeners.get(event) ?? []
      this.shared.listeners.set(event, current.filter(item => item !== record))
    }
    this.effects.push(dispose)
    return dispose
  }

  effect(setup: () => void | (() => unknown)): unknown {
    const dispose = setup()
    if (typeof dispose === 'function') this.effects.push(dispose)
    return dispose
  }

  get<K extends keyof RuntimeServices>(name: K): RuntimeServices[K] | undefined {
    const services: Partial<RuntimeServices> = {
      subprocess: this.subprocess, sessionProjections: this.sessionProjections, agents: this.agents, credentials: this.credentials,
    }
    return services[name]
  }

  async emit(event: string, ...args: any[]): Promise<void> {
    for (const record of [...this.shared.listeners.get(event) ?? []]) await record.listener(...args)
  }

  async intercept(event: string, args: any[], terminal: () => Promise<any>): Promise<any> {
    const listeners = [...this.shared.listeners.get(event) ?? []]
    const dispatch = async (index: number): Promise<any> => {
      const current = listeners[index]
      if (current === undefined) return await terminal()
      return await current.listener(...args, () => dispatch(index + 1))
    }
    return await dispatch(0)
  }

  async listSkills(): Promise<any[]> {
    const result: any[] = []
    for (const provider of this.shared.providers.values()) result.push(...await provider.list({}))
    return result
  }

  async getSkill(name: string): Promise<any | undefined> {
    for (const provider of this.shared.providers.values()) {
      const candidates = await provider.list({}) as any[]
      const candidate = candidates.find(item => item.name === name)
      if (candidate !== undefined) return await provider.get(candidate, {})
    }
    return undefined
  }

  setCredential(name: string, value: string): void { this.shared.credentials.set(name, value) }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children].reverse()) await child.dispose()
    for (const dispose of [...this.effects].reverse()) await dispose()
  }
}

function createSharedState(): SharedState {
  return { listeners: new Map(), providers: new Map(), providerControllers: new Map(), logs: [], credentials: new Map(),
    mcpConfigs: new Map(), tools: new Set(), hookRuns: [], subprocessSpawns: [], agents: new Map() }
}

function outputForCommand(command: string): HookOutputLike {
  if (command.startsWith('deny:')) return { exitCode: 0, stdout: '', stderr: '', decision: 'deny', reason: command.slice(5) }
  if (command.startsWith('ask:')) return { exitCode: 0, stdout: '', stderr: '', decision: 'ask', reason: command.slice(4) }
  if (command.startsWith('allow:')) return { exitCode: 0, stdout: '', stderr: '', decision: 'allow', reason: command.slice(6) }
  if (command.startsWith('context:')) return { exitCode: 0, stdout: '', stderr: '', additionalContext: command.slice(8) }
  if (command.startsWith('stdout:')) return { exitCode: 0, stdout: command.slice(7), stderr: '' }
  if (command.startsWith('stop:')) return { exitCode: 0, stdout: '', stderr: '', continue: false, stopReason: command.slice(5) }
  return { exitCode: 0, stdout: '', stderr: '' }
}

function resultForCommand(command: string, stdin?: string): ShellRunResult {
  const output = outputForCommand(command)
  if (output.stdout !== '' || (output.decision === undefined && output.additionalContext === undefined && output.continue === undefined)) {
    return fakeShellResult(output.stdout)
  }
  const payload = stdin === undefined ? {} : JSON.parse(stdin)
  return fakeShellResult(JSON.stringify({
    ...(output.continue === undefined ? {} : { continue: output.continue, stopReason: output.stopReason }),
    hookSpecificOutput: { hookEventName: payload.hook_event_name,
      ...(output.decision === undefined ? {} : { permissionDecision: output.decision, permissionDecisionReason: output.reason }),
      ...(output.additionalContext === undefined ? {} : { additionalContext: output.additionalContext }),
    },
  }))
}

export function fakeRuntimeDependencies(shared: SharedState): RuntimeDependencies {
  return {
    async loadHookProtocol() {
      return { ...hookProtocol,
        async runHook(shell, hook, options, now) {
          shared.hookRuns.push({ hook, options })
          return await hookProtocol.runHook(shell, hook, options, now)
        },
      }
    },
    async loadMcpClient() {
      return {
        name: 'fake-mcp-client',
        apply(ctx: FakeContext, config: Record<string, unknown>) {
          const serverName = String(config.serverName)
          if (shared.mcpConfigs.has(serverName)) throw new Error(`重复 MCP：${serverName}`)
          const command = String(config.command ?? '')
          if (command.includes('leak-config')) throw new Error(`故障注入配置：${JSON.stringify(config)}`)
          if (command.includes('fail-mcp')) throw new Error('故障注入：MCP 启动失败')
          shared.mcpConfigs.set(serverName, config)
          shared.tools.add(`mcp__${serverName}__fixture`)
          ctx.effect(() => () => { shared.mcpConfigs.delete(serverName); shared.tools.delete(`mcp__${serverName}__fixture`) })
          if (command.includes('partial-fail-mcp')) throw new Error('故障注入：部分注册后失败')
        },
      }
    },
  }
}
