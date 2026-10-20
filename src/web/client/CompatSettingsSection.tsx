import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CompatWebAddResult,
  CompatWebCancelAddResult,
  CompatWebCandidate,
  CompatWebCheckUpdatesResult,
  CompatWebDiagnostic,
  CompatWebListResult,
  CompatWebPlugin,
  CompatWebSetEnabledResult,
  CompatWebUninstallResult,
  CompatWebUpdateInfo,
  CompatWebUpdateResult,
} from '../../types/web.js'
import type { CompatSettingsLocaleKey } from './locales.js'
import css from './CompatSettingsSection.module.css'

/** Browser operations supplied by the plugin registration. */
export interface CompatSettingsInjected {
  list: () => Promise<CompatWebListResult>
  checkUpdates: () => Promise<CompatWebCheckUpdatesResult>
  update: (pluginId: string, confirmShared: boolean) => Promise<CompatWebUpdateResult>
  beginAdd: (source: string) => Promise<CompatWebAddResult>
  completeAdd: (requestId: string, plugins: string[]) => Promise<CompatWebAddResult>
  cancelAdd: (requestId: string) => Promise<CompatWebCancelAddResult>
  setEnabled: (pluginId: string, enabled: boolean) => Promise<CompatWebSetEnabledResult>
  uninstall: (pluginId: string) => Promise<CompatWebUninstallResult>
}

export type CompatSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginBridge'>
  & InjectFace<CompatSettingsInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; plugins: CompatWebPlugin[] }

type PendingAction = { pluginId: string; kind: 'toggle' | 'uninstall' | 'update' } | null

type AddPendingAction = 'fetch' | 'install' | 'cancel' | null

type ToastState = { id: number; text: string } | null

type CandidateSelection = {
  requestId: string
  candidates: CompatWebCandidate[]
}

const STATUS_KEYS = {
  disabled: 'statusDisabled',
  starting: 'statusStarting',
  running: 'statusRunning',
  degraded: 'statusDegraded',
  failed: 'statusFailed',
  stopping: 'statusStopping',
  'pending-restart': 'statusPendingRestart',
} satisfies Record<CompatWebPlugin['runtimeStatus'], CompatSettingsLocaleKey>

const CAPABILITY_KEYS = {
  source: 'capabilitySource',
  plugin: 'capabilityPlugin',
  skill: 'capabilitySkill',
  mcp: 'capabilityMcp',
  hook: 'capabilityHook',
  command: 'capabilityCommand',
  agent: 'capabilityAgent',
} satisfies Record<CompatWebDiagnostic['capability'], CompatSettingsLocaleKey>

function displayName(plugin: Pick<CompatWebPlugin, 'id' | 'name'>): string {
  return plugin.name.trim() === '' ? plugin.id : plugin.name
}

