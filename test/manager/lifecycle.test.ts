import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

const claudeFixture = resolve('test/fixtures/claude-code/full')

async function setup(): Promise<{
  temp: Awaited<ReturnType<typeof temporaryDirectory>>
  ctx: FakeContext
  layout: CompatLayout
  manager: CompatManager
}> {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  ctx.setCredential('GITHUB_TOKEN', 'resolved-token')
  const layout = new CompatLayout(resolve(temp.path, 'home'))
  const runtime = new CompatRuntimeManager(ctx, layout, {
    workspaceRoot: resolve(temp.path, 'workspace'),
    dependencies: fakeRuntimeDependencies(ctx.shared),
  })
  return { temp, ctx, layout, manager: new CompatManager(layout, runtime, createBuiltinParserEngine()) }
}

test('安装、禁用、启用和整体卸载完整旧插件', async () => {
  const { temp, ctx, layout, manager } = await setup()
  try {
    const installed = (await manager.install(claudeFixture)).plugins[0]
    assert.equal(installed.plugin.id, 'legacy-full')
    assert.equal(installed.enabled, true)
    assert.equal(installed.runtime.status, 'running')
    const packageRoot = resolve(layout.sourcePackageDir(installed.install.sourceId), installed.install.location.type === 'source-path' ? installed.install.location.path : '.')
    assert.equal(await readFile(resolve(packageRoot, 'skills/review/SKILL.md'), 'utf8').then(value => value.includes('代码审查')), true)
    await assert.rejects(readFile(resolve(layout.harnessHome, 'skills', 'review', 'SKILL.md')), /ENOENT/)
    await assert.rejects(readFile(resolve(layout.harnessHome, 'mcp.json')), /ENOENT/)
    assert.equal((await ctx.listSkills()).length, 1)
    assert.equal(ctx.shared.mcpConfigs.size, 2)

    const disabled = await manager.disable('legacy-full')
    assert.equal(disabled.state.enabled, false)
    assert.equal(disabled.runtime.status, 'disabled')
    assert.equal((await ctx.listSkills()).length, 0)
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    assert.match(await readFile(resolve(packageRoot, '.claude-plugin/plugin.json'), 'utf8'), /legacy-full/)

    const enabled = await manager.enable('legacy-full')
    assert.equal(enabled.state.enabled, true)
    assert.equal(enabled.runtime.status, 'running')
    assert.equal((await ctx.listSkills()).length, 1)

    const history = resolve(layout.harnessHome, 'sessions', 'history.log')
    await mkdir(resolve(layout.harnessHome, 'sessions'), { recursive: true })
    await writeFile(history, '历史会话不可删除')
    await manager.uninstall('legacy-full')
    await assert.rejects(readFile(layout.installFile('legacy-full')), /ENOENT/)
    assert.equal(await readFile(history, 'utf8'), '历史会话不可删除')
    assert.equal((await ctx.listSkills()).length, 0)
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('包含不支持能力的插件仍安装，但保持 disabled 并可 inspect', async () => {
  const { temp, ctx, manager } = await setup()
  try {
    const source = resolve(temp.path, 'unsupported')
    await buildClaudePlugin(source, { name: 'unsupported', unsupportedHook: true })
    const installed = (await manager.install(source)).plugins[0]
    assert.equal(installed.enabled, false)
    assert.equal(installed.plugin.diagnostics.some(item => item.code === 'HOOK_EVENT_RUNTIME_UNSUPPORTED'), true)
    const inspection = await manager.inspect('unsupported')
    assert.equal(inspection.state.enabled, false)
    assert.equal(inspection.scan.plugin.diagnostics.some(item => item.level === 'error'), true)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('两个插件能力名称冲突时不自动改名，冲突插件不能启用', async () => {
  const { temp, ctx, manager } = await setup()
  try {
    const first = resolve(temp.path, 'first')
    const second = resolve(temp.path, 'second')
    await buildClaudePlugin(first, { name: 'first', skillName: 'same-skill', mcpName: 'same_mcp' })
    await buildClaudePlugin(second, { name: 'second', skillName: 'same-skill', mcpName: 'same_mcp' })
    assert.equal((await manager.install(first)).plugins[0].enabled, true)
    const secondResult = (await manager.install(second)).plugins[0]
    assert.equal(secondResult.enabled, false)
    assert(secondResult.plugin.diagnostics.some(item => item.code === 'MCP_SERVER_NAME_CONFLICT'))
    assert(secondResult.plugin.diagnostics.some(item => item.code === 'SKILL_NAME_CONFLICT'))
    assert.equal(secondResult.plugin.mcpServers[0].serverName, 'same_mcp')
    assert.equal(secondResult.plugin.skills[0].name, 'same-skill')

    await manager.disable('first')
    const enabledSecond = await manager.enable('second')
    assert.equal(enabledSecond.state.enabled, true)
    assert.equal(enabledSecond.scan.plugin.diagnostics.some(item => item.code.endsWith('_CONFLICT')), false)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('同时安装同一插件仅有一个成功，不留下半安装目录', async () => {
  const { temp, ctx, layout, manager } = await setup()
  try {
    const source = resolve(temp.path, 'concurrent')
    await buildClaudePlugin(source, { name: 'concurrent', skillName: 'concurrent-skill' })
    const results = await Promise.allSettled([
      manager.install(source, { enable: false }),
      manager.install(source, { enable: false }),
    ])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter(item => item.status === 'rejected').length, 1)
    assert.match(await readFile(layout.installFile('concurrent'), 'utf8'), /concurrent/)
    assert.deepEqual(await readdir(layout.temp), [])
    assert.deepEqual(await readdir(layout.installed), ['concurrent'])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('list 按 priority 再按 pluginId 稳定排序', async () => {
  const { temp, ctx, manager } = await setup()
  try {
    const a = resolve(temp.path, 'a')
    const b = resolve(temp.path, 'b')
    const c = resolve(temp.path, 'c')
    await buildClaudePlugin(a, { name: 'zeta' })
    await buildClaudePlugin(b, { name: 'alpha' })
    await buildClaudePlugin(c, { name: 'middle' })
    await manager.install(a, { enable: false, priority: 0 })
    await manager.install(b, { enable: false, priority: 0 })
    await manager.install(c, { enable: false, priority: -1 })
    assert.deepEqual((await manager.list()).map(item => item.id), ['middle', 'alpha', 'zeta'])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('list/inspect 在 parserVersion 变化时从 package 真源重建 scan.json', async () => {
  const { temp, ctx, layout, manager } = await setup()
  try {
    const source = resolve(temp.path, 'rescan-manager')
    await buildClaudePlugin(source, { name: 'rescan-manager', skillName: 'first-skill' })
    await manager.install(source, { enable: false })

    const stale = JSON.parse(await readFile(layout.scanFile('rescan-manager'), 'utf8')) as Record<string, unknown>
    await writeFile(layout.scanFile('rescan-manager'), JSON.stringify({ ...stale, parserVersion: '0.0.0' }))
    await mkdir(resolve(layout.sourcePackageDir('rescan-manager'), 'skills', 'second-skill'), { recursive: true })
    await writeFile(
      resolve(layout.sourcePackageDir('rescan-manager'), 'skills/second-skill/SKILL.md'),
      '---\nname: second-skill\ndescription: 重新扫描发现的能力\n---\n正文',
    )

    const inspection = await manager.inspect('rescan-manager')
    assert.equal(inspection.scan.plugin.skills.length, 2)
    assert.equal((await manager.list()).find(item => item.id === 'rescan-manager')?.skills, 2)
    const refreshed = JSON.parse(await readFile(layout.scanFile('rescan-manager'), 'utf8')) as { parserVersion: string }
    assert.notEqual(refreshed.parserVersion, '0.0.0')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})
