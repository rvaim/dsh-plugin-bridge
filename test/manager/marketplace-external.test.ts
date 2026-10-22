import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { CompatManager } from '../../src/manager/manager.js'
import { runProcess } from '../../src/source/process.js'
import { CompatLayout } from '../../src/store/layout.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, path: string, value: string | Record<string, unknown>): Promise<void> {
  const destination = resolve(root, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function commit(root: string, message: string): Promise<string> {
  await runProcess('git', ['-C', root, 'add', '.'])
  await runProcess('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-m', message])
  return (await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}

async function repository(root: string): Promise<string> {
  await runProcess('git', ['init', root])
  await runProcess('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await runProcess('git', ['-C', root, 'config', 'user.name', 'Plugin Bridge Test'])
  await runProcess('git', ['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/release'])
  return await commit(root, 'initial')
}

test('混合 Claude 市场只获取所选外部 Git，未选不可达仓库不阻断准备或安装', async () => {
  const temp = await temporaryDirectory()
  try {
    const market = resolve(temp.path, 'market')
    const rootRepository = resolve(temp.path, 'external-root-repository')
    const subdirRepository = resolve(temp.path, 'external-subdir-repository')
    await buildClaudePlugin(resolve(market, 'plugins/local'), { name: 'local', marker: 'local-content' })
    await buildClaudePlugin(rootRepository, { name: 'external-root', marker: 'root-content' })
    await put(rootRepository, 'docs/market-only.md', '---\nname: catalog-command\ndescription: Catalog command\n---\nCatalog supplied command\n')
    const rootCommit = await repository(rootRepository)
    await buildClaudePlugin(resolve(subdirRepository, 'packages/selected'), { name: 'external-subdir', marker: 'subdir-content' })
    await put(subdirRepository, 'repository-marker.txt', 'complete repository')
    const subdirCommit = await repository(subdirRepository)
    await put(market, '.claude-plugin/marketplace.json', {
      name: 'mixed-external-market',
      owner: { name: 'fixture' },
      plugins: [
        { name: 'local', source: './plugins/local', defaultEnabled: false },
        {
          name: 'external-root',
          displayName: 'Catalog root display name',
          source: { source: 'url', url: pathToFileURL(rootRepository).href },
          commands: ['./docs/market-only.md'],
          defaultEnabled: false,
        },
        {
          name: 'external-subdir',
          source: { source: 'git-subdir', url: pathToFileURL(subdirRepository).href, path: 'packages/selected' },
          defaultEnabled: false,
        },
        {
          name: 'unreachable',
          source: { source: 'url', url: pathToFileURL(resolve(temp.path, 'missing-repository')).href },
          defaultEnabled: false,
        },
      ],
    })

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
    const preparation = await manager.prepareInstall(market)
    assert.deepEqual(preparation.plugins.map(plugin => plugin.id), ['external-root', 'external-subdir', 'local', 'unreachable'])
    assert(preparation.plugins.every(plugin => plugin.installable))
    assert.deepEqual(await readdir(layout.external), [])
    assert.deepEqual(await readdir(layout.installed), [])

    const local = await manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'local' }])
    assert.equal(local.kind, 'installed')
    if (local.kind !== 'installed') assert.fail('expected installed completion')
    assert.deepEqual(local.result.plugins.map(item => item.plugin.id), ['local'])
    assert.deepEqual(await readdir(layout.external), [])
    assert.deepEqual(await readdir(layout.installed), ['local'])

    const rootPreparation = await manager.prepareInstall(market)
    const rootResult = await manager.completeInstallPreparation(rootPreparation.preparationId, [{ pluginId: 'external-root' }])
    assert.equal(rootResult.kind, 'installed')
    if (rootResult.kind !== 'installed') assert.fail('expected installed completion')
    assert.deepEqual(rootResult.result.plugins.map(item => item.plugin.id), ['external-root'])
    const root = await manager.inspect('external-root')
    assert.equal(root.install.location.type, 'git')
    assert.equal(root.install.location.type === 'git' ? root.install.location.sha : undefined, rootCommit)
    assert.equal(root.install.materialization?.commit, rootCommit)
    assert.equal(root.packageRoot, await realpath(layout.sourceExternalPackageDir(preparation.sourceId, 'external-root')))
    assert.equal(await readFile(resolve(root.packageRoot, 'marker.txt'), 'utf8'), 'root-content')
    assert.equal(root.scan.plugin.name, 'Catalog root display name')
    assert.deepEqual(root.scan.plugin.commands.map(command => command.name), ['catalog-command'])
    assert.equal(root.scan.plugin.diagnostics.some(item => item.level === 'error'), false)
    assert.deepEqual(await readdir(layout.sourceExternalRoot(preparation.sourceId)), ['external-root'])

    const subdirPreparation = await manager.prepareInstall(market)
    const subdirResult = await manager.completeInstallPreparation(subdirPreparation.preparationId, [{ pluginId: 'external-subdir' }])
    assert.equal(subdirResult.kind, 'installed')
    if (subdirResult.kind !== 'installed') assert.fail('expected installed completion')
    assert.deepEqual(subdirResult.result.plugins.map(item => item.plugin.id), ['external-subdir'])
    const subdir = await manager.inspect('external-subdir')
    assert.equal(subdir.install.location.type, 'git-subdir')
    assert.equal(subdir.install.location.type === 'git-subdir' ? subdir.install.location.path : undefined, 'packages/selected')
    assert.equal(subdir.install.location.type === 'git-subdir' ? subdir.install.location.sha : undefined, subdirCommit)
    assert.equal(subdir.install.materialization?.commit, subdirCommit)
    assert.equal(subdir.packageRoot, await realpath(resolve(layout.sourceExternalPackageDir(preparation.sourceId, 'external-subdir'), 'packages/selected')))
    assert.equal(await readFile(resolve(subdir.packageRoot, 'marker.txt'), 'utf8'), 'subdir-content')
    assert.equal(await readFile(resolve(layout.sourceExternalPackageDir(preparation.sourceId, 'external-subdir'), 'repository-marker.txt'), 'utf8'), 'complete repository')
    assert.deepEqual((await readdir(layout.sourceExternalRoot(preparation.sourceId))).sort(), ['external-root', 'external-subdir'])
    assert.deepEqual((await readdir(layout.installed)).sort(), ['external-root', 'external-subdir', 'local'])
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await temp.cleanup()
  }
})

