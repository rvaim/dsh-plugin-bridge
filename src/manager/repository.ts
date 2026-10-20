import type { CompatParserEngine } from '../parser/contracts.js'
import { withAdditionalDiagnostics } from '../parser/model.js'
import type { SourceDiscovery } from '../types/catalog.js'
import { createPluginScan, isPluginScanCurrent, parseInstalledPluginFresh, parseStoredSource, readCurrentSourceRecord, type FreshInstalledPlugin } from './plugin-loader.js'
import type { CompatLayout } from '../store/layout.js'
import { listSourceIds, readInstalledPlugin, readInstalledSource, scanPluginSourceReferences } from '../store/metadata.js'
import { writeJsonAtomic } from '../store/json.js'
import type { InstalledPluginRecord } from '../types/plugin.js'
import type { InstalledSourceRecord, InstallSource } from '../types/source.js'
import { findCapabilityConflicts, stripConflictDiagnostics } from './conflicts.js'
import { asCompatSource, originMatches } from './helpers.js'
import type { SourceInspection } from './types.js'

export class CompatRepository {
  constructor(
    readonly layout: CompatLayout,
    readonly parsers: CompatParserEngine,
    private readonly onRefresh?: (record: InstalledPluginRecord) => Promise<void>,
  ) {}

  async findSourceByOrigin(origin: InstallSource): Promise<InstalledSourceRecord | undefined> {
    for (const sourceId of await listSourceIds(this.layout)) {
      try {
        const record = await readInstalledSource(this.layout, sourceId)
        if (originMatches(record.source.origin, origin)) return record
      } catch {
        // 损坏 Source 不参与自动复用，避免把新来源错误绑定到未知记录。
      }
    }
    return undefined
  }

  async parseStoredSource(sourceId: string, record: InstalledSourceRecord): Promise<SourceDiscovery> {
    return await parseStoredSource(this.layout, sourceId, record, this.parsers)
  }

  async readCurrentSourceRecord(sourceId: string): Promise<InstalledSourceRecord> {
    return await readCurrentSourceRecord(this.layout, sourceId, this.parsers)
  }

  async parseInstalledFresh(record: InstalledPluginRecord, sourceRecord?: InstalledSourceRecord): Promise<FreshInstalledPlugin> {
    const fresh = await parseInstalledPluginFresh(this.layout, record, this.parsers, sourceRecord)
    const plugin = stripConflictDiagnostics(fresh.plugin)
    const conflicts = await findCapabilityConflicts(this.layout, plugin, [record.install.pluginId], this.parsers)
    const checked = withAdditionalDiagnostics(plugin, conflicts)
    return { ...fresh, plugin: checked, scan: createPluginScan(checked, fresh.scan.sourceRevision, this.parsers) }
  }

  async readCurrentRecord(pluginId: string): Promise<InstalledPluginRecord> {
    const record = await readInstalledPlugin(this.layout, pluginId)
    const source = await this.readCurrentSourceRecord(record.install.sourceId)
    if (isPluginScanCurrent(record.scan, source.source.revision, this.parsers)) {
      await this.onRefresh?.(record)
      return record
    }
    const fresh = await this.parseInstalledFresh(record, source)
    await writeJsonAtomic(this.layout.scanFile(pluginId), fresh.scan)
    const refreshed = { ...record, scan: fresh.scan }
    await this.onRefresh?.(refreshed)
    return refreshed
  }

  async inspectSourceUnlocked(sourceId: string): Promise<SourceInspection> {
    const record = await this.readCurrentSourceRecord(sourceId)
    const referenceScan = await scanPluginSourceReferences(this.layout)
    const installedPlugins = referenceScan.references
      .filter(item => item.sourceId === sourceId)
      .map(item => ({ pluginId: item.pluginId, sourcePluginId: item.sourcePluginId }))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    return {
      ...record,
      compat: asCompatSource(record),
      installedPlugins,
      unreadablePluginIds: referenceScan.unreadablePluginIds,
    }
  }

  /** Source 变更必须能完整读取所有引用它的 Plugin；损坏记录时拒绝猜测。 */
  async readSourcePluginRecordsStrict(sourceId: string): Promise<InstalledPluginRecord[]> {
    const referenceScan = await scanPluginSourceReferences(this.layout)
    if (referenceScan.unreadablePluginIds.length > 0) {
      throw new Error(
        `存在无法读取 install.json 的插件目录，不能安全修改 Source ${sourceId}：${referenceScan.unreadablePluginIds.join(', ')}`,
      )
    }
    const references = referenceScan.references.filter(item => item.sourceId === sourceId)
    const records: InstalledPluginRecord[] = []
    for (const reference of references) {
      try {
        records.push(await readInstalledPlugin(this.layout, reference.pluginId))
      } catch (error) {
        throw new Error(`插件 ${reference.pluginId} 的状态或扫描缓存损坏，不能安全修改 Source ${sourceId}：${String(error)}`)
      }
    }
    return records.sort((left, right) => left.install.pluginId.localeCompare(right.install.pluginId))
  }

}
