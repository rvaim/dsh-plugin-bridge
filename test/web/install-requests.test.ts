import assert from 'node:assert/strict'
import test from 'node:test'
import type { InstallCompletion, InstallPreparation, InstallResult, PluginInstallSelection } from '../../src/manager/manager.js'
import { InstallRequests } from '../../src/web/host/install-requests.js'

type InstallTarget = ConstructorParameters<typeof InstallRequests>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function preparation(preparationId = 'request'): InstallPreparation {
  return { preparationId, sourceId: 'market', sourceCreated: true, selectionRequired: true, plugins: [] }
}

function installed(): InstallResult {
  const source: InstallResult['source']['source'] = {
    id: 'market',
    ownership: 'implicit',
    origin: { type: 'directory', path: '/fixture/market' },
    revision: 'revision-1',
    createdAt: '2026-10-21T00:00:00.000Z',
  }
  const scan: InstallResult['source']['scan'] = {
    parserVersion: 'fixture',
    parserSnapshot: { fingerprint: 'fixture', parsers: [] },
    scannedAt: source.createdAt,
    formats: [],
    plugins: [],
    diagnostics: [],
    marketplaceFiles: [],
    discovery: 'marketplace',
  }
  return {
    source: {
      source,
      scan,
      compat: { ...source, ...scan },
      installedPlugins: [],
      unreadablePluginIds: [],
    },
    plugins: [],
  }
}

function harness(overrides: Partial<InstallTarget> = {}, ttl = 100) {
  const completions: Array<{ preparationId: string; plugins: PluginInstallSelection[] }> = []
  const releases: string[] = []
  const result: InstallCompletion = { kind: 'installed', result: installed() }
  const requests = new InstallRequests({
    prepareInstall: source => overrides.prepareInstall?.(source) ?? Promise.resolve(preparation(source)),
    completeInstallPreparation: async (preparationId, plugins) => {
      completions.push({ preparationId, plugins })
      return overrides.completeInstallPreparation?.(preparationId, plugins) ?? result
    },
    releaseInstallPreparation: async (preparationId) => {
      releases.push(preparationId)
      await overrides.releaseInstallPreparation?.(preparationId)
    },
  }, ttl)
  return { requests, completions, releases, result }
}

test('同请求并发完成共用一次安装，取消等待安装成功且 TTL 不抢占', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred<InstallCompletion>()
  const started = deferred<void>()
  const h = harness({ completeInstallPreparation: () => {
    started.resolve()
    return gate.promise
  } })
  await h.requests.prepare('request')
  const first = h.requests.complete('request', [{ pluginId: 'alpha' }])
  const duplicate = h.requests.complete('request', [{ pluginId: 'beta' }])
  const cancelling = h.requests.cancel('request')
  await started.promise
  t.mock.timers.tick(1_000)
  assert.deepEqual(h.releases, [])
  assert.deepEqual(h.completions, [{ preparationId: 'request', plugins: [{ pluginId: 'alpha' }] }])

  gate.resolve(h.result)
  assert.deepEqual(await Promise.all([first, duplicate]), [h.result, h.result])
  await cancelling
  assert.deepEqual(h.releases, [])
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /已过期/)
  assert.equal(h.completions.length, 1)
  await h.requests.dispose()
})

test('先取消的请求阻止完成，重复取消共用一次释放', async () => {
  const gate = deferred<void>()
  const started = deferred<void>()
  const h = harness({ releaseInstallPreparation: () => {
    started.resolve()
    return gate.promise
  } })
  await h.requests.prepare('request')
  const cancelling = h.requests.cancel('request')
  const duplicate = h.requests.cancel('request')
  await started.promise
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /正在取消/)
  assert.deepEqual(h.completions, [])
  assert.deepEqual(h.releases, ['request'])
  gate.resolve()
  await Promise.all([cancelling, duplicate])
  await h.requests.cancel('request')
  assert.deepEqual(h.releases, ['request'])
  await h.requests.dispose()
})

test('安装失败保留明确的可重试状态，同请求重试成功', async () => {
  let attempts = 0
  const h = harness({ completeInstallPreparation: async () => {
    if (++attempts === 1) throw new Error('install failed')
    return { kind: 'installed', result: installed() }
  } })
  await h.requests.prepare('request')
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /install failed/)
  assert.deepEqual(h.releases, [])
  assert.deepEqual(await h.requests.complete('request', [{ pluginId: 'alpha' }]), h.result)
  assert.equal(h.completions.length, 2)
  await h.requests.dispose()
})

