import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { createStoredZip, createTar } from '../helpers/archive-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

type ArchiveSuffix = '.zip' | '.tar' | '.tgz' | '.tar.gz'

async function fixture(t: TestContext) {
  const temp = await temporaryDirectory('managed-upload-test-')
  t.after(() => temp.cleanup())
  const layout = new CompatLayout(join(temp.path, 'home'))
  await layout.ensure()
  const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
  return { temp, layout, manager }
}

async function archive(path: string, name: string, suffix: ArchiveSuffix = '.zip', version = '1.0.0'): Promise<Buffer> {
  const entries = [
    { name: 'wrapper/.claude-plugin/plugin.json', data: JSON.stringify({ name, version }) },
    { name: 'wrapper/marker.txt', data: `${name}-${version}` },
  ]
  if (suffix === '.zip') await createStoredZip(path, entries)
  else if (suffix === '.tar') await createTar(path, entries)
  else {
    const tar = `${path}.fixture.tar`
    await createTar(tar, entries)
    await writeFile(path, gzipSync(await readFile(tar)))
  }
  return await readFile(path)
}

async function noTransactions(layout: CompatLayout): Promise<void> {
  assert.deepEqual(await readdir(layout.temp), [])
}

for (const suffix of ['.zip', '.tar', '.tgz', '.tar.gz'] as const) {
  test(`上传 ${suffix} 原件归 Source 保管，删除输入后仍可完成、检查和反复更新`, async (t) => {
    const { temp, layout, manager } = await fixture(t)
    const input = join(temp.path, `archive${suffix}`)
    const bytes = await archive(input, 'retained-plugin', suffix)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const prepared = await manager.prepareArchiveInstall(input)
    assert.equal(prepared.sourceCreated, true)
    assert.deepEqual(prepared.plugins.map(plugin => plugin.id), ['retained-plugin'])
    const source = (await manager.sourceInspect(prepared.sourceId)).source
    assert.equal(source.origin.type, 'archive')
    if (source.origin.type !== 'archive') assert.fail('archive origin required')
    const retained = join(layout.sourceRoot(prepared.sourceId), `uploaded-origin${suffix}`)
    assert.equal(source.origin.path, retained)
    assert.equal(source.origin.sha256, digest)
    assert.equal(source.revision, `archive:${digest}`)
    assert.deepEqual(await readFile(retained), bytes)
    await rm(input)

    const installed = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'retained-plugin' }])
    assert.equal(installed.kind, 'installed')
    if (installed.kind !== 'installed') assert.fail('expected installed completion')
    assert.equal(installed.result.plugins[0].install.sourceId, prepared.sourceId)
    assert.equal(await readFile(join((await manager.inspect('retained-plugin')).packageRoot, 'marker.txt'), 'utf8'), 'retained-plugin-1.0.0')
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const checks = await manager.checkUpdates()
      assert.equal(checks.length, 1)
      assert.equal(checks[0].error, undefined)
      assert.equal(checks[0].updateAvailable, false)
      assert.equal(checks[0].latestRevision, source.revision)
      const updated = await manager.sourceUpdate(prepared.sourceId)
      assert.equal(updated.source.source.revision, source.revision)
      assert.deepEqual(await readFile(retained), bytes)
      await noTransactions(layout)
    }
    // Explicit ownership makes sourceRemove, rather than last-plugin uninstall, own cleanup.
    await manager.sourceAdd(retained)
    await assert.rejects(manager.sourceRemove(prepared.sourceId), /仍被/)
    await manager.uninstall('retained-plugin')
    assert.deepEqual(await readFile(retained), bytes)
    await manager.sourceRemove(prepared.sourceId)
    await assert.rejects(stat(layout.sourceRoot(prepared.sourceId)), { code: 'ENOENT' })
    await assert.rejects(stat(input), { code: 'ENOENT' })
    await noTransactions(layout)
  })
}

