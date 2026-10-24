#!/usr/bin/env node

/** Exercise the pinned SDK's real registries and Host/Client dispatch in memory. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { apply as applyClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TYPERT } from '../dist/typert.host.js'
import remote from '../dist/typert.remote-client.js'
import { CompatWebGateway } from '../dist/src/web/host/gateway.js'
import { createHookSessionReader } from '../dist/src/runtime/hook-session.js'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const target = manifest.engines.dsh
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  const installed = JSON.parse(await readFile(new URL(import.meta.resolve(`${name}/package.json`)), 'utf8'))
  assert.equal(installed.version, target, `${name} must match engines.dsh`)
}
assert.equal(evaluatePluginCompatibility(manifest, {}, target), undefined)
assert.notEqual(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2'), undefined)
assert.notEqual(evaluatePluginCompatibility(manifest, {}, '0.1.0-rc.6'), undefined)

const expected = ['beginAdd', 'cancelAdd', 'checkUpdates', 'completeAdd', 'contract', 'list', 'setEnabled', 'uninstall', 'update']
assert.deepEqual(TYPERT.invocations.map(item => item.method).sort(), expected)
assert.deepEqual(remote.descriptors.map(item => item.method).sort(), expected)
for (const descriptor of [...TYPERT.invocations, ...remote.descriptors]) {
  for (const codec of [descriptor.result, ...descriptor.parameters.map(parameter => parameter.codec)]) {
    assert.equal(codec.mode, 'strict')
    assert.equal(typeof codec.create, 'function')
    assert.equal(Object.hasOwn(codec, 'schema'), false)
    assert.equal(typeof codec.create().safeParse, 'function')
  }
}

const host = new Context()
const client = new Context()
const peerController = new AbortController()
let admin
try {
  const hostRegistry = new TypertRegistry(host)
  const clientRegistry = new TypertRegistry(client)
  const disposeHost = hostRegistry.register(TYPERT)
  assert.equal(hostRegistry.local.list().length, expected.length)

  // Regress the original failure against the real SDK validation boundary.
  const first = remote.descriptors[0]
  assert.throws(() => clientRegistry.remotes.register({
    package: remote.package,
    descriptors: [{ ...first, result: {
      mode: 'strict', typeSymbol: first.result.typeSymbol, schema: first.result.create(),
    } }],
  }), /strict codec has no create\(\) factory/)
  assert.equal(clientRegistry.remotes.list().length, 0)

  const hookState = { turn: 3, assistantTurn: 3, assistantText: 'Contract reply' }
  new SessionStore(host)
  const hookSession = host.sessions.create(SessionId('plugin-bridge-sdk-hook'), { meta: { cwd: '/sdk-contract' } })
  hookSession.append('turn/start', { turn: 3 })
  hookSession.append('assistant/message', {
    turn: 3, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'sdk-contract', model: 'sdk-contract' },
      content: [{ type: 'text', text: 'Contract reply' }] }),
  }, { surfaceOp: 'append' })
  const projectionProvider = host.plugin({
    name: 'plugin-bridge-contract-projections',
    apply(ctx) { new SessionProjectionRegistry(ctx) },
  })
  await projectionProvider
  const hookFiber = host.plugin({
    name: 'plugin-bridge-contract-scope',
    apply(ctx) {
      assert.throws(() => ctx.sessionProjections, /without inject/)
      const read = createHookSessionReader(ctx, 'contract')
      assert.deepEqual(read({ session: hookSession }), hookState)
    },
  })
  await hookFiber
  await hookFiber.dispose()
  await projectionProvider.dispose()

  const removed = []
  const parserSelections = []
  const releasedPreparations = []
  const parserChoice = { kind: 'parser-selection', plugins: [{
    pluginId: 'contract-tool', name: 'Contract tool', matches: [{
      parserId: 'third-party-parser', label: { en: 'Third party parser', zh: '第三方解析器' }, available: true,
      evidence: [{ kind: 'manifest', file: 'third-party/plugin.json' }, { kind: 'implicit' }],
      diagnostics: [{ level: 'warning', code: 'CONTRACT_NOTICE', capability: 'plugin', message: 'Parser notice', details: { probe: true } }],
    }],
  }] }
  const webParserChoice = { ...parserChoice, requestId: 'contract-preparation', plugins: parserChoice.plugins.map(plugin => ({
    ...plugin, matches: plugin.matches.map(match => ({ ...match,
      diagnostics: match.diagnostics.map(item => ({ ...item, details: JSON.stringify(item.details, null, 2) })),
    })),
  })) }
  let listFailure = false
  host.provide('pluginBridge', {
    async list() {
      if (listFailure) throw new Error('Controlled list failure')
      return []
    },
    listCategories() { return [] },
    async checkUpdates() { return [] },
    async uninstall(id) { removed.push(id) },
    async prepareInstall() {
      return { preparationId: 'contract-preparation', sourceId: 'contract-source', sourceCreated: true, selectionRequired: false,
        plugins: [{ id: 'contract-tool', name: 'Contract tool', formats: ['third-party-parser'],
          location: { type: 'source-path', path: '.' }, installable: true, diagnostics: [] }],
      }
    },
    async completeInstallPreparation(preparationId, plugins) {
      parserSelections.push({ preparationId, plugins })
      return parserChoice
    },
    async releaseInstallPreparation(id) { releasedPreparations.push(id) },
  })
  admin = new CompatWebGateway(host)
  const gateway = new TypertGatewayService(host, {})
  const peer = {
    id: 'plugin-bridge-contract-owner', ctx: host,
    principal: { kind: 'owner' }, signal: peerController.signal,
    interactions: 'none', async dispose() { peerController.abort() },
  }
  let calls = 0
  let jsonCarrier = true
  const roundTrip = value => jsonCarrier ? JSON.parse(JSON.stringify(value)) : value
  client.provide('connection', {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined },
    rpc: {
      // A local carrier avoids opening sockets while exercising actual dispatch.
      open() { throw new Error('No stream belongs to the unary contract probe') },
      async call(path, endpoint, payload, signal) {
        assert.equal(path, '/api')
        const [namespace, method] = endpoint.split('/')
        calls++
        const transported = roundTrip(payload)
        try {
          const value = await gateway.invoke({ namespace, method, args: transported.args, peer, signal })
          return roundTrip({ ok: true, value })
        } catch (error) {
          return roundTrip({ ok: false, error: {
            code: error.code ?? 'gateway/internal', message: error.message, details: error.details ?? {},
          } })
        }
      },
    },
  })
  applyClientRemote(client)
  const api = client.get('remote')
  const disposeRemote = await api.$mount(remote)
  const namespace = client.get('remote.pluginBridgeAdmin')
  assert.notEqual(namespace, undefined)
  const retainedList = namespace.list
  assert.deepEqual(await namespace.contract(), { ok: true, value: { protocol: 'single-parser-v1', acceptsSelections: true } })
  assert.deepEqual(await namespace.list(), { ok: true, value: { kind: 'ready', plugins: [], categories: [] } })
  assert.deepEqual(await namespace.uninstall('contract-plugin'), {
    ok: true, value: { kind: 'removed', pluginId: 'contract-plugin' },
  })
  assert.deepEqual(removed, ['contract-plugin'])
  const installSignal = new AbortController().signal
  assert.deepEqual(await namespace.beginAdd('/contract/source', installSignal), { ok: true, value: webParserChoice })
  for (const plugins of [[{ pluginId: 'contract-tool' }], [{ pluginId: 'contract-tool', parserId: 'third-party-parser' }]]) {
    assert.deepEqual(await namespace.completeAdd('contract-preparation', plugins, installSignal), { ok: true, value: webParserChoice })
  }
  assert.deepEqual(parserSelections, [
    { preparationId: 'contract-preparation', plugins: [{ pluginId: 'contract-tool' }] },
    { preparationId: 'contract-preparation', plugins: [{ pluginId: 'contract-tool' }] },
    { preparationId: 'contract-preparation', plugins: [{ pluginId: 'contract-tool', parserId: 'third-party-parser' }] },
  ])
  assert.equal(Object.hasOwn(parserSelections[1].plugins[0], 'parserId'), false)
  jsonCarrier = false
  const undefinedSelection = await namespace.completeAdd('contract-preparation', [{ pluginId: 'contract-tool', parserId: undefined }], installSignal)
  assert.equal(undefinedSelection.ok, false)
  assert.equal(undefinedSelection.error.code, 'gateway/input-invalid')
  assert.equal(parserSelections.length, 3, 'non-JSON input must not reach the manager')
  jsonCarrier = true
  assert.deepEqual(await namespace.completeAdd('contract-preparation', [{ pluginId: 'contract-tool', parserId: undefined }], installSignal), { ok: true, value: webParserChoice })
  assert.equal(Object.hasOwn(parserSelections[3].plugins[0], 'parserId'), false, 'JSON transport omits undefined fields')
  const legacySelection = await namespace.completeAdd('contract-preparation', ['contract-tool'], installSignal)
  assert.equal(legacySelection.ok, false)
  assert.equal(legacySelection.error.code, 'gateway/input-invalid')
  assert.deepEqual(await namespace.cancelAdd('contract-preparation'), { ok: true, value: { kind: 'cancelled' } })
  assert.deepEqual(releasedPreparations, ['contract-preparation'])
  const invalid = await namespace.setEnabled(42, true)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'gateway/input-invalid')
  listFailure = true
  assert.deepEqual(await namespace.list(), {
    ok: true, value: { kind: 'error', message: 'Controlled list failure' },
  })
  assert.equal(calls, 12)

  await disposeRemote()
  assert.equal(clientRegistry.remotes.list().length, 0)
  assert.equal(client.get('remote.pluginBridgeAdmin'), undefined)
  const withdrawn = await retainedList()
  assert.equal(withdrawn.ok, false)
  assert.equal(calls, 12, 'withdrawn namespace must not call the Host')
  await disposeHost()
  assert.equal(hostRegistry.local.list().length, 0)
  console.log(`DSH ${target}: strict Host/Client registration, ${calls} RPC round trips, invalid input and disposal passed`)
  console.log('This probe uses the pinned SDK in memory; it does not install into a Desktop profile or verify browser rendering.')
} finally {
  peerController.abort()
  await admin?.dispose()
  await client.fiber.dispose()
  await host.fiber.dispose()
}
