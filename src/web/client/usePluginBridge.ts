import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CompatWebCategory,
  CompatWebPlugin,
  CompatWebSetEnabledResult,
  CompatWebUninstallResult,
  CompatWebUpdateInfo,
  CompatWebUpdateResult,
} from '../../types/web.js'
import { displayName } from './panel-model.js'
import type {
  PanelToast,
  PanelView,
  PendingAction,
  PluginBridgeInjected,
  RowError,
} from './types.js'

type MutationResult = CompatWebSetEnabledResult | CompatWebUninstallResult | CompatWebUpdateResult

type ActiveAction = NonNullable<PendingAction>

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergePlugins(current: CompatWebPlugin[], incoming: CompatWebPlugin[]): CompatWebPlugin[] {
  const byId = new Map(current.map(plugin => [plugin.id, plugin]))
  for (const plugin of incoming) byId.set(plugin.id, plugin)
  return [...byId.values()].sort((left, right) =>
    left.priority - right.priority || left.id.localeCompare(right.id))
}

/** Own list reads and lifecycle writes without depending on translated render copy. */
export function usePluginBridge(api: PluginBridgeInjected) {
  const apiRef = useRef(api)
  apiRef.current = api
  const mounted = useRef(false)
  const revision = useRef(0)
  const listSequence = useRef(0)
  const updateSequence = useRef(0)
  const toastSequence = useRef(0)
  const pendingRef = useRef<PendingAction>(null)
  const pluginsRef = useRef<CompatWebPlugin[]>([])
  const categoriesRef = useRef<CompatWebCategory[]>([])
  const hasInventory = useRef(false)

  const [view, setView] = useState<PanelView>({ status: 'loading' })
  const [updateState, setUpdateState] = useState<Record<string, CompatWebUpdateInfo>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction>(null)
  const [mutationError, setMutationError] = useState<RowError | null>(null)
  const [toast, setToast] = useState<PanelToast | null>(null)

  const showToast = useCallback((key: PanelToast['key'], values?: PanelToast['values']) => {
    toastSequence.current += 1
    setToast({ id: toastSequence.current, key, values })
  }, [])

  const commitPlugins = useCallback((plugins: CompatWebPlugin[], categories = categoriesRef.current) => {
    pluginsRef.current = plugins
    categoriesRef.current = categories
    hasInventory.current = true
    setView({ status: 'ready', plugins, categories })
  }, [])

  const invalidateReads = useCallback(() => {
    revision.current += 1
    listSequence.current += 1
    updateSequence.current += 1
    setRefreshing(false)
    setCheckingUpdates(false)
  }, [])

  const readList = useCallback(async () => {
    if (!mounted.current || pendingRef.current !== null) return
    const request = ++listSequence.current
    const startedAt = revision.current
    const current = () => mounted.current
      && request === listSequence.current
      && startedAt === revision.current
    setRefreshing(true)
    if (!hasInventory.current) setView({ status: 'loading' })
    try {
      const result = await apiRef.current.list()
      if (!current()) return
      if (result.kind === 'error') {
        setListError(result.message)
        if (!hasInventory.current) setView({ status: 'error', message: result.message })
        return
      }
      commitPlugins(result.plugins, result.categories)
      setListError(null)
    } catch (error) {
      if (!current()) return
      const message = failureMessage(error)
      setListError(message)
      if (!hasInventory.current) setView({ status: 'error', message })
    } finally {
      if (current()) setRefreshing(false)
    }
  }, [commitPlugins])

  const retryUpdates = useCallback(async () => {
    if (!mounted.current || pendingRef.current !== null) return
    const request = ++updateSequence.current
    const startedAt = revision.current
    const current = () => mounted.current
      && request === updateSequence.current
      && startedAt === revision.current
    setCheckingUpdates(true)
    try {
      const result = await apiRef.current.checkUpdates()
      if (!current()) return
      if (result.kind === 'error') {
        setUpdateError(result.message)
        return
      }
      setUpdateState(Object.fromEntries(result.updates.map(item => [item.pluginId, item])))
      setUpdateError(null)
    } catch (error) {
      if (current()) setUpdateError(failureMessage(error))
    } finally {
      if (current()) setCheckingUpdates(false)
    }
  }, [])

  // Each read commits as soon as it settles; the update check never gates the list.
  const refresh = useCallback(async () => {
    await Promise.all([readList(), retryUpdates()])
  }, [readList, retryUpdates])

  useEffect(() => {
    mounted.current = true
    pendingRef.current = null
    setPending(null)
    void refresh()
    return () => {
      mounted.current = false
      revision.current += 1
      listSequence.current += 1
      updateSequence.current += 1
      pendingRef.current = null
    }
  }, [api.list, api.checkUpdates, refresh])

  const runMutation = useCallback(async <Result extends MutationResult>(
    plugin: CompatWebPlugin,
    kind: ActiveAction['kind'],
    perform: (currentApi: PluginBridgeInjected) => Promise<Result>,
    accept: (result: Exclude<Result, { kind: 'error' }>) => void,
  ): Promise<boolean> => {
    if (!mounted.current || pendingRef.current !== null) return false
    const action: ActiveAction = { pluginId: plugin.id, kind }
    // Claim the lock synchronously, before React can render the disabled controls.
    pendingRef.current = action
    invalidateReads()
    setPending(action)
    setMutationError(null)
    const current = () => mounted.current && pendingRef.current === action
    try {
      const result = await perform(apiRef.current)
      if (!current()) return false
      if (result.kind === 'error') {
        setMutationError({ pluginId: plugin.id, message: result.message })
        return false
      }
      // The common error discriminator was handled above for every RPC result.
      accept(result as Exclude<Result, { kind: 'error' }>)
      return true
    } catch (error) {
      if (current()) setMutationError({ pluginId: plugin.id, message: failureMessage(error) })
      return false
    } finally {
      if (current()) {
        pendingRef.current = null
        setPending(null)
      }
    }
  }, [invalidateReads])

  const togglePlugin = useCallback((plugin: CompatWebPlugin): Promise<boolean> => runMutation(
    plugin,
    'toggle',
    currentApi => currentApi.setEnabled(plugin.id, !plugin.enabled),
    (result) => {
      commitPlugins(mergePlugins(pluginsRef.current, [result.plugin]))
      showToast(result.plugin.enabled ? 'enabledToast' : 'disabledToast', { name: displayName(result.plugin) })
    },
  ), [commitPlugins, runMutation, showToast])

  const updatePlugin = useCallback((plugin: CompatWebPlugin, confirmShared: boolean): Promise<boolean> => runMutation(
    plugin,
    'update',
    currentApi => currentApi.update(plugin.id, confirmShared),
    (result) => {
      commitPlugins(mergePlugins(pluginsRef.current, result.plugins))
      setUpdateState((current) => {
        const next = { ...current }
        for (const pluginId of result.affectedPluginIds) {
          const existing = next[pluginId]
          if (existing !== undefined) next[pluginId] = { ...existing, available: false, affectedPluginIds: [], error: undefined }
        }
        return next
      })
      showToast('updatedToast', { name: displayName(plugin) })
    },
  ), [commitPlugins, runMutation, showToast])

  const removePlugin = useCallback((plugin: CompatWebPlugin): Promise<boolean> => runMutation(
    plugin,
    'uninstall',
    currentApi => currentApi.uninstall(plugin.id),
    (result) => {
      commitPlugins(pluginsRef.current.filter(item => item.id !== result.pluginId))
      setUpdateState((current) => {
        const next = { ...current }
        delete next[result.pluginId]
        return next
      })
      showToast('removedToast', { name: displayName(plugin) })
    },
  ), [commitPlugins, runMutation, showToast])

  const acceptInstalled = useCallback((plugins: CompatWebPlugin[]) => {
    if (!mounted.current) return
    invalidateReads()
    setMutationError(null)
    commitPlugins(mergePlugins(pluginsRef.current, plugins))
    const first = plugins[0]
    if (plugins.length === 1 && first !== undefined) showToast('installedOne', { name: displayName(first) })
    else showToast('installedMany', { count: plugins.length })
  }, [commitPlugins, invalidateReads, showToast])

  const clearMutationError = useCallback(() => {
    if (mounted.current) setMutationError(null)
  }, [])

  // An old toast's exit callback must not dismiss a newer operation's feedback.
  const dismissToast = useCallback((id?: number) => {
    setToast(current => id === undefined || current?.id === id ? null : current)
  }, [])

  return {
    view,
    updateState,
    refreshing,
    checkingUpdates,
    listError,
    updateError,
    pending,
    mutationError,
    clearMutationError,
    toast,
    refresh,
    retryUpdates,
    togglePlugin,
    updatePlugin,
    removePlugin,
    acceptInstalled,
    dismissToast,
  }
}
