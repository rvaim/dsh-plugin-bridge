import type { Config as CompatConfig } from './config.js'
import { Config } from './config.js'
import { CompatService } from './service.js'
import { CompatWebGateway } from './web/host/gateway.js'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

export const name = 'plugin-bridge'
/** 等待核心 Skill 与 Shell 服务就绪后再恢复已启用的旧插件。 */
export const inject = ['skills', 'shell']
export { Config }
export type { CompatConfig as ConfigType }

/** DSH/Cordis 插件入口。 */
export async function apply(ctx: CordisContext, config: CompatConfig = {}): Promise<void> {
  const service = new CompatService(ctx, config)
  ctx.effect(() => () => service.stop(), 'plugin-bridge: 停止全部旧插件父实例')
  await service.start()
  const gateway = new CompatWebGateway(ctx)
  ctx.effect(() => () => gateway.dispose(), 'plugin-bridge: 清理未完成的 Web 添加请求')
}

export { createBuiltinParserEngine, getDefaultParserEngine, parseCompatPlugin, parseCompatSource } from './composition/defaults.js'
export { builtInParsers } from './composition/builtins.js'
export { knownParserSignatures } from './composition/signatures.js'
export * from './runtime/adapters/index.js'
export * from './manager/index.js'
export * from './parser/index.js'
export * from './runtime/index.js'
export * from './service.js'
export * from './store/index.js'
export * from './types/index.js'
export * from './web/host/gateway.js'
