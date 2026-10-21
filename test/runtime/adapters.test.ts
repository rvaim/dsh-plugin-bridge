import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseCompatPlugin } from '../../src/composition/defaults.js'
import { copyPluginDirectory } from '../../src/source/directory.js'
import { CompatLayout } from '../../src/store/layout.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { FakeContext, createTestSession, fakeRuntimeDependencies, recordedPluginData } from '../helpers/fake-dsh.js'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { temporaryDirectory } from '../helpers/temp.js'

const claudeFixture = resolve('test/fixtures/claude-code/full')
const codexFixture = resolve('test/fixtures/codex/full')

function fakeAgent(cwd: string): any {
  const injected: any[] = []
  const steered: any[] = []
  return {
    session: createTestSession(cwd),
    injected,
    steered,
    inject(value: unknown) { injected.push(value) },
    steer(value: unknown) { steered.push(value) },
  }
}

const tick = (): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, 10))

test('父运行实例注册 Skill、MCP、Hook，停止时整体撤销', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await layout.ensure()
    const packageRoot = layout.sourcePackageDir('legacy-full')
    await copyPluginDirectory(claudeFixture, packageRoot)
    const plugin = await parseCompatPlugin(packageRoot, {
      asId: 'legacy-full',
    })
    ctx.setCredential('GITHUB_TOKEN', 'resolved-token')
    const runtime = new CompatRuntimeManager(ctx, layout, {
      workspaceRoot: resolve(temp.path, 'workspace'),
      dependencies: fakeRuntimeDependencies(ctx.shared),
    })
    const snapshot = await runtime.start(plugin, packageRoot)
    assert.equal(snapshot.status, 'running')

    const provider = ctx.shared.providers.values().next().value
    assert(provider)
    assert(provider.list({}) instanceof Promise, '当前 DSH SkillProvider.list 必须返回 Promise')
    const summaries = await ctx.listSkills()
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].name, 'review')
    const definition = await ctx.getSkill('review')
    assert(definition)
    assert.match(definition.content, /逐项检查正确性/)
    assert.equal(definition.content.includes('description:'), false)

    assert.equal(ctx.shared.mcpConfigs.size, 2)
    const github = ctx.shared.mcpConfigs.get('github')
    assert(github)
    assert.equal((github.env as Record<string, string>).GITHUB_TOKEN, 'resolved-token')
    assert.equal((github.env as Record<string, string>).INLINE_SECRET, 'ghp_do_not_copy_to_scan')
    assert.match(String(github.command), /legacy-full[\\/]package[\\/]scripts[\\/]server\.js$/)
    assert(ctx.shared.tools.has('mcp__github__fixture'))

    const agent = fakeAgent(resolve(temp.path, 'workspace'))
    const pre = await ctx.intercept('tools/pre-execute', [{
      name: 'danger', arguments: { x: 1 }, callId: 'call-1', agent, signal: new AbortController().signal,
    }], async () => ({ kind: 'allow' }))
    assert.deepEqual(pre, { kind: 'deny', reason: '危险工具已阻止' })
    const claudeRun = ctx.shared.hookRuns.find(item => item.hook.command === 'deny:危险工具已阻止')
    assert(claudeRun)
    assert.equal(claudeRun.options.expectedEventName, 'PreToolUse')
    assert.equal(claudeRun.options.trailingNewline, true)
    assert.deepEqual(claudeRun.options.env, {
      CLAUDE_PROJECT_DIR: resolve(temp.path, 'workspace'),
      CLAUDE_PLUGIN_ROOT: packageRoot,
      CLAUDE_PLUGIN_DATA: layout.dataDir('legacy-full'),
    })
    assert.deepEqual(claudeRun.options.payload, {
      session_id: 'session-1',
      transcript_path: '',
      cwd: resolve(temp.path, 'workspace'),
      hook_event_name: 'PreToolUse',
      tool_name: 'danger',
      tool_input: { x: 1 },
      tool_use_id: 'call-1',
    })

    const ask = await ctx.intercept('tools/pre-execute', [{
      name: 'confirm', arguments: { x: 2 }, callId: 'call-confirm', agent, signal: new AbortController().signal,
    }], async () => ({ kind: 'allow' }))
    assert.deepEqual(ask, { kind: 'ask', reason: '需要人工确认' })

    const post = await ctx.intercept('tools/post-execute', [{
      name: 'safe', arguments: {}, callId: 'call-2', agent, signal: new AbortController().signal,
    }, { content: [{ type: 'text', text: 'ok' }] }], async () => ({ kind: 'continue', additionalContexts: [] }))
    assert.equal(post.kind, 'continue')
    assert.equal(post.additionalContexts[0].content[0].text, '已完成安全检查')

    await ctx.emit('agent/created', { agent, source: 'startup' })
    await tick()
    assert.equal(agent.injected[0].content[0].text, '会话初始化完成')
    const invoked = recordedPluginData(agent.session, 'plugin:plugin-bridge/hook-invoked')
    const results = recordedPluginData(agent.session, 'plugin:plugin-bridge/hook-result')
    assert(invoked.length > 0)
    assert.equal(invoked.length, results.length)
    assert(invoked.some(record => record.point === 'SessionStart' && !('turn' in record)))

    const stopped = await runtime.stop(plugin.id)
    assert.equal(stopped.status, 'disabled')
    assert.equal((await ctx.listSkills()).length, 0)
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    assert.equal(ctx.shared.tools.size, 0)
    const afterStop = await ctx.intercept('tools/pre-execute', [{ name: 'danger' }], async () => ({ kind: 'allow' }))
    assert.deepEqual(afterStop, { kind: 'allow' })
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('缺少一个 MCP 凭据时插件整体进入 degraded，其他能力继续运行', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await layout.ensure()
    const packageRoot = layout.sourcePackageDir('legacy-full')
    await copyPluginDirectory(claudeFixture, packageRoot)
    const plugin = await parseCompatPlugin(packageRoot, {
      asId: 'legacy-full',
    })
    const runtime = new CompatRuntimeManager(ctx, layout, {
      dependencies: fakeRuntimeDependencies(ctx.shared),
    })
    const snapshot = await runtime.start(plugin, packageRoot)
    assert.equal(snapshot.status, 'degraded')
    assert.equal(snapshot.capabilities.find(item => item.name === 'github')?.status, 'failed')
    assert.equal(snapshot.capabilities.find(item => item.name === 'remote')?.status, 'running')
    assert.equal((await ctx.listSkills()).length, 1)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('Codex Hook 保留完整 payload，并明确阻断不支持的 ask', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await layout.ensure()
    const packageRoot = layout.sourcePackageDir('codex-full')
    await copyPluginDirectory(codexFixture, packageRoot)
    const plugin = await parseCompatPlugin(packageRoot, {
      asId: 'codex-full',
    })
    ctx.setCredential('SEARCH_KEY', 'search-token')
    const runtime = new CompatRuntimeManager(ctx, layout, {
      modelName: 'deepseek-v4',
      dependencies: fakeRuntimeDependencies(ctx.shared),
    })
    assert.equal((await runtime.start(plugin, packageRoot)).status, 'running')
    const search = ctx.shared.mcpConfigs.get('search')
    assert(search)
    assert.equal(search.toolCallTimeoutMs, 12_000)
    assert.equal(search.cwd, packageRoot)
    assert.deepEqual(search.args, [
      resolve(packageRoot, 'scripts/search.js'),
      resolve(layout.dataDir('codex-full'), 'cache.json'),
    ])
    assert.equal((search.env as Record<string, string>).SEARCH_KEY, 'search-token')
    assert.equal((search.env as Record<string, string>).PLUGIN_ROOT, packageRoot)
    assert.equal((search.env as Record<string, string>).PLUGIN_DATA, layout.dataDir('codex-full'))
    const agent = fakeAgent(temp.path)
    const decision = await ctx.intercept('tools/pre-execute', [{
      name: 'danger', arguments: { command: 'echo ok', ignored: true }, callId: 'x', agent, signal: new AbortController().signal,
    }], async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /不支持.*ask/)

    const preRun = ctx.shared.hookRuns.find(item => item.hook.command === 'ask:需要确认')
    assert(preRun)
    assert.equal(preRun.options.expectedEventName, 'PreToolUse')
    assert.equal(preRun.options.trailingNewline, false)
    assert.deepEqual(preRun.options.env, {
      PLUGIN_ROOT: packageRoot,
      PLUGIN_DATA: layout.dataDir('codex-full'),
      CODEX_PLUGIN_ROOT: packageRoot,
      CODEX_PLUGIN_DATA: layout.dataDir('codex-full'),
      CLAUDE_PLUGIN_ROOT: packageRoot,
      CLAUDE_PLUGIN_DATA: layout.dataDir('codex-full'),
      CLAUDE_PROJECT_DIR: temp.path,
    })
    assert.deepEqual(preRun.options.payload, {
      session_id: 'session-1',
      transcript_path: null,
      cwd: temp.path,
      hook_event_name: 'PreToolUse',
      model: 'deepseek-v4',
      permission_mode: 'default',
      turn_id: '1',
      tool_name: 'danger',
      tool_input: { command: 'echo ok', ignored: true },
      tool_use_id: 'x',
    })

    const preStep = await ctx.intercept('agent/pre-step', [{
      agent,
      messages: [{ role: 'user', content: [{ type: 'text', text: '请分析' }] }],
      turn: 1,
      signal: new AbortController().signal,
    }], async () => ({ kind: 'enter', messages: [] }))
    assert.equal(preStep.kind, 'enter')
    assert.equal(preStep.messages[0].content[0].text, 'Codex 提示上下文')
    const promptRun = ctx.shared.hookRuns.find(item => item.hook.command === 'stdout:Codex 提示上下文')
    assert(promptRun)
    assert.equal(promptRun.options.expectedEventName, 'UserPromptSubmit')
    assert.equal((promptRun.options.payload as any).prompt, '请分析')

    agent.session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'fixture', model: 'fixture' },
        content: [
          { type: 'reasoning', text: '不能进入 Hook payload 的私有推理' },
          { type: 'text', text: '这是本轮最终回复' },
        ],
      }),
    }, { surfaceOp: 'append' })
    await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    assert.equal(agent.steered[0].content[0].text, '继续执行')
    const stopRun = ctx.shared.hookRuns.find(item => item.hook.command === 'deny:继续执行')
    assert(stopRun)
    assert.deepEqual(stopRun.options.payload, {
      session_id: 'session-1',
      transcript_path: null,
      cwd: temp.path,
      hook_event_name: 'Stop',
      model: 'deepseek-v4',
      permission_mode: 'default',
      turn_id: '1',
      stop_hook_active: false,
      last_assistant_message: '这是本轮最终回复',
    })
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('Claude Hook 的 command + args 保留直接执行参数边界', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const sourceRoot = resolve(temp.path, 'source')
    await mkdir(resolve(sourceRoot, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(sourceRoot, 'hooks'), { recursive: true })
    await writeFile(resolve(sourceRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'hook-args' }))
    await writeFile(resolve(sourceRoot, 'hooks/hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: 'command',
            command: 'node',
            args: ['${CLAUDE_PLUGIN_ROOT}/bin/dispatch file.js', '--host', 'claude', "quote'value"],
          }],
        }],
      },
    }))

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await layout.ensure()
    const packageRoot = layout.sourcePackageDir('hook-args')
    await copyPluginDirectory(sourceRoot, packageRoot)
    const plugin = await parseCompatPlugin(packageRoot, {
      asId: 'hook-args',
    })
    const runtime = new CompatRuntimeManager(ctx, layout, {
      workspaceRoot: resolve(temp.path, 'workspace'),
      dependencies: fakeRuntimeDependencies(ctx.shared),
    })
    assert.equal((await runtime.start(plugin, packageRoot)).status, 'running')

    const agent = fakeAgent(resolve(temp.path, 'workspace'))
    await ctx.intercept('agent/pre-step', [{
      agent,
      messages: [{ role: 'user', content: [{ type: 'text', text: '触发' }] }],
      turn: 1,
      signal: new AbortController().signal,
    }], async () => ({ kind: 'enter', messages: [] }))

    assert.equal(ctx.shared.hookRuns.length, 1)
    assert.equal(ctx.shared.hookRuns[0].hook.command, 'node')
    assert.deepEqual(ctx.shared.subprocessSpawns[0].argv, [
      'node', resolve(packageRoot, 'bin/dispatch file.js'), '--host', 'claude', "quote'value",
    ])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})
