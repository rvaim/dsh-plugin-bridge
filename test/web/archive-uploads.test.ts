import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import type { CompatWebAddResult } from '../../src/types/web.js'
import { ArchiveUploads } from '../../src/web/host/archive-uploads.js'
import { temporaryDirectory } from '../helpers/temp.js'

const selection: CompatWebAddResult = { kind: 'selection', requestId: 'prepared-upload', candidates: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext, options: ConstructorParameters<typeof ArchiveUploads>[0] = {}) {
  const temp = await temporaryDirectory('archive-intake-test-')
  const uploads = new ArchiveUploads({ ...options, tempParent: temp.path })
  t.after(async () => { await uploads.dispose(); await temp.cleanup() })
  return { uploads, temp }
}
function uploadRequest(options: {
  name?: string; chunks?: readonly Uint8Array[]; body?: ReadableStream<Uint8Array> | null
  headers?: HeadersInit; signal?: AbortSignal
} = {}): Request {
  const headers = new Headers({ 'content-type': 'application/octet-stream' })
  new Headers(options.headers).forEach((value, key) => { headers.set(key, value) })
  let index = 0
  const body = options.body === undefined ? new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = (options.chunks ?? [new Uint8Array([1, 2, 3])])[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }, { highWaterMark: 0 }) : options.body
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST', headers, ...(body === null ? {} : { body }), signal: options.signal, duplex: 'half',
  }
  const query = new URLSearchParams({ name: options.name ?? 'plugin.zip' })
  const request = new Request(`http://localhost/api/plugin-bridge/upload?${query}`, init)
  for (const method of ['arrayBuffer', 'blob', 'text', 'json', 'formData'] as const) {
    Object.defineProperty(request, method, { value: () => assert.fail(`intake must stream instead of Request.${method}()`) })
  }
  return request
}
async function errorResponse(response: Response, status: number): Promise<void> {
  assert.equal(response.status, status)
  assert.equal((await response.json() as CompatWebAddResult).kind, 'error')
}
function abortableGate(signal: AbortSignal, gate: Promise<void>): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    gate.then(() => { signal.removeEventListener('abort', abort); resolve() })
  })
}

for (const [name, suffix] of [
  ['C:\\fakepath\\插件.ZIP', '.zip'], ['../../browser/plugin.tar', '.tar'],
  ['plugin.TGZ', '.tgz'], ['插件 & bundle.TAR.GZ', '.tar.gz'],
] as const) {
  test(`分块上传 ${suffix} 只把受控临时文件和完整字节传给 prepare`, async (t) => {
    const { uploads, temp } = await fixture(t, { maxBytes: 8 })
    const expected = Buffer.from([0, 255, 1, 128, 2, 42, 3, 4])
    let preparedPath = ''
    const response = await uploads.handle(uploadRequest({
      name, chunks: [expected.subarray(0, 3), expected.subarray(3, 5), expected.subarray(5)],
      headers: { 'x-plugin-archive-size': String(expected.length) },
    }), async (path, signal) => {
      preparedPath = path
      assert.equal(signal.aborted, false)
      assert.notEqual(path, name)
      assert.equal(basename(path), `archive${suffix}`)
      assert.equal(dirname(dirname(await realpath(path))), await realpath(temp.path))
      assert.deepEqual(await readFile(path), expected)
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
      return selection
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), selection)
    await assert.rejects(stat(preparedPath), { code: 'ENOENT' })
    assert.deepEqual(await readdir(temp.path), [])
  })
}

test('累计超预算后取消剩余流，不调用 prepare 并清除部分文件', async (t) => {
  const { uploads, temp } = await fixture(t, { maxBytes: 5 })
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([1, 2, 3])) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  await errorResponse(await uploads.handle(uploadRequest({ body }), async () => assert.fail('oversized upload')), 413)
  assert.equal(pulls, 2)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(temp.path), [])
})

