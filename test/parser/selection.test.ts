import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import type { PluginParser } from '../../src/parser/contracts.js'
import { ParserEngine } from '../../src/parser/engine.js'
import { selectCandidateParser } from '../../src/parser/model.js'
import type { MarketplacePluginDefinition } from '../../src/types/catalog.js'
import { diagnostic } from '../../src/types/diagnostic.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, file: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(root, file)), { recursive: true })
  await writeFile(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value))
}
function definition(format: string, extra: Partial<MarketplacePluginDefinition> = {}): MarketplacePluginDefinition {
  return { format, file: `${format}-market.json`, pointer: '/plugins/0', name: 'shared', sourcePathIsRoot: false,
    installable: true, diagnostics: [], manifestFields: { name: 'shared' }, ...extra }
}
function module(id: string, calls: string[], extra: Partial<PluginParser> = {}): PluginParser {
  return { id, version: '1.0.0', category: { label: { default: `Platform ${id}`, zh: `平台 ${id}` }, order: 0 },
    signature: { id, manifestPaths: [`${id}.json`], marketplacePaths: [] },
    async detect() { return { matched: false } }, async discoverSource() { return undefined },
    async preflight() { return { diagnostics: [] } },
    async parsePlugin() { calls.push(id); return { format: id, name: `${id}-only`, version: '1.0.0', manifestFiles: [`${id}.json`],
      skills: [], mcpServers: [], hooks: [], commands: [], agents: [], diagnostics: [] } }, ...extra }
}

test('matchPlugin returns protocol labels and actual evidence, including disabled catalog choices, without parsing capabilities', async () => {
  const temp = await temporaryDirectory()
  const calls: string[] = []
  const betaError = diagnostic('error', 'BETA_POLICY_DENIED', 'source', 'Beta catalog denies installation', 'beta-market.json')
  const engine = new ParserEngine([module('alpha', calls), module('beta', calls)])
  try {
    await put(temp.path, 'alpha.json', {})
    await put(temp.path, 'beta.json', {})
    const matches = await engine.matchPlugin(temp.path, { marketplaceDefinitions: [definition('beta', { installable: false, diagnostics: [betaError] }), definition('removed')] })
    assert.deepEqual(calls, [])
    assert.deepEqual(matches.map(item => [item.parserId, item.available]), [['alpha', true], ['beta', false], ['removed', false]])
    assert.deepEqual(matches[0].label, { en: 'Platform alpha', zh: '平台 alpha' })
    assert.deepEqual(matches[2].label, { en: 'removed' })
    assert.deepEqual(matches[0].evidence, [{ kind: 'manifest', file: 'alpha.json' }])
    assert.deepEqual(matches[1].evidence, [{ kind: 'manifest', file: 'beta.json' }, { kind: 'catalog', file: 'beta-market.json' }])
    assert.deepEqual(matches[1].diagnostics, [betaError])
    assert(matches[2].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
  } finally { engine.dispose(); await temp.cleanup() }
})

test('ambiguous parsing returns only selection error; explicit parsing executes one matching available module', async () => {
  const temp = await temporaryDirectory()
  const calls: string[] = []
  const engine = new ParserEngine([module('alpha', calls), module('beta', calls, {
    async preflight() { return { diagnostics: [diagnostic('error', 'BETA_MANIFEST_INVALID', 'plugin', 'Invalid beta metadata')] } },
  })])
  try {
    await put(temp.path, 'alpha.json', {})
    await put(temp.path, 'beta.json', {})
    await put(temp.path, 'package.json', '{invalid json')
    const ambiguous = await engine.parsePlugin(temp.path)
    assert.deepEqual(ambiguous.formats, ['alpha', 'beta'])
    assert.deepEqual(ambiguous.diagnostics.map(item => item.code), ['PARSER_SELECTION_REQUIRED'])
    assert.deepEqual(calls, [])
    const selected = await engine.parsePlugin(temp.path, { parserId: 'alpha' })
    assert.deepEqual(calls, ['alpha'])
    assert.deepEqual(selected.formats, ['alpha'])
    assert.equal(selected.name, 'alpha-only')
    assert(!selected.diagnostics.some(item => item.code === 'BETA_MANIFEST_INVALID'))
    const disabled = await engine.parsePlugin(temp.path, { parserId: 'beta' })
    assert.equal(disabled.manifestFiles.length, 0)
    assert(disabled.diagnostics.some(item => item.code === 'BETA_MANIFEST_INVALID'))
    assert.deepEqual(calls, ['alpha'])
    const mismatch = await engine.parsePlugin(temp.path, { parserId: 'removed' })
    assert.deepEqual(mismatch.diagnostics.map(item => item.code), ['PARSER_UNAVAILABLE'])
  } finally { engine.dispose(); await temp.cleanup() }
})

test('implicit evidence is explicit in the neutral API and matchPlugin never scans invalid capability files', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, 'skills/demo/SKILL.md', '---\ninvalid: [\n---\n')
    await put(temp.path, '.mcp.json', '{malformed json')
    await put(temp.path, 'hooks/hooks.json', '{malformed json')
    const matches = await engine.matchPlugin(temp.path)
    assert.deepEqual(matches.map(item => item.parserId), ['claude-code'])
    assert.deepEqual(matches[0].evidence, [{ kind: 'implicit' }])
    assert.equal(matches[0].available, true)
    assert.equal(matches[0].diagnostics.length, 0)
    const parsed = await engine.parsePlugin(temp.path)
    assert(parsed.diagnostics.some(item => item.level === 'error'))
  } finally { engine.dispose(); await temp.cleanup() }
})

