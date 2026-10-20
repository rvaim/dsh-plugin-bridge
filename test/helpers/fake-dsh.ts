import type { DshContextLike, FiberLike, LoggerLike, SkillProviderLike } from '../../src/runtime/context.js'
import type { HookOutputLike, HookProtocolLike, MergedHookOutcomeLike, RuntimeDependencies } from '../../src/runtime/dependencies.js'

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
  hookInvoked: Record<string, unknown>[]
  hookResults: Record<string, unknown>[]
  hookRuns: Array<{
    hook: { command: string; timeoutSec?: number; args?: readonly string[] }
    options: {
      payload: unknown
      env?: Record<string, string>
      cwd?: string
      signal: AbortSignal
      trailingNewline: boolean
      defaultTimeoutMs: number
      expectedEventName?: string
    }
  }>
  agents: Map<string, unknown>
}

class FakeFiber implements FiberLike {
  constructor(
    private readonly ready: Promise<unknown>,
    private readonly context: FakeContext,
  ) {}

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.ready.then(onfulfilled, onrejected)
  }

  async dispose(): Promise<void> {
    try { await this.ready } catch { /* 启动失败的 Fiber 仍需清理已注册资源。 */ }
    await this.context.dispose()
  }
}

export class FakeContext implements DshContextLike {
  readonly logger: LoggerLike
  readonly shell = {}
  readonly credentials: { resolve(ref: string): Promise<{ value: string; source: string } | undefined> }
  readonly skills: {
    registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => SkillProviderLike): () => void
  }
  private readonly effects: Array<() => unknown> = []
  private readonly children: FakeFiber[] = []
  private disposed = false

  constructor(readonly shared: SharedState = createSharedState()) {
    this.logger = {
      warn: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      info: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
      debug: (...args: unknown[]) => shared.logs.push(args.map(String).join(' ')),
    }
    this.credentials = {
      resolve: async (ref: string) => {
        const value = shared.credentials.get(ref)
        return value === undefined ? undefined : { value, source: 'fake' }
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

  static create(): FakeContext {
    return new FakeContext()
  }

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

  get(name: string): any {
    if (name === 'credentials') return this.credentials
    if (name === 'skills') return this.skills
    if (name === 'agents') return this.shared.agents
    return undefined
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

  setCredential(name: string, value: string): void {
    this.shared.credentials.set(name, value)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children].reverse()) await child.dispose()
    for (const dispose of [...this.effects].reverse()) await dispose()
  }
}

function createSharedState(): SharedState {
  return {
    listeners: new Map(),
    providers: new Map(),
    providerControllers: new Map(),
    logs: [],
    credentials: new Map(),
    mcpConfigs: new Map(),
    tools: new Set(),
    hookInvoked: [],
    hookResults: [],
    hookRuns: [],
    agents: new Map(),
  }
}

function mergeHookOutputs(outputs: HookOutputLike[]): MergedHookOutcomeLike {
  let rank = 0
  const reasons = new Map<number, string[]>()
  let stop = false
  let stopReason: string | undefined
  const additionalContext: string[] = []
  const systemMessages: string[] = []
  for (const output of outputs) {
    const current = output.decision === 'deny' || output.decision === 'block'
      ? 3
      : output.decision === 'ask'
        ? 2
        : output.decision === 'allow' || output.decision === 'approve'
          ? 1
          : 0
    rank = Math.max(rank, current)
    if (current >= 2 && output.reason) reasons.set(current, [...reasons.get(current) ?? [], output.reason])
    if (output.continue === false && !stop) {
      stop = true
      stopReason = output.stopReason
    }
    if (output.additionalContext) additionalContext.push(output.additionalContext)
    if (output.systemMessage) systemMessages.push(output.systemMessage)
  }
  return {
    decision: rank === 3 ? 'deny' : rank === 2 ? 'ask' : rank === 1 ? 'allow' : 'none',
    ...((reasons.get(rank)?.length ?? 0) > 0 ? { reason: reasons.get(rank)?.join('\n\n') } : {}),
    stop,
    ...(stopReason === undefined ? {} : { stopReason }),
    additionalContext,
    systemMessages,
  }
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

export function fakeRuntimeDependencies(shared: SharedState): RuntimeDependencies {
  const hookProtocol: HookProtocolLike = {
    DEFAULT_HOOK_TIMEOUT_MS: 600_000,
    DEFAULT_STDERR_SUMMARY_MAX_CHARS: 500,
    createDetachedRuns() {
      const controller = new AbortController()
      const pending = new Set<Promise<unknown>>()
      return {
        signal: controller.signal,
        track(run) {
          pending.add(run)
          const settled = (): void => { pending.delete(run) }
          run.then(settled, settled)
        },
        async drain() {
          controller.abort(new Error('fake Hook bridge disposed'))
          while (pending.size > 0) await Promise.allSettled([...pending])
        },
      }
    },
    appendHookInvoked(_session, data) { shared.hookInvoked.push(data) },
    appendHookResult(_session, data) { shared.hookResults.push(data) },
    mergeHookOutputs,
    async runHook(_shell, hook, options) {
      shared.hookRuns.push({ hook, options })
      return { output: outputForCommand(hook.command), durationMs: 1 }
    },
  }
  return {
    async loadHookProtocol() { return hookProtocol },
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
          ctx.effect(() => () => {
            shared.mcpConfigs.delete(serverName)
            shared.tools.delete(`mcp__${serverName}__fixture`)
          })
          if (command.includes('partial-fail-mcp')) throw new Error('故障注入：部分注册后失败')
        },
      }
    },
  }
}
