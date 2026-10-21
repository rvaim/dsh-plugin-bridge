import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompatWebCandidate, CompatWebPlugin } from '../../types/web.js'
import type { PluginBridgeInjected } from './types.js'
import { formatLabel, type Translate } from './panel-model.js'
import css from './PluginBridgePanel.module.css'

type AddApi = Pick<PluginBridgeInjected, 'beginAdd' | 'completeAdd' | 'cancelAdd'>
interface AddPluginDialogProps {
  api: AddApi
  t: Translate
  onClose(): void
  onInstalled(plugins: CompatWebPlugin[]): void
}
type Selection = { requestId: string; candidates: CompatWebCandidate[] }
type Progress = 'fetch' | 'install' | 'cancel' | null

/** The prepared Source belongs to this flow until committed or explicitly released. */
export function AddPluginDialog({ api, t, onClose, onInstalled }: AddPluginDialogProps) {
  const [source, setSource] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState<Progress>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<string | null>(null)
  const busy = useRef(false)
  const alive = useRef(true)
  const operations = useRef(api)
  operations.current = api
  const candidates = useRef<HTMLDivElement>(null)
  const sourceInput = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const hintId = useId()
  const errorId = useId()
  const selectable = useMemo(() => selection?.candidates.filter(item => item.installable && item.errors === 0) ?? [], [selection])
  const allSelected = selectable.length > 0 && selectable.every(item => selected.has(item.id))

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const id = request.current
      request.current = null
      if (id !== null) void operations.current.cancelAdd(id).catch(() => undefined)
    }
  }, [])
  useEffect(() => {
    if (selection !== null) {
      const target = candidates.current?.querySelector<HTMLInputElement>('input:not(:disabled)')
      ;(target ?? candidates.current)?.focus()
    } else sourceInput.current?.focus()
  }, [selection?.requestId])

  const release = async (close: boolean) => {
    if (busy.current) return
    busy.current = true
    setError(null)
    const id = request.current
    if (id !== null) setPending('cancel')
    try {
      if (id !== null) {
        const result = await operations.current.cancelAdd(id)
        if (result.kind === 'error') throw new Error(result.message)
      }
      request.current = null
      if (!alive.current) return
      if (close) onClose()
      else { setSelection(null); setSelected(new Set()) }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      if (alive.current) setPending(null)
    }
  }

  const submit = async () => {
    if (busy.current || source.trim() === '') return
    if (selection !== null && selected.size === 0) { setError(t('noSelection')); return }
    busy.current = true
    setPending(selection === null ? 'fetch' : 'install')
    setError(null)
    try {
      const result = selection === null
        ? await operations.current.beginAdd(source.trim())
        : await operations.current.completeAdd(selection.requestId, [...selected])
      if (!alive.current) {
        if (result.kind === 'selection') void operations.current.cancelAdd(result.requestId).catch(() => undefined)
        return
      }
      if (result.kind === 'error') { setError(result.message); return }
      if (result.kind === 'selection') {
        request.current = result.requestId
        setSelection(result)
        setSelected(new Set())
        return
      }
      request.current = null
      onInstalled(result.plugins)
      onClose()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      if (alive.current) setPending(null)
    }
  }

  return (
    <Modal open onClose={() => { void release(true) }} title={t(selection === null ? 'addTitle' : 'selectingTitle')}
      description={t(selection === null ? 'addDescription' : 'selectingDescription')} closeLabel={t('close')}
      className={css.addDialog} contentClassName={css.dialogContent} footer={(
        <>
          <Button variant="outline" disabled={pending !== null} onClick={() => { void release(true) }}>{t(pending === 'cancel' ? 'cancelling' : 'cancel')}</Button>
          <Button variant="primary" disabled={pending !== null || source.trim() === '' || (selection !== null && selected.size === 0)}
            icon={pending !== null && pending !== 'cancel' ? <IconLoadingOutlineRegular className={css.spinner} size={16} /> : undefined}
            onClick={() => { void submit() }}>
            {t(pending === 'fetch' ? 'fetching' : pending === 'install' ? 'installing' : selection === null ? 'fetch' : 'installSelected')}
          </Button>
        </>
      )}>
      {selection === null ? (
        <div className={css.sourceForm}>
          <label htmlFor={fieldId}>{t('addSourceLabel')}</label>
          <Input ref={sourceInput} id={fieldId} className={css.sourceInput} value={source} placeholder={t('addPlaceholder')} data-modal-autofocus
            aria-describedby={`${hintId}${error === null ? '' : ` ${errorId}`}`} aria-invalid={error !== null || undefined}
            disabled={pending !== null} onChange={event => { setSource(event.currentTarget.value); setError(null) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault()
                void submit()
              }
            }} />
          <p className={css.hint} id={hintId}>{t('addHint')}</p>
        </div>
      ) : (
        <div className={css.selection}>
          <div className={css.selectionSummary}>
            <span role="status">{t('selectionProgress', { selected: selected.size, total: selectable.length })}</span>
            <button type="button" className={css.textButton} disabled={pending !== null || selectable.length === 0}
              onClick={() => { setSelected(allSelected ? new Set() : new Set(selectable.map(item => item.id))); setError(null) }}>
              {t(allSelected ? 'clearSelection' : 'selectAll')}
            </button>
          </div>
          <div className={css.candidateList} ref={candidates} tabIndex={-1} aria-label={t('selectingTitle')}>
            {selection.candidates.map(candidate => {
              const enabled = candidate.installable && candidate.errors === 0
              return (
                <label key={candidate.id} className={css.candidate} data-disabled={!enabled || undefined} data-selected={selected.has(candidate.id) || undefined}>
                  <input type="checkbox" checked={selected.has(candidate.id)} disabled={!enabled || pending !== null}
                    onChange={() => {
                      setSelected(current => { const next = new Set(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next })
                      setError(null)
                    }} />
                  <span className={css.candidateCopy}>
                    <span className={css.candidateTitle}><strong>{candidate.displayName ?? candidate.name}</strong>
                      {candidate.version !== undefined ? <span className={css.version}>{t('version', { version: candidate.version })}</span> : null}</span>
                    <code>{candidate.id}</code>
                    {candidate.description ? <span>{candidate.description}</span> : null}
                    <span className={css.candidateMeta}>
                      <span>{candidate.formats.map(format => formatLabel(format, t)).join(' · ')}</span>
                      {!candidate.installable ? <span>{t('unavailable')}</span> : null}
                      {candidate.errors > 0 ? <span className={css.errorText}>{t('candidateErrors', { count: candidate.errors })}</span> : null}
                      {candidate.warnings > 0 ? <span className={css.warningText}>{t('warningCount', { count: candidate.warnings })}</span> : null}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {selectable.length === 0 ? <p className={css.rowWarning}>{t('noInstallable')}</p> : null}
          <button type="button" className={css.textButton} disabled={pending !== null} onClick={() => { void release(false) }}>{t('changeSource')}</button>
        </div>
      )}
      {pending !== null ? <p className={css.srOnly} role="status">{t(pending === 'cancel' ? 'cancelling' : pending === 'fetch' ? 'fetching' : 'installing')}</p> : null}
      {error !== null ? <p id={errorId} className={css.formError} role="alert">{error}</p> : null}
    </Modal>
  )
}
