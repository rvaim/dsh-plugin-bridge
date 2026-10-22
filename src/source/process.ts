import { runStreamingProcess, type ProcessOptions } from './process-stream.js'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const result = await runProcessBuffer(command, args, options)
  return { ...result, stdout: result.stdout.toString('utf8') }
}

export interface BinaryProcessResult {
  stdout: Buffer
  stderr: string
  exitCode: number
}

/** 有界收集 stdout；超时、取消及输出超限都等待进程树退出。 */
export async function runProcessBuffer(
  command: string,
  args: readonly string[],
  options: ProcessOptions & { maxOutputBytes?: number } = {},
): Promise<BinaryProcessResult> {
  const result = await runStreamingProcess(command, args, options, async ({ stdin, stdout, signal }) => {
    stdin.end()
    const chunks: Buffer[] = []
    const maximum = options.maxOutputBytes ?? 64 * 1024 * 1024
    let size = 0
    for await (const chunk of stdout) {
      signal.throwIfAborted()
      const data = Buffer.from(chunk)
      size += data.length
      if (size > maximum) throw new Error(`${command} 输出超过限制：${maximum}`)
      chunks.push(data)
    }
    return Buffer.concat(chunks, size)
  })
  return { stdout: result.value, stderr: result.stderr, exitCode: result.exitCode }
}
