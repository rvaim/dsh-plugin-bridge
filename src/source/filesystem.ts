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

/** 创建父目录并以 O_EXCL 写入文件，拒绝覆盖已存在的路径。 */
export async function writeExclusive(path: string, data: Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}
