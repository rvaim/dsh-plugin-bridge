import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { Config } from '../src/config.js'
import { createBuiltinParserEngine } from '../src/composition/defaults.js'
import { AGENT_PLUGIN_SCHEMA_URI } from '../src/protocols/agent-plugins/constants.js'
import { temporaryDirectory } from './helpers/temp.js'

async function put(root: string, file: string, value: string | object): Promise<void> {
  const path = resolve(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

test('实际配置校验保留省略、空列表与指定解析器三种语义', () => {
  const defaults = Config({})
  assert.equal(defaults.parsers, undefined)
  assert.deepEqual(createBuiltinParserEngine(defaults.parsers).snapshot.parsers.map(parser => parser.id), ['agent-plugins', 'claude-code', 'codex'])

  const disabled = Config({ parsers: [] })
  assert.deepEqual(disabled.parsers, [])
  assert.deepEqual(createBuiltinParserEngine(disabled.parsers).snapshot.parsers, [])

  const selected = Config({ parsers: ['codex'] })
  assert.deepEqual(selected.parsers, ['codex'])
  assert.deepEqual(createBuiltinParserEngine(selected.parsers).snapshot.parsers.map(parser => parser.id), ['codex'])
})

test('无清单名称的根插件在暂存目录和存储目录下保持同一候选 ID', async () => {
  const temp = await temporaryDirectory()
  try {
    const first = resolve(temp.path, 'acquired-source')
    const second = resolve(temp.path, 'package')
    for (const root of [first, second]) await put(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: 无清单约定目录\n---\n正文\n')
    const engine = createBuiltinParserEngine()
    const one = await engine.parseSource(first, { suggestedPluginId: 'stable-origin' })
    const two = await engine.parseSource(second, { suggestedPluginId: 'stable-origin' })
    assert.equal(one.candidates[0].id, 'stable-origin')
    assert.equal(two.candidates[0].id, 'stable-origin')
    assert.equal(one.candidates[0].installable, true)
    assert.equal(two.candidates[0].installable, true)
    assert.equal(one.scan.suggestedPluginId, 'stable-origin')
  } finally { await temp.cleanup() }
})

test('普通根 plugin.json 不抢占 Claude 清单，Agent schema 声明仍被识别并阻断无效清单', async () => {
  const temp = await temporaryDirectory()
  try {
    const claude = resolve(temp.path, 'claude-with-json')
    await put(claude, '.claude-plugin/plugin.json', { name: 'claude-plugin' })
    await put(claude, 'plugin.json', { name: 'ordinary-json' })
    const ordinary = await createBuiltinParserEngine().parseSource(claude)
    assert.deepEqual(ordinary.candidates[0].formats, ['claude-code'])

    const future = resolve(temp.path, 'future-agent')
    await put(future, 'plugin.json', {
      $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
      name: 'future-agent',
    })
    const blocked = await createBuiltinParserEngine().parseSource(future)
    assert.deepEqual(blocked.candidates[0].formats, ['agent-plugins'])
    assert.equal(blocked.candidates[0].installable, false)
    assert(blocked.candidates[0].diagnostics.some(item => item.level === 'error'))
  } finally { await temp.cleanup() }
})

test('默认配置经过 schema 后可发现三种格式，显式空列表保留阻断诊断', async () => {
  const temp = await temporaryDirectory()
  try {
    const enabled = createBuiltinParserEngine(Config({}).parsers)
    const disabled = createBuiltinParserEngine(Config({ parsers: [] }).parsers)
    for (const [format, manifest] of [
      ['claude-code', '.claude-plugin/plugin.json'],
      ['codex', '.codex-plugin/plugin.json'],
      ['agent-plugins', 'plugin.json'],
    ] as const) {
      const root = resolve(temp.path, format)
      await put(root, manifest, { ...(format === 'agent-plugins' ? { $schema: AGENT_PLUGIN_SCHEMA_URI } : {}), name: 'configured-plugin' })
      await put(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: 配置回归样例\n---\n正文\n')
      const source = await enabled.parseSource(root)
      assert.equal(source.candidates[0].id, 'configured-plugin')
      assert.equal(source.candidates[0].installable, true, JSON.stringify(source.candidates[0].diagnostics))
      const plugin = await enabled.parsePlugin(root)
      assert.deepEqual(plugin.skills.map(skill => skill.name), ['demo'])
      assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
      const blocked = await disabled.parseSource(root)
      assert.equal(blocked.candidates[0].installable, false)
      assert(blocked.candidates[0].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    }
  } finally { await temp.cleanup() }
})
