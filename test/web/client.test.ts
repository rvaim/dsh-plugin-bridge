import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import type { CompatWebCategory, CompatWebListResult, CompatWebPlugin } from '../../src/types/web.js'
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

async function loadClient(react: Record<string, unknown> = {}) {
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
    Switch: icon,
    IconCloseOutlineRegular: icon,
    IconSearchOutlineRegular: icon,
    IconChevronDownOutlineRegular: icon,
    IconLoadingOutlineRegular: icon,
    IconPlusOutlineRegular: icon,
    IconRefreshOutlineRegular: icon,
    IconTrashOutlineRegular: icon,
    IconLinkOutlineRegular: icon,
  }
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const modules: Record<string, unknown> = {
    react,
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
      resolveText: (label: { en: string; zh?: string }) => language === 'zh' ? label.zh ?? label.en : label.en,
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
  const results = {
    list: { kind: 'ready', plugins: [], categories: [] },
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
  const resolveText = face.resolveText
  const label = { en: 'New Parser', zh: '新解析器' }
  assert.equal(resolveText(label), '新解析器')
  host.setLanguage('en')
  assert.equal(face.resolveText, resolveText)
  assert.equal(resolveText(label), 'New Parser')
  assert.equal(resolveText({ en: 'English fallback' }), 'English fallback')
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

type RenderNode = { type: unknown; props: Record<string, unknown> }

/** Run the shipped factory with deterministic hooks; no source-only component substitute. */
function createHookRuntime() {
  const records: unknown[] = []
  const cleanups = new Map<number, () => void>()
  let cursor = 0
  let dirty = true
  let tree: unknown
  let render: () => unknown = () => null
  let effects: (() => void)[] = []
  const equal = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const memo = <T>(factory: () => T, dependencies: unknown[]) => {
    const index = cursor++
    const previous = records[index] as { value: T; dependencies: unknown[] } | undefined
    if (previous !== undefined && equal(previous.dependencies, dependencies)) return previous.value
    const value = factory()
    records[index] = { value, dependencies }
    return value
  }
  const react = {
    useState: <T>(initial: T) => {
      const index = cursor++
      if (!(index in records)) records[index] = initial
      return [records[index], (value: T | ((current: T) => T)) => {
        const next = typeof value === 'function' ? (value as (current: T) => T)(records[index] as T) : value
        if (!Object.is(records[index], next)) { records[index] = next; dirty = true }
      }]
    },
    useRef: <T>(initial: T) => {
      const index = cursor++
      if (!(index in records)) records[index] = { current: initial }
      return records[index]
    },
    useMemo: memo,
    useCallback: <T>(callback: T, dependencies: unknown[]) => memo(() => callback, dependencies),
    useEffect: (effect: () => (() => void) | void, dependencies: unknown[]) => {
      const index = cursor++
      const previous = records[index] as unknown[] | undefined
      if (previous !== undefined && equal(previous, dependencies)) return
      records[index] = dependencies
      effects.push(() => {
        cleanups.get(index)?.()
        const cleanup = effect()
        if (cleanup !== undefined) cleanups.set(index, cleanup)
      })
    },
  }
  const flush = async () => {
    for (let pass = 0; pass < 20; pass++) {
      if (dirty) {
        dirty = false
        cursor = 0
        effects = []
        tree = render()
        for (const effect of effects) effect()
      }
      await Promise.resolve()
    }
    assert.equal(dirty, false, 'render must settle')
    return tree
  }
  return {
    react,
    mount: (component: (props: unknown) => unknown, props: unknown) => { render = () => component(props); dirty = true; return flush() },
    refresh: () => { dirty = true; return flush() },
    flush,
    unmount: () => { for (const cleanup of cleanups.values()) cleanup() },
  }
}

function nodes(tree: unknown): RenderNode[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (tree === null || typeof tree !== 'object' || !('props' in tree)) return []
  const node = tree as RenderNode
  return [node, ...nodes(node.props.children)]
}

function propNode(tree: unknown, key: string): RenderNode {
  const found = nodes(tree).find(node => key in node.props)
  assert(found, `Expected node with ${key}`)
  return found
}

function categoryProps(tree: unknown) {
  return propNode(tree, 'onSelect').props as {
    categories: (CompatWebCategory & { count: number })[]
    selectedId: string | null
    total: number
    onSelect(id: string | null): void
    resolveText(label: CompatWebCategory['label']): string
  }
}

const runtimePlugin: CompatWebPlugin = {
  id: 'mixed', name: 'Mixed tools', sourceId: 'source', enabled: true, priority: 0, runtimeStatus: 'running',
  formats: ['future-a', 'future-b'], skills: 1, mcpServers: 0, hooks: 0, errors: 0, warnings: 0, diagnostics: [],
}
const runtimeCategories: CompatWebCategory[] = [
  { id: 'future-b', label: { en: 'Future B' }, order: 20 },
  { id: 'all', label: { en: 'All parser', zh: '同名解析器' }, order: 10 },
  { id: 'future-a', label: { en: 'Future A', zh: '未来 A' }, order: 20 },
  { id: 'empty', label: { en: 'Empty' }, order: 30 },
]

test('实际 Client bundle 分类保留零计数、语言切换不读 RPC，读取失败保留目录，移除当前分类返回全部', async () => {
  const hooks = createHookRuntime()
  const { client } = await loadClient(hooks.react)
  let result: CompatWebListResult = { kind: 'ready', plugins: [runtimePlugin, runtimePlugin], categories: runtimeCategories }
  let listCalls = 0
  let updateCalls = 0
  const host = createHost({
    list: async () => { listCalls++; return { ok: true, value: result } },
    checkUpdates: async () => { updateCalls++; return { ok: true, value: { kind: 'ready', updates: [] } } },
  })
  const disposeRemote = await client.apply(host.ctx)
  const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
  let tree = await hooks.mount(client.PluginBridgePanel as (props: unknown) => unknown, { ...face, t: host.ctx.locale.bind(client.NS) })
  assert.equal(categoryProps(tree).total, 1)
  assert.deepEqual(Array.from(categoryProps(tree).categories, item => [item.id, item.count]), [['all', 0], ['future-a', 1], ['future-b', 1], ['empty', 0]])
  categoryProps(tree).onSelect('future-a')
  tree = await hooks.flush()
  assert.equal(categoryProps(tree).selectedId, 'future-a')
  const resolveText = categoryProps(tree).resolveText
  assert.equal(resolveText(runtimeCategories[2].label), '未来 A')
  host.setLanguage('en')
  tree = await hooks.refresh()
  assert.equal(categoryProps(tree).resolveText, resolveText)
  assert.equal(resolveText(runtimeCategories[2].label), 'Future A')
  assert.deepEqual({ listCalls, updateCalls }, { listCalls: 1, updateCalls: 1 })

  const refresh = () => (nodes(tree).find(node => node.props.title === 'Refresh plugin list')!.props.onClick as () => void)()
  result = { kind: 'error', message: 'Host offline' }
  refresh()
  tree = await hooks.flush()
  assert.equal(categoryProps(tree).selectedId, 'future-a')
  assert.equal(categoryProps(tree).categories.length, 4)
  assert(nodes(tree).some(node => node.props.role === 'alert'))

  result = { kind: 'ready', plugins: [runtimePlugin], categories: [] }
  refresh()
  tree = await hooks.flush()
  assert.equal(categoryProps(tree).selectedId, null)
  assert.equal(categoryProps(tree).categories.length, 0)
  assert.equal(categoryProps(tree).total, 1)
  assert(nodes(tree).some(node => node.props.children === 'The parser for this category was removed. All plugins are now shown.'))
  assert(nodes(tree).some(node => (node.props.plugin as CompatWebPlugin | undefined)?.id === 'mixed'))
  hooks.unmount()
  host.dispose()
  await disposeRemote()
})

test('实际 Client bundle 添加清空搜索和状态；任一新插件不属于当前分类则回全部', async () => {
  const hooks = createHookRuntime()
  const { client } = await loadClient(hooks.react)
  const host = createHost({
    list: async () => ({ ok: true, value: { kind: 'ready', plugins: [runtimePlugin], categories: runtimeCategories } }),
    checkUpdates: async () => ({ ok: true, value: { kind: 'ready', updates: [] } }),
  })
  const disposeRemote = await client.apply(host.ctx)
  const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
  let tree = await hooks.mount(client.PluginBridgePanel as (props: unknown) => unknown, { ...face, t: host.ctx.locale.bind(client.NS) })
  categoryProps(tree).onSelect('future-a')
  tree = await hooks.flush()
  const change = (key: string, value: string) => (nodes(tree).find(node => node.props['aria-label'] === key)!.props.onChange as (event: unknown) => void)({ currentTarget: { value } })
  change('搜索插件', 'missing')
  const filter = nodes(tree).find(node => node.type === 'select' && node.props.value === 'all')!
  ;(filter.props.onChange as (event: unknown) => void)({ currentTarget: { value: 'disabled' } })
  tree = await hooks.flush()
  ;(nodes(tree).find(node => node.props['data-plugin-bridge-add'] !== undefined)!.props.onClick as () => void)()
  tree = await hooks.flush()
  const installed = [{ ...runtimePlugin, id: 'added-a' }, { ...runtimePlugin, id: 'added-b', formats: ['future-b'] }]
  ;(propNode(tree, 'onInstalled').props.onInstalled as (plugins: CompatWebPlugin[]) => void)(installed)
  tree = await hooks.flush()
  assert.equal(categoryProps(tree).selectedId, null)
  assert.equal(categoryProps(tree).total, 3)
  assert.equal(nodes(tree).find(node => node.props['aria-label'] === '搜索插件')!.props.value, '')
  assert(nodes(tree).some(node => node.type === 'select' && node.props.value === 'all'))
  assert.equal(nodes(tree).filter(node => node.props.plugin !== undefined).length, 3)
  hooks.unmount()
  host.dispose()
  await disposeRemote()
})
