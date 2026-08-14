import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildClaudePlugin } from '../helpers/plugin-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

const cli = resolve('dist/src/cli/index.js')
const fixture = resolve('test/fixtures/claude-code/full')

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}


async function writeClaudeMarketplace(root: string, plugins: unknown[], name: string): Promise<void> {
  await mkdir(resolve(root, '.claude-plugin'), { recursive: true })
  await writeFile(resolve(root, '.claude-plugin/marketplace.json'), JSON.stringify({
    name,
    owner: { name: 'CLI 测试' },
    plugins,
  }, null, 2))
}

function run(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: process.cwd() })
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

test('独立 CLI 完成离线 install/list/inspect/uninstall', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const install = run(['install', fixture, '--no-enable', '--home', home])
    assert.equal(install.status, 0, install.stderr)
    assert.match(install.stdout, /已安装 legacy-full/)

    const list = run(['list', '--home', home])
    assert.equal(list.status, 0, list.stderr)
    assert.match(list.stdout, /legacy-full/)
    assert.match(list.stdout, /disabled|否/)

    const inspect = run(['inspect', 'legacy-full', '--home', home])
    assert.equal(inspect.status, 0, inspect.stderr)
    assert.match(inspect.stdout, /Skills: 1/)
    assert.match(inspect.stdout, /MCP: 2/)

    const uninstall = run(['uninstall', 'legacy-full', '--home', home])
    assert.equal(uninstall.status, 0, uninstall.stderr)
    assert.match(uninstall.stdout, /已卸载 legacy-full/)
  } finally {
    await temp.cleanup()
  }
})


test('CLI 布尔参数可位于位置参数之前，未知参数会明确失败', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const install = run(['install', '--no-enable', fixture, '--home', home])
    assert.equal(install.status, 0, install.stderr)
    const bad = run(['list', '--unknown'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /未知参数/)
  } finally {
    await temp.cleanup()
  }
})

test('CLI 未传 --no-enable 时不覆盖 Marketplace 的 defaultEnabled=false', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const source = resolve(temp.path, 'market')
    await buildClaudePlugin(resolve(source, 'plugins/manual'), { name: 'manual' })
    await mkdir(resolve(source, '.claude-plugin'), { recursive: true })
    await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'default-policy',
      owner: { name: '测试' },
      plugins: [{ name: 'manual', source: './plugins/manual', defaultEnabled: false }],
    }))

    const install = run(['install', source, '--plugin', 'manual', '--home', home, '--json'])
    assert.equal(install.status, 0, install.stderr)
    assert.equal(JSON.parse(install.stdout).plugins[0].enabled, false)
  } finally {
    await temp.cleanup()
  }
})


test('CLI 支持 Source add/list/inspect/remove 与 JSON 输出', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const source = resolve(temp.path, 'source-market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await writeClaudeMarketplace(source, [{ name: 'a', source: './plugins/a' }], 'source-market')

    const add = run(['source', 'add', source, '--as', 'source-market', '--home', home, '--json'])
    assert.equal(add.status, 0, add.stderr)
    assert.equal(JSON.parse(add.stdout).source.ownership, 'explicit')

    const list = run(['source', 'list', '--home', home, '--json'])
    assert.equal(list.status, 0, list.stderr)
    assert.deepEqual(JSON.parse(list.stdout).map((item: { id: string }) => item.id), ['source-market'])

    const inspect = run(['source', 'inspect', 'source-market', '--home', home])
    assert.equal(inspect.status, 0, inspect.stderr)
    assert.match(inspect.stdout, /source-market/)
    assert.match(inspect.stdout, /a/)

    const remove = run(['source', 'remove', 'source-market', '--home', home, '--json'])
    assert.equal(remove.status, 0, remove.stderr)
    assert.deepEqual(JSON.parse(remove.stdout), { removed: 'source-market' })
  } finally {
    await temp.cleanup()
  }
})

test('无交互环境的多插件 Source 必须显式选择，重复 --plugin 可原子安装多项', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const source = resolve(temp.path, 'multi-market')
    await buildClaudePlugin(resolve(source, 'plugins/a'), { name: 'a' })
    await buildClaudePlugin(resolve(source, 'plugins/b'), { name: 'b' })
    await writeClaudeMarketplace(source, [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: './plugins/b' },
    ], 'multi-market')

    const missingSelection = run(['install', source, '--source-as', 'multi-market', '--no-enable', '--home', home])
    assert.equal(missingSelection.status, 2)
    assert.match(missingSelection.stderr, /--plugin <id>/)

    const install = run([
      'install', source,
      '--source-as', 'multi-market',
      '--plugin', 'a',
      '--plugin', 'b',
      '--no-enable',
      '--home', home,
      '--json',
    ])
    assert.equal(install.status, 0, install.stderr)
    assert.deepEqual(JSON.parse(install.stdout).plugins.map((item: { plugin: { id: string } }) => item.plugin.id), ['a', 'b'])
  } finally {
    await temp.cleanup()
  }
})

test('CLI 更新共享 Source 必须显式 --yes，并会整体更新全部已安装 Plugin', async () => {
  const temp = await temporaryDirectory()
  try {
    const home = resolve(temp.path, 'home')
    const v1 = resolve(temp.path, 'v1')
    const v2 = resolve(temp.path, 'v2')
    for (const [root, version] of [[v1, '1.0.0'], [v2, '2.0.0']] as const) {
      await buildClaudePlugin(resolve(root, 'plugins/a'), { name: 'a', version, marker: `a-${version}` })
      await buildClaudePlugin(resolve(root, 'plugins/b'), { name: 'b', version, marker: `b-${version}` })
      await writeClaudeMarketplace(root, [
        { name: 'a', source: './plugins/a' },
        { name: 'b', source: './plugins/b' },
      ], 'update-market')
    }

    const install = run([
      'install', v1,
      '--source-as', 'update-market',
      '--plugin', 'a',
      '--plugin', 'b',
      '--no-enable',
      '--home', home,
    ])
    assert.equal(install.status, 0, install.stderr)

    const refused = run(['update', 'a', '--source', v2, '--home', home])
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /--yes/)
    assert.match(refused.stderr, /a/)
    assert.match(refused.stderr, /b/)

    const updated = run(['update', 'a', '--source', v2, '--yes', '--home', home, '--json'])
    assert.equal(updated.status, 0, updated.stderr)
    assert.equal(JSON.parse(updated.stdout).scan.plugin.version, '2.0.0')

    const inspectB = run(['inspect', 'b', '--home', home, '--json'])
    assert.equal(inspectB.status, 0, inspectB.stderr)
    assert.equal(JSON.parse(inspectB.stdout).scan.plugin.version, '2.0.0')
  } finally {
    await temp.cleanup()
  }
})
