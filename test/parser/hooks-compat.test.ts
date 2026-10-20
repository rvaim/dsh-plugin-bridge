import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import type { CompatHookDialect } from '../../src/types/hook.js'
import type { HarnessDescriptor } from '../../src/types/protocol.js'
import { parseHooksForHarness as parseClaudeHooks } from '../../src/protocols/claude-code/hooks.js'
import { parseHooksForHarness as parseCodexHooks } from '../../src/protocols/codex/hooks.js'
import { DiagnosticCollector } from '../../src/shared/diagnostics.js'
import { classifyMatcher as classifyClaudeMatcher, validateMatcher as validateClaudeMatcher } from '../../src/protocols/claude-code/matcher.js'
import { classifyMatcher as classifyCodexMatcher, validateMatcher as validateCodexMatcher } from '../../src/protocols/codex/matcher.js'
import { temporaryDirectory } from '../helpers/temp.js'

function descriptor(format: CompatHookDialect, hookSources: HarnessDescriptor['hookSources']): HarnessDescriptor {
  return {
    format, manifest: {}, skillPaths: [], commandPaths: [], agentPaths: [],
    defaultCapabilityPaths: { skills: false, commands: false, agents: false }, hookSources, mcpSources: [],
  }
}

async function inline(format: CompatHookDialect, events: unknown, excludedEvents?: string[]) {
  const collector = new DiagnosticCollector()
  const source = { file: 'plugin.json', pointer: '/hooks', inline: events, excludedEvents }
  const parseFixtureHooks: typeof parseClaudeHooks = format === 'claude-code' ? parseClaudeHooks : parseCodexHooks
  const hooks = await parseFixtureHooks('.', descriptor(format, [source]), collector)
  return { hooks, diagnostics: collector.items }
}

function group(command: Record<string, unknown> = {}) {
  return [{ hooks: [{ type: 'command', command: 'do-not-execute', ...command }] }]
}

const codexEvents = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]
const claudeEvents = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
]

for (const [format, events] of [['codex', codexEvents], ['claude-code', claudeEvents]] as const) {
  test(`${format} 完整合法事件目录独立于六类 DSH 运行映射`, async () => {
    const result = await inline(format, Object.fromEntries(events.map(event => [event, group()])))
    assert.equal(result.hooks.length, events.length)
    assert.equal(result.diagnostics.some(item => item.code === 'HOOK_EVENT_UNKNOWN'), false)
    const supported = result.hooks.filter(hook => hook.runtimeSupport === 'supported')
    assert.equal(supported.length, 6)
    assert.equal(supported.find(hook => hook.event === 'session-start')?.dshEvent, 'agent/created')
    const unsupported = result.hooks.filter(hook => hook.runtimeSupport === 'unsupported')
    assert.equal(unsupported.length, events.length - 6)
    assert(unsupported.every(hook => hook.dshEvent === 'unsupported' && hook.commands.length === 0 && hook.handlers?.length === 1))
    assert.equal(result.diagnostics.filter(item => item.code === 'HOOK_EVENT_RUNTIME_UNSUPPORTED' && item.level === 'error').length, events.length - 6)
  })
}

test('未知事件与合法但运行未支持事件使用不同诊断', async () => {
  const result = await inline('codex', { PermissionRequest: group(), Notification: group(), UnknownEvent: group() })
  assert.deepEqual(result.hooks.map(hook => hook.runtime.wireEventName), ['PermissionRequest'])
  assert.equal(result.diagnostics.filter(item => item.code === 'HOOK_EVENT_UNKNOWN').length, 2)
  assert.equal(result.diagnostics.filter(item => item.code === 'HOOK_EVENT_RUNTIME_UNSUPPORTED').length, 1)
  assert.equal(result.diagnostics.some(item => item.code === 'HOOK_EVENT_UNSUPPORTED'), false)
})

