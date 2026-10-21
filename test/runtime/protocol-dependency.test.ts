import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from '../../src/runtime/adapters/hooks.js'
import { defaultRuntimeDependencies } from '../../src/runtime/dependencies.js'
import type { DshContextLike, RuntimeServices } from '../../src/runtime/context.js'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createFakeShell, createTestSession, fakeShellResult } from '../helpers/fake-dsh.js'
import type { CompatPlugin } from '../../src/types/plugin.js'

test('发布运行依赖可直接加载并执行 Hook Protocol', async () => {
  const protocol = await defaultRuntimeDependencies.loadHookProtocol()
  assert.equal(typeof protocol.runHook, 'function')
  assert.equal(typeof protocol.mergeHookOutputs, 'function')
  assert.equal(typeof protocol.createDetachedRuns, 'function')

  let resolved: ShellExecSpec | undefined
  const shell = createFakeShell(async request => {
    resolved = request
    return { ...fakeShellResult('', 2), stderr: { text: '已阻止', truncated: false } }
  })
  let now = 0
  const result = await protocol.runHook(shell, { command: 'fixture-hook' }, {
    payload: { hook_event_name: 'PreToolUse' },
    signal: new AbortController().signal,
    trailingNewline: true,
    defaultTimeoutMs: 12_345,
    expectedEventName: 'PreToolUse',
  }, () => now++)

  assert.equal(resolved?.command, 'fixture-hook')
  assert.equal(resolved?.timeoutMs, 12_345)
  assert.equal(resolved?.stdin, '{"hook_event_name":"PreToolUse"}\n')
  assert.equal(result.output.decision, 'block')
  assert.equal(result.output.reason, '已阻止')
})

test('默认运行依赖可让实际 Hook adapter 阻止工具调用', async () => {
  const listeners = new Map<string, (...args: any[]) => unknown>()
  const lifecycle = new Context()
  let shellRequest: ShellExecSpec | undefined
  const services: Partial<RuntimeServices> = { sessionProjections: new SessionProjectionRegistry(new Context()) }
  const ctx: DshContextLike = {
    logger: { warn() {} },
    shell: createFakeShell(async request => {
      shellRequest = request
      return { ...fakeShellResult('', 2), stderr: { text: '真实 Protocol 已阻止', truncated: false } }
    }),
    plugin: lifecycle.plugin.bind(lifecycle),
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect: lifecycle.effect.bind(lifecycle),
    get(name) { return services[name] },
  }
  const plugin: CompatPlugin = {
    id: 'real-protocol-hook',
    name: 'real-protocol-hook',
    sourceId: 'fixture-source',
    sourcePluginId: 'fixture-plugin',
    formats: ['claude-code'],
    skills: [],
    mcpServers: [],
    commands: [],
    agents: [],
    diagnostics: [],
    manifestFiles: [],
    hooks: [{
      id: 'claude-code:fixture',
      event: 'pre-tool-use',
      dshEvent: 'tools/pre-execute',
      dialect: 'claude-code',
      matcher: 'danger',
      runtime: {
        wireEventName: 'PreToolUse',
        matcherSyntax: 'exact',
        matcherSeparator: 'pipe-or-comma',
        defaultTimeoutSec: 600,
        trailingNewline: true,
        plainStdoutAsContext: false,
        environmentBindings: { CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root' },
        missingTranscriptPath: 'empty-string',
        includeModelPermissionFields: false,
        includeTurnId: false,
        toolInputShape: 'raw',
        honorPreToolAsk: true,
        includeNullLastAssistantMessage: false,
      },
      commands: [{ command: { type: 'template', parts: [{ type: 'text', value: 'fixture-hook' }] } }],
      sourceFile: 'hooks/hooks.json',
    }],
  }

  const health = await registerHooks(
    ctx,
    plugin,
    '/fixture/plugin',
    '/fixture/data',
    defaultRuntimeDependencies,
    { workspaceRoot: '/fixture/workspace' },
  )
  assert.deepEqual(health, [{ capability: 'hook', name: 'claude-code:fixture', status: 'running' }])
  const listener = listeners.get('tools/pre-execute')
  assert(listener)
  const agent = { session: createTestSession('/fixture/workspace', 'session-real-protocol') }
  const decision = await listener({
    name: 'danger',
    arguments: { command: 'rm -rf fixture' },
    callId: 'call-real-protocol',
    agent,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' }))

  assert.deepEqual(decision, { kind: 'deny', reason: '真实 Protocol 已阻止' })
  assert.equal(shellRequest?.command, 'fixture-hook')
  assert.equal(shellRequest?.workdir, '/fixture/workspace')
  assert.match(String(shellRequest?.stdin), /"hook_event_name":"PreToolUse"/)
  assert.deepEqual(shellRequest?.env, {
    CLAUDE_PROJECT_DIR: '/fixture/workspace',
    CLAUDE_PLUGIN_ROOT: '/fixture/plugin',
    CLAUDE_PLUGIN_DATA: '/fixture/data',
  })
  await lifecycle.fiber.dispose()
})
