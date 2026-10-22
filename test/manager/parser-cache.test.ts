import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { createPluginScan, createSourceScan, isPluginScanCurrent } from '../../src/manager/plugin-loader.js'
import type { CompatParserEngine, ParsePluginOptions, ParserMatch } from '../../src/parser/contracts.js'
import type { SourceDiscovery, SourcePluginCandidate } from '../../src/types/catalog.js'
import { SOURCE_PARSER_VERSION } from '../../src/parser/version.js'
import { CompatibilityError } from '../../src/manager/errors.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { readInstalledPlugin, readInstalledSource, writeInstalledPlugin, writeInstalledSource } from '../../src/store/metadata.js'
import { diagnostic } from '../../src/types/diagnostic.js'
import type { CompatFormat, CompatPlugin } from '../../src/types/plugin.js'
import { temporaryDirectory } from '../helpers/temp.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'

/** An injected engine intentionally has no concrete parser or default registry dependency. */
class CustomEngine implements CompatParserEngine {
  pluginCalls = 0
  sourceCalls = 0
  pluginOptions: ParsePluginOptions[] = []
  omitCandidate = false
  criticalMissing = false
  constructor(readonly formats: CompatFormat[], readonly version = 'custom-1') {}
  get categories() { return this.formats.map((id, order) => ({ id, label: { en: id }, order })) }
  dispose(): void {}
  get snapshot() {
    return { fingerprint: `${this.version}:${this.formats.join(',')}`, parsers: this.formats.map(id => ({ id, version: this.version })) }
  }
  async matchPlugin(): Promise<ParserMatch[]> {
    return this.formats.map(parserId => ({ parserId, label: { en: parserId }, available: true,
      evidence: [{ kind: 'implicit' }], diagnostics: [] }))
  }
  async parsePlugin(_root: string, options: ParsePluginOptions = {}): Promise<CompatPlugin> {
    this.pluginCalls += 1
    this.pluginOptions.push(options)
    const parserId = options.parserId ?? (this.formats.length === 1 ? this.formats[0] : undefined)
    const available = parserId !== undefined && this.formats.includes(parserId)
    return {
      id: options.asId ?? 'mixed', name: 'Selected parser plugin', sourceId: options.sourceId ?? 'catalog',
      sourcePluginId: options.sourcePluginId ?? 'mixed', formats: parserId === undefined ? [] : [parserId],
      skills: available ? [{ name: `skill-${parserId}-${this.version}`, description: parserId,
        contentPath: 'SKILL.md', rootPath: '.', invocation: { modelInvocable: true, userInvocable: true }, sourceFormat: parserId }] : [],
      mcpServers: [], hooks: [], commands: [], agents: [], manifestFiles: [],
      diagnostics: parserId === undefined
        ? [diagnostic('error', 'PARSER_SELECTION_REQUIRED', 'plugin', 'Select one parser')]
        : !available || this.criticalMissing
          ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'plugin', 'Selected parser or its required policy is unavailable', undefined, { parserId })]
          : [],
    }
  }
  async parseSource(root: string): Promise<SourceDiscovery> {
    this.sourceCalls += 1
    const diagnostics = this.criticalMissing
      ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'source', 'Catalog policy parser is unavailable')]
      : []
    const candidate: SourcePluginCandidate = {
      id: 'mixed', name: 'mixed', formats: [...this.formats], location: { type: 'source-path', path: '.' },
      locationKey: 'source-path:.', definitions: [], installable: !this.criticalMissing, diagnostics,
    }
    const candidates = this.omitCandidate ? [] : [candidate]
    return { root, candidates, scan: {
      parserVersion: SOURCE_PARSER_VERSION, parserSnapshot: this.snapshot, scannedAt: new Date().toISOString(),
      formats: [...this.formats], plugins: candidates.map(({ definitions: _definitions, locationKey: _key, ...item }) => item),
      diagnostics: this.omitCandidate ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'source', 'Catalog parser is unavailable')] : [],
      marketplaceFiles: [], discovery: 'single-plugin',
    } }
  }
}

