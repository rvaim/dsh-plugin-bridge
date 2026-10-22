/** Browser half: native DSH sidebar panel and typed Host RPC mount. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import compatRemote from '../../../dist/typert.remote-client.js'
import { PluginBridgePanel } from './PluginBridgePanel.js'
import type { PluginBridgeInjected } from './types.js'
import { PluginBridgePanelIcon } from './PluginBridgePanelIcon.js'
import { uploadLocalArchive } from './local-archive.js'
import { en, zh } from './locales.js'

const NS = 'pluginBridge'
const PANEL_ID = 'plugin-bridge'

/** Client services required before the management panel can mount. */
export const inject = ['slots', 'locale', 'remote']

function unwrap<T>(result: RemoteResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`)
  return result.value
}

/** Mount the plugin-bridge Remote namespace and contribute its management panel. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(compatRemote)
  try {
    // 该 namespace 由本插件刚刚动态挂载，无法写进静态 inject（否则会形成
    // “先等待 namespace、再执行负责挂载 namespace 的 apply”死锁）。Cordis
    // 的 get() 正是这种运行时自提供服务的无 inject 读取边界。
    const pluginBridgeAdmin = ctx.get('remote.pluginBridgeAdmin') as Context['remote']['pluginBridgeAdmin'] | undefined
    if (pluginBridgeAdmin === undefined) throw new Error('pluginBridgeAdmin Remote 挂载后不可用')
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'plugin-bridge: Web 管理面板字典',
    )
    const t = ctx.locale.bind(NS)
    const injected: PluginBridgeInjected = {
      resolveText: label => ctx.locale.resolveText(label),
      uploadArchive: uploadLocalArchive,
      list: async () => unwrap(await pluginBridgeAdmin.list(), 'pluginBridgeAdmin.list'),
      checkUpdates: async () => unwrap(await pluginBridgeAdmin.checkUpdates(), 'pluginBridgeAdmin.checkUpdates'),
      update: async (pluginId, confirmShared) => unwrap(
        await pluginBridgeAdmin.update(pluginId, confirmShared),
        'pluginBridgeAdmin.update',
      ),
      beginAdd: async (source, signal) => unwrap(
        await pluginBridgeAdmin.beginAdd(source, signal),
        'pluginBridgeAdmin.beginAdd',
      ),
      completeAdd: async (requestId, plugins, signal) => unwrap(
        await pluginBridgeAdmin.completeAdd(requestId, plugins, signal),
        'pluginBridgeAdmin.completeAdd',
      ),
      cancelAdd: async requestId => unwrap(
        await pluginBridgeAdmin.cancelAdd(requestId),
        'pluginBridgeAdmin.cancelAdd',
      ),
      setEnabled: async (pluginId, enabled) => unwrap(
        await pluginBridgeAdmin.setEnabled(pluginId, enabled),
        'pluginBridgeAdmin.setEnabled',
      ),
      uninstall: async pluginId => unwrap(
        await pluginBridgeAdmin.uninstall(pluginId),
        'pluginBridgeAdmin.uninstall',
      ),
    }
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => injected,
    }, PluginBridgePanel))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 30,
      label: () => t('nav'),
      locale: NS,
    }, PluginBridgePanelIcon))
  } catch (error) {
    await disposeRemote()
    throw error
  }

  return disposeRemote
}

export { PluginBridgePanel } from './PluginBridgePanel.js'
export type { PluginBridgeInjected } from './types.js'
export type { PluginBridgePanelProps } from './PluginBridgePanel.js'
export { NS, PANEL_ID }
