import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const modules = [
  { id: 'claude-code', exported: 'claudeCodeParser', manifest: '.claude-plugin/plugin.json' },
  { id: 'codex', exported: 'codexParser', manifest: '.codex-plugin/plugin.json' },
  { id: 'agent-plugins', exported: 'agentPluginsParser', manifest: 'plugin.json' },
]
const requested = process.argv.find(argument => argument.startsWith('--mask='))
const masks = requested === undefined ? Array.from({ length: 8 }, (_, mask) => mask) : [Number(requested.slice('--mask='.length))]
if (masks.some(mask => !Number.isInteger(mask) || mask < 0 || mask > 7)) throw new Error('mask must be 0..7')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-bridge-parser-removal-'))
const temporaryReal = await realpath(temporary)
const compiler = join(root, 'node_modules/typescript/bin/tsc')
const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Parser removal probe failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
}

try {
  for (const mask of masks) {
    const kept = modules.filter((_module, bit) => mask & (1 << bit))
    const removed = modules.filter(module => !kept.includes(module))
    const profile = join(temporaryReal, `profile-${mask}`)
    await mkdir(profile)
    // Removed implementation directories never enter the fixture. No production
    // source is deleted, and no compatibility implementation is retained elsewhere.
    await cp(join(root, 'src'), join(profile, 'src'), {
      recursive: true,
      filter(source) {
        const name = relative(join(root, 'src'), source).replaceAll('\\', '/')
        return !removed.some(module => name === `protocols/${module.id}` || name.startsWith(`protocols/${module.id}/`))
      },
    })
    const topDirectories = (await readdir(join(profile, 'src'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    assert.deepEqual(topDirectories, ['composition', 'manager', 'parser', 'protocols', 'runtime', 'shared', 'source', 'store', 'types', 'web'])
    for (const required of ['manager/plugin-loader.ts', 'types/protocol.ts', 'runtime/adapters/hooks.ts', 'runtime/adapters/mcp.ts', 'runtime/adapters/skills.ts', 'web/host/gateway.ts', 'web/client/index.ts']) {
      await readFile(join(profile, 'src', required))
    }
    const registration = [
      "import type { PluginParser } from '../parser/contracts.js'",
      ...kept.map(module => `import { ${module.exported} } from '../protocols/${module.id}/index.js'`),
      `export const builtInParsers: readonly PluginParser[] = [${kept.map(module => module.exported).join(', ')}]`,
      '',
    ].join('\n')
    await writeFile(join(profile, 'src/composition/builtins.ts'), registration)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: '@rvaim/dsh-plugin-bridge', type: 'module', exports: { './types': './src/types/index.ts' } }))
    await symlink(join(root, 'node_modules'), join(profile, 'node_modules'), 'dir')
    await mkdir(join(profile, 'dist'))
    for (const file of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']) {
      await cp(join(root, 'dist', file), join(profile, 'dist', file))
    }
    await writeFile(join(profile, 'tsconfig.json'), JSON.stringify({
      ...config, include: ['src/**/*.ts', 'src/**/*.tsx'],
      compilerOptions: { ...config.compilerOptions, declarationMap: false, sourceMap: false },
    }))
    run([compiler, '-p', 'tsconfig.json'], profile)
    const fixtures = []
    for (const module of modules) {
      const fixture = join(profile, 'fixtures', module.id)
      await mkdir(dirname(join(fixture, module.manifest)), { recursive: true })
      await writeFile(join(fixture, module.manifest), JSON.stringify({
        ...(module.id === 'agent-plugins' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' } : {}), name: 'removal-fixture',
      }))
      await mkdir(join(fixture, 'skills/example'), { recursive: true })
      await writeFile(join(fixture, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Removal probe\n---\nLiteral body\n')
      fixtures.push({ id: module.id, path: fixture, supported: kept.includes(module) })
    }
    const entry = pathToFileURL(join(profile, 'dist/src/index.js')).href
    const probe = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const selected = ${JSON.stringify(kept.map(module => module.id).sort())};
      if (!selected.includes('agent-plugins')) registerHooks({ resolve(specifier, context, next) {
        if ((specifier === 'ajv' || specifier.startsWith('ajv/')) && context.parentURL?.startsWith(${JSON.stringify(pathToFileURL(profile).href)})) throw new Error('Removed parser schema dependency was loaded');
        return next(specifier, context);
      }});
      const neutral = await import(${JSON.stringify(pathToFileURL(join(profile, 'dist/src/parser/index.js')).href)});
      assert.equal(typeof neutral.ParserEngine, 'function');
      assert.equal(Object.keys(neutral).some(key => /claude|codex|agentplugins|getProtocolApi/i.test(key)), false);
      const api = await import(${JSON.stringify(entry)});
      assert.equal(Object.keys(api).some(key => /^parse(?:Claude|Codex|AgentPlugin)|^validateAgentPlugin/.test(key)), false);
      const engine = api.getDefaultParserEngine();
      assert.deepEqual(engine.snapshot.parsers.map(parser => parser.id).sort(), selected);
      assert.equal(typeof api.CompatManager, 'function');
      assert.equal(api.CompatManager.length, 3);
      assert.equal(typeof api.CompatRuntimeManager, 'function');
      for (const fixture of ${JSON.stringify(fixtures)}) {
        const result = await engine.parsePlugin(fixture.path);
        if (fixture.supported) {
          assert.equal(result.skills.length, 1);
          assert.equal(result.diagnostics.some(item => item.level === 'error'), false);
          const source = await engine.parseSource(fixture.path);
          assert.equal(source.candidates[0].installable, true);
        } else {
          assert.deepEqual(result.formats, [fixture.id]);
          assert.equal(result.skills.length, 0);
          assert(result.diagnostics.some(item => item.code === 'PARSER_UNAVAILABLE'));
        }
      }
    `
    run(['--input-type=module', '-e', probe], profile)
    for (const module of removed) {
      const missing = await realpath(join(profile, 'src/protocols', module.id)).then(() => false, error => {
        if (error.code === 'ENOENT') return true
        throw error
      })
      assert(missing, `Removed directory is still present: ${module.id}`)
    }
    console.log(`PASS physical parser profile ${mask}: ${kept.map(module => module.id).join(', ') || '(none)'}`)
  }
  console.log(`Physical removal compilation and public-entry loading passed for ${masks.length} profiles`)
} finally {
  // Verify the exact created target before recursive cleanup, including the real
  // OS temporary parent (macOS /var aliases resolve to /private/var).
  const actual = await realpath(temporary)
  if (actual !== temporaryReal || !basename(actual).startsWith('dsh-plugin-bridge-parser-removal-') || dirname(actual) !== await realpath(tmpdir())) throw new Error('Refusing unexpected cleanup target')
  await rm(actual, { recursive: true, force: true })
}
