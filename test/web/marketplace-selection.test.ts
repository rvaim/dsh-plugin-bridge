import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { CompatManager } from '../../src/manager/manager.js'
import { ParserEngine } from '../../src/parser/engine.js'
import type { PluginParser } from '../../src/parser/contracts.js'
import { CompatLayout } from '../../src/store/layout.js'
import { CompatWebOperations } from '../../src/web/host/gateway.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

function operations(manager: CompatManager): CompatWebOperations {
  return new CompatWebOperations({
    prepareInstall: (source, options) => manager.prepareInstall(source, options),
    prepareArchiveInstall: (source, signal) => manager.prepareArchiveInstall(source, signal),
    completeInstallPreparation: (id, plugins, signal) => manager.completeInstallPreparation(id, plugins, signal),
    releaseInstallPreparation: id => manager.releaseInstallPreparation(id),
    list: () => manager.list(), listCategories: () => manager.listCategories(),
    checkUpdates: () => manager.checkUpdates(), update: (id, options) => manager.update(id, options),
    enable: id => manager.enable(id), disable: id => manager.disable(id), uninstall: id => manager.uninstall(id),
  })
}

async function json(root: string, path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(root, path)), { recursive: true })
  await writeFile(resolve(root, path), JSON.stringify(value))
}

test('未知第三方解析器可声明嵌套市场并驱动同一选择流程', async () => {
  const temp = await temporaryDirectory()
  const parser: PluginParser = {
    id: 'future-format', version: '1.0.0',
    category: { label: { default: 'Future' }, order: 50 },
    signature: { id: 'future-format', manifestPaths: [], marketplacePaths: ['market.json'], marketplaceSearchDepth: 2 },
    async detect() { return { matched: true } },
    async discoverSource(_root, file = 'market.json') {
      const path = `${dirname(file)}/package`
      return { marketplaceFile: file, marketplaceName: 'future-market', diagnostics: [], candidates: [{
        id: 'future-tool', name: 'future-tool', formats: ['future-format'],
        location: { type: 'source-path', path }, locationKey: `source-path:${path}`,
        installable: true, diagnostics: [], definitions: [],
      }] }
    },
    async parsePlugin() {
      return { format: 'future-format', name: 'future-tool', manifestFiles: [], skills: [], mcpServers: [], hooks: [], commands: [], agents: [], diagnostics: [] }
    },
  }
  const engine = new ParserEngine([parser])
  const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')), undefined, engine)
  const web = operations(manager)
  try {
    const source = resolve(temp.path, 'repository')
    await json(source, 'nested/market.json', {})
    await mkdir(resolve(source, 'nested/package'))
    const result = await web.beginAdd(source)
    assert.equal(result.kind, 'selection')
    if (result.kind !== 'selection') return
    assert.equal(result.selectionRequired, true)
    assert.deepEqual(result.candidates.map(candidate => candidate.formats), [['future-format']])
    assert.equal(result.candidates[0].source, './nested/package')
    assert.deepEqual(await manager.list(), [])
    assert.equal((await web.completeAdd(result.requestId, ['future-tool'])).kind, 'installed')
  } finally {
    await web.dispose()
    engine.dispose()
    await temp.cleanup()
  }
})

for (const format of ['claude-code', 'codex'] as const) {
  for (const nested of [false, true]) {
    test(`${format} ${nested ? '嵌套' : '根'}市场只有一个插件时仍要求用户选择`, async () => {
      const temp = await temporaryDirectory()
      const engine = createBuiltinParserEngine()
      const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')), undefined, engine)
      const web = operations(manager)
      try {
        const source = resolve(temp.path, 'repository')
        const base = nested ? 'plugins/platform' : '.'
        const market = resolve(source, base)
        if (format === 'claude-code') {
          await buildClaudePlugin(resolve(market, 'tools'), { name: 'tools', skillName: 'memory', marker: 'selected' })
          await json(market, '.claude-plugin/marketplace.json', {
            name: 'one-plugin-market', owner: { name: 'fixture' }, plugins: [{ name: 'tools', source: './tools' }],
          })
        } else {
          await json(market, 'tools/.codex-plugin/plugin.json', { name: 'tools', version: '1.0.0', description: 'Tools' })
          await json(market, '.agents/plugins/marketplace.json', {
            name: 'one-plugin-market', plugins: [{ name: 'tools', source: { source: 'local', path: './tools' } }],
          })
        }
        if (nested) {
          // The root's generic skills must not hide an explicit nested marketplace.
          await mkdir(resolve(source, 'skills/invalid_name'), { recursive: true })
          await writeFile(resolve(source, 'skills/invalid_name/SKILL.md'), '---\nname: invalid_name\ndescription: Root collection\n---\nBody\n')
        }
        const begun = await web.beginAdd(source)
        assert.equal(begun.kind, 'selection')
        if (begun.kind !== 'selection') return
        assert.equal(begun.selectionRequired, true)
        assert.deepEqual(begun.candidates.map(candidate => candidate.id), ['tools'])
        assert.equal(begun.candidates[0].source, nested ? './plugins/platform/tools' : './tools')
        assert.deepEqual(await manager.list(), [])
        await assert.rejects(manager.install(source), /必须通过 plugins 显式选择/)
        const completed = await web.completeAdd(begun.requestId, ['tools'])
        assert.equal(completed.kind, 'installed')
        assert.deepEqual((await manager.list()).map(plugin => plugin.id), ['tools'])
        const installed = await manager.inspect('tools')
        assert.deepEqual(installed.install.location, { type: 'source-path', path: nested ? 'plugins/platform/tools' : 'tools' })
      } finally {
        await web.dispose()
        engine.dispose()
        await temp.cleanup()
      }
    })
  }
}

test('通用候选列表公开本仓目录、外部仓库和阻断诊断，选择前不安装', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  const manager = new CompatManager(new CompatLayout(resolve(temp.path, 'home')), undefined, engine)
  const web = operations(manager)
  try {
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'local'), { name: 'local' })
    await json(source, '.claude-plugin/marketplace.json', {
      name: 'location-market', owner: { name: 'fixture' }, plugins: [
        { name: 'local', source: './local' },
        { name: 'external', source: { source: 'github', repo: 'example/external', ref: 'release' } },
        { name: 'subdir', source: { source: 'git-subdir', url: 'https://example.com/shared.git', path: 'plugins/tools', ref: 'main' } },
        { name: 'missing', source: './missing' },
      ],
    })
    const result = await web.beginAdd(source)
    assert.equal(result.kind, 'selection')
    if (result.kind !== 'selection') return
    const candidates = new Map(result.candidates.map(candidate => [candidate.id, candidate]))
    assert.equal(candidates.get('local')?.source, './local')
    assert.equal(candidates.get('external')?.source, 'https://github.com/example/external.git#release')
    assert.equal(candidates.get('subdir')?.source, 'https://example.com/shared.git#main:plugins/tools')
    assert.equal(candidates.get('missing')?.installable, false)
    assert.equal(candidates.get('missing')?.diagnostics[0].code, 'SOURCE_PLUGIN_PATH_MISSING')
    assert.equal(candidates.get('missing')?.diagnostics[0].file, '.claude-plugin/marketplace.json')
    assert.deepEqual(await manager.list(), [])
    assert.equal((await web.cancelAdd(result.requestId)).kind, 'cancelled')
    assert.deepEqual(await manager.sourceList(), [])
  } finally {
    await web.dispose()
    engine.dispose()
    await temp.cleanup()
  }
})
