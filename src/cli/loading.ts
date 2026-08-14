import { stdout } from 'node:process'
import type { Writable } from 'node:stream'
import {
  spinner,
  type SpinnerOptions,
  type SpinnerResult,
} from '@clack/prompts'

export interface LoadingIndicator {
  readonly active: boolean
  start(message: string): void
  message(message: string): void
  stop(message: string): void
  error(message: string): void
  clear(): void
}

export type SpinnerFactory = (options?: SpinnerOptions) => SpinnerResult

export function createLoadingIndicator(
  enabled: boolean,
  output: Writable = stdout,
  createSpinner: SpinnerFactory = spinner,
): LoadingIndicator {
  let active = false
  const activity = enabled ? createSpinner({
    indicator: 'dots',
    output,
    // Clack 会先移除自己的 SIGINT listener，再调用 onCancel。重新发送一次
    // SIGINT，保留普通 CLI 的 Ctrl+C/130 退出语义，而不是只停掉动画。
    onCancel: () => { process.kill(process.pid, 'SIGINT') },
  }) : undefined

  return {
    get active() {
      return active
    },
    start(message) {
      if (activity === undefined) return
      if (active) {
        activity.message(message)
        return
      }
      activity.start(message)
      active = true
    },
    message(message) {
      if (active) activity?.message(message)
    },
    stop(message) {
      if (!active) return
      activity?.stop(message)
      active = false
    },
    error(message) {
      if (!active) return
      activity?.error(message)
      active = false
    },
    clear() {
      if (!active) return
      activity?.clear()
      active = false
    },
  }
}

export async function runWithLoading<T>(
  loading: LoadingIndicator,
  messages: { start: string; success: string; failure: string },
  operation: () => Promise<T>,
): Promise<T> {
  loading.start(messages.start)
  try {
    const result = await operation()
    loading.stop(messages.success)
    return result
  } catch (error) {
    loading.error(messages.failure)
    throw error
  }
}
