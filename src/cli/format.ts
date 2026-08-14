import type {
  PluginInspection,
  PluginListEntry,
  SourceInspection,
  SourceListEntry,
} from '../manager/manager.js'
import type { InstallSource } from '../types/source.js'

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - [...value].length))
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '(无)'
  const widths = headers.map((header, index) => Math.max(
    [...header].length,
    ...rows.map(row => [...(row[index] ?? '')].length),
  ))
  return [headers, ...rows]
    .map(row => row.map((value, index) => pad(value, widths[index] ?? 0)).join('  '))
    .join('\n')
}

function describeOrigin(origin: InstallSource): string[] {
  if (origin.type === 'directory') {
    return [
      `类型: directory`,
      `位置: ${origin.path}`,
      ...(origin.contentHash === undefined ? [] : [`内容 SHA-256: ${origin.contentHash}`]),
    ]
  }
  if (origin.type === 'archive') {
    return [
      `类型: archive`,
      `位置: ${origin.path}`,
      ...(origin.sha256 === undefined ? [] : [`SHA-256: ${origin.sha256}`]),
    ]
  }
  return [
    `类型: git`,
    `URL: ${origin.url}`,
    ...(origin.ref === undefined ? [] : [`Ref: ${origin.ref}`]),
    ...(origin.commit === undefined ? [] : [`Commit: ${origin.commit}`]),
  ]
}

function formatDiagnostics(items: readonly {
  level: string
  code: string
  file?: string
  message: string
}[]): string {
  return items.length === 0
    ? '  无'
    : items
        .map(item => `  ${item.level.toUpperCase()} ${item.code}${item.file ? ` (${item.file})` : ''}\n    ${item.message}`)
        .join('\n')
}

export function formatList(entries: PluginListEntry[]): string {
  const rows = entries.map(item => [
    item.id,
    item.sourceId,
    item.enabled ? '是' : '否',
    item.runtimeStatus,
    String(item.skills),
    String(item.mcpServers),
    String(item.hooks),
    `${item.errors}/${item.warnings}`,
  ])
  return table(['PLUGIN', 'SOURCE', 'ENABLED', 'STATUS', 'SKILL', 'MCP', 'HOOK', 'E/W'], rows)
}

export function formatSourceList(entries: SourceListEntry[]): string {
  const rows = entries.map(item => [
    item.id,
    item.ownership,
    item.originType,
    item.formats.join(',') || '-',
    String(item.availablePlugins),
    String(item.installedPlugins),
    `${item.errors}/${item.warnings}`,
  ])
  return table(['SOURCE', 'OWNERSHIP', 'TYPE', 'FORMATS', 'AVAILABLE', 'INSTALLED', 'E/W'], rows)
}

export function formatInspection(record: PluginInspection): string {
  const plugin = record.scan.plugin
  return [
    `Plugin: ${plugin.id}`,
    `名称: ${plugin.name}`,
    `版本: ${plugin.version ?? '(未声明)'}`,
    `Source: ${record.install.sourceId}`,
    `Source Plugin: ${record.install.sourcePluginId}`,
    `原始目录: ${record.packageRoot}`,
    `格式: ${plugin.formats.join(', ') || '(无法识别)'}`,
    `启用: ${record.state.enabled ? '是' : '否'}`,
    `优先级: ${record.state.priority}`,
    `运行状态: ${record.runtime.status}`,
    '能力:',
    `  Skills: ${plugin.skills.length}`,
    `  MCP: ${plugin.mcpServers.length}`,
    `  Hooks: ${plugin.hooks.length}`,
    `  Commands: ${plugin.commands.length}（仅识别）`,
    `  Agents: ${plugin.agents.length}（仅识别）`,
    '诊断:',
    formatDiagnostics(plugin.diagnostics),
  ].join('\n')
}

export function formatSourceInspection(record: SourceInspection): string {
  const installedBySourcePlugin = new Map(
    record.installedPlugins.map(item => [item.sourcePluginId, item.pluginId] as const),
  )
  const plugins = record.scan.plugins.length === 0
    ? '  无'
    : record.scan.plugins.map(plugin => {
        const installedAs = installedBySourcePlugin.get(plugin.id)
        return [
          `  - ${plugin.id}${plugin.displayName ? ` (${plugin.displayName})` : ''}`,
          `    格式: ${plugin.formats.join(', ') || '-'}`,
          `    位置: ${plugin.location.type === 'source-path' ? plugin.location.path : plugin.location.type}`,
          `    可安装: ${plugin.installable ? '是' : '否'}${installedAs ? `；已安装为 ${installedAs}` : ''}`,
        ].join('\n')
      }).join('\n')
  return [
    `Source: ${record.source.id}`,
    `名称: ${record.source.name ?? '(未声明)'}`,
    `归属: ${record.source.ownership}`,
    `Revision: ${record.source.revision}`,
    ...describeOrigin(record.source.origin),
    `发现方式: ${record.scan.discovery}`,
    `格式: ${record.scan.formats.join(', ') || '(未识别)'}`,
    `Marketplace: ${record.scan.marketplaceFiles.join(', ') || '(无)'}`,
    `已安装 Plugin: ${record.installedPlugins.map(item => item.pluginId).join(', ') || '(无)'}`,
    ...(record.unreadablePluginIds.length === 0
      ? []
      : [`无法读取归属的安装目录: ${record.unreadablePluginIds.join(', ')}`]),
    '可用 Plugin:',
    plugins,
    '诊断:',
    formatDiagnostics(record.scan.diagnostics),
  ].join('\n')
}
