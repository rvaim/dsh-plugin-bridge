import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from '../../src/runtime/adapters/hooks.js'
import { defaultRuntimeDependencies } from '../../src/runtime/dependencies.js'
import type { DshContextLike, RuntimeServices } from '../../src/runtime/context.js'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { createFakeShell, createTestSession, fakeShellResult, recordedPluginData, recordedSessionEvents } from '../helpers/fake-dsh.js'
import type { CompatHook } from '../../src/types/hook.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import type { CapabilityRuntimeHealth } from '../../src/types/runtime.js'

function plugin(command: Partial<CompatHook['commands'][number]> = {}, event: 'pre-tool-use' | 'session-start' | 'stop' = 'pre-tool-use'): CompatPlugin {
  return {
    id: 'contract', name: 'contract', sourceId: 'fixture', sourcePluginId: 'contract', formats: ['claude-code'],
    skills: [], mcpServers: [], agents: [], commands: [], diagnostics: [], manifestFiles: [],
    hooks: [{
      id: 'contract:hook', event,
      dshEvent: event === 'pre-tool-use' ? 'tools/pre-execute' : event === 'session-start' ? 'agent/created' : 'agent/turn-stopping',
      dialect: 'claude-code', sourceFile: 'hooks/hooks.json',
      runtime: {
        wireEventName: event === 'pre-tool-use' ? 'PreToolUse' : event === 'session-start' ? 'SessionStart' : 'Stop',
        matcherSyntax: 'all', matcherSeparator: 'pipe-or-comma', defaultTimeoutSec: 600, trailingNewline: true, plainStdoutAsContext: event === 'session-start',
        environmentBindings: { CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root' },
        missingTranscriptPath: 'empty-string', includeModelPermissionFields: false,
        includeTurnId: false, toolInputShape: 'raw', honorPreToolAsk: true, includeNullLastAssistantMessage: event === 'stop',
      },
      commands: [{ command: { type: 'template', parts: [{ type: 'text', value: 'audit-fixture' }] }, ...command }],
    }],
  }
}

function harness(run: (request: ShellExecSpec) => Promise<ShellRunResult>, turn = 4) {
  const listeners = new Map<string, (...args: any[]) => any>()
  const effects: Array<() => any> = []
  const logs: string[] = []
  const session = createTestSession('/original', 'contract-session', turn)
  const records = recordedSessionEvents(session)
  const health: CapabilityRuntimeHealth[] = []
  const injected: any[] = []
  const cancelled: any[] = []
  const agent = {
    session,
    inject(message: unknown) { injected.push(message) },
    steer(message: unknown) { injected.push(message) },
    cancel(cause: unknown) { cancelled.push(cause) },
  }
  const ctx: DshContextLike = {
    logger: { warn(...args) { logs.push(args.join(' ')) } },
    shell: createFakeShell(run),
    sessionProjections: new SessionProjectionRegistry(new Context()),
    on(name, listener) { listeners.set(name, listener) },
    effect(setup) { const disposer = setup(); if (typeof disposer === 'function') effects.push(disposer) },
    get(name) {
      const services: Partial<RuntimeServices> = { sessionProjections: this.sessionProjections,
        workingDirectory: { get() { return '/effective' } }, subprocess: this.subprocess, credentials: this.credentials }
      return services[name]
    },
  }
  const mount = async (p = plugin()) => await registerHooks(ctx, p, '/plugin', '/data', defaultRuntimeDependencies,
    { workspaceRoot: '/fallback', onHealth(next) { health.push(next) } })
  const execute = async (name = 'mcp__docs__lookup', args: unknown = { query: 'preserve me', limit: 3 }) => {
    let nextCalls = 0
    const decision = await listeners.get('tools/pre-execute')?.({
      name, arguments: args, callId: 'tool-1', agent, signal: new AbortController().signal,
    }, async () => { nextCalls += 1; return { kind: 'allow' } })
    return { decision, nextCalls }
  }
  return { ctx, agent, records, logs, health, injected, cancelled, listeners, mount, execute,
    async dispose() { for (const effect of effects.reverse()) await effect() } }
}
const outcome = fakeShellResult

test('当前 Shell execute/result 接口真实执行 Hook 并完整传递工具 JSON 和工作区', async () => {
  let request: any
  const h = harness(async value => { request = value; return outcome('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"policy"}}') })
  try {
    await h.mount()
    assert.deepEqual(await h.execute(), { decision: { kind: 'deny', reason: 'policy' }, nextCalls: 0 })
    assert.equal(request.workdir, '/effective')
    assert.deepEqual(JSON.parse(request.stdin).tool_input, { query: 'preserve me', limit: 3 })
    assert.equal(recordedPluginData(h.agent.session, 'plugin:plugin-bridge/hook-result')[0]?.decision, 'deny')
  } finally { await h.dispose() }
})

test('onFailure:block 在启动失败、超时、异常退出和错误 JSON 时阻止工具', async () => {
  const failures = [
    async () => { throw new Error('fixture executable missing') },
    async () => ({ ...outcome('', 0), timedOut: true }),
    async () => outcome('', 7),
    async () => outcome('{invalid-json'),
    async () => outcome('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"invalid"}}'),
    async () => outcome('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":42}}'),
    async () => outcome('{"hookSpecificOutput":[]}'),
    async () => outcome('{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow"}}'),
  ]
  for (const run of failures) {
    const h = harness(run)
    try {
      await h.mount(plugin({ onFailure: 'block' }))
      const { decision, nextCalls } = await h.execute()
      assert.equal(decision.kind, 'deny')
      assert.equal(nextCalls, 0)
      assert.equal(h.health.at(-1)?.status, 'degraded')
      assert.notEqual(recordedPluginData(h.agent.session, 'plugin:plugin-bridge/hook-result')[0]?.decision, 'pass')
    } finally { await h.dispose() }
  }
})

test('默认继续策略仍记录 error 并降低健康状态，不把失败报告成成功', async () => {
  const h = harness(async () => { throw new Error('fixture failure') })
  try {
    await h.mount()
    assert.deepEqual(await h.execute(), { decision: { kind: 'allow' }, nextCalls: 1 })
    assert.equal(recordedPluginData(h.agent.session, 'plugin:plugin-bridge/hook-result')[0]?.decision, 'error')
    assert.equal(h.health.at(-1)?.status, 'degraded')
    assert(h.logs.some(line => line.includes('fixture failure')))
  } finally { await h.dispose() }
})

test('args 通过 subprocess argv 直接执行，保留特殊字符且不用 Shell', async () => {
  const h = harness(async () => { assert.fail('exec form must not use shell') })
  let spec: any
  let terminated = false
  h.ctx.subprocess = {
    async resolveExecutable(command) { assert.equal(command, 'audit-fixture'); return '/bin/audit-fixture' },
    spawn(value) {
      spec = value
      return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        done: Promise.resolve({ exitCode: 2, signal: null }), collected: {
        stdout: { readFrom() { return { text: '', nextOffset: 0, lossy: false } } },
        stderr: { readFrom() { return { text: 'argv blocked', nextOffset: 12, lossy: false } } },
      }, terminate() { terminated = true }, async waitForExit() { return true } }
    },
  }
  try {
    await h.mount(plugin({ executionMode: 'exec', args: [{ type: 'template', parts: [{ type: 'text', value: "quote' $() ` ;" }] }] }))
    assert.equal((await h.execute()).decision.reason, 'argv blocked')
    assert.deepEqual(spec.argv, ['/bin/audit-fixture', "quote' $() ` ;"])
    assert.equal(JSON.parse(spec.stdio.stdin.data).tool_name, 'mcp__docs__lookup')
    assert(terminated)
  } finally { await h.dispose() }
})

