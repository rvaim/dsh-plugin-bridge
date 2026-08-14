import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { MultiSelectOptions } from '@clack/prompts'
import {
  PromptCancelledError,
  selectPluginsInteractively,
} from '../../src/cli/select-plugins.js'
import type { CompatSourcePlugin } from '../../src/types/source.js'

function candidate(
  id: string,
  installable = true,
  overrides: Partial<CompatSourcePlugin> = {},
): CompatSourcePlugin {
  return {
    id,
    name: id,
    formats: ['claude-code'],
    location: { type: 'source-path', path: `plugins/${id}` },
    installable,
    diagnostics: [],
    ...overrides,
  }
}

function ttyStreams(): { input: PassThrough; output: PassThrough } {
  const input = Object.assign(new PassThrough(), { isTTY: true })
  const output = Object.assign(new PassThrough(), { isTTY: true })
  return { input, output }
}

test('多插件 TUI 把候选映射为 Clack 复选项并返回所选 ID', async () => {
  const streams = ttyStreams()
  let received: MultiSelectOptions<string> | undefined
  try {
    const result = await selectPluginsInteractively([
      candidate('alpha', true, { displayName: 'Alpha Plugin', description: '第一项' }),
      candidate('disabled', false),
      candidate('charlie'),
    ], {
      ...streams,
      ci: false,
      prompt: async options => {
        received = options
        return ['alpha', 'charlie']
      },
    })

    assert.deepEqual(result, ['alpha', 'charlie'])
    assert.match(received?.message ?? '', /Space 选中\/反选/)
    assert.equal(received?.required, true)
    assert.equal(received?.showInstructions, false)
    assert.deepEqual(received?.options.map(option => ({
      value: option.value,
      label: option.label,
      disabled: option.disabled ?? false,
    })), [
      { value: 'alpha', label: 'alpha (Alpha Plugin)', disabled: false },
      { value: 'disabled', label: 'disabled', disabled: true },
      { value: 'charlie', label: 'charlie', disabled: false },
    ])
  } finally {
    streams.input.destroy()
    streams.output.destroy()
  }
})

test('多插件 TUI 在非交互环境不调用 Clack', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let called = false
  try {
    const result = await selectPluginsInteractively([candidate('alpha'), candidate('beta')], {
      input,
      output,
      prompt: async () => {
        called = true
        return ['alpha']
      },
    })
    assert.deepEqual(result, [])
    assert.equal(called, false)
  } finally {
    input.destroy()
    output.destroy()
  }
})

test('多插件 TUI 将 Clack 的取消结果转换为退出错误', async () => {
  const streams = ttyStreams()
  try {
    await assert.rejects(selectPluginsInteractively([
      candidate('alpha'),
      candidate('beta'),
    ], {
      ...streams,
      ci: false,
      prompt: async () => Symbol('cancel'),
    }), PromptCancelledError)
  } finally {
    streams.input.destroy()
    streams.output.destroy()
  }
})
