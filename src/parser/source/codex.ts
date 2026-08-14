import { resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic, sortDiagnostics } from '../../types/diagnostic.js'
import { pathExists, readJson } from '../shared/fs.js'
import { asObject } from '../shared/object.js'
import { createCandidate, parseMarketplaceLocation, stringField } from './common.js'
import type { SourceParserResult } from './types.js'

export const CODEX_MARKETPLACE_FILE = '.agents/plugins/marketplace.json'

export async function parseCodexMarketplace(sourceRoot: string): Promise<SourceParserResult | undefined> {
  const file = resolve(sourceRoot, CODEX_MARKETPLACE_FILE)
  if (!await pathExists(file)) return undefined
  const diagnostics: CompatDiagnostic[] = []
  let root: Record<string, unknown>
  try {
    const value = await readJson(file)
    const object = asObject(value)
    if (object === undefined) throw new Error('顶层必须是对象')
    root = object
  } catch (error) {
    return {
      marketplaceFile: CODEX_MARKETPLACE_FILE,
      candidates: [],
      diagnostics: [diagnostic('error', 'CODEX_MARKETPLACE_INVALID', 'source', `Codex Marketplace 无法解析：${String(error)}`, CODEX_MARKETPLACE_FILE)],
    }
  }

  const marketplaceName = stringField(root, 'name')
  const fatalDiagnostics: CompatDiagnostic[] = []
  if (marketplaceName === undefined) {
    const item = diagnostic('error', 'CODEX_MARKETPLACE_NAME_MISSING', 'source', 'Codex Marketplace 缺少 name', CODEX_MARKETPLACE_FILE)
    diagnostics.push(item)
    fatalDiagnostics.push(item)
  }
  if (root.interface !== undefined) {
    const marketplaceInterface = asObject(root.interface)
    if (marketplaceInterface === undefined) {
      const item = diagnostic('error', 'CODEX_MARKETPLACE_INTERFACE_INVALID', 'source', 'Codex Marketplace interface 必须是对象', CODEX_MARKETPLACE_FILE)
      diagnostics.push(item)
      fatalDiagnostics.push(item)
    } else if (
      marketplaceInterface.displayName !== undefined
      && stringField(marketplaceInterface, 'displayName') === undefined
    ) {
      const item = diagnostic('error', 'CODEX_MARKETPLACE_DISPLAY_NAME_INVALID', 'source', 'Codex Marketplace interface.displayName 必须是非空字符串', CODEX_MARKETPLACE_FILE)
      diagnostics.push(item)
      fatalDiagnostics.push(item)
    }
  }
  const rawPlugins = root.plugins
  if (!Array.isArray(rawPlugins)) {
    diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGINS_INVALID', 'source', 'Codex Marketplace plugins 必须是数组', CODEX_MARKETPLACE_FILE))
    return { marketplaceFile: CODEX_MARKETPLACE_FILE, ...(marketplaceName === undefined ? {} : { marketplaceName }), candidates: [], diagnostics }
  }

  const candidates: import('./types.js').SourcePluginCandidate[] = []
  for (const [index, rawEntry] of rawPlugins.entries()) {
    const entry = asObject(rawEntry)
    if (entry === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_ENTRY_INVALID', 'source', `plugins 第 ${index + 1} 项必须是对象`, CODEX_MARKETPLACE_FILE))
      continue
    }
    if (stringField(entry, 'name') === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_NAME_MISSING', 'source', `plugins 第 ${index + 1} 项缺少 name`, CODEX_MARKETPLACE_FILE))
      continue
    }
    if (entry.source === undefined) {
      diagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_SOURCE_MISSING', 'source', `插件 ${String(entry.name)} 缺少 source`, CODEX_MARKETPLACE_FILE))
      continue
    }

    const entryDiagnostics: CompatDiagnostic[] = [...fatalDiagnostics]
    const policy = entry.policy === undefined ? undefined : asObject(entry.policy)
    if (entry.policy !== undefined && policy === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy 必须是对象`, CODEX_MARKETPLACE_FILE))
    }
    const installation = policy === undefined ? undefined : stringField(policy, 'installation')
    if (policy?.installation !== undefined && installation === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_INSTALLATION_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.installation 必须是非空字符串`, CODEX_MARKETPLACE_FILE))
    }
    if (installation !== undefined && !['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(installation)) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_INSTALLATION_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.installation 无效：${installation}`, CODEX_MARKETPLACE_FILE))
    }
    const authentication = policy === undefined ? undefined : stringField(policy, 'authentication')
    if (policy?.authentication !== undefined && authentication === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_AUTH_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.authentication 必须是非空字符串`, CODEX_MARKETPLACE_FILE))
    }
    if (authentication !== undefined && !['ON_INSTALL', 'ON_USE'].includes(authentication)) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_AUTH_POLICY_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.authentication 无效：${authentication}`, CODEX_MARKETPLACE_FILE))
    }
    if (installation === 'NOT_AVAILABLE') {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PLUGIN_NOT_AVAILABLE', 'source', `插件 ${String(entry.name)} 的安装策略为 NOT_AVAILABLE`, CODEX_MARKETPLACE_FILE))
    }
    if (policy?.products !== undefined) {
      if (!Array.isArray(policy.products) || policy.products.some(item => typeof item !== 'string')) {
        entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_PRODUCTS_INVALID', 'source', `插件 ${String(entry.name)} 的 policy.products 必须是字符串数组`, CODEX_MARKETPLACE_FILE))
      } else {
        entryDiagnostics.push(diagnostic('warning', 'CODEX_MARKETPLACE_PRODUCT_POLICY_NOT_ENFORCED', 'source', `插件 ${String(entry.name)} 声明了 Codex 产品范围；dsh-compat 只在用户明确选择后安装，不把 DSH 伪装成某个 Codex 产品`, CODEX_MARKETPLACE_FILE))
      }
    }
    if (entry.category !== undefined && stringField(entry, 'category') === undefined) {
      entryDiagnostics.push(diagnostic('error', 'CODEX_MARKETPLACE_CATEGORY_INVALID', 'source', `插件 ${String(entry.name)} 的 category 必须是非空字符串`, CODEX_MARKETPLACE_FILE))
    }

    const parsed = await parseMarketplaceLocation({
      sourceRoot,
      raw: entry.source,
      marketplaceFile: CODEX_MARKETPLACE_FILE,
      format: 'codex',
    })
    const candidate = createCandidate({
      format: 'codex',
      marketplaceFile: CODEX_MARKETPLACE_FILE,
      pointer: `/plugins/${index}`,
      entry,
      location: parsed.location,
      locationKey: parsed.key,
      installable: parsed.installable && !entryDiagnostics.some(item => item.level === 'error'),
      diagnostics: [...parsed.diagnostics, ...entryDiagnostics],
      fallbackId: `invalid-${index + 1}`,
    })
    candidates.push(candidate)
  }
  return {
    marketplaceFile: CODEX_MARKETPLACE_FILE,
    ...(marketplaceName === undefined ? {} : { marketplaceName }),
    candidates,
    diagnostics: sortDiagnostics(diagnostics),
  }
}
