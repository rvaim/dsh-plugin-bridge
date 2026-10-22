import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { parseCompatPlugin } from '../../src/composition/defaults.js'
import { parseClaudeHarness } from '../../src/protocols/claude-code/harness.js'
import { parseCodexHarness } from '../../src/protocols/codex/harness.js'
import { DiagnosticCollector } from '../../src/shared/diagnostics.js'
import { parseCompatSource } from '../../src/composition/defaults.js'
import type { MarketplacePluginDefinition } from '../../src/types/catalog.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, file: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(root, file)), { recursive: true })
  await writeFile(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value))
}

const skill = (name: string): string => `---\nname: ${name}\ndescription: compatibility fixture\n---\nBody`
const event = (command: string): unknown[] => [{ hooks: [{ type: 'command', command }] }]
function definition(fields: Record<string, unknown> = {}, extra: Partial<MarketplacePluginDefinition> = {}): MarketplacePluginDefinition {
  return { format: 'claude-code', file: '.claude-plugin/marketplace.json', pointer: '/plugins/0', name: 'compat', sourcePathIsRoot: false, manifestFields: { name: 'compat', ...fields }, ...fields, ...extra }
}

async function fixture(format: 'claude-code' | 'codex', manifest: Record<string, unknown>, files: Record<string, unknown>, run: (root: string) => Promise<void>): Promise<void> {
  const temp = await temporaryDirectory()
  try {
    await put(temp.path, `.${format === 'claude-code' ? 'claude' : 'codex'}-plugin/plugin.json`, { name: 'compat', ...manifest })
    for (const [file, value] of Object.entries(files)) await put(temp.path, file, value)
    await run(temp.path)
  } finally { await temp.cleanup() }
}

