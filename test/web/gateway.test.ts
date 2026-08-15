import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { CompatWebOperations } from '../../src/web/gateway.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function buildMarketplace(root: string): Promise<void> {
  await buildClaudePlugin(resolve(root, 'plugins/alpha'), {
    name: 'alpha',
    version: '1.0.0',
    skillName: 'alpha-skill',
  })
  await buildClaudePlugin(resolve(root, 'plugins/beta'), {
    name: 'beta',
    hookEvent: 'PreToolUse',
  })
  await mkdir(resolve(root, '.claude-plugin'), { recursive: true })
  await writeFile(resolve(root, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'web-market',
    owner: { name: 'dsh-compat test' },
    plugins: [
      { name: 'alpha', source: './plugins/alpha' },
      { name: 'beta', source: './plugins/beta' },
    ],
  }))
}

function operations(manager: CompatManager): CompatWebOperations {
  return new CompatWebOperations({
    prepareInstall: (source, options) => manager.prepareInstall(source, options),
    sourceRemove: sourceId => manager.sourceRemove(sourceId),
    install: (source, options) => manager.install(source, options),
    list: () => manager.list(),
    checkUpdates: () => manager.checkUpdates(),
    update: (pluginId, options) => manager.update(pluginId, options),
    enable: pluginId => manager.enable(pluginId),
    disable: pluginId => manager.disable(pluginId),
    uninstall: pluginId => manager.uninstall(pluginId),
  })
}

test('Web 多插件选择复用第一次拉取的固定快照，并可动态管理生命周期', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildMarketplace(source)
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')))
    const web = operations(manager)

    const begun = await web.beginAdd(source)
    assert.equal(begun.kind, 'selection')
    if (begun.kind !== 'selection') return
    assert.deepEqual(begun.candidates.map(item => item.id), ['alpha', 'beta'])

    // 第二步必须使用已经固定的 Source；删除用户输入位置后仍能完成安装。
    await rm(source, { recursive: true, force: true })
    const completed = await web.completeAdd(begun.requestId, ['alpha'])
    assert.equal(completed.kind, 'installed')
    if (completed.kind !== 'installed') return
    assert.equal(completed.plugins[0]?.id, 'alpha')
    assert.equal(completed.plugins[0]?.runtimeStatus, 'pending-restart')
    assert.equal(completed.plugins[0]?.skills, 1)

    const disabled = await web.setEnabled('alpha', false)
    assert.equal(disabled.kind, 'updated')
    if (disabled.kind === 'updated') assert.equal(disabled.plugin.runtimeStatus, 'disabled')
    const enabled = await web.setEnabled('alpha', true)
    assert.equal(enabled.kind, 'updated')
    if (enabled.kind === 'updated') assert.equal(enabled.plugin.runtimeStatus, 'pending-restart')

    assert.deepEqual(await web.uninstall('alpha'), { kind: 'removed', pluginId: 'alpha' })
    assert.deepEqual(await manager.sourceList(), [])
    await web.dispose()
  } finally {
    await temp.cleanup()
  }
})

test('Web 取消多插件选择会回收未被引用的临时 Source', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildMarketplace(source)
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')))
    const web = operations(manager)

    const begun = await web.beginAdd(source)
    assert.equal(begun.kind, 'selection')
    if (begun.kind !== 'selection') return
    assert.equal((await manager.sourceList()).length, 1)
    assert.deepEqual(await web.cancelAdd(begun.requestId), { kind: 'cancelled' })
    assert.deepEqual(await manager.sourceList(), [])
    assert.deepEqual(await web.cancelAdd(begun.requestId), { kind: 'cancelled' })
  } finally {
    await temp.cleanup()
  }
})

test('并发选择同一新 Source 时只由最后一个请求负责回收快照', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildMarketplace(source)
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')))
    const web = operations(manager)

    const first = await web.beginAdd(source)
    const second = await web.beginAdd(source)
    assert.equal(first.kind, 'selection')
    assert.equal(second.kind, 'selection')
    if (first.kind !== 'selection' || second.kind !== 'selection') return

    assert.deepEqual(await web.cancelAdd(first.requestId), { kind: 'cancelled' })
    assert.equal((await manager.sourceList()).length, 1)
    const completed = await web.completeAdd(second.requestId, ['beta'])
    assert.equal(completed.kind, 'installed')
    assert.deepEqual((await manager.list()).map(item => item.id), ['beta'])
    await web.uninstall('beta')
    assert.deepEqual(await manager.sourceList(), [])
  } finally {
    await temp.cleanup()
  }
})

test('Web 单插件来源在第一次拉取后直接安装', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'single')
    await buildClaudePlugin(source, { name: 'single', hookEvent: 'PreToolUse' })
    await mkdir(resolve(source, 'bin'), { recursive: true })
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')))
    const web = operations(manager)

    const result = await web.beginAdd(source)
    assert.equal(result.kind, 'installed')
    if (result.kind === 'installed') {
      assert.equal(result.plugins.length, 1)
      assert.equal(result.plugins[0]?.id, 'single')
      assert.equal(result.plugins[0]?.hooks, 1)
      assert.deepEqual(result.plugins[0]?.diagnostics.map(item => ({
        level: item.level,
        code: item.code,
        capability: item.capability,
        file: item.file,
      })), [{
        level: 'warning',
        code: 'CLAUDE_BIN_PATH_UNSUPPORTED',
        capability: 'plugin',
        file: 'bin',
      }])
    }
    const listed = await web.list()
    assert.equal(listed.kind, 'ready')
    if (listed.kind === 'ready') {
      assert.equal(listed.plugins[0]?.diagnostics[0]?.message,
        '插件包含 Claude Code bin/ 可执行目录；当前不会修改 DSH Shell 的 PATH')
    }
  } finally {
    await temp.cleanup()
  }
})


test('Web 检查更新会标记共享 Source 的全部插件，并可在线更新', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildMarketplace(source)
    const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')))
    const web = operations(manager)
    const first = await web.beginAdd(source)
    assert.equal(first.kind, 'selection')
    if (first.kind !== 'selection') return
    await web.completeAdd(first.requestId, ['alpha'])
    const second = await web.beginAdd(source)
    assert.equal(second.kind, 'selection')
    if (second.kind !== 'selection') return
    await web.completeAdd(second.requestId, ['beta'])

    const before = await web.checkUpdates()
    assert.equal(before.kind, 'ready')
    if (before.kind === 'ready') {
      assert.deepEqual(before.updates.map(item => item.available), [false, false])
      assert.deepEqual(before.updates.map(item => item.sharedSource), [true, true])
    }

    await writeFile(resolve(source, 'plugins/alpha', 'marker.txt'), 'updated')
    const changed = await web.checkUpdates()
    assert.equal(changed.kind, 'ready')
    if (changed.kind === 'ready') {
      assert.deepEqual(changed.updates.map(item => item.available), [true, true])
    }

    const updated = await web.update('alpha', true)
    assert.equal(updated.kind, 'updated')
    if (updated.kind === 'updated') {
      assert.deepEqual(updated.affectedPluginIds, ['alpha', 'beta'])
      assert.deepEqual(updated.plugins.map(item => item.id), ['alpha', 'beta'])
    }
  } finally {
    await temp.cleanup()
  }
})