for (const [declared, actual] of [[5, 3], [2, 3]] as const) {
  test(`实际 ${actual} 字节与声明 ${declared} 不一致时拒绝并清理`, async (t) => {
    const { uploads, temp } = await fixture(t, { maxBytes: 8 })
    await errorResponse(await uploads.handle(uploadRequest({
      headers: { 'x-plugin-archive-size': String(declared) }, chunks: [new Uint8Array(actual)],
    }), async () => assert.fail('incomplete upload')), 400)
    assert.deepEqual(await readdir(temp.path), [])
  })
}

test('支持 Content-Length 声明及带参数的媒体类型', async (t) => {
  const { uploads, temp } = await fixture(t)
  const response = await uploads.handle(uploadRequest({
    headers: { 'content-length': '3', 'content-type': 'Application/Octet-Stream; charset=binary' },
  }), async path => { assert.equal((await readFile(path)).length, 3); return selection })
  assert.equal(response.status, 200)
  assert.deepEqual(await readdir(temp.path), [])
})

for (const [label, options, status] of [
  ['非归档后缀', { name: 'plugin.exe' }, 415], ['缺少名称', { name: '' }, 415],
  ['裸 gzip', { name: 'plugin.gz' }, 415], ['错误媒体类型', { headers: { 'content-type': 'application/json' } }, 415],
  ['超限声明', { headers: { 'x-plugin-archive-size': '9' } }, 413],
  ['非法大小', { headers: { 'x-plugin-archive-size': '3x' } }, 400],
  ['负数大小', { headers: { 'x-plugin-archive-size': '-1' } }, 400],
  ['不安全整数', { headers: { 'x-plugin-archive-size': '9007199254740992' } }, 400],
  ['零声明', { headers: { 'x-plugin-archive-size': '0' } }, 400],
  ['无请求体', { body: null }, 400], ['空字节流', { chunks: [] }, 400],
] as const) {
  test(`${label} 不进入 prepare 且无临时残留`, async (t) => {
    const { uploads, temp } = await fixture(t, { maxBytes: 8 })
    await errorResponse(await uploads.handle(uploadRequest(options), async () => assert.fail('invalid upload')), status)
    assert.deepEqual(await readdir(temp.path), [])
  })
}

test('已读取或已锁定的 body 不进入 prepare', async (t) => {
  const { uploads, temp } = await fixture(t)
  const used = uploadRequest()
  const usedReader = used.body!.getReader()
  await usedReader.read()
  usedReader.releaseLock()
  await errorResponse(await uploads.handle(used, async () => assert.fail('used body')), 400)
  await used.body!.cancel()
  const locked = uploadRequest()
  const reader = locked.body!.getReader()
  try { await errorResponse(await uploads.handle(locked, async () => assert.fail('locked body')), 400) }
  finally { await reader.cancel(); reader.releaseLock() }
  assert.deepEqual(await readdir(temp.path), [])
})

test('流中途失败或出现非字节块时回收部分写入', async (t) => {
  const { uploads, temp } = await fixture(t)
  for (const invalid of [false, true]) {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1]))
        else if (invalid) controller.enqueue('not bytes' as unknown as Uint8Array)
        else controller.error(new Error('input stream failed'))
      },
    }, { highWaterMark: 0 })
    await errorResponse(await uploads.handle(uploadRequest({ body }), async () => assert.fail('broken stream')), 400)
    assert.deepEqual(await readdir(temp.path), [])
  }
})

test('prepare 抛错或返回业务失败均清理临时文件，且异常不泄漏路径', async (t) => {
  const { uploads, temp } = await fixture(t)
  const response = await uploads.handle(uploadRequest(), async path => {
    assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]))
    throw new Error(`prepare failed for ${path}`)
  })
  await errorResponse(response.clone(), 400)
  const result = await response.json() as { message: string }
  assert.match(result.message, /prepare failed/)
  assert.equal(result.message.includes(temp.path), false)
  assert.deepEqual(await readdir(temp.path), [])
  const failure: CompatWebAddResult = { kind: 'error', message: 'unsupported plugin contents' }
  assert.deepEqual(await (await uploads.handle(uploadRequest(), async () => failure)).json(), failure)
  assert.deepEqual(await readdir(temp.path), [])
})