test('CC strict=false 检查条目组件，保留已有 manifest 组件', async () => {
  await fixture('claude-code', { commands: './extra/run.md', hooks: { Stop: event('manifest') } }, { 'extra/run.md': '# run' }, async root => {
    const valid = await parseCompatPlugin(root, { marketplaceDefinitions: [definition({}, { strict: false })] })
    assert.deepEqual(valid.commands.map(item => item.name), ['run'])
    assert.equal(valid.hooks.length, 1)
    assert(!valid.diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT'))
    const conflicting = await parseCompatPlugin(root, { marketplaceDefinitions: [definition({ commands: [] }, { strict: false })] })
    assert(conflicting.diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_NON_STRICT_CONFLICT' && item.level === 'error'))
    assert.deepEqual(conflicting.commands.map(item => item.name), ['run'])
  })
})

test('CC strict=true entry 同事件替换，其他 manifest 事件及 JSON pointer 保留', async () => {
  const hooks = { PreToolUse: event('manifest-pre'), Stop: event('manifest-stop') }
  const entryHooks = { PreToolUse: event('entry-pre') }
  await fixture('claude-code', { hooks }, {
    'hooks/hooks.json': { hooks: { PreToolUse: event('default-pre'), SessionStart: event('default-start') } },
    '.claude-plugin/marketplace.json': { plugins: [{ hooks: entryHooks }] },
  }, async root => {
    const parsed = await parseCompatPlugin(root, { marketplaceDefinitions: [definition({ hooks: entryHooks })] })
    assert.equal(parsed.hooks.filter(item => item.event === 'pre-tool-use').length, 1)
    assert.deepEqual(new Set(parsed.hooks.map(item => item.event)), new Set(['pre-tool-use', 'stop', 'session-start']))
    const pre = parsed.hooks.find(item => item.event === 'pre-tool-use')!.commands[0].command
    assert.equal(pre.type, 'deferred-json')
    if (pre.type === 'deferred-json') assert.deepEqual([pre.file, pre.pointer], ['.claude-plugin/marketplace.json', '/plugins/0/hooks/PreToolUse/0/hooks/0/command'])
    const stop = parsed.hooks.find(item => item.event === 'stop')!.commands[0].command
    if (stop.type === 'deferred-json') assert.equal(stop.pointer, '/hooks/Stop/0/hooks/0/command')
  })
})

test('CC 无 manifest 的 entry hooks 仅支持 inline，无论 strict', async () => {
  const temp = await temporaryDirectory()
  try {
    for (const strict of [false, true]) {
      for (const hooks of ['./hooks/extra.json', [{ Stop: event('entry') }]]) {
        const collector = new DiagnosticCollector()
        const descriptor = await parseClaudeHarness(temp.path, collector, false, definition({ hooks }, { strict }))
        assert.equal(descriptor.hookSources.length, 0)
        assert(collector.items.some(item => item.code === 'CLAUDE_MARKETPLACE_HOOKS_FORM_UNSUPPORTED'))
      }
      const collector = new DiagnosticCollector()
      const descriptor = await parseClaudeHarness(temp.path, collector, false, definition({ hooks: { Stop: event('inline') } }, { strict }))
      assert.equal(descriptor.hookSources[0].pointer, '/plugins/0/hooks')
      assert(!collector.items.some(item => item.level === 'error'))
    }
  } finally { await temp.cleanup() }
})

test('CC 显式 commands/agents 替换默认，skills 追加默认', async () => {
  await fixture('claude-code', { commands: './extra/command.md', agents: './extra/agent.md', skills: './extra/skills' }, {
    'commands/default.md': '# default', 'agents/default.md': '# default',
    'skills/default/SKILL.md': skill('default'), 'extra/skills/extra/SKILL.md': skill('extra'),
    'extra/command.md': '# command', 'extra/agent.md': '# agent',
  }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.deepEqual(plugin.commands.map(item => item.name), ['command'])
    assert.deepEqual(plugin.agents.map(item => item.name), ['agent'])
    assert.deepEqual(new Set(plugin.skills.map(item => item.name)), new Set(['default', 'extra']))
    assert(!plugin.diagnostics.some(item => item.level === 'error'))
  })
})

test('CC 默认 MCP 先读再按声明顺序覆盖整个 server，保留最后凭据来源', async () => {
  await fixture('claude-code', { mcpServers: ['./extra/mcp.json', { shared: { command: 'node', args: ['last'], env: { TOKEN: 'private-last' } } }] }, {
    '.mcp.json': { mcpServers: { shared: { command: 'node', args: ['first'] }, onlyDefault: { command: 'node' } } },
    'extra/mcp.json': { mcpServers: { shared: { command: 'node', args: ['middle'] }, onlyPath: { command: 'node' } } },
  }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.deepEqual(new Set(plugin.mcpServers.map(item => item.serverName)), new Set(['shared', 'onlyDefault', 'onlyPath']))
    assert(!plugin.diagnostics.some(item => item.code === 'MCP_SERVER_NAME_DUPLICATE'))
    const server = plugin.mcpServers.find(item => item.serverName === 'shared')!
    assert.equal(server.sourceFile, '.claude-plugin/plugin.json')
    assert.equal(server.transport, 'stdio')
    if (server.transport === 'stdio') {
      assert.equal(server.env.TOKEN.type, 'deferred-json')
      if (server.env.TOKEN.type === 'deferred-json') assert.equal(server.env.TOKEN.pointer, '/mcpServers/1/shared/env/TOKEN')
    }
    assert(!JSON.stringify(plugin).includes('private-last'))
  })
})

test('CC Marketplace 文件 MCP 来源不继承 entry JSON pointer', async () => {
  await fixture('claude-code', {}, { 'extra/mcp.json': { mcpServers: { remote: { command: 'node', args: ['secret'] } } } }, async root => {
    const collector = new DiagnosticCollector()
    const descriptor = await parseClaudeHarness(root, collector, false, definition({ mcpServers: './extra/mcp.json' }))
    assert.deepEqual(descriptor.mcpSources, [{ file: 'extra/mcp.json' }])
    const plugin = await parseCompatPlugin(root, { marketplaceDefinitions: [definition({ mcpServers: './extra/mcp.json' })] })
    const server = plugin.mcpServers[0]
    if (server.transport === 'stdio' && server.args[0].type === 'deferred-json') assert.equal(server.args[0].pointer, '/mcpServers/remote/args/0')
  })
})

