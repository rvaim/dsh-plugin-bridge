import { useMemo, useRef, useState } from 'react'
import { Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompatWebPlugin } from '../../types/web.js'
import type { PluginBridgeLocaleKey } from './locales.js'
import type { PluginBridgeInjected } from './types.js'
import { AddPluginDialog } from './AddPluginDialog.js'
import { PluginActionDialog, type ConfirmAction } from './PluginActionDialog.js'
import { PluginRow } from './PluginRow.js'
import { usePluginBridge } from './usePluginBridge.js'
import { filterPlugins, needsAttention, type PluginFilter } from './panel-model.js'
import css from './PluginBridgePanel.module.css'

export type PluginBridgePanelProps = PropsRuntime<'main'> & PropsLocale<'pluginBridge'> & InjectFace<PluginBridgeInjected>

/** Native DSH management: clear state, searchable rows, protected multi-plugin actions. */
export function PluginBridgePanel({ t, ...api }: PluginBridgePanelProps) {
  const state = usePluginBridge(api)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const plugins = state.view.status === 'ready' ? state.view.plugins : []
  const visible = useMemo(() => filterPlugins(plugins, query, filter, state.updateState), [plugins, query, filter, state.updateState])
  const running = plugins.filter(plugin => plugin.runtimeStatus === 'running').length
  const attention = plugins.filter(plugin => needsAttention(plugin, state.updateState[plugin.id])).length
  const busy = state.pending !== null
  const filtered = query.trim() !== '' || filter !== 'all'
  const clearFilters = () => { setQuery(''); setFilter('all') }

  const requestUpdate = (plugin: CompatWebPlugin) => {
    const info = state.updateState[plugin.id]
    if (info === undefined || !info.available) return
    if (info.sharedSource) { state.clearMutationError(); setConfirmation({ kind: 'update', plugin, affectedPluginIds: info.affectedPluginIds }) }
    else void state.updatePlugin(plugin, false)
  }
  const confirmAction = async () => {
    if (confirmation === null || busy) return
    const target = confirmation
    const success = target.kind === 'remove'
      ? await state.removePlugin(target.plugin)
      : await state.updatePlugin(target.plugin, true)
    if (success) {
      setConfirmation(null)
      // The confirmed row/action may have disappeared. Choose a connected control.
      requestAnimationFrame(() => {
        const row = [...panel.current?.querySelectorAll<HTMLElement>('[data-plugin-id]') ?? []]
          .find(element => element.dataset.pluginId === target.plugin.id)
        ;(row?.querySelector<HTMLButtonElement>('[role="switch"]') ?? addButton.current)?.focus()
      })
    }
  }

  return (
    <section ref={panel} className={css.panel} aria-label={t('title')}>
      <header className={css.headingRow} data-window-drag>
        <div className={css.headingCopy}><h1>{t('title')}</h1><p>{t('intro')}</p></div>
        <div className={css.headingActions}>
          <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')}
            disabled={busy || state.refreshing || state.checkingUpdates || state.view.status === 'loading'}
            onClick={() => { void state.refresh() }}>
            {state.refreshing || state.checkingUpdates ? <IconLoadingOutlineRegular className={css.spinner} size={16} /> : <IconRefreshOutlineRegular size={16} />}
          </button>
          <Button ref={addButton} variant="primary" size="sm" icon={<IconPlusOutlineRegular size={14} />} data-plugin-bridge-add
            disabled={busy || state.view.status !== 'ready'} onClick={() => { setAddOpen(true) }}>{t('add')}</Button>
        </div>
      </header>

      {state.view.status === 'loading' ? (
        <div className={css.loadingState} role="status" aria-label={t('loading')}>
          <span className={css.skeletonTitle} /><span className={css.skeletonLine} /><span className={css.skeletonLine} />
          <span className={css.srOnly}>{t('loading')}</span>
        </div>
      ) : null}
      {state.view.status === 'error' ? <div className={css.errorState} role="alert">
        <div><strong>{t('listError')}</strong><p>{state.view.message}</p></div>
        <Button variant="outline" size="sm" onClick={() => { void state.refresh() }}>{t('retry')}</Button>
      </div> : null}
      {state.view.status === 'ready' ? (
        <>
          <div className={css.collectionHeader}>
            <p>{t('collectionSummary', { total: plugins.length, running, attention })}</p>
            <span className={css.checkStatus} role="status">
              {state.checkingUpdates ? t('checkingUpdates') : state.refreshing ? t('refreshingList') : ''}
            </span>
          </div>
          {state.listError !== null ? <div className={css.inlineNotice} role="alert"><p>{t('refreshError', { message: state.listError })}</p>
            <Button variant="outline" size="sm" disabled={state.refreshing || busy} onClick={() => { void state.refresh() }}>{t('retry')}</Button></div> : null}
          {state.updateError !== null ? <div className={css.inlineNotice} role="alert"><p>{t('updateCheckError', { message: state.updateError })}</p>
            <Button variant="outline" size="sm" disabled={state.checkingUpdates || busy} onClick={() => { void state.retryUpdates() }}>{t('retryCheck')}</Button></div> : null}
          {plugins.length > 0 ? (
            <>
              <div className={css.listToolbar}>
                <div className={css.searchField}>
                  <Input icon={<IconSearchOutlineRegular size={16} />} type="search" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')}
                    value={query} onChange={event => { setQuery(event.currentTarget.value) }} />
                  {query !== '' ? <button type="button" className={css.clearSearch} aria-label={t('clearSearch')} onClick={() => { setQuery('') }}><IconCloseOutlineRegular size={14} /></button> : null}
                </div>
                <label className={css.filterField}>
                  <span className={css.srOnly}>{t('filterLabel')}</span>
                  <select value={filter} onChange={event => { setFilter(event.currentTarget.value as PluginFilter) }}>
                    <option value="all">{t('filterAll')}</option><option value="enabled">{t('filterEnabled')}</option>
                    <option value="disabled">{t('filterDisabled')}</option><option value="attention">{t('filterAttention')}</option>
                    <option value="updates">{t('filterUpdates')}</option>
                  </select>
                </label>
              </div>
              {filtered ? <div className={css.filterSummary}>
                <span role="status">{t('resultCount', { count: visible.length, total: plugins.length })}</span>
                <button type="button" className={css.textButton} onClick={clearFilters}>{t('clearFilters')}</button>
              </div> : null}
              {visible.length === 0 ? <div className={css.emptyState}><strong>{t('noResultsTitle')}</strong><p>{t('noResultsDescription')}</p>
                <Button variant="outline" size="sm" onClick={clearFilters}>{t('clearFilters')}</Button></div>
                : <ul className={css.pluginList} aria-label={t('pluginListLabel')}>
                  {visible.map(plugin => <PluginRow key={plugin.id} plugin={plugin} updateInfo={state.updateState[plugin.id]}
                    pending={state.pending} error={state.mutationError} busy={busy} expanded={expanded === plugin.id}
                    onExpand={() => { setExpanded(current => current === plugin.id ? null : plugin.id) }}
                    onToggle={() => { void state.togglePlugin(plugin) }} onUpdate={() => { requestUpdate(plugin) }}
                    onRemove={() => { state.clearMutationError(); setConfirmation({ kind: 'remove', plugin }) }} t={t} />)}
                </ul>}
            </>
          ) : <div className={css.emptyState}><strong>{t('emptyTitle')}</strong><p>{t('emptyDescription')}</p>
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={14} />} data-plugin-bridge-add onClick={() => { setAddOpen(true) }}>{t('add')}</Button></div>}
        </>
      ) : null}
      {addOpen ? <AddPluginDialog api={api} t={t} onClose={() => { setAddOpen(false) }} onInstalled={installed => { clearFilters(); state.acceptInstalled(installed) }} /> : null}
      {confirmation !== null ? <PluginActionDialog action={confirmation} plugins={plugins} pending={busy}
        error={state.mutationError?.pluginId === confirmation.plugin.id ? state.mutationError.message : undefined}
        onClose={() => { if (!busy) setConfirmation(null) }} onConfirm={() => { void confirmAction() }} t={t} /> : null}
      {state.toast !== null ? <Toast key={state.toast.id} text={t(state.toast.key, state.toast.values)} onDone={() => { state.dismissToast(state.toast?.id) }} /> : null}
    </section>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { pluginBridge: PluginBridgeLocaleKey }
}
