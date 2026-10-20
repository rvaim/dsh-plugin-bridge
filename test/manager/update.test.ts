import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager, CompatibilityError } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('事务更新替换 package/，保留 data/state，并清理 cache', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const v1 = resolve(temp.path, 'v1')
    const v2 = resolve(temp.path, 'v2')
    await buildClaudePlugin(v1, { name: 'updatable', version: '1.0.0', mcpName: 'svc', mcpCommand: 'fake-mcp-v1', marker: 'version-one' })
    await buildClaudePlugin(v2, { name: 'updatable', version: '2.0.0', mcpName: 'svc', mcpCommand: 'fake-mcp-v2', marker: 'version-two' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime, createBuiltinParserEngine())
    assert.equal((await manager.install(v1)).plugins[0].enabled, true)
    await writeFile(resolve(layout.dataDir('updatable'), 'persistent.txt'), '保留我')
    await writeFile(resolve(layout.cacheDir('updatable'), 'old.cache'), '可删除')

    const updated = await manager.update('updatable', { source: v2 })
    assert.equal(updated.scan.plugin.version, '2.0.0')
    assert.equal(updated.state.enabled, true)
    assert.equal(updated.runtime.status, 'running')
    assert.equal(await readFile(resolve(updated.packageRoot, 'marker.txt'), 'utf8'), 'version-two')
    assert.equal(await readFile(resolve(layout.dataDir('updatable'), 'persistent.txt'), 'utf8'), '保留我')
    await assert.rejects(readFile(resolve(layout.cacheDir('updatable'), 'old.cache')), /ENOENT/)
    assert.equal(ctx.shared.mcpConfigs.get('svc')?.command, 'fake-mcp-v2')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('新版运行失败时恢复旧 package、元数据、状态和旧运行实例', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const stable = resolve(temp.path, 'stable')
    const broken = resolve(temp.path, 'broken')
    await buildClaudePlugin(stable, { name: 'rollback', version: '2.0.0', mcpName: 'svc', mcpCommand: 'fake-mcp-v2', marker: 'stable' })
    await buildClaudePlugin(broken, { name: 'rollback', version: '3.0.0', mcpName: 'svc', mcpCommand: 'fail-mcp', marker: 'broken' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime, createBuiltinParserEngine())
    await manager.install(stable)
    await writeFile(resolve(layout.dataDir('rollback'), 'persistent.txt'), 'data')

    await assert.rejects(manager.update('rollback', { source: broken }), /新版插件 rollback 运行实例启动失败/)
    const inspection = await manager.inspect('rollback')
    assert.equal(inspection.scan.plugin.version, '2.0.0')
    assert.equal(inspection.state.enabled, true)
    assert.equal(await readFile(resolve(inspection.packageRoot, 'marker.txt'), 'utf8'), 'stable')
    assert.equal(await readFile(resolve(layout.dataDir('rollback'), 'persistent.txt'), 'utf8'), 'data')
    assert.equal(ctx.shared.mcpConfigs.get('svc')?.command, 'fake-mcp-v2')
    assert.equal(runtime.get('rollback').status, 'running')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('新版静态解析有 error 时不停止旧实例、不交换目录', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const stable = resolve(temp.path, 'stable')
    const invalid = resolve(temp.path, 'invalid')
    await buildClaudePlugin(stable, { name: 'static-check', version: '1.0.0', mcpName: 'svc', marker: 'stable' })
    await buildClaudePlugin(invalid, { name: 'static-check', version: '2.0.0', unsupportedHook: true, marker: 'invalid' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime, createBuiltinParserEngine())
    await manager.install(stable)
    await assert.rejects(
      manager.update('static-check', { source: invalid }),
      error => error instanceof CompatibilityError,
    )
    const inspection = await manager.inspect('static-check')
    assert.equal(await readFile(resolve(inspection.packageRoot, 'marker.txt'), 'utf8'), 'stable')
    assert.equal(ctx.shared.mcpConfigs.has('svc'), true)
    assert.equal(runtime.get('static-check').status, 'running')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})


test('checkUpdates 探测目录 Source 的 revision 变化，并在更新后收敛', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'source')
    await buildClaudePlugin(source, { name: 'updatable-check', version: '1.0.0', marker: 'v1' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    await manager.install(source)

    const before = await manager.checkUpdates()
    assert.equal(before.length, 1)
    assert.equal(before[0].updateAvailable, false)
    assert.deepEqual(before[0].affectedPluginIds, ['updatable-check'])

    await writeFile(resolve(source, 'marker.txt'), 'v2')
    const changed = await manager.checkUpdates()
    assert.equal(changed[0].updateAvailable, true)
    assert.notEqual(changed[0].latestRevision, changed[0].currentRevision)

    await manager.update('updatable-check')
    const after = await manager.checkUpdates()
    assert.equal(after[0].updateAvailable, false)
    assert.equal(await readFile(resolve((await manager.inspect('updatable-check')).packageRoot, 'marker.txt'), 'utf8'), 'v2')
  } finally {
    await temp.cleanup()
  }
})
