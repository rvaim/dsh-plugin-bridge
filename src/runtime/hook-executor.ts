import { isAbsolute, resolve } from 'node:path'
import type { ShellExecSpec, ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { DshContextLike } from './context.js'

interface ExecutionOptions {
  args?: readonly string[]
  shell?: 'bash' | 'powershell'
  signal: AbortSignal
}

export type HookProcessResult = ShellRunResult
export type HookExecutor = Pick<ShellExecutor, 'resolve' | 'execute'> & { failure?: string }

/** Apply Hook policy around the current SDK runner; argv Hooks use subprocess directly. */
export function createHookExecutor(ctx: DshContextLike, options: ExecutionOptions): HookExecutor {
  const executor: HookExecutor = {
    resolve(request) {
      const signal = request.signal === undefined ? options.signal : AbortSignal.any([request.signal, options.signal])
      if (options.args !== undefined) return {
        ...request, signal, onExpiry: 'kill', workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 600_000, stdoutMaxBytes: request.stdoutMaxBytes ?? 1_048_576,
        sandboxPolicy: request.sandboxPolicy,
      }
      if ((options.shell === 'powershell' && process.platform !== 'win32')
        || (options.shell === 'bash' && process.platform === 'win32')) {
        throw new Error('当前 Shell 服务不能保证该 Hook 显式选择的 Shell 语义')
      }
      if (ctx.shell === undefined) throw new Error('DSH 未提供 ctx.shell，无法执行 Shell Hook')
      return ctx.shell.resolve({ ...request, signal, onExpiry: 'kill' })
    },
    async execute(spec) {
      try {
        const execution = options.args === undefined
          ? await ctx.shell!.execute(spec)
          : await executeExec(ctx, spec, options.args)
        // Keep the Host handle intact; only its foreground result needs Hook health tracking.
        return new Proxy(execution, {
          get(target, property) {
            if (property === 'result') return async (): Promise<ShellRunResult> => {
              try {
                const result = await target.result()
                if (result.timedOut) executor.failure = 'Hook 执行超时'
                else if (result.aborted || spec.signal?.aborted) executor.failure = 'Hook 执行已取消'
                else if (result.stdout.truncated) executor.failure = 'Hook stdout 超出完整解析预算'
                else if (result.exitCode === null || (result.exitCode !== 0 && result.exitCode !== 2)) {
                  executor.failure = `Hook 异常退出：${String(result.exitCode)}`
                }
                return result
              } catch (error) {
                executor.failure = error instanceof Error ? error.message : String(error)
                throw error
              }
            }
            const value: unknown = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      } catch (error) {
        executor.failure = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
  }
  return executor
}

async function executeExec(ctx: DshContextLike, spec: ShellExecSpec, args: readonly string[]): Promise<ShellExecution> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error('当前 DSH 未提供直接执行 Hook args 所需的 subprocess 服务；不会降级为 Shell')
  }
  const timeout = new AbortController()
  const signal = spec.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, spec.signal])
  const timer = setTimeout(() => timeout.abort(new Error('Hook 执行超时')), spec.timeoutMs)
  timer.unref?.()
  let handle: SubprocessHandle
  try {
    const command = /[/\\]/.test(spec.command) && !isAbsolute(spec.command)
      ? resolve(spec.workdir, spec.command)
      : spec.command
    const executable = await subprocess.resolveExecutable(command, spec.env, signal)
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
      throw new Error('exec Hook 不接受 .cmd/.bat；请显式选择 Shell 形式')
    }
    handle = subprocess.spawn({
      argv: [executable, ...args], cwd: spec.workdir,
      stdio: { stdin: { data: spec.stdin ?? '' }, stdout: { maxBytes: spec.stdoutMaxBytes }, stderr: { maxBytes: 65_536 } },
      graceMs: 1_000, signal, env: spec.env,
    })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  let status: ShellExecution['status'] = 'running'
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  const read = (stream: 'stdout' | 'stderr', offset: number) => handle.collected[stream]?.readFrom(offset)
    ?? { text: '', nextOffset: offset, lossy: false }
  const completed = (async (): Promise<ShellRunResult> => {
    try {
      const outcome = await handle.done
      exitCode = outcome.exitCode
      exitSignal = outcome.signal
      status = outcome.exitCode === null ? 'killed' : 'completed'
      const stdout = read('stdout', 0)
      const stderr = read('stderr', 0)
      return {
        exitCode, signal: exitSignal,
        stdout: { text: stdout.text, truncated: stdout.lossy },
        stderr: { text: stderr.text, truncated: stderr.lossy },
        timedOut: timeout.signal.aborted && signal.reason === timeout.signal.reason,
        aborted: spec.signal?.aborted === true && signal.reason === spec.signal.reason,
        timeoutMs: spec.timeoutMs,
      }
    } catch (error) {
      status = 'killed'
      throw error
    } finally {
      clearTimeout(timer)
      handle.terminate()
      if (!await handle.waitForExit()) throw new Error('Hook 子进程未完全停止')
    }
  })()
  let stdoutOffset = 0
  let stderrOffset = 0
  return {
    get status() { return status },
    get exitCode() { return exitCode },
    get signal() { return exitSignal },
    done: completed.then(() => {}, () => {}),
    observed: {
      stdout: { readFrom: offset => read('stdout', offset) },
      stderr: { readFrom: offset => read('stderr', offset) },
    },
    readOutput() {
      const stdout = read('stdout', stdoutOffset)
      const stderr = read('stderr', stderrOffset)
      stdoutOffset = stdout.nextOffset
      stderrOffset = stderr.nextOffset
      return { delta: stdout.text + (stderr.text === '' ? '' : `\n[stderr]\n${stderr.text}`), lossy: stdout.lossy || stderr.lossy }
    },
    kill() {
      if (status !== 'running') return false
      handle.terminate()
      return true
    },
    result: () => completed,
  }
}
