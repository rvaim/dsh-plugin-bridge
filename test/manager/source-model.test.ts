import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  CompatManager,
  CompatibilityError,
  SharedSourceUpdateError,
} from '../../src/manager/manager.js'
import type { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { runProcess } from '../../src/source/process.js'
import { CompatLayout } from '../../src/store/layout.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import type { PluginRuntimeSnapshot } from '../../src/types/runtime.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function writeClaudeMarketplace(
  root: string,
  plugins: unknown[],
  name = 'test-market',
): Promise<void> {
  await mkdir(resolve(root, '.claude-plugin'), { recursive: true })
  await writeFile(resolve(root, '.claude-plugin/marketplace.json'), JSON.stringify({
    name,
    owner: { name: 'Plugin Bridge 测试' },
    plugins,
  }, null, 2))
}

async function initializeGitRepository(root: string): Promise<string> {
  await runProcess('git', ['init', root])
  await runProcess('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await runProcess('git', ['-C', root, 'config', 'user.name', 'Plugin Bridge Test'])
  await runProcess('git', ['-C', root, 'add', '.'])
  await runProcess('git', ['-C', root, 'commit', '-m', 'initial'])
  return (await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}

async function commitAll(root: string, message: string): Promise<string> {
  await runProcess('git', ['-C', root, 'add', '.'])
  await runProcess('git', ['-C', root, 'commit', '-m', message])
  return (await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}

class ScriptedRuntime {
  readonly failStartCalls: Set<number>
  readonly failStopCalls: Set<number>
  readonly snapshots = new Map<string, PluginRuntimeSnapshot>()
  readonly mountedModels = new Map<string, { model: string; packageRoot: string }>()
  startCalls = 0
  stopCalls = 0

  constructor(options: { failStartCalls?: number[]; failStopCalls?: number[] } = {}) {
    this.failStartCalls = new Set(options.failStartCalls ?? [])
    this.failStopCalls = new Set(options.failStopCalls ?? [])
  }

  get(pluginId: string): PluginRuntimeSnapshot {
    return this.snapshots.get(pluginId) ?? { pluginId, status: 'disabled', capabilities: [] }
  }

  noteFailure(pluginId: string, error: string): PluginRuntimeSnapshot {
    const snapshot: PluginRuntimeSnapshot = { pluginId, status: 'failed', capabilities: [], error }
    this.snapshots.set(pluginId, snapshot)
    return snapshot
  }

  isCurrent(plugin: CompatPlugin, packageRoot: string): boolean {
    const mounted = this.mountedModels.get(plugin.id)
    return this.get(plugin.id).status === 'running' && mounted?.model === JSON.stringify(plugin) && mounted.packageRoot === packageRoot
  }

  async start(plugin: CompatPlugin, packageRoot: string): Promise<PluginRuntimeSnapshot> {
    this.startCalls += 1
    if (this.failStartCalls.has(this.startCalls)) {
      return this.noteFailure(plugin.id, `测试注入的第 ${this.startCalls} 次启动失败`)
    }
    this.mountedModels.set(plugin.id, { model: JSON.stringify(plugin), packageRoot })
    const snapshot: PluginRuntimeSnapshot = { pluginId: plugin.id, status: 'running', capabilities: [] }
    this.snapshots.set(plugin.id, snapshot)
    return snapshot
  }

  async stop(pluginId: string): Promise<PluginRuntimeSnapshot> {
    this.stopCalls += 1
    if (this.failStopCalls.has(this.stopCalls)) {
      throw new Error(`测试注入的第 ${this.stopCalls} 次停止失败`)
    }
    this.mountedModels.delete(pluginId)
    const snapshot: PluginRuntimeSnapshot = { pluginId, status: 'disabled', capabilities: [] }
    this.snapshots.set(pluginId, snapshot)
    return snapshot
  }
}

test('多插件 Marketplace 只安装被选择项，共享 Source 只保存一份完整内容', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a', skillName: 'skill-a' })
    await buildClaudePlugin(resolve(source, 'plugins/b'), { name: 'b', skillName: 'skill-b' })
    await buildClaudePlugin(resolve(source, 'plugins/c'), { name: 'c', skillName: 'skill-c' })
    await writeClaudeMarketplace(source, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
      { name: 'c', source: './plugins/c' },
    ], 'shared-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    const installed = await manager.install(source, {
      sourceAs: 'shared-market',
      plugins: [{ pluginId: 'a' }, { pluginId: 'c' }],
      enable: false,
    })

    assert.deepEqual(installed.plugins.map(item => item.plugin.id), ['a', 'c'])
    assert.deepEqual(installed.source.installedPlugins.map(item => item.pluginId), ['a', 'c'])
    assert.deepEqual(installed.source.scan.plugins.map(item => item.id), ['a', 'b', 'c'])
    assert.match(
      await readFile(resolve(layout.sourcePackageDir('shared-market'), 'plugins/b/.claude-plugin/plugin.json'), 'utf8'),
      /"b"/,
    )
    await assert.rejects(lstat(resolve(layout.pluginRoot('a'), 'package')), /ENOENT/)
    await assert.rejects(lstat(layout.pluginRoot('b')), /ENOENT/)

    await manager.uninstall('a')
    assert.deepEqual((await manager.sourceInspect('shared-market')).installedPlugins.map(item => item.pluginId), ['c'])
    assert.equal((await manager.inspect('c')).scan.plugin.id, 'c')

    await manager.uninstall('c')
    await assert.rejects(lstat(layout.sourceRoot('shared-market')), /ENOENT/)
    await assert.rejects(lstat(layout.sourceExternalRoot('shared-market')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})


test('多插件 Source 未显式选择时拒绝安装，并列出全部候选 ID', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'select-market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await buildClaudePlugin(resolve(source, 'plugins/b'), { name: 'b' })
    await writeClaudeMarketplace(source, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
    ], 'select-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await assert.rejects(
      manager.install(source, { sourceAs: 'select-market', enable: false }),
      /必须通过 plugins 显式选择：a, b/,
    )

    await layout.ensure()
    assert.deepEqual(await readdir(layout.sources), [])
    assert.deepEqual(await readdir(layout.installed), [])
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await temp.cleanup()
  }
})

