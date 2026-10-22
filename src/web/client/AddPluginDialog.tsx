import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, IconArchiveOutlineRegular, IconLoadingOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompatWebAddResult, CompatWebCandidate, CompatWebCategory, CompatWebPlugin } from '../../types/web.js'
import type { PluginBridgeInjected, ResolveText } from './types.js'
import { MAX_PLUGIN_ARCHIVE_BYTES, PLUGIN_ARCHIVE_ACCEPT, pluginArchiveSuffix } from '../../shared/archive-input.js'
import { formatLabel, type Translate } from './panel-model.js'
import css from './PluginBridgePanel.module.css'
import fileCss from './AddPluginDialog.module.css'

type AddApi = Pick<PluginBridgeInjected, 'beginAdd' | 'completeAdd' | 'cancelAdd' | 'uploadArchive'>
interface AddPluginDialogProps {
  api: AddApi
  categories: readonly CompatWebCategory[]
  resolveText: ResolveText
  t: Translate
  onClose(): void
  onInstalled(plugins: CompatWebPlugin[]): void
}
type Selection = { requestId: string; candidates: CompatWebCandidate[] }
type Progress = 'fetch' | 'upload' | 'install' | 'cancel' | null

/** The prepared Source belongs to this flow until committed or explicitly released. */
export function AddPluginDialog({ api, categories, resolveText, t, onClose, onInstalled }: AddPluginDialogProps) {
  const [source, setSource] = useState('')
  const [localFile, setLocalFile] = useState<File | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const flow = useRef<AbortController | null>(null)
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
      flow.current?.abort()
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
    if (busy.current) {
      if (flow.current !== null) {
        flow.current.abort()
        if (close) onClose()
      }
      return
    }
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
      else { setSelection(null); setSelected(new Set()); setLocalFile(null) }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      if (alive.current) setPending(null)
    }
  }

  const chooseFile = (file: File | undefined) => {
    if (file === undefined) return
    if (pluginArchiveSuffix(file.name) === undefined || file.size === 0) { setError(t('invalidArchive')); return }
    if (file.size > MAX_PLUGIN_ARCHIVE_BYTES) { setError(t('fileTooLarge', { limit: 30 })); return }
    setLocalFile(file)
    setError(null)
  }

  const submit = async () => {
    if (busy.current || (localFile === null && source.trim() === '')) return
    if (selection !== null && selected.size === 0) { setError(t('noSelection')); return }
    busy.current = true
    const controller = new AbortController()
    flow.current = controller
    setPending(selection !== null ? 'install' : localFile !== null ? 'upload' : 'fetch')
    setError(null)
    try {
      let result: CompatWebAddResult
      if (selection !== null) result = await operations.current.completeAdd(selection.requestId, [...selected], controller.signal)
      else if (localFile !== null) {
        result = await operations.current.uploadArchive(localFile, controller.signal)
        if (result.kind === 'selection' && (!alive.current || controller.signal.aborted)) {
          await operations.current.cancelAdd(result.requestId)
          return
        }
        if (result.kind === 'selection' && !result.selectionRequired && result.candidates.length === 1 && result.candidates[0].installable && result.candidates[0].errors === 0) {
          request.current = result.requestId
          setSelection(result)
          setSelected(new Set([result.candidates[0].id]))
          setPending('install')
          result = await operations.current.completeAdd(result.requestId, [result.candidates[0].id], controller.signal)
        }
      } else result = await operations.current.beginAdd(source.trim(), controller.signal)
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
      flow.current = null
      busy.current = false
      if (alive.current) setPending(null)
    }
  }

  return (
    <Modal open onClose={() => { void release(true) }} title={t(selection === null ? 'addTitle' : 'selectingTitle')}
      description={t(selection === null ? 'addDescription' : 'selectingDescription')} closeLabel={t('close')}
      className={css.addDialog} contentClassName={css.dialogContent} footer={(
        <>
          <Button variant="outline" disabled={pending === 'cancel'} onClick={() => { void release(true) }}>{t(pending === 'cancel' ? 'cancelling' : 'cancel')}</Button>
          <Button variant="primary" disabled={pending !== null || (localFile === null && source.trim() === '') || (selection !== null && selected.size === 0)}
            icon={pending !== null && pending !== 'cancel' ? <IconLoadingOutlineRegular className={css.spinner} size={16} /> : undefined}
            onClick={() => { void submit() }}>
            {t(pending === 'upload' ? 'uploadingFile' : pending === 'fetch' ? 'fetching' : pending === 'install' ? 'installing' : selection === null ? 'fetch' : 'installSelected')}
          </Button>
        </>
      )}>
      {selection === null ? (
        <div className={css.sourceForm}>
          <label htmlFor={fieldId}>{t('addSourceLabel')}</label>
          <Input ref={sourceInput} id={fieldId} className={css.sourceInput} value={localFile?.name ?? source} placeholder={t('addPlaceholder')} data-modal-autofocus
            aria-describedby={`${hintId}${error === null ? '' : ` ${errorId}`}`} aria-invalid={error !== null || undefined}
            disabled={pending !== null || localFile !== null} onChange={event => { setSource(event.currentTarget.value); setError(null) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault()
                void submit()
              }
            }} />
          <p className={css.hint} id={hintId}>{t(localFile === null ? 'addHint' : 'localFileHint')}</p>
          <input ref={filePicker} type="file" hidden accept={PLUGIN_ARCHIVE_ACCEPT} aria-label={t('chooseLocalFile')}
            disabled={pending !== null} onChange={event => { chooseFile(event.currentTarget.files?.[0]) }} />
          <div className={fileCss.actions}>
            <Button variant="outline" size="sm" icon={<IconArchiveOutlineRegular size={16} />} disabled={pending !== null}
              onClick={() => { if (filePicker.current !== null) { filePicker.current.value = ''; filePicker.current.click() } }}>{t('chooseLocalFile')}</Button>
            {localFile !== null ? <Button variant="ghost" size="sm" disabled={pending !== null}
              onClick={() => { setLocalFile(null); setError(null); requestAnimationFrame(() => sourceInput.current?.focus()) }}>{t('removeLocalFile')}</Button> : null}
          </div>
          {localFile !== null ? <div className={fileCss.selected} role="status"><strong title={localFile.name}>{localFile.name}</strong><span>{(localFile.size / (1024 * 1024)).toFixed(1)} MiB</span></div>
            : <p className={css.hint}>{t('localFileHint')}</p>}
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
                    <span className={css.sourceLine}>{t('candidateSource', { source: candidate.source })}</span>
                    {candidate.description ? <span>{candidate.description}</span> : null}
                    <span className={css.candidateMeta}>
                      <span>{candidate.formats.map(format => formatLabel(format, categories, resolveText)).join(' · ')}</span>
                      {!candidate.installable ? <span>{t('unavailable')}</span> : null}
                      {candidate.errors > 0 ? <span className={css.errorText}>{t('candidateErrors', { count: candidate.errors })}</span> : null}
                      {candidate.warnings > 0 ? <span className={css.warningText}>{t('warningCount', { count: candidate.warnings })}</span> : null}
                    </span>
                    {candidate.diagnostics.map((item, index) => (
                      <span key={`${item.code}:${index}`} className={item.level === 'error' ? css.errorText : css.warningText}>
                        <code>{item.code}</code> {item.message}
                        {item.file === undefined ? null : ` (${item.file})`}
                      </span>
                    ))}
                  </span>
                </label>
              )
            })}
          </div>
          {selectable.length === 0 ? <p className={css.rowWarning}>{t('noInstallable')}</p> : null}
          <button type="button" className={css.textButton} disabled={pending !== null} onClick={() => { void release(false) }}>{t('changeSource')}</button>
        </div>
      )}
      {pending !== null ? <p className={css.srOnly} role="status">{t(pending === 'cancel' ? 'cancelling' : pending === 'upload' ? 'uploadingFile' : pending === 'fetch' ? 'fetching' : 'installing')}</p> : null}
      {error !== null ? <p id={errorId} className={css.formError} role="alert">{error}</p> : null}
    </Modal>
  )
}
