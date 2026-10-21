import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DshContextLike } from './context.js'

export interface HookSessionState {
  turn: number
  assistantTurn: number
  assistantText: string | null
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    [key: `plugin-bridge:${string}:hooks`]: HookSessionState
  }
}

/** Current DSH owns folding and replay; Hooks consume its registered state. */
export function createHookSessionReader(ctx: DshContextLike, pluginId: string): (agent: Agent) => HookSessionState {
  const projections = ctx.get?.('sessionProjections')
  if (projections === undefined) throw new Error('DSH 未提供 ctx.sessionProjections，无法读取 Hook 会话状态')
  const key = `plugin-bridge:${pluginId}:hooks` as const
  projections.register({
    key,
    stateVersion: 1,
    stateSchema: z.object({ turn: z.number(), assistantTurn: z.number(), assistantText: z.string().nullable() }),
    init: (): HookSessionState => ({ turn: 0, assistantTurn: 0, assistantText: null }),
    apply(state, event): HookSessionState {
      if (event.type === 'turn/start') return { turn: event.data.turn, assistantTurn: 0, assistantText: null }
      if (event.type !== 'assistant/message') return state
      const text = event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join('')
      return { ...state, assistantTurn: event.data.turn, assistantText: text.trim() === '' ? null : text }
    },
  })
  return agent => {
    const state = projections.stateOf(agent.session, key)
    if (state === undefined) throw new Error(`DSH Hook 会话 projection 未注册：${key}`)
    return state
  }
}
