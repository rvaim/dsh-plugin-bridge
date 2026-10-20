import assert from 'node:assert/strict'
import { mkdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { mountMcpServers } from '../../src/runtime/adapters/mcp.js'
import { parseAgentPluginMcp } from '../../src/protocols/agent-plugins/mcp.js'
import { DiagnosticCollector } from '../../src/shared/diagnostics.js'
import {
  buildProcessEnvironment, expandPluginPaths, isReservedPathEnvironmentName,
  validateExecutableToken, validateProcessEnvironment, validateHttpHeaders, validateEndpointUrl,
} from '../../src/shared/mcp-execution.js'
import { resolveRuntimeValue } from '../../src/runtime/value.js'
import type { CompatMcpServer } from '../../src/types/mcp.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

const schema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const pathBindings = { PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data' } as const

async function configure(root: string, mcpServers: Record<string, unknown>): Promise<void> {
  await writeFile(resolve(root, 'mcp.json'), JSON.stringify({ $schema: schema, mcpServers }))
}

function plugin(mcpServers: CompatMcpServer[]): CompatPlugin {
  return { id: 'portable-mcp-test', mcpServers, skills: [] } as unknown as CompatPlugin
}

function noErrors(collector: DiagnosticCollector): void {
  assert.equal(collector.items.some(item => item.level === 'error'), false)
}

test('AP MCP discovers only mcp.json and isolates invalid JSON, closed envelopes, versions and wrong-kind locations', async () => {
  const temp = await temporaryDirectory()
  try {
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({ mcpServers: { legacy: { command: 'node' } } }))
    const missing = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginMcp(temp.path, missing), [])
    assert.deepEqual(missing.items, [])
    for (const raw of [
      '{', 'null', '[]', '{}', JSON.stringify({ mcpServers: {} }),
      JSON.stringify({ $schema: schema.replace('1.0.0', '2.0.0'), mcpServers: {} }),
      JSON.stringify({ $schema: schema, mcpServers: [], extra: true }),
      JSON.stringify({ $schema: schema, mcpServers: { valid: { type: 'stdio', command: 'node' } }, unknown: true }),
    ]) {
      await writeFile(resolve(temp.path, 'mcp.json'), raw)
      const collector = new DiagnosticCollector()
      assert.deepEqual(await parseAgentPluginMcp(temp.path, collector), [])
      assert.equal(collector.items.length, 1)
      assert.equal(collector.items[0].level, 'warning')
    }
    await configure(temp.path, {})
    const empty = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginMcp(temp.path, empty), [])
    assert.deepEqual(empty.items, [])
    await unlink(resolve(temp.path, 'mcp.json'))
    await mkdir(resolve(temp.path, 'mcp.json'))
    const wrongKind = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginMcp(temp.path, wrongKind), [])
    assert(wrongKind.items.some(item => item.code === 'AGENT_PLUGINS_MCP_LOCATION_INVALID'))
    noErrors(wrongKind)
  } finally { await temp.cleanup() }
})

