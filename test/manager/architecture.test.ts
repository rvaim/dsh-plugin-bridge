import assert from 'node:assert/strict'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRepository } from '../../src/manager/repository.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { readInstalledSource } from '../../src/store/metadata.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function marketplace(root: string) {
  for (const name of ['alpha', 'beta']) await buildClaudePlugin(join(root, 'plugins', name), { name })
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'prepared-market', owner: { name: 'fixture' },
    plugins: ['alpha', 'beta'].map(name => ({ name, source: `./plugins/${name}` })),
  }))
}

for (const promotion of ['explicit', 'referenced'] as const) {
  test(`preparation release preserves a Source that became ${promotion}`, async () => {
    const temp = await temporaryDirectory()
    try {
      const source = join(temp.path, 'market')
      await marketplace(source)
      const layout = new CompatLayout(join(temp.path, 'home'))
      const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
      const prepared = await manager.prepareInstall(source)
      if (promotion === 'explicit') await manager.sourceAdd(source)
      else await manager.install(prepared.sourceId, { plugins: ['alpha'] })
      await manager.releaseInstallPreparation(prepared.preparationId)
      await manager.releaseInstallPreparation(prepared.preparationId)
      assert.equal((await manager.sourceList()).length, 1)
      if (promotion === 'explicit') assert.equal((await manager.sourceInspect(prepared.sourceId)).source.ownership, 'explicit')
      else assert.deepEqual((await manager.list()).map(item => item.id), ['alpha'])
      await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, ['beta']), /已结束/)
    } finally { await temp.cleanup() }
  })
}

test('the last preparation across callers owns cleanup, never the first request alone', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = join(temp.path, 'market')
    await marketplace(source)
    const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine())
    const first = await manager.prepareInstall(source)
    const second = await manager.prepareInstall(source)
    assert.notEqual(first.preparationId, second.preparationId)
    await manager.releaseInstallPreparation(first.preparationId)
    assert.equal((await manager.sourceList()).length, 1)
    await manager.releaseInstallPreparation(second.preparationId)
    assert.deepEqual(await manager.sourceList(), [])
  } finally { await temp.cleanup() }
})

test('a preparation cannot complete or reclaim a replacement directory with identical metadata', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = join(temp.path, 'market')
    await marketplace(source)
    const layout = new CompatLayout(join(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    const prepared = await manager.prepareInstall(source)
    const oldRoot = join(temp.path, 'old-source')
    await rename(layout.sourceRoot(prepared.sourceId), oldRoot)
    const { cp } = await import('node:fs/promises')
    await cp(oldRoot, layout.sourceRoot(prepared.sourceId), { recursive: true })
    await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, ['alpha']), /已变化/)
    await manager.releaseInstallPreparation(prepared.preparationId)
    assert.equal((await manager.sourceList()).length, 1)
    assert.deepEqual(await manager.list(), [])
  } finally { await temp.cleanup() }
})

test('a changed prepared revision is rejected and its newer Source is preserved', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = join(temp.path, 'market')
    await marketplace(source)
    const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine())
    const prepared = await manager.prepareInstall(source)
    await writeFile(join(source, 'revision.txt'), 'changed')
    await manager.sourceUpdate(prepared.sourceId)
    await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, ['alpha']), /已变化/)
    await manager.releaseInstallPreparation(prepared.preparationId)
    assert.equal((await manager.sourceList()).length, 1)
  } finally { await temp.cleanup() }
})

test('failed completion can retry; completion and release share the repository transaction', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = join(temp.path, 'market')
    await marketplace(source)
    const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine())
    const prepared = await manager.prepareInstall(source)
    await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, ['missing']), /不包含/)
    const completed = await manager.completeInstallPreparation(prepared.preparationId, ['alpha'])
    assert.equal(completed.plugins[0].plugin.id, 'alpha')
    await manager.releaseInstallPreparation(prepared.preparationId)
    await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, ['alpha']), /已结束/)
    assert.equal((await manager.list()).length, 1)
  } finally { await temp.cleanup() }
})

for (const releaseFirst of [false, true]) {
  test(`prepared completion/release race is atomic (release launched first: ${releaseFirst})`, async () => {
    const temp = await temporaryDirectory()
    try {
      const source = join(temp.path, 'market')
      await marketplace(source)
      const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine())
      const prepared = await manager.prepareInstall(source)
      const complete = () => manager.completeInstallPreparation(prepared.preparationId, ['alpha'])
      const release = () => manager.releaseInstallPreparation(prepared.preparationId)
      const results = await Promise.allSettled(releaseFirst ? [release(), complete()] : [complete(), release()])
      assert.equal(results[releaseFirst ? 0 : 1].status, 'fulfilled')
      const plugins = await manager.list()
      const sources = await manager.sourceList()
      assert.equal(plugins.length, results[releaseFirst ? 1 : 0].status === 'fulfilled' ? 1 : 0)
      assert.equal(sources.length, plugins.length)
      await manager.releaseInstallPreparation(prepared.preparationId)
      assert.equal((await manager.list()).length, plugins.length)
    } finally { await temp.cleanup() }
  })
}

