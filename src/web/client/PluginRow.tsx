import { useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconLoadingOutlineRegular, IconTrashOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompatWebCategory, CompatWebDiagnostic, CompatWebPlugin, CompatWebUpdateInfo } from '../../types/web.js'
import type { PendingAction, ResolveText, RowError } from './types.js'
import type { PluginBridgeLocaleKey } from './locales.js'
import { displayName, formatLabel, type Translate } from './panel-model.js'
import css from './PluginBridgePanel.module.css'

const STATUS_KEYS = {
  disabled: 'statusDisabled', starting: 'statusStarting', running: 'statusRunning', degraded: 'statusDegraded',
  failed: 'statusFailed', stopping: 'statusStopping', 'pending-restart': 'statusPendingRestart',
} satisfies Record<CompatWebPlugin['runtimeStatus'], PluginBridgeLocaleKey>
type DiagnosticItem = CompatWebPlugin['diagnostics'][number]

/** 复制给用户的诊断必须包含稳定代码、位置和详情，且不丢失未知字段。 */
function diagnosticText(item: DiagnosticItem, capability: string): string {
  const lines = [`[${item.level}] ${item.code}`, `能力：${capability}`, `消息：${item.message}`]
  if (item.file !== undefined) lines.push(`文件：${item.file}`)
  if (item.details !== undefined) lines.push(`详情：${item.details}`)
  return lines.join('\n')
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('copy unavailable')
}

const CAPABILITY_KEYS = {
  source: 'capabilitySource', plugin: 'capabilityPlugin', skill: 'capabilitySkill', mcp: 'capabilityMcp',
  hook: 'capabilityHook', command: 'capabilityCommand', agent: 'capabilityAgent',
} satisfies Record<CompatWebDiagnostic['capability'], PluginBridgeLocaleKey>

interface PluginRowProps {
  plugin: CompatWebPlugin
  categories: readonly CompatWebCategory[]
  resolveText: ResolveText
  updateInfo?: CompatWebUpdateInfo
  pending: PendingAction
  error: RowError | null
  busy: boolean
  expanded: boolean
  onExpand(): void
  onToggle(): void
  onUpdate(): void
  onRemove(): void
  t: Translate
}