async function fixture(engine: CustomEngine, parserId = 'codex') {
  const temp = await temporaryDirectory('plugin-bridge-parser-cache-')
  const layout = new CompatLayout(join(temp.path, 'home'))
  await layout.ensure()
  await mkdir(layout.sourcePackageDir('catalog'), { recursive: true })
  await writeFile(join(layout.sourcePackageDir('catalog'), 'SKILL.md'), '---\nname: custom\ndescription: custom engine skill\n---\nBody')
  await mkdir(layout.dataDir('mixed'), { recursive: true })
  await writeFile(join(layout.dataDir('mixed'), 'history.txt'), 'retained user data')
  const plugin = await engine.parsePlugin(layout.sourcePackageDir('catalog'), { sourceId: 'catalog', parserId })
  const discovery = await engine.parseSource(layout.sourcePackageDir('catalog'))
  await writeInstalledSource(layout.sourceRoot('catalog'), {
    id: 'catalog', origin: { type: 'directory', path: layout.sourcePackageDir('catalog') }, ownership: 'explicit',
    revision: 'source-1', createdAt: '2026-01-01T00:00:00.000Z',
  }, createSourceScan(discovery.scan, 'source-1', engine))
  await writeInstalledPlugin(layout.pluginRoot('mixed'), {
    pluginId: 'mixed', sourceId: 'catalog', sourcePluginId: 'mixed', parserId, location: { type: 'source-path', path: '.' },
    installedAt: '2026-01-01T00:00:00.000Z',
  }, { enabled: true, priority: 7 }, createPluginScan(plugin, 'source-1', engine))
  return { temp, layout }
}

for (const operation of ['inspect', 'list', 'reconcile'] as const) {
  test(`${operation} stops a running parent when its selected parser disappears`, async () => {
    const original = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(original, 'codex')
    const ctx = FakeContext.create()
    try {
      const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
      await new CompatManager(layout, runtime, original).reconcile()
      assert.equal(runtime.get('mixed').status, 'running')
      assert.deepEqual((await ctx.listSkills()).map(skill => skill.name), ['skill-codex-custom-1'])
      const missing = new CustomEngine(['claude-code'])
      const manager = new CompatManager(layout, runtime, missing)
      if (operation === 'inspect') await manager.inspect('mixed')
      else if (operation === 'list') await manager.list()
      else await manager.reconcile()
      assert.equal((await ctx.listSkills()).length, 0)
      assert.equal(runtime.get('mixed').status, 'failed')
      assert.deepEqual(missing.pluginOptions.map(options => options.parserId), ['codex'], 'the remaining parser must not replace the selected parser')
      const record = await readInstalledPlugin(layout, 'mixed')
      assert.equal(record.install.parserId, 'codex')
      assert.deepEqual(record.scan.plugin.formats, ['codex'])
      assert.equal(record.scan.plugin.skills.length, 0)
      assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
      assert.deepEqual(record.state, { enabled: true, priority: 7 })
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
    } finally {
      await ctx.dispose()
      await temp.cleanup()
    }
  })
}

