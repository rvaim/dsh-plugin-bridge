import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import type { CompatWebAddResult, CompatWebCandidate, CompatWebCategory, CompatWebListResult, CompatWebParserChoiceRequest, CompatWebParserMatch, CompatWebPlugin } from '../../src/types/web.js'
import type { PluginInstallSelection } from '../../src/manager/types.js'
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
  PluginRow: unknown
}

async function loadClient(react: Record<string, unknown> = {}, browser: Record<string, unknown> = {}) {
  let registration: { id: string; factory: (require: (id: string) => unknown) => ClientModule } | undefined
  const source = await readFile(resolve('dist/client.js'), 'utf8')
  new Script(source, { filename: 'dist/client.js' }).runInNewContext({
    window: { __ModuleLoader__: { load: (entry: typeof registration) => { registration = entry } } },
    AbortController,
    ...browser,
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
    IconArchiveOutlineRegular: icon,
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
  if (remote !== undefined && !Object.hasOwn(remote, 'contract')) {
    remote.contract = async () => ({ ok: true, value: { protocol: 'single-parser-v1', acceptsSelections: true } })
  }
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
    contract: { protocol: 'single-parser-v1', acceptsSelections: true },
    list: { kind: 'ready', plugins: [], categories: [] },
    checkUpdates: { kind: 'ready', updates: [] },
    update: { kind: 'updated', plugins: [], affectedPluginIds: ['demo'] },
    beginAdd: { kind: 'selection', requestId: 'selection', selectionRequired: true, candidates: [] },
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
  const signal = new AbortController().signal
  assert.equal(await face.beginAdd('github:owner/repo', signal), results.beginAdd)
  assert.equal(await face.completeAdd('selection', [{ pluginId: 'demo' }], signal), results.completeAdd)
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
    { method: 'contract', args: [] },
    { method: 'beginAdd', args: ['github:owner/repo', signal] },
    { method: 'contract', args: [] },
    { method: 'completeAdd', args: ['selection', [{ pluginId: 'demo' }], signal] },
    { method: 'cancelAdd', args: ['selection'] },
    { method: 'setEnabled', args: ['demo', false] },
    { method: 'uninstall', args: ['demo'] },
  ])
  remote.list = async () => ({ ok: false, error: { message: 'service unavailable' } })
  await assert.rejects(face.list(), /pluginBridgeAdmin\.list: service unavailable/)
  host.dispose()
  await disposeRemote()
})

