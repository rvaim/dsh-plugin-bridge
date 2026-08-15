import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseCompatPlugin } from '../../src/parser/normalize.js'
import { parseCompatSource } from '../../src/parser/source/index.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function createClaudePlugin(root: string, name: string): Promise<void> {
  await writeJson(resolve(root, '.claude-plugin/plugin.json'), { name, version: '1.0.0' })
  await mkdir(resolve(root, 'skills', 'demo'), { recursive: true })
  await writeFile(resolve(root, 'skills/demo/SKILL.md'), `---\nname: ${name}-skill\ndescription: 测试 Skill\n---\n正文\n`)
}

async function createCodexPlugin(root: string, name: string): Promise<void> {
  await writeJson(resolve(root, '.codex-plugin/plugin.json'), {
    name,
    version: '1.0.0',
    description: '测试插件',
    author: { name: '测试' },
    interface: { displayName: name, shortDescription: '测试', defaultPrompt: '测试' },
  })
  await mkdir(resolve(root, 'skills', 'demo'), { recursive: true })
  await writeFile(resolve(root, 'skills/demo/SKILL.md'), `---\nname: ${name}-skill\ndescription: 测试 Skill\n---\n正文\n`)
}

function claudeMarketplace(name: string, plugins: unknown[]): Record<string, unknown> {
  return { name, owner: { name: '测试维护者' }, plugins }
}

test('Claude Marketplace 只按清单定位插件，不递归猜测未列出的目录', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'market')
    await createClaudePlugin(resolve(root, 'plugins/a'), 'a')
    await createClaudePlugin(resolve(root, 'deep/unlisted'), 'unlisted')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('claude-market', [
      { name: 'a', source: './plugins/a' },
    ]))

    const result = await parseCompatSource(root)
    assert.equal(result.name, 'claude-market')
    assert.equal(result.scan.discovery, 'marketplace')
    assert.deepEqual(result.candidates.map(item => item.id), ['a'])
    assert.deepEqual(result.scan.marketplaceFiles, ['.claude-plugin/marketplace.json'])
  } finally {
    await temp.cleanup()
  }
})

test('Codex Marketplace 解析 local source，并明确执行安装策略', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'market')
    await createCodexPlugin(resolve(root, 'plugins/a'), 'a')
    await createCodexPlugin(resolve(root, 'plugins/b'), 'b')
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'codex-market',
      interface: { displayName: 'Codex 测试市场' },
      plugins: [
        {
          name: 'a',
          source: { source: 'local', path: './plugins/a' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: '测试',
        },
        {
          name: 'b',
          source: { source: 'local', path: './plugins/b' },
          policy: { installation: 'NOT_AVAILABLE', authentication: 'ON_USE' },
          category: '测试',
        },
      ],
    })

    const result = await parseCompatSource(root)
    assert.deepEqual(result.candidates.map(item => item.id), ['a', 'b'])
    assert.equal(result.candidates[0].installable, true)
    assert.equal(result.candidates[1].installable, false)
    assert(result.candidates[1].diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE'))
  } finally {
    await temp.cleanup()
  }
})

test('同一 Source 的 Claude/Codex 同名同真实目录条目合并为一个 Plugin', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'mixed')
    const plugin = resolve(root, 'plugins/shared')
    await createClaudePlugin(plugin, 'shared')
    await createCodexPlugin(plugin, 'shared')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('mixed', [
      { name: 'shared', source: './plugins/shared' },
    ]))
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'mixed',
      plugins: [{ name: 'shared', source: { source: 'local', path: './plugins/shared' } }],
    })

    const result = await parseCompatSource(root)
    assert.equal(result.candidates.length, 1)
    assert.deepEqual(result.candidates[0].formats, ['claude-code', 'codex'])
    assert.equal(result.candidates[0].definitions.length, 2)
    assert.equal(result.candidates[0].installable, true)
  } finally {
    await temp.cleanup()
  }
})

