import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { registerHooks } from '../../src/runtime/adapters/hooks.js'
import { mountMcpServers } from '../../src/runtime/adapters/mcp.js'
import { buildPluginEnvironment } from '../../src/runtime/environment.js'
import { resolveRuntimeValue } from '../../src/runtime/value.js'
import type { CompatHook } from '../../src/types/hook.js'
import type { CompatMcpServer } from '../../src/types/mcp.js'
import type { CompatDeferredJsonValue, CompatRuntimeValue } from '../../src/types/path.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { FakeContext, createTestSession, fakeRuntimeDependencies, recordedPluginData } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

const literal = (value: string): CompatRuntimeValue => ({ type: 'template', parts: [{ type: 'text', value }] })
const deferred = (pointer: string): CompatDeferredJsonValue => ({
  type: 'deferred-json', file: 'mcp.json', pointer, sensitive: true,
})
function plugin(mcpServers: CompatMcpServer[] = [], hooks: CompatHook[] = []): CompatPlugin {
  return {
    id: 'independent-runtime', name: 'independent-runtime', sourceId: 'fixture', sourcePluginId: 'fixture',
    formats: [], skills: [], mcpServers, hooks, agents: [], commands: [], diagnostics: [], manifestFiles: [],
  }
}

const sourceFormats = ['claude-code', 'codex', 'agent-plugins', 'removed-protocol']

test('contained MCP profile has identical opaque values and real-root containment for every source label', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'package')
    const data = resolve(temp.path, 'data')
    await mkdir(resolve(root, 'bin'), { recursive: true })
    await writeFile(resolve(root, 'bin/server'), 'fixture only')
    await writeFile(resolve(root, 'mcp.json'), JSON.stringify({
      command: './bin/server', args: ['${PLUGIN_ROOT}/bin', '${TOKEN:-literal}', '${CLAUDE_PLUGIN_ROOT}'],
      token: 'private-literal', root: '${PLUGIN_ROOT}', url: 'https://example.com/${TOKEN}',
      escapingCommand: '../outside',
    }))
    let expected: unknown
    for (const sourceFormat of sourceFormats) {
      const ctx = FakeContext.create()
      ctx.credentials.resolve = async () => { assert.fail('contained values must not resolve credentials') }
      try {
        const base = {
          sourceFormat, sourceFile: 'mcp.json', executionProfile: { mode: 'contained' as const },
          environmentBindings: { PLUGIN_ROOT: 'plugin-root' as const, PLUGIN_DATA: 'plugin-data' as const, BOUND_WORKSPACE: 'workspace-root' as const },
        }
        const pathValue = (pointer: string): CompatDeferredJsonValue => ({
          ...deferred(pointer), expansion: 'exact-plugin-vars',
          templateBindings: { PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data' },
        })
        const servers: CompatMcpServer[] = [{
          ...base, serverName: 'local', transport: 'stdio', command: { ...deferred('/command'), expansion: 'none' },
          args: [pathValue('/args/0'), pathValue('/args/1'), pathValue('/args/2')],
          env: { TOKEN: { ...deferred('/token'), expansion: 'none' }, ROOT: pathValue('/root') },
        }, {
          ...base, serverName: 'remote', transport: 'streamable-http', url: { ...deferred('/url'), expansion: 'none' }, headers: {},
        }, {
          ...base, serverName: 'escaped', transport: 'stdio', command: { ...deferred('/escapingCommand'), expansion: 'none' }, args: [], env: {},
        }]
        const mounted = await mountMcpServers(ctx, plugin(servers), root, data, temp.path, fakeRuntimeDependencies(ctx.shared))
        assert.deepEqual(mounted.health.map(item => item.status), ['running', 'running', 'failed'])
        const configs = [...ctx.shared.mcpConfigs.values()]
        if (expected === undefined) expected = configs
        else assert.deepEqual(configs, expected)
        const rootReal = await realpath(root)
        const local = ctx.shared.mcpConfigs.get('local')!
        assert.equal(local.command, resolve(rootReal, 'bin/server'))
        assert.equal(local.cwd, rootReal)
        assert.deepEqual(local.args, [`${rootReal}/bin`, '${TOKEN:-literal}', '${CLAUDE_PLUGIN_ROOT}'])
        assert.deepEqual(local.env, {
          BOUND_WORKSPACE: temp.path, TOKEN: 'private-literal', ROOT: rootReal,
          PLUGIN_ROOT: rootReal, PLUGIN_DATA: await realpath(data),
        })
        assert.equal(local.failOnStartupError, true)
        assert.equal(ctx.shared.mcpConfigs.get('remote')?.url, 'https://example.com/${TOKEN}')
        for (const fiber of mounted.fibers) await fiber.dispose()
        assert.equal(ctx.shared.mcpConfigs.size, 0)
      } finally { await ctx.dispose() }
    }
  } finally { await temp.cleanup() }
})