test('显式 Source 在引用归零后保留，仍被 Plugin 引用时禁止删除', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await writeClaudeMarketplace(source, [{ name: 'a', source: './plugins/a' }], 'explicit-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    const added = await manager.sourceAdd(source, { as: 'explicit-market' })
    assert.equal(added.source.ownership, 'explicit')

    const installed = (await manager.install('a@explicit-market', { enable: false })).plugins[0]
    assert.equal(installed.install.sourceId, 'explicit-market')
    await assert.rejects(manager.sourceRemove('explicit-market'), /仍被以下已安装插件使用：a/)

    await manager.uninstall('a')
    const retained = await manager.sourceInspect('explicit-market')
    assert.equal(retained.source.ownership, 'explicit')
    assert.deepEqual(retained.installedPlugins, [])

    await manager.sourceRemove('explicit-market')
    await assert.rejects(lstat(layout.sourceRoot('explicit-market')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('一次选择多个 Plugin 时，任一 Marketplace 位置无效则整体不提交', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'atomic-market')
    await buildClaudePlugin(resolve(source, 'plugins/good'), { name: 'good' })
    await writeClaudeMarketplace(source, [
      { name: 'good', source: './plugins/good' },
      { name: 'missing', source: './plugins/missing' },
    ], 'atomic-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await assert.rejects(
      manager.install(source, {
        sourceAs: 'atomic-market',
        plugins: [{ pluginId: 'good' }, { pluginId: 'missing' }],
        enable: false,
      }),
      error => error instanceof CompatibilityError,
    )

    await layout.ensure()
    assert.deepEqual(await readdir(layout.sources), [])
    assert.deepEqual(await readdir(layout.installed), [])
    assert.deepEqual(await readdir(layout.external), [])
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await temp.cleanup()
  }
})

test('共享 Source 更新影响全部已安装 Plugin，新候选只进入可安装列表', async () => {
  const temp = await temporaryDirectory()
  try {
    const v1 = resolve(temp.path, 'v1')
    const v2 = resolve(temp.path, 'v2')
    const missing = resolve(temp.path, 'missing')

    await buildClaudePlugin(resolve(v1, 'plugins/a'), { name: 'a', version: '1.0.0', marker: 'a-v1' })
    await buildClaudePlugin(resolve(v1, 'plugins/b'), { name: 'b', version: '1.0.0', marker: 'b-v1' })
    await writeClaudeMarketplace(v1, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
    ], 'update-market')

    await buildClaudePlugin(resolve(v2, 'plugins/a'), { name: 'a', version: '2.0.0', marker: 'a-v2' })
    await buildClaudePlugin(resolve(v2, 'plugins/b'), { name: 'b', version: '2.0.0', marker: 'b-v2' })
    await buildClaudePlugin(resolve(v2, 'plugins/d'), { name: 'd', version: '1.0.0', marker: 'd-v1' })
    await writeClaudeMarketplace(v2, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
      { name: 'd', source: './plugins/d' },
    ], 'update-market')

    await buildClaudePlugin(resolve(missing, 'plugins/a'), { name: 'a', version: '3.0.0', marker: 'a-v3' })
    await writeClaudeMarketplace(missing, [{ name: 'a', source: './plugins/a' }], 'update-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.install(v1, {
      sourceAs: 'update-market',
      plugins: [{ pluginId: 'a' }, { pluginId: 'b' }],
      enable: false,
    })

    await assert.rejects(
      manager.update('a', { source: v2 }),
      error => error instanceof SharedSourceUpdateError
        && error.sourceId === 'update-market'
        && error.pluginIds.join(',') === 'a,b',
    )

    await manager.update('a', { source: v2, confirmShared: true })
    assert.equal(await readFile(resolve((await manager.inspect('a')).packageRoot, 'marker.txt'), 'utf8'), 'a-v2')
    assert.equal(await readFile(resolve((await manager.inspect('b')).packageRoot, 'marker.txt'), 'utf8'), 'b-v2')
    const sourceAfter = await manager.sourceInspect('update-market')
    assert.deepEqual(sourceAfter.scan.plugins.map(item => item.id), ['a', 'b', 'd'])
    assert.deepEqual(sourceAfter.installedPlugins.map(item => item.pluginId), ['a', 'b'])
    assert.equal((await manager.list()).some(item => item.id === 'd'), false)

    await assert.rejects(manager.sourceUpdate('update-market', { source: missing }), /已安装插件 b 消失/)
    assert.equal(await readFile(resolve((await manager.inspect('a')).packageRoot, 'marker.txt'), 'utf8'), 'a-v2')
    assert.equal(await readFile(resolve((await manager.inspect('b')).packageRoot, 'marker.txt'), 'utf8'), 'b-v2')
  } finally {
    await temp.cleanup()
  }
})

