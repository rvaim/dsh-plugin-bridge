import type { Config as CompatConfig } from './config.js'
import { Config } from './config.js'
import { CompatService } from './service.js'
import type { DshContextLike } from './runtime/context.js'

export const name = 'dsh-compat'
/** 等待核心 Skill 与 Shell 服务就绪后再恢复已启用的旧插件。 */
export const inject = ['skills', 'shell']
export { Config }
export type { CompatConfig as ConfigType }

/** DSH/Cordis 插件入口。 */
export async function apply(ctx: DshContextLike, config: CompatConfig = {}): Promise<void> {
  const service = new CompatService(ctx, config)
  ctx.effect?.(() => () => service.stop(), 'dsh-compat: 停止全部旧插件父实例')
  await service.start()
}

export * from './adapters/index.js'
export * from './manager/index.js'
export * from './parser/index.js'
export * from './runtime/index.js'
export * from './service.js'
export * from './store/index.js'
export * from './types/index.js'