test('removing another parser preserves the selected parser capabilities and running parent', async () => {
  const original = new CustomEngine(['claude-code', 'codex'])
  const { temp, layout } = await fixture(original, 'claude-code')
  const ctx = FakeContext.create()
  try {
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    await new CompatManager(layout, runtime, original).reconcile()
    const before = await ctx.listSkills()
    assert.deepEqual(before.map(skill => skill.name), ['skill-claude-code-custom-1'])
    const updated = new CustomEngine(['claude-code'])
    await new CompatManager(layout, runtime, updated).list()
    assert.deepEqual((await ctx.listSkills()).map(skill => skill.name), before.map(skill => skill.name))
    assert.deepEqual(updated.pluginOptions.map(options => options.parserId), ['claude-code'])
    assert.equal(runtime.get('mixed').status, 'running')
    const record = await readInstalledPlugin(layout, 'mixed')
    assert.equal(record.install.parserId, 'claude-code')
    assert.deepEqual(record.scan.plugin.formats, ['claude-code'])
    assert.deepEqual(record.state, { enabled: true, priority: 7 })
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('source update rejects a removed selected parser before commit and retains data and enabled intention', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']), 'codex')
  try {
    const engine = new CustomEngine(['claude-code'])
    const manager = new CompatManager(layout, undefined, engine)
    await assert.rejects(manager.sourceUpdate('catalog'), CompatibilityError)
    assert.equal((await readInstalledSource(layout, 'catalog')).source.revision, 'source-1')
    const record = await readInstalledPlugin(layout, 'mixed')
    assert.equal(record.install.parserId, 'codex')
    assert.deepEqual(record.state, { enabled: true, priority: 7 })
    assert.deepEqual(record.scan.plugin.formats, ['codex'])
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    assert(engine.pluginOptions.every(options => options.parserId === 'codex'))
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})

for (const [label, updated] of [
  ['another parser is removed', new CustomEngine(['claude-code'])],
  ['the selected parser version changes', new CustomEngine(['claude-code', 'codex'], 'custom-2')],
] as const) {
  test(`manager inspect/list rebuild source and plugin caches when ${label}, preserving data and intent`, async () => {
    const old = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(old, 'claude-code')
    try {
      const manager = new CompatManager(layout, undefined, updated)
      const result = await manager.inspect('mixed')
      assert.equal(updated.pluginCalls, 1)
      assert(updated.sourceCalls > 0)
      assert.deepEqual(updated.pluginOptions.map(options => options.parserId), ['claude-code'])
      assert.equal(result.scan.parserSnapshot.fingerprint, updated.snapshot.fingerprint)
      assert.equal(result.install.parserId, 'claude-code')
      assert.deepEqual(result.scan.plugin.formats, ['claude-code'])
      assert.deepEqual(result.scan.plugin.skills.map(skill => [skill.name, skill.sourceFormat]), [[`skill-claude-code-${updated.version}`, 'claude-code']])
      assert.deepEqual(result.state, { enabled: true, priority: 7 })
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
      assert.equal((await manager.list())[0].skills, 1)
      assert.equal(updated.pluginCalls, 1, 'a current engine snapshot is reusable')
      assert.equal((await readInstalledSource(layout, 'catalog')).scan.parserSnapshot.fingerprint, updated.snapshot.fingerprint)
      await manager.reconcile()
      assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
    } finally { await temp.cleanup() }
  })
}

test('missing source candidate remains inspectable without unsafe parser fallback or lost enabled state', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']), 'claude-code')
  try {
    const engine = new CustomEngine(['claude-code'])
    engine.omitCandidate = true
    const manager = new CompatManager(layout, undefined, engine)
    const result = await manager.inspect('mixed')
    assert.equal(result.state.enabled, true)
    assert.equal(result.install.parserId, 'claude-code')
    assert.deepEqual(result.scan.plugin.formats, ['claude-code'])
    assert.equal(result.scan.plugin.skills.length, 0, 'a parser must not take over a missing catalog entry')
    assert(result.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal((await manager.list())[0].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'), true)
    await assert.rejects(manager.enable('mixed'), (error: unknown) => error instanceof CompatibilityError)
    await manager.reconcile()
    assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})

test('missing critical policy blocks selected parser capabilities without overwriting user intent', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']), 'claude-code')
  try {
    const engine = new CustomEngine(['claude-code'])
    engine.criticalMissing = true
    let starts = 0
    const runtime = new CompatRuntimeManager({ logger: { warn() {} } } as never, layout)
    runtime.start = async plugin => { starts += 1; return { pluginId: plugin.id, status: 'running', capabilities: [] } }
    const manager = new CompatManager(layout, runtime, engine)
    await manager.reconcile()
    assert.equal(starts, 0)
    const result = await manager.inspect('mixed')
    assert.equal(result.scan.plugin.skills.length, 1, 'the selected parser capabilities remain visible for inspection')
    assert.deepEqual(result.scan.plugin.formats, ['claude-code'])
    assert(result.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    assert.deepEqual(result.state, { enabled: true, priority: 7 })
    await assert.rejects(manager.enable('mixed'), CompatibilityError)
    assert.equal(starts, 0)
    assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})

test('plugin cache validity requires exactly the persisted parser id', async () => {
  const engine = new CustomEngine(['claude-code', 'codex'])
  const plugin = await engine.parsePlugin('/unused', { parserId: 'claude-code' })
  const scan = createPluginScan(plugin, 'source-1', engine)
  assert.equal(isPluginScanCurrent(scan, 'source-1', engine, 'claude-code'), true)
  for (const formats of [[], ['codex'], ['claude-code', 'codex'], ['claude-code', 'claude-code']]) {
    assert.equal(isPluginScanCurrent({ ...scan, plugin: { ...plugin, formats } }, 'source-1', engine, 'claude-code'), false,
      `formats ${JSON.stringify(formats)} must not reuse the selected parser cache`)
  }
})

for (const invalidation of ['fingerprint', 'parserVersion', 'sourceRevision', 'wrong parserId', 'multiple formats'] as const) {
  test(`manager rebuilds a current-schema plugin cache with stale ${invalidation}`, async () => {
    const engine = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(engine, 'codex')
    try {
      const record = await readInstalledPlugin(layout, 'mixed')
      if (invalidation === 'fingerprint') record.scan.parserSnapshot.fingerprint = 'stale-fingerprint'
      else if (invalidation === 'parserVersion') record.scan.parserVersion = 'stale-version'
      else if (invalidation === 'sourceRevision') record.scan.sourceRevision = 'stale-revision'
      else record.scan.plugin.formats = invalidation === 'wrong parserId' ? ['claude-code'] : ['codex', 'claude-code']
      await writeInstalledPlugin(layout.pluginRoot('mixed'), record.install, record.state, record.scan)
      engine.pluginCalls = engine.sourceCalls = 0
      engine.pluginOptions = []
      const manager = new CompatManager(layout, undefined, engine)
      const current = await manager.inspect('mixed')
      assert.equal(engine.pluginCalls, 1)
      assert.deepEqual(engine.pluginOptions.map(options => options.parserId), ['codex'])
      assert.equal(current.scan.parserSnapshot.fingerprint, engine.snapshot.fingerprint)
      assert.equal(isPluginScanCurrent(current.scan, 'source-1', engine, 'codex'), true)
      assert.deepEqual(current.scan.plugin.formats, ['codex'])
      assert.deepEqual(current.state, { enabled: true, priority: 7 })
      await manager.list()
      assert.equal(engine.pluginCalls, 1, 'the corrected cache is reused')
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
    } finally { await temp.cleanup() }
  })
}

for (const invalidation of ['fingerprint', 'parserVersion', 'sourceRevision'] as const) {
  test(`manager rebuilds a current-schema source cache with stale ${invalidation}`, async () => {
    const engine = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(engine, 'codex')
    try {
      const source = await readInstalledSource(layout, 'catalog')
      if (invalidation === 'fingerprint') source.scan.parserSnapshot.fingerprint = 'stale-fingerprint'
      else if (invalidation === 'parserVersion') source.scan.parserVersion = 'stale-version'
      else source.scan.sourceRevision = 'stale-revision'
      await writeInstalledSource(layout.sourceRoot('catalog'), source.source, source.scan)
      engine.pluginCalls = engine.sourceCalls = 0
      await new CompatManager(layout, undefined, engine).inspect('mixed')
      assert.equal(engine.sourceCalls, 1)
      assert.equal(engine.pluginCalls, 0, 'refreshing source metadata alone does not invalidate a current plugin scan')
      const current = await readInstalledSource(layout, 'catalog')
      assert.equal(current.scan.parserSnapshot.fingerprint, engine.snapshot.fingerprint)
      assert.equal(current.scan.parserVersion, SOURCE_PARSER_VERSION)
      assert.equal(current.scan.sourceRevision, 'source-1')
      assert.deepEqual((await readInstalledPlugin(layout, 'mixed')).state, { enabled: true, priority: 7 })
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
    } finally { await temp.cleanup() }
  })
}

test('a new source revision refreshes both caches while retaining the selected parser', async () => {
  const engine = new CustomEngine(['claude-code', 'codex'])
  const { temp, layout } = await fixture(engine, 'codex')
  try {
    const source = await readInstalledSource(layout, 'catalog')
    await writeInstalledSource(layout.sourceRoot('catalog'), { ...source.source, revision: 'source-2' }, source.scan)
    engine.pluginCalls = engine.sourceCalls = 0
    engine.pluginOptions = []
    await new CompatManager(layout, undefined, engine).inspect('mixed')
    assert.equal(engine.pluginCalls, 1)
    assert(engine.sourceCalls > 0)
    assert.deepEqual(engine.pluginOptions.map(options => options.parserId), ['codex'])
    const record = await readInstalledPlugin(layout, 'mixed')
    assert.equal(record.scan.sourceRevision, 'source-2')
    assert.equal((await readInstalledSource(layout, 'catalog')).scan.sourceRevision, 'source-2')
    assert.equal(record.install.parserId, 'codex')
    assert.deepEqual(record.state, { enabled: true, priority: 7 })
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})