test('默认最多同时处理两个上传，完成后释放容量', async (t) => {
  const { uploads, temp } = await fixture(t)
  const started = deferred<void>()
  const gate = deferred<void>()
  let preparations = 0
  const hold = async (_path: string, signal: AbortSignal) => {
    if (++preparations === 2) started.resolve()
    await abortableGate(signal, gate.promise)
    return selection
  }
  const first = uploads.handle(uploadRequest(), hold)
  const second = uploads.handle(uploadRequest(), hold)
  await started.promise
  assert.equal((await readdir(temp.path)).length, 2)
  await errorResponse(await uploads.handle(uploadRequest(), async () => assert.fail('third concurrent upload')), 429)
  gate.resolve()
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200])
  assert.equal((await uploads.handle(uploadRequest(), async () => selection)).status, 200)
  assert.deepEqual(await readdir(temp.path), [])
})

test('请求 abort 打断未结束的流并清理部分文件，之后还能上传', async (t) => {
  const { uploads, temp } = await fixture(t)
  const requested = deferred<void>()
  const controller = new AbortController()
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(stream) { if (pulls++ === 0) stream.enqueue(new Uint8Array([1])); else requested.resolve() },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const pending = uploads.handle(uploadRequest({ body, signal: controller.signal }), async () => assert.fail('cancelled intake'))
  await requested.promise
  controller.abort(new Error('user cancelled'))
  await errorResponse(await pending, 408)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(temp.path), [])
  assert.equal((await uploads.handle(uploadRequest(), async () => selection)).status, 200)
})

test('预先取消的请求不会调用 prepare 或留下目录', async (t) => {
  const { uploads, temp } = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await errorResponse(await uploads.handle(uploadRequest({ signal: controller.signal }), async () => assert.fail('already aborted')), 408)
  assert.deepEqual(await readdir(temp.path), [])
})

test('dispose 取消 prepare、等待回收并拒绝后续上传', async (t) => {
  const { uploads, temp } = await fixture(t)
  const started = deferred<AbortSignal>()
  const never = deferred<void>()
  const pending = uploads.handle(uploadRequest(), async (_path, signal) => {
    started.resolve(signal)
    await abortableGate(signal, never.promise)
    return selection
  })
  const signal = await started.promise
  await uploads.dispose()
  assert.equal(signal.aborted, true)
  await errorResponse(await pending, 408)
  assert.deepEqual(await readdir(temp.path), [])
  await errorResponse(await uploads.handle(uploadRequest(), async () => assert.fail('disposed upload')), 503)
  await uploads.dispose()
})

test('TTL 打断停滞 body，取消 reader 并回收目录', { timeout: 5_000 }, async (t) => {
  const { uploads, temp } = await fixture(t, { timeoutMs: 40 })
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  // AbortSignal.timeout is unref'ed; keep only this test alive until it fires.
  const keepAlive = setTimeout(() => {}, 4_000)
  try {
    await errorResponse(await uploads.handle(uploadRequest({ body }), async () => assert.fail('timed out upload')), 408)
    assert.equal(cancelled, true)
    assert.deepEqual(await readdir(temp.path), [])
  } finally { clearTimeout(keepAlive) }
})

test('未完成上传的长 TTL 不阻止独立 Node 进程正常退出', { timeout: 8_000 }, async (t) => {
  const temp = await temporaryDirectory('archive-unref-test-')
  t.after(() => temp.cleanup())
  const moduleUrl = new URL('../../src/web/host/archive-uploads.js', import.meta.url).href
  const script = `
    import { ArchiveUploads } from ${JSON.stringify(moduleUrl)};
    const uploads = new ArchiveUploads({ timeoutMs: 600_000, tempParent: ${JSON.stringify(temp.path)} });
    const request = new Request('http://localhost/api/plugin-bridge/upload?name=plugin.zip', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new ReadableStream(), duplex: 'half',
    });
    void uploads.handle(request, async () => ({ kind: 'selection', requestId: 'unused', candidates: [] }));
  `
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 5_000 })
})
