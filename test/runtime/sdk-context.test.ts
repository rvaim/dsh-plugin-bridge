import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Config as McpConfigSchema, type Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry, type SkillProvider } from '@deepseek-ai/dsh-skill'
import * as bridge from '../../src/index.js'
import { CompatService } from '../../src/service.js'
import { defaultRuntimeDependencies, type RuntimeDependencies } from '../../src/runtime/dependencies.js'
import { createHookSessionReader } from '../../src/runtime/hook-session.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { resolveTemplate } from '../../src/runtime/value.js'
import { CompatLayout } from '../../src/store/layout.js'
import type { CompatRuntimeValue } from '../../src/types/path.js'
import type { CompatPlugin } from '../../src/types/plugin.js'
import { createFakeShell, fakeShellResult } from '../helpers/fake-dsh.js'
import { temporaryDirectory } from '../helpers/temp.js'

const literal = (value: string): CompatRuntimeValue => ({ type: 'template', parts: [{ type: 'text', value }] })

function model(): CompatPlugin {
  return {
    id: 'sdk-contract', name: 'sdk-contract', sourceId: 'sdk-source', sourcePluginId: 'sdk-contract',
    formats: [], diagnostics: [], manifestFiles: [], skills: [], hooks: [], mcpServers: [], commands: [], agents: [],
  }
}

test('公开入口和 Service 在真实 Cordis Context 中挂载并随 Fiber 撤销', async () => {
  const temp = await temporaryDirectory()
  const host = new Context()
  try {
    new SkillRegistry(host)
    host.provide('shell', createFakeShell(async () => fakeShellResult()))
    const fiber = host.plugin(bridge, { harnessHome: temp.path, autoStart: false })
    await fiber
    const service = host.get('pluginBridge')
    assert(service instanceof CompatService)
    assert.equal(typeof service.completeInstallPreparation, 'function')
    assert.equal(typeof service.releaseInstallPreparation, 'function')
    assert.deepEqual(await service.list(), [])
    const admin = host.get('pluginBridgeAdmin')
    assert(admin)
    assert.deepEqual(await admin.list(), { kind: 'ready', plugins: [] })
    await fiber.dispose()
    assert.equal(host.get('pluginBridge'), undefined)
    assert.equal(host.get('pluginBridgeAdmin'), undefined)
  } finally {
    await host.fiber.dispose()
    await temp.cleanup()
  }
})

test('可选服务通过 SDK typed get 读取，未 inject 的直接属性访问仍被 Cordis 拒绝', async () => {
  const host = new Context()
  try {
    new SessionStore(host)
    const session = host.sessions.create(SessionId('sdk-optional'), { meta: { cwd: '/sdk-workspace' } })
    session.append('turn/start', { turn: 4 })
    const projections = await host.plugin({
      name: 'sdk-optional-projections',
      apply(ctx) { new SessionProjectionRegistry(ctx) },
    })
    const credentials: Pick<CredentialProvider, 'resolve'> = {
      async resolve(reference) {
        assert.equal(reference, 'SDK_FIXTURE_TOKEN')
        return { value: 'sdk-resolved-secret', source: 'sdk-test' }
      },
    }
    const credentialOwner = await host.plugin({
      name: 'sdk-optional-credentials',
      apply(ctx) { ctx.provide('credentials', credentials) },
    })
    const probe = await host.plugin({
      name: 'sdk-optional-reader',
      async apply(ctx) {
        assert.throws(() => ctx.sessionProjections, /without inject/)
        assert.throws(() => ctx.credentials, /without inject/)
        assert.equal(typeof createHookSessionReader(ctx, 'sdk-optional'), 'function')
        assert.equal(await resolveTemplate(ctx, { type: 'template', parts: [{ type: 'env', name: 'SDK_FIXTURE_TOKEN' }] },
          '/plugin', '/data', '/workspace'), 'sdk-resolved-secret')
        assert.deepEqual(ctx.get('sessionProjections')?.stateOf(session, 'plugin-bridge:sdk-optional:hooks'), {
          turn: 4, assistantTurn: 0, assistantText: null,
        })
      },
    })
    await probe.dispose()
    await credentialOwner.dispose()
    await projections.dispose()
    assert.equal(host.get('credentials'), undefined)
    assert.equal(host.get('sessionProjections'), undefined)
  } finally { await host.fiber.dispose() }
})