test('standard MCP profile preserves explicit environment and header/token precedence independently of source format', async () => {
  const temp = await temporaryDirectory()
  try {
    const packageRoot = resolve(temp.path, 'package')
    const sourceRoot = resolve(temp.path, 'source')
    await mkdir(packageRoot)
    await mkdir(sourceRoot)
    await writeFile(resolve(sourceRoot, 'inline.json'), JSON.stringify({ token: 'source-private-token' }))
    let expected: unknown
    for (const sourceFormat of sourceFormats) {
      const ctx = FakeContext.create()
      try {
        const base = {
          sourceFormat, sourceFile: 'inline.json', executionProfile: { mode: 'standard' as const },
          environmentBindings: { CUSTOM_ROOT: 'plugin-root' as const, CUSTOM_DATA: 'plugin-data' as const },
        }
        const servers: CompatMcpServer[] = [{
          ...base, transport: 'stdio', serverName: 'local', command: literal('command with spaces'), args: [],
          env: { CUSTOM_ROOT: literal('configured-root') },
        }, {
          ...base, transport: 'streamable-http', serverName: 'remote', url: literal('https://example.com/mcp'),
          headers: { AUTHORIZATION: literal('static'), 'X-Tenant': literal('static-tenant'), 'X-Keep': literal('keep') },
          envHeaders: { authorization: literal('environment'), 'x-tenant': literal('environment-tenant'), 'x-keep': literal('') },
          bearerToken: { type: 'deferred-json', file: 'inline.json', pointer: '/token', base: 'source', sensitive: true },
        }]
        const mounted = await mountMcpServers(ctx, plugin(servers), packageRoot, '/data', '/workspace', fakeRuntimeDependencies(ctx.shared), sourceRoot)
        assert.deepEqual(mounted.health.map(item => item.status), ['running', 'running'])
        const configs = [...ctx.shared.mcpConfigs.values()]
        if (expected === undefined) expected = configs
        else assert.deepEqual(configs, expected)
        assert.deepEqual(ctx.shared.mcpConfigs.get('local')?.env, { CUSTOM_ROOT: 'configured-root', CUSTOM_DATA: '/data' })
        assert.deepEqual(ctx.shared.mcpConfigs.get('remote')?.headers, {
          authorization: 'Bearer source-private-token', 'x-tenant': 'environment-tenant', 'x-keep': 'keep',
        })
      } finally { await ctx.dispose() }
    }
  } finally { await temp.cleanup() }
})

