import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 1,
      }
      if (code === 0) resolve(result)
      else reject(new Error(`${command} 执行失败（${signal ?? code}）：${result.stderr.trim()}`))
    })
  })
}

export interface BinaryProcessResult {
  stdout: Buffer
  stderr: string
  exitCode: number
}

/** 运行需要读取二进制 stdout 的子进程，并限制输出体积。 */
export async function runProcessBuffer(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<BinaryProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024
    let outputBytes = 0
    let forcedError: Error | undefined
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const consume = (target: Buffer[], chunk: unknown): void => {
      if (forcedError !== undefined) return
      const data = Buffer.from(chunk as Uint8Array)
      outputBytes += data.length
      if (outputBytes > maxOutputBytes && forcedError === undefined) {
        forcedError = new Error(`${command} 输出超过限制：${maxOutputBytes}`)
        child.kill('SIGKILL')
        return
      }
      target.push(data)
    }
    child.stdout.on('data', chunk => consume(stdout, chunk))
    child.stderr.on('data', chunk => consume(stderr, chunk))
    child.on('error', fail)
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          forcedError = new Error(`${command} 执行超时：${options.timeoutMs}ms`)
          child.kill('SIGKILL')
        }, options.timeoutMs)
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      if (settled) return
      if (forcedError !== undefined) return fail(forcedError)
      const result: BinaryProcessResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 1,
      }
      if (code === 0) {
        settled = true
        resolve(result)
      } else {
        fail(new Error(`${command} 执行失败（${signal ?? code}）：${result.stderr.trim()}`))
      }
    })
  })
}
