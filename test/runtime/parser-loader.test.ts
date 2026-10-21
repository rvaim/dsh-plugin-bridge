import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createPluginScan, createSourceScan, loadInstalledPluginForRuntime, resolveInstalledPluginPackageRoot } from '../../src/manager/plugin-loader.js'
import type { CompatParserEngine, ParsePluginOptions } from '../../src/parser/contracts.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../../src/types/catalog.js'
import { SOURCE_PARSER_VERSION } from '../../src/parser/version.js'
import { CompatLayout } from '../../src/store/layout.js'
import { readInstalledPlugin, readInstalledSource, writeInstalledPlugin, writeInstalledSource } from '../../src/store/metadata.js'
import { diagnostic } from '../../src/types/diagnostic.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { temporaryDirectory } from '../helpers/temp.js'

function customEngine(fingerprint: string, options: { missing?: boolean; critical?: boolean; unrelatedMissing?: boolean } = {}) {
  const calls = { plugin: 0, source: 0 }
  const engine: CompatParserEngine = {
    snapshot: { fingerprint, parsers: [{ id: 'custom-parser', version: fingerprint }] },
    categories: [{ id: 'custom-parser', label: { en: 'Custom parser' }, order: 0 }],
    dispose() {},
    async parsePlugin(_root: string, parseOptions: ParsePluginOptions = {}): Promise<CompatPlugin> {
      calls.plugin += 1
      return {
        id: parseOptions.asId ?? 'installed', name: 'Fresh plugin', sourceId: parseOptions.sourceId ?? 'catalog', sourcePluginId: 'original',
        formats: ['claude-code'], skills: [], mcpServers: [], hooks: [], commands: [], agents: [], diagnostics: [], manifestFiles: [],
      }
    },
    async parseSource(root: string): Promise<SourceDiscovery> {
      calls.source += 1
      const unavailable = diagnostic('error', 'PARSER_UNAVAILABLE', 'source', 'The catalog policy parser is unavailable')
      const candidate: SourcePluginCandidate = {
        id: 'original', name: 'Original', formats: ['claude-code'], location: { type: 'source-path', path: '.' },
        locationKey: 'source-path:.', definitions: [], installable: !options.critical,
        diagnostics: options.critical ? [unavailable] : [],
      }
      const candidates = options.missing ? [] : [candidate]
      return { root, candidates, scan: {
        parserVersion: SOURCE_PARSER_VERSION, scannedAt: '2026-01-01T00:00:00.000Z', formats: ['claude-code'],
        plugins: candidates.map(({ definitions: _defs, locationKey: _key, ...item }) => item),
        diagnostics: options.missing || options.unrelatedMissing ? [unavailable] : [], marketplaceFiles: [], discovery: 'marketplace',
      } }
    },
  }
  return { engine, calls }
}

async function fixture() {
  const temp = await temporaryDirectory('plugin-bridge-parser-loader-')
  const layout = new CompatLayout(join(temp.path, 'home'))
  await layout.ensure()
  await mkdir(layout.sourcePackageDir('catalog'), { recursive: true })
  await mkdir(layout.dataDir('installed'), { recursive: true })
  await writeFile(join(layout.dataDir('installed'), 'user.txt'), 'keep')
  const { engine } = customEngine('old-parser-set')
  const plugin = await engine.parsePlugin(layout.sourcePackageDir('catalog'))
  plugin.id = 'installed'
  plugin.name = 'Original installed name'
  plugin.formats = ['codex']
  const catalog = await engine.parseSource(layout.sourcePackageDir('catalog'))
  await writeInstalledSource(layout.sourceRoot('catalog'), {
    id: 'catalog', origin: { type: 'directory', path: layout.sourcePackageDir('catalog') }, ownership: 'explicit', revision: 'revision-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  }, createSourceScan(catalog.scan, 'revision-1', engine))
  await writeInstalledPlugin(layout.pluginRoot('installed'), {
    pluginId: 'installed', sourceId: 'catalog', sourcePluginId: 'original', location: { type: 'source-path', path: '.' },
    installedAt: '2026-01-01T00:00:00.000Z',
  }, { enabled: true, priority: 3 }, createPluginScan(plugin, 'revision-1', engine))
  return { temp, layout }
}

test('runtime loader accepts only its explicit engine, refreshes parser fingerprints and preserves installed data', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('new-parser-version')
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(record.scan.plugin.name, 'Fresh plugin')
    assert.equal(record.scan.parserSnapshot?.fingerprint, 'new-parser-version')
    assert.equal(calls.plugin, 1)
    assert(calls.source > 0)
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1, 'valid scans reuse the same engine snapshot')
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
    assert.equal((await readInstalledSource(layout, 'catalog')).scan.parserSnapshot?.fingerprint, engine.snapshot.fingerprint)
  } finally { await temp.cleanup() }
})

test('runtime loader still reports unavailable parser diagnostics when the installed source candidate vanished', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('removed-catalog-parser', { missing: true })
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1, 'the engine still evaluates the stored installed root')
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal(record.scan.plugin.name, 'Original installed name')
    assert(record.scan.plugin.formats.includes('codex'))
    assert.deepEqual([record.scan.plugin.skills, record.scan.plugin.mcpServers, record.scan.plugin.hooks], [[], [], []])
    assert.equal(record.state.enabled, true)
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('runtime refresh retains current candidate critical-policy diagnostics but isolates unrelated missing formats', async () => {
  const { temp, layout } = await fixture()
  try {
    const critical = customEngine('missing-critical-policy', { critical: true })
    const blocked = await loadInstalledPluginForRuntime(layout, 'installed', critical.engine)
    assert(blocked.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    const unrelated = customEngine('unrelated-missing-parser', { unrelatedMissing: true })
    const supported = await loadInstalledPluginForRuntime(layout, 'installed', unrelated.engine)
    assert.equal(supported.scan.plugin.diagnostics.length, 0, 'another source candidate must not poison this plugin')
    assert.equal(supported.state.enabled, true)
  } finally { await temp.cleanup() }
})

test('runtime loader invalidates legacy snapshotless scans, source revisions and global versions', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('old-parser-set')
    const record = await readInstalledPlugin(layout, 'installed')
    const source = await readInstalledSource(layout, 'catalog')
    delete record.scan.parserSnapshot
    delete source.scan.parserSnapshot
    await writeInstalledPlugin(layout.pluginRoot('installed'), record.install, record.state, record.scan)
    await writeInstalledSource(layout.sourceRoot('catalog'), source.source, source.scan)
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1)
    const currentSource = await readInstalledSource(layout, 'catalog')
    await writeInstalledSource(layout.sourceRoot('catalog'), { ...currentSource.source, revision: 'revision-2' }, currentSource.scan)
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 2)
    const current = await readInstalledPlugin(layout, 'installed')
    await writeInstalledPlugin(layout.pluginRoot('installed'), current.install, current.state, { ...current.scan, parserVersion: 'old-global-version' })
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 3)
    const stamped = await readInstalledSource(layout, 'catalog')
    assert.equal(stamped.scan.sourceRevision, 'revision-2')
  } finally { await temp.cleanup() }
})

test('neutral installed root resolution rejects traversal independently of parser implementations', async () => {
  const { temp, layout } = await fixture()
  try {
    const { install } = await readInstalledPlugin(layout, 'installed')
    await assert.rejects(resolveInstalledPluginPackageRoot(layout, { ...install, location: { type: 'source-path', path: '../outside' } }), /逃逸/)
  } finally { await temp.cleanup() }
})