test('handler 类型按平台区分，合法未支持声明不包含配置明文', async () => {
  const handlers = [
    { type: 'http', url: 'https://private-token.example', headers: { Authorization: 'Bearer handler-secret' } },
    { type: 'mcp_tool', server: 'private-server', tool: 'private-tool', input: { token: 'handler-secret' } },
    { type: 'prompt', prompt: 'handler-secret' },
    { type: 'agent', prompt: 'handler-secret' },
    { type: 'unknown-private-token', command: 'handler-secret' },
  ]
  const claude = await inline('claude-code', { PreToolUse: [{ hooks: handlers }] })
  assert.deepEqual(claude.hooks[0].handlers?.map(handler => handler.type), ['http', 'mcp_tool', 'prompt', 'agent'])
  assert.equal(claude.hooks[0].commands.length, 0)
  assert.equal(claude.diagnostics.filter(item => item.code === 'HOOK_UNSUPPORTED_HANDLER').length, 4)
  assert.equal(claude.diagnostics.filter(item => item.code === 'HOOK_HANDLER_TYPE_INVALID').length, 1)
  const codex = await inline('codex', { PreToolUse: [{ hooks: handlers }] })
  assert.deepEqual(codex.hooks[0].handlers?.map(handler => handler.type), ['mcp_tool'])
  assert.equal(codex.diagnostics.filter(item => item.code === 'HOOK_HANDLER_TYPE_INVALID').length, 4)
  for (const result of [claude, codex]) {
    const serialized = JSON.stringify(result)
    for (const secret of ['private-token', 'handler-secret', 'private-server', 'private-tool']) assert.equal(serialized.includes(secret), false)
    assert(result.hooks[0].handlers?.every(handler => handler.configuration?.type === 'deferred-json'))
  }
})

test('Claude 顶层 modules 无论是否伴随 hooks 都专用报错且拒绝配置', async () => {
  for (const config of [
    { modules: ['./must-not-import.mjs'] },
    { modules: ['./must-not-import.mjs'], hooks: { Stop: group() } },
    { modules: [], Stop: group() },
  ]) {
    const result = await inline('claude-code', config)
    assert.deepEqual(result.hooks, [])
    assert(result.diagnostics.some(item => item.code === 'HOOK_MODULES_RUNTIME_UNSUPPORTED' && item.level === 'error'))
    assert.equal(result.diagnostics.some(item => item.code === 'HOOK_EVENT_UNKNOWN'), false)
    assert.equal(JSON.stringify(result).includes('must-not-import'), false)
  }
})

test('两平台通配符、exact 字符集及正则按固定协议分类', async () => {
  for (const format of ['codex', 'claude-code'] as const) {
    const classifyFixtureMatcher: typeof classifyClaudeMatcher = format === 'claude-code' ? classifyClaudeMatcher : classifyCodexMatcher
    const validateFixtureMatcher: typeof validateClaudeMatcher = format === 'claude-code' ? validateClaudeMatcher : validateCodexMatcher
    for (const matcher of ['', '*', undefined]) {
      assert.equal(validateFixtureMatcher(matcher), undefined)
      const result = await inline(format, { PreToolUse: [{ matcher, ...group()[0] }] })
      assert.equal(result.hooks[0].matcher, undefined)
      assert.equal(result.hooks[0].runtime.matcherSyntax, 'all')
      assert.equal(result.diagnostics.some(item => item.level === 'error'), false)
    }
    assert.equal(classifyFixtureMatcher('Bash|Read').matcherSyntax, 'exact')
    assert.equal(classifyFixtureMatcher('^mcp__.*').matcherSyntax, 'regex')
  }
  assert.deepEqual(classifyClaudeMatcher('Edit, Write'), { matcherSyntax: 'exact', matcherSeparator: 'pipe-or-comma' })
  assert.equal(classifyClaudeMatcher('code-reviewer').matcherSyntax, 'exact')
  assert.deepEqual(classifyCodexMatcher('Edit, Write'), { matcherSyntax: 'regex', matcherSeparator: 'pipe' })
  assert.equal(classifyCodexMatcher('code-reviewer').matcherSyntax, 'regex')
  assert.equal(classifyClaudeMatcher('a-b', 'StopFailure').matcherSyntax, 'regex')
  assert.equal(classifyClaudeMatcher('a-b', 'FileChanged').matcherSyntax, 'regex')
  assert.throws(() => validateClaudeMatcher('[private-token'), error => error instanceof Error && !error.message.includes('private-token'))
  const invalid = await inline('claude-code', { PreToolUse: [{ matcher: '[private-token', ...group()[0] }] })
  assert.equal(invalid.hooks.length, 0)
  assert(invalid.diagnostics.some(item => item.code === 'HOOK_MATCHER_INVALID'))
  assert.equal(JSON.stringify(invalid).includes('private-token'), false)
})

