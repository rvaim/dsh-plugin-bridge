import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PARSER_VERSION, parseCompatPlugin, withAdditionalDiagnostics } from '../parser/normalize.js'
import { parseCompatSource, validateSourceDirectory } from '../parser/source/index.js'
import { normalizeManagementId } from '../parser/shared/id.js'
import { isPathInside } from '../source/safety.js'
import { writeJsonAtomic } from '../store/json.js'
import type { CompatLayout } from '../store/layout.js'
import { readInstalledPlugin, readInstalledSource } from '../store/metadata.js'
import type { InstallMetadata, InstalledPluginRecord, ScanCache } from '../types/plugin.js'

export async function resolveInstalledPluginPackageRoot(
  layout: CompatLayout,
  install: InstallMetadata,
): Promise<string> {
  if (install.location.type === 'source-path') {
    const path = await validateSourceDirectory(layout.sourcePackageDir(install.sourceId), install.location.path)
    return resolve(layout.sourcePackageDir(install.sourceId), path === '.' ? '' : path)
  }
  if (install.location.type === 'git' || install.location.type === 'git-subdir') {
    const repositoryRoot = layout.sourceExternalPackageDir(
      install.sourceId,
      normalizeManagementId(install.sourcePluginId, 'plugin'),
    )
    const target = install.location.type === 'git'
      ? repositoryRoot
      : resolve(repositoryRoot, install.location.path)
    const [rootReal, targetReal] = await Promise.all([realpath(repositoryRoot), realpath(target)])
    if (!isPathInside(rootReal, targetReal)) throw new Error(`外部插件路径逃逸缓存目录：${install.pluginId}`)
    return targetReal
  }
  throw new Error(`插件 ${install.pluginId} 的来源类型 ${install.location.type} 当前不能运行`)
}

/** parser 或 Source 版本变化时，从 Source 中的原始 Plugin 真源重新扫描。 */
export async function loadInstalledPluginForRuntime(
  layout: CompatLayout,
  pluginId: string,
): Promise<InstalledPluginRecord> {
  const record = await readInstalledPlugin(layout, pluginId)
  const sourceRecord = await readInstalledSource(layout, record.install.sourceId)
  if (
    record.scan.parserVersion === PARSER_VERSION
    && record.scan.schemaVersion === 1
    && record.scan.sourceRevision === sourceRecord.source.revision
  ) return record

  const catalog = await parseCompatSource(layout.sourcePackageDir(record.install.sourceId), {
    sourceId: record.install.sourceId,
    ...(sourceRecord.scan.manualPaths === undefined ? {} : { paths: sourceRecord.scan.manualPaths }),
  })
  const candidate = catalog.candidates.find(item => item.id === record.install.sourcePluginId)
  if (candidate === undefined) throw new Error(`Source ${record.install.sourceId} 中找不到已安装插件 ${record.install.sourcePluginId}`)
  const packageRoot = await resolveInstalledPluginPackageRoot(layout, record.install)
  let plugin = await parseCompatPlugin(packageRoot, {
    sourceId: record.install.sourceId,
    sourcePluginId: record.install.sourcePluginId,
    asId: record.install.pluginId,
    displayName: candidate.displayName,
    marketplaceDefinitions: candidate.definitions,
  })
  // Source parser 负责 Marketplace 位置、策略和格式诊断。运行时重扫时必须把
  // 这些诊断重新附加到统一结构，不能因 scan.json 失效而“恢复”为伪兼容。
  plugin = withAdditionalDiagnostics(plugin, candidate.diagnostics)
  const scan: ScanCache = {
    schemaVersion: 1,
    parserVersion: PARSER_VERSION,
    sourceRevision: sourceRecord.source.revision,
    scannedAt: new Date().toISOString(),
    plugin,
  }
  await writeJsonAtomic(layout.scanFile(pluginId), scan)
  return { ...record, scan }
}