function mergePlugins(current: CompatWebPlugin[], installed: CompatWebPlugin[]): CompatWebPlugin[] {
  const byId = new Map(current.map(plugin => [plugin.id, plugin]))
  for (const plugin of installed) byId.set(plugin.id, plugin)
  return [...byId.values()].sort((left, right) =>
    left.priority - right.priority || left.id.localeCompare(right.id))
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Native DSH settings section for external plugin lifecycle management. */
export function CompatSettingsSection({
  list,
  checkUpdates,
  update,
  beginAdd,
  completeAdd,
  cancelAdd,
  setEnabled,
  uninstall,
  t,
}: CompatSettingsSectionProps) {
  const generation = useRef(0)
  const toastSequence = useRef(0)
  const selectionRequest = useRef<string | null>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [updateState, setUpdateState] = useState<Record<string, CompatWebUpdateInfo>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState<PendingAction>(null)
  const [toast, setToast] = useState<ToastState>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [source, setSource] = useState('')
  const [selection, setSelection] = useState<CandidateSelection | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [addPending, setAddPending] = useState<AddPendingAction>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<CompatWebPlugin | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [expandedDiagnostics, setExpandedDiagnostics] = useState<string | null>(null)

  const showToast = useCallback((text: string) => {
    toastSequence.current += 1
    setToast({ id: toastSequence.current, text })
  }, [])

  const invalidateLoad = useCallback(() => {
    generation.current += 1
    setRefreshing(false)
  }, [])

  const restoreDialogFocus = useCallback(() => {
    const previous = dialogTrigger.current
    dialogTrigger.current = null
    queueMicrotask(() => {
      const fallback = document.querySelector<HTMLButtonElement>('[data-plugin-bridge-add]')
      const target = previous?.isConnected === true ? previous : fallback
      target?.focus()
    })
  }, [])

  const load = useCallback(async (preserve: boolean) => {
    const request = ++generation.current
    if (preserve) setRefreshing(true)
    else setView({ status: 'loading' })
    try {
      const [result, updates] = await Promise.all([
        list(),
        checkUpdates().catch((error): CompatWebCheckUpdatesResult => ({
          kind: 'error',
          message: failureMessage(error),
        })),
      ])
      if (request !== generation.current) return
      if (result.kind === 'ready') setView({ status: 'ready', plugins: result.plugins })
      else if (preserve) showToast(t('operationFailed', { message: result.message }))
      else setView({ status: 'error', message: result.message })
      setUpdateState(updates.kind === 'ready'
        ? Object.fromEntries(updates.updates.map(item => [item.pluginId, item]))
        : {})
    } catch (error) {
      if (request !== generation.current) return
      const message = failureMessage(error)
      if (preserve) showToast(t('operationFailed', { message }))
      else setView({ status: 'error', message })
    } finally {
      if (request === generation.current) setRefreshing(false)
    }
  }, [list, checkUpdates, showToast, t])

  useEffect(() => {
    void load(false)
    return () => { generation.current += 1 }
  }, [load])

  const openAdd = useCallback((trigger: HTMLButtonElement) => {
    dialogTrigger.current = trigger
    setSource('')
    setSelection(null)
    selectionRequest.current = null
    setSelected(new Set())
    setAddError(null)
    setAddOpen(true)
  }, [])

  const closeAdd = useCallback(async () => {
    if (addPending !== null) return
    const requestId = selectionRequest.current
    if (requestId !== null) {
      setAddPending('cancel')
      setAddError(null)
      try {
        const result = await cancelAdd(requestId)
        if (result.kind === 'error') {
          setAddError(result.message)
          return
        }
      } catch (error) {
        setAddError(failureMessage(error))
        return
      } finally {
        setAddPending(null)
      }
    }
    selectionRequest.current = null
    setSelection(null)
    setAddOpen(false)
    restoreDialogFocus()
  }, [addPending, cancelAdd, restoreDialogFocus])

  const closeRemove = useCallback(() => {
    if (pending?.kind === 'uninstall') return
    setRemoveError(null)
    setRemoveTarget(null)
    restoreDialogFocus()
  }, [pending, restoreDialogFocus])

  useEffect(() => () => {
    const requestId = selectionRequest.current
    if (requestId !== null) void cancelAdd(requestId).catch(() => undefined)
  }, [cancelAdd])

  useEffect(() => {
    if (!addOpen && removeTarget === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (addOpen) void closeAdd()
        else closeRemove()
        return
      }
      if (event.key !== 'Tab') return
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      const dialog = dialogs.item(dialogs.length - 1)
      if (dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [addOpen, closeAdd, closeRemove, removeTarget])

  const install = async (plugins: string[]) => {
    const trimmed = source.trim()
    if (trimmed === '') return
    if (selection !== null && plugins.length === 0) {
      setAddError(t('noSelection'))
      return
    }
    invalidateLoad()
    setAddPending(selection === null ? 'fetch' : 'install')
    setAddError(null)
    let installed = false
    try {
      const result = selection === null
        ? await beginAdd(trimmed)
        : await completeAdd(selection.requestId, plugins)
      if (result.kind === 'error') {
        setAddError(result.message)
        return
      }
      if (result.kind === 'selection') {
        selectionRequest.current = result.requestId
        setSelection({ requestId: result.requestId, candidates: result.candidates })
        setSelected(new Set())
        return
      }
      selectionRequest.current = null
      setSelection(null)
      setView(current => current.status === 'ready'
        ? { status: 'ready', plugins: mergePlugins(current.plugins, result.plugins) }
        : { status: 'ready', plugins: result.plugins })
      setAddOpen(false)
      installed = true
      const first = result.plugins[0]
      showToast(result.plugins.length === 1 && first !== undefined
        ? t('installedOne', { name: displayName(first) })
        : t('installedMany', { count: result.plugins.length }))
    } catch (error) {
      setAddError(failureMessage(error))
    } finally {
      setAddPending(null)
      if (installed) restoreDialogFocus()
    }
  }

  const togglePlugin = async (plugin: CompatWebPlugin) => {
    const enabled = !plugin.enabled
    invalidateLoad()
    setPending({ pluginId: plugin.id, kind: 'toggle' })
    try {
      const result = await setEnabled(plugin.id, enabled)
      if (result.kind === 'error') {
        showToast(t('operationFailed', { message: result.message }))
        return
      }
      setView(current => current.status === 'ready'
        ? {
            status: 'ready',
            plugins: current.plugins.map(item => item.id === result.plugin.id ? result.plugin : item),
          }
        : current)
      showToast(t(enabled ? 'enabledToast' : 'disabledToast', { name: displayName(result.plugin) }))
    } catch (error) {
      showToast(t('operationFailed', { message: failureMessage(error) }))
    } finally {
      setPending(null)
    }
  }

  const updatePlugin = async (plugin: CompatWebPlugin) => {
    const info = updateState[plugin.id]
    if (info === undefined || !info.available) return
    invalidateLoad()
    setPending({ pluginId: plugin.id, kind: 'update' })
    try {
      const result = await update(plugin.id, true)
      if (result.kind === 'error') {
        showToast(t('operationFailed', { message: result.message }))
        return
      }
      setView(current => current.status === 'ready'
        ? { status: 'ready', plugins: mergePlugins(current.plugins, result.plugins) }
        : { status: 'ready', plugins: result.plugins })
      setUpdateState(current => {
        const next = { ...current }
        for (const pluginId of result.affectedPluginIds) {
          const existing = next[pluginId]
          if (existing === undefined) continue
          next[pluginId] = { ...existing, available: false, affectedPluginIds: [] }
        }
        return next
      })
      showToast(t('updatedToast', { name: displayName(plugin) }))
    } catch (error) {
      showToast(t('operationFailed', { message: failureMessage(error) }))
    } finally {
      setPending(null)
    }
  }

  const removePlugin = async () => {
    if (removeTarget === null) return
    invalidateLoad()
    setPending({ pluginId: removeTarget.id, kind: 'uninstall' })
    setRemoveError(null)
    let removed = false
    try {
      const result = await uninstall(removeTarget.id)
      if (result.kind === 'error') {
        setRemoveError(result.message)
        return
      }
      setView(current => current.status === 'ready'
        ? { status: 'ready', plugins: current.plugins.filter(item => item.id !== result.pluginId) }
        : current)
      showToast(t('removedToast', { name: displayName(removeTarget) }))
      setRemoveTarget(null)
      removed = true
    } catch (error) {
      setRemoveError(failureMessage(error))
    } finally {
      setPending(null)
      if (removed) restoreDialogFocus()
    }
  }

  const selectedIds = useMemo(() => [...selected], [selected])
  const selectableCandidates = useMemo(
    () => selection?.candidates.filter(candidate => candidate.installable && candidate.errors === 0) ?? [],
    [selection],
  )

  return (
    <section
      className={css.section}
      aria-busy={view.status === 'loading' || refreshing || addPending !== null || pending !== null}
    >
      <div className={css.headingRow}>
        <div className={css.headingCopy}>
          <h2>{t('title')}</h2>
          <p>{t('intro')}</p>
        </div>
        <div className={css.headingActions}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={pending !== null || refreshing || view.status === 'loading'}
            onClick={() => { void load(true) }}
          >
            {refreshing
              ? <IconLoadingOutline16 className={css.spinner} size={16} />
              : <IconRefreshOutline16 size={16} />}
          </button>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutline16 size={14} />}
            data-plugin-bridge-add
            disabled={pending !== null || refreshing || view.status === 'loading'}
            onClick={(event) => { openAdd(event.currentTarget) }}
          >
            {t('add')}
          </Button>
        </div>
      </div>

      {view.status === 'loading' ? (
        <div className={css.loadingState} role="status">
          <IconLoadingOutline16 className={css.spinner} size={16} />
          <span>{t('loading')}</span>
        </div>
      ) : null}

      {view.status === 'error' ? (
        <div className={css.errorState} role="alert">
          <div>
            <strong>{t('listError')}</strong>
            <p>{view.message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { void load(false) }}>{t('retry')}</Button>
        </div>
      ) : null}

      {view.status === 'ready' && view.plugins.length === 0 ? (
        <div className={css.emptyState}>
          <strong>{t('emptyTitle')}</strong>
          <p>{t('emptyDescription')}</p>
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutline16 size={14} />}
            data-plugin-bridge-add
            disabled={refreshing}
            onClick={(event) => { openAdd(event.currentTarget) }}
          >
            {t('add')}
          </Button>
        </div>
      ) : null}

      {view.status === 'ready' && view.plugins.length > 0 ? (
        <ul className={css.pluginList}>
          {view.plugins.map((plugin) => {
            const name = displayName(plugin)
            const rowPending = pending?.pluginId === plugin.id
            const updateInfo = updateState[plugin.id]
            const controlsBusy = pending !== null || refreshing
            const diagnosticsOpen = expandedDiagnostics === plugin.id
            const diagnosticsId = `plugin-bridge-diagnostics-${encodeURIComponent(plugin.id)}`
            const capabilities = [
              plugin.skills > 0 ? t('skillCount', { count: plugin.skills }) : undefined,
              plugin.mcpServers > 0 ? t('mcpCount', { count: plugin.mcpServers }) : undefined,
              plugin.hooks > 0 ? t('hookCount', { count: plugin.hooks }) : undefined,
            ].filter((item): item is string => item !== undefined)
            return (
              <li
                key={plugin.id}
                className={css.pluginRow}
                data-plugin-id={plugin.id}
                data-open={diagnosticsOpen || undefined}
              >
                <div className={css.pluginMain}>
                  <div className={css.pluginInfo}>
                    <div className={css.pluginTitleLine}>
                      <strong title={plugin.name}>{name}</strong>
                      {plugin.version !== undefined ? <span className={css.tag}>{t('version', { version: plugin.version })}</span> : null}
                      {plugin.formats.map(format => (
                        <span key={format} className={css.tag}>
                          {format === 'agent-plugins' ? t('formatAgentPlugins') : format === 'codex' ? t('formatCodex') : format === 'claude-code' ? t('formatClaude') : format}
                        </span>
                      ))}
                    </div>
                    <div className={css.pluginMeta}>
                      <code>{plugin.id}</code>
                      <span>{t('source', { source: plugin.sourceId })}</span>
                    </div>
                    <div className={css.capabilities}>
                      <span>{capabilities.length > 0 ? capabilities.join(' · ') : t('otherCapabilities')}</span>
                      {plugin.diagnostics.length > 0 ? (
                        <button
                          type="button"
                          className={css.diagnosticToggle}
                          aria-expanded={diagnosticsOpen}
                          aria-controls={diagnosticsId}
                          aria-label={t(diagnosticsOpen ? 'hideDiagnostics' : 'showDiagnostics', { name })}
                          onClick={() => {
                            setExpandedDiagnostics(current => current === plugin.id ? null : plugin.id)
                          }}
                        >
                          <span className={css.diagnosticSeparator} aria-hidden="true">·</span>
                          {plugin.errors > 0 ? <span className={css.errorText}>{t('errorCount', { count: plugin.errors })}</span> : null}
                          {plugin.warnings > 0 ? <span className={css.warningText}>{t('warningCount', { count: plugin.warnings })}</span> : null}
                          <IconChevronDownOutline14 className={css.diagnosticChevron} size={12} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className={css.pluginActions}>
                    <span className={css.runtimeStatus} data-status={plugin.runtimeStatus}>
                      {rowPending && pending?.kind === 'toggle'
                        ? <IconLoadingOutline16 className={css.spinner} size={14} />
                        : <span className={css.statusDot} aria-hidden="true" />}
                      <span>{t(STATUS_KEYS[plugin.runtimeStatus])}</span>
                    </span>
                    {updateInfo?.available === true ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className={css.updateButton}
                        aria-label={t('updateTitle', { name })}
                        title={updateInfo.sharedSource
                          ? t('updateSharedTitle', { name, count: updateInfo.affectedPluginIds.length })
                          : t('updateTitle', { name })}
                        disabled={controlsBusy}
                        icon={rowPending && pending?.kind === 'update'
                          ? <IconLoadingOutline16 className={css.spinner} size={14} />
                          : undefined}
                        onClick={() => { void updatePlugin(plugin) }}
                      >
                        {t(rowPending && pending?.kind === 'update' ? 'updating' : 'updateAction')}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      className={css.switch}
                      role="switch"
                      aria-checked={plugin.enabled}
                      aria-label={t(plugin.enabled ? 'disable' : 'enable', { name })}
                      disabled={controlsBusy}
                      onClick={() => { void togglePlugin(plugin) }}
                    >
                      <span className={css.switchThumb} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={css.trashButton}
                      aria-label={t('uninstall', { name })}
                      title={t('uninstall', { name })}
                      disabled={controlsBusy}
                      onClick={(event) => {
                        dialogTrigger.current = event.currentTarget
                        setRemoveError(null)
                        setRemoveTarget(plugin)
                      }}
                    >
                      {rowPending && pending?.kind === 'uninstall'
                        ? <IconLoadingOutline16 className={css.spinner} size={16} />
                        : <IconTrashOutline16 size={16} />}
                    </button>
                  </div>
                </div>
                {diagnosticsOpen ? (
                  <div
                    id={diagnosticsId}
                    className={css.diagnosticsPanel}
                    role="region"
                    aria-label={t('diagnosticsFor', { name })}
                  >
                    <p className={css.diagnosticsIntro}>{t('diagnosticsIntro')}</p>
                    <ul className={css.diagnosticList}>
                      {plugin.diagnostics.map((item, index) => (
                        <li key={`${item.code}:${item.file ?? ''}:${index}`} className={css.diagnosticItem}>
                          <div className={css.diagnosticMessage}>
                            <span className={item.level === 'error' ? css.errorText : css.warningText}>
                              {t(item.level === 'error' ? 'levelError' : 'levelWarning')}
                            </span>
                            <span>{item.message}</span>
                          </div>
                          <div className={css.diagnosticMeta}>
                            <code>{item.code}</code>
                            <span>{t(CAPABILITY_KEYS[item.capability])}</span>
                            {item.file !== undefined ? (
                              <span>{t('diagnosticFile', { file: item.file })}</span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      <Modal
        open={addOpen}
        onClose={() => { void closeAdd() }}
        title={t(selection === null ? 'addTitle' : 'selectingTitle')}
        closeLabel={t('close')}
        description={t(selection === null ? 'addDescription' : 'selectingDescription')}
        className={css.addDialog}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={addPending !== null}
              icon={addPending === 'cancel'
                ? <IconLoadingOutline16 className={css.spinner} size={16} />
                : undefined}
              onClick={() => { void closeAdd() }}
            >
              {t(addPending === 'cancel' ? 'cancelling' : 'cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={addPending !== null || source.trim() === '' || (selection !== null && selectedIds.length === 0)}
              icon={addPending === 'fetch' || addPending === 'install'
                ? <IconLoadingOutline16 className={css.spinner} size={16} />
                : undefined}
              onClick={() => { void install(selection === null ? [] : selectedIds) }}
            >
              {addPending === 'fetch' || addPending === 'install'
                ? t(selection === null ? 'fetching' : 'installing')
                : t(selection === null ? 'fetch' : 'installSelected')}
            </Button>
          </>
        )}
      >
        {selection === null ? (
          <div className={css.sourceForm}>
            <label htmlFor="plugin-bridge-source">{t('addSourceLabel')}</label>
            <Input
              id="plugin-bridge-source"
              className={css.sourceInput}
              value={source}
              placeholder={t('addPlaceholder')}
              autoFocus
              disabled={addPending !== null}
              onChange={(event) => { setSource(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && source.trim() !== '' && addPending === null) {
                  event.preventDefault()
                  void install([])
                }
              }}
            />
            <p className={css.hint}>{t('addHint')}</p>
          </div>
        ) : (
          <div className={css.selection}>
            <div className={css.selectionSummary}>
              <span>{t('selectedCount', { count: selectedIds.length })}</span>
              <span>{t('installableCount', { count: selectableCandidates.length })}</span>
            </div>
            <div className={css.candidateList}>
              {selection.candidates.map((candidate) => {
                const selectable = candidate.installable && candidate.errors === 0
                const checked = selected.has(candidate.id)
                return (
                  <label key={candidate.id} className={css.candidate} data-disabled={!selectable || undefined}>
                    <input
                      type="checkbox"
                      autoFocus={candidate.id === selectableCandidates[0]?.id}
                      checked={checked}
                      disabled={!selectable || addPending !== null}
                      onChange={() => {
                        setSelected((current) => {
                          const next = new Set(current)
                          if (next.has(candidate.id)) next.delete(candidate.id)
                          else next.add(candidate.id)
                          return next
                        })
                        setAddError(null)
                      }}
                    />
                    <span className={css.candidateCopy}>
                      <span className={css.candidateTitle}>
                        <strong>{candidate.displayName ?? candidate.name}</strong>
                        {candidate.version !== undefined ? <span className={css.tag}>{t('version', { version: candidate.version })}</span> : null}
                      </span>
                      <code>{candidate.id}</code>
                      {candidate.description !== undefined ? <span>{candidate.description}</span> : null}
                      <span className={css.candidateMeta}>
                        {candidate.formats.map(format => format === 'agent-plugins' ? t('formatAgentPlugins') : format === 'codex' ? t('formatCodex') : format === 'claude-code' ? t('formatClaude') : format).join(' · ')}
                        {!candidate.installable ? ` · ${t('unavailable')}` : ''}
                        {candidate.errors > 0 ? ` · ${t('candidateErrors', { count: candidate.errors })}` : ''}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
        {addPending !== null ? (
          <div className={css.progress} role="status">
            <IconLoadingOutline16 className={css.spinner} size={14} />
            <span>{t(addPending === 'cancel' ? 'cancelling' : selection === null ? 'fetching' : 'installing')}</span>
          </div>
        ) : null}
        {addError !== null ? <p className={css.formError} role="alert">{addError}</p> : null}
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={closeRemove}
        title={t('uninstallTitle', { name: removeTarget === null ? '' : displayName(removeTarget) })}
        closeLabel={t('close')}
        description={t('uninstallDescription')}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={pending?.kind === 'uninstall'}
              onClick={closeRemove}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={pending?.kind === 'uninstall'}
              icon={pending?.kind === 'uninstall' ? <IconLoadingOutline16 className={css.spinner} size={16} /> : undefined}
              onClick={() => { void removePlugin() }}
            >
              {t(pending?.kind === 'uninstall' ? 'uninstalling' : 'uninstallConfirm')}
            </Button>
          </>
        )}
      >
        {removeError !== null ? <p className={css.formError} role="alert">{removeError}</p> : null}
      </Modal>

      {toast !== null ? (
        <Toast
          key={toast.id}
          text={toast.text}
          onDone={() => { setToast(current => current?.id === toast.id ? null : current) }}
        />
      ) : null}
    </section>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pluginBridge': CompatSettingsLocaleKey
  }
}
