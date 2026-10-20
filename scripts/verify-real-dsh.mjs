#!/usr/bin/env node

/**
 * 在目标 DSH profile/checkout 已安装 peerDependencies 后运行。
 * 该探针只核对当前发布包的关键导出契约；完整行为仍由 test/ 中的生命周期测试覆盖。
 */
const failures = []

async function load(name) {
  try {
    console.log(`探针依赖 ${name} → ${import.meta.resolve(name)}`)
    return await import(name)
  } catch (error) {
    failures.push(`${name} 无法导入：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

const [cordis, schemaModule, hookProtocol, mcpClient] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/schemastery'),
  load('@deepseek-ai/dsh-hook-protocol'),
  load('@deepseek-ai/dsh-mcp-client'),
])

if (cordis !== undefined && typeof cordis.Service !== 'function') failures.push('@deepseek-ai/cordis 未导出 Service')
const schema = schemaModule?.default ?? schemaModule
if (schema !== undefined && typeof schema.object !== 'function') failures.push('@deepseek-ai/schemastery 未导出 object()')
for (const name of ['runHook', 'matchesMatcher', 'mergeHookOutputs', 'createDetachedRuns']) {
  if (hookProtocol !== undefined && typeof hookProtocol[name] !== 'function') {
    failures.push(`@deepseek-ai/dsh-hook-protocol 未导出 ${name}()`)
  }
}
if (mcpClient !== undefined) {
  const plugin = mcpClient.default ?? mcpClient
  if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function') {
    failures.push('@deepseek-ai/dsh-mcp-client 不是 Cordis 可挂载插件')
  }
}

try {
  const compat = await import('../dist/src/index.js')
  if (typeof compat.apply !== 'function') failures.push('plugin-bridge 未导出 apply()')
  if (!Array.isArray(compat.inject) || !compat.inject.includes('skills') || !compat.inject.includes('shell')) {
    failures.push('plugin-bridge 的 inject 未声明 skills/shell')
  }
  if (compat.Config === undefined) failures.push('plugin-bridge 未导出 Config schema')
  if (typeof compat.CompatWebGateway !== 'function') failures.push('plugin-bridge 未导出 CompatWebGateway')
  if (typeof compat.CompatManager?.prototype?.prepareInstall !== 'function') {
    failures.push('CompatManager 未导出分步 Web 安装的 prepareInstall()')
  }
  if (typeof compat.CompatManager?.prototype?.checkUpdates !== 'function') {
    failures.push('CompatManager 未导出 Web 更新检测的 checkUpdates()')
  }
} catch (error) {
  failures.push(`plugin-bridge 构建入口无法导入：${error instanceof Error ? error.message : String(error)}`)
}

try {
  const [{ TYPERT }, { default: remote }] = await Promise.all([
    import('../dist/typert.host.js'),
    import('../dist/typert.remote-client.js'),
  ])
  const hostMethods = new Set(TYPERT?.invocations?.map(item => `${item.namespace}/${item.method}`) ?? [])
  const remoteMethods = new Set(remote?.descriptors?.map(item => `${item.namespace}/${item.method}`) ?? [])
  for (const method of ['beginAdd', 'cancelAdd', 'checkUpdates', 'completeAdd', 'list', 'setEnabled', 'uninstall', 'update']) {
    const endpoint = `pluginBridgeAdmin/${method}`
    if (!hostMethods.has(endpoint)) failures.push(`Typert Host 缺少 ${endpoint}`)
    if (!remoteMethods.has(endpoint)) failures.push(`Typert Remote 缺少 ${endpoint}`)
  }
} catch (error) {
  failures.push(`plugin-bridge Typert 产物无法导入：${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error('真实 DSH 契约探针失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error('\n请在安装了目标 DeepSeek Harness 依赖的 profile 或源码 checkout 中重试。')
  process.exitCode = 1
} else {
  console.log('当前解析环境的 DSH 关键导出检查通过；这不是当前 Desktop 挂载、RPC 往返或浏览器验证')
}
