/** Browser half: native DSH settings registration and typed Host RPC mount. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import compatRemote from '../../dist/typert.remote-client.js'
import { CompatSettingsSection, type CompatSettingsInjected } from './CompatSettingsSection.js'
import { en, zh } from './locales.js'

const NS = 'settings.compat'

/** Client services required before the Settings contribution can mount. */
export const inject = ['slots', 'locale', 'remote']

function unwrap<T>(result: RemoteResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`)
  return result.value
}

/** Mount the dsh-compat Remote namespace and contribute its Settings section. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(compatRemote)
  try {
    // 该 namespace 由本插件刚刚动态挂载，无法写进静态 inject（否则会形成
    // “先等待 namespace、再执行负责挂载 namespace 的 apply”死锁）。Cordis
    // 的 get() 正是这种运行时自提供服务的无 inject 读取边界。
    const compatAdmin = ctx.get('remote.compatAdmin') as Context['remote']['compatAdmin'] | undefined
    if (compatAdmin === undefined) throw new Error('compatAdmin Remote 挂载后不可用')
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'dsh-compat: Web 设置字典',
    )
    const t = ctx.locale.bind(NS)
    const injected: CompatSettingsInjected = {
      list: async () => unwrap(await compatAdmin.list(), 'compatAdmin.list'),
      beginAdd: async source => unwrap(
        await compatAdmin.beginAdd(source),
        'compatAdmin.beginAdd',
      ),
      completeAdd: async (requestId, plugins) => unwrap(
        await compatAdmin.completeAdd(requestId, plugins),
        'compatAdmin.completeAdd',
      ),
      cancelAdd: async requestId => unwrap(
        await compatAdmin.cancelAdd(requestId),
        'compatAdmin.cancelAdd',
      ),
      setEnabled: async (pluginId, enabled) => unwrap(
        await compatAdmin.setEnabled(pluginId, enabled),
        'compatAdmin.setEnabled',
      ),
      uninstall: async pluginId => unwrap(
        await compatAdmin.uninstall(pluginId),
        'compatAdmin.uninstall',
      ),
    }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'compat-plugins',
      order: 30,
      label: () => t('nav'),
      locale: NS,
      inject: () => injected,
    }, CompatSettingsSection))
  } catch (error) {
    await disposeRemote()
    throw error
  }

  return disposeRemote
}

export { CompatSettingsSection } from './CompatSettingsSection.js'
export type { CompatSettingsInjected, CompatSettingsSectionProps } from './CompatSettingsSection.js'
export { NS }
