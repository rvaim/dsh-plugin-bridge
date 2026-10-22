import type {
  CompatWebAddResult,
  CompatWebCancelAddResult,
  CompatWebCategory,
  CompatWebCheckUpdatesResult,
  CompatWebListResult,
  CompatWebPlugin,
  CompatWebSetEnabledResult,
  CompatWebUninstallResult,
  CompatWebUpdateResult,
} from '../../types/web.js'
import type { PluginInstallSelection } from '../../types/plugin.js'
import type { PluginBridgeLocaleKey } from './locales.js'

/** Labels follow the Host catalog and resolve through the native locale service. */
export type ResolveText = (label: CompatWebCategory['label']) => string

/** Browser operations supplied by the plugin registration. */
export interface PluginBridgeInjected {
  resolveText: ResolveText
  uploadArchive(file: File, signal: AbortSignal): Promise<CompatWebAddResult>
  list: () => Promise<CompatWebListResult>
  checkUpdates: () => Promise<CompatWebCheckUpdatesResult>
  update: (pluginId: string, confirmShared: boolean) => Promise<CompatWebUpdateResult>
  beginAdd: (source: string, signal: AbortSignal) => Promise<CompatWebAddResult>
  completeAdd: (requestId: string, plugins: PluginInstallSelection[], signal: AbortSignal) => Promise<CompatWebAddResult>
  cancelAdd: (requestId: string) => Promise<CompatWebCancelAddResult>
  setEnabled: (pluginId: string, enabled: boolean) => Promise<CompatWebSetEnabledResult>
  uninstall: (pluginId: string) => Promise<CompatWebUninstallResult>
}

export type PanelView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; plugins: CompatWebPlugin[]; categories: CompatWebCategory[] }

export type PendingAction = {
  pluginId: string
  kind: 'toggle' | 'uninstall' | 'update'
} | null

/** A failed mutation stays beside its plugin until another operation starts. */
export type RowError = { pluginId: string; message: string }

/** Resolve copy during render so a language change also updates active feedback. */
export type PanelToast = {
  id: number
  key: PluginBridgeLocaleKey
  values?: Record<string, string | number>
}