test('exclusive root manifests cannot be bypassed by a selected parser or catalog policy', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, 'plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'exclusive' })
    await put(temp.path, '.claude-plugin/plugin.json', { name: 'other', userConfig: {} })
    const definitions = [definition('claude-code', { diagnostics: [diagnostic('error', 'OTHER_POLICY', 'source', 'Other policy')], installable: false })]
    const matches = await engine.matchPlugin(temp.path, { marketplaceDefinitions: definitions })
    assert.deepEqual(matches.map(item => item.parserId), ['agent-plugins'])
    assert.equal(matches[0].available, true)
    const mismatch = await engine.parsePlugin(temp.path, { parserId: 'claude-code', marketplaceDefinitions: definitions })
    assert.deepEqual(mismatch.diagnostics.map(item => item.code), ['PARSER_MISMATCH'])
    const parsed = await engine.parsePlugin(temp.path, { parserId: 'agent-plugins', marketplaceDefinitions: definitions })
    assert.deepEqual(parsed.formats, ['agent-plugins'])
    assert(!parsed.diagnostics.some(item => item.code === 'OTHER_POLICY' || item.code === 'CLAUDE_USER_CONFIG_UNSUPPORTED'))
    const removed = createBuiltinParserEngine(['claude-code'])
    try {
      const unavailable = await removed.parsePlugin(temp.path, { parserId: 'agent-plugins' })
      assert.equal(unavailable.skills.length + unavailable.mcpServers.length + unavailable.hooks.length, 0)
      assert(unavailable.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'))
    } finally { removed.dispose() }
  } finally { engine.dispose(); await temp.cleanup() }
})

test('interface-only Codex sidecars do not contaminate selected Claude skills or cause alias conflicts', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, '.claude-plugin/plugin.json', { name: 'claude-name', version: '1.0.0' })
    await put(temp.path, '.codex-plugin/plugin.json', { name: 'codex-name', version: '2.0.0', interface: { displayName: 'Codex display' } })
    await put(temp.path, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared skill\n---\nBody')
    await put(temp.path, 'skills/demo/agents/openai.yaml', 'interface:\n  display_name: Codex skill\n  short_description: Display only\n')
    const claude = await engine.parsePlugin(temp.path, { parserId: 'claude-code' })
    const codex = await engine.parsePlugin(temp.path, { parserId: 'codex' })
    assert.equal(claude.name, 'claude-name')
    assert.equal(claude.version, '1.0.0')
    assert.equal(claude.skills[0].metadata, undefined)
    assert(!claude.diagnostics.some(item => item.code.includes('CODEX') || item.code.includes('INTERFACE')))
    assert.equal(codex.name, 'Codex display')
    assert.equal(codex.version, '2.0.0')
    assert.deepEqual(codex.skills[0].metadata?.codex, { interface: { display_name: 'Codex skill', short_description: 'Display only' } })
    assert(!codex.diagnostics.some(item => item.level === 'error'))
  } finally { engine.dispose(); await temp.cleanup() }
})