test('AP MCP validates each closed transport independently and skips legal unsupported SSE with warnings', async () => {
  const temp = await temporaryDirectory()
  try {
    await configure(temp.path, {
      absentType: { command: 'node' }, inferredHttp: { url: 'https://example.com/mcp' },
      nativeHttp: { type: 'http', url: 'https://example.com/mcp' },
      crossFields: { type: 'stdio', command: 'node', url: 'https://example.com/mcp' },
      unknownField: { type: 'stdio', command: 'node', oauth: {} },
      remoteEnv: { type: 'streamable-http', url: 'https://example.com/mcp', env: {} },
      argsWrongType: { type: 'stdio', command: 'node', args: [42] },
      envWrongType: { type: 'stdio', command: 'node', env: { TOKEN: 42 } },
      reservedRoot: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'override' } },
      reservedData: { type: 'stdio', command: 'node', env: { PLUGIN_DATA: 'override' } },
      nonObject: null,
      sse: { type: 'sse', url: 'https://example.com/sse' },
      local: { type: 'stdio', command: 'node' },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
    })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(temp.path, collector)
    assert.deepEqual(servers.map(server => server.serverName), ['local', 'remote'])
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGINS_MCP_SERVER_INVALID').length, 11)
    assert(collector.items.some(item => item.code === 'AGENT_PLUGINS_MCP_TRANSPORT_UNSUPPORTED' && item.level === 'warning'))
    assert(servers.every(server => server.sourceFormat === 'agent-plugins'))
    for (const server of servers) assert.deepEqual(server.environmentBindings, pathBindings)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('AP MCP rejects shell commands and escaping command/cwd paths while preserving actual in-package symlinks', async () => {
  const temp = await temporaryDirectory()
  const outside = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, 'bin'))
    await mkdir(resolve(temp.path, 'work'))
    await writeFile(resolve(temp.path, 'bin/server'), 'fixture only; never executed')
    await writeFile(resolve(outside.path, 'server'), 'outside fixture; never executed')
    await symlink(resolve(temp.path, 'bin/server'), resolve(temp.path, 'internal'))
    await symlink(resolve(outside.path, 'server'), resolve(temp.path, 'escaped'))
    await symlink(outside.path, resolve(temp.path, 'escaped-cwd'))
    await configure(temp.path, {
      shell: { type: 'stdio', command: 'node server.js' },
      shellPipe: { type: 'stdio', command: 'node|sh' },
      absolute: { type: 'stdio', command: resolve(temp.path, 'bin/server') },
      relative: { type: 'stdio', command: '../server' },
      missing: { type: 'stdio', command: './missing' },
      directory: { type: 'stdio', command: './bin' },
      escape: { type: 'stdio', command: './escaped' },
      cwdEscape: { type: 'stdio', command: 'node', cwd: './escaped-cwd' },
      cwdRelative: { type: 'stdio', command: 'node', cwd: 'work' },
      cwdParent: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../outside' },
      dataParent: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/../outside' },
      bundled: { type: 'stdio', command: './internal', cwd: './work' },
      rootCwd: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}' },
      dataCwd: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' },
    })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(temp.path, collector)
    assert.deepEqual(servers.map(server => server.serverName), ['dataParent', 'bundled', 'rootCwd', 'dataCwd'])
    assert.equal(servers.find(server => server.serverName === 'bundled')?.transport, 'stdio')
    const bundled = servers.find(server => server.serverName === 'bundled')!
    const dataCwd = servers.find(server => server.serverName === 'dataCwd')!
    assert.equal(bundled.transport === 'stdio' && bundled.commandBase, 'plugin')
    assert.equal(dataCwd.transport === 'stdio' && dataCwd.cwd?.type, 'data')
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGINS_MCP_STDIO_INVALID').length, 9)
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGINS_MCP_SERVER_INVALID').length, 1)
    noErrors(collector)
    await unlink(resolve(temp.path, 'mcp.json'))
    await symlink(resolve(outside.path, 'server'), resolve(temp.path, 'mcp.json'))
    const escapedFile = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginMcp(temp.path, escapedFile), [])
    assert(escapedFile.items.some(item => item.code === 'AGENT_PLUGINS_MCP_LOCATION_INVALID'))
  } finally { await temp.cleanup(); await outside.cleanup() }
})

