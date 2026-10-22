import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { CompatManager, CompatibilityError, ParserSelectionRequiredError } from '../../src/manager/manager.js'
import { CompatLayout } from '../../src/store/layout.js'
import { readInstalledPlugin } from '../../src/store/metadata.js'
import { runProcess } from '../../src/source/process.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, file: string, value: unknown): Promise<void> {
  const path = resolve(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

async function dual(root: string, name = 'dual', mcp = false): Promise<void> {
  await put(root, '.claude-plugin/plugin.json', { name, version: '1.0.0' })
  await put(root, '.codex-plugin/plugin.json', { name, version: '1.0.0', skills: './skills' })
  await put(root, 'skills/review/SKILL.md', '---\nname: review\ndescription: Review fixture\n---\nLiteral body\n')
  await put(root, 'skills/review/agents/openai.yaml', 'interface:\n  display_name: Codex review\npolicy:\n  allow_implicit_invocation: false\n')
  if (mcp) await put(root, '.mcp.json', { mcpServers: { fixture: { type: 'stdio', command: 'fixture-never-executed' } } })
}

for (const parserId of ['claude-code', 'codex']) {
  test(`双平台插件明确选择 ${parserId} 后只保留其调用策略，重扫和更新沿用选择`, async () => {
    const temp = await temporaryDirectory()
    const engine = createBuiltinParserEngine()
    try {
      const source = resolve(temp.path, 'dual-source')
      await dual(source, 'dual', parserId === 'claude-code')
      const layout = new CompatLayout(resolve(temp.path, 'home'))
      const manager = new CompatManager(layout, undefined, engine)
      const prepared = await manager.prepareInstall(source)
      const next = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual' }])
      assert.equal(next.kind, 'parser-selection')
      if (next.kind !== 'parser-selection') assert.fail('expected parser choice')
      assert.deepEqual(next.plugins[0].matches.map(match => match.parserId), ['claude-code', 'codex'])
      assert(next.plugins[0].matches.every(match => match.evidence.some(item => item.kind === 'manifest')))
      assert.deepEqual(await manager.list(), [])
      assert.equal((await readdir(layout.temp)).length, 1)
      const completed = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual', parserId }])
      assert.equal(completed.kind, 'installed')
      if (completed.kind !== 'installed') assert.fail('expected installation')
      const installed = completed.result.plugins[0]
      assert.equal(installed.install.parserId, parserId)
      assert.deepEqual(installed.plugin.formats, [parserId])
      assert.equal(installed.plugin.skills.length, 1)
      assert.equal(installed.plugin.skills[0].invocation.modelInvocable, parserId === 'claude-code')
      assert.equal(installed.plugin.diagnostics.some(item => item.level === 'error'), false)
      assert.equal(installed.plugin.manifestFiles.length, 1)
      assert.deepEqual(await readdir(layout.temp), [])
      await put(layout.pluginRoot('dual'), 'data/retained.txt', 'keep')
      const restarted = new CompatManager(layout, undefined, createBuiltinParserEngine())
      assert.equal((await restarted.inspect('dual')).install.parserId, parserId)
      await put(source, 'marker.txt', 'updated source')
      await restarted.sourceUpdate(prepared.sourceId)
      const updated = await restarted.inspect('dual')
      assert.equal(updated.install.parserId, parserId)
      assert.deepEqual(updated.scan.plugin.formats, [parserId])
      assert.equal(updated.scan.plugin.skills[0].invocation.modelInvocable, parserId === 'claude-code')
      assert.equal(await readFile(resolve(layout.dataDir('dual'), 'retained.txt'), 'utf8'), 'keep')
      restarted.parsers.dispose()
    } finally { engine.dispose(); await temp.cleanup() }
  })
}

test('非交互多匹配不默认选首项，错误 parserId 不能安装', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'source')
    await dual(source)
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    await assert.rejects(manager.install(source), ParserSelectionRequiredError)
    assert.deepEqual(await readdir(layout.installed), [])
    assert.deepEqual(await readdir(layout.temp), [])
    const preparation = await manager.prepareInstall(source)
    await assert.rejects(manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'dual', parserId: 'arbitrary' }]), /不匹配/)
    assert.deepEqual(await manager.list(), [])
    await manager.releaseInstallPreparation(preparation.preparationId)
    assert.deepEqual(await readdir(layout.temp), [])
    assert.deepEqual(await readdir(layout.sources), [])
  } finally { engine.dispose(); await temp.cleanup() }
})