for (const pin of ['ref', 'sha'] as const) {
  test(`Codex url.path 外部子目录在确认时固定 ${pin}，更新保留来源与市场回退定义`, async () => {
    const temp = await temporaryDirectory()
    try {
      const market = resolve(temp.path, 'market')
      const remote = resolve(temp.path, 'remote')
      const pluginPath = 'packages/catalog-plugin'
      // Deliberately omit plugin.json: only the catalog declares this plugin's skill path.
      await put(remote, `${pluginPath}/marker.txt`, 'v1')
      await put(remote, `${pluginPath}/catalog-skills/example/SKILL.md`, '---\nname: catalog-skill\ndescription: Catalog skill\n---\nSkill body\n')
      await put(remote, 'repository-marker.txt', 'complete repository')
      const firstCommit = await repository(remote)
      const entry = {
        name: 'catalog-plugin',
        version: '1.0.0',
        skills: ['./catalog-skills'],
        defaultEnabled: false,
        source: {
          source: 'url',
          url: pathToFileURL(remote).href,
          path: `./${pluginPath}`,
          ref: 'release',
          ...(pin === 'sha' ? { sha: firstCommit } : {}),
        },
      }
      await put(market, '.agents/plugins/marketplace.json', { name: 'codex-external-market', plugins: [entry] })
      const layout = new CompatLayout(resolve(temp.path, 'home'))
      const manager = new CompatManager(layout, undefined, createBuiltinParserEngine())
      const preparation = await manager.prepareInstall(market)
      assert.equal(preparation.plugins.length, 1)
      assert.equal(preparation.plugins[0].installable, true)
      assert.deepEqual(preparation.plugins[0].location, {
        type: 'git-subdir', url: pathToFileURL(remote).href, path: pluginPath,
        ref: 'release', ...(pin === 'sha' ? { sha: firstCommit } : {}),
      })
      assert.deepEqual(await readdir(layout.external), [])

      // A moving external ref is resolved at confirmation, not during catalog preparation.
      await put(remote, `${pluginPath}/marker.txt`, 'v2')
      const secondCommit = await commit(remote, 'second')
      const result = await manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'catalog-plugin' }])
      assert.equal(result.kind, 'installed')
      if (result.kind !== 'installed') assert.fail('expected installed completion')
      const expectedCommit = pin === 'sha' ? firstCommit : secondCommit
      assert.equal(result.result.plugins[0].install.materialization?.commit, expectedCommit)
      const installed = await manager.inspect('catalog-plugin')
      assert.deepEqual(installed.install.location, {
        type: 'git-subdir', url: pathToFileURL(remote).href, path: pluginPath, ref: 'release', sha: expectedCommit,
      })
      assert.equal(installed.packageRoot, await realpath(resolve(layout.sourceExternalPackageDir(preparation.sourceId, 'catalog-plugin'), pluginPath)))
      assert.equal(await readFile(resolve(installed.packageRoot, 'marker.txt'), 'utf8'), pin === 'sha' ? 'v1' : 'v2')
      assert.deepEqual(installed.scan.plugin.formats, ['codex'])
      assert.deepEqual(installed.scan.plugin.skills.map(skill => skill.name), ['catalog-skill'])
      assert(installed.scan.plugin.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_MANIFEST_FALLBACK'))
      assert.equal(installed.scan.plugin.diagnostics.some(item => item.level === 'error'), false)
      await assert.rejects(readFile(resolve(layout.sourcePackageDir(preparation.sourceId), pluginPath, 'marker.txt')), { code: 'ENOENT' })

      await put(remote, `${pluginPath}/marker.txt`, 'v3')
      const thirdCommit = await commit(remote, 'third')
      assert.equal((await manager.inspect('catalog-plugin')).install.materialization?.commit, expectedCommit)
      await manager.sourceUpdate(preparation.sourceId)
      const updated = await manager.inspect('catalog-plugin')
      const updatedCommit = pin === 'sha' ? firstCommit : thirdCommit
      assert.deepEqual(updated.install.location, {
        type: 'git-subdir', url: pathToFileURL(remote).href, path: pluginPath, ref: 'release', sha: updatedCommit,
      })
      assert.equal(updated.install.materialization?.commit, updatedCommit)
      assert.equal(updated.packageRoot, installed.packageRoot)
      assert.equal(await readFile(resolve(updated.packageRoot, 'marker.txt'), 'utf8'), pin === 'sha' ? 'v1' : 'v3')
      assert.deepEqual(updated.scan.plugin.skills.map(skill => skill.name), ['catalog-skill'])
      assert(updated.scan.plugin.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_MANIFEST_FALLBACK'))
      assert.equal(updated.scan.plugin.diagnostics.some(item => item.level === 'error'), false)
      assert.equal(await readFile(resolve(layout.sourceExternalPackageDir(preparation.sourceId, 'catalog-plugin'), 'repository-marker.txt'), 'utf8'), 'complete repository')
      assert.deepEqual(await readdir(layout.temp), [])
    } finally {
      await temp.cleanup()
    }
  })
}