test('传统 Codex 有效 skills/hooks/MCP 显式声明替换默认', async () => {
  await fixture('codex', { skills: './extra/skills', hooks: [{ hooks: { Stop: event('explicit') } }], mcpServers: { explicit: { command: 'node' } } }, {
    'skills/default/SKILL.md': skill('default'), 'extra/skills/extra/SKILL.md': skill('extra'),
    'hooks/hooks.json': { hooks: { SessionStart: event('default') } }, '.mcp.json': { mcpServers: { default: { command: 'node' } } },
  }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.deepEqual(plugin.skills.map(item => item.name), ['extra'])
    assert.deepEqual(plugin.hooks.map(item => item.event), ['stop'])
    assert.deepEqual(plugin.mcpServers.map(item => item.serverName), ['explicit'])
  })
})

test('传统 Codex 空/无效路径列表、hooks和MCP 按 resolver 结果回退，[]不统一关闭', async () => {
  const defaults = { 'skills/default/SKILL.md': skill('default'), 'hooks/hooks.json': { hooks: { Stop: event('default') } }, '.mcp.json': { mcpServers: { default: { command: 'node' } } } }
  for (const invalid of [[], null, 42, '', 'missing-prefix']) {
    await fixture('codex', { skills: invalid, hooks: invalid, mcpServers: invalid }, defaults, async root => {
      const plugin = await parseCompatPlugin(root)
      assert.deepEqual(plugin.skills.map(item => item.name), ['default'])
      assert.equal(plugin.hooks.length, 1)
      assert.deepEqual(plugin.mcpServers.map(item => item.serverName), ['default'])
      assert(plugin.diagnostics.some(item => item.code === 'CODEX_COMPONENT_DEFAULT_FALLBACK'))
    })
  }
  await fixture('codex', { hooks: {}, mcpServers: {} }, defaults, async root => {
    const collector = new DiagnosticCollector()
    const descriptor = await parseCodexHarness(root, collector)
    assert.deepEqual(descriptor.hookSources.map(item => item.file), ['.codex-plugin/plugin.json'])
    assert.deepEqual(descriptor.mcpSources.map(item => item.file), ['.codex-plugin/plugin.json'])
  })
})

test('传统 Codex 有效但不存在的显式路径不误回退，混合 hooks 数组整体无效', async () => {
  await fixture('codex', { skills: './absent', hooks: './absent.json', mcpServers: './absent.json' }, {
    'skills/default/SKILL.md': skill('default'), 'hooks/hooks.json': { hooks: { Stop: event('default') } }, '.mcp.json': { mcpServers: { default: { command: 'node' } } },
  }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.equal(plugin.skills.length, 0)
    assert.equal(plugin.hooks.length, 0)
    assert.equal(plugin.mcpServers.length, 0)
    assert(plugin.diagnostics.some(item => item.code === 'DECLARED_PATH_MISSING'))
    await put(root, '.codex-plugin/plugin.json', { name: 'compat', hooks: ['./absent.json', { hooks: { PreToolUse: event('inline') } }] })
    const fallback = await parseCompatPlugin(root)
    assert.deepEqual(fallback.hooks.map(item => item.event), ['stop'])
    assert(fallback.diagnostics.some(item => item.code === 'CODEX_COMPONENT_DEFAULT_FALLBACK'))
  })
})

test('CC command object 正确识别 source/content，缓存保留inline来源且不执行', async () => {
  await fixture('claude-code', { commands: { renamed: { source: './docs/original.md', argumentHint: '[env]' }, inline: { content: 'private-inline-body', description: 'About', allowedTools: ['Read'] } } }, {
    'docs/original.md': '---\nname: original\ndescription: file description\n---\nBody', 'commands/default.md': '# hidden',
  }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.deepEqual(new Set(plugin.commands.map(item => item.name)), new Set(['renamed', 'inline']))
    assert.equal(plugin.commands.find(item => item.name === 'renamed')!.contentPath, 'docs/original.md')
    const inline = plugin.commands.find(item => item.name === 'inline')!
    assert.equal(inline.contentPath, '.claude-plugin/plugin.json')
    assert.deepEqual(inline.contentSource, { type: 'inline', pointer: '/commands/inline/content' })
    assert.equal(inline.description, 'About')
    assert(!JSON.stringify(plugin).includes('private-inline-body'))
    assert.equal(plugin.diagnostics.filter(item => item.code === 'COMMAND_RUNTIME_UNSUPPORTED').length, 2)
  })
})

