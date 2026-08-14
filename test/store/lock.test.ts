import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { acquireFileLock } from '../../src/store/lock.js'
import { temporaryDirectory } from '../helpers/temp.js'

const delay = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

test('文件锁将并发操作串行化', async () => {
  const temp = await temporaryDirectory()
  try {
    const path = resolve(temp.path, 'test.lock')
    const order: string[] = []
    const first = await acquireFileLock(path)
    const secondPromise = (async () => {
      const second = await acquireFileLock(path, { timeoutMs: 2_000, pollMs: 10 })
      order.push('second-acquired')
      await second.release()
    })()
    await delay(50)
    order.push('first-release')
    await first.release()
    await secondPromise
    assert.deepEqual(order, ['first-release', 'second-acquired'])
  } finally {
    await temp.cleanup()
  }
})

test('崩溃遗留的陈旧锁会被回收', async () => {
  const temp = await temporaryDirectory()
  try {
    const path = resolve(temp.path, 'stale.lock')
    await mkdir(temp.path, { recursive: true })
    await writeFile(path, JSON.stringify({ pid: 99999999, token: 'old', createdAt: '2000-01-01T00:00:00.000Z' }))
    const lock = await acquireFileLock(path, { timeoutMs: 500, pollMs: 5, staleMs: 1 })
    assert.equal(lock.path, path)
    await lock.release()
  } finally {
    await temp.cleanup()
  }
})

test('存活进程持有的长时锁不会因 staleMs 到期被抢占', async () => {
  const temp = await temporaryDirectory()
  try {
    const path = resolve(temp.path, 'live.lock')
    const first = await acquireFileLock(path)
    await assert.rejects(
      acquireFileLock(path, { timeoutMs: 60, pollMs: 5, staleMs: 0 }),
      /获取锁超时/,
    )
    await first.release()
  } finally {
    await temp.cleanup()
  }
})

test('刚创建但尚未写完的锁受 mtime 保护，陈旧损坏锁可回收', async () => {
  const temp = await temporaryDirectory()
  try {
    const path = resolve(temp.path, 'partial.lock')
    await writeFile(path, '')
    await assert.rejects(
      acquireFileLock(path, { timeoutMs: 50, pollMs: 5, staleMs: 10_000 }),
      /获取锁超时/,
    )

    const old = new Date(Date.now() - 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(path, old, old)
    const recovered = await acquireFileLock(path, { timeoutMs: 500, pollMs: 5, staleMs: 1_000 })
    await recovered.release()
  } finally {
    await temp.cleanup()
  }
})
