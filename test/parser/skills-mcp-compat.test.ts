import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { registerSkillProvider } from '../../src/runtime/adapters/skills.js'
import { mountMcpServers } from '../../src/runtime/adapters/mcp.js'
import type { HarnessDescriptor } from '../../src/types/protocol.js'
import { parseMcpForHarness as parseClaudeMcp } from '../../src/protocols/claude-code/mcp.js'
import { parseMcpForHarness as parseCodexMcp } from '../../src/protocols/codex/mcp.js'
import { parseSkillsForHarness as parseClaudeSkills } from '../../src/protocols/claude-code/skills.js'
import { parseSkillsForHarness as parseCodexSkills } from '../../src/protocols/codex/skills.js'
import { DiagnosticCollector } from '../../src/shared/diagnostics.js'
import { parseFrontmatter } from '../../src/shared/frontmatter.js'
import { parsePotentialSecretValue, parseTemplate } from '../../src/protocols/claude-code/template.js'
import { resolveRuntimeValue, resolveTemplate } from '../../src/runtime/value.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

function harness(format: 'codex' | 'claude-code'): HarnessDescriptor {
  return { format, manifest: {}, skillPaths: [], commandPaths: [], agentPaths: [],
    defaultCapabilityPaths: { skills: true, commands: false, agents: false }, hookSources: [], mcpSources: [{ file: '.mcp.json' }] }
}

async function skill(root: string, attributes: string, body = 'Skill body\r\n', sidecar?: string): Promise<void> {
  await mkdir(resolve(root, 'skills/demo/agents'), { recursive: true })
  await writeFile(resolve(root, 'skills/demo/SKILL.md'), `---\nname: demo\ndescription: Demo skill\n${attributes}\n---\n${body}`)
  if (sidecar !== undefined) await writeFile(resolve(root, 'skills/demo/agents/openai.yaml'), sidecar)
}

function plugin(parts: Partial<CompatPlugin>): CompatPlugin {
  return { id: 'compat-regression', skills: [], mcpServers: [], ...parts } as CompatPlugin
}