test('CC 非法 command object、组件类型与边界产生error', async () => {
  await fixture('claude-code', { commands: { both: { source: './a.md', content: 'x' }, neither: {}, bad: { content: 1 } }, agents: './agents', skills: '../escape' }, { 'agents/a.md': '# a' }, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.equal(plugin.commands.length, 0)
    assert.equal(plugin.diagnostics.filter(item => item.code === 'COMMAND_CONTENT_SOURCE_INVALID').length, 3)
    assert(plugin.diagnostics.some(item => item.code === 'DECLARED_PATH_KIND_INVALID'))
    assert(plugin.diagnostics.some(item => item.code === 'DECLARED_PATH_ESCAPE'))
  })
})

test('CC metadata/defaultEnabled优先级正确，不误报自由metadata，关键未适配语义阻止启用', async () => {
  await fixture('claude-code', { defaultEnabled: false, displayName: 'Manifest', metadata: { arbitrary: { useful: true } }, settings: { agent: 'reviewer' }, userConfig: {}, dependencies: ['required'] }, {}, async root => {
    const plugin = await parseCompatPlugin(root, { marketplaceDefinitions: [definition({ displayName: 'Entry' }, { defaultEnabled: true })] })
    assert.equal(plugin.defaultEnabled, true)
    assert.equal(plugin.name, 'Entry')
    assert(!plugin.diagnostics.some(item => item.code === 'PLUGIN_MANIFEST_UNKNOWN_FIELD'))
    for (const code of ['CLAUDE_SETTINGS_UNSUPPORTED', 'CLAUDE_USER_CONFIG_UNSUPPORTED', 'CLAUDE_PLUGIN_DEPENDENCIES_UNSUPPORTED']) assert(plugin.diagnostics.some(item => item.code === code && item.level === 'error'))
  })
})

test('传统 Codex interface/apps/onboarding 合法识别，未知字段仅诊断，无runtime伪支持', async () => {
  await fixture('codex', { interface: { displayName: 'Display', capabilities: ['tools'], defaultPrompt: ['Try it'], logo: './assets/logo.svg' }, apps: './apps.json', extensions: { 'com.openai': { onboardingSkill: 'skills/setup' } }, extraTypo: true }, {}, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.equal(plugin.name, 'Display')
    for (const code of ['CODEX_INTERFACE_METADATA_RECOGNIZED', 'CODEX_APPS_UNSUPPORTED', 'CODEX_ONBOARDING_UNSUPPORTED', 'PLUGIN_MANIFEST_UNKNOWN_FIELD']) assert(plugin.diagnostics.some(item => item.code === code))
    assert(!plugin.diagnostics.some(item => item.level === 'error'))
  })
})

test('CC MCP bundles 是合法但未适配来源，显式诊断而非当JSON解析', async () => {
  await fixture('claude-code', { mcpServers: ['./server.mcpb', './server.dxt', 'https://example.com/server.mcpb'] }, {}, async root => {
    const plugin = await parseCompatPlugin(root)
    assert.equal(plugin.diagnostics.filter(item => item.code === 'MCP_BUNDLE_UNSUPPORTED').length, 3)
    assert(!plugin.diagnostics.some(item => item.code === 'MCP_CONFIG_INVALID'))
  })
})

test('CC Marketplace npm/archive/command source 合法识别但不安装脚本', async () => {
  const temp = await temporaryDirectory()
  try {
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'market', owner: { name: 'owner' }, plugins: [
      { name: 'npm-one', source: { source: 'npm', package: '@example/plugin' }, metadata: { custom: true }, defaultEnabled: false },
      { name: 'archive-one', source: { source: 'archive', url: 'https://example.com/plugin.zip' } },
      { name: 'command-one', source: { source: 'command', command: 'never execute' } },
    ] })
    const source = await parseCompatSource(temp.path)
    assert.equal(source.candidates.length, 3)
    assert(source.candidates.every(item => !item.installable))
    const codes = source.candidates.flatMap(item => item.diagnostics.map(diagnostic => diagnostic.code))
    for (const code of ['SOURCE_LOCATION_NPM_UNSUPPORTED', 'SOURCE_LOCATION_ARCHIVE_URL_UNSUPPORTED', 'SOURCE_LOCATION_COMMAND_UNSUPPORTED']) assert(codes.includes(code))
    assert(!codes.includes('SOURCE_LOCATION_INVALID'))
    const npm = source.candidates.find(item => item.id === 'npm-one')!
    assert.equal(npm.defaultEnabled, false)
    assert.equal(npm.definitions[0].defaultEnabled, false)
  } finally { await temp.cleanup() }
})

