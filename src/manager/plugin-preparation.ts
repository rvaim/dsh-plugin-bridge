import { join, resolve } from 'node:path'
import type { CompatParserEngine } from '../parser/contracts.js'
import { withAdditionalDiagnostics } from '../parser/model.js'
import { validateSourceDirectory } from '../shared/source-path.js'
import { pathExists } from '../source/filesystem.js'
import type { CompatLayout } from '../store/layout.js'
import type { SourcePluginCandidate } from '../types/catalog.js'
import type { CompatPlugin, InstallMetadata } from '../types/plugin.js'
import { materializeExternalPlugin } from './acquire.js'
import { findCapabilityConflicts, findCapabilityConflictsWithin, stripConflictDiagnostics } from './conflicts.js'
import { CompatibilityError } from './errors.js'
import { candidateWantsEnable, externalDirectoryName, hasNonConflictErrors, stateOf } from './helpers.js'
import { createPluginScan } from './plugin-loader.js'
import type { InstallOptions, ParsedInstallCandidate, PreparedPlugin } from './types.js'

export interface PluginPreparationContext {
  layout: CompatLayout
  parsers: CompatParserEngine
}

export async function parseAndCheckPlugin(
  { layout, parsers }: PluginPreparationContext,
  packageRoot: string,
  sourceId: string,
  sourcePluginId: string,
  suggestedId: string | undefined,
  asId: string | undefined,
  excludePluginIds: readonly string[] = [],
  candidate?: SourcePluginCandidate,
): Promise<CompatPlugin> {
  const parsed = stripConflictDiagnostics(await parsers.parsePlugin(packageRoot, {
    sourceId,
    sourcePluginId,
    ...(suggestedId === undefined ? {} : { suggestedId }),
    ...(asId === undefined ? {} : { asId }),
    ...(candidate?.displayName === undefined ? {} : { displayName: candidate.displayName }),
    ...(candidate === undefined ? {} : { marketplaceDefinitions: candidate.definitions }),
  }))
  const conflicts = await findCapabilityConflicts(layout, parsed, excludePluginIds, parsers)
  return withAdditionalDiagnostics(parsed, conflicts)
}

export async function preparePluginContent(
  sourceRoot: string,
  candidate: SourcePluginCandidate,
  transactionRoot: string,
  existingExternalRoot?: string,
  signal?: AbortSignal,
): Promise<PreparedPlugin> {
  signal?.throwIfAborted()
  if (candidate.location.type === 'source-path') {
    const path = await validateSourceDirectory(join(sourceRoot, 'package'), candidate.location.path)
    return {
      candidate,
      packageRoot: resolve(sourceRoot, 'package', path),
      location: { type: 'source-path', path },
    }
  }

  if (candidate.location.type !== 'git' && candidate.location.type !== 'git-subdir') {
    throw new CompatibilityError(`插件 ${candidate.id} 的来源类型 ${candidate.location.type} 当前不支持`, candidate.diagnostics)
  }

  const key = externalDirectoryName(candidate.id)
  const official = existingExternalRoot === undefined ? undefined : join(existingExternalRoot, key)
  if (official !== undefined && await pathExists(join(official, 'package'))) {
    const packageRoot = candidate.location.type === 'git'
      ? join(official, 'package')
      : resolve(official, 'package', candidate.location.path)
    await validateSourceDirectory(join(official, 'package'), candidate.location.type === 'git' ? '.' : candidate.location.path)
    return {
      candidate,
      packageRoot,
      location: candidate.location,
      ...(candidate.location.sha === undefined ? {} : { materialization: { commit: candidate.location.sha } }),
    }
  }

  const staged = join(transactionRoot, 'materialized-external', key)
  const materialized = await materializeExternalPlugin(candidate.location, staged, signal)
  const packageRoot = materialized.location.type === 'git'
    ? materialized.packageRoot
    : resolve(materialized.packageRoot, materialized.location.path)
  await validateSourceDirectory(
    materialized.packageRoot,
    materialized.location.type === 'git' ? '.' : materialized.location.path,
  )
  return {
    candidate,
    packageRoot,
    location: materialized.location,
    materialization: { commit: materialized.location.sha },
    newlyMaterializedExternal: staged,
  }
}

export async function buildParsedCandidates(
  { layout, parsers }: PluginPreparationContext,
  sourceId: string,
  sourceRoot: string,
  candidates: readonly SourcePluginCandidate[],
  sourceRevision: string,
  transactionRoot: string,
  options: InstallOptions,
  existingExternalRoot?: string,
): Promise<ParsedInstallCandidate[]> {
  if (options.as !== undefined && candidates.length !== 1) throw new Error('--as 只能用于一次安装一个插件')
  const parsed: ParsedInstallCandidate[] = []

  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    const prepared = await preparePluginContent(sourceRoot, candidate, transactionRoot, existingExternalRoot, options.signal)
    let plugin = await parseAndCheckPlugin(
      { layout, parsers },
      prepared.packageRoot,
      sourceId,
      candidate.id,
      candidate.id,
      options.as,
      [],
      candidate,
    )
    plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
    const install: InstallMetadata = {
      pluginId: plugin.id,
      sourceId,
      sourcePluginId: candidate.id,
      location: prepared.location,
      ...(prepared.materialization === undefined ? {} : { materialization: prepared.materialization }),
      installedAt: new Date().toISOString(),
    }
    parsed.push({
      prepared,
      plugin,
      install,
      state: stateOf(false, options.priority ?? 0),
      scan: createPluginScan(plugin, sourceRevision, parsers),
    })
  }

  const duplicate = parsed.find((item, index) =>
    parsed.findIndex(other => other.plugin.id === item.plugin.id) !== index)
  if (duplicate !== undefined) throw new Error(`一次安装中产生重复 pluginId：${duplicate.plugin.id}`)

  // 只有本次确实准备启用的 Plugin 才形成活动能力冲突。--no-enable 或
  // Marketplace 默认禁用的 Plugin 仍可整体安装，之后 enable 时重新检查。
  const within = findCapabilityConflictsWithin(
    parsed
      .filter(item => candidateWantsEnable(item, options.enable) && !hasNonConflictErrors(item.plugin))
      .map(item => item.plugin),
  )
  for (const item of parsed) {
    const diagnostics = within.get(item.plugin.id) ?? []
    if (diagnostics.length > 0) {
      item.plugin = withAdditionalDiagnostics(item.plugin, diagnostics)
      item.scan = createPluginScan(item.plugin, sourceRevision, parsers)
    }
  }
  return parsed
}
