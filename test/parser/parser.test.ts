import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseCompatPlugin } from '../../src/parser/normalize.js'
import { parseFrontmatter } from '../../src/parser/shared/frontmatter.js'
import { temporaryDirectory } from '../helpers/temp.js'

const claudeFixture = resolve('test/fixtures/claude-code/full')
const codexFixture = resolve('test/fixtures/codex/full')

test('Claude Code 完整插件被规范化为 CompatPlugin', async () => {
  const plugin = await parseCompatPlugin(claudeFixture, {
    source: { type: 'directory', path: claudeFixture },
  })
  assert.equal(plugin.id, 'legacy-full')
  assert.equal(plugin.name, 'legacy-full')
  assert.equal(plugin.version, '1.2.3')
  assert.deepEqual(plugin.formats, ['claude-code'])
  assert.equal(plugin.skills.length, 1)
  assert.equal(plugin.mcpServers.length, 2)
  assert.equal(plugin.hooks.length, 4)
  assert.equal(plugin.commands.length, 1)
  assert.equal(plugin.agents.length, 1)
  assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
  assert.equal(plugin.skills[0].name, 'review')
  assert.equal(plugin.skills[0].invocation.modelInvocable, true)
  assert.deepEqual(new Set(plugin.hooks.map(item => item.dshEvent)), new Set([
    'agent/session-start', 'tools/pre-execute', 'tools/post-execute',
  ]))
})

test('MCP 凭据和配置明文不进入扫描结果', async () => {
  const plugin = await parseCompatPlugin(claudeFixture, {
    source: { type: 'directory', path: claudeFixture },
  })
  const serialized = JSON.stringify(plugin)
  assert.equal(serialized.includes('ghp_do_not_copy_to_scan'), false)
  assert.equal(serialized.includes('Bearer plain-secret'), false)
  assert.equal(serialized.includes('token=do_not_copy'), false)
  assert.equal(serialized.includes('--mode'), false)
  assert.equal(serialized.includes('deny:危险工具已阻止'), false)
  assert.equal(serialized.includes('context:已完成安全检查'), false)
  assert.equal(serialized.includes('GITHUB_TOKEN'), true)
  const github = plugin.mcpServers.find(item => item.serverName === 'github')
  assert(github && github.transport === 'stdio')
  assert.equal(github.env.GITHUB_TOKEN.type, 'template')
  assert.equal(github.env.INLINE_SECRET.type, 'deferred-json')
  assert.equal(github.args.every(item => item.type === 'deferred-json'), true)
  assert.equal(plugin.hooks.every(hook => hook.commands.every(command => command.command.type === 'deferred-json')), true)
  const remote = plugin.mcpServers.find(item => item.serverName === 'remote')
  assert(remote && remote.transport === 'streamable-http')
  assert.equal(remote.url.type, 'deferred-json')
})

test('Codex 插件识别 snake_case Hook 和 Plugin Root 模板', async () => {
  const plugin = await parseCompatPlugin(codexFixture, {
    source: { type: 'directory', path: codexFixture },
  })
  assert.equal(plugin.id, 'codex-full')
  assert.deepEqual(plugin.formats, ['codex'])
  assert.equal(plugin.skills[0].name, 'analyze')
  assert.equal(plugin.mcpServers[0].serverName, 'search')
  assert.equal(plugin.mcpServers[0].toolCallTimeoutMs, 12_000)
  assert(plugin.mcpServers[0].transport === 'stdio')
  assert.equal(plugin.mcpServers[0].env.SEARCH_KEY.type, 'template')
  assert.equal(plugin.mcpServers[0].args[1].type, 'template')
  assert.deepEqual(plugin.mcpServers[0].args[1], { type: 'template', parts: [
    { type: 'plugin-data' },
    { type: 'text', value: '/cache.json' },
  ] })
  assert.equal(plugin.hooks.length, 3)
  assert.deepEqual(new Set(plugin.hooks.map(item => item.dshEvent)), new Set(['agent/pre-step', 'tools/pre-execute', 'agent/turn-stopping']))
  assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
})

test('不支持的 Hook handler 与事件产生 error，不静默忽略', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'hooks'), { recursive: true })
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'bad-hooks' }))
    await writeFile(resolve(temp.path, 'hooks/hooks.json'), JSON.stringify({
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
        PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['ok', 42] }] }],
      },
    }))
    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert(plugin.diagnostics.some(item => item.code === 'HOOK_EVENT_UNSUPPORTED' && item.level === 'error'))
    assert(plugin.diagnostics.some(item => item.code === 'HOOK_UNSUPPORTED_HANDLER' && item.level === 'error'))
    assert(plugin.diagnostics.some(item => item.code === 'HOOK_ARGS_INVALID' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})

