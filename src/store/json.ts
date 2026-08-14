import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function readJsonFile<T>(file: string): Promise<T> {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text) as T
}

/** 先写同目录临时文件，再 rename，避免进程中断留下半个 JSON。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = join(dirname(file), `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