test('同一真实 Plugin 的跨 Marketplace 语义冲突会阻止安装', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'mixed-conflict')
    const plugin = resolve(root, 'plugins/shared')
    await createClaudePlugin(plugin, 'shared')
    await createCodexPlugin(plugin, 'shared')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('mixed-conflict', [
      {
        name: 'shared',
        source: './plugins/shared',
        version: '1.0.0',
        defaultEnabled: true,
      },
    ]))
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'mixed-conflict',
      plugins: [{
        name: 'shared',
        source: { source: 'local', path: './plugins/shared' },
        version: '2.0.0',
        policy: { installation: 'AVAILABLE' },
      }],
    })

    const result = await parseCompatSource(root)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].installable, false)
    assert(result.candidates[0].diagnostics.some(item => item.code === 'SOURCE_PLUGIN_METADATA_CONFLICT'))
  } finally {
    await temp.cleanup()
  }
})

test('同目录双格式插件的等价 Skill 与 MCP 合并为单一运行能力', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'mixed-capabilities')
    const pluginRoot = resolve(root, 'plugins/shared')
    await createClaudePlugin(pluginRoot, 'shared')
    await createCodexPlugin(pluginRoot, 'shared')
    await writeJson(resolve(pluginRoot, '.mcp.json'), {
      mcpServers: {
        shared: {
          command: 'node',
          args: ['./server.mjs'],
        },
      },
    })
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('mixed', [
      { name: 'shared', source: './plugins/shared' },
    ]))
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'mixed',
      plugins: [{ name: 'shared', source: { source: 'local', path: './plugins/shared' } }],
    })

    const source = await parseCompatSource(root)
    const candidate = source.candidates[0]
    const plugin = await parseCompatPlugin(pluginRoot, {
      sourceId: 'mixed',
      sourcePluginId: candidate.id,
      marketplaceDefinitions: candidate.definitions,
    })

    assert.deepEqual(plugin.formats, ['claude-code', 'codex'])
    assert.deepEqual(plugin.skills.map(item => item.name), ['shared-skill'])
    assert.equal(plugin.mcpServers.length, 1)
    assert.equal(plugin.mcpServers[0].serverName, 'shared')
    assert.equal(plugin.mcpServers[0].environmentMode, 'combined-plugin')
    assert.equal(plugin.diagnostics.some(item => item.code === 'SKILL_NAME_DUPLICATE'), false)
    assert.equal(plugin.diagnostics.some(item => item.code === 'MCP_SERVER_NAME_DUPLICATE'), false)
    assert(plugin.diagnostics.some(item => item.code === 'CAPABILITY_FORMAT_ALIAS_MERGED'))
  } finally {
    await temp.cleanup()
  }
})

test('同一 Hook 的双方言声明产生明确冲突，不会在 DSH 中重复执行', async () => {
  const temp = await temporaryDirectory()
  try {
    const pluginRoot = resolve(temp.path, 'mixed-hooks')
    await createClaudePlugin(pluginRoot, 'mixed-hooks')
    await createCodexPlugin(pluginRoot, 'mixed-hooks')
    await writeJson(resolve(pluginRoot, 'hooks/hooks.json'), {
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node check.mjs' }] }],
      },
    })

    const plugin = await parseCompatPlugin(pluginRoot, {
      sourceId: 'mixed-hooks',
      sourcePluginId: 'mixed-hooks',
    })

    assert.equal(plugin.hooks.length, 2)
    assert(plugin.diagnostics.some(item => item.code === 'HOOK_DIALECT_CONFLICT' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})

test('同名不同目录的混合 Marketplace 条目产生冲突且不会猜测合并', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'mixed-conflict')
    await createClaudePlugin(resolve(root, 'claude/shared'), 'shared')
    await createCodexPlugin(resolve(root, 'codex/shared'), 'shared')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('mixed-conflict', [
      { name: 'shared', source: './claude/shared' },
    ]))
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'mixed-conflict',
      plugins: [{ name: 'shared', source: { source: 'local', path: './codex/shared' } }],
    })

    const result = await parseCompatSource(root)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].installable, false)
    assert(result.scan.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_ID_CONFLICT'))
  } finally {
    await temp.cleanup()
  }
})

test('同一 Marketplace 重复 pluginId 明确报错，不静默覆盖', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'duplicate')
    await createClaudePlugin(resolve(root, 'plugins/a'), 'a')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('duplicate', [
      { name: 'a', source: './plugins/a' },
      { name: 'a', source: './plugins/a' },
    ]))
    const result = await parseCompatSource(root)
    assert.equal(result.candidates[0].installable, false)
    assert(result.scan.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_ID_DUPLICATE'))
  } finally {
    await temp.cleanup()
  }
})

