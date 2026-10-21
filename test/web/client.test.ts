import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import type { PluginBridgeInjected } from '../../src/web/client/types.js'

type Entry = {
  name: string
  key?: string
  id?: string
  locale: string
  label?: () => string
  inject?: () => PluginBridgeInjected
}

type ClientModule = {
  NS: string
  PANEL_ID: string
  inject: string[]
  apply: (ctx: unknown) => Promise<() => Promise<void>>
  PluginBridgePanel: unknown
}

async function loadClient() {
  let registration: { id: string; factory: (require: (id: string) => unknown) => ClientModule } | undefined
  const source = await readFile(resolve('dist/client.js'), 'utf8')
  new Script(source, { filename: 'dist/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load: (entry: typeof registration) => { registration = entry } } },
  })
  assert.equal(registration?.id, '@rvaim/dsh-plugin-bridge')
  const icon = () => null
  const primitives = {
    Button: icon,
    Input: icon,
    Modal: icon,
    Toast: icon,
    IconChevronDownOutlineRegular: icon,
    IconLoadingOutlineRegular: icon,
    IconPlusOutlineRegular: icon,
    IconRefreshOutlineRegular: icon,
    IconTrashOutlineRegular: icon,
    IconLinkOutlineRegular: icon,
  }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const modules: Record<string, unknown> = {
    react: {},
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  const client = registration!.factory((id) => {
    assert(Object.hasOwn(modules, id), `Unexpected browser dependency: ${id}`)
    return modules[id]
  })
  return { client, primitives }
}

function createHost(remote: Record<string, unknown> | undefined) {
  const entries: { options: Entry; component: unknown }[] = []
  const slots: string[] = []
  const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
  const disposers: (() => void)[] = []
  let language: 'zh' | 'en' = 'zh'
  let mounts = 0
  let remoteDisposals = 0
  const ctx = {
    remote: {
      $mount: async (definition: unknown) => {
        assert(definition !== undefined)
        mounts += 1
        return async () => { remoteDisposals += 1 }
      },
    },
    get: (name: string) => {
      assert.equal(name, 'remote.pluginBridgeAdmin')
      return remote
    },
    effect: (effect: () => () => void) => { disposers.push(effect()) },
    locale: {
      register: (namespace: string, resource: { zh: Record<string, string>; en: Record<string, string> }) => {
        dictionaries.set(namespace, resource)
        return () => { dictionaries.delete(namespace) }
      },
      bind: (namespace: string) => (key: string) => dictionaries.get(namespace)![language][key],
    },
    slots: {
      inject: (slot: string, callback: () => () => void) => {
        slots.push(slot)
        disposers.push(callback())
      },
      register: (options: Entry, component: unknown) => {
        const entry = { options, component }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      },
    },
  }
  return {
    ctx,
    entries,
    slots,
    dictionaries,
    setLanguage: (value: 'zh' | 'en') => { language = value },
    counts: () => ({ mounts, remoteDisposals }),
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

test('Client 通过宿主侧边栏打开同 ID 的独立 main 面板，不再贡献设置页', async () => {
  const { client, primitives } = await loadClient()
  const host = createHost({})
  const disposeRemote = await client.apply(host.ctx)
  assert.equal(client.NS, 'pluginBridge')
  assert.equal(client.PANEL_ID, 'plugin-bridge')
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'remote'])
  assert.deepEqual(host.slots, ['main', 'sidebar.panellist'])
  assert.equal(host.entries.length, 2)
  const main = host.entries.find(entry => entry.options.name === 'main')!
  const sidebar = host.entries.find(entry => entry.options.name === 'sidebar.panellist')!
  assert.equal(main.options.key, sidebar.options.id)
  assert.equal(main.options.key, client.PANEL_ID)
  assert.equal(main.component, client.PluginBridgePanel)
  assert.equal(main.options.locale, client.NS)
  assert.equal(sidebar.options.locale, client.NS)
  assert.equal(sidebar.options.label!(), '插件桥')
  host.setLanguage('en')
  assert.equal(sidebar.options.label!(), 'Plugin Bridge')
  const renderIcon = sidebar.component as (props: { size: number; active: boolean }) => { type: unknown; props: { size: number } }
  const glyph = renderIcon({ size: 18, active: true })
  assert.equal(glyph.type, primitives.IconLinkOutlineRegular)
  assert.equal(glyph.props.size, 18)
  assert.equal(Object.hasOwn(client, 'CompatSettingsSection'), false)
  host.dispose()
  await disposeRemote()
  assert.equal(host.entries.length, 0)
  assert.equal(host.dictionaries.size, 0)
  assert.deepEqual(host.counts(), { mounts: 1, remoteDisposals: 1 })
})

test('独立管理面板保留全部业务 RPC，并显示 Host 拒绝原因', async () => {
  const { client } = await loadClient()
  const calls: { method: string; args: unknown[] }[] = []
  const results: Record<keyof PluginBridgeInjected, unknown> = {
    list: { kind: 'ready', plugins: [] },
    checkUpdates: { kind: 'ready', updates: [] },
    update: { kind: 'updated', plugins: [], affectedPluginIds: ['demo'] },
    beginAdd: { kind: 'selection', requestId: 'selection', candidates: [] },
    completeAdd: { kind: 'installed', plugins: [] },
    cancelAdd: { kind: 'cancelled' },
    setEnabled: { kind: 'updated', plugin: { id: 'demo' } },
    uninstall: { kind: 'removed', pluginId: 'demo' },
  }
  const remote: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.fromEntries(Object.entries(results).map(([method, value]) => [
    method,
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return { ok: true, value }
    },
  ]))
  const host = createHost(remote)
  const disposeRemote = await client.apply(host.ctx)
  const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
  assert.equal(await face.list(), results.list)
  assert.equal(await face.checkUpdates(), results.checkUpdates)
  assert.equal(await face.update('demo', true), results.update)
  assert.equal(await face.beginAdd('github:owner/repo'), results.beginAdd)
  assert.equal(await face.completeAdd('selection', ['demo']), results.completeAdd)
  assert.equal(await face.cancelAdd('selection'), results.cancelAdd)
  assert.equal(await face.setEnabled('demo', false), results.setEnabled)
  assert.equal(await face.uninstall('demo'), results.uninstall)
  assert.deepEqual(calls, [
    { method: 'list', args: [] },
    { method: 'checkUpdates', args: [] },
    { method: 'update', args: ['demo', true] },
    { method: 'beginAdd', args: ['github:owner/repo'] },
    { method: 'completeAdd', args: ['selection', ['demo']] },
    { method: 'cancelAdd', args: ['selection'] },
    { method: 'setEnabled', args: ['demo', false] },
    { method: 'uninstall', args: ['demo'] },
  ])
  remote.list = async () => ({ ok: false, error: { message: 'service unavailable' } })
  await assert.rejects(face.list(), /pluginBridgeAdmin\.list: service unavailable/)
  host.dispose()
  await disposeRemote()
})

test('管理 Remote 挂载失败时回收挂载，且不留下无法打开的入口', async () => {
  const { client } = await loadClient()
  const host = createHost(undefined)
  await assert.rejects(client.apply(host.ctx), /pluginBridgeAdmin Remote 挂载后不可用/)
  assert.equal(host.entries.length, 0)
  assert.equal(host.dictionaries.size, 0)
  assert.deepEqual(host.counts(), { mounts: 1, remoteDisposals: 1 })
})
