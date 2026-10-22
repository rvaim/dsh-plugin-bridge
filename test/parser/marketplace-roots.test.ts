import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { parseCompatPlugin, parseCompatSource } from '../../src/composition/defaults.js'
import { parseClaudeMarketplace } from '../../src/protocols/claude-code/source.js'
import { parseCodexMarketplace } from '../../src/protocols/codex/source.js'
import { temporaryDirectory } from '../helpers/temp.js'

async function put(root: string, file: string, value: unknown): Promise<void> {
  const path = resolve(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function claude(plugins: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'nested-market', owner: { name: 'fixture' }, plugins, ...extra }
}

test('nested Claude marketplace uses its market root and retains Source-relative inline references', async () => {
  const temp = await temporaryDirectory()
  try {
    const prefix = 'plugins/claude_code'
    const marker = `${prefix}/.claude-plugin/marketplace.json`
    await put(temp.path, marker, claude([{
      name: 'nested-claude', source: './', strict: false,
      skills: ['./skills'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fixture-never-executed' }] }] },
      mcpServers: { docs: { command: 'fixture-never-executed', args: [] } },
    }]))
    await put(temp.path, `${prefix}/skills/example/SKILL.md`, '---\nname: example\ndescription: Nested fixture\n---\nBody\n')
    const parsed = await parseClaudeMarketplace(temp.path, marker)
    assert(parsed)
    assert.equal(parsed.marketplaceFile, marker)
    const candidate = parsed.candidates[0]!
    assert.equal(candidate.installable, true)
    assert.deepEqual(candidate.location, { type: 'source-path', path: prefix })
    assert.equal(candidate.locationKey, `source-path:${await realpath(resolve(temp.path, prefix))}`)
    assert.equal(candidate.definitions[0]!.file, marker)
    assert.equal(candidate.definitions[0]!.pointer, '/plugins/0')
    assert.equal(candidate.definitions[0]!.sourcePathIsRoot, false)
    const standalone = await parseClaudeMarketplace(resolve(temp.path, prefix))
    assert.equal(standalone?.candidates[0]?.locationKey, candidate.locationKey)
    assert.equal(standalone?.candidates[0]?.definitions[0]?.sourcePathIsRoot, true)

    const plugin = await parseCompatPlugin(resolve(temp.path, prefix), { marketplaceDefinitions: candidate.definitions })
    assert.deepEqual(plugin.skills.map(skill => skill.name), ['example'])
    const command = plugin.hooks[0]?.commands[0]?.command
    assert(command?.type === 'deferred-json')
    assert.deepEqual([command.file, command.pointer, command.base], [marker, '/plugins/0/hooks/Stop/0/hooks/0/command', 'source'])
    const server = plugin.mcpServers[0]
    const mcpCommand = server?.transport === 'stdio' ? server.command : undefined
    assert(mcpCommand?.type === 'deferred-json')
    assert.deepEqual([mcpCommand.file, mcpCommand.pointer, mcpCommand.base], [marker, '/plugins/0/mcpServers/docs/command', 'source'])
  } finally { await temp.cleanup() }
})

test('nested Claude metadata.pluginRoot composes before rebasing and external Git paths stay external', async () => {
  const temp = await temporaryDirectory()
  try {
    const marker = 'catalogs/team/.claude-plugin/marketplace.json'
    const sha = 'a'.repeat(40)
    await mkdir(resolve(temp.path, 'catalogs/team/packages/local'), { recursive: true })
    await put(temp.path, marker, claude([
      { name: 'local', source: 'local' },
      { name: 'github', source: { source: 'github', repo: 'example/plugin', ref: 'stable', sha } },
      { name: 'git-subdir', source: { source: 'git-subdir', url: 'example/collection', path: './plugins/remote', ref: 'v1' } },
    ], { metadata: { pluginRoot: './packages' } }))
    const parsed = await parseClaudeMarketplace(temp.path, marker)
    assert(parsed)
    assert(parsed.candidates.every(candidate => candidate.installable))
    assert.deepEqual(parsed.candidates[0]?.location, { type: 'source-path', path: 'catalogs/team/packages/local' })
    assert.deepEqual(parsed.candidates[1]?.location, { type: 'git', url: 'https://github.com/example/plugin.git', ref: 'stable', sha })
    assert.deepEqual(parsed.candidates[2]?.location, { type: 'git-subdir', url: 'https://github.com/example/collection.git', path: 'plugins/remote', ref: 'v1' })
    assert(parsed.candidates.every(candidate => candidate.definitions[0]?.file === marker))
  } finally { await temp.cleanup() }
})

test('nested Codex local, URL and git-subdir candidates retain separate roots and Git selectors', async () => {
  const temp = await temporaryDirectory()
  try {
    const marker = 'integrations/codex/.agents/plugins/marketplace.json'
    const sha = 'b'.repeat(40)
    await mkdir(resolve(temp.path, 'integrations/codex/packages/local'), { recursive: true })
    await put(temp.path, marker, { name: 'nested-codex', plugins: [
      { name: 'local', source: { source: 'local', path: './packages/local' } },
      { name: 'url', source: { source: 'url', url: 'https://example.com/root.git', ref: 'release', sha } },
      { name: 'url-subdir', source: { source: 'url', url: 'example/collection', path: './packages/compat', ref: 'v1' } },
      { name: 'git-subdir', source: { source: 'git-subdir', url: 'example/collection', path: 'packages/native', sha } },
    ] })
    const parsed = await parseCodexMarketplace(temp.path, marker)
    assert(parsed)
    assert(parsed.candidates.every(candidate => candidate.installable))
    assert.deepEqual(parsed.candidates[0]?.location, { type: 'source-path', path: 'integrations/codex/packages/local' })
    assert.deepEqual(parsed.candidates[1]?.location, { type: 'git', url: 'https://example.com/root.git', ref: 'release', sha })
    assert.deepEqual(parsed.candidates[2]?.location, { type: 'git-subdir', url: 'https://github.com/example/collection.git', path: 'packages/compat', ref: 'v1' })
    assert.deepEqual(parsed.candidates[3]?.location, { type: 'git-subdir', url: 'https://github.com/example/collection.git', path: 'packages/native', sha })
    assert(parsed.candidates.every(candidate => candidate.definitions[0]?.file === marker))
    assert.equal(parsed.candidates[0]?.definitions[0]?.sourcePathIsRoot, false)
  } finally { await temp.cleanup() }
})

test('marketplace entry paths cannot escape a nested market root even into the surrounding Source', async () => {
  const temp = await temporaryDirectory()
  try {
    const marker = 'nested/.agents/plugins/marketplace.json'
    await mkdir(resolve(temp.path, 'sibling'), { recursive: true })
    await symlink(resolve(temp.path, 'sibling'), resolve(temp.path, 'nested-link'), 'dir')
    await mkdir(resolve(temp.path, 'nested'), { recursive: true })
    await symlink(resolve(temp.path, 'sibling'), resolve(temp.path, 'nested/escape'), 'dir')
    await put(temp.path, marker, { name: 'bounded', plugins: [
      { name: 'parent', source: { source: 'local', path: '../sibling' } },
      { name: 'symlink', source: { source: 'local', path: './escape' } },
    ] })
    const parsed = await parseCodexMarketplace(temp.path, marker)
    assert(parsed)
    assert(parsed.candidates.every(candidate => !candidate.installable))
    assert(parsed.candidates[0]?.diagnostics.some(item => item.code === 'SOURCE_LOCATION_INVALID' && item.file === marker))
    assert(parsed.candidates[1]?.diagnostics.some(item => item.code === 'SOURCE_PLUGIN_PATH_ESCAPE' && item.file === marker))
  } finally { await temp.cleanup() }
})

test('marketplace file input rejects traversal, wrong protocol markers, non-files and escaping symlinks', async () => {
  const temp = await temporaryDirectory()
  try {
    for (const [parse, suffix, wrong] of [
      [parseClaudeMarketplace, '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'],
      [parseCodexMarketplace, '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'],
    ] as const) {
      const root = resolve(temp.path, suffix.startsWith('.claude') ? 'claude' : 'codex')
      await mkdir(root, { recursive: true })
      for (const path of [wrong, `../${suffix}`, resolve(root, suffix), `nested/../${suffix}`, `nested//${suffix}`]) {
        const rejected = await parse(root, path)
        assert(rejected, path)
        assert.equal(rejected.candidates.length, 0)
        assert(rejected.diagnostics.some(item => item.level === 'error'), path)
      }
      assert.equal(await parse(root), undefined)
      await mkdir(resolve(root, suffix), { recursive: true })
      assert((await parse(root))?.diagnostics.some(item => item.level === 'error'))
      const external = resolve(temp.path, 'outside', suffix)
      await put(temp.path, `outside/${suffix}`, claude([]))
      const link = `linked/${suffix}`
      await mkdir(dirname(resolve(root, link)), { recursive: true })
      await symlink(external, resolve(root, link))
      assert((await parse(root, link))?.diagnostics.some(item => item.level === 'error'))
      const dangling = `dangling/${suffix}`
      await mkdir(dirname(resolve(root, dangling)), { recursive: true })
      await symlink(resolve(temp.path, 'missing'), resolve(root, dangling))
      assert((await parse(root, dangling))?.diagnostics.some(item => item.level === 'error'))
    }
  } finally { await temp.cleanup() }
})

test('core discovers opted-in nested marketplaces before root capability inference and retains all catalogs', async () => {
  const temp = await temporaryDirectory()
  try {
    const claudeMarker = 'plugins/claude_code/.claude-plugin/marketplace.json'
    const codexMarker = 'plugins/codex/.agents/plugins/marketplace.json'
    await put(temp.path, 'skills/unlisted/SKILL.md', '---\nname: unlisted\ndescription: Root fallback fixture\n---\nBody\n')
    await put(temp.path, claudeMarker, claude([{ name: 'claude-candidate', source: './' }]))
    await put(temp.path, codexMarker, { name: 'codex-market', plugins: [{ name: 'codex-candidate', source: './' }] })
    const result = await parseCompatSource(temp.path)
    assert.equal(result.scan.discovery, 'marketplace')
    assert.deepEqual(result.scan.marketplaceFiles, [claudeMarker, codexMarker])
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ['claude-candidate', 'codex-candidate'])
    assert(result.candidates.every(candidate => candidate.installable))
    assert.deepEqual(result.candidates.map(candidate => candidate.location), [
      { type: 'source-path', path: 'plugins/claude_code' },
      { type: 'source-path', path: 'plugins/codex' },
    ])
  } finally { await temp.cleanup() }
})

test('a malformed nested marketplace keeps its real path in diagnostics and prevents fallback', async () => {
  const temp = await temporaryDirectory()
  try {
    const marker = 'plugins/broken/.claude-plugin/marketplace.json'
    await put(temp.path, 'skills/fallback/SKILL.md', '---\nname: fallback\ndescription: Root fallback fixture\n---\nBody\n')
    await put(temp.path, marker, '{broken')
    const result = await parseCompatSource(temp.path)
    assert.equal(result.scan.discovery, 'marketplace')
    assert.deepEqual(result.scan.marketplaceFiles, [marker])
    assert.equal(result.candidates.length, 0)
    assert(result.scan.diagnostics.some(item => item.code === 'CLAUDE_MARKETPLACE_INVALID' && item.file === marker))
  } finally { await temp.cleanup() }
})