test('同内容从不同上传路径准备时复用同一个 Source，最后一次 release 才回收', async (t) => {
  const { temp, layout, manager } = await fixture(t)
  const firstPath = join(temp.path, 'first.zip')
  const bytes = await archive(firstPath, 'same-content')
  const secondPath = join(temp.path, 'other-name.zip')
  await writeFile(secondPath, bytes)
  const first = await manager.prepareArchiveInstall(firstPath)
  const second = await manager.prepareArchiveInstall(secondPath)
  assert.equal(second.sourceCreated, false)
  assert.equal(second.sourceId, first.sourceId)
  assert.notEqual(second.preparationId, first.preparationId)
  assert.equal((await manager.sourceList()).length, 1)
  await rm(firstPath)
  await rm(secondPath)
  await manager.releaseInstallPreparation(first.preparationId)
  assert.deepEqual(await readFile(join(layout.sourceRoot(first.sourceId), 'uploaded-origin.zip')), bytes)
  await manager.releaseInstallPreparation(second.preparationId)
  await manager.releaseInstallPreparation(second.preparationId)
  assert.deepEqual(await readdir(layout.sources), [])
  assert.deepEqual(await readdir(layout.installed), [])
  await noTransactions(layout)
})

test('两个同名 archive.zip 输入中不同的单插件内容可连续安装且同 hash 仍复用', async (t) => {
  const { temp, layout, manager } = await fixture(t)
  const firstInput = join(temp.path, 'first', 'archive.zip')
  const secondInput = join(temp.path, 'second', 'archive.zip')
  await mkdir(resolve(firstInput, '..'), { recursive: true })
  await mkdir(resolve(secondInput, '..'), { recursive: true })
  const firstBytes = await archive(firstInput, 'alpha')
  await archive(secondInput, 'beta')
  const first = await manager.prepareArchiveInstall(firstInput)
  await manager.completeInstallPreparation(first.preparationId, [{ pluginId: 'alpha' }])
  const second = await manager.prepareArchiveInstall(secondInput)
  assert.notEqual(second.sourceId, first.sourceId)
  await manager.completeInstallPreparation(second.preparationId, [{ pluginId: 'beta' }])
  assert.deepEqual((await manager.list()).map(plugin => plugin.id).sort(), ['alpha', 'beta'])
  const repeatedInput = join(temp.path, 'repeated.zip')
  await writeFile(repeatedInput, firstBytes)
  const repeated = await manager.prepareArchiveInstall(repeatedInput)
  assert.equal(repeated.sourceId, first.sourceId)
  assert.equal(repeated.sourceCreated, false)
  await manager.releaseInstallPreparation(repeated.preparationId)
  assert.equal((await manager.sourceList()).length, 2)
  await manager.uninstall('alpha')
  await manager.uninstall('beta')
  assert.deepEqual(await readdir(layout.sources), [])
  await noTransactions(layout)
})

test('普通归档已有准备会话可在同 hash 上传接管且原文件删除后继续完成', async (t) => {
  const { temp, layout, manager } = await fixture(t)
  const external = join(temp.path, 'external.zip')
  const uploaded = join(temp.path, 'archive.zip')
  const bytes = await archive(external, 'adopted-plugin')
  const previous = await manager.prepareInstall(external)
  const before = (await manager.sourceInspect(previous.sourceId)).source
  await copyFile(external, uploaded)
  await rm(external)
  const current = await manager.prepareArchiveInstall(uploaded)
  assert.equal(current.sourceId, previous.sourceId)
  assert.equal(current.sourceCreated, false)
  const after = (await manager.sourceInspect(previous.sourceId)).source
  assert.equal(after.createdAt, before.createdAt)
  assert.equal(after.revision, before.revision)
  assert.equal(after.ownership, 'implicit')
  assert.equal(after.origin.type, 'archive')
  if (after.origin.type !== 'archive') assert.fail('archive origin required')
  assert.equal(after.origin.path, join(layout.sourceRoot(previous.sourceId), 'uploaded-origin.zip'))
  assert.deepEqual(await readFile(after.origin.path), bytes)
  await rm(uploaded)
  await manager.completeInstallPreparation(previous.preparationId, [{ pluginId: 'adopted-plugin' }])
  await manager.releaseInstallPreparation(current.preparationId)
  assert.equal((await manager.checkUpdates())[0].error, undefined)
  await manager.uninstall('adopted-plugin')
  assert.deepEqual(await readdir(layout.sources), [])
  await noTransactions(layout)
})