test('a blocked remote probe leaves list and disable free to finish', { timeout: 5000 }, async () => {
  const temp = await temporaryDirectory()
  const gate = deferred<string>()
  const started = deferred<void>()
  let checking: Promise<unknown> | undefined
  try {
    const source = join(temp.path, 'source')
    await buildClaudePlugin(source, { name: 'unblocked' })
    const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine(), {
      async probeRevision() { started.resolve(); return await gate.promise },
    })
    await manager.install(source)
    checking = manager.checkUpdates()
    await started.promise
    assert.equal((await manager.list())[0].id, 'unblocked')
    assert.equal((await manager.disable('unblocked')).state.enabled, false)
    gate.resolve('directory:new-revision')
    const result = await checking as Awaited<ReturnType<CompatManager['checkUpdates']>>
    assert.equal(result[0].updateAvailable, true)
  } finally { gate.resolve('directory:release'); await checking; await temp.cleanup() }
})

test('update results reject revisions or references changed while probing', { timeout: 5000 }, async () => {
  const temp = await temporaryDirectory()
  const gate = deferred<string>()
  const started = deferred<void>()
  let checking: Promise<unknown> | undefined
  try {
    const source = join(temp.path, 'source')
    await buildClaudePlugin(source, { name: 'changing' })
    const layout = new CompatLayout(join(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine(), {
      async probeRevision() { started.resolve(); return await gate.promise },
    })
    const initial = await manager.install(source)
    checking = manager.checkUpdates()
    await started.promise
    await writeFile(join(source, 'revision.txt'), 'new contents')
    await manager.update('changing')
    gate.resolve('directory:old-remote-result')
    const [result] = await checking as Awaited<ReturnType<CompatManager['checkUpdates']>>
    assert.equal(result.currentRevision, initial.source.source.revision)
    assert.equal(result.updateAvailable, false)
    assert.equal(result.latestRevision, undefined)
    assert.match(result.error ?? '', /已变化/)
    assert.notEqual((await readInstalledSource(layout, result.sourceId)).source.revision, result.currentRevision)
  } finally { gate.resolve('directory:release'); await checking; await temp.cleanup() }
})

test('a changed reference set invalidates a probe even when its Source revision stayed the same', { timeout: 5000 }, async () => {
  const temp = await temporaryDirectory()
  const gate = deferred<string>()
  const started = deferred<void>()
  let checking: Promise<unknown> | undefined
  try {
    const source = join(temp.path, 'market')
    await marketplace(source)
    const manager = new CompatManager(new CompatLayout(join(temp.path, 'home')), undefined, createBuiltinParserEngine(), {
      async probeRevision() { started.resolve(); return await gate.promise },
    })
    await manager.install(source, { plugins: ['alpha'] })
    checking = manager.checkUpdates()
    await started.promise
    await manager.install(source, { plugins: ['beta'] })
    gate.resolve('directory:new')
    const [result] = await checking as Awaited<ReturnType<CompatManager['checkUpdates']>>
    assert.equal(result.updateAvailable, false)
    assert.equal(result.latestRevision, undefined)
    assert.deepEqual(result.affectedPluginIds, ['alpha', 'beta'])
    assert.match(result.error ?? '', /已变化/)
  } finally { gate.resolve('directory:release'); await checking; await temp.cleanup() }
})

test('repository refresh does not touch runtime, while manager reports synchronization failures separately', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = join(temp.path, 'source')
    await buildClaudePlugin(source, { name: 'sync-failure', skillName: 'sync-skill' })
    const layout = new CompatLayout(join(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const parsers = createBuiltinParserEngine()
    const manager = new CompatManager(layout, runtime, parsers)
    await manager.install(source)
    const stop = runtime.stop.bind(runtime)
    const isCurrent = runtime.isCurrent.bind(runtime)
    runtime.isCurrent = () => false
    runtime.start = async () => { throw new Error('Controlled runtime replacement failure') }
    const repository = new CompatRepository(layout, parsers)
    assert.equal((await repository.readCurrentRecord('sync-failure')).install.pluginId, 'sync-failure')
    const [item] = await manager.list()
    assert.equal(item.name, 'sync-failure')
    assert.equal(item.skills, 1)
    assert.equal(item.enabled, true)
    assert(item.diagnostics.some(diagnostic => diagnostic.code === 'PLUGIN_RUNTIME_SYNC_FAILED'))
    assert.equal(item.diagnostics.some(diagnostic => diagnostic.code === 'INSTALLED_PLUGIN_READ_FAILED'), false)
    await assert.rejects(manager.inspect('sync-failure'), /运行状态同步失败/)
    runtime.isCurrent = isCurrent
    await stop('sync-failure')
  } finally { await ctx.dispose(); await temp.cleanup() }
})
