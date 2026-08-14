import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CompatLayout } from './layout.js'

export async function createTransactionDir(layout: CompatLayout, prefix: string): Promise<string> {
  await layout.ensure()
  const path = join(layout.temp, `${prefix}-${randomUUID()}`)
  await mkdir(path, { recursive: false, mode: 0o700 })
  return path
}

export async function commitDirectory(staged: string, destination: string): Promise<void> {
  await rename(staged, destination)
}

/** 先从正式目录 rename 出去，再删除；运行层永远不会看到“删到一半”的目录。 */
export async function removeDirectoryTransactionally(
  layout: CompatLayout,
  directory: string,
  prefix = 'deleting',
): Promise<void> {
  const deleting = join(layout.temp, `${prefix}-${randomUUID()}`)
  await rename(directory, deleting)
  await rm(deleting, { recursive: true, force: true })
}

export async function rollbackRemove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