test('UserPromptSubmit、Stop、Interrupt 的 matcher 不参与验证或执行', async () => {
  const result = await inline('codex', Object.fromEntries(['UserPromptSubmit', 'Stop', 'Interrupt'].map(event =>
    [event, [{ matcher: '[invalid-private-token', ...group()[0] }]])))
  assert.equal(result.hooks.length, 3)
  assert(result.hooks.every(hook => hook.matcher === undefined && hook.runtime.matcherSyntax === 'all'))
  assert.equal(result.diagnostics.filter(item => item.code === 'HOOK_MATCHER_IGNORED').length, 3)
  assert.equal(result.diagnostics.some(item => item.code === 'HOOK_MATCHER_INVALID'), false)
  assert.equal(JSON.stringify(result).includes('private-token'), false)
})

test('空 args 仍为 exec，onFailure 与 shell 行为被明确保留', async () => {
  const result = await inline('claude-code', { PreToolUse: [{ hooks: [
    { type: 'command', command: 'private-executable', args: [], shell: 'powershell', onFailure: 'block', timeout: 12 },
    { type: 'command', command: 'private-shell-script', shell: 'bash', onFailure: 'continue' },
  ] }] })
  assert.equal(result.diagnostics.some(item => item.level === 'error'), false)
  assert(result.diagnostics.some(item => item.code === 'HOOK_SHELL_IGNORED'))
  const [exec, shell] = result.hooks[0].commands
  assert.equal(exec.executionMode, 'exec')
  assert.deepEqual(exec.args, [])
  assert.equal(exec.onFailure, 'block')
  assert.equal(exec.timeoutSec, 12)
  assert.equal(exec.shell, 'powershell')
  assert.equal(shell.executionMode, 'shell')
  assert.equal(shell.args, undefined)
  assert.equal(shell.onFailure, 'continue')
  assert.equal(shell.shell, 'bash')
  assert.equal(JSON.stringify(result).includes('private-executable'), false)
  assert.equal(JSON.stringify(result).includes('private-shell-script'), false)
})

test('关键行为不静默忽略，不能运行的条件、rewake、未知字段均保留脱敏声明', async () => {
  const result = await inline('claude-code', { PreToolUse: [{ hooks: [
    { type: 'command', command: 'private-command', if: 'Bash(private-token *)' },
    { type: 'command', command: 'private-command', asyncRewake: true },
    { type: 'command', command: 'private-command', unknownBehavior: 'private-token' },
    { type: 'command', command: 'private-command', async: true, onFailure: 'block' },
    { type: 'command', command: 'private-command', shell: 'powershell' },
  ] }] })
  assert.equal(result.hooks[0].commands.length, 0)
  assert.equal(result.hooks[0].handlers?.length, 5)
  for (const code of ['HOOK_CONDITION_RUNTIME_UNSUPPORTED', 'HOOK_ASYNC_REWAKE_RUNTIME_UNSUPPORTED', 'HOOK_HANDLER_FIELD_UNSUPPORTED', 'HOOK_ON_FAILURE_ASYNC_CONFLICT', 'HOOK_SHELL_RUNTIME_UNSUPPORTED']) {
    assert(result.diagnostics.some(item => item.code === code && item.level === 'error'), code)
  }
  assert.equal(result.hooks[0].handlers?.[0].behavior?.if?.type, 'deferred-json')
  assert.equal(result.hooks[0].handlers?.[1].behavior?.asyncRewake, true)
  assert.equal(result.hooks[0].handlers?.[3].behavior?.onFailure, 'block')
  assert.equal(JSON.stringify(result).includes('private-command'), false)
  assert.equal(JSON.stringify(result).includes('private-token'), false)
})

