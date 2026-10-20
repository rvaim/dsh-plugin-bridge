import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { redactSensitiveText } from '../../src/runtime/redaction.js'
import { CompatLayout } from '../../src/store/layout.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('下游 MCP 异常消息不会泄漏环境变量、Header 或 URL Token', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'leak')
    await buildClaudePlugin(source, { name: 'leak-safe' })
    await writeFile(resolve(source, '.mcp.json'), JSON.stringify({
      mcpServers: {
        leaker: {
          command: 'leak-config',
          env: { INLINE_TOKEN: 'ghp_runtime_secret_12345678' },
        },
        remote: {
          type: 'streamable-http',
          url: 'https://example.invalid/mcp?token=url-secret-value',
          headers: { Authorization: 'Bearer header-secret-value' },
        },
      },
    }))
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const result = (await new CompatManager(layout, runtime, createBuiltinParserEngine()).install(source)).plugins[0]

    assert.equal(result.enabled, true)
    assert.equal(result.runtime.status, 'degraded')
    const logs = ctx.shared.logs.join('\n')
    assert.equal(logs.includes('ghp_runtime_secret_12345678'), false)
    assert.equal(logs.includes('url-secret-value'), false)
    assert.equal(logs.includes('header-secret-value'), false)
    assert.match(logs, /已脱敏/)
    const failed = result.runtime.capabilities.find(item => item.name === 'leaker')
    assert.equal(failed?.message?.includes('ghp_runtime_secret_12345678'), false)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('所有运行能力失败时立即 dispose 父实例，不保留部分注册', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'partial')
    await buildClaudePlugin(source, {
      name: 'partial-failure',
      mcpName: 'partial',
      mcpCommand: 'partial-fail-mcp',
    })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const result = (await new CompatManager(layout, runtime, createBuiltinParserEngine()).install(source)).plugins[0]

    assert.equal(result.enabled, false)
    assert.equal(result.runtime.status, 'failed')
    assert.equal(ctx.shared.mcpConfigs.size, 0)
    assert.equal(ctx.shared.tools.size, 0)
    assert.equal((await runtime.stop('partial-failure')).status, 'disabled')
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('通用脱敏器覆盖 Bearer、查询参数和常见 Token 前缀', () => {
  const text = redactSensitiveText(
    'Authorization: Bearer abcdefgh token=query-secret&x=1 key=plain-key ghp_1234567890',
    ['abcdefgh'],
  )
  assert.equal(text.includes('abcdefgh'), false)
  assert.equal(text.includes('query-secret'), false)
  assert.equal(text.includes('plain-key'), false)
  assert.equal(text.includes('ghp_1234567890'), false)
})
