import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageName = '@rvaim/dsh-plugin-bridge'
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const dependency of ['@deepseek-ai/dsh-typert-generator', '@deepseek-ai/dsh-typert-protocol']) {
  const installed = JSON.parse(await readFile(new URL(import.meta.resolve(`${dependency}/package.json`)), 'utf8'))
  if (installed.version !== manifest.engines.dsh) throw new Error(`${dependency} 与目标 DSH 版本不一致`)
}
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-plugin-bridge-typert-'))
const temporaryReal = await realpath(temporaryRoot)
const packageRoot = join(temporaryRoot, 'packages', 'dsh-plugin-bridge')

// Typert analyzes workspace source ownership, including merged SDK interfaces.
// Mirror the published declaration graphs without changing their contents or
// mutating installed packages. Only this plugin is selected for analysis/emission.
async function copyDeclarations(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyDeclarations(join(source, entry.name), join(target, entry.name))
    else if (entry.name.endsWith('.d.ts')) {
      await cp(join(source, entry.name), join(target, entry.name.replace(/\.d\.ts$/, '.ts')))
    }
  }
}

function typeTarget(value) {
  if (typeof value !== 'object' || value === null) return undefined
  if (typeof value.types === 'string') return value.types
  for (const condition of Object.values(value)) {
    const target = typeTarget(condition)
    if (target !== undefined) return target
  }
  return undefined
}

try {
  await mkdir(packageRoot, { recursive: true })
  await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
  await symlink(join(root, 'node_modules'), join(temporaryRoot, 'node_modules'), 'dir')
  const paths = { [`${packageName}/types`]: ['./packages/dsh-plugin-bridge/src/types/index.ts'] }
  const references = []
  const sdkScope = join(root, 'node_modules', '@deepseek-ai')
  for (const entry of await readdir(sdkScope, { withFileTypes: true })) {
    if (entry.name === 'dsh-typert-generator' || !entry.isDirectory()) continue
    const installedRoot = join(sdkScope, entry.name)
    const sdk = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
    const exports = sdk.exports ?? { '.': { types: sdk.types } }
    const primary = typeTarget(exports['.'])
    if (primary === undefined || !primary.startsWith('./lib/')) continue
    const declarations = primary.startsWith('./lib/types/') ? 'lib/types' : 'lib'
    const mirrorRoot = join(temporaryRoot, 'packages', `sdk-${entry.name}`)
    await copyDeclarations(join(installedRoot, declarations), join(mirrorRoot, 'src'))
    await writeFile(join(mirrorRoot, 'package.json'), `${JSON.stringify(sdk, null, 2)}\n`)
    await writeFile(join(mirrorRoot, 'tsconfig.host.json'), `${JSON.stringify({
      extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', noEmit: true }, include: ['src/**/*.ts'],
    }, null, 2)}\n`)
    references.push({ path: `./packages/sdk-${entry.name}/tsconfig.host.json` })
    for (const [subpath, exported] of Object.entries(exports)) {
      const target = typeTarget(exported)
      if (target === undefined || !target.startsWith(`./${declarations}/`)) continue
      const specifier = subpath === '.' ? sdk.name : `${sdk.name}${subpath.slice(1)}`
      paths[specifier] = [`./packages/sdk-${entry.name}/src/${target.slice(declarations.length + 3).replace(/\.d\.ts$/, '.ts')}`]
    }
  }

  manifest.exports = {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './service': { types: './lib/types/service.d.ts', default: './lib/service.js' },
    './types': { types: './lib/types/types/index.d.ts', default: './lib/types/types/index.js' },
    './client': { types: './lib/types/web/client/index.d.ts', default: './lib/client.js' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    './package.json': './package.json',
  }
  manifest.files = ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts', 'lib/typert.remote-client.d.ts.map']
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(packageRoot, 'tsconfig.host.json'), `${JSON.stringify({
    extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', noEmit: true },
    include: ['src/**/*.ts'], exclude: ['src/web/client'],
  }, null, 2)}\n`)
  references.push({ path: './packages/dsh-plugin-bridge/tsconfig.host.json' })
  await writeFile(join(temporaryRoot, 'tsconfig.base.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2024', 'DOM', 'DOM.Iterable'],
      strict: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ['node'], jsx: 'react-jsx', paths,
    },
  }, null, 2)}\n`)
  await writeFile(join(temporaryRoot, 'tsconfig.host.json'), `${JSON.stringify({
    extends: './tsconfig.base.json', files: [], references,
  }, null, 2)}\n`)

  const model = new WorkspaceAnalyzer({ root: temporaryRoot, packages: [packageName], faces: ['host'] }).analyze()
  const face = model.faces.find(item => item.face === 'host')
  if (face === undefined) throw new Error('Typert 未生成 Host 模型')
  const artifact = new FaceModelEmitter(face).emit(packageName)
  if (artifact.remote === undefined) throw new Error('Typert 未生成 Remote 产物')
  const output = join(root, 'dist')
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(join(output, 'typert.host.js'), artifact.js),
    writeFile(join(output, 'typert.host.d.ts'), artifact.dts),
    writeFile(join(output, 'typert.remote-client.js'), artifact.remote.js),
    writeFile(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts),
    writeFile(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap),
  ])
} finally {
  const actual = await realpath(temporaryRoot)
  if (actual !== temporaryReal || dirname(actual) !== await realpath(tmpdir())
    || !basename(actual).startsWith('dsh-plugin-bridge-typert-')) throw new Error('Refusing unexpected Typert cleanup target')
  await rm(actual, { recursive: true, force: true })
}