/** One management row owns presentation only; commands and request state live above it. */
export function PluginRow({ plugin, categories, resolveText, updateInfo, pending, error, busy, expanded, onExpand, onToggle, onUpdate, onRemove, t }: PluginRowProps) {
  const name = displayName(plugin)
  const rowPending = pending?.pluginId === plugin.id
  const transitioning = plugin.runtimeStatus === 'starting' || plugin.runtimeStatus === 'stopping'
  const diagnosticsId = `plugin-bridge-diagnostics-${encodeURIComponent(plugin.id)}`
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async (items: readonly DiagnosticItem[]) => {
    try {
      await copyText(items.map(item => diagnosticText(item, t(CAPABILITY_KEYS[item.capability]))).join('\n\n'))
      setCopyState('copied')
    } catch { setCopyState('failed') }
  }
  const capabilities = [
    plugin.skills > 0 ? t('skillCount', { count: plugin.skills }) : undefined,
    plugin.mcpServers > 0 ? t('mcpCount', { count: plugin.mcpServers }) : undefined,
    plugin.hooks > 0 ? t('hookCount', { count: plugin.hooks }) : undefined,
  ].filter(Boolean)
  return (
    <li className={css.pluginRow} data-plugin-id={plugin.id} data-open={expanded || undefined} aria-busy={rowPending}>
      <div className={css.pluginMain}>
        <div className={css.pluginInfo}>
          <div className={css.pluginTitleLine}>
            <strong title={name}>{name}</strong>
            {plugin.version !== undefined ? <span className={css.version}>{t('version', { version: plugin.version })}</span> : null}
          </div>
          <div className={css.pluginMeta}>
            {plugin.formats.map(format => <span key={format} className={css.tag}>{formatLabel(format, categories, resolveText)}</span>)}
            <code>{plugin.id}</code>
          </div>
          <div className={css.sourceLine}>{t('source', { source: plugin.sourceId })}</div>
          <div className={css.capabilities}>
            <span>{capabilities.length > 0 ? capabilities.join(' · ') : t('otherCapabilities')}</span>
            {plugin.diagnostics.length > 0 ? (
              <button type="button" className={css.diagnosticToggle} aria-expanded={expanded} aria-controls={diagnosticsId}
                aria-label={t(expanded ? 'hideDiagnostics' : 'showDiagnostics', { name })} onClick={onExpand}>
                {plugin.errors > 0 ? <span className={css.errorText}>{t('errorCount', { count: plugin.errors })}</span> : null}
                {plugin.warnings > 0 ? <span className={css.warningText}>{t('warningCount', { count: plugin.warnings })}</span> : null}
                <IconChevronDownOutlineRegular className={css.diagnosticChevron} size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {updateInfo?.error ? <p className={css.rowWarning}>{t('sourceCheckFailed', { message: updateInfo.error })}</p> : null}
        </div>
        <div className={css.pluginActions}>
          <span className={css.runtimeStatus} data-status={plugin.runtimeStatus} role={rowPending ? 'status' : undefined}>
            {rowPending || transitioning ? <IconLoadingOutlineRegular className={css.spinner} size={14} /> : <span className={css.statusDot} aria-hidden="true" />}
            <span>{rowPending && pending?.kind === 'toggle' ? t(plugin.enabled ? 'disabling' : 'enabling') : t(STATUS_KEYS[plugin.runtimeStatus])}</span>
          </span>
          <div className={css.rowControls}>
            {updateInfo?.available === true ? (
              <Button variant="outline" size="sm" className={css.updateButton} aria-label={t('updateTitle', { name })}
                disabled={busy || transitioning} onClick={onUpdate}>
                {t(rowPending && pending?.kind === 'update' ? 'updating' : 'updateAction')}
              </Button>
            ) : null}
            <Switch className={css.pluginSwitch} checked={plugin.enabled}
              label={t(plugin.enabled ? 'disable' : 'enable', { name })} disabled={busy || transitioning} onChange={onToggle} />
            <button type="button" className={css.trashButton} aria-label={t('uninstall', { name })} title={t('uninstall', { name })}
              disabled={busy || transitioning} onClick={onRemove}><IconTrashOutlineRegular size={16} /></button>
          </div>
        </div>
      </div>
      {error?.pluginId === plugin.id ? <p className={css.rowError} role="alert">{t('operationFailed', { message: error.message })}</p> : null}
      {expanded ? (
        <div id={diagnosticsId} className={css.diagnosticsPanel} role="region" aria-label={t('diagnosticsFor', { name })}>
          <div className={css.diagnosticsHeader}>
            <p className={css.diagnosticsIntro}>{t('diagnosticsIntro')}</p>
            <button type="button" className={css.textButton} onClick={() => { void copy(plugin.diagnostics) }}>{t('copyAllDiagnostics')}</button>
          </div>
          {copyState === 'copied' ? <p className={css.copyFeedback} role="status">{t('copied')}</p> : null}
          {copyState === 'failed' ? <p className={css.copyFeedback} role="alert">{t('copyFailed')}</p> : null}
          <ul className={css.diagnosticList}>{plugin.diagnostics.map((item, index) => (
            <li key={`${item.code}:${item.file ?? ''}:${index}`} className={css.diagnosticItem}>
              <div className={css.diagnosticMessage}>
                <span className={item.level === 'error' ? css.errorText : css.warningText}>{t(item.level === 'error' ? 'levelError' : 'levelWarning')}</span>
                <span className={css.diagnosticText}>{item.message}</span>
              </div>
              <div className={css.diagnosticMeta}><code>{item.code}</code><span>{t(CAPABILITY_KEYS[item.capability])}</span>
                {item.file !== undefined ? <span>{t('diagnosticFile', { file: item.file })}</span> : null}
                <button type="button" className={css.copyButton} onClick={() => { void copy([item]) }}>{t('copyDiagnostic')}</button></div>
              {item.details !== undefined ? <pre className={css.diagnosticDetails}>{t('diagnosticDetails', { details: item.details })}</pre> : null}
            </li>
          ))}</ul>
        </div>
      ) : null}
    </li>
  )
}
