import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { createPluginScan, createSourceScan } from '../../src/manager/plugin-loader.js'
import type { CompatParserEngine, ParsePluginOptions } from '../../src/parser/contracts.js'
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
  omitCandidate = false
  criticalMissing = false
  constructor(readonly formats: CompatFormat[], readonly version = 'custom-1') {}
  get snapshot() {
    return { fingerprint: `${this.version}:${this.formats.join(',')}`, parsers: this.formats.map(id => ({ id, version: this.version })) }
  }
  async parsePlugin(_root: string, options: ParsePluginOptions = {}): Promise<CompatPlugin> {
    this.pluginCalls += 1
    return {
      id: options.asId ?? 'mixed', name: 'Mixed plugin', sourceId: options.sourceId ?? 'catalog', sourcePluginId: 'mixed',
      formats: ['claude-code', 'codex'],
      skills: this.formats.map(format => ({ name: `skill-${format}-${this.version}`, description: format,
        contentPath: 'SKILL.md', rootPath: '.', invocation: { modelInvocable: true, userInvocable: true }, sourceFormat: format })),
      mcpServers: [], hooks: [], commands: [], agents: [], manifestFiles: [],
      diagnostics: this.criticalMissing ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'plugin', 'Missing parser owns required policy')] : [],
    }
  }
  async parseSource(root: string): Promise<SourceDiscovery> {
    this.sourceCalls += 1
    const candidate: SourcePluginCandidate = {
      id: 'mixed', name: 'mixed', formats: ['claude-code', 'codex'], location: { type: 'source-path', path: '.' },
      locationKey: 'source-path:.', definitions: [], installable: !this.criticalMissing,
      diagnostics: this.criticalMissing ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'source', 'Catalog policy parser is unavailable')] : [],
    }
    const candidates = this.omitCandidate ? [] : [candidate]
    return { root, candidates, scan: {
      parserVersion: SOURCE_PARSER_VERSION, parserSnapshot: this.snapshot, scannedAt: new Date().toISOString(),
      formats: ['claude-code', 'codex'], plugins: candidates.map(({ definitions: _definitions, locationKey: _key, ...item }) => item),
      diagnostics: this.omitCandidate ? [diagnostic('error', 'PARSER_UNAVAILABLE', 'source', 'Catalog parser is unavailable')] : [],
      marketplaceFiles: [], discovery: 'single-plugin',
    } }
  }
}

async function fixture(engine: CustomEngine) {
  const temp = await temporaryDirectory('plugin-bridge-parser-cache-')
  const layout = new CompatLayout(join(temp.path, 'home'))
  await layout.ensure()
  await mkdir(layout.sourcePackageDir('catalog'), { recursive: true })
  await writeFile(join(layout.sourcePackageDir('catalog'), 'SKILL.md'), '---\nname: custom\ndescription: custom engine skill\n---\nBody')
  await mkdir(layout.dataDir('mixed'), { recursive: true })
  await writeFile(join(layout.dataDir('mixed'), 'history.txt'), 'retained user data')
  const plugin = await engine.parsePlugin(layout.sourcePackageDir('catalog'), { sourceId: 'catalog' })
  const discovery = await engine.parseSource(layout.sourcePackageDir('catalog'))
  await writeInstalledSource(layout.sourceRoot('catalog'), {
    id: 'catalog', origin: { type: 'directory', path: layout.sourcePackageDir('catalog') }, ownership: 'explicit',
    revision: 'source-1', createdAt: '2026-01-01T00:00:00.000Z',
  }, createSourceScan(discovery.scan, 'source-1', engine))
  await writeInstalledPlugin(layout.pluginRoot('mixed'), {
    pluginId: 'mixed', sourceId: 'catalog', sourcePluginId: 'mixed', location: { type: 'source-path', path: '.' },
    installedAt: '2026-01-01T00:00:00.000Z',
  }, { enabled: true, priority: 7 }, createPluginScan(plugin, 'source-1', engine))
  return { temp, layout }
}

for (const operation of ['inspect', 'list', 'reconcile'] as const) {
  test(`${operation} stops a running parent when a new parser set loses required semantics`, async () => {
    const original = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(original)
    const ctx = FakeContext.create()
    try {
      const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
      await new CompatManager(layout, runtime, original).reconcile()
      assert.equal(runtime.get('mixed').status, 'running')
      assert.equal((await ctx.listSkills()).length, 2)
      const missing = new CustomEngine(['claude-code'])
      missing.criticalMissing = true
      const manager = new CompatManager(layout, runtime, missing)
      if (operation === 'inspect') await manager.inspect('mixed')
      else if (operation === 'list') await manager.list()
      else await manager.reconcile()
      assert.equal((await ctx.listSkills()).length, 0)
      assert.equal(runtime.get('mixed').status, 'failed')
      assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
    } finally {
      await ctx.dispose()
      await temp.cleanup()
    }
  })
}

