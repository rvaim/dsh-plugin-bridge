import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { CompatRuntimeManager } from '../../src/runtime/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { writeJsonAtomic } from '../../src/store/json.js'
import { FakeContext, fakeRuntimeDependencies } from '../helpers/fake-dsh.js'
import { createStoredZip } from '../helpers/archive-builder.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('安装阶段拒绝恶意归档且不留下半安装目录或事务目录', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'evil.zip')
    await createStoredZip(archive, [{ name: '../outside.txt', data: 'owned' }])
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    await assert.rejects(manager.install(archive, { enable: false }), /逃逸/)
    assert.deepEqual(await readdir(layout.installed), [])
    assert.deepEqual(await readdir(layout.temp), [])
    await assert.rejects(readFile(resolve(temp.path, 'outside.txt')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('损坏清单作为结构化 error 保存，插件可 inspect 但不会启用', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'broken-manifest')
    await mkdir(resolve(source, '.claude-plugin'), { recursive: true })
    await writeFile(resolve(source, '.claude-plugin/plugin.json'), '{broken json')
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    const result = (await manager.install(source)).plugins[0]
    assert.equal(result.enabled, false)
    assert(result.plugin.diagnostics.some(item => item.code === 'PLUGIN_MANIFEST_INVALID' && item.level === 'error'))
    assert.equal((await manager.inspect(result.plugin.id)).state.enabled, false)
  } finally {
    await temp.cleanup()
  }
})

test('安装不会执行 package.json 的 postinstall 或任意第三方脚本', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'no-scripts')
    const marker = resolve(temp.path, 'script-ran.txt')
    await buildClaudePlugin(source, { name: 'no-scripts' })
    await writeFile(resolve(source, 'package.json'), JSON.stringify({
      name: 'no-scripts',
      scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')"` },
    }))
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    await new CompatManager(layout).install(source, { enable: false })
    await assert.rejects(readFile(marker), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('运行实例 dispose 失败时卸载中止，正式插件目录保持完整', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'dispose-failure')
    await buildClaudePlugin(source, { name: 'dispose-failure', skillName: 'keep-me' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime)
    await manager.install(source)
    runtime.stop = async () => { throw new Error('故障注入：dispose 失败') }

    await assert.rejects(manager.uninstall('dispose-failure'), /dispose 失败/)
    assert.match(await readFile(layout.installFile('dispose-failure'), 'utf8'), /dispose-failure/)
    assert.match(await readFile(resolve(layout.sourcePackageDir('dispose-failure'), '.claude-plugin/plugin.json'), 'utf8'), /dispose-failure/)
    assert.deepEqual(await readdir(layout.temp), [])
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})

test('enable 启动异常时可靠回写 disabled', async () => {
  const temp = await temporaryDirectory()
  const ctx = FakeContext.create()
  try {
    const source = resolve(temp.path, 'enable-failure')
    await buildClaudePlugin(source, { name: 'enable-failure' })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const runtime = new CompatRuntimeManager(ctx, layout, { dependencies: fakeRuntimeDependencies(ctx.shared) })
    const manager = new CompatManager(layout, runtime)
    await manager.install(source, { enable: false })
    const record = await manager.inspect('enable-failure')
    await writeJsonAtomic(layout.stateFile('enable-failure'), { ...record.state, enabled: true })
    runtime.start = async () => { throw new Error('故障注入：start 抛出异常') }

    await assert.rejects(manager.enable('enable-failure'), /start 抛出异常/)
    assert.equal((await manager.inspect('enable-failure')).state.enabled, false)
  } finally {
    await ctx.dispose()
    await temp.cleanup()
  }
})
