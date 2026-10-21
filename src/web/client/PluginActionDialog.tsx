import { Button, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompatWebPlugin } from '../../types/web.js'
import { displayName, type Translate } from './panel-model.js'
import css from './PluginBridgePanel.module.css'

export interface ConfirmAction {
  kind: 'remove' | 'update'
  plugin: CompatWebPlugin
  affectedPluginIds?: readonly string[]
}
interface PluginActionDialogProps {
  action: ConfirmAction
  plugins: readonly CompatWebPlugin[]
  pending: boolean
  error?: string
  onClose(): void
  onConfirm(): void
  t: Translate
}

export function PluginActionDialog({ action, plugins, pending, error, onClose, onConfirm, t }: PluginActionDialogProps) {
  const removing = action.kind === 'remove'
  const names = new Map(plugins.map(plugin => [plugin.id, displayName(plugin)]))
  const affected = action.affectedPluginIds ?? [action.plugin.id]
  return (
    <Modal open className={css.actionDialog} contentClassName={css.dialogContent} onClose={() => { if (!pending) onClose() }} closeLabel={t('close')}
      title={removing ? t('uninstallTitle', { name: displayName(action.plugin) }) : t('sharedUpdateTitle')}
      description={removing ? t('uninstallDescription') : t('sharedUpdateDescription', { count: affected.length })}
      footer={(
        <>
          <Button variant="outline" data-modal-autofocus disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending} onClick={onConfirm}
            icon={pending ? <IconLoadingOutlineRegular className={css.spinner} size={16} /> : undefined}>
            {t(pending ? removing ? 'uninstalling' : 'updating' : removing ? 'uninstallConfirm' : 'sharedUpdateConfirm')}
          </Button>
        </>
      )}>
      {!removing ? (
        <div className={css.affectedPlugins}>
          <p>{t('source', { source: action.plugin.sourceId })}</p>
          <ul>{affected.map(id => <li key={id}>{names.get(id) ?? id}</li>)}</ul>
        </div>
      ) : null}
      {error !== undefined ? <p className={css.formError} role="alert">{error}</p> : null}
    </Modal>
  )
}