test('传统 Codex hooks各有效形式及MCP文件路径替换默认，不限制JSON文件扩展名', async () => {
  for (const hooks of ['./custom/hooks.conf', ['./custom/hooks.conf'], { hooks: { Stop: event('explicit') } }, [{ hooks: { Stop: event('explicit') } }]]) {
    await fixture('codex', { hooks, mcpServers: './custom/mcp.conf' }, {
      'hooks/hooks.json': { hooks: { SessionStart: event('default') } },
      '.mcp.json': { mcpServers: { default: { command: 'node' } } },
      'custom/hooks.conf': { hooks: { Stop: event('explicit') } },
      'custom/mcp.conf': { mcpServers: { explicit: { command: 'node' } } },
    }, async root => {
      const plugin = await parseCompatPlugin(root)
      assert.deepEqual(plugin.hooks.map(item => item.event), ['stop'])
      assert.deepEqual(plugin.mcpServers.map(item => item.serverName), ['explicit'])
      assert(!plugin.diagnostics.some(item => item.level === 'error'))
    })
  }
})

test('CC skills根目录形式有效，显式symbolic link配置不得逃逸插件根', async () => {
  const outside = await temporaryDirectory()
  try {
    await put(outside.path, 'mcp.json', { mcpServers: { outside: { command: 'node' } } })
    await fixture('claude-code', { skills: '.', mcpServers: './escape.json' }, { 'SKILL.md': skill('root-skill') }, async root => {
      await symlink(resolve(outside.path, 'mcp.json'), resolve(root, 'escape.json'))
      const collector = new DiagnosticCollector()
      const descriptor = await parseClaudeHarness(root, collector)
      assert.deepEqual(descriptor.skillPaths, [''])
      assert.equal(descriptor.mcpSources.length, 0)
      assert(collector.items.some(item => item.code === 'DECLARED_PATH_ESCAPE' && item.level === 'error'))
    })
  } finally { await outside.cleanup() }
})

test('CC 无manifest条目fallback保留metadata/defaultEnabled和inline command pointer', async () => {
  const temp = await temporaryDirectory()
  try {
    const fields = { name: 'compat', source: './', strict: false, defaultEnabled: false, metadata: { freeForm: true }, commands: { inline: { content: 'private-fallback' } } }
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'market', owner: { name: 'owner' }, plugins: [fields] })
    const source = await parseCompatSource(temp.path)
    const plugin = await parseCompatPlugin(temp.path, { marketplaceDefinitions: source.candidates[0].definitions })
    assert.equal(plugin.defaultEnabled, false)
    assert.deepEqual(plugin.commands[0].contentSource, { type: 'inline', pointer: '/plugins/0/commands/inline/content' })
    assert(!JSON.stringify(plugin).includes('private-fallback'))
    assert(!plugin.diagnostics.some(item => item.code === 'PLUGIN_MANIFEST_UNKNOWN_FIELD'))
  } finally { await temp.cleanup() }
})

test('MCP 跨格式仍保持等价合并及冲突检查，不被同格式覆盖规则吞掉', async () => {
  await fixture('claude-code', {}, { '.codex-plugin/plugin.json': { name: 'compat' }, '.mcp.json': { mcpServers: { shared: { command: 'node' } } } }, async root => {
    const equal = await parseCompatPlugin(root)
    assert.equal(equal.mcpServers.length, 1)
    assert.deepEqual(equal.mcpServers[0].environmentBindings, {
      CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root',
      CODEX_PLUGIN_ROOT: 'plugin-root', CODEX_PLUGIN_DATA: 'plugin-data', PLUGIN_ROOT: 'plugin-root', PLUGIN_DATA: 'plugin-data',
    })
    await put(root, '.codex-plugin/plugin.json', { name: 'compat', mcpServers: { shared: { command: 'other' } } })
    const conflict = await parseCompatPlugin(root)
    assert(conflict.diagnostics.some(item => item.code === 'MCP_SERVER_NAME_DUPLICATE' && item.level === 'error'))
  })
})