test('continue:false 取消 Agent 并阻止继续派发', async () => {
  const h = harness(async () => outcome('{"continue":false,"stopReason":"stop now"}'))
  try {
    await h.mount()
    assert.equal((await h.execute()).decision.kind, 'deny')
    assert.deepEqual(h.cancelled, [{ kind: 'hook', reason: 'stop now' }])
  } finally { await h.dispose() }
})

test('SessionStart 在 agent/created 中等待完成，注入完整 UserMessage', async () => {
  const h = harness(async () => outcome('initial context'), 0)
  try {
    await h.mount(plugin({}, 'session-start'))
    assert.equal(h.listeners.has('agent/session-start'), false)
    await h.listeners.get('agent/created')?.({ agent: h.agent, source: 'startup', signal: new AbortController().signal })
    assert.equal(h.injected[0].role, 'user')
    assert.equal(typeof h.injected[0].id, 'string')
    assert.equal(h.injected[0].content[0].text, 'initial context')
    const invoked = recordedPluginData(h.agent.session, 'plugin:plugin-bridge/hook-invoked')
    const results = recordedPluginData(h.agent.session, 'plugin:plugin-bridge/hook-result')
    assert.equal(invoked.length, 1)
    assert.equal(results.length, 1)
    assert.equal(invoked[0].point, 'SessionStart')
    assert.equal('turn' in invoked[0], false)
    assert.equal('turn' in results[0], false)
    assert.equal(results[0].decision, 'pass')
  } finally { await h.dispose() }
})