test('只校验所选市场平台策略，被禁止的平台不能污染可用平台或绕过限制', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'market')
    await dual(resolve(source, 'plugins/dual'))
    await put(source, '.claude-plugin/marketplace.json', {
      name: 'dual-market', owner: { name: 'fixture' }, plugins: [{ name: 'dual', source: './plugins/dual', defaultEnabled: false }],
    })
    await put(source, '.agents/plugins/marketplace.json', {
      name: 'dual-market', plugins: [{ name: 'dual', source: { source: 'local', path: './plugins/dual' }, policy: { installation: 'NOT_AVAILABLE' } }],
    })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    const preparation = await manager.prepareInstall(source)
    assert.equal(preparation.plugins[0].installable, true)
    const next = await manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'dual' }])
    assert.equal(next.kind, 'parser-selection')
    if (next.kind !== 'parser-selection') assert.fail('expected parser choice')
    const codex = next.plugins[0].matches.find(match => match.parserId === 'codex')!
    assert(codex.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE'))
    await assert.rejects(manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'dual', parserId: 'codex' }]), CompatibilityError)
    const completed = await manager.completeInstallPreparation(preparation.preparationId, [{ pluginId: 'dual', parserId: 'claude-code' }])
    assert.equal(completed.kind, 'installed')
    if (completed.kind !== 'installed') assert.fail('expected installation')
    assert.equal(completed.result.plugins[0].plugin.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE'), false)
    assert.equal(completed.result.plugins[0].enabled, false)
  } finally { engine.dispose(); await temp.cleanup() }
})

test('选择平台后仅采用该平台的默认启用策略和展示元数据', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'market')
    await dual(resolve(source, 'plugins/dual'))
    await put(source, '.claude-plugin/marketplace.json', {
      name: 'dual-market', owner: { name: 'fixture' },
      plugins: [{ name: 'dual', source: './plugins/dual', defaultEnabled: false, displayName: 'CC display' }],
    })
    await put(source, '.agents/plugins/marketplace.json', {
      name: 'dual-market', plugins: [{ name: 'dual', source: { source: 'local', path: './plugins/dual' }, defaultEnabled: true, displayName: 'Codex display' }],
    })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    const result = await manager.install(source, { plugins: [{ pluginId: 'dual', parserId: 'codex' }] })
    assert.equal(result.plugins[0].enabled, true)
    assert.equal(result.plugins[0].plugin.name, 'Codex display')
    assert.equal(result.plugins[0].install.parserId, 'codex')
  } finally { engine.dispose(); await temp.cleanup() }
})

async function commit(root: string, message: string): Promise<string> {
  await runProcess('git', ['-C', root, 'add', '.'])
  await runProcess('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-m', message])
  return (await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}

for (const finish of ['install', 'cancel'] as const) {
  test(`外部插件在解析器选择期间固定提交，${finish} 后清理准备内容`, async () => {
    const temp = await temporaryDirectory()
    const engine = createBuiltinParserEngine()
    try {
      const remote = resolve(temp.path, 'remote')
      const market = resolve(temp.path, 'market')
      await dual(remote)
      await put(remote, 'marker.txt', 'before')
      await runProcess('git', ['init', remote])
      await runProcess('git', ['-C', remote, 'config', 'user.email', 'test@example.com'])
      await runProcess('git', ['-C', remote, 'config', 'user.name', 'Fixture'])
      const pinned = await commit(remote, 'initial')
      await put(market, '.claude-plugin/marketplace.json', {
        name: 'external-market', owner: { name: 'fixture' },
        plugins: [{ name: 'dual', source: { source: 'url', url: pathToFileURL(remote).href } }],
      })
      const layout = new CompatLayout(resolve(temp.path, 'home'))
      const manager = new CompatManager(layout, undefined, engine)
      const prepared = await manager.prepareInstall(market)
      const next = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual' }])
      assert.equal(next.kind, 'parser-selection')
      assert.deepEqual(await readdir(layout.external), [])
      assert.deepEqual(await readdir(layout.installed), [])
      await put(remote, 'marker.txt', 'after')
      await commit(remote, 'advanced')
      if (finish === 'cancel') {
        await manager.releaseInstallPreparation(prepared.preparationId)
        assert.deepEqual(await readdir(layout.sources), [])
        assert.deepEqual(await readdir(layout.external), [])
      } else {
        const completed = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual', parserId: 'codex' }])
        assert.equal(completed.kind, 'installed')
        if (completed.kind !== 'installed') assert.fail('expected installation')
        assert.equal(completed.result.plugins[0].install.materialization?.commit, pinned)
        const installed = await manager.inspect('dual')
        assert.equal(installed.install.parserId, 'codex')
        assert.equal(await readFile(resolve(installed.packageRoot, 'marker.txt'), 'utf8'), 'before')
      }
      assert.deepEqual(await readdir(layout.temp), [])
    } finally { engine.dispose(); await temp.cleanup() }
  })
}