test('Marketplace 损坏或缺少必需元数据时不会退化为递归/根目录猜测', async () => {
  const temp = await temporaryDirectory()
  try {
    const malformed = resolve(temp.path, 'malformed')
    await createClaudePlugin(malformed, 'root-plugin')
    await mkdir(resolve(malformed, '.claude-plugin'), { recursive: true })
    await writeFile(resolve(malformed, '.claude-plugin/marketplace.json'), '{bad json')
    const malformedResult = await parseCompatSource(malformed)
    assert.equal(malformedResult.scan.discovery, 'marketplace')
    assert.equal(malformedResult.candidates.length, 0)
    assert(malformedResult.scan.diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_INVALID'))

    const noOwner = resolve(temp.path, 'no-owner')
    await createClaudePlugin(resolve(noOwner, 'plugins/a'), 'a')
    await writeJson(resolve(noOwner, '.claude-plugin/marketplace.json'), {
      name: 'no-owner',
      plugins: [{ name: 'a', source: './plugins/a' }],
    })
    const noOwnerResult = await parseCompatSource(noOwner)
    assert.equal(noOwnerResult.candidates[0].installable, false)
    assert(noOwnerResult.candidates[0].diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_OWNER_INVALID'))
  } finally {
    await temp.cleanup()
  }
})

test('Marketplace 缺失目录和不支持来源产生结构化诊断', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'invalid-locations')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('invalid-locations', [
      { name: 'missing', source: './plugins/missing' },
      { name: 'npm-plugin', source: { source: 'npm', package: '@example/plugin' } },
      { name: 'command-plugin', source: { source: 'command', command: 'make-plugin' } },
    ]))
    const result = await parseCompatSource(root)
    const missing = result.candidates.find(item => item.id === 'missing')
    const npm = result.candidates.find(item => item.id === 'npm-plugin')
    const command = result.candidates.find(item => item.id === 'command-plugin')
    assert.equal(missing?.installable, false)
    assert(missing?.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_PATH_MISSING'))
    assert.equal(npm?.installable, false)
    assert(npm?.diagnostics.some(item => item.code === 'SOURCE_LOCATION_NPM_UNSUPPORTED'))
    assert.equal(command?.installable, false)
    assert(command?.diagnostics.some(item => item.code === 'SOURCE_LOCATION_COMMAND_REQUIRES_AUTHORIZATION'))
  } finally {
    await temp.cleanup()
  }
})

test('外部 Git、git-subdir 与 Codex url.path 被规范化但不在扫描阶段执行代码', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'external')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('external', [
      { name: 'git', source: { source: 'url', url: 'https://example.com/plugin.git', ref: 'main' } },
      { name: 'subdir', source: { source: 'git-subdir', url: 'owner/repo', path: 'plugins/sub', ref: 'v1' } },
    ]))
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'external',
      plugins: [{
        name: 'codex-subdir',
        source: { source: 'url', url: 'https://example.com/repo.git', path: './plugins/codex' },
      }],
    })
    const result = await parseCompatSource(root)
    assert.equal(result.candidates.find(item => item.id === 'git')?.location.type, 'git')
    assert.equal(result.candidates.find(item => item.id === 'subdir')?.location.type, 'git-subdir')
    const codex = result.candidates.find(item => item.id === 'codex-subdir')
    assert.equal(codex?.location.type, 'git-subdir')
    assert.equal(codex?.location.type === 'git-subdir' ? codex.location.path : undefined, 'plugins/codex')
  } finally {
    await temp.cleanup()
  }
})

test('单插件根目录、归档单层包装目录与 paths 使用同一识别模型', async () => {
  const temp = await temporaryDirectory()
  try {
    const single = resolve(temp.path, 'single')
    await createClaudePlugin(single, 'single')
    const singleResult = await parseCompatSource(single)
    assert.equal(singleResult.scan.discovery, 'single-plugin')
    assert.equal(singleResult.candidates[0].id, 'single')

    const wrapped = resolve(temp.path, 'wrapped')
    await createClaudePlugin(resolve(wrapped, 'repo-main'), 'wrapped-plugin')
    const withoutWrapper = await parseCompatSource(wrapped)
    assert.equal(withoutWrapper.candidates[0].installable, false)
    const withWrapper = await parseCompatSource(wrapped, { allowSingleWrapper: true })
    assert.equal(withWrapper.candidates[0].id, 'wrapped-plugin')
    assert.equal(withWrapper.root, resolve(wrapped, 'repo-main'))

    const manual = resolve(temp.path, 'manual')
    await createClaudePlugin(resolve(manual, 'packages/a'), 'a')
    await createClaudePlugin(resolve(manual, 'packages/b'), 'b')
    const manualResult = await parseCompatSource(manual, { paths: ['packages/a'] })
    assert.equal(manualResult.scan.discovery, 'manual-paths')
    assert.deepEqual(manualResult.candidates.map(item => item.id), ['a'])
  } finally {
    await temp.cleanup()
  }
})

