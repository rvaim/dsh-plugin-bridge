import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { SpinnerOptions } from '@clack/prompts'
import {
  createLoadingIndicator,
  runWithLoading,
  type SpinnerFactory,
} from '../../src/cli/loading.js'

function fakeSpinner(): { create: SpinnerFactory; events: string[]; options: SpinnerOptions[] } {
  const events: string[] = []
  const options: SpinnerOptions[] = []
  return {
    events,
    options,
    create: received => {
      options.push(received ?? {})
      return {
        start: message => { events.push(`start:${message ?? ''}`) },
        stop: message => { events.push(`stop:${message ?? ''}`) },
        cancel: message => { events.push(`cancel:${message ?? ''}`) },
        error: message => { events.push(`error:${message ?? ''}`) },
        message: message => { events.push(`message:${message ?? ''}`) },
        clear: () => { events.push('clear') },
        isCancelled: false,
      }
    },
  }
}

test('加载动画支持更新文案、暂停并再次启动', () => {
  const output = new PassThrough()
  const fake = fakeSpinner()
  try {
    const loading = createLoadingIndicator(true, output, fake.create)
    loading.start('拉取 Source')
    loading.start('解析 Source')
    loading.stop('Source 已解析')
    loading.start('安装 Plugin')
    loading.clear()

    assert.deepEqual(fake.events, [
      'start:拉取 Source',
      'message:解析 Source',
      'stop:Source 已解析',
      'start:安装 Plugin',
      'clear',
    ])
    assert.equal(typeof fake.options[0]?.onCancel, 'function')
    assert.equal(loading.active, false)
  } finally {
    output.destroy()
  }
})

test('加载包装器在失败时结束动画并保留原错误', async () => {
  const output = new PassThrough()
  const fake = fakeSpinner()
  const expected = new Error('network down')
  try {
    const loading = createLoadingIndicator(true, output, fake.create)
    await assert.rejects(runWithLoading(loading, {
      start: '正在拉取',
      success: '拉取完成',
      failure: '拉取失败',
    }, async () => { throw expected }), error => error === expected)
    assert.deepEqual(fake.events, ['start:正在拉取', 'error:拉取失败'])
  } finally {
    output.destroy()
  }
})

test('禁用加载动画时不创建 spinner', () => {
  let created = false
  const output = new PassThrough()
  try {
    const loading = createLoadingIndicator(false, output, () => {
      created = true
      return fakeSpinner().create()
    })
    loading.start('不会显示')
    loading.stop('不会显示')
    assert.equal(created, false)
    assert.equal(loading.active, false)
  } finally {
    output.destroy()
  }
})
