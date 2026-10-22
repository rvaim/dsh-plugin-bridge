import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { registerSkillProvider } from '../../src/runtime/adapters/skills.js'
import { AGENT_MCP_SCHEMA_URI, AGENT_PLUGIN_SCHEMA_URI, AGENT_PLUGINS_VERSION } from '../../src/protocols/agent-plugins/constants.js'
import { parseAgentPluginsHarness } from '../../src/protocols/agent-plugins/manifest.js'
import { inspectContainedPath, resolveContainedPath } from '../../src/shared/contained-path.js'
import { validateAgentMcpEnvelope, validateAgentMcpServer, validateAgentPluginManifest } from '../../src/protocols/agent-plugins/schema.js'
import { parseAgentPluginSkills } from '../../src/protocols/agent-plugins/skills.js'
import { DiagnosticCollector } from '../../src/shared/diagnostics.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { FakeContext } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

const minimal = { $schema: AGENT_PLUGIN_SCHEMA_URI, name: 'example.plugin' }

async function manifest(root: string, value: unknown = minimal): Promise<void> {
  await writeFile(resolve(root, 'plugin.json'), JSON.stringify(value))
}

async function skill(root: string, folder: string, attributes = `name: ${folder}\ndescription: Skill description`, body = 'Literal body\r\n'): Promise<void> {
  const directory = resolve(root, 'skills', folder)
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'SKILL.md'), `---\n${attributes}\n---\n${body}`)
}

function noErrors(collector: DiagnosticCollector): void {
  assert.equal(collector.items.some(item => item.level === 'error'), false, JSON.stringify(collector.items))
}

test('vendored Agent Plugins 1.0.0 schemas match tag and canonical endpoint SHA256 and ship full attribution', async () => {
  assert.equal(AGENT_PLUGINS_VERSION, '1.0.0')
  for (const [name, expected] of [
    ['plugin', '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883'],
    ['mcp', '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb'],
  ]) {
    const source = await readFile(resolve(`src/protocols/agent-plugins/schemas/1.0.0/${name}.schema.json`), 'utf8')
    const emitted = await readFile(new URL(`../../src/protocols/agent-plugins/schemas/1.0.0/${name}.schema.json`, import.meta.url), 'utf8')
    // 哈希对应规范 LF 内容；Git 在 Windows 上检出为 CRLF，比较前统一换行。
    const canonical = source.replaceAll('\r\n', '\n')
    assert.equal(createHash('sha256').update(canonical).digest('hex'), expected)
    // tsc 会重排 JSON 空白；发布产物必须保持相同的 schema 数据。
    assert.deepEqual(JSON.parse(emitted), JSON.parse(source))
  }
  const license = JSON.parse(await readFile(new URL('../../src/protocols/agent-plugins/schemas/1.0.0/LICENSE.json', import.meta.url), 'utf8')) as Record<string, unknown>
  assert.equal(license.license, 'Apache-2.0')
  assert.equal(license.revision, 'bd383552095128f6effe895b9257cfd580a6d179')
  assert.match(String(license.licenseText), /END OF TERMS AND CONDITIONS/)
})

test('local JSON Schema validation stays strict and MCP envelope preserves per-server failure boundaries', () => {
  assert.equal(validateAgentPluginManifest(minimal), true)
  assert.equal(validateAgentPluginManifest({ ...minimal, hooks: {} }), false)
  const servers = { good: { type: 'stdio', command: 'node' }, bad: 4 }
  assert.equal(validateAgentMcpEnvelope({ $schema: AGENT_MCP_SCHEMA_URI, mcpServers: servers }), true)
  assert.equal(validateAgentMcpServer(servers.good), true)
  assert.equal(validateAgentMcpServer(servers.bad), false)
  assert.equal(validateAgentMcpServer({ type: 'streamable-http', url: 'https://example.com/mcp', command: 'node' }), false)
  assert.equal(validateAgentMcpServer({ type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'bad' } }), false)
  assert.equal(validateAgentMcpEnvelope({ $schema: AGENT_MCP_SCHEMA_URI, mcpServers: [] }), false)
  assert.equal(validateAgentMcpEnvelope({ $schema: AGENT_MCP_SCHEMA_URI, mcpServers: {}, unexpected: true }), false)
  assert.equal(validateAgentMcpEnvelope({ mcpServers: {} }), false)
})

