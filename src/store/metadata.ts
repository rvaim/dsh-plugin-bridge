import { readdir } from 'node:fs/promises'
import type { InstallMetadata, InstalledPluginRecord, PluginState, ScanCache } from '../types/plugin.js'
import type { InstalledSourceRecord, SourceMetadata, SourceScanCache } from '../types/source.js'
import { CompatLayout } from './layout.js'
import { readJsonFile, writeJsonAtomic } from './json.js'

export async function readInstalledPlugin(layout: CompatLayout, pluginId: string): Promise<InstalledPluginRecord> {
  const [install, state, scan] = await Promise.all([
    readJsonFile<InstallMetadata>(layout.installFile(pluginId)),
    readJsonFile<PluginState>(layout.stateFile(pluginId)),
    readJsonFile<ScanCache>(layout.scanFile(pluginId)),
  ])
  if (typeof install.parserId !== 'string' || install.parserId.trim() === '') {
    throw new Error(`插件 ${pluginId} 的安装记录缺少有效 parserId；不支持旧格式安装记录，请重新安装`)
  }
  return { install, state, scan }
}

/** 只读取 Source 引用关系，不要求 state.json/scan.json 完整。 */
async function readInstallMetadata(layout: CompatLayout, pluginId: string): Promise<InstallMetadata> {
  return await readJsonFile<InstallMetadata>(layout.installFile(pluginId))
}

export async function writeInstalledPlugin(
  root: string,
  install: InstallMetadata,
  state: PluginState,
  scan: ScanCache,
): Promise<void> {
  await Promise.all([
    writeJsonAtomic(`${root}/install.json`, install),
    writeJsonAtomic(`${root}/state.json`, state),
    writeJsonAtomic(`${root}/scan.json`, scan),
  ])
}

export async function readInstalledSource(layout: CompatLayout, sourceId: string): Promise<InstalledSourceRecord> {
  const [source, scan] = await Promise.all([
    readJsonFile<SourceMetadata>(layout.sourceFile(sourceId)),
    readJsonFile<SourceScanCache>(layout.sourceScanFile(sourceId)),
  ])
  return { source, scan }
}

export async function writeInstalledSource(
  root: string,
  source: SourceMetadata,
  scan: SourceScanCache,
): Promise<void> {
  await Promise.all([
    writeJsonAtomic(`${root}/source.json`, source),
    writeJsonAtomic(`${root}/scan.json`, scan),
  ])
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

export async function listPluginIds(layout: CompatLayout): Promise<string[]> {
  await layout.ensure()
  return await listDirectories(layout.installed)
}

export async function listSourceIds(layout: CompatLayout): Promise<string[]> {
  await layout.ensure()
  return await listDirectories(layout.sources)
}

export interface PluginSourceReference {
  pluginId: string
  sourceId: string
  sourcePluginId: string
}

export interface PluginSourceReferenceScan {
  references: PluginSourceReference[]
  /** install.json 无法读取的目录；其 Source 归属未知，删除 Source 时必须保守处理。 */
  unreadablePluginIds: string[]
}

/**
 * 只读取 install.json 扫描 Source 引用。
 *
 * state.json 或 scan.json 损坏不应导致 Source 引用丢失；install.json 本身损坏时，
 * 调用方必须把该目录视为“可能引用任意 Source”，禁止自动删除来源。
 */
export async function scanPluginSourceReferences(layout: CompatLayout): Promise<PluginSourceReferenceScan> {
  const references: PluginSourceReference[] = []
  const unreadablePluginIds: string[] = []
  for (const pluginId of await listPluginIds(layout)) {
    try {
      const install = await readInstallMetadata(layout, pluginId)
      references.push({
        pluginId,
        sourceId: install.sourceId,
        sourcePluginId: install.sourcePluginId,
      })
    } catch {
      unreadablePluginIds.push(pluginId)
    }
  }
  return {
    references: references.sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    unreadablePluginIds: unreadablePluginIds.sort(),
  }
}