test('更新丢失已选解析器时拒绝提交，不切换到剩余平台', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'source')
    await dual(source)
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    await manager.install(source, { plugins: [{ pluginId: 'dual', parserId: 'claude-code' }] })
    const before = await manager.inspect('dual')
    await put(layout.pluginRoot('dual'), 'data/retained.txt', 'keep')
    await rm(resolve(source, '.claude-plugin/plugin.json'))
    await assert.rejects(manager.sourceUpdate(before.install.sourceId), CompatibilityError)
    const after = await manager.inspect('dual')
    assert.equal(after.install.parserId, 'claude-code')
    assert.equal(after.scan.sourceRevision, before.scan.sourceRevision)
    assert.deepEqual(after.scan.plugin.formats, ['claude-code'])
    assert.equal(await readFile(resolve(layout.dataDir('dual'), 'retained.txt'), 'utf8'), 'keep')
  } finally { engine.dispose(); await temp.cleanup() }
})

for (const phase of ['install', 'parser-selection'] as const) {
  test(`${phase} 提交后临时清理失败仍返回已安装且后续操作重试清理`, async () => {
    const temp = await temporaryDirectory()
    const engine = createBuiltinParserEngine()
    try {
      const source = resolve(temp.path, 'source')
      await dual(source)
      const layout = new CompatLayout(resolve(temp.path, 'home'))
      let failures = 0
      const manager = new CompatManager(layout, undefined, engine, {
        async cleanupTemporary(path) {
          assert.equal(dirname(path), layout.temp)
          if (basename(path).startsWith(`${phase}-`) && failures++ === 0) throw new Error('EACCES: fixture cleanup failure')
          await rm(path, { recursive: true, force: true })
        },
      })
      const prepared = await manager.prepareInstall(source)
      const next = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual' }])
      assert.equal(next.kind, 'parser-selection')
      const done = await manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual', parserId: 'claude-code' }])
      assert.equal(done.kind, 'installed')
      if (done.kind !== 'installed') assert.fail('expected committed installation')
      assert(done.result.plugins[0].plugin.diagnostics.some(item => item.code === 'TEMP_CLEANUP_FAILED'))
      assert.equal((await readInstalledPlugin(layout, 'dual')).install.parserId, 'claude-code')
      assert.equal((await readdir(layout.temp)).length, 1)
      await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'dual', parserId: 'claude-code' }]), /已结束/)
      assert.deepEqual(await readdir(layout.temp), [])
      await manager.releaseInstallPreparation(prepared.preparationId)
      assert.equal((await manager.sourceList()).length, 1)
      assert.equal((await readInstalledPlugin(layout, 'dual')).install.parserId, 'claude-code')
    } finally { engine.dispose(); await temp.cleanup() }
  })
}

test('plugin@source 简写保留显式 parserId，不接受展示名代替稳定 pluginId', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'market')
    await dual(resolve(source, 'plugins/dual'))
    await put(source, '.claude-plugin/marketplace.json', {
      name: 'shorthand-market', owner: { name: 'fixture' },
      plugins: [{ name: 'dual', displayName: 'Friendly display', source: './plugins/dual' }],
    })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    await manager.sourceAdd(source)
    await assert.rejects(manager.install('shorthand-market', { plugins: [{ pluginId: 'Friendly display', parserId: 'codex' }] }), /不包含插件/)
    const result = await manager.install('dual@shorthand-market', { plugins: [{ pluginId: 'dual', parserId: 'codex' }] })
    assert.equal(result.plugins[0].install.parserId, 'codex')
    assert.deepEqual(result.plugins[0].plugin.formats, ['codex'])
  } finally { engine.dispose(); await temp.cleanup() }
})