test('共享 Source 中第二个新版 Plugin 启动失败时整体恢复全部旧运行实例', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const v1 = resolve(temp.path, 'runtime-v1')
    const v2 = resolve(temp.path, 'runtime-v2')

    await buildClaudePlugin(resolve(v1, 'plugins/a'), {
      name: 'a',
      version: '1.0.0',
      marker: 'a-v1',
      mcpName: 'mcp-a',
      mcpCommand: 'fake-a-v1',
    })
    await buildClaudePlugin(resolve(v1, 'plugins/b'), {
      name: 'b',
      version: '1.0.0',
      marker: 'b-v1',
      mcpName: 'mcp-b',
      mcpCommand: 'fake-b-v1',
    })
    await writeClaudeMarketplace(v1, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
    ], 'runtime-rollback-market')

    await buildClaudePlugin(resolve(v2, 'plugins/a'), {
      name: 'a',
      version: '2.0.0',
      marker: 'a-v2',
      mcpName: 'mcp-a',
      mcpCommand: 'fake-a-v2',
    })
    await buildClaudePlugin(resolve(v2, 'plugins/b'), {
      name: 'b',
      version: '2.0.0',
      marker: 'b-v2',
      mcpName: 'mcp-b',
      mcpCommand: 'fail-mcp',
    })
    await writeClaudeMarketplace(v2, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
    ], 'runtime-rollback-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new (await import('../../src/runtime/manager.js')).CompatRuntimeManager(ctx, layout, {
      dependencies: fakeRuntimeDependencies(ctx.shared),
    })
    const manager = new CompatManager(layout, runtime, createBuiltinParserEngine())
    await manager.install(v1, {
      sourceAs: 'runtime-rollback-market',
      plugins: [{ pluginId: 'a' }, { pluginId: 'b' }],
      enable: true,
    })

    await assert.rejects(
      manager.sourceUpdate('runtime-rollback-market', { source: v2 }),
      /新版插件 b 运行实例启动失败/,
    )

    const a = await manager.inspect('a')
    const b = await manager.inspect('b')
    assert.equal(a.scan.plugin.version, '1.0.0')
    assert.equal(b.scan.plugin.version, '1.0.0')
    assert.equal(await readFile(resolve(a.packageRoot, 'marker.txt'), 'utf8'), 'a-v1')
    assert.equal(await readFile(resolve(b.packageRoot, 'marker.txt'), 'utf8'), 'b-v1')
    assert.equal(ctx.shared.mcpConfigs.get('mcp-a')?.command, 'fake-a-v1')
    assert.equal(ctx.shared.mcpConfigs.get('mcp-b')?.command, 'fake-b-v1')
    assert.equal(runtime.get('a').status, 'running')
    assert.equal(runtime.get('b').status, 'running')
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('Marketplace 外部 Git Plugin 保存在顶层 external，并随 Source 整体更新和删除', async () => {
  const temp = await temporaryDirectory()
  try {
    const remote = resolve(temp.path, 'remote-plugin')
    await buildClaudePlugin(remote, { name: 'remote', version: '1.0.0', marker: 'remote-v1' })
    const firstCommit = await initializeGitRepository(remote)

    const marketplace = resolve(temp.path, 'marketplace')
    await writeClaudeMarketplace(marketplace, [{
      name: 'remote',
      source: { source: 'url', url: `file://${remote}` },
    }], 'external-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    const installed = (await manager.install(marketplace, {
      sourceAs: 'external-market',
      plugins: [{ pluginId: 'remote' }],
      enable: false,
    })).plugins[0]

    assert.equal(installed.install.location.type, 'git')
    assert.equal(installed.install.location.type === 'git' ? installed.install.location.sha : undefined, firstCommit)
    assert.equal(installed.install.materialization?.commit, firstCommit)
    assert.equal(await readFile(resolve((await manager.inspect('remote')).packageRoot, 'marker.txt'), 'utf8'), 'remote-v1')
    await lstat(layout.sourceExternalPackageDir('external-market', 'remote'))
    await assert.rejects(lstat(resolve(layout.sourceRoot('external-market'), 'external')), /ENOENT/)

    await writeFile(resolve(remote, 'marker.txt'), 'remote-v2')
    await writeFile(resolve(remote, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'remote',
      version: '2.0.0',
    }))
    const secondCommit = await commitAll(remote, 'second')

    await manager.sourceUpdate('external-market')
    const updated = await manager.inspect('remote')
    assert.equal(updated.install.location.type === 'git' ? updated.install.location.sha : undefined, secondCommit)
    assert.equal(updated.install.materialization?.commit, secondCommit)
    assert.equal(updated.scan.plugin.version, '2.0.0')
    assert.equal(await readFile(resolve(updated.packageRoot, 'marker.txt'), 'utf8'), 'remote-v2')

    await manager.uninstall('remote')
    await assert.rejects(lstat(layout.sourceRoot('external-market')), /ENOENT/)
    await assert.rejects(lstat(layout.sourceExternalRoot('external-market')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('复用已有 Source 时不静默忽略冲突的 --source-as', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await writeClaudeMarketplace(source, [{ name: 'a', source: './plugins/a' }], 'canonical-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.sourceAdd(source, { as: 'canonical-market' })

    await assert.rejects(
      manager.install(source, {
        sourceAs: 'another-name',
        plugins: [{ pluginId: 'a' }],
        enable: false,
      }),
      /--source-as another-name 不会被静默忽略/,
    )
    assert.deepEqual((await manager.sourceInspect('canonical-market')).installedPlugins, [])
  } finally {
    await temp.cleanup()
  }
})

test('外部 Git Plugin 新版启动失败时恢复旧 Source、旧提交与旧运行实例', async () => {
  const temp = await temporaryDirectory()
  try {
    const remote = resolve(temp.path, 'rollback-remote')
    await buildClaudePlugin(remote, { name: 'remote', version: '1.0.0', marker: 'remote-v1' })
    const firstCommit = await initializeGitRepository(remote)

    const marketplace = resolve(temp.path, 'rollback-marketplace')
    await writeClaudeMarketplace(marketplace, [{
      name: 'remote',
      source: { source: 'url', url: `file://${remote}` },
    }], 'rollback-market')

    const runtime = new ScriptedRuntime({ failStartCalls: [2] })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, runtime as unknown as CompatRuntimeManager, createBuiltinParserEngine())
    await manager.install(marketplace, {
      sourceAs: 'rollback-market',
      plugins: [{ pluginId: 'remote' }],
      enable: true,
    })

    await writeFile(resolve(remote, 'marker.txt'), 'remote-v2')
    await writeFile(resolve(remote, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'remote',
      version: '2.0.0',
    }))
    await commitAll(remote, 'runtime failure')

    await assert.rejects(
      manager.sourceUpdate('rollback-market'),
      /新版插件 remote 运行实例启动失败/,
    )

    const restored = await manager.inspect('remote')
    assert.equal(restored.install.materialization?.commit, firstCommit)
    assert.equal(restored.scan.plugin.version, '1.0.0')
    assert.equal(await readFile(resolve(restored.packageRoot, 'marker.txt'), 'utf8'), 'remote-v1')
    assert.equal(runtime.get('remote').status, 'running')
    assert.equal(runtime.startCalls, 3)
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await temp.cleanup()
  }
})

