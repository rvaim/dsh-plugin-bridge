import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
for (const file of [
  'dist/src/index.js',
  'dist/src/manager/plugin-loader.js',
  'dist/src/runtime/adapters/hooks.js',
  'dist/src/runtime/adapters/mcp.js',
  'dist/src/runtime/adapters/skills.js',
  'dist/src/types/protocol.d.ts',
  'dist/src/web/host/gateway.js',
  'dist/src/web/client/index.d.ts',
  'dist/client.js',
  'dist/client.js.map',
  'dist/typert.host.js',
  'dist/typert.host.d.ts',
  'dist/typert.remote-client.js',
  'dist/typert.remote-client.d.ts',
  'dist/typert.remote-client.d.ts.map',
  'locale/zh.json',
  'locale/en.json',
  'icon.png',
  'docs/包更名说明.md',
  'README.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'docs/架构与生命周期.md',
  'docs/传统插件兼容矩阵.md',
  'docs/安全模型.md',
  'docs/测试策略.md',
  'docs/使用与运维.md',
  'docs/历史版本验证报告.md',
  'docs/传统插件解析兼容方案.md',
  'docs/插件协议兼容验证报告.md',
  'docs/Agent Plugins 1.0.0 兼容说明.md',
  'docs/解析器解耦重构说明.md',
  'docs/解析器解耦验证报告.md',
  'docs/Agent Plugins 1.0.0 验证报告.md',
  'dist/src/protocols/agent-plugins/schemas/1.0.0/plugin.schema.json',
  'dist/src/protocols/agent-plugins/schemas/1.0.0/mcp.schema.json',
  'dist/src/protocols/agent-plugins/schemas/1.0.0/LICENSE.json',
  'docs/assets/compat-settings.png',
]) {
  await access(new URL(file, root))
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (packageJson.name !== '@rvaim/dsh-plugin-bridge') throw new Error('包名必须为 @rvaim/dsh-plugin-bridge')
if (packageJson.exports?.['./locale/*.json'] !== './locale/*.json' || packageJson.exports?.['./icon'] !== './icon.png') throw new Error('包必须导出本地化展示元数据和图标')
for (const [locale, title] of [['zh', '插件桥'], ['en', 'Plugin Bridge']]) {
  const metadata = JSON.parse(await readFile(new URL(`locale/${locale}.json`, root), 'utf8'))
  if (metadata.meta?.title !== title || !metadata.meta?.description?.includes('Agent Plugins')) throw new Error(`locale/${locale}.json 缺少明确产品名称和支持格式说明`)
}
const icon = await readFile(new URL('icon.png', root))
if (icon.length > 256 * 1024 || icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('包图标必须为有效大小的 PNG')
if (packageJson.version !== '0.7.0') throw new Error('交付版本必须为 0.7.0')
if (packageJson.publishConfig?.access !== 'public') throw new Error('npm 组织包必须公开发布')
if (packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error('npm 发布 registry 配置错误')
if (packageJson.repository?.url !== 'git+https://github.com/rvaim/dsh-plugin-bridge.git') {
  throw new Error('npm 包缺少正确的 GitHub repository')
}
if (packageJson.bin !== undefined) throw new Error('独立 CLI 已移除，package.json 不得再配置 bin')
if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch 配置错误')
if (packageJson.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform 必须为 web')
for (const dependency of [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
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
if (packageJson.exports?.['./client']?.types !== './dist/src/web/client/index.d.ts') throw new Error('Client 类型导出必须指向收敛后的 Web Client 目录')
if (packageJson.engines?.node !== '^22.19.0 || >=24.0.0') throw new Error('Node engines 未与当前 DSH 对齐')
if (packageJson.files?.includes('dist/') === true) throw new Error('发布清单不得包含整个 dist/，否则会夹带测试产物')
if (!packageJson.files?.includes('dist/src/')) throw new Error('发布清单缺少 dist/src/')
if (packageJson.peerDependenciesMeta?.['@deepseek-ai/schemastery'] !== undefined) {
  throw new Error('Schemastery 是静态导入，不能声明为 optional peer')
}
if (packageJson.dependencies?.['@deepseek-ai/dsh-hook-protocol'] !== packageJson.engines?.dsh
  || packageJson.devDependencies?.['@deepseek-ai/dsh-typert-generator'] !== packageJson.engines?.dsh) {
  throw new Error('Hook Protocol、Typert Generator 必须与目标 DSH 对齐')
}
for (const [name, range] of Object.entries(packageJson.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-') && range !== packageJson.engines?.dsh) throw new Error(`${name} 未与目标 DSH 对齐`)
}
for (const name of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-settings']) {
  if (packageJson.dsh.client.inject.includes(name) || packageJson.peerDependencies[name] !== undefined
    || packageJson.devDependencies[name] !== undefined) throw new Error(`残留旧客户端依赖 ${name}`)
}
if (packageJson.dependencies?.ajv !== '8.20.0') throw new Error('Agent Plugins 离线 schema 校验器必须是固定运行依赖')
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
if (!clientBundle.includes('id: "@rvaim/dsh-plugin-bridge"')) {
  throw new Error('Web client 的 ModuleLoader id 必须与 npm 包名一致')
}
for (const marker of ['plugin-bridge', 'pluginBridgeAdmin.beginAdd', 'pluginBridgeAdmin.checkUpdates', 'pluginBridgeAdmin.update']) {
  if (!clientBundle.includes(marker)) throw new Error(`Web client 缺少 ${marker}`)
}
const hostTypert = await readFile(new URL('dist/typert.host.js', root), 'utf8')
const remoteTypert = await readFile(new URL('dist/typert.remote-client.js', root), 'utf8')
for (const method of ['beginAdd', 'cancelAdd', 'checkUpdates', 'completeAdd', 'list', 'setEnabled', 'uninstall', 'update']) {
  if (!hostTypert.includes(`pluginBridgeAdmin/${method}`) || !remoteTypert.includes(`pluginBridgeAdmin/${method}`)) {
    throw new Error(`Typert Host/Remote 缺少 pluginBridgeAdmin/${method}`)
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
  'locale/zh.json',
  'locale/en.json',
  'icon.png',
  'docs/包更名说明.md',
  'dist/src/manager/plugin-loader.js',
  'dist/src/runtime/adapters/hooks.js',
  'dist/src/runtime/adapters/mcp.js',
  'dist/src/runtime/adapters/skills.js',
  'dist/src/types/protocol.d.ts',
  'dist/src/web/host/gateway.js',
  'dist/src/web/client/index.d.ts',
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
for (const obsolete of ['dist/src/core/', 'dist/src/adapters/', 'dist/src/client/', 'dist/src/protocols/shared/', 'dist/src/web/gateway.']) {
  if ([...files].some(path => path.startsWith(obsolete))) throw new Error(`npm 包含已收敛目录的残留产物：${obsolete}`)
}
if ([...files].some(path => path.startsWith('dist/test/'))) throw new Error('npm 包意外包含 dist/test/')
if ([...files].some(path => path.startsWith('dist/src/cli/'))) throw new Error('npm 包不得再包含已移除的 CLI 产物')
if ([...files].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('node_modules/'))) {
  throw new Error('npm 包意外包含源码、测试或 node_modules')
}
for (const required of ['CHANGELOG.md', 'docs/使用与运维.md', 'docs/传统插件解析兼容方案.md', 'docs/插件协议兼容验证报告.md', 'docs/assets/compat-settings.png']) {
  if (!files.has(required)) throw new Error(`npm 包缺少 ${required}`)
}

console.log(`包结构、DSH bundle 与 ${files.size} 个发布文件检查通过`)