test('当前 session projection 提供轮次与最后回复，不要求 session.events', async () => {
  let request: any
  const h = harness(async value => { request = value; return outcome() })
  assert.equal('events' in h.agent.session, false)
  h.agent.session.append('turn/start', { turn: 9 })
  h.agent.session.append('assistant/message', {
    turn: 9, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [
      { type: 'reasoning', text: 'private' }, { type: 'text', text: 'public reply' },
    ] }),
  }, { surfaceOp: 'append' })
  const p = plugin({}, 'stop')
  p.hooks[0].dialect = 'codex'
  p.hooks[0].runtime.includeModelPermissionFields = true
  p.hooks[0].runtime.includeTurnId = true
  try {
    await h.mount(p)
    await h.listeners.get('agent/turn-stopping')?.({ agent: h.agent, turn: 9, signal: new AbortController().signal })
    const payload = JSON.parse(request.stdin)
    assert.equal(payload.turn_id, '9')
    assert.equal(payload.last_assistant_message, 'public reply')
    assert.equal(request.stdin.includes('private'), false)
  } finally { await h.dispose() }
})

test('无法执行的 Hook 结果重写被明确阻断而不是忽略', async () => {
  const h = harness(async () => outcome('{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"x":2}}}'))
  try {
    await h.mount()
    assert.equal((await h.execute()).decision.kind, 'deny')
  } finally { await h.dispose() }
})

test('Hook stopReason 的已解析凭据不进入取消、拒绝和初始化异常', async () => {
  const secret = 'fixtureCredential987654'
  for (const event of ['pre-tool-use', 'session-start'] as const) {
    const h = harness(async () => outcome(JSON.stringify({ continue: false, stopReason: secret })))
    h.ctx.credentials = { async resolve() { return { value: secret, source: 'fixture' } } }
    const p = plugin({ command: { type: 'template', parts: [{ type: 'env', name: 'FIXTURE_HOOK_SECRET' }] } }, event)
    try {
      await h.mount(p)
      if (event === 'pre-tool-use') {
        const result = await h.execute()
        assert.equal(JSON.stringify(result).includes(secret), false)
      } else {
        await assert.rejects(h.listeners.get('agent/created')!({ agent: h.agent, source: 'startup' }), error =>
          error instanceof Error && !error.message.includes(secret))
      }
      assert.equal(JSON.stringify(h.cancelled).includes(secret), false)
      assert.equal(JSON.stringify(h.records).includes(secret), false)
      assert.equal(h.logs.join('\n').includes(secret), false)
    } finally { await h.dispose() }
  }
})

