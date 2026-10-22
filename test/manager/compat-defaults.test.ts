import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { parseCompatPlugin } from '../../src/composition/defaults.js'
import { createTestSession, FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('安装尊重 Manifest defaultEnabled:false，用户显式 enable 优先', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) }), createBuiltinParserEngine())
    for (const [name, explicit] of [['default-off', false], ['explicit-on', true]] as const) {
      const source = resolve(temp.path, name)
      await buildClaudePlugin(source, { name })
      await writeFile(resolve(source, '.claude-plugin/plugin.json'), JSON.stringify({ name, defaultEnabled: false }))
      const installed = (await manager.install(source, explicit ? { enable: true } : {})).plugins[0]
      assert.equal(installed.enabled, explicit)
      assert.equal((await manager.inspect(name)).state.enabled, explicit)
    }
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('Marketplace 内联 MCP 和 Hook 使用 Source 来源，安装更新后不读取同名插件文件', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'source')
    const root = resolve(source, 'plugins/nested')
    await buildClaudePlugin(root, { name: 'nested' })
    await mkdir(resolve(source, '.claude-plugin'), { recursive: true })
    const put = async (version: string) => await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'source-provenance', owner: { name: 'fixture' }, plugins: [{
        name: 'nested', source: './plugins/nested',
        mcpServers: { source_server: { command: 'fake-mcp', env: { SOURCE_VALUE: `private-source-${version}` } } },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `deny:source-policy-${version}` }] }] },
      }],
    }))
    await put('v1')
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) }), createBuiltinParserEngine())
    const installed = (await manager.install(source, { plugins: ['nested'] })).plugins[0]
    assert.equal(installed.runtime.status, 'running')
    assert.equal((ctx.shared.mcpConfigs.get('source_server')?.env as any).SOURCE_VALUE, 'private-source-v1')
    assert.equal(JSON.stringify(installed.plugin).includes('private-source-v1'), false)
    const command = installed.plugin.hooks[0].commands[0].command
    assert.equal(command.type, 'deferred-json')
    if (command.type === 'deferred-json') assert.equal(command.base, 'source')
    await put('v2')
    await manager.update('nested')
    assert.equal((ctx.shared.mcpConfigs.get('source_server')?.env as any).SOURCE_VALUE, 'private-source-v2')
    await manager.disable('nested')
    await manager.enable('nested')
    const agent = { session: createTestSession(temp.path, 'provenance') }
    const result = await ctx.intercept('tools/pre-execute', [{ name: 'fixture', arguments: {}, callId: 'source-call', agent,
      signal: new AbortController().signal }], async () => ({ kind: 'allow' }))
    assert.deepEqual(result, { kind: 'deny', reason: 'source-policy-v2' })
    assert.equal((ctx.shared.mcpConfigs.get('source_server')?.env as any).SOURCE_VALUE, 'private-source-v2')
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('Agent Plugins schema 独立识别，不因含skills目录误判为传统 CC 或 Codex', async () => {
  const temp = await temporaryDirectory()
  try {
    await writeFile(resolve(temp.path, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'portable-out-of-scope',
    }))
    await mkdir(resolve(temp.path, 'skills/demo'), { recursive: true })
    await writeFile(resolve(temp.path, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: portable fixture\n---\nBody')
    const parsed = await parseCompatPlugin(temp.path)
    assert.deepEqual(parsed.formats, ['agent-plugins'])
    assert.deepEqual(parsed.skills.map(skill => skill.name), ['demo'])
    assert.equal(parsed.protocol?.version, '1.0.0')
    assert.equal(parsed.diagnostics.some(item => item.level === 'error'), false)
  } finally { await temp.cleanup() }
})