test('Claude Hook 的独立 args 保留参数边界且明文不进入扫描结果', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'hooks'), { recursive: true })
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'hook-args' }))
    await writeFile(resolve(temp.path, 'hooks/hooks.json'), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{
          type: 'command',
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/bin/dispatch.js', '--host', 'claude', '--stop'],
        }] }],
      },
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
    const command = plugin.hooks[0].commands[0]
    assert.equal(command.command.type, 'deferred-json')
    assert.equal(command.args?.length, 4)
    assert.equal(command.args?.[0].type, 'template')
    assert.equal(command.args?.[1].type, 'deferred-json')
    assert.equal(JSON.stringify(plugin).includes('--host'), false)
    assert.equal(JSON.stringify(plugin).includes('--stop'), false)
  } finally {
    await temp.cleanup()
  }
})

test('无显式清单但有标准目录时给出推断诊断', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, 'skills', 'demo'), { recursive: true })
    await writeFile(resolve(temp.path, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: 示例\n---\n正文')
    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.deepEqual(plugin.formats, ['claude-code'])
    assert(plugin.diagnostics.some(item => item.code === 'PLUGIN_FORMAT_INFERRED'))
  } finally {
    await temp.cleanup()
  }
})

test('Node 依赖只产生显式运行环境警告，安装 parser 不执行包管理器', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'node-deps' }))
    await writeFile(resolve(temp.path, 'package.json'), JSON.stringify({
      name: 'node-deps',
      version: '1.0.0',
      dependencies: { example: '^1.0.0' },
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    const warning = plugin.diagnostics.find(item => item.code === 'NODE_DEPENDENCIES_NOT_INSTALLED')
    assert(warning)
    assert.equal(warning.level, 'warning')
    assert.equal(warning.file, 'package.json')
    assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
  } finally {
    await temp.cleanup()
  }
})

test('同一插件内部的能力重名明确报错且不自动改名', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'skills', 'a'), { recursive: true })
    await mkdir(resolve(temp.path, 'skills', 'b'), { recursive: true })
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'duplicate' }))
    const skill = '---\nname: same\ndescription: 测试\n---\n正文'
    await writeFile(resolve(temp.path, 'skills/a/SKILL.md'), skill)
    await writeFile(resolve(temp.path, 'skills/b/SKILL.md'), skill)
    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert(plugin.diagnostics.some(item => item.code === 'SKILL_NAME_DUPLICATE'))
    assert.equal(plugin.skills.length, 1)
    assert.equal(plugin.skills[0].name, 'same')
  } finally {
    await temp.cleanup()
  }
})

test('frontmatter 子集支持数组、嵌套对象和块文本', () => {
  const parsed = parseFrontmatter(`---
name: demo
tags: [one, two]
metadata:
  owner: team
notes: |
  第一行
  第二行
---
正文`)
  assert.equal(parsed.attributes.name, 'demo')
  assert.deepEqual(parsed.attributes.tags, ['one', 'two'])
  assert.deepEqual(parsed.attributes.metadata, { owner: 'team' })
  assert.equal(parsed.attributes.notes, '第一行\n第二行')
  assert.equal(parsed.body, '正文')
})


test('Codex 清单显式内联配置补充默认文件，并支持 PascalCase Hook 与 mcp_servers', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.codex-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'hooks'), { recursive: true })
    await writeFile(resolve(temp.path, 'hooks/hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'allow:默认文件' }] }] },
    }))
    await writeFile(resolve(temp.path, '.mcp.json'), JSON.stringify({
      mcp_servers: { default_server: { command: 'node' } },
    }))
    await writeFile(resolve(temp.path, '.codex-plugin/plugin.json'), JSON.stringify({
      name: 'inline-codex',
      hooks: [{
        hooks: {
          PreToolUse: [{
            matcher: '^shell$',
            hooks: [{ type: 'command', command: 'allow:内联配置' }],
          }],
        },
      }],
      mcp_servers: {
        inline_server: {
          command: 'node',
          env_vars: ['INLINE_TOKEN'],
          tool_timeout_sec: 2,
        },
      },
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.equal(plugin.diagnostics.some(item => item.level === 'error'), false)
    assert.equal(plugin.hooks.length, 2)
    const inlineHook = plugin.hooks.find(item => item.runtime.wireEventName === 'PreToolUse')
    assert(inlineHook)
    assert.equal(inlineHook.matcher, '^shell$')
    assert(plugin.hooks.some(item => item.event === 'stop'))
    assert.deepEqual(plugin.mcpServers.map(item => item.serverName).sort(), ['default_server', 'inline_server'])
    const inlineServer = plugin.mcpServers.find(item => item.serverName === 'inline_server')
    assert(inlineServer)
    assert.equal(inlineServer.toolCallTimeoutMs, 2_000)
    assert(inlineServer.transport === 'stdio')
    assert.equal(inlineServer.env.INLINE_TOKEN.type, 'template')
  } finally {
    await temp.cleanup()
  }
})

