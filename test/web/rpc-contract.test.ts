import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry, type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { apply as applyClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { Remote, TypertRemoteService, type PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { PLUGIN_BRIDGE_RPC_PROTOCOL } from '../../src/shared/rpc-contract.js'
import { CompatWebGateway } from '../../src/web/host/gateway.js'
import type { PluginInstallSelection } from '../../src/types/plugin.js'
import type { PluginBridgeInjected } from '../../src/web/client/types.js'

// Generated host declarations expose unknown; the real registry validates this artifact.
const contribution = (await import(pathToFileURL(resolve('dist/typert.host.js')).href)).TYPERT as TypertContribution

class LegacyGateway extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'pluginBridgeAdmin') }

  @Remote('list')
  list() { return { kind: 'ready', plugins: [], categories: [] } }

  @Remote('cancelAdd')
  cancelAdd(_requestId: string) { return { kind: 'cancelled' } }

  async dispose(): Promise<void> {}
}

function withSelectionSchema(schema: z.ZodType): TypertContribution {
  return {
    ...contribution,
    invocations: contribution.invocations.map(descriptor => descriptor.method !== 'completeAdd' ? descriptor : {
      ...descriptor,
      parameters: descriptor.parameters.map(parameter => parameter.name !== 'plugins' ? parameter : {
        ...parameter,
        codec: { mode: 'strict', typeSymbol: 'plugin-bridge-contract-fixture', create: () => schema },
      }),
    }),
  }
}

const selections = z.array(z.object({ pluginId: z.string(), parserId: z.string().optional() }))
const schemaCases = [
  { name: 'current object selections', contribution, accepts: true },
  { name: 'cached legacy string selections', contribution: withSelectionSchema(z.array(z.string())), accepts: false },
  { name: 'required parser rejects first stage', contribution: withSelectionSchema(z.array(z.object({ pluginId: z.string(), parserId: z.string() }))), accepts: false },
  { name: 'permissive schema also accepts legacy input', contribution: withSelectionSchema(z.array(z.unknown())), accepts: false },
  { name: 'parse output contains nested undefined', contribution: withSelectionSchema(selections.transform(items => items.map(item => ({ ...item, parserId: item.parserId })))), accepts: false },
  { name: 'completeAdd descriptor is absent', contribution: { ...contribution, invocations: contribution.invocations.filter(item => item.method !== 'completeAdd') }, accepts: false },
]

for (const fixture of schemaCases) {
  test(`Host contract checks active registry: ${fixture.name}`, async () => {
    const host = new Context()
    let admin: CompatWebGateway | undefined
    try {
      new TypertRegistry(host).register(fixture.contribution)
      host.provide('pluginBridge', { async releaseInstallPreparation() {} })
      admin = new CompatWebGateway(host)
      assert.deepEqual(admin.contract(), { protocol: PLUGIN_BRIDGE_RPC_PROTOCOL, acceptsSelections: fixture.accepts })
    } finally { await admin?.dispose(); await host.fiber.dispose() }
  })
}

type BrowserModule = { apply(ctx: Context): Promise<() => Promise<void>> }
type BundleEntry = { id: string; factory(require: (name: string) => unknown): BrowserModule }

