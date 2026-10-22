import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { knownParserSignatures } from '../../src/composition/signatures.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, path: string, value: string | Record<string, unknown>): Promise<void> {
  const destination = resolve(root, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, typeof value === 'string' ? value : JSON.stringify(value))
}

async function claudeMarket(root: string, prefix: string, plugins: unknown[]): Promise<void> {
  await put(root, `${prefix ? `${prefix}/` : ''}.claude-plugin/marketplace.json`, {
    name: 'fixture-market', owner: { name: 'fixture' }, plugins,
  })
}

async function plugin(root: string, prefix: string, name: string): Promise<void> {
  await put(root, `${prefix ? `${prefix}/` : ''}.claude-plugin/plugin.json`, { name })
}

test('同格式的两个嵌套市场不能合并同名同位置的不同策略', async () => {
  const temp = await temporaryDirectory()
  try {
    const location = { source: 'url', url: pathToFileURL(resolve(temp.path, 'not-fetched')).href }
    await claudeMarket(temp.path, 'first', [{ name: 'shared', source: location, strict: false }])
    await claudeMarket(temp.path, 'second', [{
      name: 'shared', source: location, strict: true,
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture-only' }] }] },
    }])
    const discovery = await createBuiltinParserEngine().parseSource(temp.path)
    assert.deepEqual(discovery.scan.marketplaceFiles, ['first/.claude-plugin/marketplace.json', 'second/.claude-plugin/marketplace.json'])
    assert.equal(discovery.candidates.length, 1)
    assert.equal(discovery.candidates[0].id, 'shared')
    assert.equal(discovery.candidates[0].installable, false)
    assert(discovery.candidates[0].diagnostics.some(item => item.code === 'SOURCE_PLUGIN_MARKETPLACE_CONFLICT' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})

test('根市场拥有发现范围，不吸入嵌套 fixture 市场', async () => {
  const temp = await temporaryDirectory()
  try {
    await plugin(temp.path, 'plugins/root', 'root-item')
    await claudeMarket(temp.path, '', [{ name: 'root-item', source: './plugins/root' }])
    await claudeMarket(temp.path, 'fixtures/nested', [{
      name: 'fixture-item', source: { source: 'url', url: pathToFileURL(resolve(temp.path, 'not-fetched')).href },
    }])
    const discovery = await createBuiltinParserEngine().parseSource(temp.path)
    assert.equal(discovery.scan.discovery, 'marketplace')
    assert.deepEqual(discovery.scan.marketplaceFiles, ['.claude-plugin/marketplace.json'])
    assert.deepEqual(discovery.candidates.map(candidate => candidate.id), ['root-item'])
    assert.equal(discovery.candidates[0].installable, true)
  } finally {
    await temp.cleanup()
  }
})

test('显式根插件不被其嵌套示例市场接管', async () => {
  const temp = await temporaryDirectory()
  try {
    await plugin(temp.path, '', 'standalone-root')
    await claudeMarket(temp.path, 'examples/nested', [{
      name: 'fixture-item', source: { source: 'url', url: pathToFileURL(resolve(temp.path, 'not-fetched')).href },
    }])
    const discovery = await createBuiltinParserEngine().parseSource(temp.path)
    assert.equal(discovery.scan.discovery, 'single-plugin')
    assert.deepEqual(discovery.scan.marketplaceFiles, [])
    assert.deepEqual(discovery.candidates.map(candidate => candidate.id), ['standalone-root'])
    assert.deepEqual(discovery.candidates[0].location, { type: 'source-path', path: '.' })
    assert.equal(discovery.candidates[0].installable, true)
  } finally {
    await temp.cleanup()
  }
})

test('显式 manual paths 不触发嵌套发现，但不能绕过根市场', async () => {
  const temp = await temporaryDirectory()
  try {
    await plugin(temp.path, 'manual', 'manual-item')
    await plugin(temp.path, 'root-item', 'root-item')
    await claudeMarket(temp.path, 'nested', [{
      name: 'nested-item', source: { source: 'url', url: pathToFileURL(resolve(temp.path, 'not-fetched')).href },
    }])
    const engine = createBuiltinParserEngine()
    const manual = await engine.parseSource(temp.path, { paths: ['./manual'] })
    assert.equal(manual.scan.discovery, 'manual-paths')
    assert.deepEqual(manual.scan.manualPaths, ['manual'])
    assert.deepEqual(manual.scan.marketplaceFiles, [])
    assert.deepEqual(manual.candidates.map(candidate => candidate.id), ['manual-item'])
    assert.equal(manual.candidates[0].installable, true)

    await claudeMarket(temp.path, '', [{ name: 'root-item', source: './root-item' }])
    const root = await engine.parseSource(temp.path, { paths: ['./manual'] })
    assert.equal(root.scan.discovery, 'marketplace')
    assert.deepEqual(root.candidates.map(candidate => candidate.id), ['root-item'])
    assert(root.scan.diagnostics.some(item => item.code === 'SOURCE_MANUAL_PATHS_IGNORED'))
  } finally {
    await temp.cleanup()
  }
})

test('移除解析器仍保留嵌套市场名称边界，不回退为另一个隐式格式', async () => {
  const temp = await temporaryDirectory()
  try {
    // These root skills could otherwise trigger the remaining parser's implicit detection.
    await put(temp.path, 'skills/implicit/SKILL.md', '---\nname: implicit-root\ndescription: Fixture\n---\nBody\n')
    await put(temp.path, 'nested/.agents/plugins/marketplace.json', {
      name: 'missing-parser-market',
      plugins: [{ name: 'owned-item', source: { source: 'local', path: './owned' } }],
    })
    const missingSignature = knownParserSignatures.find(signature => signature.id === 'codex')
    assert.equal(missingSignature?.marketplaceSearchDepth, 4)
    const discovery = await createBuiltinParserEngine(['claude-code']).parseSource(temp.path)
    assert.equal(discovery.scan.discovery, 'marketplace')
    assert.deepEqual(discovery.scan.marketplaceFiles, ['nested/.agents/plugins/marketplace.json'])
    assert.deepEqual(discovery.candidates.map(candidate => candidate.id), ['owned-item'])
    assert.deepEqual(discovery.candidates[0].formats, ['codex'])
    assert.equal(discovery.candidates[0].installable, false)
    assert(discovery.candidates[0].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal(discovery.candidates.some(candidate => candidate.formats.includes('claude-code')), false)
  } finally {
    await temp.cleanup()
  }
})

test('嵌套市场发现不沿目录符号链接跨出来源', async (t) => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'source')
    const outside = resolve(temp.path, 'outside')
    await mkdir(source)
    await claudeMarket(outside, '', [{ name: 'outside-item', source: '.' }])
    try {
      await symlink(outside, resolve(source, 'linked-market'), 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('当前环境不允许创建目录符号链接')
        return
      }
      throw error
    }
    const discovery = await createBuiltinParserEngine().parseSource(source)
    assert.deepEqual(discovery.scan.marketplaceFiles, [])
    assert.equal(discovery.candidates.some(candidate => candidate.id === 'outside-item'), false)
    assert.equal(discovery.candidates.some(candidate => candidate.installable), false)
  } finally {
    await temp.cleanup()
  }
})

test('嵌套市场清单符号链接逃逸被拒绝，不回退为来源根的隐式插件', async (t) => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'source')
    const outside = resolve(temp.path, 'outside')
    await put(source, 'skills/implicit/SKILL.md', '---\nname: implicit-root\ndescription: Fixture\n---\nBody\n')
    await claudeMarket(outside, '', [{ name: 'outside-item', source: '.' }])
    await mkdir(resolve(source, 'nested/.claude-plugin'), { recursive: true })
    try {
      await symlink(resolve(outside, '.claude-plugin/marketplace.json'), resolve(source, 'nested/.claude-plugin/marketplace.json'), 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('当前环境不允许创建文件符号链接')
        return
      }
      throw error
    }
    const discovery = await createBuiltinParserEngine().parseSource(source)
    assert.equal(discovery.scan.discovery, 'marketplace')
    assert.deepEqual(discovery.scan.marketplaceFiles, ['nested/.claude-plugin/marketplace.json'])
    assert.deepEqual(discovery.candidates, [])
    assert(discovery.scan.diagnostics.some(item => item.code === 'SOURCE_MARKETPLACE_PATH_INVALID' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})