test('metadata.pluginRoot 与 Codex 本地路径前缀按各自生态规则处理', async () => {
  const temp = await temporaryDirectory()
  try {
    const claudeRoot = resolve(temp.path, 'claude-root')
    await createClaudePlugin(resolve(claudeRoot, 'plugins/a'), 'a')
    await writeJson(resolve(claudeRoot, '.claude-plugin/marketplace.json'), {
      ...claudeMarketplace('plugin-root', [{ name: 'a', source: 'a' }]),
      metadata: { pluginRoot: './plugins' },
    })
    const claude = await parseCompatSource(claudeRoot)
    assert.equal(claude.candidates[0].location.type === 'source-path' ? claude.candidates[0].location.path : undefined, 'plugins/a')
    assert.equal(claude.candidates[0].installable, true)

    const codexRoot = resolve(temp.path, 'codex-prefix')
    await createCodexPlugin(resolve(codexRoot, 'plugins/a'), 'a')
    await writeJson(resolve(codexRoot, '.agents/plugins/marketplace.json'), {
      name: 'codex-prefix',
      plugins: [{ name: 'a', source: { source: 'local', path: 'plugins/a' } }],
    })
    const codex = await parseCompatSource(codexRoot)
    assert.equal(codex.candidates[0].installable, false)
    assert(codex.candidates[0].diagnostics.some(item => item.code === 'SOURCE_LOCATION_INVALID'))
  } finally {
    await temp.cleanup()
  }
})

test('共享 Source 根目录的 Marketplace 条目只解析自身显式能力路径', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'shared-root')
    await mkdir(resolve(root, 'plugin-a-skills/a'), { recursive: true })
    await mkdir(resolve(root, 'plugin-b-skills/b'), { recursive: true })
    await writeFile(resolve(root, 'plugin-a-skills/a/SKILL.md'), '---\nname: skill-a\ndescription: A 的 Skill\n---\nA\n')
    await writeFile(resolve(root, 'plugin-b-skills/b/SKILL.md'), '---\nname: skill-b\ndescription: B 的 Skill\n---\nB\n')
    // 根目录还存在默认 skills/，用于证明显式条目不会越界扫描。
    await mkdir(resolve(root, 'skills/leaked'), { recursive: true })
    await writeFile(resolve(root, 'skills/leaked/SKILL.md'), '---\nname: leaked\ndescription: 不应被解析\n---\n泄漏\n')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('shared-root', [
      { name: 'plugin-a', source: './', strict: false, skills: ['./plugin-a-skills'] },
      { name: 'plugin-b', source: './', strict: false, skills: ['./plugin-b-skills'] },
    ]))

    const source = await parseCompatSource(root)
    const candidate = source.candidates.find(item => item.id === 'plugin-a')
    assert(candidate)
    const plugin = await parseCompatPlugin(root, {
      sourceId: 'shared-root',
      sourcePluginId: candidate.id,
      marketplaceDefinitions: candidate.definitions,
    })

    assert.deepEqual(plugin.skills.map(item => item.name), ['skill-a'])
    assert.equal(plugin.skills.some(item => item.name === 'skill-b'), false)
    assert.equal(plugin.skills.some(item => item.name === 'leaked'), false)
  } finally {
    await temp.cleanup()
  }
})