test('清单中的非法能力路径项会明确诊断，不会静默过滤', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'skills', 'demo'), { recursive: true })
    await writeFile(resolve(temp.path, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: 示例\n---\n正文')
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'invalid-path-list',
      skills: ['skills/demo', 42, ''],
      commands: { path: 'commands/demo.md' },
      agents: [null],
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.equal(plugin.skills.length, 1)
    const invalid = plugin.diagnostics.filter(item => item.code === 'DECLARED_PATH_INVALID')
    assert.equal(invalid.length, 4)
    assert(invalid.every(item => item.level === 'error'))
    assert(invalid.every(item => item.file === '.claude-plugin/plugin.json'))
  } finally {
    await temp.cleanup()
  }
})

test('Claude Code 新增能力会产生明确诊断，不会被静默当作已兼容', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.claude-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'workflows'), { recursive: true })
    await mkdir(resolve(temp.path, 'bin'), { recursive: true })
    await writeFile(resolve(temp.path, '.lsp.json'), JSON.stringify({ typescript: { command: 'typescript-language-server' } }))
    await writeFile(resolve(temp.path, 'settings.json'), JSON.stringify({ agent: 'demo' }))
    await writeFile(resolve(temp.path, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'modern-claude',
      workflows: './workflows',
      outputStyles: './output-styles',
      lspServers: './.lsp.json',
      experimental: { themes: './themes', monitors: './monitors.json' },
      userConfig: { api_token: { type: 'string', title: 'Token', description: 'Token', sensitive: true } },
      channels: [{ server: 'telegram' }],
      dependencies: ['helper-plugin'],
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    const codes = new Set(plugin.diagnostics.map(item => item.code))
    for (const code of [
      'CLAUDE_WORKFLOWS_UNSUPPORTED',
      'CLAUDE_OUTPUT_STYLES_UNSUPPORTED',
      'CLAUDE_LSP_UNSUPPORTED',
      'CLAUDE_THEMES_UNSUPPORTED',
      'CLAUDE_MONITORS_UNSUPPORTED',
      'CLAUDE_USER_CONFIG_UNSUPPORTED',
      'CLAUDE_CHANNELS_UNSUPPORTED',
      'CLAUDE_PLUGIN_DEPENDENCIES_UNSUPPORTED',
      'CLAUDE_BIN_PATH_UNSUPPORTED',
      'CLAUDE_SETTINGS_UNSUPPORTED',
    ]) assert(codes.has(code), code)
    assert(plugin.diagnostics.some(item => item.code === 'CLAUDE_USER_CONFIG_UNSUPPORTED' && item.level === 'error'))
    assert(plugin.diagnostics.some(item => item.code === 'CLAUDE_PLUGIN_DEPENDENCIES_UNSUPPORTED' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})

test('Codex 现行顶层组件清单被规范化，apps 明确告警但不污染运行层', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.codex-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'skills', 'demo'), { recursive: true })
    await writeFile(resolve(temp.path, 'skills/demo/SKILL.md'), '---\nname: modern-skill\ndescription: 现代 Codex Skill\n---\n正文')
    await writeFile(resolve(temp.path, '.codex-plugin/plugin.json'), JSON.stringify({
      name: 'modern-codex',
      version: '2.0.0',
      skills: ['./skills/demo'],
      mcpServers: {
        modern: { command: 'node', args: ['./server.mjs'] },
      },
      hooks: {
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'allow:检查通过' }] }],
        },
      },
      apps: './app.json',
      interface: { displayName: '现代 Codex 插件' },
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.equal(plugin.name, '现代 Codex 插件')
    assert.deepEqual(plugin.skills.map(item => item.name), ['modern-skill'])
    assert.deepEqual(plugin.mcpServers.map(item => item.serverName), ['modern'])
    assert.equal(plugin.hooks.length, 1)
    assert(plugin.diagnostics.some(item => item.code === 'CODEX_APPS_UNSUPPORTED' && item.level === 'warning'))
    assert.equal(plugin.diagnostics.some(item => item.code === 'CODEX_PLUGIN_MANIFEST_MISSING'), false)
  } finally {
    await temp.cleanup()
  }
})

test('Codex paths 包装字段被明确拒绝，不能伪装成当前插件 JSON 规范', async () => {
  const temp = await temporaryDirectory()
  try {
    await mkdir(resolve(temp.path, '.codex-plugin'), { recursive: true })
    await mkdir(resolve(temp.path, 'custom-skill'), { recursive: true })
    await writeFile(resolve(temp.path, 'custom-skill/SKILL.md'), '---\nname: should-not-load\ndescription: 不应加载\n---\n正文')
    await writeFile(resolve(temp.path, '.codex-plugin/plugin.json'), JSON.stringify({
      name: 'invalid-paths-wrapper',
      paths: {
        skills: ['./custom-skill'],
        mcpServers: { hidden: { command: 'node' } },
      },
    }))

    const plugin = await parseCompatPlugin(temp.path, { source: { type: 'directory', path: temp.path } })
    assert.equal(plugin.skills.some(item => item.name === 'should-not-load'), false)
    assert.equal(plugin.mcpServers.some(item => item.serverName === 'hidden'), false)
    assert(plugin.diagnostics.some(item => item.code === 'CODEX_PLUGIN_PATHS_UNSUPPORTED' && item.level === 'error'))
  } finally {
    await temp.cleanup()
  }
})
