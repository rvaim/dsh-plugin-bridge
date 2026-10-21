import type { CompatWebAddResult } from '../../types/web.js'
import { PLUGIN_ARCHIVE_UPLOAD_PATH } from '../../types/upload.js'
import { MAX_PLUGIN_ARCHIVE_BYTES, pluginArchiveSuffix } from '../../shared/archive-input.js'
import remote from '@rvaim/dsh-plugin-bridge/remote'

/** Standard File/Blob upload: browser-native picker and transfer work on every supported desktop OS. */
export async function uploadLocalArchive(
  file: File,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
  base = document.baseURI,
): Promise<CompatWebAddResult> {
  if (pluginArchiveSuffix(file.name) === undefined) throw new Error('请选择 ZIP、TAR 或 TGZ 归档')
  if (file.size <= 0 || file.size > MAX_PLUGIN_ARCHIVE_BYTES) throw new Error('归档为空或超过 30 MiB 限制')
  signal.throwIfAborted()
  const url = new URL(PLUGIN_ARCHIVE_UPLOAD_PATH.replace(/^\//, ''), base)
  url.searchParams.set('name', file.name)
  const response = await fetcher(url, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/octet-stream', 'x-plugin-archive-size': String(file.size) },
    body: file,
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
      ? body.message : `文件上传失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  // The route returns the same domain result as beginAdd; use the generated strict schema.
  try { return remote.methods['pluginBridgeAdmin/beginAdd'].result.create().parse(body) }
  catch { throw new Error('文件上传响应无效，请重试') }
}
