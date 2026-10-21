import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { builtInParsers } from '../../src/composition/builtins.js'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { knownParserSignatures } from '../../src/composition/signatures.js'
import { CompatManager } from '../../src/manager/manager.js'
import type { CompatCategory, PluginParser } from '../../src/parser/contracts.js'
import { ParserEngine } from '../../src/parser/engine.js'
import { ParserCategoryRegistry } from '../../src/parser/registry.js'
import { CompatService } from '../../src/service.js'
import { CompatLayout } from '../../src/store/layout.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

function extraParser(id = 'fourth-parser'): PluginParser {
  return {
    id, version: '1.0.0',
    category: { label: { default: 'Fourth parser', zh: '第四种解析器' }, order: 15 },
    signature: { id, manifestPaths: [], marketplacePaths: [] },
    async detect() { return { matched: false } },
    async discoverSource() { return undefined },
    async parsePlugin() {
      return { format: id, manifestFiles: [], skills: [], mcpServers: [], hooks: [], commands: [], agents: [], diagnostics: [] }
    },
  }
}

const category = (id: string, order = 0): CompatCategory => ({ id, label: { en: id }, order })

test('category registry rejects duplicate ids and disposers only revoke their own registration', () => {
  const registry = new ParserCategoryRegistry()
  const owner = {}
  const otherOwner = {}
  const input = category('first', 20)
  const removeFirst = registry.register(owner, input)
  const removeOther = registry.register(otherOwner, category('other', 10))
  input.label.en = 'changed outside registry'
  assert.throws(() => registry.register(owner, category('first')), /重复/)
  assert.throws(() => registry.register(otherOwner, category('first')), /重复/)
  assert.deepEqual(registry.list().map(item => item.id), ['other', 'first'])
  assert.deepEqual(registry.list(owner), [category('first', 20)])
  const returned = registry.list()
  returned[0].label.en = 'changed returned copy'
  assert.equal(registry.list()[0].label.en, 'other')

  removeFirst()
  removeFirst()
  assert.deepEqual(registry.list(), [category('other', 10)])
  const removeReplacement = registry.register(otherOwner, category('first', 5))
  removeFirst()
  assert.deepEqual(registry.list().map(item => item.id), ['first', 'other'])
  removeReplacement()
  removeOther()
  assert.deepEqual(registry.list(), [])
})

test('all parser subsets contribute only actual modules and never retained signatures', () => {
  for (let mask = 0; mask < 1 << builtInParsers.length; mask++) {
    const modules = builtInParsers.filter((_parser, bit) => (mask & (1 << bit)) !== 0)
    const engine = createBuiltinParserEngine(modules.map(parser => parser.id))
    assert.deepEqual(engine.categories.map(item => item.id).sort(), modules.map(parser => parser.id).sort())
    assert.equal(engine.signatures.length, knownParserSignatures.length)
    engine.dispose()
    engine.dispose()
    assert.deepEqual(engine.categories, [])
  }
})

test('unknown fourth parser contributes normalized labels and deterministic ordering without a protocol table', () => {
  const parser = extraParser()
  const engine = new ParserEngine([...builtInParsers, parser], knownParserSignatures)
  assert.deepEqual(engine.categories.map(item => item.id), ['codex', 'fourth-parser', 'claude-code', 'agent-plugins'])
  assert.deepEqual(engine.categories.find(item => item.id === parser.id), {
    id: parser.id, label: { en: 'Fourth parser', zh: '第四种解析器' }, order: 15,
  })
  parser.category.label.default = 'changed after assembly'
  const returned = engine.categories
  returned[0].label.en = 'changed returned copy'
  assert.equal(engine.categories[0].label.en, 'Codex')
  assert.equal(engine.categories[1].label.en, 'Fourth parser')
  engine.dispose()
  assert.deepEqual(engine.categories, [])
  const reassembled = new ParserEngine([extraParser()])
  assert.equal(reassembled.categories.length, 1)
  reassembled.dispose()
})

test('shared category registration isolates engine owners and rolls back partial assembly', () => {
  const registry = new ParserCategoryRegistry()
  const first = new ParserEngine([extraParser('z-kept')], [], registry)
  const second = new ParserEngine([extraParser('second')], [], registry)
  assert.deepEqual(first.categories.map(item => item.id), ['z-kept'])
  assert.deepEqual(second.categories.map(item => item.id), ['second'])
  assert.throws(() => new ParserEngine([extraParser('a-rollback'), extraParser('z-kept')], [], registry), /重复/)
  assert.deepEqual(registry.list().map(item => item.id), ['second', 'z-kept'])
  first.dispose()
  first.dispose()
  assert.deepEqual(registry.list().map(item => item.id), ['second'])
  assert.deepEqual(second.categories.map(item => item.id), ['second'])
  second.dispose()
  assert.deepEqual(registry.list(), [])
})

test('metadata labels and order do not alter parser cache identity', () => {
  const original = new ParserEngine(builtInParsers, knownParserSignatures)
  const changed = new ParserEngine(builtInParsers.map(parser => ({
    ...parser, category: { label: { default: `Renamed ${parser.id}`, en: `English ${parser.id}`, zh: `中文 ${parser.id}` }, order: -parser.category.order },
  })), knownParserSignatures)
  assert.deepEqual(changed.snapshot, original.snapshot)
  assert.notDeepEqual(changed.categories, original.categories)
  original.dispose()
  changed.dispose()
})

test('metadata-only category changes reuse installed plugin and source caches', async () => {
  const temp = await temporaryDirectory('plugin-bridge-categories-')
  const original = createBuiltinParserEngine()
  let pluginCalls = 0
  let sourceCalls = 0
  const changed = new ParserEngine(builtInParsers.map(parser => ({
    ...parser,
    category: { label: { default: `Renamed ${parser.id}` }, order: -parser.category.order },
    async parsePlugin(input) { pluginCalls++; return parser.parsePlugin(input) },
    async discoverSource(root) { sourceCalls++; return parser.discoverSource(root) },
  })), knownParserSignatures)
  try {
    const source = resolve(temp.path, 'source')
    await buildClaudePlugin(source, { name: 'category-cache' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await new CompatManager(layout, undefined, original).install(source, { enable: false })
    const manager = new CompatManager(layout, undefined, changed)
    assert.deepEqual((await manager.list()).map(item => item.id), ['category-cache'])
    assert.equal(pluginCalls, 0)
    assert.equal(sourceCalls, 0)
    assert.equal(manager.listCategories()[0].label.en, 'Renamed agent-plugins')
  } finally {
    original.dispose()
    changed.dispose()
    await temp.cleanup()
  }
})

test('service stop revokes its parser categories even when runtime shutdown fails', async () => {
  const engine = createBuiltinParserEngine()
  const service = {
    manager: { parsers: engine },
    runtime: { async stopAll() { throw new Error('runtime shutdown failed') } },
  } as unknown as CompatService
  await assert.rejects(CompatService.prototype.stop.call(service), /runtime shutdown failed/)
  assert.deepEqual(engine.categories, [])
})
