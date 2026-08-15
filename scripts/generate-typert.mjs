import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-compat-typert-'))
const packageRoot = join(temporaryRoot, 'packages', 'dsh-compat')
const protocolRoot = join(temporaryRoot, 'packages', 'typert-protocol')

try {
  await mkdir(packageRoot, { recursive: true })
  await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
  await symlink(join(root, 'node_modules'), join(temporaryRoot, 'node_modules'), 'dir')

  await mkdir(join(protocolRoot, 'src'), { recursive: true })
  const installedProtocol = join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  await Promise.all([
    cp(join(installedProtocol, 'lib', 'types', 'index.d.ts'), join(protocolRoot, 'src', 'index.ts')),
    cp(join(installedProtocol, 'lib', 'types', 'types.d.ts'), join(protocolRoot, 'src', 'types.ts')),
  ])
  const protocolManifest = JSON.parse(await readFile(join(installedProtocol, 'package.json'), 'utf8'))
  protocolManifest.exports = {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    './package.json': './package.json',
  }
  await writeFile(join(protocolRoot, 'package.json'), `${JSON.stringify(protocolManifest, null, 2)}\n`)
  await writeFile(join(protocolRoot, 'tsconfig.json'), `${JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', noEmit: true },
    include: ['src'],
  }, null, 2)}\n`)

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  manifest.exports = {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './service': { types: './lib/types/service.d.ts', default: './lib/service.js' },
    './types': { types: './lib/types/types/index.d.ts', default: './lib/types/types/index.js' },
    './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    './package.json': './package.json',
  }
  manifest.files = [
    'lib/typert.host.js',
    'lib/typert.host.d.ts',
    'lib/typert.remote-client.js',
    'lib/typert.remote-client.d.ts',
    'lib/typert.remote-client.d.ts.map',
  ]

  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(packageRoot, 'tsconfig.json'), `${JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      rootDir: 'src',
      noEmit: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['src/client'],
  }, null, 2)}\n`)
  await writeFile(join(temporaryRoot, 'tsconfig.base.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2024', 'DOM'],
      strict: true,
      skipLibCheck: true,
      types: ['node'],
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['packages/typert-protocol/src/types.ts'],
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(temporaryRoot, 'tsconfig.host.json'), `${JSON.stringify({
    extends: './tsconfig.base.json',
    files: [],
    references: [
      { path: './packages/typert-protocol' },
      { path: './packages/dsh-compat' },
    ],
  }, null, 2)}\n`)

  const artifacts = new WorkspaceTypertGenerator(temporaryRoot)
    .generate(['dsh-compat'], ['host'])
  const artifact = artifacts.find(item => item.package === 'dsh-compat' && item.face === 'host')
  if (artifact === undefined || artifact.remote === undefined) {
    throw new Error('Typert 未生成 dsh-compat Host/Remote 产物')
  }

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
  await rm(temporaryRoot, { recursive: true, force: true })
}
