import { isAbsolute, resolve } from 'node:path'
import type { DshContextLike } from './context.js'

interface HookRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  stdin?: string
  signal?: AbortSignal
  env?: Record<string, string>
}

interface Collected { text: string; truncated?: boolean }
export interface HookProcessResult {
  exitCode: number | null
  stdout: Collected
  stderr: Collected
  timedOut?: boolean
  aborted?: boolean
}

interface ExecutionOptions {
  args?: readonly string[]
  shell?: 'bash' | 'powershell'
  signal: AbortSignal
}

/** Bridge the shared wire codec to current DSH execution services; exec never uses a shell. */
export function createHookExecutor(ctx: DshContextLike, options: ExecutionOptions): {
  resolve(request: HookRequest): HookRequest
  run(request: HookRequest): Promise<HookProcessResult>
  failure?: string
} {
  const executor = {
    failure: undefined as string | undefined,
    resolve(request: HookRequest): HookRequest { return request },
    async run(request: HookRequest): Promise<HookProcessResult> {
      const signal = request.signal === undefined
        ? options.signal
        : AbortSignal.any([request.signal, options.signal])
      try {
        let result: HookProcessResult
        if (options.args !== undefined) {
          result = await runExec(ctx, { ...request, signal }, options.args)
        } else {
          if ((options.shell === 'powershell' && process.platform !== 'win32')
            || (options.shell === 'bash' && process.platform === 'win32')) {
            throw new Error('当前 Shell 服务不能保证该 Hook 显式选择的 Shell 语义')
          }
          const shell = ctx.shell as {
            resolve?(value: HookRequest & { onExpiry: 'kill' }): unknown
            execute?(spec: unknown): Promise<{ result(): Promise<HookProcessResult> }>
            run?(spec: unknown): Promise<HookProcessResult>
          } | undefined
          if (shell?.resolve === undefined) throw new Error('DSH Shell resolve 不可用')
          const spec = shell.resolve({ ...request, signal, onExpiry: 'kill' })
          if (shell.execute !== undefined) result = await (await shell.execute(spec)).result()
          else if (shell.run !== undefined) result = await shell.run(spec)
          else throw new Error('DSH Shell execute 不可用')
        }
        if (result.timedOut) executor.failure = 'Hook 执行超时'
        else if (result.aborted || signal.aborted) executor.failure = 'Hook 执行已取消'
        else if (result.stdout.truncated) executor.failure = 'Hook stdout 超出完整解析预算'
        else if (result.exitCode === null || (result.exitCode !== 0 && result.exitCode !== 2)) {
          executor.failure = `Hook 异常退出：${String(result.exitCode)}`
        }
        return result
      } catch (error) {
        executor.failure = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
  }
  return executor
}

async function runExec(ctx: DshContextLike, request: HookRequest, args: readonly string[]): Promise<HookProcessResult> {
  const subprocess = ctx.subprocess ?? ctx.get?.('subprocess')
  if (subprocess?.resolveExecutable === undefined || subprocess.spawn === undefined) {
    throw new Error('当前 DSH 未提供直接执行 Hook args 所需的 subprocess 服务；不会降级为 Shell')
  }
  const timeout = new AbortController()
  const signal = request.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, request.signal])
  const timer = setTimeout(() => timeout.abort(new Error('Hook 执行超时')), request.timeoutMs ?? 600_000)
  timer.unref?.()
  const cwd = request.workdir ?? process.cwd()
  let handle: any
  try {
    const command = /[/\\]/.test(request.command) && !isAbsolute(request.command)
      ? resolve(cwd, request.command)
      : request.command
    const executable = await subprocess.resolveExecutable(command, request.env, signal)
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
      throw new Error('exec Hook 不接受 .cmd/.bat；请显式选择 Shell 形式')
    }
    handle = subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: { data: request.stdin ?? '' },
        stdout: { maxBytes: 1_048_576 },
        stderr: { maxBytes: 65_536 },
      },
      graceMs: 1_000,
      signal,
      env: request.env,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    return {
      exitCode: outcome.exitCode,
      stdout: { text: stdout?.text ?? '', truncated: stdout?.lossy ?? false },
      stderr: { text: stderr?.text ?? '', truncated: stderr?.lossy ?? false },
      timedOut: timeout.signal.aborted,
      aborted: request.signal?.aborted ?? false,
    }
  } finally {
    clearTimeout(timer)
    if (handle !== undefined) {
      handle.terminate()
      const stopped = await handle.waitForExit()
      if (!stopped) throw new Error('Hook 子进程未完全停止')
    }
  }
}