test('a new parser set replaces an existing mixed plugin parent with only its available capabilities', async () => {
  const original = new CustomEngine(['claude-code', 'codex'])
  const { temp, layout } = await fixture(original)
  const ctx = FakeContext.create()
  try {
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    await new CompatManager(layout, runtime, original).reconcile()
    assert.equal((await ctx.listSkills()).length, 2)
    const updated = new CustomEngine(['claude-code'])
    await new CompatManager(layout, runtime, updated).list()
    assert.equal((await ctx.listSkills()).length, 1)
    assert.equal(runtime.get('mixed').status, 'running')
    assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('source update rejects missing parser policy before commit and retains data and enabled intention', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']))
  try {
    const engine = new CustomEngine(['claude-code'])
    engine.criticalMissing = true
    const manager = new CompatManager(layout, undefined, engine)
    await assert.rejects(manager.sourceUpdate('catalog'), CompatibilityError)
    assert.equal((await readInstalledSource(layout, 'catalog')).source.revision, 'source-1')
    const record = await readInstalledPlugin(layout, 'mixed')
    assert.equal(record.state.enabled, true)
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})

for (const [label, updated] of [
  ['parser set changes', new CustomEngine(['claude-code'])],
  ['parser version changes', new CustomEngine(['claude-code', 'codex'], 'custom-2')],
] as const) {
  test(`manager inspect/list rebuild source and plugin caches when ${label}, preserving data and intent`, async () => {
    const old = new CustomEngine(['claude-code', 'codex'])
    const { temp, layout } = await fixture(old)
    try {
      const manager = new CompatManager(layout, undefined, updated)
      const result = await manager.inspect('mixed')
      assert.equal(updated.pluginCalls, 1)
      assert(updated.sourceCalls > 0)
      assert.equal(result.scan.parserSnapshot?.fingerprint, updated.snapshot.fingerprint)
      assert.equal(result.scan.plugin.skills.length, updated.formats.length)
      assert.deepEqual(result.state, { enabled: true, priority: 7 })
      assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
      assert.equal((await manager.list())[0].skills, updated.formats.length)
      assert.equal(updated.pluginCalls, 1, 'a current engine snapshot is reusable')
      assert.equal((await readInstalledSource(layout, 'catalog')).scan.parserSnapshot?.fingerprint, updated.snapshot.fingerprint)
      await manager.reconcile()
      assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
    } finally { await temp.cleanup() }
  })
}

test('missing source candidate remains inspectable without unsafe cross-format fallback or lost enabled state', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']))
  try {
    const engine = new CustomEngine(['claude-code'])
    engine.omitCandidate = true
    const manager = new CompatManager(layout, undefined, engine)
    const result = await manager.inspect('mixed')
    assert.equal(result.state.enabled, true)
    assert.equal(result.scan.plugin.skills.length, 0, 'an implicit remaining parser must not take over the missing catalog entry')
    assert(result.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal((await manager.list())[0].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'), true)
    await assert.rejects(manager.enable('mixed'), (error: unknown) => error instanceof CompatibilityError)
    await manager.reconcile()
    assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
    assert.equal(await readFile(join(layout.dataDir('mixed'), 'history.txt'), 'utf8'), 'retained user data')
  } finally { await temp.cleanup() }
})

test('missing critical semantics block remaining mixed-format capabilities without overwriting user intent', async () => {
  const { temp, layout } = await fixture(new CustomEngine(['claude-code', 'codex']))
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
    assert.equal(result.scan.plugin.skills.length, 1, 'remaining capabilities are visible for inspection')
    assert(result.scan.plugin.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    assert.equal(result.state.enabled, true)
    await assert.rejects(manager.enable('mixed'), CompatibilityError)
    assert.equal(starts, 0)
    assert.equal((await readInstalledPlugin(layout, 'mixed')).state.enabled, true)
  } finally { await temp.cleanup() }
})

test('legacy caches without snapshots and source revision mismatches both force engine rescans', async () => {
  const engine = new CustomEngine(['claude-code'])
  const { temp, layout } = await fixture(engine)
  try {
    const record = await readInstalledPlugin(layout, 'mixed')
    delete record.scan.parserSnapshot
    await writeInstalledPlugin(layout.pluginRoot('mixed'), record.install, record.state, record.scan)
    const source = await readInstalledSource(layout, 'catalog')
    delete source.scan.parserSnapshot
    await writeInstalledSource(layout.sourceRoot('catalog'), source.source, source.scan)
    engine.pluginCalls = engine.sourceCalls = 0
    const manager = new CompatManager(layout, undefined, engine)
    await manager.inspect('mixed')
    assert.equal(engine.pluginCalls, 1)
    assert(engine.sourceCalls > 0)
    const refreshed = await readInstalledSource(layout, 'catalog')
    await writeInstalledSource(layout.sourceRoot('catalog'), { ...refreshed.source, revision: 'source-2' }, refreshed.scan)
    await manager.inspect('mixed')
    assert.equal(engine.pluginCalls, 2)
    assert.equal((await readInstalledPlugin(layout, 'mixed')).scan.sourceRevision, 'source-2')
    assert.equal((await readInstalledSource(layout, 'catalog')).scan.sourceRevision, 'source-2')
  } finally { await temp.cleanup() }
})
