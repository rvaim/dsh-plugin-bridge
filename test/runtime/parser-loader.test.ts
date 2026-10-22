import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createPluginScan, createSourceScan, isPluginScanCurrent, loadInstalledPluginForRuntime, resolveInstalledPluginPackageRoot } from '../../src/manager/plugin-loader.js'
import type { CompatParserEngine, ParsePluginOptions, ParserMatch } from '../../src/parser/contracts.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../../src/types/catalog.js'
import { PARSER_VERSION, SOURCE_PARSER_VERSION } from '../../src/parser/version.js'
import { CompatLayout } from '../../src/store/layout.js'
import { readInstalledPlugin, readInstalledSource, writeInstalledPlugin, writeInstalledSource } from '../../src/store/metadata.js'
import { diagnostic } from '../../src/types/diagnostic.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { temporaryDirectory } from '../helpers/temp.js'

const selectedParserId = 'custom-parser'
const otherParserId = 'other-parser'

function customEngine(fingerprint: string, options: {
  missing?: boolean
  critical?: boolean
  unrelatedMissing?: boolean
  parserIds?: string[]
  matchedParserIds?: string[]
  catalogFormats?: string[]
} = {}) {
  const calls = { plugin: 0, source: 0, options: [] as ParsePluginOptions[] }
  const parserIds = options.parserIds ?? [selectedParserId, otherParserId]
  const matchedParserIds = options.matchedParserIds ?? parserIds
  const engine: CompatParserEngine = {
    snapshot: { fingerprint, parsers: parserIds.map(id => ({ id, version: fingerprint })) },
    categories: parserIds.map((id, order) => ({ id, label: { en: id }, order })),
    dispose() {},
    async matchPlugin(): Promise<ParserMatch[]> {
      return matchedParserIds.map(parserId => ({ parserId, label: { en: parserId }, available: parserIds.includes(parserId),
        evidence: [{ kind: 'implicit' }], diagnostics: [] }))
    },
    async parsePlugin(_root: string, parseOptions: ParsePluginOptions = {}): Promise<CompatPlugin> {
      calls.plugin += 1
      calls.options.push(parseOptions)
      const parserId = parseOptions.parserId ?? (matchedParserIds.length === 1 ? matchedParserIds[0] : undefined)
      const available = parserId !== undefined && parserIds.includes(parserId)
      const matched = parserId !== undefined && matchedParserIds.includes(parserId)
      return {
        id: parseOptions.asId ?? 'installed', name: 'Fresh plugin', sourceId: parseOptions.sourceId ?? 'catalog',
        sourcePluginId: parseOptions.sourcePluginId ?? 'original', formats: parserId === undefined ? [] : [parserId],
        skills: available && matched ? [{ name: `skill-${parserId}`, description: parserId, contentPath: 'SKILL.md', rootPath: '.',
          invocation: { modelInvocable: true, userInvocable: true }, sourceFormat: parserId }] : [],
        mcpServers: [], hooks: [], commands: [], agents: [], manifestFiles: [],
        diagnostics: parserId === undefined
          ? [diagnostic('error', 'PARSER_SELECTION_REQUIRED', 'plugin', 'Select one parser')]
          : !available ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'plugin', 'The selected parser is unavailable', undefined, { parserId })]
            : matched ? [] : [diagnostic('error', 'PARSER_MISMATCH', 'plugin', 'The selected parser no longer matches the package', undefined, { parserId })],
      }
    },
    async parseSource(root: string): Promise<SourceDiscovery> {
      calls.source += 1
      const unavailable = (parserId: string) => diagnostic('error', 'PARSER_UNAVAILABLE', 'source',
        `The catalog policy for ${parserId} is unavailable`, `${parserId}/marketplace.json`, { parserId })
      const formats = options.catalogFormats ?? parserIds
      const definitions = formats.map(format => {
        const blocked = format === selectedParserId ? options.critical : options.unrelatedMissing
        return { format, file: `${format}/marketplace.json`, pointer: '/plugins/0', name: 'original',
          installable: !blocked, diagnostics: blocked ? [unavailable(format)] : [],
          sourcePathIsRoot: true, manifestFields: {} }
      })
      const candidate: SourcePluginCandidate = {
        id: 'original', name: 'Original', formats: [...formats], location: { type: 'source-path', path: '.' },
        locationKey: 'source-path:.', definitions, installable: definitions.some(item => item.installable),
        diagnostics: definitions.flatMap(item => item.diagnostics),
      }
      const candidates = options.missing ? [] : [candidate]
      return { root, candidates, scan: {
        parserVersion: SOURCE_PARSER_VERSION, parserSnapshot: engine.snapshot, scannedAt: '2026-01-01T00:00:00.000Z', formats: [...formats],
        plugins: candidates.map(({ definitions: _defs, locationKey: _key, ...item }) => item),
        diagnostics: options.missing ? [unavailable(selectedParserId)] : candidate.diagnostics,
        marketplaceFiles: definitions.map(item => item.file), discovery: 'marketplace',
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
  await writeFile(join(layout.sourcePackageDir('catalog'), 'SKILL.md'), '---\nname: custom\ndescription: custom skill\n---\nBody')
  await mkdir(layout.dataDir('installed'), { recursive: true })
  await writeFile(join(layout.dataDir('installed'), 'user.txt'), 'keep')
  const { engine } = customEngine('old-parser-set')
  const plugin = await engine.parsePlugin(layout.sourcePackageDir('catalog'), { parserId: selectedParserId })
  plugin.name = 'Original installed name'
  const catalog = await engine.parseSource(layout.sourcePackageDir('catalog'))
  await writeInstalledSource(layout.sourceRoot('catalog'), {
    id: 'catalog', origin: { type: 'directory', path: layout.sourcePackageDir('catalog') }, ownership: 'explicit', revision: 'revision-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  }, createSourceScan(catalog.scan, 'revision-1', engine))
  await writeInstalledPlugin(layout.pluginRoot('installed'), {
    pluginId: 'installed', sourceId: 'catalog', sourcePluginId: 'original', parserId: selectedParserId,
    location: { type: 'source-path', path: '.' }, installedAt: '2026-01-01T00:00:00.000Z',
  }, { enabled: true, priority: 3 }, createPluginScan(plugin, 'revision-1', engine))
  return { temp, layout }
}

test('runtime loader uses the persisted parser with its explicit engine and preserves installed data', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('new-parser-version')
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(record.scan.plugin.name, 'Fresh plugin')
    assert.equal(record.install.parserId, selectedParserId)
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert.deepEqual(record.scan.plugin.skills.map(skill => skill.sourceFormat), [selectedParserId])
    assert.equal(record.scan.parserSnapshot.fingerprint, 'new-parser-version')
    assert.equal(calls.plugin, 1)
    assert(calls.source > 0)
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert.deepEqual(calls.options[0].marketplaceDefinitions?.map(definition => definition.format), [selectedParserId])
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1, 'valid scans reuse the same engine snapshot')
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
    assert.equal((await readInstalledSource(layout, 'catalog')).scan.parserSnapshot.fingerprint, engine.snapshot.fingerprint)
  } finally { await temp.cleanup() }
})

test('removing an unselected parser preserves the selected parser capabilities during runtime refresh', async () => {
  const { temp, layout } = await fixture()
  try {
    const before = await readInstalledPlugin(layout, 'installed')
    const { engine, calls } = customEngine('other-parser-removed', { parserIds: [selectedParserId] })
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.deepEqual(record.scan.plugin.skills, before.scan.plugin.skills)
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert.equal(record.install.parserId, selectedParserId)
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert.equal(record.scan.plugin.diagnostics.length, 0)
    assert.deepEqual(record.state, before.state)
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('runtime loader fails closed when the selected parser disappears even though another parser remains', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('selected-parser-removed', { parserIds: [otherParserId] })
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1)
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert.equal(record.install.parserId, selectedParserId)
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.deepEqual([record.scan.plugin.skills, record.scan.plugin.mcpServers, record.scan.plugin.hooks,
      record.scan.plugin.commands, record.scan.plugin.agents], [[], [], [], [], []])
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('runtime loader keeps the selected package parser when only another parser has a catalog definition', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('other-catalog-definition', { catalogFormats: [otherParserId] })
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert.deepEqual(calls.options[0].marketplaceDefinitions, [])
    assert.equal(record.scan.plugin.diagnostics.length, 0)
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert.deepEqual(record.scan.plugin.skills.map(skill => skill.sourceFormat), [selectedParserId])
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('runtime loader fails closed when the installed parser no longer matches the package', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('selected-parser-no-longer-matches', {
      matchedParserIds: [otherParserId], catalogFormats: [otherParserId],
    })
    assert(engine.snapshot.parsers.some(parser => parser.id === selectedParserId), 'the selected parser remains registered')
    assert.deepEqual((await engine.matchPlugin(layout.sourcePackageDir('catalog'))).map(match => match.parserId), [otherParserId])
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1)
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert.deepEqual(calls.options[0].marketplaceDefinitions, [])
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_MISMATCH' && item.level === 'error'
      && item.details?.parserId === selectedParserId))
    assert.equal(record.install.parserId, selectedParserId)
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert.deepEqual([record.scan.plugin.skills, record.scan.plugin.mcpServers, record.scan.plugin.hooks,
      record.scan.plugin.commands, record.scan.plugin.agents], [[], [], [], [], []])
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
    await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1, 'a cached parser mismatch cannot trigger selection of the remaining parser')
  } finally { await temp.cleanup() }
})

