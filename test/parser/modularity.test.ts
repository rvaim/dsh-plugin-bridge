import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createBuiltinParserEngine } from '../../src/composition/defaults.js'
import { knownParserSignatures } from '../../src/composition/signatures.js'
import { builtInParsers } from '../../src/composition/builtins.js'
import { ParserEngine } from '../../src/parser/engine.js'
import { temporaryDirectory } from '../helpers/temp.js'

const ids = ['claude-code', 'codex', 'agent-plugins']
const subsets = Array.from({ length: 8 }, (_, mask) => ids.filter((_id, bit) => (mask & (1 << bit)) !== 0))
async function put(root: string, file: string, value: unknown): Promise<void> {
  const path = resolve(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function fixture(root: string, id: string): Promise<void> {
  const path = id === 'claude-code' ? '.claude-plugin/plugin.json' : id === 'codex' ? '.codex-plugin/plugin.json' : 'plugin.json'
  await put(root, path, { ...(id === 'agent-plugins' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' } : {}), name: 'independent-example', version: '1.0.0' })
  await put(root, 'skills/example/SKILL.md', '---\nname: example\ndescription: Independent fixture\n---\nLiteral body\n')
}

test('all eight parser selections preserve retained parser output and block removed formats without fallback', async () => {
  const temp = await temporaryDirectory()
  try {
    const roots = new Map<string, string>()
    const all = createBuiltinParserEngine()
    const expected = new Map()
    for (const id of ids) {
      const root = resolve(temp.path, id)
      await fixture(root, id)
      roots.set(id, root)
      expected.set(id, await all.parsePlugin(root))
    }
    for (const selected of subsets) {
      const engine = createBuiltinParserEngine(selected)
      assert.deepEqual(engine.snapshot.parsers.map(parser => parser.id).sort(), [...selected].sort())
      for (const id of ids) {
        const parsed = await engine.parsePlugin(roots.get(id)!)
        if (selected.includes(id)) assert.deepEqual(parsed, expected.get(id), `${selected.join(',')} retains ${id}`)
        else {
          assert.deepEqual(parsed.formats, [id])
          assert.equal(parsed.skills.length + parsed.mcpServers.length + parsed.hooks.length, 0)
          assert(parsed.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
          const source = await engine.parseSource(roots.get(id)!)
          assert.deepEqual(source.candidates[0].formats, [id])
          assert.equal(source.candidates[0].installable, false)
        }
      }
    }
  } finally { await temp.cleanup() }
})

test('snapshots include module versions and selection and cannot be altered through returned values', () => {
  const all = createBuiltinParserEngine()
  const versioned = new ParserEngine(builtInParsers.map(parser => ({ ...parser, version: `${parser.version}.changed` })), knownParserSignatures)
  assert.notEqual(all.snapshot.fingerprint, versioned.snapshot.fingerprint)
  const seen = new Set(subsets.map(selected => createBuiltinParserEngine(selected).snapshot.fingerprint))
  assert.equal(seen.size, 8)
  const copy = all.snapshot
  copy.parsers[0].version = 'modified'
  copy.fingerprint = 'modified'
  assert.notEqual(all.snapshot.fingerprint, copy.fingerprint)
  assert.notEqual(all.snapshot.parsers[0].version, 'modified')
  assert.throws(() => new ParserEngine([builtInParsers[0], builtInParsers[0]]), /重复/)
})

test('a removed catalog contributes tombstones only to its named candidates and cannot silently lose shared policy', async () => {
  const temp = await temporaryDirectory()
  try {
    await put(temp.path, '.claude-plugin/marketplace.json', { name: 'cc-catalog', owner: { name: 'fixture' }, plugins: [{ name: 'shared', source: './shared' }] })
    await put(temp.path, '.agents/plugins/marketplace.json', { name: 'codex-catalog', plugins: [
      { name: 'shared', source: './shared' }, { name: 'codex-only', source: './codex-only' },
    ] })
    await put(temp.path, 'shared/.codex-plugin/plugin.json', { name: 'shared' })
    await put(temp.path, 'codex-only/.codex-plugin/plugin.json', { name: 'codex-only' })
    const source = await createBuiltinParserEngine(['codex']).parseSource(temp.path)
    const shared = source.candidates.find(candidate => candidate.id === 'shared')!
    assert.deepEqual(shared.formats, ['claude-code', 'codex'])
    assert.equal(shared.installable, true)
    assert(shared.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
    assert.equal(source.candidates.find(candidate => candidate.id === 'codex-only')?.installable, true)
    const selected = await createBuiltinParserEngine(['codex']).parsePlugin(resolve(temp.path, 'codex-only'))
    assert.equal(selected.diagnostics.some(item => item.level === 'error'), false)
  } finally { await temp.cleanup() }
})

test('unknown parser and malformed missing catalog are explicit errors rather than another parser fallback', async () => {
  assert.throws(() => createBuiltinParserEngine(['unknown-parser']), /未知/)
  const temp = await temporaryDirectory()
  try {
    await put(temp.path, '.claude-plugin/marketplace.json', { unexpected: 'no index' })
    await put(temp.path, '.agents/plugins/marketplace.json', { name: 'catalog', plugins: [{ name: 'only', source: './only' }] })
    await put(temp.path, 'only/.codex-plugin/plugin.json', { name: 'only' })
    const result = await createBuiltinParserEngine(['codex']).parseSource(temp.path)
    assert.equal(result.candidates[0].installable, true)
    assert(result.scan.diagnostics.some(item => item.code === 'SOURCE_CATALOG_SCOPE_UNKNOWN'))
    assert(!result.candidates[0].diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE' && item.level === 'error'))
  } finally { await temp.cleanup() }
})

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.[cm]?tsx?$/.test(entry.name)) files.push(path)
  }
  return files
}
function importTargets(file: string, text: string): string[] {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  const add = (node: ts.Node | undefined): void => { if (node && ts.isStringLiteralLike(node)) imports.push(node.text) }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return imports
}

test('architecture enforces one composition file, no sibling parser imports and no implementation dependency in execution/core', async () => {
  const root = resolve('src')
  const topDirectories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  assert.deepEqual(topDirectories, ['composition', 'manager', 'parser', 'protocols', 'runtime', 'shared', 'source', 'store', 'types', 'web'])
  assert.deepEqual((await readdir(resolve(root, 'protocols'))).sort(), ['agent-plugins', 'claude-code', 'codex'])
  assert.deepEqual((await readdir(resolve(root, 'web'))).sort(), ['client', 'host'])
  assert.deepEqual((await readdir(resolve(root, 'runtime/adapters'))).sort(), ['hooks.ts', 'index.ts', 'mcp.ts', 'skills.ts'])
  assert.deepEqual((await readdir(resolve(root, 'parser'))).sort(), [
    'catalog.ts', 'contracts.ts', 'engine.ts', 'index.ts', 'model.ts', 'plugin.ts', 'registry.ts', 'version.ts',
  ])
  for (const obsolete of ['composition/api.ts', 'runtime/agent-plugins.ts', 'runtime/loader.ts', 'core/manager.ts']) {
    await assert.rejects(readFile(resolve(root, obsolete)), { code: 'ENOENT' })
  }
  const files = await sourceFiles(root)
  for (const file of files) {
    const local = relative(root, file).replaceAll('\\', '/')
    const text = await readFile(file, 'utf8')
    if (/^(parser|shared|runtime|manager)\//.test(local)) assert(!/codex|claude|agent.?plugins?|getProtocolApi|LEGACY_BINDINGS/i.test(text), `${local} contains protocol-specific or compatibility code`)
    const targets = importTargets(file, text)
    for (const target of targets) {
      if (!target.startsWith('.')) {
        if (local.startsWith('web/client/')) assert(!target.startsWith('node:'), `${local} must not load Node builtin ${target}`)
        if (target === 'ajv' || target.startsWith('ajv/')) assert(local.startsWith('protocols/agent-plugins/'), `${local} owns schema dependency`)
        continue
      }
      const destination = relative(root, resolve(dirname(file), target)).replaceAll('\\', '/')
      const provider = /^protocols\/(claude-code|codex|agent-plugins)\//.exec(destination)?.[1]
      const owner = /^protocols\/(claude-code|codex|agent-plugins)\//.exec(local)?.[1]
      if (provider !== undefined) assert(owner === provider || local === 'composition/builtins.ts', `${local} illegally imports ${destination}`)
      if (owner !== undefined) {
        assert(!/^(runtime|composition|manager|web)\//.test(destination), `${local} must not import ${destination}`)
      }
      if (local.startsWith('runtime/')) assert(!/^(parser|protocols|composition)\//.test(destination), `${local} must not import ${destination}`)
      if (local.startsWith('manager/')) {
        assert(!/^composition\//.test(destination) && provider === undefined, `${local} needs an injected parser`)
        if (destination.startsWith('parser/')) assert(/^parser\/(contracts|model|version)\.js$/.test(destination), `${local} must not use a parser implementation: ${destination}`)
      }
      if (local.startsWith('parser/')) assert(!/^composition\//.test(destination) && provider === undefined, `${local} must stay implementation free`)
      if (local.startsWith('shared/') || local.startsWith('types/')) assert(!/^(parser|protocols|composition|runtime|manager|web)\//.test(destination), `${local} must be a neutral leaf: ${destination}`)
      if (local.startsWith('web/client/')) assert(!/^(manager|source|store|composition|parser|protocols|runtime|web\/host)\//.test(destination), `${local} must not import server implementation ${destination}`)
      if (local.startsWith('web/host/')) assert(!destination.startsWith('web/client/'), `${local} must not import browser implementation ${destination}`)
    }
  }
})