test('AP cwd containment uses actual expanded roots and permits contained parent roundtrips', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const root = resolve(temp.path, 'acme')
    const data = resolve(temp.path, 'data')
    await mkdir(root)
    await mkdir(data)
    await configure(root, {
      relativeRoundtrip: { type: 'stdio', command: 'node', cwd: './../acme' },
      rootRoundtrip: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../acme' },
      dataRoundtrip: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/../data' },
      dataEscape: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/../../outside' },
    })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(root, collector)
    assert.equal(servers.length, 4)
    const mounted = await mountMcpServers(ctx, plugin(servers), root, data, root, fakeRuntimeDependencies(ctx.shared))
    assert.deepEqual(mounted.health.map(item => item.status), ['running', 'running', 'running', 'failed'])
    assert.equal(ctx.shared.mcpConfigs.get('relativeRoundtrip')?.cwd, await realpath(root))
    assert.equal(ctx.shared.mcpConfigs.get('rootRoundtrip')?.cwd, await realpath(root))
    assert.equal(ctx.shared.mcpConfigs.get('dataRoundtrip')?.cwd, await realpath(data))
    assert.equal(ctx.shared.mcpConfigs.has('dataEscape'), false)
    noErrors(collector)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('AP placeholders replace every exact occurrence once and leave unknown, default and CC variables literal', () => {
  const input = '${PLUGIN_ROOT}|${PLUGIN_DATA}|${TOKEN}|${TOKEN:-default}|${CLAUDE_PLUGIN_ROOT}|${CODEX_PLUGIN_ROOT}|${PLUGIN_ROOT:-fallback}|${TOKEN:-${PLUGIN_ROOT}}'
  const root = '/plugins/${PLUGIN_DATA}/root'
  const data = '/data/${PLUGIN_ROOT}/state'
  assert.equal(expandPluginPaths(input, { PLUGIN_ROOT: root, PLUGIN_DATA: data }), `${root}|${data}|\${TOKEN}|\${TOKEN:-default}|\${CLAUDE_PLUGIN_ROOT}|\${CODEX_PLUGIN_ROOT}|\${PLUGIN_ROOT:-fallback}|\${TOKEN:-${root}}`)
  assert.equal(validateExecutableToken('${TOKEN}'), 'bare')
  assert.equal(validateExecutableToken('node'), 'bare')
})

test('AP env reserved names follow platform semantics and host variables override configured values last', () => {
  assert.equal(isReservedPathEnvironmentName('plugin_root', pathBindings, 'linux'), false)
  assert.equal(isReservedPathEnvironmentName('plugin_root', pathBindings, 'win32'), true)
  assert.equal(isReservedPathEnvironmentName('Plugin_Data', pathBindings, 'win32'), true)
  assert.throws(() => validateProcessEnvironment({ plugin_root: 'bad' }, pathBindings, 'win32'), /保留/)
  assert.throws(() => validateProcessEnvironment({ PLUGIN_DATA: 'bad' }, pathBindings, 'linux'), /保留/)
  assert.doesNotThrow(() => validateProcessEnvironment({ plugin_root: 'literal', PLUGIN_ROOT_EXTRA: 'literal' }, pathBindings, 'linux'))
  assert.deepEqual(buildProcessEnvironment({ PLUGIN_ROOT: 'bad', PLUGIN_DATA: 'bad', OTHER: 'value' }, { PLUGIN_ROOT: '/root', PLUGIN_DATA: '/data' }), { OTHER: 'value', PLUGIN_ROOT: '/root', PLUGIN_DATA: '/data' })
  assert.deepEqual(buildProcessEnvironment({ path: 'configured', other: 'value' }, { PLUGIN_ROOT: 'C:/root', PLUGIN_DATA: 'C:/data' }, 'win32'), { PATH: 'configured', OTHER: 'value', PLUGIN_ROOT: 'C:/root', PLUGIN_DATA: 'C:/data' })
})

test('AP HTTP URL validation permits only absolute HTTPS or literal loopback HTTP and validates header casing', () => {
  for (const url of ['https://example.com/mcp', 'HTTPS://example.com/mcp', 'HTTP://LOCALHOST:1234/mcp', 'https://example.com/${TOKEN}', 'http://localhost:1234/mcp', 'http://127.0.0.1/mcp', 'http://127.255.1.2/mcp', 'http://[::1]/mcp', 'http://[0:0:0:0:0:0:0:1]/mcp']) assert.doesNotThrow(() => validateEndpointUrl(url), url)
  for (const url of ['/mcp', 'ftp://example.com', 'http://example.com', 'http://localhost.evil', 'http://localhost.', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'https://user:pass@example.com', 'https://@example.com', 'https://example.com/#', 'https://example.com/#secret', 'https://example.com/\n']) assert.throws(() => validateEndpointUrl(url), url)
  assert.doesNotThrow(() => validateHttpHeaders({ 'X-Public-Tenant': '${TOKEN}', Accept: 'text/plain\t' }))
  const invalidHeaders: Record<string, string>[] = [{ 'X-Tenant': 'one', 'x-tenant': 'two' }, { 'bad name': 'value' }, { 'X-Tenant': 'bad\nvalue' }, { 'X-Tenant': 'bad\u0001value' }, { 'X-Tenant': '\u4e2d' }]
  for (const headers of invalidHeaders) assert.throws(() => validateHttpHeaders(headers))
})

test('AP parser distinguishes invalid HTTP headers from valid unsupported configured headers and retains headerless entries', async () => {
  const temp = await temporaryDirectory()
  try {
    await configure(temp.path, {
      headersUnsupported: { type: 'streamable-http', url: 'https://example.com', headers: { 'X-Tenant': 'public-visible-value' } },
      duplicate: { type: 'streamable-http', url: 'https://example.com', headers: { 'X-Tenant': 'a', 'x-tenant': 'b' } },
      unsafeUrl: { type: 'streamable-http', url: 'http://remote.example.com' },
      userInfo: { type: 'streamable-http', url: 'https://secret-user:secret-pass@example.com' },
      emptyHeaders: { type: 'streamable-http', url: 'https://example.com/${TOKEN}', headers: {} },
      local: { type: 'stdio', command: 'node' },
    })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(temp.path, collector)
    assert.deepEqual(servers.map(server => server.serverName), ['emptyHeaders', 'local'])
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGINS_MCP_HEADERS_UNSUPPORTED').length, 1)
    assert.equal(collector.items.filter(item => item.code === 'AGENT_PLUGINS_MCP_HTTP_INVALID').length, 3)
    for (const literal of ['public-visible-value', 'secret-user', 'secret-pass']) assert.equal(JSON.stringify({ servers, diagnostics: collector.items }).includes(literal), false)
    noErrors(collector)
  } finally { await temp.cleanup() }
})

test('AP mount captures real roots, default cwd, opaque args/env and literal HTTP without credential expansion or scan secrets', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const root = resolve(temp.path, '${PLUGIN_DATA}', 'package')
    const data = resolve(temp.path, 'persistent-data')
    await mkdir(resolve(root, 'bin'), { recursive: true })
    await writeFile(resolve(root, 'bin/server'), 'fixture; never executed')
    await configure(root, {
      bundled: { type: 'stdio', command: './bin/server', args: ['${PLUGIN_ROOT}/server.js', '${PLUGIN_DATA}/cache', '${TOKEN}', '${TOKEN:-default}', '${CLAUDE_PLUGIN_ROOT}', '../opaque/path', 'argument-private-value'], env: { TOKEN: 'literal-private-value', FROM_ROOT: '${PLUGIN_ROOT}', FROM_DATA: '${PLUGIN_DATA}', UNKNOWN: '${TOKEN:-default}' } },
      dataCwd: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' },
      remote: { type: 'streamable-http', url: 'https://example.com/${TOKEN}', headers: {} },
    })
    let credentialCalls = 0
    ctx.credentials.resolve = async () => { credentialCalls++; throw new Error('AP must not resolve credentials') }
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(root, collector)
    const scan = JSON.stringify({ servers, diagnostics: collector.items })
    for (const value of ['literal-private-value', 'argument-private-value', '${TOKEN:-default}', 'https://example.com/']) assert.equal(scan.includes(value), false)
    const mounted = await mountMcpServers(ctx, plugin(servers), root, data, temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.deepEqual(mounted.health.map(health => health.status), ['running', 'running', 'running'])
    const rootReal = await realpath(root)
    const dataReal = await realpath(data)
    assert((await stat(data)).isDirectory())
    const config = ctx.shared.mcpConfigs.get('bundled')!
    assert.equal(config.command, resolve(rootReal, 'bin/server'))
    assert.equal(config.cwd, rootReal)
    assert.deepEqual(config.args, [`${rootReal}/server.js`, `${dataReal}/cache`, '${TOKEN}', '${TOKEN:-default}', '${CLAUDE_PLUGIN_ROOT}', '../opaque/path', 'argument-private-value'])
    assert.deepEqual(config.env, { TOKEN: 'literal-private-value', FROM_ROOT: rootReal, FROM_DATA: dataReal, UNKNOWN: '${TOKEN:-default}', PLUGIN_ROOT: rootReal, PLUGIN_DATA: dataReal })
    assert.equal(ctx.shared.mcpConfigs.get('dataCwd')?.cwd, dataReal)
    assert.equal(ctx.shared.mcpConfigs.get('remote')?.url, 'https://example.com/${TOKEN}')
    assert.deepEqual(ctx.shared.mcpConfigs.get('remote')?.headers, {})
    assert.equal(credentialCalls, 0)
    noErrors(collector)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('AP deferred none mode preserves literals and explicit exact-plugin-vars expands only bound paths', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, 'mcp.json'), JSON.stringify({ value: '${TOKEN:-secret-fallback}/${PLUGIN_ROOT}/${PLUGIN_DATA}' }))
    ctx.credentials.resolve = async () => { throw new Error('must not resolve credentials') }
    const ref = { type: 'deferred-json', file: 'mcp.json', pointer: '/value', sensitive: true } as const
    assert.equal(await resolveRuntimeValue(ctx, { ...ref, expansion: 'none', templateSyntax: 'environment', templateBindings: pathBindings }, temp.path, '/data', '/workspace'), '${TOKEN:-secret-fallback}/${PLUGIN_ROOT}/${PLUGIN_DATA}')
    assert.equal(await resolveRuntimeValue(ctx, { ...ref, expansion: 'exact-plugin-vars', templateBindings: pathBindings }, temp.path, '/data', '/workspace'), `\${TOKEN:-secret-fallback}/${temp.path}//data`)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('AP runtime rechecks command and cwd symlinks and keeps independent servers running after mount failures', async () => {
  const temp = await temporaryDirectory()
  const outside = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await mkdir(resolve(temp.path, 'bin'))
    await mkdir(resolve(temp.path, 'work'))
    await writeFile(resolve(temp.path, 'bin/server'), 'fixture; never executed')
    await writeFile(resolve(outside.path, 'server'), 'outside; never executed')
    await symlink(resolve(temp.path, 'bin/server'), resolve(temp.path, 'command-link'))
    await symlink(resolve(temp.path, 'work'), resolve(temp.path, 'cwd-link'))
    await configure(temp.path, {
      commandSwap: { type: 'stdio', command: './command-link' },
      cwdSwap: { type: 'stdio', command: 'node', cwd: './cwd-link' },
      startupFail: { type: 'stdio', command: 'fail-mcp' },
      okay: { type: 'stdio', command: 'node' },
    })
    const servers = await parseAgentPluginMcp(temp.path, new DiagnosticCollector())
    assert.equal(servers.length, 4)
    await unlink(resolve(temp.path, 'command-link'))
    await unlink(resolve(temp.path, 'cwd-link'))
    await symlink(resolve(outside.path, 'server'), resolve(temp.path, 'command-link'))
    await symlink(outside.path, resolve(temp.path, 'cwd-link'))
    const mounted = await mountMcpServers(ctx, plugin(servers), temp.path, resolve(temp.path, 'data'), temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.deepEqual(mounted.health.map(health => health.status), ['failed', 'failed', 'failed', 'running'])
    assert.deepEqual([...ctx.shared.mcpConfigs.keys()], ['okay'])
  } finally { await ctx.dispose(); await temp.cleanup(); await outside.cleanup() }
})

test('AP runtime refuses data cwd symlink escapes and configured headers even in injected normalized configs', async () => {
  const temp = await temporaryDirectory()
  const outside = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const data = resolve(temp.path, 'data')
    await mkdir(data)
    await symlink(outside.path, resolve(data, 'escaped'))
    await configure(temp.path, {
      dataEscape: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/escaped' },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      okay: { type: 'stdio', command: 'node' },
    })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(temp.path, collector)
    const remote = servers.find(server => server.serverName === 'remote')!
    assert.equal(remote.transport, 'streamable-http')
    if (remote.transport === 'streamable-http') remote.headers['X-Tenant'] = { type: 'deferred-json', file: 'mcp.json', pointer: '/does-not-exist', expansion: 'none' }
    const mounted = await mountMcpServers(ctx, plugin(servers), temp.path, data, temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.deepEqual(mounted.health.map(health => health.status), ['failed', 'failed', 'running'])
    assert(mounted.health[1].message?.includes('跨 origin'))
    assert.deepEqual([...ctx.shared.mcpConfigs.keys()], ['okay'])
    noErrors(collector)
  } finally { await ctx.dispose(); await temp.cleanup(); await outside.cleanup() }
})

test('AP MCP fixed discovery is case exact and bundled executable filenames remain literal argv tokens', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await writeFile(resolve(temp.path, 'MCP.JSON'), JSON.stringify({ $schema: schema, mcpServers: { caseWrong: { type: 'stdio', command: 'node' } } }))
    const missing = new DiagnosticCollector()
    assert.deepEqual(await parseAgentPluginMcp(temp.path, missing), [])
    assert.deepEqual(missing.items, [])
    await unlink(resolve(temp.path, 'MCP.JSON'))
    await mkdir(resolve(temp.path, 'bin'))
    const command = './bin/server file;${TOKEN}'
    await writeFile(resolve(temp.path, command), 'fixture; never executed')
    await configure(temp.path, { bundled: { type: 'stdio', command } })
    const collector = new DiagnosticCollector()
    const servers = await parseAgentPluginMcp(temp.path, collector)
    assert.equal(servers.length, 1)
    const mounted = await mountMcpServers(ctx, plugin(servers), temp.path, resolve(temp.path, 'data'), temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.equal(mounted.health[0].status, 'running')
    assert.equal(ctx.shared.mcpConfigs.get('bundled')?.command, resolve(await realpath(temp.path), command))
    noErrors(collector)
  } finally { await ctx.dispose(); await temp.cleanup() }
})

test('AP runtime redacts deferred literals from startup failures without preventing the next entry', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    await configure(temp.path, {
      denied: { type: 'stdio', command: 'leak-config', args: ['opaque-argument-private'], env: { TOKEN: 'opaque-env-private', UNKNOWN: '${TOKEN:-opaque-default-private}' } },
      okay: { type: 'stdio', command: 'node' },
    })
    const servers = await parseAgentPluginMcp(temp.path, new DiagnosticCollector())
    const mounted = await mountMcpServers(ctx, plugin(servers), temp.path, resolve(temp.path, 'data'), temp.path, fakeRuntimeDependencies(ctx.shared))
    assert.deepEqual(mounted.health.map(health => health.status), ['failed', 'running'])
    const visible = JSON.stringify({ health: mounted.health, logs: ctx.shared.logs })
    for (const secret of ['opaque-argument-private', 'opaque-env-private', 'opaque-default-private']) assert.equal(visible.includes(secret), false)
  } finally { await ctx.dispose(); await temp.cleanup() }
})