test('runtime loader reports unavailable parser diagnostics when the installed source candidate vanished', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('removed-catalog-parser', { missing: true })
    const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1, 'the engine still evaluates the stored installed root using its persisted parser')
    assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal(record.scan.plugin.name, 'Original installed name')
    assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
    assert.deepEqual([record.scan.plugin.skills, record.scan.plugin.mcpServers, record.scan.plugin.hooks,
      record.scan.plugin.commands, record.scan.plugin.agents], [[], [], [], [], []])
    assert.deepEqual(record.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('runtime refresh applies only the selected parser catalog definitions and critical-policy diagnostics', async () => {
  const { temp, layout } = await fixture()
  try {
    const critical = customEngine('missing-critical-policy', { critical: true })
    const blocked = await loadInstalledPluginForRuntime(layout, 'installed', critical.engine)
    assert(blocked.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.details?.parserId === selectedParserId))
    assert.deepEqual(critical.calls.options[0].marketplaceDefinitions?.map(definition => definition.format), [selectedParserId])
    const unrelated = customEngine('unrelated-missing-parser', { unrelatedMissing: true })
    const supported = await loadInstalledPluginForRuntime(layout, 'installed', unrelated.engine)
    assert.equal(supported.scan.plugin.diagnostics.length, 0, 'another parser policy must not poison the selected parser')
    assert.deepEqual(unrelated.calls.options[0].marketplaceDefinitions?.map(definition => definition.format), [selectedParserId])
    assert.deepEqual(supported.scan.plugin.formats, [selectedParserId])
    assert.deepEqual(supported.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

for (const invalidation of ['fingerprint', 'parserVersion', 'sourceRevision', 'wrong parserId', 'multiple formats', 'duplicate selected parser'] as const) {
  test(`runtime loader invalidates a current-schema plugin scan with stale ${invalidation}`, async () => {
    const { temp, layout } = await fixture()
    try {
      const { engine, calls } = customEngine('old-parser-set')
      const record = await readInstalledPlugin(layout, 'installed')
      if (invalidation === 'fingerprint') record.scan.parserSnapshot.fingerprint = 'stale-fingerprint'
      else if (invalidation === 'parserVersion') record.scan.parserVersion = 'stale-version'
      else if (invalidation === 'sourceRevision') record.scan.sourceRevision = 'stale-revision'
      else record.scan.plugin.formats = invalidation === 'wrong parserId' ? [otherParserId]
        : invalidation === 'multiple formats' ? [selectedParserId, otherParserId] : [selectedParserId, selectedParserId]
      await writeInstalledPlugin(layout.pluginRoot('installed'), record.install, record.state, record.scan)
      const current = await loadInstalledPluginForRuntime(layout, 'installed', engine)
      assert.equal(calls.plugin, 1)
      assert.deepEqual(calls.options.map(options => options.parserId), [selectedParserId])
      assert.equal(current.scan.parserVersion, PARSER_VERSION)
      assert.equal(current.scan.parserSnapshot.fingerprint, engine.snapshot.fingerprint)
      assert.equal(isPluginScanCurrent(current.scan, 'revision-1', engine, selectedParserId), true)
      assert.deepEqual(current.scan.plugin.formats, [selectedParserId])
      assert.deepEqual(current.state, { enabled: true, priority: 3 })
      await loadInstalledPluginForRuntime(layout, 'installed', engine)
      assert.equal(calls.plugin, 1, 'the corrected scan is reusable')
      assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
    } finally { await temp.cleanup() }
  })
}

for (const invalidation of ['fingerprint', 'parserVersion', 'sourceRevision'] as const) {
  test(`runtime loader invalidates a current-schema source scan with stale ${invalidation}`, async () => {
    const { temp, layout } = await fixture()
    try {
      const { engine, calls } = customEngine('old-parser-set')
      const source = await readInstalledSource(layout, 'catalog')
      if (invalidation === 'fingerprint') source.scan.parserSnapshot.fingerprint = 'stale-fingerprint'
      else if (invalidation === 'parserVersion') source.scan.parserVersion = 'stale-version'
      else source.scan.sourceRevision = 'stale-revision'
      await writeInstalledSource(layout.sourceRoot('catalog'), source.source, source.scan)
      const record = await loadInstalledPluginForRuntime(layout, 'installed', engine)
      assert.equal(calls.source, 1)
      assert.equal(calls.plugin, 0)
      const refreshed = await readInstalledSource(layout, 'catalog')
      assert.equal(refreshed.scan.parserSnapshot.fingerprint, engine.snapshot.fingerprint)
      assert.equal(refreshed.scan.parserVersion, SOURCE_PARSER_VERSION)
      assert.equal(refreshed.scan.sourceRevision, 'revision-1')
      assert.deepEqual(record.scan.plugin.formats, [selectedParserId])
      assert.deepEqual(record.state, { enabled: true, priority: 3 })
      assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
    } finally { await temp.cleanup() }
  })
}

test('runtime loader refreshes source and plugin scans when the stored source revision changes', async () => {
  const { temp, layout } = await fixture()
  try {
    const { engine, calls } = customEngine('old-parser-set')
    const source = await readInstalledSource(layout, 'catalog')
    await writeInstalledSource(layout.sourceRoot('catalog'), { ...source.source, revision: 'revision-2' }, source.scan)
    const current = await loadInstalledPluginForRuntime(layout, 'installed', engine)
    assert.equal(calls.plugin, 1)
    assert(calls.source > 0)
    assert.equal(current.scan.sourceRevision, 'revision-2')
    assert.equal((await readInstalledSource(layout, 'catalog')).scan.sourceRevision, 'revision-2')
    assert.equal(current.install.parserId, selectedParserId)
    assert.deepEqual(current.state, { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('installed metadata without parserId is rejected without scanning or repairing the record', async () => {
  const { temp, layout } = await fixture()
  try {
    const record = await readInstalledPlugin(layout, 'installed')
    const { parserId: _parserId, ...invalidInstall } = record.install
    const invalidJson = JSON.stringify(invalidInstall)
    await writeFile(layout.installFile('installed'), invalidJson)
    const { engine, calls } = customEngine('new-parser-version')
    await assert.rejects(readInstalledPlugin(layout, 'installed'), /parserId/)
    await assert.rejects(loadInstalledPluginForRuntime(layout, 'installed', engine), /parserId/)
    assert.equal(calls.plugin, 0)
    assert.equal(calls.source, 0)
    assert.equal(await readFile(layout.installFile('installed'), 'utf8'), invalidJson)
    assert.deepEqual(JSON.parse(await readFile(layout.stateFile('installed'), 'utf8')), { enabled: true, priority: 3 })
    assert.equal(await readFile(join(layout.dataDir('installed'), 'user.txt'), 'utf8'), 'keep')
  } finally { await temp.cleanup() }
})

test('neutral installed root resolution rejects traversal independently of parser implementations', async () => {
  const { temp, layout } = await fixture()
  try {
    const { install } = await readInstalledPlugin(layout, 'installed')
    await assert.rejects(resolveInstalledPluginPackageRoot(layout, { ...install, location: { type: 'source-path', path: '../outside' } }), /逃逸/)
  } finally { await temp.cleanup() }
})