test('Claude Marketplace strict=false 不回退扫描条目未声明的默认能力', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'non-strict')
    const pluginRoot = resolve(root, 'plugins/a')
    await createClaudePlugin(pluginRoot, 'a')
    await mkdir(resolve(pluginRoot, 'hooks'), { recursive: true })
    await mkdir(resolve(pluginRoot, 'workflows'), { recursive: true })
    await mkdir(resolve(pluginRoot, 'bin'), { recursive: true })
    await writeJson(resolve(pluginRoot, 'hooks/hooks.json'), { hooks: {} })
    await writeFile(resolve(pluginRoot, '.lsp.json'), '{}')
    await writeFile(resolve(pluginRoot, 'settings.json'), '{}')
    await writeJson(resolve(pluginRoot, '.mcp.json'), {
      mcpServers: {
        hidden: { command: 'node', args: ['server.mjs'] },
      },
    })
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('non-strict', [
      { name: 'a', source: './plugins/a', strict: false },
    ]))

    const source = await parseCompatSource(root)
    const candidate = source.candidates[0]
    const plugin = await parseCompatPlugin(pluginRoot, {
      sourceId: 'non-strict',
      sourcePluginId: candidate.id,
      marketplaceDefinitions: candidate.definitions,
    })

    assert.equal(plugin.skills.length, 0)
    assert.equal(plugin.mcpServers.length, 0)
    assert.equal(plugin.hooks.length, 0)
    for (const code of [
      'CLAUDE_WORKFLOWS_UNSUPPORTED',
      'CLAUDE_LSP_UNSUPPORTED',
      'CLAUDE_BIN_PATH_UNSUPPORTED',
      'CLAUDE_SETTINGS_UNSUPPORTED',
    ]) {
      assert.equal(plugin.diagnostics.some(item => item.code === code), false, code)
    }
  } finally {
    await temp.cleanup()
  }
})

test('Claude Marketplace strict=false 与 plugin.json 能力字段冲突时明确拒绝启用', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'non-strict-conflict')
    const pluginRoot = resolve(root, 'plugins/a')
    await writeJson(resolve(pluginRoot, '.claude-plugin/plugin.json'), {
      name: 'a',
      version: '1.0.0',
      skills: './skills',
    })
    await mkdir(resolve(pluginRoot, 'skills/demo'), { recursive: true })
    await writeFile(resolve(pluginRoot, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: 测试\n---\n正文\n')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('non-strict-conflict', [
      { name: 'a', source: './plugins/a', strict: false },
    ]))

    const source = await parseCompatSource(root)
    const candidate = source.candidates[0]
    const plugin = await parseCompatPlugin(pluginRoot, {
      sourceId: 'non-strict-conflict',
      sourcePluginId: candidate.id,
      marketplaceDefinitions: candidate.definitions,
    })

    assert.equal(plugin.skills.length, 0)
    assert(plugin.diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})

test('Marketplace 允许 Source 内安全目录符号链接，并拒绝逃逸 Source 的链接', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'symlink-market')
    const outside = resolve(temp.path, 'outside-plugin')
    await createClaudePlugin(resolve(root, 'plugins/actual'), 'safe')
    await createClaudePlugin(outside, 'outside')
    await mkdir(resolve(root, 'aliases'), { recursive: true })
    await symlink(resolve(root, 'plugins/actual'), resolve(root, 'aliases/safe'), 'dir')
    await symlink(outside, resolve(root, 'aliases/escape'), 'dir')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('symlink-market', [
      { name: 'safe', source: './aliases/safe' },
      { name: 'escape', source: './aliases/escape' },
    ]))

    const result = await parseCompatSource(root)
    const safe = result.candidates.find(item => item.id === 'safe')
    const escape = result.candidates.find(item => item.id === 'escape')
    assert(safe)
    assert(escape)
    assert.equal(safe.installable, true)
    assert.equal(safe.diagnostics.some(item => item.level === 'error'), false)
    assert.equal(escape.installable, false)
    assert(escape.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_PATH_ESCAPE'))
  } finally {
    await temp.cleanup()
  }
})

test('Marketplace 拒绝指向普通文件的目录符号链接', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'symlink-file-market')
    await mkdir(resolve(root, 'plugins'), { recursive: true })
    await mkdir(resolve(root, 'aliases'), { recursive: true })
    await writeFile(resolve(root, 'plugins/not-a-directory'), '普通文件\n')
    await symlink(resolve(root, 'plugins/not-a-directory'), resolve(root, 'aliases/file'))
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), claudeMarketplace('symlink-file-market', [
      { name: 'file-link', source: './aliases/file' },
    ]))

    const result = await parseCompatSource(root)
    assert.equal(result.candidates[0].installable, false)
    assert(result.candidates[0].diagnostics.some(item => item.code === 'SOURCE_PLUGIN_PATH_NOT_DIRECTORY'))
  } finally {
    await temp.cleanup()
  }
})

