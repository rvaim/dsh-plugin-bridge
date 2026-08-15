import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
for (const file of [
  'dist/src/index.js',
  'dist/client.js',
  'dist/client.js.map',
  'dist/typert.host.js',
  'dist/typert.host.d.ts',
  'dist/typert.remote-client.js',
  'dist/typert.remote-client.d.ts',
  'dist/typert.remote-client.d.ts.map',
  'README.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'docs/ARCHITECTURE.md',
  'docs/COMPATIBILITY.md',
  'docs/SECURITY.md',
  'docs/TESTING.md',
  'docs/USAGE.md',
  'docs/VALIDATION-REPORT.md',
  'docs/assets/compat-settings.png',
]) {
  await access(new URL(file, root))
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (packageJson.name !== '@rvaim/dsh-compat') throw new Error('包名必须为 @rvaim/dsh-compat')
if (packageJson.version !== '0.4.4') throw new Error('交付版本必须为 0.4.4')
if (packageJson.publishConfig?.access !== 'public') throw new Error('npm 组织包必须公开发布')
if (packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error('npm 发布 registry 配置错误')
if (packageJson.repository?.url !== 'git+https://github.com/rvaim/dsh-compat.git') {
  throw new Error('npm 包缺少正确的 GitHub repository')
}
if (packageJson.bin !== undefined) throw new Error('独立 CLI 已移除，package.json 不得再配置 bin')
if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch 配置错误')
if (packageJson.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform 必须为 web')
for (const dependency of [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-locale',
]) {
  if (!packageJson.dsh.client.inject.includes(dependency)) {
    throw new Error(`dsh.client.inject 缺少 ${dependency}`)
  }
}
for (const [subpath, target] of [
  ['./client', './dist/client.js'],
  ['./typert', './dist/typert.host.js'],
  ['./remote', './dist/typert.remote-client.js'],
]) {
  if (packageJson.exports?.[subpath]?.default !== target) {
    throw new Error(`${subpath} 导出必须指向 ${target}`)
  }
}
if (packageJson.engines?.node !== '^22.19.0 || >=24.0.0') throw new Error('Node engines 未与当前 DSH 对齐')
if (packageJson.files?.includes('dist/') === true) throw new Error('发布清单不得包含整个 dist/，否则会夹带测试产物')
if (!packageJson.files?.includes('dist/src/')) throw new Error('发布清单缺少 dist/src/')
if (packageJson.peerDependenciesMeta?.['@deepseek-ai/schemastery'] !== undefined) {
  throw new Error('Schemastery 是静态导入，不能声明为 optional peer')
}
if (packageJson.dependencies?.['@deepseek-ai/dsh-hook-protocol'] !== '0.1.0-rc.6') {
  throw new Error('Hook Protocol 必须作为与目标 DSH 对齐的运行依赖安装')
}
if (packageJson.dependencies?.['@clack/prompts'] !== undefined) {
  throw new Error('独立 CLI 已移除，@clack/prompts 不得再作为运行依赖')
}
if (packageJson.peerDependencies?.['@deepseek-ai/dsh-hook-protocol'] !== undefined
  || packageJson.peerDependenciesMeta?.['@deepseek-ai/dsh-hook-protocol'] !== undefined) {
  throw new Error('Hook Protocol 不能再声明为 peer/optional peer，否则 profile 安装后 Hook 无法注册')
}

const clientBundle = await readFile(new URL('dist/client.js', root), 'utf8')
if (!clientBundle.startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('Web client 不是 DSH ModuleLoader closure-factory 产物')
}
if (!clientBundle.includes('id: "@rvaim/dsh-compat"')) {
  throw new Error('Web client 的 ModuleLoader id 必须与 npm 包名一致')
}
for (const marker of ['compat-plugins', 'compatAdmin.beginAdd', 'compatAdmin.checkUpdates', 'compatAdmin.update']) {
  if (!clientBundle.includes(marker)) throw new Error(`Web client 缺少 ${marker}`)
}
const hostTypert = await readFile(new URL('dist/typert.host.js', root), 'utf8')
const remoteTypert = await readFile(new URL('dist/typert.remote-client.js', root), 'utf8')
for (const method of ['beginAdd', 'cancelAdd', 'checkUpdates', 'completeAdd', 'list', 'setEnabled', 'uninstall', 'update']) {
  if (!hostTypert.includes(`compatAdmin/${method}`) || !remoteTypert.includes(`compatAdmin/${method}`)) {
    throw new Error(`Typert Host/Remote 缺少 compatAdmin/${method}`)
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('.', root),
  encoding: 'utf8',
})
if (packed.status !== 0) throw new Error(`npm pack --dry-run 失败：${packed.stderr.trim()}`)
const packReport = JSON.parse(packed.stdout)
const files = new Set(packReport[0]?.files?.map(item => item.path) ?? [])
if (![...files].some(path => path === 'dist/src/index.js')) throw new Error('npm 包缺少 dist/src/index.js')
if (![...files].some(path => path === 'cordis.patch.yml')) throw new Error('npm 包缺少 cordis.patch.yml')
for (const required of [
  'dist/client.js',
  'dist/client.js.map',
  'dist/typert.host.js',
  'dist/typert.host.d.ts',
  'dist/typert.remote-client.js',
  'dist/typert.remote-client.d.ts',
  'dist/typert.remote-client.d.ts.map',
]) {
  if (!files.has(required)) throw new Error(`npm 包缺少 ${required}`)
}
if ([...files].some(path => path.startsWith('dist/test/'))) throw new Error('npm 包意外包含 dist/test/')
if ([...files].some(path => path.startsWith('dist/src/cli/'))) throw new Error('npm 包不得再包含已移除的 CLI 产物')
if ([...files].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('node_modules/'))) {
  throw new Error('npm 包意外包含源码、测试或 node_modules')
}
for (const required of ['CHANGELOG.md', 'docs/USAGE.md', 'docs/assets/compat-settings.png']) {
  if (!files.has(required)) throw new Error(`npm 包缺少 ${required}`)
}

console.log(`包结构、DSH bundle 与 ${files.size} 个发布文件检查通过`)