async function loadBundle(): Promise<BrowserModule> {
  let entry: BundleEntry | undefined
  new Script(await readFile(resolve('dist/client.js'), 'utf8'), { filename: 'dist/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load(value: BundleEntry) { entry = value } } },
    AbortController,
  })
  assert.equal(entry?.id, '@rvaim/dsh-plugin-bridge')
  return entry!.factory(name => {
    assert(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'].includes(name), `Unexpected browser dependency: ${name}`)
    return {}
  })
}

async function runtimeFixture(mode: 'fresh' | 'cached-legacy' | 'missing-contract', transport: 'direct' | 'json') {
  const host = new Context()
  const client = new Context()
  const abort = new AbortController()
  let admin: CompatWebGateway | LegacyGateway | undefined
  let disposeBundle: (() => Promise<void>) | undefined
  const business: string[] = []
  const handled: { preparationId: string; plugins: PluginInstallSelection[] }[] = []
  const rpcCalls: string[] = []
  try {
    const active = mode === 'cached-legacy' ? withSelectionSchema(z.array(z.string())) : mode === 'missing-contract'
      ? { ...contribution, invocations: contribution.invocations.filter(descriptor => descriptor.method !== 'contract') }
      : contribution
    new TypertRegistry(host).register(active)
    new TypertRegistry(client)
    host.provide('pluginBridge', {
      async list() { return [] },
      listCategories() { return [] },
      async prepareInstall() {
        business.push('prepare')
        return { preparationId: 'contract-preparation', sourceId: 'contract-source', sourceCreated: false, selectionRequired: true,
          plugins: [{ id: 'tool', name: 'Tool', formats: ['parser-a', 'parser-b'], location: { type: 'source-path', path: '.' }, installable: true, diagnostics: [] }] }
      },
      async completeInstallPreparation(preparationId: string, plugins: PluginInstallSelection[]) {
        business.push('complete')
        handled.push({ preparationId, plugins })
        return plugins[0].parserId === undefined ? { kind: 'parser-selection', plugins: [{ pluginId: 'tool', name: 'Tool',
          matches: ['parser-a', 'parser-b'].map(parserId => ({ parserId, label: { en: parserId }, available: true, evidence: [], diagnostics: [] })) }] }
          : { kind: 'installed', result: { plugins: [] } }
      },
      async releaseInstallPreparation() { business.push('release') },
    })
    admin = mode === 'missing-contract' ? new LegacyGateway(host) : new CompatWebGateway(host)
    const gateway = new TypertGatewayService(host, {})
    const peer = { id: 'plugin-bridge-contract-test' as PeerId, ctx: host, principal: { kind: 'owner' as const }, signal: abort.signal,
      interactions: 'none' as const, async dispose() { abort.abort() } }
    const roundTrip = <Value>(value: Value): Value => transport === 'json' ? JSON.parse(JSON.stringify(value)) : value
    client.provide('connection', {
      interactions: 'none', isLoopback: true, generation: { getSnapshot: () => undefined },
      rpc: {
        open() { throw new Error('Unary contract test has no streams') },
        async call(path: string, endpoint: string, payload: { args: Record<string, unknown> }, signal: AbortSignal) {
          assert.equal(path, '/api')
          rpcCalls.push(endpoint)
          const [namespace, method] = endpoint.split('/')
          const transported = roundTrip(payload)
          try {
            return roundTrip({ ok: true, value: await gateway.invoke({ namespace, method, args: transported.args, peer, signal }) })
          } catch (error) {
            assert(error instanceof Error)
            const code = 'code' in error ? error.code : 'gateway/internal'
            const details = 'details' in error ? error.details : {}
            return roundTrip({ ok: false, error: { code, message: error.message, details } })
          }
        },
      },
    })
    applyClientRemote(client)
    let face: PluginBridgeInjected | undefined
    const dictionaries = new Map<string, { zh: Record<string, string> }>()
    client.provide('locale', {
      register(namespace: string, resources: { zh: Record<string, string> }) {
        dictionaries.set(namespace, resources)
        return () => { dictionaries.delete(namespace) }
      },
      bind(namespace: string) { return (key: string) => dictionaries.get(namespace)?.zh[key] ?? key },
      resolveText(label: { en: string }) { return label.en },
    })
    client.provide('slots', {
      inject(_name: string, callback: () => () => void) { return callback() },
      register(options: { name: string; inject?: () => PluginBridgeInjected }) {
        if (options.name === 'main') face = options.inject!()
        return () => {}
      },
    })
    disposeBundle = await (await loadBundle()).apply(client)
    assert(face)
    return {
      face, business, handled, rpcCalls,
      contract: () => {
        assert(admin instanceof CompatWebGateway)
        return admin.contract()
      },
      dispose: async () => { abort.abort(); await disposeBundle?.(); await admin?.dispose(); await client.fiber.dispose(); await host.fiber.dispose() },
    }
  } catch (error) {
    abort.abort(); await disposeBundle?.(); await admin?.dispose(); await client.fiber.dispose(); await host.fiber.dispose()
    throw error
  }
}

for (const transport of ['direct', 'json'] as const) {
  test(`Actual Client bundle + real Gateway preserves two-stage selections over ${transport} carrier`, async () => {
    const fixture = await runtimeFixture('fresh', transport)
    try {
      assert.deepEqual(fixture.contract(), { protocol: PLUGIN_BRIDGE_RPC_PROTOCOL, acceptsSelections: true })
      const signal = new AbortController().signal
      const begun = await fixture.face.beginAdd('github:fixture/tools', signal)
      assert.equal(begun.kind, 'selection')
      if (begun.kind !== 'selection') return
      const parsers = await fixture.face.completeAdd(begun.requestId, [{ pluginId: 'tool' }], signal)
      assert.equal(parsers.kind, 'parser-selection')
      if (parsers.kind !== 'parser-selection') return
      assert.equal(parsers.requestId, begun.requestId)
      const installed = await fixture.face.completeAdd(parsers.requestId, [{ pluginId: 'tool', parserId: 'parser-b' }], signal)
      assert.equal(installed.kind, 'installed')
      assert.deepEqual(fixture.handled, [
        { preparationId: 'contract-preparation', plugins: [{ pluginId: 'tool' }] },
        { preparationId: 'contract-preparation', plugins: [{ pluginId: 'tool', parserId: 'parser-b' }] },
      ])
      assert.equal(Object.hasOwn(fixture.handled[0].plugins[0], 'parserId'), false)
      assert.deepEqual(fixture.rpcCalls, ['contract', 'beginAdd', 'contract', 'completeAdd', 'contract', 'completeAdd'].map(method => `pluginBridgeAdmin/${method}`))
      assert.deepEqual(fixture.business, ['prepare', 'complete', 'complete'])
    } finally { await fixture.dispose() }
  })
}

for (const mode of ['cached-legacy', 'missing-contract'] as const) {
  test(`Actual Client bundle blocks ${mode} Host before any install manager operation`, async () => {
    const fixture = await runtimeFixture(mode, 'json')
    try {
      if (mode === 'cached-legacy') assert.deepEqual(fixture.contract(), { protocol: PLUGIN_BRIDGE_RPC_PROTOCOL, acceptsSelections: false })
      const signal = new AbortController().signal
      const restart = /完整退出[\s\S]*重启[\s\S]*Harness|完整退出[\s\S]*Harness[\s\S]*重启/
      await assert.rejects(fixture.face.beginAdd('github:fixture/tools', signal), restart)
      await assert.rejects(fixture.face.completeAdd('pending', [{ pluginId: 'tool' }], signal), restart)
      await assert.rejects(fixture.face.uploadArchive({ name: 'plugin.zip', size: 128 } as File, signal), restart)
      assert.deepEqual(fixture.rpcCalls, Array(3).fill('pluginBridgeAdmin/contract'))
      assert.deepEqual(fixture.business, [])
      assert.deepEqual(fixture.handled, [])
      assert.equal((await fixture.face.list()).kind, 'ready')
      assert.equal((await fixture.face.cancelAdd('pending')).kind, 'cancelled')
      assert.deepEqual(fixture.business, [])
    } finally { await fixture.dispose() }
  })
}