test('新版运行实例无法停止时保留正在使用的 Source 与事务恢复材料', async () => {
  const temp = await temporaryDirectory()
  try {
    const v1 = resolve(temp.path, 'stop-failure-v1')
    const v2 = resolve(temp.path, 'stop-failure-v2')
    await buildClaudePlugin(resolve(v1, 'plugins/a'), { name: 'a', version: '1.0.0', marker: 'a-v1' })
    await writeClaudeMarketplace(v1, [{ name: 'a', source: './plugins/a' }], 'stop-failure-market')
    await buildClaudePlugin(resolve(v2, 'plugins/a'), { name: 'a', version: '2.0.0', marker: 'a-v2' })
    await writeClaudeMarketplace(v2, [{ name: 'a', source: './plugins/a' }], 'stop-failure-market')

    const runtime = new ScriptedRuntime({ failStartCalls: [2], failStopCalls: [2] })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, runtime as unknown as CompatRuntimeManager, createBuiltinParserEngine())
    await manager.install(v1, {
      sourceAs: 'stop-failure-market',
      plugins: [{ pluginId: 'a' }],
      enable: true,
    })

    await assert.rejects(
      manager.sourceUpdate('stop-failure-market', { source: v2 }),
      error => error instanceof AggregateError
        && /回滚未完全成功/.test(error.message)
        && /恢复材料已保留在/.test(error.message),
    )

    // 新版父实例无法确认已停止时，禁止删除其可能仍在使用的正式 Source。
    assert.equal(
      await readFile(resolve(layout.sourcePackageDir('stop-failure-market'), 'plugins/a/marker.txt'), 'utf8'),
      'a-v2',
    )
    const transactions = await readdir(layout.temp)
    assert.equal(transactions.length, 1)
    assert.match(transactions[0] ?? '', /^source-update-stop-failure-market-/)
    assert.equal(
      await readFile(resolve(layout.temp, transactions[0]!, 'backup-source/package/plugins/a/marker.txt'), 'utf8'),
      'a-v1',
    )
  } finally {
    await temp.cleanup()
  }
})