for (const ownership of ['implicit', 'explicit'] as const) {
  test(`同 hash 接管后取消全部准备会话正确保留或回收 ${ownership} 来源`, async (t) => {
    const { temp, layout, manager } = await fixture(t)
    const external = join(temp.path, 'external.zip')
    const uploaded = join(temp.path, 'archive.zip')
    await archive(external, 'cancel-adoption')
    if (ownership === 'explicit') await manager.sourceAdd(external)
    const previous = await manager.prepareInstall(external)
    await copyFile(external, uploaded)
    await rm(external)
    const current = await manager.prepareArchiveInstall(uploaded)
    assert.equal(current.sourceId, previous.sourceId)
    await rm(uploaded)
    await manager.releaseInstallPreparation(previous.preparationId)
    await stat(join(layout.sourceRoot(previous.sourceId), 'uploaded-origin.zip'))
    await manager.releaseInstallPreparation(current.preparationId)
    if (ownership === 'implicit') assert.deepEqual(await readdir(layout.sources), [])
    else {
      assert.equal((await manager.sourceInspect(previous.sourceId)).source.ownership, 'explicit')
      await stat(join(layout.sourceRoot(previous.sourceId), 'uploaded-origin.zip'))
      await manager.sourceRemove(previous.sourceId)
      assert.deepEqual(await readdir(layout.sources), [])
    }
    await noTransactions(layout)
  })
}

test('损坏归档准备失败不留下 Source、插件或事务，之后仍可正常准备并取消', async (t) => {
  const { temp, layout, manager } = await fixture(t)
  const input = join(temp.path, 'broken.zip')
  await writeFile(input, 'not a zip archive')
  await assert.rejects(manager.prepareArchiveInstall(input))
  assert.deepEqual(await readdir(layout.sources), [])
  assert.deepEqual(await readdir(layout.installed), [])
  await noTransactions(layout)
  await archive(input, 'recovered-upload')
  const preparation = await manager.prepareArchiveInstall(input)
  await rm(input)
  await manager.releaseInstallPreparation(preparation.preparationId)
  assert.deepEqual(await readdir(layout.sources), [])
  await noTransactions(layout)
})

test('普通外部归档保留路径更新语义，不自动复制或删除外部原件', async (t) => {
  const { temp, layout, manager } = await fixture(t)
  const input = join(temp.path, 'ordinary.zip')
  const bytes = await archive(input, 'ordinary-plugin')
  const added = await manager.sourceAdd(input)
  assert.equal(added.source.origin.type, 'archive')
  if (added.source.origin.type !== 'archive') assert.fail('archive origin required')
  assert.equal(added.source.origin.path, input)
  assert.equal((await readdir(layout.sourceRoot(added.source.id))).some(name => name.startsWith('uploaded-origin')), false)
  await manager.install(added.source.id, { enable: false })
  await archive(input, 'ordinary-plugin', '.zip', '2.0.0')
  assert.equal((await manager.checkUpdates())[0].updateAvailable, true)
  await manager.sourceUpdate(added.source.id)
  assert.equal((await manager.inspect('ordinary-plugin')).scan.plugin.version, '2.0.0')
  await manager.uninstall('ordinary-plugin')
  await manager.sourceRemove(added.source.id)
  assert.notDeepEqual(await readFile(input), bytes)
  await noTransactions(layout)
})
