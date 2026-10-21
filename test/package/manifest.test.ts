import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { en, zh } from '../../src/web/client/locales.js'
import test from 'node:test'

test('发布清单是可安装 DSH bundle，且运行包不夹带测试目录', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as any
  assert.equal(packageJson.name, '@rvaim/dsh-plugin-bridge')
  assert.equal(packageJson.version, '0.6.0')
  assert.equal(packageJson.publishConfig.access, 'public')
  assert.equal(packageJson.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(packageJson.repository.url, 'git+https://github.com/rvaim/dsh-compat.git')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.bin, undefined)
  assert(packageJson.files.includes('dist/src/'))
  assert.equal(packageJson.files.includes('dist/'), false)
  assert.equal(packageJson.peerDependenciesMeta?.['@deepseek-ai/schemastery'], undefined)
  assert.equal(packageJson.dependencies?.['@deepseek-ai/dsh-hook-protocol'], packageJson.engines.dsh)
  assert.equal(packageJson.devDependencies?.['@deepseek-ai/dsh-typert-generator'], packageJson.engines.dsh)
  for (const [name, range] of Object.entries(packageJson.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, packageJson.engines.dsh, name)
  }
  assert.equal(packageJson.dependencies?.['ajv'], '8.20.0')
  assert.equal(packageJson.dependencies?.['@clack/prompts'], undefined)
  assert.equal(packageJson.peerDependencies?.['@deepseek-ai/dsh-hook-protocol'], undefined)
  assert.equal(packageJson.peerDependenciesMeta?.['@deepseek-ai/dsh-hook-protocol'], undefined)
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  for (const name of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-settings']) {
    assert.equal(packageJson.dsh.client.inject.includes(name), false)
    assert.equal(packageJson.peerDependencies[name], undefined)
    assert.equal(packageJson.devDependencies[name], undefined)
  }
  assert.equal(packageJson.exports['./client'].types, './dist/src/web/client/index.d.ts')
  assert.equal(packageJson.exports['./client'].default, './dist/client.js')
  assert.equal(packageJson.exports['./typert'].default, './dist/typert.host.js')
  assert.equal(packageJson.exports['./remote'].default, './dist/typert.remote-client.js')
  for (const file of [
    'dist/client.js',
    'dist/typert.host.js',
    'dist/typert.host.d.ts',
    'dist/typert.remote-client.js',
    'dist/typert.remote-client.d.ts',
    'dist/typert.remote-client.d.ts.map',
  ]) assert(packageJson.files.includes(file))

  const patch = await readFile(resolve('cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*plugin-bridge/)
  assert.match(patch, /name:\s*['"]@rvaim\/dsh-plugin-bridge['"]/)
  for (const file of [
    'README.md',
    'CHANGELOG.md',
    'docs/包更名说明.md',
    'docs/架构与生命周期.md',
    'docs/传统插件兼容矩阵.md',
    'docs/安全模型.md',
    'docs/测试策略.md',
    'docs/使用与运维.md',
    'docs/传统插件解析兼容方案.md',
    'docs/插件协议兼容验证报告.md',
    'docs/Agent Plugins 1.0.0 兼容说明.md',
    'docs/解析器解耦重构说明.md',
    'docs/解析器解耦验证报告.md',
    'docs/Agent Plugins 1.0.0 验证报告.md',
    'docs/assets/compat-settings.png',
  ]) {
    await access(resolve(file))
  }
})

test('Plugin Bridge 的中英文展示、图标和包级资源一致', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as any
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.png')
  assert(manifest.files.includes('locale/*.json'))
  assert(manifest.files.includes('icon.png'))
  for (const [language, expected, client] of [['zh', '插件桥', zh], ['en', 'Plugin Bridge', en]] as const) {
    const resource = JSON.parse(await readFile(resolve(`locale/${language}.json`), 'utf8')) as any
    assert.equal(resource.meta.title, expected)
    assert.equal(client.title, expected)
    assert.equal(client.nav, expected)
    for (const format of ['Claude Code', 'Codex', 'Agent Plugins']) assert(resource.meta.description.includes(format))
  }
  const icon = await readFile(resolve('icon.png'))
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(icon.readUInt32BE(16), 256)
  assert.equal(icon.readUInt32BE(20), 256)
  assert(icon.length <= 256 * 1024)
})
