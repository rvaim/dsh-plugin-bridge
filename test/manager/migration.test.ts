import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { writeJsonAtomic } from '../../src/store/json.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function createLegacyRecord(
  layout: CompatLayout,
  pluginId: string,
  packageBuilder: (packageRoot: string) => Promise<void>,
): Promise<string> {
  const root = resolve(layout.legacyPlugins, pluginId)
  await Promise.all([
    mkdir(resolve(root, 'package'), { recursive: true }),
    mkdir(resolve(root, 'data'), { recursive: true }),
    mkdir(resolve(root, 'cache'), { recursive: true }),
  ])
  await packageBuilder(resolve(root, 'package'))
  await writeJsonAtomic(resolve(root, 'install.json'), {
    schemaVersion: 1,
    id: pluginId,
    source: { type: 'directory', path: `/旧来源/${pluginId}` },
    installedAt: '2026-01-02T03:04:05.000Z',
  })
  await writeJsonAtomic(resolve(root, 'state.json'), {
    schemaVersion: 1,
    enabled: false,
    priority: 7,
  })
  return root
}

test('0.1.x 单插件布局自动迁移为 implicit Source 与 installed 记录并保留 data/state', async () => {
  const temp = await temporaryDirectory()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const legacyRoot = await createLegacyRecord(layout, 'legacy-plugin', async packageRoot => {
      await buildClaudePlugin(packageRoot, {
        name: 'legacy-plugin',
        version: '1.2.3',
        marker: 'legacy-source',
      })
    })
    await writeFile(resolve(legacyRoot, 'data/persistent.txt'), '必须保留')
    await writeFile(resolve(legacyRoot, 'cache/discardable.txt'), '可以重建')
    // 旧 scan 损坏不影响迁移，因为 package 才是事实真源。
    await writeFile(resolve(legacyRoot, 'scan.json'), '{ damaged scan')

    const manager = new CompatManager(layout)
    const listed = await manager.list()
    assert.deepEqual(listed.map(item => item.id), ['legacy-plugin'])
    assert.equal(listed[0]?.sourceId, 'legacy-legacy-plugin')
    assert.equal(listed[0]?.priority, 7)

    assert.equal(await pathExists(legacyRoot), false)
    assert.equal(await pathExists(resolve(layout.pluginRoot('legacy-plugin'), 'package')), false)
    assert.equal(
      await readFile(resolve(layout.sourcePackageDir('legacy-legacy-plugin'), 'marker.txt'), 'utf8'),
      'legacy-source',
    )
    assert.equal(await readFile(resolve(layout.dataDir('legacy-plugin'), 'persistent.txt'), 'utf8'), '必须保留')
    assert.deepEqual(await readdir(layout.cacheDir('legacy-plugin')), [])

    const source = await manager.sourceInspect('legacy-legacy-plugin')
    assert.equal(source.source.ownership, 'implicit')
    assert.deepEqual(source.installedPlugins, [{
      pluginId: 'legacy-plugin',
      sourcePluginId: 'legacy-plugin',
    }])
    const plugin = await manager.inspect('legacy-plugin')
    assert.equal(plugin.install.installedAt, '2026-01-02T03:04:05.000Z')
    assert.equal(plugin.scan.plugin.version, '1.2.3')
    assert.equal(plugin.state.enabled, false)

    await manager.uninstall('legacy-plugin')
    assert.equal(await pathExists(layout.sourceRoot('legacy-legacy-plugin')), false)
  } finally {
    await temp.cleanup()
  }
})

test('旧 package 含多个 Marketplace Plugin 且无法唯一匹配时停止迁移并完整保留旧目录', async () => {
  const temp = await temporaryDirectory()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const legacyRoot = await createLegacyRecord(layout, 'ambiguous-container', async packageRoot => {
      await buildClaudePlugin(resolve(packageRoot, 'plugins/a'), { name: 'a' })
      await buildClaudePlugin(resolve(packageRoot, 'plugins/b'), { name: 'b' })
      await mkdir(resolve(packageRoot, '.claude-plugin'), { recursive: true })
      await writeFile(resolve(packageRoot, '.claude-plugin/marketplace.json'), JSON.stringify({
        name: 'ambiguous-market',
        owner: { name: '测试' },
        plugins: [
          { name: 'a', source: './plugins/a' },
          { name: 'b', source: './plugins/b' },
        ],
      }))
    })
    await writeFile(resolve(legacyRoot, 'data/keep.txt'), '不要删除')

    const manager = new CompatManager(layout)
    await assert.rejects(manager.list(), /无法无歧义确定原安装对象/)

    assert.equal(await pathExists(legacyRoot), true)
    assert.equal(await readFile(resolve(legacyRoot, 'data/keep.txt'), 'utf8'), '不要删除')
    await layout.ensure()
    assert.deepEqual(await readdir(layout.sources), [])
    assert.deepEqual(await readdir(layout.installed), [])
  } finally {
    await temp.cleanup()
  }
})
