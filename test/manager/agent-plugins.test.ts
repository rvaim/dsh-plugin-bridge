import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { parseCompatPlugin } from '../../src/composition/defaults.js'
import { parseCompatSource } from '../../src/composition/defaults.js'
import { AGENT_MCP_SCHEMA_URI, AGENT_PLUGIN_SCHEMA_URI } from '../../src/protocols/agent-plugins/constants.js'
import { createStoredZip } from '../helpers/archive-builder.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, file: string, value: unknown): Promise<void> {
  const path = resolve(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}
const manifest = (version = 'release one') => ({ $schema: AGENT_PLUGIN_SCHEMA_URI, name: 'acme.tools', version })
const skill = '---\nname: review\ndescription: Portable review skill\n---\nPortable body\n'

async function fixture(root: string, version = 'release one'): Promise<void> {
  await put(root, 'plugin.json', manifest(version))
  await put(root, 'skills/review/SKILL.md', skill)
  await put(root, 'mcp.json', { $schema: AGENT_MCP_SCHEMA_URI, mcpServers: {
    portable: { type: 'stdio', command: 'fake-mcp', args: ['${PLUGIN_DATA}/cache', '${UNKNOWN_TOKEN:-literal}'],
      env: { LOCATION: '${PLUGIN_ROOT}/settings', VERSION_LITERAL: version } },
  } })
}

test('Agent Plugins 独立来源身份、启动启停、更新保留数据及卸载整体清理', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'portable')
    await fixture(source)
    const discovery = await parseCompatSource(source)
    assert.deepEqual(discovery.scan.formats, ['agent-plugins'])
    assert.equal(discovery.candidates[0].name, 'acme.tools')
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime, createBuiltinParserEngine())
    const installed = (await manager.install(source)).plugins[0]
    assert.equal(installed.plugin.id, 'acme.tools')
    assert.deepEqual(installed.plugin.formats, ['agent-plugins'])
    assert.equal(installed.plugin.protocol?.schema, AGENT_PLUGIN_SCHEMA_URI)
    assert.equal(installed.runtime.status, 'running')
    assert.equal((await ctx.listSkills()).length, 1)
    const config = ctx.shared.mcpConfigs.get('portable')!
    const root = await realpath(layout.sourcePackageDir(installed.install.sourceId))
    const data = await realpath(layout.dataDir('acme.tools'))
    assert.equal(config.cwd, root)
    assert.deepEqual(config.args, [resolve(data, 'cache'), '${UNKNOWN_TOKEN:-literal}'])
    assert.deepEqual(config.env, { LOCATION: resolve(root, 'settings'), VERSION_LITERAL: 'release one',
      PLUGIN_ROOT: root, PLUGIN_DATA: data })
    const saved = resolve(layout.dataDir('acme.tools'), 'state.txt')
    await writeFile(saved, 'persistent data')
    await manager.disable('acme.tools')
    assert.equal((await ctx.listSkills()).length, 0)
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    await manager.enable('acme.tools')
    assert.equal((await ctx.listSkills()).length, 1)
    await fixture(source, 'release two')
    await manager.update('acme.tools')
    assert.equal(await readFile(saved, 'utf8'), 'persistent data')
    assert.equal((ctx.shared.mcpConfigs.get('portable')?.env as any).VERSION_LITERAL, 'release two')
    await manager.uninstall('acme.tools')
    assert.equal((await ctx.listSkills()).length, 0)
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    await assert.rejects(readFile(saved), /ENOENT/)
    assert.deepEqual(await manager.sourceList(), [])
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('坏 Skill、坏 MCP entry、SSE 及未知扩展不妨碍同包有效组件运行', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'partial')
    await fixture(source)
    await put(source, 'plugin.json', { ...manifest(), unexpectedTop: 'do not execute', extensions: { 'com.openai': 42, 'org.example': { hooks: 'never run' } } })
    await put(source, 'skills/invalid/SKILL.md', '---\nname: wrong-name\n---\nInvalid')
    await put(source, 'mcp.json', { $schema: AGENT_MCP_SCHEMA_URI, mcpServers: {
      good: { type: 'stdio', command: 'fake-mcp' },
      bad: { type: 'stdio', command: 'sh', unexpected: 'not allowed' },
      legacy: { type: 'sse', url: 'https://example.invalid/events' },
    } })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) }), createBuiltinParserEngine())
    const installed = (await manager.install(source)).plugins[0]
    assert.equal(installed.enabled, true)
    assert.equal(installed.plugin.diagnostics.some(item => item.level === 'error'), false)
    assert.deepEqual(installed.plugin.skills.map(item => item.name), ['review'])
    assert.deepEqual(installed.plugin.mcpServers.map(item => item.serverName), ['good'])
    assert(installed.plugin.diagnostics.some(item => item.level === 'warning'))
    assert.equal(ctx.shared.hookRuns.length, 0)
    assert.equal((await ctx.listSkills()).length, 1)
    assert.deepEqual([...ctx.shared.mcpConfigs.keys()], ['good'])
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('MCP 启动失败保持另一连接和 Skill，而不把整个包禁用', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'connection-failure')
    await fixture(source)
    await put(source, 'mcp.json', { $schema: AGENT_MCP_SCHEMA_URI, mcpServers: {
      good: { type: 'stdio', command: 'fake-mcp' }, bad: { type: 'stdio', command: 'partial-fail-mcp' },
    } })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) }), createBuiltinParserEngine())
    const installed = (await manager.install(source)).plugins[0]
    assert.equal(installed.enabled, true)
    assert.equal(installed.runtime.status, 'degraded')
    assert.equal((await ctx.listSkills()).length, 1)
    assert(ctx.shared.mcpConfigs.has('good'))
    assert.equal(ctx.shared.mcpConfigs.has('bad'), false)
    assert.equal(ctx.shared.tools.has('mcp__bad__fixture'), false)
    assert.equal(installed.runtime.capabilities.find(item => item.name === 'bad')?.status, 'failed')
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('根 portable 清单不被 legacy Marketplace、清单或内联配置覆盖', async () => {
  const temp = await temporaryDirectory()
  try {
    await fixture(temp.path)
    await put(temp.path, '.claude-plugin/plugin.json', { name: 'legacy-wrong', version: 'legacy' })
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'legacy-market', owner: { name: 'fixture' }, plugins: [{ name: 'legacy-wrong', source: './missing' }] })
    const source = await parseCompatSource(temp.path, { paths: ['missing'] })
    assert.equal(source.scan.discovery, 'single-plugin')
    assert.equal(source.candidates[0].name, 'acme.tools')
    const parsed = await parseCompatPlugin(temp.path, { displayName: 'catalog override', marketplaceDefinitions: [{
      format: 'codex', file: '.agents/plugins/marketplace.json', pointer: '/plugins/0', name: 'legacy-codex',
      version: 'wrong-version', sourcePathIsRoot: true, manifestFields: { name: 'legacy-codex' },
    }] })
    assert.deepEqual(parsed.formats, ['agent-plugins'])
    assert.equal(parsed.name, 'acme.tools')
    assert.equal(parsed.version, 'release one')
    assert.equal(parsed.hooks.length, 0)
  } finally { await temp.cleanup() }
})