test('真实 Cordis/SkillRegistry 与 MCP Schema 保持配置、失败清理和父实例撤销', async () => {
  const temp = await temporaryDirectory()
  const host = new Context()
  const active = new Map<string, McpConfig>()
  const released: string[] = []
  const logs: string[] = []
  const secret = 'sdk-startup-sensitive-sentinel'
  host.logger.exporter({ levels: { default: 3 }, export(message) { logs.push(message.args.map(String).join(' ')) } })
  try {
    const skills = new SkillRegistry(host)
    const credentials: Pick<CredentialProvider, 'resolve'> = { async resolve() { return { value: secret, source: 'sdk-test' } } }
    host.provide('credentials', credentials)
    const packageRoot = join(temp.path, 'package')
    await mkdir(join(packageRoot, 'skills/demo'), { recursive: true })
    await writeFile(join(packageRoot, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: SDK fixture\n---\nSDK body\n')
    const plugin = model()
    plugin.skills.push({
      name: 'demo', description: 'SDK fixture', sourceFormat: 'sdk-test',
      invocation: { modelInvocable: true, userInvocable: false },
      rootPath: 'skills/demo', contentPath: 'skills/demo/SKILL.md', metadata: { test: true },
    })
    const common = { sourceFormat: 'sdk-test', sourceFile: 'fixture.json' }
    plugin.mcpServers.push({
      ...common, serverName: 'failed', transport: 'stdio', command: literal('fixture'), args: [],
      env: { SECRET: { type: 'template', parts: [{ type: 'env', name: 'SDK_STARTUP_SENTINEL' }] } },
    }, {
      ...common, serverName: 'local', transport: 'stdio', command: literal('fixture'),
      args: [literal('space value'), literal("quote' $() ;")],
      environmentBindings: { PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data' },
      env: { PLUGIN_ROOT: literal('configured-root'), TOKEN: literal('explicit-env'),
        ['__proto__']: literal('env-prototype'), constructor: literal('env-constructor') },
      cwd: { type: 'plugin', path: '' }, reconnect: { enabled: false },
    }, {
      ...common, serverName: 'remote', transport: 'streamable-http', url: literal('https://example.com/mcp'),
      headers: { Authorization: literal('static'), 'X-Key': literal('static-key'),
        ['__proto__']: literal('header-prototype'), constructor: literal('header-constructor') },
      envHeaders: { 'x-key': literal('resolved-key') }, bearerToken: literal('resolved-bearer'),
    })
    const dependencies: RuntimeDependencies = {
      loadHookProtocol: defaultRuntimeDependencies.loadHookProtocol,
      async loadMcpClient() {
        return {
          name: 'sdk-controlled-mcp', Config: McpConfigSchema,
          async apply(ctx, config) {
            assert(Context.is(ctx))
            active.set(config.serverName, config)
            ctx.effect(() => () => { active.delete(config.serverName); released.push(config.serverName) })
            if (config.serverName === 'failed') throw new Error(`failure after registering an effect: ${JSON.stringify(config)}`)
          },
        }
      },
    }
    const runtime = new CompatRuntimeManager(host, new CompatLayout(join(temp.path, 'home')), { dependencies })
    const snapshot = await runtime.start(plugin, packageRoot)
    assert.equal(snapshot.status, 'degraded')
    assert.equal(snapshot.capabilities.find(item => item.name === 'failed')?.status, 'failed')
    assert.deepEqual([...active.keys()], ['local', 'remote'])
    assert.deepEqual(released, ['failed'])
    assert(logs.some(line => line.includes('已脱敏')))
    assert.equal(logs.join('\n').includes(secret), false)
    assert.equal(JSON.stringify(snapshot).includes(secret), false)
    const local = active.get('local')
    assert(local?.transport === 'stdio')
    assert.deepEqual(local.args, ['space value', "quote' $() ;"])
    assert.deepEqual(local.env, {
      PLUGIN_ROOT: 'configured-root', PLUGIN_DATA: new CompatLayout(join(temp.path, 'home')).dataDir(plugin.id), TOKEN: 'explicit-env',
      ['__proto__']: 'env-prototype', constructor: 'env-constructor',
    })
    assert.equal(local.cwd, packageRoot)
    assert.equal(local.toolCallTimeoutMs, 60_000)
    assert.equal(local.failOnStartupError, false)
    assert.equal(local.reconnect?.enabled, false)
    const remote = active.get('remote')
    assert(remote?.transport === 'streamable-http')
    assert.deepEqual(remote.headers, { ['__proto__']: 'header-prototype', constructor: 'header-constructor',
      authorization: 'Bearer resolved-bearer', 'x-key': 'resolved-key' })
    const catalog = await skills.list()
    assert.equal(catalog.length, 1)
    assert.deepEqual(catalog[0].invocation, { modelInvocable: true, userInvocable: false })
    assert.deepEqual(catalog[0].resourceBase, { kind: 'directory', path: join(packageRoot, 'skills/demo') })
    assert.equal((await skills.get('demo'))?.content, 'SDK body\n')
    const abort = new AbortController()
    abort.abort(new Error('cancel skill lookup'))
    await assert.rejects(skills.get('demo', { signal: abort.signal }), /cancel skill lookup/)
    await runtime.stop(plugin.id)
    assert.equal(active.size, 0)
    assert.deepEqual(new Set(released), new Set(['failed', 'local', 'remote']))
    assert.deepEqual(await skills.list(), [])
  } finally {
    await host.fiber.dispose()
    await temp.cleanup()
  }
})

test('默认 MCP 动态加载返回官方可挂载模块及 Schema，配置不经过 unknown 边界', async () => {
  const module = await defaultRuntimeDependencies.loadMcpClient()
  assert.equal(module.Config, McpConfigSchema)
  assert.equal(typeof module.apply, 'function')
  if (false) {
    const host = new Context()
    // @ts-expect-error stdio configuration must provide the official required fields.
    host.plugin(module, { transport: 'stdio', serverName: 'incomplete' })
    // @ts-expect-error provider discovery must be asynchronous and return official candidates/observations.
    const provider: SkillProvider = { name: 'sync', list: () => [], get: async () => undefined }
    void provider
  }
})
