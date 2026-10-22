import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadLocalArchive } from '../../src/web/client/local-archive.js'
import { MAX_PLUGIN_ARCHIVE_BYTES } from '../../src/shared/archive-input.js'

const prepared = { kind: 'selection', requestId: 'prepared-file', selectionRequired: true, candidates: [{ id: 'local-tools', name: 'Local tools', formats: ['custom-parser'], installable: true, errors: 0, warnings: 0, source: './tools', diagnostics: [] }] }

test('本地选择以原始 File 同源上传，保留部署前缀与跨平台文件名', async () => {
  const file = new File(['archive-bytes'], '本地 tools.TAR.GZ', { type: 'application/gzip' })
  Object.defineProperty(file, 'arrayBuffer', { value() { throw new Error('Do not buffer the complete browser file') } })
  const controller = new AbortController()
  let calls = 0
  const fetcher: typeof fetch = async (input, init) => {
    calls++
    const url = new URL(String(input))
    assert.equal(url.pathname, '/profile/web/api/plugin-bridge/upload')
    assert.equal(url.searchParams.get('name'), file.name)
    assert.equal(init?.body, file)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.signal, controller.signal)
    assert.equal(new Headers(init?.headers).get('x-plugin-archive-size'), String(file.size))
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/octet-stream')
    return Response.json(prepared)
  }
  assert.deepEqual(await uploadLocalArchive(file, controller.signal, fetcher, 'https://dsh.example/profile/web/'), prepared)
  assert.equal(calls, 1)
})

test('无效、空、过大文件及提前取消均不发上传请求', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(prepared) }
  for (const file of [new File(['x'], 'not-an-archive.exe'), new File([], 'empty.zip')]) {
    await assert.rejects(uploadLocalArchive(file, new AbortController().signal, fetcher, 'https://dsh.example/'))
  }
  const large = new File(['x'], 'large.zip')
  Object.defineProperty(large, 'size', { value: MAX_PLUGIN_ARCHIVE_BYTES + 1 })
  await assert.rejects(uploadLocalArchive(large, new AbortController().signal, fetcher, 'https://dsh.example/'), /30 MiB/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(uploadLocalArchive(new File(['x'], 'local.zip'), cancelled.signal, fetcher, 'https://dsh.example/'))
  assert.equal(calls, 0)
})

test('上传 HTTP 错误和非法结果可恢复，返回结果必须通过现有严格 Schema', async () => {
  const file = new File(['archive'], 'local.zip')
  const signal = new AbortController().signal
  await assert.rejects(uploadLocalArchive(file, signal, async () => Response.json({ kind: 'error', message: '上传超过预算' }, { status: 413 }), 'https://dsh.example/'), /上传超过预算/)
  await assert.rejects(uploadLocalArchive(file, signal, async () => new Response('Authentication required', { status: 401 }), 'https://dsh.example/'), /401/)
  await assert.rejects(uploadLocalArchive(file, signal, async () => Response.json({ kind: 'selection', requestId: 'missing-candidates' }), 'https://dsh.example/'), /响应无效/)
  const result = await uploadLocalArchive(file, signal, async () => Response.json({ kind: 'error', message: '归档未包含支持的插件' }), 'https://dsh.example/')
  assert.deepEqual(result, { kind: 'error', message: '归档未包含支持的插件' })
})