for (const firstAction of ['cancel-fails-once', 'install'] as const) {
  test(`两个会话固定同一外仓后 ${firstAction} 不影响另一会话与已安装来源`, async () => {
    const temp = await temporaryDirectory()
    const engine = createBuiltinParserEngine()
    try {
      const remote = resolve(temp.path, 'remote')
      const market = resolve(temp.path, 'market')
      await dual(remote)
      await runProcess('git', ['init', remote])
      await runProcess('git', ['-C', remote, 'config', 'user.email', 'test@example.com'])
      await runProcess('git', ['-C', remote, 'config', 'user.name', 'Fixture'])
      const pinned = await commit(remote, 'initial')
      await put(market, '.claude-plugin/marketplace.json', { name: 'shared-external', owner: { name: 'fixture' },
        plugins: [{ name: 'dual', source: { source: 'url', url: pathToFileURL(remote).href } }] })
      const layout = new CompatLayout(resolve(temp.path, 'home'))
      let failCleanup = firstAction === 'cancel-fails-once'
      const manager = new CompatManager(layout, undefined, engine, {
        async cleanupTemporary(path) {
          assert.equal(dirname(path), layout.temp)
          if (failCleanup) { failCleanup = false; throw new Error('EBUSY: fixture cancellation cleanup') }
          await rm(path, { recursive: true, force: true })
        },
      })
      const first = await manager.prepareInstall(market)
      const second = await manager.prepareInstall(market)
      const choices = [{ pluginId: 'dual' }]
      assert.equal((await manager.completeInstallPreparation(first.preparationId, choices)).kind, 'parser-selection')
      assert.equal((await manager.completeInstallPreparation(second.preparationId, choices)).kind, 'parser-selection')
      assert.equal((await readdir(layout.temp)).length, 2)
      if (firstAction === 'cancel-fails-once') {
        await assert.rejects(manager.releaseInstallPreparation(first.preparationId), /EBUSY/)
        await manager.releaseInstallPreparation(first.preparationId)
        assert.equal((await readdir(layout.temp)).length, 1)
        const installed = await manager.completeInstallPreparation(second.preparationId, [{ pluginId: 'dual', parserId: 'claude-code' }])
        assert.equal(installed.kind, 'installed')
        if (installed.kind !== 'installed') assert.fail('expected installation')
        assert.equal(installed.result.plugins[0].install.materialization?.commit, pinned)
      } else {
        const installed = await manager.completeInstallPreparation(first.preparationId, [{ pluginId: 'dual', parserId: 'claude-code' }])
        assert.equal(installed.kind, 'installed')
        await manager.releaseInstallPreparation(second.preparationId)
      }
      assert.equal((await manager.sourceList()).length, 1)
      assert.equal((await readInstalledPlugin(layout, 'dual')).install.materialization?.commit, pinned)
      assert.deepEqual(await readdir(layout.temp), [])
    } finally { engine.dispose(); await temp.cleanup() }
  })
}

test('准备中断且清理失败的事务仍有归属，取消时可回收', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const remote = resolve(temp.path, 'remote')
    const market = resolve(temp.path, 'market')
    await dual(remote)
    await runProcess('git', ['init', remote])
    await runProcess('git', ['-C', remote, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', remote, 'config', 'user.name', 'Fixture'])
    await commit(remote, 'initial')
    await put(market, '.claude-plugin/marketplace.json', { name: 'failed-preparation', owner: { name: 'fixture' }, plugins: [
      { name: 'first', source: { source: 'url', url: pathToFileURL(remote).href } },
      { name: 'missing', source: { source: 'url', url: pathToFileURL(resolve(temp.path, 'not-a-repository')).href } },
    ] })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    let cleanupFailed = false
    const manager = new CompatManager(layout, undefined, engine, {
      async cleanupTemporary(path) {
        assert.equal(dirname(path), layout.temp)
        if (!cleanupFailed) { cleanupFailed = true; throw new Error('EACCES: fixture cleanup failure') }
        await rm(path, { recursive: true, force: true })
      },
    })
    const prepared = await manager.prepareInstall(market)
    await assert.rejects(manager.completeInstallPreparation(prepared.preparationId, [{ pluginId: 'first' }, { pluginId: 'missing' }]), AggregateError)
    assert.equal((await readdir(layout.temp)).length, 1)
    assert.deepEqual(await readdir(layout.installed), [])
    await manager.releaseInstallPreparation(prepared.preparationId)
    assert.deepEqual(await readdir(layout.temp), [])
    assert.deepEqual(await readdir(layout.sources), [])
  } finally { engine.dispose(); await temp.cleanup() }
})

test('解析阶段的冲突错误保留到安装记录，阻止启用', async () => {
  const temp = await temporaryDirectory()
  const engine = createBuiltinParserEngine()
  try {
    const source = resolve(temp.path, 'source')
    await put(source, '.claude-plugin/plugin.json', { name: 'hook-conflict' })
    await put(source, 'hooks/hooks.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture-never-executed', timeout: 1, timeoutSec: 2 }] }] } })
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout, undefined, engine)
    const installed = await manager.install(source)
    assert.equal(installed.plugins[0].enabled, false)
    assert(installed.plugins[0].plugin.diagnostics.some(item => item.code === 'HOOK_TIMEOUT_CONFLICT'))
    const record = await readInstalledPlugin(layout, 'hook-conflict')
    assert(record.scan.plugin.diagnostics.some(item => item.code === 'HOOK_TIMEOUT_CONFLICT'))
    await assert.rejects(manager.enable('hook-conflict'), CompatibilityError)
  } finally { engine.dispose(); await temp.cleanup() }
})
