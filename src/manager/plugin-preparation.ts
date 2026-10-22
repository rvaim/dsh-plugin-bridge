import { join, resolve } from 'node:path'
import type { CompatParserEngine } from '../parser/contracts.js'
import { selectCandidateParser, withAdditionalDiagnostics } from '../parser/model.js'
import { validateSourceDirectory } from '../shared/source-path.js'
import { pathExists } from '../source/filesystem.js'
import type { CompatLayout } from '../store/layout.js'
import type { SourcePluginCandidate } from '../types/catalog.js'
import type { CompatPlugin, InstallMetadata } from '../types/plugin.js'
import { materializeExternalPlugin } from './acquire.js'
import { findCapabilityConflicts, findCapabilityConflictsWithin, stripConflictDiagnostics } from './conflicts.js'
import { CompatibilityError, ParserSelectionRequiredError } from './errors.js'
import { hasErrorDiagnostics } from '../types/diagnostic.js'
import { copyPluginDirectory } from '../source/directory.js'
import type { ParserMatch } from '../types/parser.js'
import { candidateWantsEnable, externalDirectoryName, hasNonConflictErrors, stateOf } from './helpers.js'
import { createPluginScan } from './plugin-loader.js'
import type { InstallOptions, ParsedInstallCandidate, ParserChoiceRequest, PluginInstallSelection, PreparedPlugin } from './types.js'

export interface PluginPreparationContext {
  layout: CompatLayout
  parsers: CompatParserEngine
}

export async function parseAndCheckPlugin(
  { layout, parsers }: PluginPreparationContext,
  packageRoot: string,
  parserId: string,
  sourceId: string,
  sourcePluginId: string,
  suggestedId: string | undefined,
  asId: string | undefined,
  excludePluginIds: readonly string[] = [],
  candidate?: SourcePluginCandidate,
): Promise<CompatPlugin> {
  const selected = candidate === undefined ? undefined : selectCandidateParser(candidate, parserId)
  if (selected !== undefined && (!selected.installable || hasErrorDiagnostics(selected.diagnostics))) {
    throw new CompatibilityError(`插件 ${sourcePluginId} 的解析器 ${parserId} 不可用于安装`, selected.diagnostics)
  }
  const parsed = stripConflictDiagnostics(await parsers.parsePlugin(packageRoot, {
    parserId,
    sourceId,
    sourcePluginId,
    ...(suggestedId === undefined ? {} : { suggestedId }),
    ...(asId === undefined ? {} : { asId }),
    ...(selected?.displayName === undefined ? {} : { displayName: selected.displayName }),
    ...(selected === undefined ? {} : { marketplaceDefinitions: selected.definitions }),
  }))
  const conflicts = await findCapabilityConflicts(layout, parsed, excludePluginIds, parsers)
  return withAdditionalDiagnostics(parsed, [...(selected?.diagnostics ?? []), ...conflicts])
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

export async function inspectPreparedParsers(parsers: CompatParserEngine, contents: readonly PreparedPlugin[]): Promise<ParserChoiceRequest[]> {
  const choices: ParserChoiceRequest[] = []
  for (const prepared of contents) {
    choices.push({
      pluginId: prepared.candidate.id,
      name: prepared.candidate.displayName ?? prepared.candidate.name,
      matches: await parsers.matchPlugin(prepared.packageRoot, { marketplaceDefinitions: prepared.candidate.definitions }),
    })
  }
  return choices
}

export function resolveParserSelections(choices: readonly ParserChoiceRequest[], selections: readonly PluginInstallSelection[]): Map<string, string> {
  const resolved = new Map<string, string>()
  let needsSelection = false
  for (const choice of choices) {
    const requested = selections.find(item => item.pluginId === choice.pluginId)?.parserId
    const match: ParserMatch | undefined = requested === undefined
      ? choice.matches.length === 1 ? choice.matches[0] : undefined
      : choice.matches.find(item => item.parserId === requested)
    if (match === undefined) {
      if (requested !== undefined) throw new Error(`插件 ${choice.pluginId} 不匹配解析器 ${requested}`)
      if (choice.matches.length === 0) throw new Error(`没有已注册解析器能识别插件 ${choice.pluginId}`)
      needsSelection = true
      continue
    }
    if (!match.available || hasErrorDiagnostics(match.diagnostics)) {
      throw new CompatibilityError(`插件 ${choice.pluginId} 的解析器 ${match.parserId} 不可用`, match.diagnostics)
    }
    resolved.set(choice.pluginId, match.parserId)
  }
  if (needsSelection) throw new ParserSelectionRequiredError([...choices])
  return resolved
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
  preparedContents?: readonly PreparedPlugin[],
): Promise<ParsedInstallCandidate[]> {
  if (options.as !== undefined && candidates.length !== 1) throw new Error('--as 只能用于一次安装一个插件')
  const parsed: ParsedInstallCandidate[] = []
  const contents: PreparedPlugin[] = []
  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    const cached = preparedContents?.find(item => item.candidate.id === candidate.id)
    if (cached?.newlyMaterializedExternal !== undefined) {
      const staged = join(transactionRoot, 'materialized-external', externalDirectoryName(candidate.id))
      await copyPluginDirectory(cached.newlyMaterializedExternal, staged, options.signal)
      const relativeRoot = cached.location.type === 'git-subdir' ? cached.location.path : '.'
      contents.push({ ...cached, candidate, packageRoot: resolve(staged, 'package', relativeRoot), newlyMaterializedExternal: staged })
    } else {
      contents.push(cached === undefined
        ? await preparePluginContent(sourceRoot, candidate, transactionRoot, existingExternalRoot, options.signal)
        : { ...cached, candidate })
    }
  }
  const choices = await inspectPreparedParsers(parsers, contents)
  const selectedParsers = resolveParserSelections(choices, options.plugins ?? [])

  for (const prepared of contents) {
    options.signal?.throwIfAborted()
    const candidate = prepared.candidate
    const parserId = selectedParsers.get(candidate.id)!
    const plugin = await parseAndCheckPlugin(
      { layout, parsers },
      prepared.packageRoot,
      parserId,
      sourceId,
      candidate.id,
      candidate.id,
      options.as,
      [],
      candidate,
    )
    const install: InstallMetadata = {
      pluginId: plugin.id,
      sourceId,
      sourcePluginId: candidate.id,
      parserId,
      location: prepared.location,
      ...(prepared.materialization === undefined ? {} : { materialization: prepared.materialization }),
      installedAt: new Date().toISOString(),
    }
    parsed.push({
      prepared: { ...prepared, candidate: selectCandidateParser(candidate, parserId) },
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