test('false invocation permissions stay with the selected parser and cannot be widened by another parser', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, '.claude-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, '.codex-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared skill\nuser-invocable: "false"\n---\nBody')
    await put(temp.path, 'skills/demo/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n')
    const claude = await engine.parsePlugin(temp.path, { parserId: 'claude-code' })
    const codex = await engine.parsePlugin(temp.path, { parserId: 'codex' })
    assert.deepEqual(claude.skills[0].invocation, { modelInvocable: true, userInvocable: false })
    assert.deepEqual(codex.skills[0].invocation, { modelInvocable: false, userInvocable: true })
    assert.deepEqual(claude.formats, ['claude-code'])
    assert.deepEqual(codex.formats, ['codex'])
    assert(!claude.diagnostics.some(item => item.code === 'SKILL_NAME_DUPLICATE'))
    assert(!codex.diagnostics.some(item => item.code === 'SKILL_NAME_DUPLICATE'))
  } finally { engine.dispose(); await temp.cleanup() }
})

test('candidate policy projection isolates disabled platforms and preserves same-format catalog conflicts', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, 'shared/.claude-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, 'shared/.codex-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'cc', owner: { name: 'owner' }, plugins: [{ name: 'shared', source: './shared', defaultEnabled: true }] })
    await put(temp.path, '.agents/plugins/marketplace.json', { name: 'codex', plugins: [{ name: 'shared', source: './shared', policy: { installation: 'NOT_AVAILABLE' } }] })
    const candidate = (await engine.parseSource(temp.path)).candidates[0]
    assert.equal(candidate.installable, true)
    const claude = selectCandidateParser(candidate, 'claude-code')
    const codex = selectCandidateParser(candidate, 'codex')
    assert.equal(claude.installable, true)
    assert.equal(codex.installable, false)
    assert.equal(codex.defaultEnabled, undefined)
    assert(!claude.diagnostics.some(item => item.code.startsWith('CODEX_')))
    const matches = await engine.matchPlugin(resolve(temp.path, 'shared'), { marketplaceDefinitions: candidate.definitions })
    assert.equal(matches.find(item => item.parserId === 'claude-code')?.available, true)
    assert.equal(matches.find(item => item.parserId === 'codex')?.available, false)
    const denied = await engine.parsePlugin(resolve(temp.path, 'shared'), { parserId: 'codex', marketplaceDefinitions: candidate.definitions })
    assert(denied.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE'))
    assert.deepEqual(denied.manifestFiles, [])
    const duplicate = { ...claude.definitions[0], file: 'second-market.json' }
    const conflict = await engine.parsePlugin(resolve(temp.path, 'shared'), { parserId: 'claude-code', marketplaceDefinitions: [...candidate.definitions, duplicate] })
    assert(conflict.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_MARKETPLACE_CONFLICT'))
    assert.deepEqual(conflict.manifestFiles, [])
  } finally { engine.dispose(); await temp.cleanup() }
})

test('actual explicit parser choices remain selectable when a marketplace only declares another platform', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    await put(temp.path, 'shared/.claude-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, 'shared/.codex-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'cc', owner: { name: 'owner' }, plugins: [{ name: 'shared', source: './shared', defaultEnabled: true }] })
    const candidate = (await engine.parseSource(temp.path)).candidates[0]
    const matches = await engine.matchPlugin(resolve(temp.path, 'shared'), { marketplaceDefinitions: candidate.definitions })
    assert(matches.some(item => item.parserId === 'codex' && item.available))
    const selected = selectCandidateParser(candidate, 'codex')
    assert.equal(selected.installable, true)
    assert.deepEqual(selected.formats, ['codex'])
    assert.deepEqual(selected.definitions, [])
    assert.equal(selected.defaultEnabled, undefined)
    const parsed = await engine.parsePlugin(resolve(temp.path, 'shared'), { parserId: 'codex', marketplaceDefinitions: selected.definitions })
    assert.deepEqual(parsed.formats, ['codex'])
  } finally { engine.dispose(); await temp.cleanup() }
})