test('Source Plugin 可使用管理别名安装，但同一具体 Plugin 不能以另一别名重复安装', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'alias-market')
    await buildClaudePlugin(resolve(source, 'plugins/original'), { name: 'original' })
    await writeClaudeMarketplace(source, [{ name: 'original', source: './plugins/original' }], 'alias-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.sourceAdd(source, { as: 'alias-market' })
    await manager.install('original@alias-market', { as: 'managed-alias', enable: false })

    const inspection = await manager.sourceInspect('alias-market')
    assert.deepEqual(inspection.installedPlugins, [{
      pluginId: 'managed-alias',
      sourcePluginId: 'original',
    }])
    assert.equal((await manager.inspect('managed-alias')).install.sourcePluginId, 'original')

    await assert.rejects(
      manager.install('original@alias-market', { as: 'second-alias', enable: false }),
      /已安装为 managed-alias；一个具体 Plugin 不能重复安装/,
    )
    await assert.rejects(lstat(layout.pluginRoot('second-alias')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('损坏的 install.json 会保守阻止 Source 删除和隐式 Source 自动回收', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'conservative-market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await writeClaudeMarketplace(source, [{ name: 'a', source: './plugins/a' }], 'conservative-market')

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.install(source, {
      sourceAs: 'conservative-market',
      plugins: [{ pluginId: 'a' }],
      enable: false,
    })
    await mkdir(layout.pluginRoot('broken-record'), { recursive: true })
    await writeFile(layout.installFile('broken-record'), '{ not-json')

    const inspection = await manager.sourceInspect('conservative-market')
    assert.deepEqual(inspection.unreadablePluginIds, ['broken-record'])
    await assert.rejects(
      manager.sourceRemove('conservative-market'),
      /不能安全删除 Source conservative-market：broken-record/,
    )

    await manager.uninstall('a')
    // Source 是 implicit 且已无已知引用，但未知归属记录存在时必须保留。
    await lstat(layout.sourceRoot('conservative-market'))
    assert.deepEqual((await manager.sourceInspect('conservative-market')).installedPlugins, [])
  } finally {
    await temp.cleanup()
  }
})

test('禁用 Plugin 的同名能力不阻止共享 Source 更新，启用时再执行冲突检查', async () => {
  const temp = await temporaryDirectory()
  try {
    const v1 = resolve(temp.path, 'disabled-conflict-v1')
    const v2 = resolve(temp.path, 'disabled-conflict-v2')
    for (const [root, version] of [[v1, '1.0.0'], [v2, '2.0.0']] as const) {
      await buildClaudePlugin(resolve(root, 'plugins/a'), {
        name: 'a',
        version,
        skillName: 'shared-skill',
        marker: `a-${version}`,
      })
      await buildClaudePlugin(resolve(root, 'plugins/b'), {
        name: 'b',
        version,
        skillName: 'shared-skill',
        marker: `b-${version}`,
      })
      await writeClaudeMarketplace(root, [
        { name: 'a', source: './plugins/a' },
        { name: 'b', source: './plugins/b' },
      ], 'disabled-conflict-market')
    }

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.install(v1, {
      sourceAs: 'disabled-conflict-market',
      plugins: [{ pluginId: 'a' }, { pluginId: 'b' }],
      enable: false,
    })

    await manager.sourceUpdate('disabled-conflict-market', { source: v2 })
    assert.equal((await manager.inspect('a')).scan.plugin.version, '2.0.0')
    assert.equal((await manager.inspect('b')).scan.plugin.version, '2.0.0')

    await manager.enable('a')
    await assert.rejects(
      manager.enable('b'),
      error => error instanceof CompatibilityError
        && error.diagnostics.some(item => item.code === 'SKILL_NAME_CONFLICT'),
    )
    assert.equal((await manager.inspect('b')).state.enabled, false)
  } finally {
    await temp.cleanup()
  }
})
