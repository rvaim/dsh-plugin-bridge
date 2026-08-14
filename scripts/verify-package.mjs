import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
for (const file of [
  'dist/src/index.js',
  'dist/src/cli/index.js',
  'README.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'docs/ARCHITECTURE.md',
  'docs/COMPATIBILITY.md',
  'docs/MIGRATION.md',
  'docs/SECURITY.md',
  'docs/TESTING.md',
  'docs/USAGE.md',
  'docs/VALIDATION-REPORT.md',
]) {
  await access(new URL(file, root))
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (packageJson.name !== 'dsh-compat') throw new Error('包名必须为 dsh-compat')
if (packageJson.version !== '0.2.2') throw new Error('交付版本必须为 0.2.2')
if (packageJson.bin?.['dsh-compat'] !== './dist/src/cli/index.js') throw new Error('bin 配置错误')
if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch 配置错误')
if (packageJson.engines?.node !== '^22.19.0 || >=24.0.0') throw new Error('Node engines 未与当前 DSH 对齐')
if (packageJson.files?.includes('dist/') === true) throw new Error('发布清单不得包含整个 dist/，否则会夹带测试产物')
if (!packageJson.files?.includes('dist/src/')) throw new Error('发布清单缺少 dist/src/')
if (packageJson.peerDependenciesMeta?.['@deepseek-ai/schemastery'] !== undefined) {
  throw new Error('Schemastery 是静态导入，不能声明为 optional peer')
}
if (packageJson.dependencies?.['@deepseek-ai/dsh-hook-protocol'] !== '0.0.1-rc.5') {
  throw new Error('Hook Protocol 必须作为与目标 DSH 对齐的运行依赖安装')
}
if (packageJson.peerDependencies?.['@deepseek-ai/dsh-hook-protocol'] !== undefined
  || packageJson.peerDependenciesMeta?.['@deepseek-ai/dsh-hook-protocol'] !== undefined) {
  throw new Error('Hook Protocol 不能再声明为 peer/optional peer，否则 profile 安装后 Hook 无法注册')
}

const help = spawnSync(process.execPath, [new URL('dist/src/cli/index.js', root).pathname, 'help'], { encoding: 'utf8' })
if (
  help.status !== 0
  || !help.stdout.includes('dsh-compat')
  || !help.stdout.includes('source add')
  || !help.stdout.includes('--plugin')
) throw new Error('CLI help 冒烟测试失败')

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
if ([...files].some(path => path.startsWith('dist/test/'))) throw new Error('npm 包意外包含 dist/test/')
if ([...files].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('node_modules/'))) {
  throw new Error('npm 包意外包含源码、测试或 node_modules')
}
for (const required of ['CHANGELOG.md', 'docs/MIGRATION.md', 'docs/USAGE.md']) {
  if (!files.has(required)) throw new Error(`npm 包缺少 ${required}`)
}

console.log(`包结构、DSH bundle、CLI 与 ${files.size} 个发布文件检查通过`)