test('Claude UserPromptSubmit 使用事件级三十秒默认超时', async () => {
  let request: any
  const h = harness(async value => { request = value; return outcome() })
  const p = plugin()
  p.hooks[0].event = 'user-prompt-submit'
  p.hooks[0].dshEvent = 'agent/pre-step'
  p.hooks[0].runtime.wireEventName = 'UserPromptSubmit'
  p.hooks[0].runtime.defaultTimeoutSec = 30
  try {
    await h.mount(p)
    await h.listeners.get('agent/pre-step')!({ agent: h.agent, messages: [{ content: [{ type: 'text', text: 'prompt' }] }], turn: 4,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(request.timeoutMs, 30_000)
  } finally { await h.dispose() }
})

test('Stop additionalContext 触发续步，后续 payload 标记 active 且至多连续八次', async () => {
  const payloads: any[] = []
  const h = harness(async request => {
    assert.equal(typeof request.stdin, 'string')
    payloads.push(JSON.parse(request.stdin!))
    return outcome('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"run checks"}}')
  })
  try {
    await h.mount(plugin({}, 'stop'))
    for (let index = 0; index < 10; index += 1) {
      await h.listeners.get('agent/turn-stopping')!({ agent: h.agent, turn: 4, signal: new AbortController().signal })
    }
    assert.equal(h.injected.length, 8)
    assert.equal(h.injected[0].content[0].text, 'run checks')
    assert.equal(payloads[0].stop_hook_active, false)
    assert.equal(payloads[1].stop_hook_active, true)
    assert(h.logs.some(line => line.includes('八次')))
  } finally { await h.dispose() }
})

test('缺少当前 projection 服务时明确拒绝注册，不扫描旧 session.events', async () => {
  const h = harness(async () => outcome())
  h.ctx.sessionProjections = undefined
  Object.defineProperty(h.agent.session, 'events', { get() { assert.fail('旧 session.events 不得被读取') } })
  try { await assert.rejects(h.mount(), /sessionProjections/) } finally { await h.dispose() }
})

test('旧 Host 仅 shell.run 不再执行，失败仍按策略阻止工具', async () => {
  const h = harness(async () => outcome())
  let legacyCalled = false
  h.ctx.shell = { resolve: h.ctx.shell!.resolve,
    async run() { legacyCalled = true; return outcome() },
  } as unknown as NonNullable<DshContextLike['shell']>
  try {
    await h.mount(plugin({ onFailure: 'block' }))
    assert.equal((await h.execute()).decision.kind, 'deny')
    assert.equal(legacyCalled, false)
    assert.equal(h.health.at(-1)?.status, 'degraded')
  } finally { await h.dispose() }
})

test('纯 argv Hook 不要求可选 Shell 服务，仍通过当前 subprocess 执行', async () => {
  const h = harness(async () => { assert.fail('argv must not use Shell') })
  h.ctx.shell = undefined
  let spawned = false
  h.ctx.subprocess = {
    async resolveExecutable(command) { return command },
    spawn() {
      spawned = true
      return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        done: Promise.resolve({ exitCode: 0, signal: null }), collected: {}, terminate() {}, async waitForExit() { return true } }
    },
  }
  try {
    await h.mount(plugin({ args: [] }))
    assert.equal((await h.execute()).decision.kind, 'allow')
    assert.equal(spawned, true)
  } finally { await h.dispose() }
})

test('中立 Hook 来源保持执行与结果合并，并以本包 typed 记录保留原始来源', async () => {
  const h = harness(async () => outcome('', 2))
  const p = plugin()
  p.hooks[0].dialect = 'agent-plugins'
  try {
    await h.mount(p)
    assert.equal((await h.execute()).decision.kind, 'deny')
    const records = h.records.map(pluginRecordOf).filter(record => record !== undefined)
    assert.deepEqual(records.map(record => record.type), ['plugin:plugin-bridge/hook-invoked', 'plugin:plugin-bridge/hook-result'])
    assert.deepEqual(records[0].data, { turn: 4, point: 'PreToolUse', handlerId: 'contract:hook:0', dialect: 'agent-plugins' })
    assert.equal(h.records.some(event => event.type === 'hook/invoked'), false)
    assert.equal(h.health.at(-1)?.status, 'running')
  } finally { await h.dispose() }
})
