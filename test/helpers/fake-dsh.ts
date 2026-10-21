import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, pluginRecordOf, type PluginRecordMap, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { Config as McpConfigSchema, type Config as McpConfig, type StdioConfig, type StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import * as hookProtocol from '@deepseek-ai/dsh-hook-protocol'
import type { ShellExecSpec, ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { DshContextLike, RuntimeServices } from '../../src/runtime/context.js'
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

/** Read-only observation view; mounted configs still use the official discriminated union. */
type RecordedMcpConfig = McpConfig & Partial<Omit<StdioConfig, 'transport'> & Omit<StreamableHttpConfig, 'transport'>>

interface SharedState {
  providers: Map<string, SkillProvider>
  logs: string[]
  credentials: Map<string, string>
  mcpConfigs: Map<string, RecordedMcpConfig>
  tools: Set<string>
  hookRuns: Array<{ hook: hookProtocol.CommandHook; options: hookProtocol.RunHookOptions }>
  subprocessSpawns: SubprocessSpawnSpec[]
  agents: Map<SessionId, import('@deepseek-ai/dsh-agent').Agent>
}

class ObservedSkillRegistry extends SkillRegistry {
  constructor(ctx: Context, private readonly shared: SharedState) { super(ctx) }

  override registerProvider(create: Parameters<SkillRegistry['registerProvider']>[0]): ReturnType<SkillRegistry['registerProvider']> {
    return super.registerProvider(control => {
      const provider = create(control)
      if (this.shared.providers.has(provider.name)) throw new Error(`重复 provider：${provider.name}`)
      this.shared.providers.set(provider.name, provider)
      control.signal.addEventListener('abort', () => {
        if (this.shared.providers.get(provider.name) === provider) this.shared.providers.delete(provider.name)
      }, { once: true })
      return provider
    })
  }
}

/** Real Cordis lifecycle/SkillRegistry with deterministic execution and connection endpoints. */
export class FakeContext implements DshContextLike {
  readonly context = new Context()
  readonly logger = this.context.logger
  readonly plugin: Context['plugin'] = this.context.plugin.bind(this.context)
  readonly on: Context['on'] = this.context.on.bind(this.context)
  readonly effect: Context['effect'] = this.context.effect.bind(this.context)
  readonly get: Context['get'] = this.context.get.bind(this.context)
  readonly shell = createFakeShell(async spec => resultForCommand(spec.command, spec.stdin))
  readonly sessionProjections = new SessionProjectionRegistry(this.context)
  readonly agents: SharedState['agents']
  readonly credentials: RuntimeServices['credentials']
  readonly skills: SkillRegistry
  readonly subprocess: RuntimeServices['subprocess']

  constructor(readonly shared: SharedState = createSharedState()) {
    this.agents = shared.agents
    this.context.logger.exporter({ levels: { default: 3 }, export(message) {
      shared.logs.push(message.args.map(String).join(' '))
    } })
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
    this.skills = new ObservedSkillRegistry(this.context, shared)
    // Test endpoints implement exactly the SDK members consumed by the runtime.
    this.context.provide('shell', this.shell)
    this.context.provide('subprocess', this.subprocess)
    this.context.provide('credentials', this.credentials)
    this.context.provide('agents', this.agents)
  }

  static create(): FakeContext { return new FakeContext() }

  async emit(event: string, ...args: any[]): Promise<void> {
    await this.context.events.parallel(event, ...args)
  }

  async intercept(event: string, args: any[], terminal: () => Promise<any>): Promise<any> {
    return await this.context.events.waterfall(event, ...args, terminal)
  }

  listSkills(): ReturnType<SkillRegistry['list']> { return this.skills.list() }

  getSkill(name: string): ReturnType<SkillRegistry['get']> { return this.skills.get(name) }

  setCredential(name: string, value: string): void { this.shared.credentials.set(name, value) }

  async dispose(): Promise<void> { await this.context.fiber.dispose() }
}

function createSharedState(): SharedState {
  return { providers: new Map(), logs: [], credentials: new Map(), mcpConfigs: new Map(), tools: new Set(),
    hookRuns: [], subprocessSpawns: [], agents: new Map() }
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
        Config: McpConfigSchema,
        async apply(ctx: Context, config: McpConfig) {
          const serverName = String(config.serverName)
          if (shared.mcpConfigs.has(serverName)) throw new Error(`重复 MCP：${serverName}`)
          const command = config.transport === 'stdio' ? config.command : ''
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