test('未知关键分组字段保留整个分组引用并禁止降级运行', async () => {
  const result = await inline('claude-code', { PreToolUse: [{ ...group()[0], futureBehavior: 'private-token' }] })
  assert.equal(result.hooks[0].commands.length, 0)
  assert.equal(result.hooks[0].handlers?.[0].groupConfiguration?.type, 'deferred-json')
  assert(result.diagnostics.some(item => item.code === 'HOOK_GROUP_FIELD_UNSUPPORTED'))
  assert.equal(JSON.stringify(result).includes('private-token'), false)
  const wrapped = await inline('claude-code', { hooks: { PreToolUse: group() }, futureBehavior: 'private-token' })
  assert.equal(wrapped.hooks[0].commands.length, 0)
  assert.equal(wrapped.hooks[0].handlers?.[0].groupConfiguration?.type, 'deferred-json')
  assert(wrapped.diagnostics.some(item => item.code === 'HOOK_CONFIG_FIELD_UNSUPPORTED'))
  assert.equal(JSON.stringify(wrapped).includes('private-token'), false)
})

test('timeout 类型和正数、onFailure 枚举、布尔与参数类型均严格验证', async () => {
  const invalid = [
    { timeout: '30' }, { timeout: 0 }, { timeout: -1 }, { timeout: Number.NaN },
    { timeoutSec: '30' }, { timeout: 1, timeoutSec: 2 }, { args: [42] },
    { onFailure: 'deny' }, { async: 'true' }, { shell: 'zsh' },
  ]
  const result = await inline('claude-code', { PreToolUse: [{ hooks: invalid.map(fields => ({ type: 'command', command: 'do-not-execute', ...fields })) }] })
  assert.equal(result.hooks[0].commands.length, 0)
  assert.equal(result.hooks[0].handlers?.length, invalid.length)
  for (const code of ['HOOK_TIMEOUT_INVALID', 'HOOK_TIMEOUT_CONFLICT', 'HOOK_ARGS_INVALID', 'HOOK_ON_FAILURE_INVALID', 'HOOK_HANDLER_FIELD_INVALID', 'HOOK_SHELL_INVALID']) {
    assert(result.diagnostics.some(item => item.code === code), code)
  }
})

test('展示文本与普通 plugin once 仅警告，不复制任意文本到扫描结果', async () => {
  const result = await inline('claude-code', { PreToolUse: group({
    statusMessage: 'private-token', description: 'private-token', once: true,
  }) })
  assert.equal(result.hooks[0].commands.length, 1)
  assert.equal(result.hooks[0].commands[0].statusMessage, undefined)
  assert.equal(result.diagnostics.some(item => item.level === 'error'), false)
  for (const code of ['HOOK_STATUS_MESSAGE_IGNORED', 'HOOK_DISPLAY_FIELD_IGNORED', 'HOOK_ONCE_IGNORED']) assert(result.diagnostics.some(item => item.code === code))
  assert.equal(JSON.stringify(result).includes('private-token'), false)
})