test('Claude Marketplace 元数据和插件可选字段类型错误会阻止安装', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'claude-invalid-fields')
    await createClaudePlugin(resolve(root, 'plugins/a'), 'a')
    await writeJson(resolve(root, '.claude-plugin/marketplace.json'), {
      ...claudeMarketplace('claude-invalid-fields', [{
        name: 'a',
        source: './plugins/a',
        displayName: 123,
        description: [],
        version: false,
        strict: 'yes',
        defaultEnabled: 'yes',
      }]),
      metadata: { pluginRoot: 42 },
    })

    const result = await parseCompatSource(root)
    const candidate = result.candidates[0]
    assert.equal(candidate.installable, false)
    for (const code of [
      'CLAUDE_MARKETPLACE_PLUGIN_ROOT_INVALID',
      'SOURCE_PLUGIN_DISPLAY_NAME_INVALID',
      'SOURCE_PLUGIN_DESCRIPTION_INVALID',
      'SOURCE_PLUGIN_VERSION_INVALID',
      'SOURCE_PLUGIN_STRICT_INVALID',
      'SOURCE_PLUGIN_DEFAULT_ENABLED_INVALID',
    ]) {
      assert(candidate.diagnostics.some(item => item.code === code), `缺少诊断：${code}`)
    }
  } finally {
    await temp.cleanup()
  }
})

test('Codex Marketplace policy/interface/category 字段错误会产生明确诊断', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'codex-invalid-fields')
    await createCodexPlugin(resolve(root, 'plugins/a'), 'a')
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'codex-invalid-fields',
      interface: { displayName: 123 },
      plugins: [{
        name: 'a',
        source: { source: 'local', path: './plugins/a' },
        category: [],
        policy: {
          installation: 'SOMETIMES',
          authentication: 'NEVER',
        },
      }],
    })

    const result = await parseCompatSource(root)
    const candidate = result.candidates[0]
    assert.equal(candidate.installable, false)
    for (const code of [
      'CODEX_MARKETPLACE_DISPLAY_NAME_INVALID',
      'CODEX_MARKETPLACE_INSTALLATION_POLICY_INVALID',
      'CODEX_MARKETPLACE_AUTH_POLICY_INVALID',
      'CODEX_MARKETPLACE_CATEGORY_INVALID',
    ]) {
      assert(candidate.diagnostics.some(item => item.code === code), `缺少诊断：${code}`)
    }
  } finally {
    await temp.cleanup()
  }
})

test('Codex Marketplace 内联 manifest 可在缺少 plugin.json 时作为回退清单', async () => {
  const temp = await temporaryDirectory()
  try {
    const root = resolve(temp.path, 'market')
    const pluginRoot = resolve(root, 'plugins/fallback')
    await mkdir(resolve(pluginRoot, 'skills', 'demo'), { recursive: true })
    await writeFile(resolve(pluginRoot, 'skills/demo/SKILL.md'), '---\nname: fallback-skill\ndescription: 回退 Skill\n---\n正文')
    await writeJson(resolve(root, '.agents/plugins/marketplace.json'), {
      name: 'fallback-market',
      plugins: [{
        name: 'fallback',
        source: { source: 'local', path: './plugins/fallback' },
        version: '1.0.0',
        interface: { displayName: '回退插件' },
        skills: ['./skills/demo'],
        mcpServers: {
          fallback: { command: 'node', args: ['./server.mjs'] },
        },
      }],
    })

    const source = await parseCompatSource(root)
    const candidate = source.candidates[0]
    const plugin = await parseCompatPlugin(pluginRoot, {
      sourceId: 'fallback-market',
      sourcePluginId: candidate.id,
      marketplaceDefinitions: candidate.definitions,
    })
    assert.equal(plugin.name, '回退插件')
    assert.equal(plugin.version, '1.0.0')
    assert.deepEqual(plugin.skills.map(item => item.name), ['fallback-skill'])
    assert.deepEqual(plugin.mcpServers.map(item => item.serverName), ['fallback'])
    assert(plugin.diagnostics.some(item => item.code === 'CODEX_MARKETPLACE_MANIFEST_FALLBACK'))
    assert.equal(plugin.diagnostics.some(item => item.code === 'CODEX_PLUGIN_MANIFEST_MISSING'), false)
  } finally {
    await temp.cleanup()
  }
})
