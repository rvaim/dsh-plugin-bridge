import { posix, resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic, sortDiagnostics } from '../../types/diagnostic.js'
import { readJson } from '../../shared/fs.js'
import { inspectContainedPath } from '../../shared/contained-path.js'
import { asObject } from '../../shared/object.js'
import { createCandidate, parseMarketplaceLocation, stringField } from './source-common.js'
import type { SourceParserResult } from '../../types/catalog.js'

export const CODEX_MARKETPLACE_FILE = '.agents/plugins/marketplace.json'

export async function parseCodexMarketplace(sourceRoot: string, marketplaceFile = CODEX_MARKETPLACE_FILE): Promise<SourceParserResult | undefined> {
  marketplaceFile = marketplaceFile.replaceAll('\\', '/')
  const marketPrefix = marketplaceFile === CODEX_MARKETPLACE_FILE
    ? ''
    : marketplaceFile.endsWith(`/${CODEX_MARKETPLACE_FILE}`)
      ? marketplaceFile.slice(0, -CODEX_MARKETPLACE_FILE.length - 1)
      : undefined
  const invalid = (message: string): SourceParserResult => ({
    marketplaceFile,
    candidates: [],
    diagnostics: [diagnostic('error', 'CODEX_MARKETPLACE_INVALID', 'source', message, marketplaceFile)],
  })
  if (marketPrefix === undefined || marketplaceFile.includes('\0') || /^[A-Za-z]:\//.test(marketplaceFile)
    || marketplaceFile.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return invalid('Codex Marketplace 必须位于 Source 内的 .agents/plugins/marketplace.json')
  }
  const inspected = await inspectContainedPath(sourceRoot, marketplaceFile, 'file')
  if (inspected.status === 'missing') return undefined
  if (inspected.status !== 'ok') return invalid('Codex Marketplace 清单路径无效或逃逸 Source')
  const marketRoot = resolve(sourceRoot, marketPrefix)
  const diagnostics: CompatDiagnostic[] = []
  let root: Record<string, unknown>
  try {
    const value = await readJson(inspected.path)
    const object = asObject(value)
    if (object === undefined) throw new Error('顶层必须是对象')
    root = object
  } catch (error) {
    return invalid(`Codex Marketplace 无法解析：${String(error)}`)
  }

  for (const key of Object.keys(root)) {
    if (!['$schema', 'name', 'interface', 'plugins'].includes(key)) diagnostics.push(diagnostic('warning', 'CODEX_MARKETPLACE_UNKNOWN_FIELD', 'source', `未识别的 Codex Marketplace 顶层字段已忽略：${key}`, marketplaceFile))
  }
  const marketplaceName = stringField(root, 'name')
  const fatalDiagnostics: CompatDiagnostic[] = []
  if (marketplaceName === undefined) {
    const item = diagnostic('error', 'CODEX_MARKETPLACE_NAME_MISSING', 'source', 'Codex Marketplace 缺少 name', marketplaceFile)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  if (root.interface !== undefined) {
    const marketplaceInterface = asObject(root.interface)
    if (marketplaceInterface === undefined) {
      const item = diagnostic('error', 'CODEX_MARKETPLACE_INTERFACE_INVALID', 'source', 'Codex Marketplace interface 必须是对象', marketplaceFile)
      diagnostics.push(item)
      fatalDiagnostics.push(item)
    } else if (
      marketplaceInterface.displayName !== undefined
      && stringField(marketplaceInterface, 'displayName') === undefined
    ) {
      const item = diagnostic('error', 'CODEX_MARKETPLACE_DISPLAY_NAME_INVALID', 'source', 'Codex Marketplace interface.displayName 必须是非空字符串', marketplaceFile)
      diagnostics.push(item)
      fatalDiagnostics.push(item)
    }
  }
  const rawPlugins = root.plugins
  if (!Array.isArray(rawPlugins)) {
    diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGINS_INVALID', 'source', 'Codex Marketplace plugins 必须是数组', marketplaceFile))
    return { marketplaceFile, ...(marketplaceName === undefined ? {} : { marketplaceName }), candidates: [], diagnostics }
  }

  const candidates: import('../../types/catalog.js').SourcePluginCandidate[] = []
  for (const [index, rawEntry] of rawPlugins.entries()) {
    const entry = asObject(rawEntry)
    if (entry === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_ENTRY_INVALID', 'source', `plugins 第 ${index + 1} 项必须是对象`, marketplaceFile))
      continue
    }
    if (stringField(entry, 'name') === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_NAME_MISSING', 'source', `plugins 第 ${index + 1} 项缺少 name`, marketplaceFile))
      continue
    }
    if (entry.source === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_SOURCE_MISSING', 'source', `插件 ${String(entry.name)} 缺少 source`, marketplaceFile))
      continue
    }

    const entryDiagnostics: CompatDiagnostic[] = [...fatalDiagnostics]
    const policy = entry.policy === undefined ? undefined : asObject(entry.policy)
    if (entry.policy !== undefined && policy === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy 必须是对象`, marketplaceFile))
    }
    const installation = policy === undefined ? undefined : stringField(policy, 'installation')
    if (policy?.installation !== undefined && installation === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_INSTALLATION_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.installation 必须是非空字符串`, marketplaceFile))
    }
    if (installation !== undefined && !['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(installation)) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_INSTALLATION_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.installation 无效：${installation}`, marketplaceFile))
    }
    const authentication = policy === undefined ? undefined : stringField(policy, 'authentication')
    if (policy?.authentication !== undefined && authentication === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_AUTH_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.authentication 必须是非空字符串`, marketplaceFile))
    }
    if (authentication !== undefined && !['ON_INSTALL', 'ON_USE'].includes(authentication)) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_AUTH_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.authentication 无效：${authentication}`, marketplaceFile))
    }
    if (installation === 'NOT_AVAILABLE') {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE', 'source', `插件 ${String(entry.name)} 的安装策略为 NOT_AVAILABLE`, marketplaceFile))
    }
    if (policy?.products !== undefined) {
      if (!Array.isArray(policy.products) || policy.products.some(item => typeof item !== 'string')) {
        entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PRODUCTS_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.products 必须是字符串数组`, marketplaceFile))
      } else {
        entryDiagnostics.push(diagnostic('warning', 'CODEX_MARKETPLACE_PRODUCT_POLICY_NOT_ENFORCED', 'source', `插件 ${String(entry.name)} 声明了 Codex 产品范围；Plugin Bridge 只在用户明确选择后安装，不把 DSH 伪装成某个 Codex 产品`, marketplaceFile))
      }
    }
    if (entry.category !== undefined && stringField(entry, 'category') === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_CATEGORY_INVALID', 'source', `插件 ${String(entry.name)} 的 category 必须是非空字符串`, marketplaceFile))
    }

    const parsed = await parseMarketplaceLocation({
      sourceRoot: marketRoot,
      raw: entry.source,
      marketplaceFile,
      format: 'codex',
    })
    // 本地路径先以市场根解析，再恢复为整个 Source 内的路径；外部仓库不变。
    const location = parsed.location.type === 'source-path'
      ? { ...parsed.location, path: posix.join(marketPrefix, parsed.location.path) }
      : parsed.location
    const candidate = createCandidate({
      format: 'codex',
      marketplaceFile,
      pointer: `/plugins/${index}`,
      entry,
      location,
      locationKey: parsed.key,
      installable: parsed.installable && !entryDiagnostics.some(item => item.level === 'error'),
      diagnostics: [...parsed.diagnostics, ...entryDiagnostics],
      fallbackId: `invalid-${index + 1}`,
    })
    candidates.push(candidate)
  }
  return {
    marketplaceFile,
    ...(marketplaceName === undefined ? {} : { marketplaceName }),
    candidates,
    diagnostics: sortDiagnostics(diagnostics),
  }
}