test('TTL 在安装期间暂停，安装失败后重新计时并释放会话', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred<InstallCompletion>()
  const started = deferred<void>()
  const released = deferred<void>()
  const h = harness({
    completeInstallPreparation: () => {
      started.resolve()
      return gate.promise
    },
    releaseInstallPreparation: async () => { released.resolve() },
  })
  await h.requests.prepare('request')
  const completion = h.requests.complete('request', [{ pluginId: 'alpha' }])
  const failed = assert.rejects(completion, /install failed/)
  await started.promise
  t.mock.timers.tick(1_000)
  assert.deepEqual(h.releases, [])
  gate.reject(new Error('install failed'))
  await failed
  t.mock.timers.tick(99)
  assert.deepEqual(h.releases, [])
  t.mock.timers.tick(1)
  await released.promise
  await h.requests.cancel('request')
  assert.deepEqual(h.releases, ['request'])
  await h.requests.dispose()
})

test('安装与取消竞争时安装失败，等待中的取消随后释放准备会话', async () => {
  const gate = deferred<InstallCompletion>()
  const started = deferred<void>()
  const h = harness({ completeInstallPreparation: () => {
    started.resolve()
    return gate.promise
  } })
  await h.requests.prepare('request')
  const completing = h.requests.complete('request', [{ pluginId: 'alpha' }]).then(
    () => assert.fail('安装应失败'),
    async (error: unknown) => {
      assert.match(String(error), /install failed/)
      await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /正在取消|已过期/)
    },
  )
  const cancelling = h.requests.cancel('request')
  await started.promise
  assert.deepEqual(h.releases, [])
  gate.reject(new Error('install failed'))
  await Promise.all([completing, cancelling])
  assert.deepEqual(h.releases, ['request'])
  assert.equal(h.completions.length, 1)
  await h.requests.dispose()
})

test('取消失败保留会话，可重试取消且不会重新安装', async () => {
  let attempts = 0
  const h = harness({ releaseInstallPreparation: async () => {
    if (++attempts === 1) throw new Error('release failed')
  } })
  await h.requests.prepare('request')
  await assert.rejects(h.requests.cancel('request'), /release failed/)
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /正在取消/)
  await h.requests.cancel('request')
  assert.deepEqual(h.releases, ['request', 'request'])
  assert.deepEqual(h.completions, [])
  await h.requests.dispose()
})

test('TTL 释放失败可在关闭时报告，并可再次关闭重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failing = true
  const attempted = deferred<void>()
  const h = harness({ releaseInstallPreparation: async () => {
    attempted.resolve()
    if (failing) throw new Error('release failed')
  } })
  await h.requests.prepare('request')
  t.mock.timers.tick(100)
  await attempted.promise
  await assert.rejects(h.requests.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /未能释放全部安装准备会话/)
    assert.match(String(error.errors[0]), /release failed/)
    return true
  })
  failing = false
  await h.requests.dispose()
  assert.ok(h.releases.length >= 2)
})

test('dispose 等待正在进行的安装，成功会话不再释放并拒绝新请求', async () => {
  const gate = deferred<InstallCompletion>()
  const started = deferred<void>()
  const h = harness({ completeInstallPreparation: () => {
    started.resolve()
    return gate.promise
  } })
  await h.requests.prepare('request')
  const completion = h.requests.complete('request', [{ pluginId: 'alpha' }])
  await started.promise
  let disposed = false
  const closing = h.requests.dispose().then(() => { disposed = true })
  await assert.rejects(h.requests.prepare('new'), /已关闭/)
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /已关闭/)
  assert.equal(disposed, false)
  assert.deepEqual(h.releases, [])
  gate.resolve(h.result)
  await Promise.all([completion, closing])
  assert.equal(disposed, true)
  assert.deepEqual(h.releases, [])
})

test('dispose 等待安装失败后释放该会话及其他未完成请求', async () => {
  const gate = deferred<InstallCompletion>()
  const started = deferred<void>()
  const h = harness({ completeInstallPreparation: () => {
    started.resolve()
    return gate.promise
  } })
  await h.requests.prepare('installing')
  await h.requests.prepare('pending')
  const completion = assert.rejects(h.requests.complete('installing', [{ pluginId: 'alpha' }]), /install failed/)
  await started.promise
  const closing = h.requests.dispose()
  gate.reject(new Error('install failed'))
  await Promise.all([completion, closing])
  assert.deepEqual(h.releases.sort(), ['installing', 'pending'])
})