test('runtime profile 保留 Codex 原始 tool_input、两平台纯文本上下文与 Codex ask 限制', async () => {
  for (const format of ['claude-code', 'codex'] as const) {
    const result = await inline(format, { SessionStart: group(), UserPromptSubmit: group(), PreToolUse: group() })
    assert(result.hooks.every(hook => hook.runtime.toolInputShape === 'raw'))
    assert(result.hooks.filter(hook => hook.event === 'session-start' || hook.event === 'user-prompt-submit').every(hook => hook.runtime.plainStdoutAsContext))
    assert.equal(result.hooks.find(hook => hook.event === 'pre-tool-use')?.runtime.honorPreToolAsk, format === 'claude-code')
  }
})

test('Claude 文件必须包装、inline 事件映射，历史格式有明确 warning 且指针正确', async () => {
  const temp = await temporaryDirectory()
  try {
    const collector = new DiagnosticCollector()
    await writeFile(resolve(temp.path, 'unwrapped.json'), JSON.stringify({ Stop: group() }))
    const rejected = await parseClaudeHooks(temp.path, descriptor('claude-code', [{ file: 'unwrapped.json' }]), collector)
    assert.deepEqual(rejected, [])
    assert(collector.items.some(item => item.code === 'HOOK_CONFIG_INVALID'))
    await writeFile(resolve(temp.path, 'wrapped.json'), JSON.stringify({
      description: 'private-token', $schema: 'https://private-token.example', hooks: { Stop: group() },
    }))
    const fileCollector = new DiagnosticCollector()
    const wrapped = await parseClaudeHooks(temp.path, descriptor('claude-code', [{ file: 'wrapped.json' }]), fileCollector)
    assert.equal(wrapped.length, 1)
    assert.deepEqual(wrapped[0].commands[0].command, { type: 'deferred-json', file: 'wrapped.json', pointer: '/hooks/Stop/0/hooks/0/command' })
    assert.equal(fileCollector.items.some(item => item.level === 'error'), false)
    const direct = await inline('claude-code', { Stop: { command: 'private-token' }, description: 'private-token', $schema: 'private-token' })
    assert.equal(direct.hooks[0].commands.length, 1)
    assert(direct.diagnostics.some(item => item.code === 'HOOK_LEGACY_DIRECT_GROUP'))
    assert(direct.diagnostics.some(item => item.code === 'HOOK_LEGACY_DIRECT_HANDLER'))
    const historical = await inline('claude-code', { hooks: { Stop: group() } })
    assert(historical.diagnostics.some(item => item.code === 'HOOK_LEGACY_WRAPPED_INLINE'))
    assert.deepEqual(historical.hooks[0].commands[0].command, { type: 'deferred-json', file: 'plugin.json', pointer: '/hooks/hooks/Stop/0/hooks/0/command' })
    assert.equal(JSON.stringify([direct, historical, wrapped, fileCollector.items]).includes('private-token'), false)
  } finally { await temp.cleanup() }
})

test('被 marketplace 覆盖的事件在任何验证与诊断之前排除', async () => {
  const result = await inline('claude-code', { PreToolUse: [{ matcher: '[broken', hooks: [{ type: 'invalid' }] }], Stop: group() }, ['PreToolUse'])
  assert.deepEqual(result.hooks.map(hook => hook.event), ['stop'])
  assert.equal(result.diagnostics.some(item => item.level === 'error'), false)
})

test('未实现模板语法转为 Hook 诊断并保留声明，不向 normalize 抛异常', async () => {
  for (const template of ['${user_config.TOKEN}', '${UNCLOSED', '${NESTED${INNER}}']) {
    const result = await inline('claude-code', { PreToolUse: group({ args: [template] }) })
    assert.equal(result.hooks[0].commands.length, 0)
    assert.equal(result.hooks[0].handlers?.length, 1)
    assert(result.diagnostics.some(item => item.code === 'HOOK_TEMPLATE_UNSUPPORTED'))
    assert.equal(JSON.stringify(result).includes(template), false)
  }
})