test('Codex allow_implicit_invocation false survives sidecar parsing and Provider metadata without eager body loading', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await skill(temp.path, '', 'First body\r\n', 'policy:\n  allow_implicit_invocation: false # manual only\ninterface:\n  display_name: "Demo UI"\n  brand_color: "#123ABC"\n')
    const diagnostics = new DiagnosticCollector()
    const skills = await parseCodexSkills(temp.path, harness('codex'), diagnostics)
    assert.equal(skills[0].invocation.modelInvocable, false)
    assert.equal(skills[0].invocation.userInvocable, true)
    assert.equal(diagnostics.items.some(item => item.level === 'error'), false)
    assert(diagnostics.items.some(item => item.code === 'SKILL_INTERFACE_UNSUPPORTED'))
    registerSkillProvider(ctx, plugin({ skills }), temp.path)
    assert.equal((await ctx.listSkills())[0].invocation.modelInvocable, false)
    await skill(temp.path, '', 'Changed on demand\r\n')
    assert.equal((await ctx.getSkill('demo'))?.content, 'Changed on demand\r\n')
    assert.equal(JSON.stringify(skills).includes('First body'), false)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('Codex products and dependency restrictions are valid metadata with explicit unsupported execution errors', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await skill(temp.path, '', 'Body', 'policy:\n  products: [codex]\ndependencies:\n  tools:\n    - type: "mcp"\n      value: "github"\n      transport: "streamable_http"\n      url: "https://example.com/mcp"\n')
    const diagnostics = new DiagnosticCollector()
    const skills = await parseCodexSkills(temp.path, harness('codex'), diagnostics)
    assert(diagnostics.items.some(item => item.code === 'SKILL_PRODUCT_POLICY_UNSUPPORTED' && item.level === 'error'))
    assert(diagnostics.items.some(item => item.code === 'SKILL_DEPENDENCIES_UNSUPPORTED' && item.level === 'error'))
    assert.equal(diagnostics.items.some(item => item.code === 'SKILL_CODEX_CONFIG_FIELD_INVALID'), false)
    assert.throws(() => registerSkillProvider(ctx, plugin({ skills }), temp.path), /运行语义尚未适配/)
    assert.equal(ctx.shared.providers.size, 0)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('duplicate Codex policy keys and unknown product enums cannot silently enable a skill', async () => {
  const temp = await temporaryDirectory()
  try {
    await skill(temp.path, '', 'Body', 'policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true\n')
    const duplicate = new DiagnosticCollector()
    const skills = await parseCodexSkills(temp.path, harness('codex'), duplicate)
    assert(duplicate.items.some(item => item.code === 'SKILL_CODEX_CONFIG_INVALID' && item.level === 'error'))
    assert(skills[0].runtimeUnsupported?.includes('agents/openai.yaml'))
    await skill(temp.path, '', 'Body', 'policy:\n  products: [unknown-product]\n')
    const invalid = new DiagnosticCollector()
    await parseCodexSkills(temp.path, harness('codex'), invalid)
    assert(invalid.items.some(item => item.code === 'SKILL_CODEX_CONFIG_FIELD_INVALID' && item.details?.field === 'policy.products'))
    assert.equal(invalid.items.some(item => item.code === 'SKILL_PRODUCT_POLICY_UNSUPPORTED'), false)
  } finally { await temp.cleanup() }
})

test('Claude when_to_use and permissive boolean fields do not change unrelated YAML scalars or Codex policy types', async () => {
  const temp = await temporaryDirectory()
  try {
    for (const [disable, user, modelExpected, userExpected] of [
      ['YES', 'off', false, false], ['on', '0', false, false], ['1', 'no', false, false],
      ['NO', 'yes', true, true], ['off', 'ON', true, true], ['0', '1', true, true],
    ] as const) {
      await skill(temp.path, `when_to_use: Review changes\ndisable-model-invocation: ${disable}\nuser-invocable: ${user}\nmetadata:\n  switch: on`)
      const diagnostics = new DiagnosticCollector()
      const skills = await parseClaudeSkills(temp.path, harness('claude-code'), diagnostics)
      assert.equal(skills[0].whenToUse, 'Review changes')
      assert.deepEqual(skills[0].invocation, { modelInvocable: modelExpected, userInvocable: userExpected })
      assert.equal(diagnostics.items.some(item => item.level === 'error'), false)
    }
    assert.equal((parseFrontmatter('---\nmetadata:\n  switch: on\n---\n').attributes.metadata as { switch: unknown }).switch, 'on')
    await skill(temp.path, '', 'Body', 'policy:\n  allow_implicit_invocation: no\n')
    const diagnostics = new DiagnosticCollector()
    await parseCodexSkills(temp.path, harness('codex'), diagnostics)
    assert(diagnostics.items.some(item => item.code === 'SKILL_CODEX_CONFIG_FIELD_INVALID' && item.level === 'error'))
  } finally { await temp.cleanup() }
})

test('valid Claude execution directives and dynamic bodies cannot be registered as unrestricted plain skills', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await skill(temp.path, 'model: opus\neffort: high\ncontext: fork\nagent: Explore\nbackground: no\nhooks: {Stop: []}\npaths: ["src/**"]\nshell: bash\nallowed-tools: Read Grep\ndisallowed-tools: [Write]\narguments: [issue]', '!`git status`\nReview $ARGUMENTS and $issue\n${CLAUDE_SKILL_DIR}\n')
    const diagnostics = new DiagnosticCollector()
    const skills = await parseClaudeSkills(temp.path, harness('claude-code'), diagnostics)
    for (const field of ['model', 'effort', 'context:fork', 'agent', 'background', 'hooks', 'paths', 'shell', 'allowed-tools', 'disallowed-tools', 'arguments', 'dynamic-shell-content', 'content-substitution']) {
      assert(diagnostics.items.some(item => item.code === 'SKILL_EXECUTION_UNSUPPORTED' && item.details?.field === field && item.level === 'error'), field)
    }
    assert.equal(diagnostics.items.some(item => item.code === 'SKILL_FIELD_INVALID'), false)
    assert.throws(() => registerSkillProvider(ctx, plugin({ skills }), temp.path), /尚未适配/)
    assert.equal(ctx.shared.providers.size, 0)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('invalid Claude field values and DSH name limits have distinct diagnostics', async () => {
  const temp = await temporaryDirectory()
  try {
    await skill(temp.path, 'disable-model-invocation: perhaps\neffort: extreme\ncontext: sideways\npaths: 42')
    const invalid = new DiagnosticCollector()
    await parseClaudeSkills(temp.path, harness('claude-code'), invalid)
    assert.equal(invalid.items.filter(item => item.code === 'SKILL_FIELD_INVALID').length, 4)
    assert.equal(invalid.items.some(item => item.code === 'SKILL_EXECUTION_UNSUPPORTED'), false)
    await writeFile(resolve(temp.path, 'skills/demo/SKILL.md'), '---\nname: Upstream_Name\ndescription: Valid upstream string\n---\nBody')
    for (const format of ['claude-code', 'codex'] as const) {
      const diagnostics = new DiagnosticCollector()
      const parseFixtureSkills: typeof parseClaudeSkills = format === 'claude-code' ? parseClaudeSkills : parseCodexSkills
      assert.equal((await parseFixtureSkills(temp.path, harness(format), diagnostics)).length, 0)
      assert(diagnostics.items.some(item => item.code === 'SKILL_NAME_DSH_UNSUPPORTED'))
      assert.equal(diagnostics.items.some(item => item.code === 'SKILL_NAME_INVALID'), false)
    }
  } finally { await temp.cleanup() }
})

test('Codex header maps remain deferred, merge case-insensitively, retain static fallback, and apply bearer last', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { url: 'https://example.com/mcp',
        http_headers: { 'X-Key': 'static-sensitive', 'X-Keep': 'static-fallback', Authorization: 'literal-secret', constructor: 'header-constructor', ['__proto__']: 'header-prototype' },
        env_http_headers: { 'x-key': 'COMPAT_HEADER_KEY', 'X-Keep': 'COMPAT_HEADER_EMPTY', authorization: 'COMPAT_HEADER_AUTH' },
        bearer_token_env_var: 'COMPAT_BEARER_TOKEN' },
    } }))
    ctx.setCredential('COMPAT_HEADER_KEY', 'resolved-header')
    ctx.setCredential('COMPAT_HEADER_EMPTY', '   ')
    ctx.setCredential('COMPAT_HEADER_AUTH', 'Basic env-secret')
    ctx.setCredential('COMPAT_BEARER_TOKEN', 'bearer-secret')
    const diagnostics = new DiagnosticCollector()
    const mcpServers = await parseCodexMcp(temp.path, harness('codex'), diagnostics)
    assert.equal(diagnostics.items.some(item => item.level === 'error'), false)
    const serialized = JSON.stringify(mcpServers)
    for (const secret of ['static-sensitive', 'static-fallback', 'literal-secret', 'resolved-header', 'bearer-secret']) assert.equal(serialized.includes(secret), false)
    assert(serialized.includes('COMPAT_HEADER_KEY'))
    const mounted = await mountMcpServers(ctx, plugin({ mcpServers }), temp.path, temp.path, temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.equal(mounted.health[0].status, 'running')
    assert.deepEqual(ctx.shared.mcpConfigs.get('remote')?.headers, { ['__proto__']: 'header-prototype', authorization: 'Bearer bearer-secret', constructor: 'header-constructor', 'x-keep': 'static-fallback', 'x-key': 'resolved-header' })
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('Claude header and env templates resolve credentials and fallback without persisting sensitive defaults', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${COMPAT_DEFAULT_TOKEN:-fallback-sensitive}' } },
      local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: '${COMPAT_DEFAULT_TOKEN:-fallback-sensitive}' } },
    } }))
    const diagnostics = new DiagnosticCollector()
    const mcpServers = await parseClaudeMcp(temp.path, harness('claude-code'), diagnostics)
    assert.equal(diagnostics.items.some(item => item.level === 'error'), false)
    assert.equal(JSON.stringify(mcpServers).includes('fallback-sensitive'), false)
    assert.equal(JSON.stringify(mcpServers).includes('Bearer '), false)
    await mountMcpServers(ctx, plugin({ mcpServers }), temp.path, temp.path, temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.equal((ctx.shared.mcpConfigs.get('remote')?.headers as Record<string, string>).authorization, 'Bearer fallback-sensitive')
    assert.equal((ctx.shared.mcpConfigs.get('local')?.env as Record<string, string>).TOKEN, 'fallback-sensitive')
    ctx.setCredential('COMPAT_DEFAULT_TOKEN', 'credential-value')
    assert.equal(await resolveRuntimeValue(ctx, parsePotentialSecretValue('${COMPAT_DEFAULT_TOKEN:-fallback-sensitive}', '.mcp.json', '/mcpServers/local/env/TOKEN'), temp.path, temp.path, temp.path), 'credential-value')
    assert.deepEqual(parseTemplate('${COMPAT_UNUSED_TOKEN:-}').parts, [{ type: 'env', name: 'COMPAT_UNUSED_TOKEN', fallback: '' }])
    assert.equal(await resolveTemplate(ctx, parseTemplate('${COMPAT_UNUSED_TOKEN:-}'), temp.path, temp.path, temp.path), '')
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('unadapted MCP permissions, OAuth, and helpers block mounting instead of widening access', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    for (const [format, fields] of [
      ['codex', { enabled_tools: ['read'], disabled_tools: ['delete'], required: true, auth: 'oauth', oauth: { client_secret: 'oauth-sensitive' }, http_headers_helper: 'echo sensitive' }],
      ['claude-code', { headersHelper: 'echo sensitive', oauth: { clientId: 'sensitive' }, toolPermissions: ['read'] }],
    ] as const) {
      await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: { denied: { url: 'https://example.com', ...fields } } }))
      const diagnostics = new DiagnosticCollector()
      const parseFixtureMcp: typeof parseClaudeMcp = format === 'claude-code' ? parseClaudeMcp : parseCodexMcp
      const mcpServers = await parseFixtureMcp(temp.path, harness(format), diagnostics)
      assert(diagnostics.items.some(item => item.level === 'error'))
      assert.equal(JSON.stringify({ mcpServers, diagnostics: diagnostics.items }).includes('oauth-sensitive'), false)
      const mounted = await mountMcpServers(ctx, plugin({ mcpServers }), temp.path, temp.path, temp.path, fakeRuntimeDependencies(ctx.shared))
      assert.equal(mounted.health[0].status, 'failed')
      assert.equal(ctx.shared.mcpConfigs.size, 0)
    }
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('MCP rejects cross-platform authentication fields, malformed Header maps, unknown user_config and unsupported transports', async () => {
  const temp = await temporaryDirectory()
  try {
    for (const [format, config, code] of [
      ['codex', { url: 'https://example.com', headers: { Authorization: 'secret' } }, 'MCP_PLATFORM_FIELD_UNSUPPORTED'],
      ['claude-code', { type: 'http', url: 'https://example.com', http_headers: { Authorization: 'secret' } }, 'MCP_PLATFORM_FIELD_UNSUPPORTED'],
      ['claude-code', { type: 'http', url: 'https://example.com', headers: { Authorization: 42 } }, 'MCP_MAP_INVALID'],
      ['claude-code', { command: 'node', args: ['${user_config.token}'] }, 'MCP_TEMPLATE_UNSUPPORTED'],
      ['claude-code', { type: 'sse', url: 'https://example.com' }, 'MCP_TRANSPORT_UNSUPPORTED'],
      ['claude-code', { type: 'ws', url: 'https://example.com' }, 'MCP_TRANSPORT_UNSUPPORTED'],
    ] as const) {
      await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: { demo: config } }))
      const diagnostics = new DiagnosticCollector()
      const parseFixtureMcp: typeof parseClaudeMcp = format === 'claude-code' ? parseClaudeMcp : parseCodexMcp
      await parseFixtureMcp(temp.path, harness(format), diagnostics)
      assert(diagnostics.items.some(item => item.code === code && item.level === 'error'), code)
    }
    const descriptor = harness('claude-code')
    descriptor.mcpSources = [{ file: 'https://example.com/server.mcpb' }, { file: './server.dxt' }]
    const diagnostics = new DiagnosticCollector()
    assert.deepEqual(await parseClaudeMcp(temp.path, descriptor, diagnostics), [])
    assert.equal(diagnostics.items.filter(item => item.code === 'MCP_BUNDLE_UNSUPPORTED').length, 2)
  } finally { await temp.cleanup() }
})

test('deferred fallback results join sensitive redaction values and unsupported references never pass through at runtime', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ token: 'Bearer ${COMPAT_FALLBACK_ONLY:-secret-default}', invalid: '${user_config.secret}' }))
    const refs = new Set<string>()
    const value = parsePotentialSecretValue('Bearer ${COMPAT_FALLBACK_ONLY:-secret-default}', '.mcp.json', '/token')
    assert.equal(JSON.stringify(value).includes('secret-default'), false)
    assert.equal(await resolveRuntimeValue(ctx, value, temp.path, temp.path, temp.path, refs), 'Bearer secret-default')
    assert(refs.has('secret-default'))
    assert(refs.has('Bearer secret-default'))
    await assert.rejects(resolveRuntimeValue(ctx, { type: 'deferred-json', file: '.mcp.json', pointer: '/invalid', templateSyntax: 'environment', templateBindings: {} }, temp.path, temp.path, temp.path), /模板引用语法尚未适配/)
  } finally { await ctx.dispose(); await temp.cleanup() }
})
