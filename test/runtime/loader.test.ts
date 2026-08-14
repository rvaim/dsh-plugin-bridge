import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { PARSER_VERSION } from '../../src/parser/normalize.js'
import { loadInstalledPluginForRuntime } from '../../src/runtime/loader.js'
import { writeJsonAtomic } from '../../src/store/json.js'
import { CompatLayout } from '../../src/store/layout.js'
import { temporaryDirectory } from '../helpers/temp.js'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'

const fixture = resolve('test/fixtures/claude-code/full')

test('parserVersion 变化时从 package/ 真源重新扫描', async () => {
  const temp = await temporaryDirectory()
  try {
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    await manager.install(fixture, { enable: false })
    const old = await manager.inspect('legacy-full')
    await writeJsonAtomic(layout.scanFile('legacy-full'), { ...old.scan, parserVersion: '0.0.0' })
    const skillPath = resolve(old.packageRoot, 'skills/review/SKILL.md')
    await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replace('审查代码并给出可执行建议', '重新扫描后的描述'))
    const refreshed = await loadInstalledPluginForRuntime(layout, 'legacy-full')
    assert.equal(refreshed.scan.parserVersion, PARSER_VERSION)
    assert.equal(refreshed.scan.plugin.skills[0].description, '重新扫描后的描述')
  } finally {
    await temp.cleanup()
  }
})

test('运行时重扫会重新附加 Marketplace 候选诊断', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await mkdir(resolve(source, '.agents/plugins'), { recursive: true })
    await writeFile(resolve(source, '.agents/plugins/marketplace.json'), JSON.stringify({
      name: 'codex-market',
      plugins: [{
        name: 'a',
        source: { source: 'local', path: './plugins/a' },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      }],
    }))

    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    await manager.install(source, { plugins: ['a'], enable: false })
    const old = await manager.inspect('a')
    await writeJsonAtomic(layout.scanFile('a'), { ...old.scan, parserVersion: '0.0.0' })

    const refreshed = await loadInstalledPluginForRuntime(layout, 'a')
    assert(refreshed.scan.plugin.diagnostics.some(item =>
      item.code === 'CODEX_MARKETPLACE_PRODUCT_POLICY_NOT_ENFORCED' && item.level === 'warning'))
  } finally {
    await temp.cleanup()
  }
})