test('dispose 等待尚未返回的 prepare，并释放关闭期间到达的会话', async () => {
  const gate = deferred<InstallPreparation>()
  const started = deferred<void>()
  const h = harness({ prepareInstall: () => {
    started.resolve()
    return gate.promise
  } })
  const preparing = assert.rejects(h.requests.prepare('request'), /已关闭/)
  await started.promise
  let disposed = false
  const closing = h.requests.dispose().then(() => { disposed = true })
  assert.equal(disposed, false)
  assert.deepEqual(h.releases, [])
  gate.resolve(preparation())
  await Promise.all([preparing, closing])
  assert.deepEqual(h.releases, ['request'])
})


test('解析器选择保留同一会话，并用完整对象选择继续安装', async () => {
  const choice: InstallCompletion = { kind: 'parser-selection', plugins: [{
    pluginId: 'alpha', name: 'Alpha', matches: [
      { parserId: 'third-party-a', label: { en: 'Third party A' }, available: true, evidence: [{ kind: 'implicit' }], diagnostics: [] },
      { parserId: 'third-party-b', label: { en: 'Third party B' }, available: true, evidence: [{ kind: 'manifest', file: 'custom.json' }], diagnostics: [] },
    ],
  }] }
  let attempts = 0
  const h = harness({ completeInstallPreparation: async () => ++attempts === 1 ? choice : { kind: 'installed', result: installed() } })
  await h.requests.prepare('request')
  assert.deepEqual(await h.requests.complete('request', [{ pluginId: 'alpha' }]), choice)
  assert.deepEqual(h.releases, [])
  const plugins = [{ pluginId: 'alpha', parserId: 'third-party-b' }]
  const completion = h.requests.complete('request', plugins)
  plugins[0].parserId = 'mutated-after-submit'
  assert.deepEqual(await completion, h.result)
  assert.deepEqual(h.completions, [
    { preparationId: 'request', plugins: [{ pluginId: 'alpha' }] },
    { preparationId: 'request', plugins: [{ pluginId: 'alpha', parserId: 'third-party-b' }] },
  ])
  await h.requests.dispose()
  assert.deepEqual(h.releases, [])
})

test('返回解析器选择后重新计算 TTL，过期仍释放准备会话', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const released = deferred<void>()
  const h = harness({
    completeInstallPreparation: async () => ({ kind: 'parser-selection', plugins: [] }),
    releaseInstallPreparation: async () => { released.resolve() },
  })
  await h.requests.prepare('request')
  t.mock.timers.tick(90)
  assert.equal((await h.requests.complete('request', [{ pluginId: 'alpha' }])).kind, 'parser-selection')
  t.mock.timers.tick(99)
  assert.deepEqual(h.releases, [])
  t.mock.timers.tick(1)
  await released.promise
  await h.requests.cancel('request')
  assert.deepEqual(h.releases, ['request'])
  await assert.rejects(h.requests.complete('request', [{ pluginId: 'alpha' }]), /已过期/)
  await h.requests.dispose()
})

for (const action of ['cancel', 'dispose'] as const) {
  test(`${action} 等待安装检查返回解析器选择后释放一次会话`, async () => {
    const gate = deferred<InstallCompletion>()
    const started = deferred<void>()
    const h = harness({ completeInstallPreparation: () => { started.resolve(); return gate.promise } })
    await h.requests.prepare('request')
    const completion = h.requests.complete('request', [{ pluginId: 'alpha' }])
    const duplicate = h.requests.complete('request', [{ pluginId: 'beta' }])
    await started.promise
    const closing = action === 'cancel' ? h.requests.cancel('request') : h.requests.dispose()
    const secondClosing = action === 'cancel' ? h.requests.cancel('request') : h.requests.dispose()
    assert.deepEqual(h.releases, [])
    gate.resolve({ kind: 'parser-selection', plugins: [] })
    assert.equal((await completion).kind, 'parser-selection')
    assert.equal(await duplicate, await completion)
    await Promise.all([closing, secondClosing])
    assert.deepEqual(h.releases, ['request'])
    assert.equal(h.completions.length, 1)
    await h.requests.dispose()
  })
}
