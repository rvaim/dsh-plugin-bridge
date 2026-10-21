import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CompatWebAddResult } from '../../types/web.js'
import { MAX_PLUGIN_ARCHIVE_BYTES, pluginArchiveSuffix } from '../../shared/archive-input.js'

interface ActiveUpload { controller: AbortController; done: Promise<void> }
interface UploadOptions {
  maxBytes?: number
  maxConcurrent?: number
  timeoutMs?: number
  tempParent?: string
}

function json(value: CompatWebAddResult, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
class IntakeError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** Owned binary intake; only mount through Connection's authenticated owner-only streaming route. */
export class ArchiveUploads {
  private readonly active = new Set<ActiveUpload>()
  private closed = false
  constructor(private readonly options: UploadOptions = {}) {}

  async handle(request: Request, prepare: (path: string, signal: AbortSignal) => Promise<CompatWebAddResult>): Promise<Response> {
    if (this.closed) return json({ kind: 'error', message: '文件上传服务已关闭' }, 503)
    if (this.active.size >= (this.options.maxConcurrent ?? 2)) return json({ kind: 'error', message: '同时上传的文件过多，请稍后重试' }, 429)
    const suffix = pluginArchiveSuffix(new URL(request.url).searchParams.get('name') ?? '')
    if (suffix === undefined) return json({ kind: 'error', message: '请选择 ZIP、TAR 或 TGZ 归档' }, 415)
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
      return json({ kind: 'error', message: '文件上传需要二进制请求体' }, 415)
    }
    const maximum = this.options.maxBytes ?? MAX_PLUGIN_ARCHIVE_BYTES
    const length = request.headers.get('x-plugin-archive-size') ?? request.headers.get('content-length')
    const expected = length === null ? undefined : /^\d+$/.test(length) ? Number(length) : NaN
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0)) return json({ kind: 'error', message: '文件大小无效' }, 400)
    if (expected !== undefined && expected > maximum) return json({ kind: 'error', message: '文件超过上传大小限制' }, 413)
    if (request.body === null || request.body.locked || request.bodyUsed) return json({ kind: 'error', message: '上传文件为空或已读取' }, 400)

    const controller = new AbortController()
    let finish!: () => void
    const entry: ActiveUpload = { controller, done: new Promise<void>(resolve => { finish = resolve }) }
    this.active.add(entry)
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 600_000)])
    const parent = this.options.tempParent ?? tmpdir()
    let root: string | undefined
    let canonical: string | undefined
    let file: Awaited<ReturnType<typeof open>> | undefined
    const reader = request.body.getReader()
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      root = await mkdtemp(join(parent, 'dsh-plugin-upload-'))
      canonical = await realpath(root)
      const archive = join(root, `archive${suffix}`)
      file = await open(archive, 'wx', 0o600)
      let received = 0
      for (;;) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        if (!(value instanceof Uint8Array)) throw new IntakeError('文件数据无效', 400)
        received += value.byteLength
        if (received > maximum) throw new IntakeError('文件超过上传大小限制', 413)
        if (expected !== undefined && received > expected) throw new IntakeError('文件大小与声明不一致', 400)
        await file.writeFile(value)
      }
      if (received === 0 || (expected !== undefined && expected !== received)) throw new IntakeError('上传文件不完整', 400)
      await file.close()
      file = undefined
      signal.throwIfAborted()
      // The manager copies the archive into its Source before this temporary intake ends.
      const result = await prepare(archive, signal)
      return json(result.kind === 'error' ? { ...result, message: result.message.split(root).join('[上传文件]') } : result)
    } catch (error) {
      const message = signal.aborted ? '文件上传已取消或超时'
        : error instanceof Error ? error.message : '文件上传失败'
      return json({ kind: 'error', message: root === undefined ? message : message.split(root).join('[上传文件]') },
        signal.aborted ? 408 : error instanceof IntakeError ? error.status : 400)
    } finally {
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      try {
        if (file !== undefined) await file.close()
        if (root !== undefined && canonical !== undefined) {
          const actual = await realpath(root).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
          if (actual !== undefined) {
            if (actual !== canonical || dirname(actual) !== await realpath(parent) || !basename(actual).startsWith('dsh-plugin-upload-')) {
              throw new Error('Refusing unexpected upload cleanup target')
            }
            await rm(actual, { recursive: true, force: true })
          }
        }
      } finally { this.active.delete(entry); finish() }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    const operations = [...this.active]
    for (const entry of operations) entry.controller.abort(new Error('上传服务已关闭'))
    await Promise.all(operations.map(entry => entry.done))
  }
}