test('Hook matching, timeout and environment follow the neutral profile while dialect remains metadata', async () => {
  for (const dialect of sourceFormats) {
    const ctx = FakeContext.create()
    try {
      const hook: CompatHook = {
        id: 'neutral-hook', sourceFile: 'hooks.json', dialect,
        event: 'pre-tool-use', dshEvent: 'tools/pre-execute', matcher: 'Read,Write|Bash',
        runtime: {
          wireEventName: 'PreToolUse', matcherSyntax: 'exact', matcherSeparator: 'pipe', defaultTimeoutSec: 7,
          trailingNewline: true, plainStdoutAsContext: false,
          environmentBindings: { ROOT: 'plugin-root', WORK: 'workspace-root' },
          missingTranscriptPath: 'empty-string', includeModelPermissionFields: false, includeTurnId: false,
          toolInputShape: 'raw', honorPreToolAsk: true, includeNullLastAssistantMessage: false,
        },
        commands: [{ command: literal('allow:neutral') }],
      }
      await registerHooks(ctx, plugin([], [hook]), '/plugin', '/data', fakeRuntimeDependencies(ctx.shared), { workspaceRoot: '/workspace' })
      const agent = { session: createTestSession('/workspace', 'session') }
      for (const name of ['Read', 'Read,Write', 'Bash', 'Read,WriteSuffix']) {
        await ctx.intercept('tools/pre-execute', [{ name, arguments: {}, agent, signal: new AbortController().signal }], async () => ({ kind: 'allow' }))
      }
      assert.equal(ctx.shared.hookRuns.length, 2)
      assert.deepEqual(ctx.shared.hookRuns.map(run => (run.options.payload as any).tool_name), ['Read,Write', 'Bash'])
      for (const run of ctx.shared.hookRuns) {
        assert.equal(run.options.defaultTimeoutMs, 7_000)
        assert.deepEqual(run.options.env, { ROOT: '/plugin', WORK: '/workspace' })
      }
      const invoked = recordedPluginData(agent.session, 'plugin:plugin-bridge/hook-invoked')
      assert.equal(invoked.length, 2)
      assert(invoked.every(record => record.dialect === dialect))
    } finally { await ctx.dispose() }
  }
})

test('exact-plugin-vars expands only explicit bindings and leaves unbound paths literal', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, 'mcp.json'), JSON.stringify({ value: '${PLUGIN_ROOT}/${PLUGIN_DATA}/${TOKEN:-literal}' }))
    ctx.credentials.resolve = async () => { assert.fail('exact plugin vars must not resolve credentials') }
    assert.equal(await resolveRuntimeValue(ctx, { ...deferred('/value'), expansion: 'exact-plugin-vars',
      templateBindings: { PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data' } }, temp.path, '/data', '/workspace'),
      `${temp.path}//data/\${TOKEN:-literal}`)
    assert.equal(await resolveRuntimeValue(ctx, { ...deferred('/value'), expansion: 'exact-plugin-vars', templateBindings: {} }, temp.path, '/data', '/workspace'),
      '${PLUGIN_ROOT}/${PLUGIN_DATA}/${TOKEN:-literal}')
    assert.deepEqual(buildPluginEnvironment({ A: 'plugin-root', B: 'plugin-data', C: 'workspace-root' }, '/root', '/data', '/workspace'),
      { A: '/root', B: '/data', C: '/workspace' })
    assert.deepEqual(buildPluginEnvironment({}, '/root', '/data', '/workspace'), {})
    assert.deepEqual(buildPluginEnvironment(undefined, '/root', '/data', '/workspace'), {})
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('runtime and adapter execution graph has no parser or concrete protocol dependency', async () => {
  const queue = [
    'src/runtime/plugin.ts', 'src/shared/mcp-execution.ts', 'src/runtime/value.ts', 'src/runtime/environment.ts',
    'src/runtime/hook-executor.ts', 'src/runtime/hook-session.ts',
    'src/runtime/adapters/mcp.ts', 'src/runtime/adapters/hooks.ts', 'src/runtime/adapters/skills.ts',
  ].map(file => resolve(file))
  const visited = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    assert.doesNotMatch(file, /[/\\]src[/\\](?:parser|protocols)[/\\]/, `execution graph depends on ${file}`)
    const text = await readFile(file, 'utf8')
    const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bexport\s*\*\s*from\s*)['"]([^'"]+)['"]/g
    for (const match of text.matchAll(imports)) {
      if (match[1].startsWith('.')) queue.push(resolve(dirname(file), match[1].replace(/\.js$/, '.ts')))
    }
  }
  assert(visited.has(resolve('src/shared/contained-path.ts')))
  assert(visited.has(resolve('src/shared/mcp-execution.ts')))
  assert(visited.has(resolve('src/shared/template.ts')))
  assert(visited.has(resolve('src/shared/frontmatter.ts')))
})
