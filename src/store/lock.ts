import { open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CompatLayout } from './layout.js'

interface LockPayload {
  pid: number
  token: string
  createdAt: string
}

export interface LockOptions {
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
}

export interface AcquiredLock {
  path: string
  release(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function validPayload(value: unknown): value is LockPayload {
  if (value === null || typeof value !== 'object') return false
  const payload = value as Partial<LockPayload>
  return Number.isInteger(payload.pid)
    && Number(payload.pid) > 0
    && typeof payload.token === 'string'
    && payload.token.length > 0
    && typeof payload.createdAt === 'string'
}

/**
 * 只回收可以明确判定为无主的锁。
 *
 * 注意：锁持有时间超过 staleMs 并不代表锁已失效。只要记录中的进程仍存活，
 * 就必须保留该锁；否则长时间更新可能被第二个进程并发闯入。
 * 对刚创建但尚未写完 JSON 的锁文件，则使用 mtime 给写入方留出保护窗口。
 */
async function removeIfStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }

    if (validPayload(parsed)) {
      if (processExists(parsed.pid)) return false
      await rm(path, { force: true })
      return true
    }

    const info = await stat(path)
    const age = Math.max(0, Date.now() - info.mtimeMs)
    if (age <= staleMs) return false
    await rm(path, { force: true })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** 使用 O_EXCL 锁文件提供跨进程串行化，并对崩溃遗留锁做保守回收。 */
export async function acquireFileLock(path: string, options: LockOptions = {}): Promise<AcquiredLock> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollMs = options.pollMs ?? 40
  const staleMs = options.staleMs ?? 10 * 60_000
  const deadline = Date.now() + timeoutMs
  const token = randomUUID()
  const payload: LockPayload = { pid: process.pid, token, createdAt: new Date().toISOString() }

  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      let released = false
      return {
        path,
        async release(): Promise<void> {
          if (released) return
          released = true
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockPayload>
            if (current.token === token) await rm(path, { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await removeIfStale(path, staleMs)
      if (Date.now() >= deadline) throw new Error(`获取锁超时：${path}`)
      await sleep(pollMs)
    }
  }
}

function lockName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

export async function withRepositoryLock<T>(
  layout: CompatLayout,
  operation: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  await layout.ensure()
  const lock = await acquireFileLock(join(layout.locks, 'repository.lock'), options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

export async function withPluginLock<T>(
  layout: CompatLayout,
  pluginId: string,
  operation: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  await layout.ensure()
  const lock = await acquireFileLock(join(layout.locks, `plugin-${lockName(pluginId)}.lock`), options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

export async function withSourceLock<T>(
  layout: CompatLayout,
  sourceId: string,
  operation: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  await layout.ensure()
  const lock = await acquireFileLock(join(layout.locks, `source-${lockName(sourceId)}.lock`), options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

/** 按稳定顺序获取多个插件锁，避免共享 Source 更新时形成锁顺序死锁。 */
export async function withPluginLocks<T>(
  layout: CompatLayout,
  pluginIds: readonly string[],
  operation: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const ids = [...new Set(pluginIds)].sort()
  const run = async (index: number): Promise<T> => {
    if (index >= ids.length) return await operation()
    return await withPluginLock(layout, ids[index], () => run(index + 1), options)
  }
  return await run(0)
}
