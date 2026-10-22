import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
}

interface ProcessStreams {
  stdin: Writable
  stdout: Readable
  signal: AbortSignal
}

/** 取消时先终止整棵进程树；调用者只能在进程和读写操作全部结束后取得结果。 */
export async function runStreamingProcess<T>(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
  consume: (streams: ProcessStreams) => Promise<T>,
): Promise<{ value: T; stderr: string; exitCode: number }> {
  options.signal?.throwIfAborted()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  const controller = new AbortController()
  const errors: Buffer[] = []
  let errorBytes = 0
  let failure: unknown
  let termination: Promise<void> | undefined
  // 防止非零退出或取消同时关闭 stdin 时产生未处理的 EPIPE。
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = 1024 * 1024 - errorBytes
    if (remaining > 0) {
      const data = Buffer.from(chunk.subarray(0, remaining))
      errors.push(data)
      errorBytes += data.length
    }
  })
  const stderr = (): string => Buffer.concat(errors).toString('utf8')
  const stop = (cause: unknown): void => {
    if (failure !== undefined) return
    failure = cause ?? new Error(`${command} 已停止`)
    controller.abort(failure)
    // 关闭管道唤醒正在等待响应的读取，但仍等待终止和 close，不能遗留后台写入。
    child.stdin.destroy()
    child.stdout.destroy(failure instanceof Error ? failure : new Error(String(failure)))
    termination = terminateTree(child)
    void termination.catch(() => {})
  }
  child.on('error', stop)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.once('exit', (code, signal) => {
    if (code !== 0) stop(new Error(`${command} 执行失败（${signal ?? code}）：${stderr().trim()}`))
  })
  const abort = (): void => stop(options.signal!.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(
    () => stop(new Error(`${command} 执行超时：${options.timeoutMs}ms`)), options.timeoutMs,
  )
  if (options.signal?.aborted) abort()

  let value: T | undefined
  try {
    try {
      controller.signal.throwIfAborted()
      value = await consume({ stdin: child.stdin, stdout: child.stdout, signal: controller.signal })
      child.stdin.end()
    } catch (error) {
      stop(error)
    }
    const result = await closed
    if (termination !== undefined) await termination
    if (failure !== undefined) throw failure
    options.signal?.throwIfAborted()
    if (result.code !== 0) throw new Error(`${command} 执行失败（${result.signal ?? result.code}）：${stderr().trim()}`)
    return { value: value as T, stderr: stderr(), exitCode: 0 }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  // taskkill /T 必须在根进程仍存在时执行，不能先 child.kill 再尝试寻找后代。
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, shell: false,
    })
    killer.once('error', error => { child.kill(); reject(error) })
    killer.once('close', code => {
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve()
      else { child.kill(); reject(new Error(`无法终止进程树 ${pid}：taskkill ${code}`)) }
    })
  })
}

/** 精确读取协议边界；保留未消费的小段数据，避免把整个对象或仓库放入内存。 */
export class ProcessReader {
  private readonly iterator: AsyncIterator<Buffer>
  private pending = Buffer.alloc(0)

  constructor(stream: Readable, private readonly signal?: AbortSignal) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }

  private async fill(): Promise<boolean> {
    this.signal?.throwIfAborted()
    if (this.pending.length > 0) return true
    const next = await this.iterator.next()
    this.signal?.throwIfAborted()
    if (next.done) return false
    this.pending = Buffer.from(next.value)
    return true
  }

  async line(maxBytes = 256): Promise<string> {
    const parts: Buffer[] = []
    let size = 0
    while (await this.fill()) {
      const end = this.pending.indexOf(0x0a)
      const length = end < 0 ? this.pending.length : end
      size += length
      if (size > maxBytes) throw new Error('Git batch 响应头超过限制')
      parts.push(this.pending.subarray(0, length))
      this.pending = this.pending.subarray(length + (end < 0 ? 0 : 1))
      if (end >= 0) return Buffer.concat(parts, size).toString('ascii')
    }
    throw new Error('Git batch 响应头被截断')
  }

  async *chunks(size: number): AsyncGenerator<Buffer> {
    let remaining = size
    while (remaining > 0) {
      if (!await this.fill()) throw new Error('Git batch 对象内容被截断')
      const length = Math.min(remaining, this.pending.length)
      const chunk = this.pending.subarray(0, length)
      this.pending = this.pending.subarray(length)
      remaining -= length
      yield chunk
    }
    this.signal?.throwIfAborted()
  }

  async separator(): Promise<void> {
    if (!await this.fill() || this.pending[0] !== 0x0a) throw new Error('Git batch 对象结束分隔符无效或被截断')
    this.pending = this.pending.subarray(1)
  }

  async finish(): Promise<void> {
    if (await this.fill()) throw new Error('Git batch 返回多余内容')
  }
}

export async function writeProcessInput(stream: Writable, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(data, error => error ? reject(error) : resolve())
  })
}