test('不支持 schema 的根清单不回退传统推断，也不发现任何组件', async () => {
  const temp = await temporaryDirectory()
  try {
    await fixture(temp.path)
    await put(temp.path, 'plugin.json', { ...manifest(), $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' })
    const parsed = await parseCompatPlugin(temp.path)
    assert.deepEqual(parsed.formats, ['agent-plugins'])
    assert.equal(parsed.protocol, undefined)
    assert.deepEqual(parsed.skills, [])
    assert.deepEqual(parsed.mcpServers, [])
    assert(parsed.diagnostics.some(item => item.level === 'error'))
  } finally { await temp.cleanup() }
})

test('Source 预读名称拒绝越界根清单，不回退 legacy metadata', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'safe-source')
    const outside = resolve(temp.path, 'outside.json')
    await mkdir(source)
    await writeFile(outside, JSON.stringify({ ...manifest(), name: 'outside-private-name' }))
    await symlink(outside, resolve(source, 'plugin.json'))
    await put(source, '.claude-plugin/plugin.json', { name: 'legacy-fallback-must-not-apply' })
    const parsed = await parseCompatSource(source)
    assert.deepEqual(parsed.scan.formats, ['agent-plugins'])
    assert.equal(parsed.candidates[0].name, 'safe-source')
    assert.equal(JSON.stringify(parsed).includes('outside-private-name'), false)
    assert.equal(JSON.stringify(parsed).includes('legacy-fallback-must-not-apply'), false)
    const plugin = await parseCompatPlugin(source)
    assert(plugin.diagnostics.some(item => item.level === 'error'))
    assert.deepEqual(plugin.skills, [])
  } finally { await temp.cleanup() }
})

test('ZIP 单层包装目录可以安装独立 portable 格式', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'portable.zip')
    await createStoredZip(archive, [
      { name: 'package/plugin.json', data: JSON.stringify(manifest()) },
      { name: 'package/skills/review/SKILL.md', data: skill },
    ])
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')), undefined, createBuiltinParserEngine())
    const installed = (await manager.install(archive, { enable: false })).plugins[0]
    assert.deepEqual(installed.plugin.formats, ['agent-plugins'])
    assert.deepEqual(installed.plugin.skills.map(item => item.name), ['review'])
    assert.equal(installed.enabled, false)
  } finally { await temp.cleanup() }
})