test('manifest uses only fixed component locations and ignores unknown topfields without retaining raw data', async () => {
  const temp = await temporaryDirectory()
  try {
    await manifest(temp.path, { ...minimal, skills: './alternate', hooks: { Stop: 'sensitive-hook' }, mcpServers: { token: 'sensitive-inline' } })
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginsHarness(temp.path, collector)
    assert(parsed)
    assert.equal(parsed.format, 'agent-plugins')
    assert.deepEqual(parsed.skillPaths, ['skills'])
    assert.deepEqual(parsed.mcpSources, [{ file: 'mcp.json' }])
    assert.deepEqual(parsed.hookSources, [])
    assert.deepEqual(parsed.commandPaths, [])
    assert.deepEqual(parsed.agentPaths, [])
    assert.deepEqual(parsed.defaultCapabilityPaths, { skills: false, commands: false, agents: false })
    assert.deepEqual(parsed.manifest, minimal)
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGIN_MANIFEST_UNKNOWN_FIELD').length, 3)
    assert.equal(JSON.stringify({ parsed, diagnostics: collector.items }).includes('sensitive-'), false)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('all unimplemented extension namespace values and nonobject extensions are ignored per normative exceptions', async () => {
  const temp = await temporaryDirectory()
  try {
    for (const extensions of [false, 42, null, 'sensitive-extension', [], {
      'com.openai': 'sensitive-extension',
      'com.example': null,
      'not.reverse-domain': [false, 42],
      invalid: { token: 'sensitive-extension' },
    }]) {
      await manifest(temp.path, { ...minimal, extensions })
      const collector = new DiagnosticCollector()
      const parsed = await parseAgentPluginsHarness(temp.path, collector)
      assert(parsed)
      assert.deepEqual(parsed.manifest, minimal)
      assert.equal(collector.items.filter(item => item.code.startsWith('AGENT_PLUGIN_EXTENSIONS_')).length, 1)
      assert.equal(JSON.stringify({ parsed, diagnostics: collector.items }).includes('sensitive-extension'), false)
      noErrors(collector)
    }
  } finally { await temp.cleanup() }
})

test('malformed, no-schema, unsupported-schema, wrong-name, metadata-type and author errors reject whole manifest', async () => {
  const temp = await temporaryDirectory()
  try {
    const invalidValues: unknown[] = [null, [], false, {}, { name: 'okay' },
      { ...minimal, $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' },
      ...['', 'UPPER', '-start', 'end-', 'two--parts', 'two..dots', 'has space', 'x'.repeat(65)].map(name => ({ ...minimal, name })),
      { ...minimal, author: 'Jane' }, { ...minimal, author: { name: 3 } }, { ...minimal, author: { extra: 'sensitive-author' } },
      { ...minimal, keywords: [7] }, { ...minimal, version: 9 },
    ]
    for (const value of invalidValues) {
      await manifest(temp.path, value)
      const collector = new DiagnosticCollector()
      assert.equal(await parseAgentPluginsHarness(temp.path, collector), undefined)
      assert(collector.items.some(item => item.level === 'error'))
      assert.equal(JSON.stringify(collector.items).includes('sensitive-author'), false)
    }
    await writeFile(resolve(temp.path, 'plugin.json'), '{ invalid json')
    const collector = new DiagnosticCollector()
    assert.equal(await parseAgentPluginsHarness(temp.path, collector), undefined)
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_MANIFEST_INVALID'))
  } finally { await temp.cleanup() }
})

test('metadata validates only JSON types, with no semver/url/email/SPDX interpretation', async () => {
  const temp = await temporaryDirectory()
  try {
    await manifest(temp.path, { ...minimal, version: 'rolling', homepage: 'not a URL', repository: '', license: 'custom terms', author: { email: 'local handle', url: 'anything' }, keywords: [''] })
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginsHarness(temp.path, collector)
    assert(parsed)
    assert.equal(parsed.version, 'rolling')
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('a root manifest symlink escape is fatal; contained manifest links work', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'root')
    await mkdir(root)
    await manifest(temp.path)
    await symlink('../plugin.json', resolve(root, 'plugin.json'))
    const rejected = new DiagnosticCollector()
    assert.equal(await parseAgentPluginsHarness(root, rejected), undefined)
    assert(rejected.items.some(item => item.code === 'AGENT_PLUGIN_MANIFEST_PATH_INVALID' && item.level === 'error'))
    const contained = resolve(temp.path, 'contained')
    await mkdir(resolve(contained, 'core'), { recursive: true })
    await manifest(resolve(contained, 'core'))
    await symlink('./core/plugin.json', resolve(contained, 'plugin.json'))
    assert(await parseAgentPluginsHarness(contained, new DiagnosticCollector()))
  } finally { await temp.cleanup() }
})

test('legacy manifests, root SKILL.md, alternate skills, hooks, agents, commands and MCP do not supply core discovery', async () => {
  const temp = await temporaryDirectory()
  try {
    await manifest(temp.path)
    for (const folder of ['.codex-plugin', '.claude-plugin', 'alternate', 'hooks', 'agents', 'commands']) await mkdir(resolve(temp.path, folder))
    await manifest(resolve(temp.path, '.codex-plugin'), { name: 'override', skills: './alternate' })
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: { legacy: { command: 'node' } } }))
    await writeFile(resolve(temp.path, 'SKILL.md'), '---\nname: root\ndescription: Root skill\n---\n')
    await writeFile(resolve(temp.path, 'alternate/SKILL.md'), '---\nname: alternate\ndescription: Alternate skill\n---\n')
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginsHarness(temp.path, collector)
    assert(parsed)
    assert.equal(parsed.name, minimal.name)
    assert.deepEqual(await parseAgentPluginSkills(temp.path, collector), [])
    assert.deepEqual(parsed.mcpSources, [{ file: 'mcp.json' }])
    assert.deepEqual(parsed.hookSources, [])
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_LEGACY_COMPONENTS_IGNORED'))
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('Skill discovery is exact-case direct-child-only and does not read Codex openai sidecars', async () => {
  const temp = await temporaryDirectory()
  try {
    await skill(temp.path, 'good')
    await mkdir(resolve(temp.path, 'skills/good/agents'))
    await writeFile(resolve(temp.path, 'skills/good/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\ndependencies: invalid')
    await skill(temp.path, 'wrapper/deep', 'name: deep\ndescription: Nested skill')
    await mkdir(resolve(temp.path, 'skills/lower'))
    await writeFile(resolve(temp.path, 'skills/lower/skill.md'), '---\nname: lower\ndescription: Lowercase filename\n---\n')
    await writeFile(resolve(temp.path, 'skills/plain-file'), 'not a directory')
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginSkills(temp.path, collector)
    assert.deepEqual(parsed.map(item => item.name), ['good'])
    assert.deepEqual(parsed[0].invocation, { modelInvocable: true, userInvocable: true })
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('invalid individual skills skip while name/description lengths, folder matching and metadata map constraints remain strict', async () => {
  const temp = await temporaryDirectory()
  try {
    const cases: Array<[string, string]> = [
      ['good', 'name: good\ndescription: Good skill'],
      ['missing-name', 'description: Missing name'],
      ['missing-description', 'name: missing-description'],
      ['wrong-name', 'name: other\ndescription: Mismatched'],
      ['long-description', `name: long-description\ndescription: ${'x'.repeat(1025)}`],
      ['bad-description', 'name: bad-description\ndescription: 42'],
      ['bad-metadata', 'name: bad-metadata\ndescription: Metadata bad\nmetadata:\n  version: 1'],
      ['bad-metadata-map', 'name: bad-metadata-map\ndescription: Metadata bad\nmetadata: []'],
      ['bad-license', 'name: bad-license\ndescription: License bad\nlicense: false'],
      ['bad-compatibility', `name: bad-compatibility\ndescription: Compatibility bad\ncompatibility: ${'x'.repeat(501)}`],
      ['empty-compatibility', 'name: empty-compatibility\ndescription: Compatibility empty\ncompatibility: ""'],
      ['bad-tools', 'name: bad-tools\ndescription: Tools bad\nallowed-tools: [Read]'],
      ['invalid--name', 'name: invalid--name\ndescription: Invalid name'],
      ['x'.repeat(65), `name: ${'x'.repeat(65)}\ndescription: Too long`],
    ]
    for (const [folder, attributes] of cases) await skill(temp.path, folder, attributes)
    await mkdir(resolve(temp.path, 'skills/not-a-file/SKILL.md'), { recursive: true })
    await skill(temp.path, 'malformed', 'name: malformed\nmetadata:\n wrong: bad\n  duplicate: indent')
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginSkills(temp.path, collector)
    assert.deepEqual(parsed.map(item => item.name), ['good'])
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILL_PATH_INVALID'))
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILL_FIELD_INVALID'))
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILL_FRONTMATTER_INVALID'))
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('Agent Skills Unicode names receive a DSH host-constraint warning, not an upstream invalid-name error', async () => {
  const temp = await temporaryDirectory()
  try {
    await skill(temp.path, 'résumé')
    const collector = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginSkills(temp.path, collector), [])
    assert(collector.items.some(item => item.code === 'SKILL_NAME_DSH_UNSUPPORTED'))
    assert.equal(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILL_NAME_INVALID'), false)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('Agent Skills allowed-tools skips only that skill and unknown platform fields are ignored without behavior changes', async () => {
  const temp = await temporaryDirectory()
  try {
    await skill(temp.path, 'blocked', 'name: blocked\ndescription: Restricted\nallowed-tools: Read Bash(git:*)')
    await skill(temp.path, 'good', 'name: good\ndescription: Good\ndisable-model-invocation: true\nuser-invocable: false\nwhen_to_use: sensitive-unknown\nmodel: sensitive-unknown\nhooks: sensitive-unknown', '!`literal syntax` $ARGUMENTS ${CLAUDE_SKILL_DIR}')
    const collector = new DiagnosticCollector()
    const parsed = await parseAgentPluginSkills(temp.path, collector)
    assert.deepEqual(parsed.map(item => item.name), ['good'])
    assert.deepEqual(parsed[0].invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(parsed[0].whenToUse, undefined)
    assert.equal(parsed[0].metadata, undefined)
    assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILL_BEHAVIOR_UNSUPPORTED' && item.level === 'warning'))
    assert.equal(JSON.stringify({ parsed, diagnostics: collector.items }).includes('sensitive-unknown'), false)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('wrong-kind or escaping fixed skills root disables only Skill component and does not invalidate MCP descriptor', async () => {
  const temp = await temporaryDirectory()
  try {
    const wrong = resolve(temp.path, 'wrong')
    const escaped = resolve(temp.path, 'escaped')
    const outside = resolve(temp.path, 'outside')
    await mkdir(wrong)
    await mkdir(escaped)
    await mkdir(outside)
    await writeFile(resolve(wrong, 'skills'), 'not a directory')
    await symlink('../outside', resolve(escaped, 'skills'))
    for (const root of [wrong, escaped]) {
      await manifest(root)
      const collector = new DiagnosticCollector()
      const parsed = await parseAgentPluginsHarness(root, collector)
      assert(parsed)
      assert.deepEqual(await parseAgentPluginSkills(root, collector), [])
      assert.deepEqual(parsed.mcpSources, [{ file: 'mcp.json' }])
      assert(collector.items.some(item => item.code === 'AGENT_PLUGIN_SKILLS_PATH_INVALID' && item.level === 'warning'))
      noErrors(collector)
    }
  } finally { await temp.cleanup() }
})

test('escaping individual SKILL.md and child-directory links skip only their entries; contained links remain usable', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'root')
    await mkdir(root)
    await skill(root, 'good')
    await writeFile(resolve(temp.path, 'external.md'), '---\nname: escaped\ndescription: External\n---\n')
    await mkdir(resolve(root, 'skills/escaped'))
    await symlink('../../../external.md', resolve(root, 'skills/escaped/SKILL.md'))
    await symlink('../../', resolve(root, 'skills/outside'))
    await mkdir(resolve(root, 'data'))
    await writeFile(resolve(root, 'data/contained.md'), '---\nname: contained\ndescription: Internal\n---\n')
    await mkdir(resolve(root, 'skills/contained'))
    await symlink('../../data/contained.md', resolve(root, 'skills/contained/SKILL.md'))
    const collector = new DiagnosticCollector()
    assert.deepEqual((await parseAgentPluginSkills(root, collector)).map(item => item.name), ['contained', 'good'])
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGIN_SKILL_PATH_INVALID').length, 2)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('filesystem containment handles missing suffixes, escaped ancestors, dangling links and symlink loops without lstat recursion', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'root')
    await mkdir(root)
    await mkdir(resolve(root, 'inside'))
    await symlink('./inside', resolve(root, 'contained'))
    await symlink('../', resolve(root, 'escaped'))
    await symlink('../missing-outside', resolve(root, 'dangling'))
    await symlink('./loop', resolve(root, 'loop'))
    const rootReal = await realpath(root)
    assert.equal(await resolveContainedPath(root, './contained/new/nested'), resolve(rootReal, 'inside/new/nested'))
    for (const target of ['./escaped/missing/nested', './dangling/nested', './loop', '../not-inside']) {
      await assert.rejects(resolveContainedPath(root, target), /Contained package path is invalid/)
    }
    assert.deepEqual(await inspectContainedPath(root, 'not-there', 'file'), { status: 'missing' })
    assert.deepEqual(await inspectContainedPath(root, 'inside', 'file'), { status: 'invalid', reason: 'kind' })
  } finally { await temp.cleanup() }
})

test('valid Agent Plugins skill preserves literal description/metadata and reuses the on-demand DSH Provider contract', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const attributes = 'name: demo\ndescription: "  literal description\\nsecond line  "\nlicense: Custom license\ncompatibility: Requires Python\nmetadata:\n  author: Team\n  version: "1.0"'
    await skill(temp.path, 'demo', attributes, 'First body\r\n')
    const collector = new DiagnosticCollector()
    const skills = await parseAgentPluginSkills(temp.path, collector)
    assert.equal(skills[0].sourceFormat, 'agent-plugins')
    assert.equal(skills[0].description, '  literal description\nsecond line  ')
    assert.deepEqual(skills[0].metadata, { license: 'Custom license', compatibility: 'Requires Python', metadata: { author: 'Team', version: '1.0' } })
    assert.equal(JSON.stringify(skills).includes('First body'), false)
    registerSkillProvider(ctx, { id: 'agent-plugins-core', skills } as CompatPlugin, temp.path)
    assert.equal((await ctx.listSkills())[0].description, skills[0].description)
    await skill(temp.path, 'demo', attributes, 'Changed on demand\r\n')
    assert.equal((await ctx.getSkill('demo'))?.content, 'Changed on demand\r\n')
    noErrors(collector)
  } finally { await ctx.dispose(); await temp.cleanup() }
})
