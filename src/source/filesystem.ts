import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 创建父目录并以 O_EXCL 写入文件；迭代输入逐块落盘，保持背压。 */
export async function writeExclusive(
  path: string,
  data: Buffer | AsyncIterable<Uint8Array>,
  mode = 0o600,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  signal?.throwIfAborted()
  const handle = await open(path, 'wx', mode)
  try {
    signal?.throwIfAborted()
    await handle.writeFile(data, { signal })
    signal?.throwIfAborted()
  } finally {
    await handle.close()
  }
}
