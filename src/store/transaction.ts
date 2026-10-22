import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CompatLayout } from './layout.js'

export async function createTransactionDir(layout: CompatLayout, prefix: string): Promise<string> {
  await layout.ensure()
  const path = join(layout.temp, `${prefix}-${randomUUID()}`)
  await mkdir(path, { recursive: false, mode: 0o700 })
  return path
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows 的实时扫描或索引服务会短暂占用新建目录，使 rename 偶发 EPERM。
 * 只对明确的短暂占用做有限重试；其他错误立即抛出，不掩盖真实失败。
 */
async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!RETRYABLE_RENAME.has(code ?? '') || attempt >= 4) throw error
      await delay(25 * (attempt + 1))
    }
  }
}

export async function commitDirectory(staged: string, destination: string): Promise<void> {
  await renameWithRetry(staged, destination)
}

/** 先从正式目录 rename 出去，再删除；运行层永远不会看到“删到一半”的目录。 */
export async function removeDirectoryTransactionally(
  layout: CompatLayout,
  directory: string,
  prefix = 'deleting',
): Promise<void> {
  const deleting = join(layout.temp, `${prefix}-${randomUUID()}`)
  await renameWithRetry(directory, deleting)
  await rm(deleting, { recursive: true, force: true })
}