for (const failure of ['stale', 'protocol', 'missing-method', 'missing-endpoint'] as const) {
  test(`实际 Client bundle 在 ${failure} 契约下阻止所有安装入口，并提示完整退出重启`, async () => {
    let uploads = 0
    let businessCalls = 0
    let checks = 0
    const { client } = await loadClient({}, { fetch: async () => { uploads++; throw new Error('upload must be guarded') } })
    const host = createHost({
      contract: failure === 'missing-method' ? undefined : async () => {
        checks++
        return failure === 'missing-endpoint'
          ? { ok: false, error: { code: 'gateway/endpoint-unavailable', message: 'contract endpoint unavailable' } }
          : { ok: true, value: { protocol: failure === 'protocol' ? 'legacy' : 'single-parser-v1', acceptsSelections: failure !== 'stale' } }
      },
      beginAdd: async () => { businessCalls++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
      completeAdd: async () => { businessCalls++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
      list: async () => ({ ok: true, value: { kind: 'ready', plugins: [], categories: [] } }),
      cancelAdd: async () => ({ ok: true, value: { kind: 'cancelled' } }),
    })
    const disposeRemote = await client.apply(host.ctx)
    try {
      const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
      const signal = new AbortController().signal
      const restartMessage = (error: unknown) => {
        assert(error !== null && typeof error === 'object' && 'message' in error)
        const message = String(error.message)
        assert.match(message, /完整退出/)
        assert.match(message, /重启/)
        assert.match(message, /Harness/)
        return true
      }
      await assert.rejects(face.beginAdd('github:owner/repo', signal), restartMessage)
      await assert.rejects(face.completeAdd('pending', [{ pluginId: 'demo' }], signal), restartMessage)
      await assert.rejects(face.uploadArchive({ name: 'plugin.zip', size: 128 } as File, signal), restartMessage)
      assert.equal(businessCalls, 0)
      assert.equal(uploads, 0)
      assert.equal(checks, failure === 'missing-method' ? 0 : 3)
      assert.equal((await face.list()).kind, 'ready')
      assert.equal((await face.cancelAdd('pending')).kind, 'cancelled')
    } finally { host.dispose(); await disposeRemote() }
  })
}

test('实际 Client bundle 每次安装前重新检查契约，保留取消旧请求的入口', async () => {
  const { client } = await loadClient()
  let acceptsSelections = true
  let checks = 0
  let completions = 0
  const host = createHost({
    contract: async () => { checks++; return { ok: true, value: { protocol: 'single-parser-v1', acceptsSelections } } },
    beginAdd: async () => ({ ok: true, value: { kind: 'selection', requestId: 'pending', selectionRequired: true, candidates: [] } }),
    completeAdd: async () => { completions++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
    cancelAdd: async () => ({ ok: true, value: { kind: 'cancelled' } }),
  })
  const disposeRemote = await client.apply(host.ctx)
  try {
    const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
    const signal = new AbortController().signal
    assert.equal((await face.beginAdd('github:owner/repo', signal)).kind, 'selection')
    acceptsSelections = false
    await assert.rejects(face.completeAdd('pending', [{ pluginId: 'demo' }], signal), /重启/)
    assert.equal(checks, 2)
    assert.equal(completions, 0)
    assert.equal((await face.cancelAdd('pending')).kind, 'cancelled')
    assert.equal(checks, 2)
  } finally { host.dispose(); await disposeRemote() }
})

for (const failure of ['network-response', 'denied-response', 'network-throw'] as const) {
  test(`实际 Client bundle 保留 ${failure} 错误，不误报需要重启`, async () => {
    const { client } = await loadClient()
    const message = failure === 'denied-response' ? 'Permission denied by owner policy' : 'Connection is offline'
    const thrown = new Error(message)
    let businessCalls = 0
    const host = createHost({
      contract: async () => {
        if (failure === 'network-throw') throw thrown
        return { ok: false, error: { code: failure === 'denied-response' ? 'gateway/interactions-forbidden' : 'gateway/internal', message } }
      },
      beginAdd: async () => { businessCalls++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
    })
    const disposeRemote = await client.apply(host.ctx)
    try {
      const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
      await assert.rejects(face.beginAdd('github:owner/repo', new AbortController().signal), error => {
        assert(error !== null && typeof error === 'object' && 'message' in error)
        assert(String(error.message).includes(message))
        assert(!String(error.message).includes('重启'))
        if (failure === 'network-throw') assert.equal(error, thrown)
        return true
      })
      assert.equal(businessCalls, 0)
    } finally { host.dispose(); await disposeRemote() }
  })
}

test('实际 Client bundle 已取消的安装请求不发送契约或业务 RPC', async () => {
  const { client } = await loadClient()
  let calls = 0
  const host = createHost({
    contract: async () => { calls++; return { ok: true, value: { protocol: 'single-parser-v1', acceptsSelections: true } } },
    beginAdd: async () => { calls++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
    completeAdd: async () => { calls++; return { ok: true, value: { kind: 'installed', plugins: [] } } },
  })
  const disposeRemote = await client.apply(host.ctx)
  try {
    const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
    const controller = new AbortController()
    const reason = new Error('Install was cancelled')
    controller.abort(reason)
    const cancelled = (error: unknown) => { assert.equal(error, reason); return true }
    await assert.rejects(face.beginAdd('github:owner/repo', controller.signal), cancelled)
    await assert.rejects(face.completeAdd('pending', [{ pluginId: 'demo' }], controller.signal), cancelled)
    await assert.rejects(face.uploadArchive({ name: 'plugin.zip', size: 128 } as File, controller.signal), cancelled)
    assert.equal(calls, 0)
  } finally { host.dispose(); await disposeRemote() }
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
    useId: () => memo(() => `test-id-${cursor}`, []),
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
    unmount: () => {
      for (const cleanup of cleanups.values()) cleanup()
      cleanups.clear()
      records.length = 0
      effects = []
      cursor = 0
      dirty = false
      tree = null
      render = () => null
    },
  }
}

function nodes(tree: unknown): RenderNode[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (tree === null || typeof tree !== 'object' || !('props' in tree)) return []
  const node = tree as RenderNode
  return [node, ...nodes(node.props.children)]
}

function textContent(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textContent).join('')
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (tree === null || typeof tree !== 'object' || !('props' in tree)) return ''
  return textContent((tree as RenderNode).props.children)
}

function interpolate(t: (key: string) => string) {
  return (key: string, values: Record<string, string | number> = {}) => Object.entries(values)
    .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(key))
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

test('实际 Client bundle 展开诊断后显示明确详情并保留可选文本', async () => {
  const hooks = createHookRuntime()
  const copied: string[] = []
  const { client } = await loadClient(hooks.react, {
    navigator: { clipboard: { writeText: async (value: string) => { copied.push(value) } } },
  })
  const diagnosed: CompatWebPlugin = {
    ...runtimePlugin,
    warnings: 1,
    diagnostics: [{
      level: 'warning', code: 'AGENT_PLUGIN_EXTENSIONS_IGNORED', capability: 'plugin',
      message: 'Agent Plugins 未实现的扩展命名空间已忽略：com.openai', file: 'plugin.json',
      details: '{\n  "namespaces": [\n    "com.openai"\n  ]\n}',
    }],
  }
  const host = createHost({
    list: async () => ({ ok: true, value: { kind: 'ready', plugins: [diagnosed], categories: [] } }),
    checkUpdates: async () => ({ ok: true, value: { kind: 'ready', updates: [] } }),
  })
  const disposeRemote = await client.apply(host.ctx)
  const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
  let tree = await hooks.mount(client.PluginBridgePanel as (props: unknown) => unknown, { ...face, t: host.ctx.locale.bind(client.NS) })
  hooks.unmount()
  tree = await hooks.mount((client as ClientModule).PluginRow as (props: unknown) => unknown, {
    plugin: diagnosed, categories: [], resolveText: (label: { en: string; zh?: string }) => label.zh ?? label.en,
    pending: null, error: null, busy: false, expanded: true, onExpand: () => {}, onToggle: () => {},
    onUpdate: () => {}, onRemove: () => {}, t: interpolate(host.ctx.locale.bind(client.NS)),
  })
  assert(nodes(tree).some(node => node.props.children === 'Agent Plugins 未实现的扩展命名空间已忽略：com.openai'))
  const details = nodes(tree).find(node => node.type === 'pre')
  assert(details, 'expanded diagnostic must retain a preformatted details block')
  assert.equal(details.props.children, `详情：${diagnosed.diagnostics[0].details}`)
  const copy = nodes(tree).find(node => node.type === 'button' && node.props.children === '复制此条诊断')
  assert(copy, 'expanded diagnostic must offer copying its full contents')
  assert.equal(typeof copy.props.onClick, 'function')
  ;(copy.props.onClick as () => void)()
  tree = await hooks.flush()
  assert.equal(copied.length, 1)
  assert(copied[0].includes(diagnosed.diagnostics[0].code))
  assert(copied[0].includes(diagnosed.diagnostics[0].message))
  assert(copied[0].includes(diagnosed.diagnostics[0].file!))
  assert(copied[0].includes(diagnosed.diagnostics[0].details!))
  assert(nodes(tree).some(node => node.props.role === 'status' && node.props.children === '已复制'))
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

for (const selectionRequired of [true, false]) {
  test(selectionRequired
    ? '实际 Client bundle 上传单候选市场先展示选择，用户勾选提交后仅安装一次'
    : '实际 Client bundle 上传独立单插件保留自动提交且仅安装一次', async () => {
    const hooks = createHookRuntime()
    const { client } = await loadClient(hooks.react)
    const candidate: CompatWebCandidate = {
      id: 'uploaded-only', name: 'Uploaded plugin', formats: ['future-a'],
      installable: true, errors: 0, warnings: 1, source: './plugins/uploaded-only',
      diagnostics: [{ level: 'warning', code: 'CATALOG_NOTICE', capability: 'source', message: 'Catalog entry warning', file: 'nested/marketplace.json' }],
    }
    const preparation: CompatWebAddResult = {
      kind: 'selection', requestId: 'upload-request', selectionRequired, candidates: [candidate],
    }
    const added: CompatWebPlugin = { ...runtimePlugin, id: candidate.id, name: candidate.name }
    const uploads: { file: File; signal: AbortSignal }[] = []
    const completions: { requestId: string; plugins: PluginInstallSelection[]; signal: AbortSignal }[] = []
    const cancellations: string[] = []
    const installed: CompatWebPlugin[][] = []
    let closed = 0
    const host = createHost({
      list: async () => ({ ok: true, value: { kind: 'ready', plugins: [], categories: runtimeCategories } }),
      checkUpdates: async () => ({ ok: true, value: { kind: 'ready', updates: [] } }),
      beginAdd: async () => { throw new Error('file selection must use uploadArchive') },
      completeAdd: async (requestId: string, plugins: PluginInstallSelection[], signal: AbortSignal) => {
        completions.push({ requestId, plugins: Array.from(plugins, plugin => ({ ...plugin })), signal })
        return { ok: true, value: { kind: 'installed', plugins: [added] } }
      },
      cancelAdd: async (requestId: string) => {
        cancellations.push(requestId)
        return { ok: true, value: { kind: 'cancelled' } }
      },
    })
    const disposeRemote = await client.apply(host.ctx)
    try {
      const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
      let tree = await hooks.mount(client.PluginBridgePanel as (props: unknown) => unknown, {
        ...face,
        uploadArchive: async (file: File, signal: AbortSignal): Promise<CompatWebAddResult> => {
          uploads.push({ file, signal })
          return preparation
        },
        t: interpolate(host.ctx.locale.bind(client.NS)),
      })
      const add = nodes(tree).find(node => node.props['data-plugin-bridge-add'] !== undefined)
      assert(add)
      assert.equal(add.props.disabled, false)
      ;(add.props.onClick as () => void)()
      tree = await hooks.flush()
      const dialog = propNode(tree, 'onInstalled')
      assert.equal(typeof dialog.type, 'function')
      hooks.unmount()
      tree = await hooks.mount(dialog.type as (props: unknown) => unknown, {
        ...dialog.props,
        onInstalled: (plugins: CompatWebPlugin[]) => { installed.push(Array.from(plugins)) },
        onClose: () => { closed++ },
      })
      const file = { name: 'plugin.zip', size: 128 } as File
      const picker = nodes(tree).find(node => node.type === 'input' && node.props.type === 'file')
      assert(picker)
      ;(picker.props.onChange as (event: unknown) => void)({ currentTarget: { files: [file] } })
      tree = await hooks.flush()
      const submit = (current: unknown) => {
        const button = nodes((current as RenderNode).props.footer).find(node => node.props.variant === 'primary')
        assert(button)
        assert.equal(button.props.disabled, false)
        // A rapid repeated click must share the in-flight action.
        ;(button.props.onClick as () => void)()
        ;(button.props.onClick as () => void)()
      }
      submit(tree)
      tree = await hooks.flush()
      assert.equal(uploads.length, 1)
      assert.equal(uploads[0].file, file)
      assert.equal(uploads[0].signal.aborted, false)

      if (selectionRequired) {
        assert.equal(completions.length, 0)
        assert.equal(installed.length, 0)
        assert.equal(closed, 0)
        assert.equal((tree as RenderNode).props.title, '选择要添加的插件')
        assert(textContent(tree).includes('插件位置：./plugins/uploaded-only'))
        assert(textContent(tree).includes('CATALOG_NOTICE'))
        assert(textContent(tree).includes('Catalog entry warning'))
        assert(textContent(tree).includes('nested/marketplace.json'))
        const checkbox = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')
        assert(checkbox)
        assert.equal(checkbox.props.checked, false)
        assert.equal(checkbox.props.disabled, false)
        const beforeSelection = nodes((tree as RenderNode).props.footer).find(node => node.props.variant === 'primary')
        assert.equal(beforeSelection?.props.disabled, true)
        ;(checkbox.props.onChange as () => void)()
        tree = await hooks.flush()
        assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')?.props.checked, true)
        submit(tree)
        tree = await hooks.flush()
      }

      assert.equal(completions.length, 1)
      assert.equal(completions[0].requestId, preparation.requestId)
      assert.deepEqual(completions[0].plugins, [{ pluginId: candidate.id }])
      assert.equal(completions[0].signal.aborted, false)
      assert.deepEqual(installed, [[added]])
      assert.equal(closed, 1)
      assert.deepEqual(cancellations, [])
    } finally {
      hooks.unmount()
      host.dispose()
      await disposeRemote()
    }
  })
}


type AddFlowApi = Pick<PluginBridgeInjected, 'beginAdd' | 'completeAdd' | 'cancelAdd' | 'uploadArchive'>

async function mountAddFlow(overrides: Partial<AddFlowApi>) {
  const hooks = createHookRuntime()
  const { client } = await loadClient(hooks.react)
  const installed: CompatWebPlugin[][] = []
  let closed = 0
  const api: AddFlowApi = {
    beginAdd: async () => ({ kind: 'error', message: 'unexpected beginAdd' }),
    completeAdd: async () => ({ kind: 'error', message: 'unexpected completeAdd' }),
    cancelAdd: async () => ({ kind: 'cancelled' }),
    uploadArchive: async () => ({ kind: 'error', message: 'unexpected uploadArchive' }),
    ...overrides,
  }
  const host = createHost({
    list: async () => ({ ok: true, value: { kind: 'ready', plugins: [], categories: [] } }),
    checkUpdates: async () => ({ ok: true, value: { kind: 'ready', updates: [] } }),
    beginAdd: async (...args: Parameters<AddFlowApi['beginAdd']>) => ({ ok: true, value: await api.beginAdd(...args) }),
    completeAdd: async (...args: Parameters<AddFlowApi['completeAdd']>) => ({ ok: true, value: await api.completeAdd(...args) }),
    cancelAdd: async (...args: Parameters<AddFlowApi['cancelAdd']>) => ({ ok: true, value: await api.cancelAdd(...args) }),
  })
  const disposeRemote = await client.apply(host.ctx)
  const face = host.entries.find(entry => entry.options.name === 'main')!.options.inject!()
  let tree = await hooks.mount(client.PluginBridgePanel as (props: unknown) => unknown, {
    ...face, uploadArchive: api.uploadArchive, t: interpolate(host.ctx.locale.bind(client.NS)),
  })
  ;(nodes(tree).find(node => node.props['data-plugin-bridge-add'] !== undefined)!.props.onClick as () => void)()
  tree = await hooks.flush()
  const dialog = propNode(tree, 'onInstalled')
  hooks.unmount()
  tree = await hooks.mount(dialog.type as (props: unknown) => unknown, {
    ...dialog.props,
    onInstalled: (plugins: CompatWebPlugin[]) => { installed.push(Array.from(plugins)) },
    onClose: () => { closed++ },
  })
  const primary = (current: unknown) => nodes((current as RenderNode).props.footer).find(node => node.props.variant === 'primary')!
  return {
    tree, hooks, host, installed, primary, closed: () => closed,
    submit: (current: unknown) => {
      const button = primary(current)
      assert.equal(button.props.disabled, false)
      ;(button.props.onClick as () => void)()
      ;(button.props.onClick as () => void)()
    },
    enterSource: async () => {
      ;(propNode(tree, 'placeholder').props.onChange as (event: unknown) => void)({ currentTarget: { value: 'github:fixture/tools' } })
      return hooks.flush()
    },
    dispose: async () => { hooks.unmount(); host.dispose(); await disposeRemote() },
  }
}

function parserMatch(parserId: string, overrides: Partial<CompatWebParserMatch> = {}): CompatWebParserMatch {
  return { parserId, label: { en: `Third party ${parserId}`, zh: `第三方 ${parserId}` }, available: true,
    evidence: [{ kind: 'manifest', file: `${parserId}/plugin.json` }], diagnostics: [], ...overrides }
}

for (const secondAvailable of [true, false]) {
  test(`实际 Client bundle 单插件多解析器不默认选择（第二项${secondAvailable ? '可用' : '未装配'}），显示通用依据与阻断诊断`, async () => {
    const choices: CompatWebParserChoiceRequest[] = [{ pluginId: 'tool', name: 'Third party tool', matches: [
      parserMatch('future-a'),
      parserMatch('future-b', { available: secondAvailable, evidence: [{ kind: 'catalog', file: 'future/catalog.json' }] }),
      parserMatch('policy-blocked', { evidence: [{ kind: 'implicit' }], diagnostics: [{
        level: 'error', code: 'FUTURE_POLICY', capability: 'plugin', message: 'Host policy blocks this parser',
        file: 'policy.json', details: '{"reason":"explicit policy"}',
      }] }),
    ] }]
    const completions: { requestId: string; plugins: PluginInstallSelection[] }[] = []
    const h = await mountAddFlow({
      beginAdd: async () => ({ kind: 'parser-selection', requestId: 'same-request', plugins: choices }),
      completeAdd: async (requestId, plugins) => {
        completions.push({ requestId, plugins: Array.from(plugins, plugin => ({ ...plugin })) })
        return { kind: 'installed', plugins: [runtimePlugin] }
      },
    })
    try {
      let tree = await h.enterSource()
      h.submit(tree)
      tree = await h.hooks.flush()
      assert.equal((tree as RenderNode).props.title, '为每个插件选择解析器')
      const radios = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'radio')
      assert.equal(radios.length, 3)
      assert(radios.every(node => node.props.checked === false))
      assert.equal(radios[0].props.name, radios[1].props.name)
      assert.equal(radios[0].props.disabled, false)
      assert.equal(radios[1].props.disabled, !secondAvailable)
      assert.equal(radios[2].props.disabled, true)
      assert.equal(h.primary(tree).props.disabled, true)
      assert.equal(completions.length, 0)
      for (const text of ['第三方 future-a', '匹配依据：插件清单', '匹配依据：市场声明', '匹配依据：目录内容', 'future-a/plugin.json', 'future/catalog.json', 'FUTURE_POLICY', 'Host policy blocks this parser', 'explicit policy']) {
        assert(textContent(tree).includes(text), `missing generic parser detail: ${text}`)
      }
      h.host.setLanguage('en')
      tree = await h.hooks.refresh()
      assert(textContent(tree).includes('Third party future-a'))
      const chosen = secondAvailable ? 'future-b' : 'future-a'
      ;(nodes(tree).find(node => node.props.value === chosen)!.props.onChange as () => void)()
      tree = await h.hooks.flush()
      assert.equal(nodes(tree).filter(node => node.props.type === 'radio' && node.props.checked === true).length, 1)
      h.submit(tree)
      tree = await h.hooks.flush()
      assert.deepEqual(completions, [{ requestId: 'same-request', plugins: [{ pluginId: 'tool', parserId: chosen }] }])
      assert.equal(h.installed.length, 1)
      assert.equal(h.closed(), 1)
    } finally { await h.dispose() }
  })
}

test('实际 Client bundle 市场多插件逐项选解析器，重试保留选择并续传唯一匹配插件', async () => {
  const candidates: CompatWebCandidate[] = ['alpha', 'beta'].map(id => ({
    id, name: id, formats: ['future-a'], installable: true, errors: 1, warnings: 0, source: `./${id}`,
    diagnostics: [{ level: 'error', code: 'OTHER_PARSER_POLICY', capability: 'plugin', message: 'Another parser is blocked' }],
  }))
  const choices: CompatWebParserChoiceRequest[] = [
    { pluginId: 'alpha', name: 'Alpha', matches: [parserMatch('future-a'), parserMatch('future-b')] },
    { pluginId: 'beta', name: 'Beta', matches: [parserMatch('future-c')] },
  ]
  const calls: { requestId: string; plugins: PluginInstallSelection[] }[] = []
  let fail = true
  const h = await mountAddFlow({
    beginAdd: async () => ({ kind: 'selection', requestId: 'market-request', selectionRequired: true, candidates }),
    completeAdd: async (requestId, plugins) => {
      calls.push({ requestId, plugins: Array.from(plugins, plugin => ({ ...plugin })) })
      if (plugins.some(plugin => plugin.parserId === undefined)) return { kind: 'parser-selection', requestId, plugins: choices }
      if (fail) { fail = false; return { kind: 'error', message: 'Retry this snapshot' } }
      return { kind: 'installed', plugins: [runtimePlugin] }
    },
  })
  try {
    let tree = await h.enterSource()
    h.submit(tree)
    tree = await h.hooks.flush()
    for (const checkbox of nodes(tree).filter(node => node.props.type === 'checkbox')) (checkbox.props.onChange as () => void)()
    tree = await h.hooks.flush()
    h.submit(tree)
    tree = await h.hooks.flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].plugins, [{ pluginId: 'alpha' }, { pluginId: 'beta' }])
    const radios = nodes(tree).filter(node => node.props.type === 'radio')
    assert.equal(radios.find(node => node.props.value === 'future-c')?.props.checked, true)
    assert.equal(radios.find(node => node.props.value === 'future-a')?.props.checked, false)
    assert.equal(h.primary(tree).props.disabled, true)
    ;(radios.find(node => node.props.value === 'future-b')!.props.onChange as () => void)()
    tree = await h.hooks.flush()
    h.submit(tree)
    tree = await h.hooks.flush()
    assert(textContent(tree).includes('Retry this snapshot'))
    assert.equal(h.closed(), 0)
    assert.equal(nodes(tree).filter(node => node.props.type === 'radio' && node.props.checked === true).length, 2)
    h.submit(tree)
    await h.hooks.flush()
    const full = [{ pluginId: 'alpha', parserId: 'future-b' }, { pluginId: 'beta', parserId: 'future-c' }]
    assert.deepEqual(calls.slice(1), [
      { requestId: 'market-request', plugins: full }, { requestId: 'market-request', plugins: full },
    ])
    assert.equal(h.installed.length, 1)
    assert.equal(h.closed(), 1)
  } finally { await h.dispose() }
})

test('实际 Client bundle 解析器选择取消失败可重试，成功释放原请求并返回输入', async () => {
  const cancellations: string[] = []
  let fail = true
  const h = await mountAddFlow({
    beginAdd: async () => ({ kind: 'parser-selection', requestId: 'cancel-request', plugins: [
      { pluginId: 'tool', name: 'Tool', matches: [parserMatch('future-a'), parserMatch('future-b')] },
    ] }),
    cancelAdd: async requestId => {
      cancellations.push(requestId)
      if (fail) { fail = false; return { kind: 'error', message: 'Release temporarily failed' } }
      return { kind: 'cancelled' }
    },
  })
  try {
    let tree = await h.enterSource()
    h.submit(tree)
    tree = await h.hooks.flush()
    const changeSource = () => (nodes(tree).find(node => node.props.children === '更换来源')!.props.onClick as () => void)()
    changeSource()
    tree = await h.hooks.flush()
    assert(textContent(tree).includes('Release temporarily failed'))
    assert.equal((tree as RenderNode).props.title, '为每个插件选择解析器')
    changeSource()
    tree = await h.hooks.flush()
    assert.equal((tree as RenderNode).props.title, '添加外部插件')
    assert.deepEqual(cancellations, ['cancel-request', 'cancel-request'])
    assert.equal(h.installed.length, 0)
  } finally { await h.dispose() }
  assert.equal(cancellations.length, 2)
})

test('实际 Client bundle 独立归档自动续传可进入解析器选择，确认使用同请求且不重复上传', async () => {
  let uploads = 0
  const calls: PluginInstallSelection[][] = []
  const h = await mountAddFlow({
    uploadArchive: async () => {
      uploads++
      return { kind: 'selection', requestId: 'archive-request', selectionRequired: false, candidates: [{
        id: 'archive-tool', name: 'Archive tool', formats: ['future-a', 'future-b'], installable: true,
        errors: 1, warnings: 0, source: './', diagnostics: [{ level: 'error', code: 'OTHER_PARSER_POLICY', capability: 'plugin', message: 'Another parser is blocked' }],
      }] }
    },
    completeAdd: async (requestId, plugins) => {
      assert.equal(requestId, 'archive-request')
      calls.push(Array.from(plugins, plugin => ({ ...plugin })))
      return plugins[0].parserId === undefined
        ? { kind: 'parser-selection', requestId, plugins: [{ pluginId: 'archive-tool', name: 'Archive tool', matches: [parserMatch('future-a'), parserMatch('future-b')] }] }
        : { kind: 'installed', plugins: [runtimePlugin] }
    },
  })
  try {
    let tree = h.tree
    ;(nodes(tree).find(node => node.props.type === 'file')!.props.onChange as (event: unknown) => void)({ currentTarget: { files: [{ name: 'tools.zip', size: 128 }] } })
    tree = await h.hooks.flush()
    h.submit(tree)
    tree = await h.hooks.flush()
    assert.equal(uploads, 1)
    assert.deepEqual(calls, [[{ pluginId: 'archive-tool' }]])
    assert.equal((tree as RenderNode).props.title, '为每个插件选择解析器')
    assert.equal(h.primary(tree).props.disabled, true)
    ;(nodes(tree).find(node => node.props.value === 'future-b')!.props.onChange as () => void)()
    tree = await h.hooks.flush()
    h.submit(tree)
    await h.hooks.flush()
    assert.equal(uploads, 1)
    assert.deepEqual(calls, [[{ pluginId: 'archive-tool' }], [{ pluginId: 'archive-tool', parserId: 'future-b' }]])
    assert.equal(h.installed.length, 1)
  } finally { await h.dispose() }
})
