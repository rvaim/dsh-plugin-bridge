import { z } from 'zod'
import type { DshContextLike } from './context.js'

interface HookSessionState {
  turn: number
  assistantTurn: number
  assistantText: string | null
}

function publicText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('')
}

/** Current DSH owns folding/replay; the legacy .events fallback is only for older Hosts. */
export function createHookSessionReader(ctx: DshContextLike, pluginId: string): (agent: any) => HookSessionState {
  const projections = ctx.get?.('sessionProjections')
  const key = `plugin-bridge:${pluginId}:hooks`
  if (projections?.register !== undefined && projections.stateOf !== undefined) {
    projections.register({
      key,
      stateVersion: 1,
      stateSchema: z.object({ turn: z.number(), assistantTurn: z.number(), assistantText: z.string().nullable() }),
      init: (): HookSessionState => ({ turn: 0, assistantTurn: 0, assistantText: null }),
      apply(state: HookSessionState, event: any): HookSessionState {
        if (event.type === 'turn/start') return { turn: event.data.turn, assistantTurn: 0, assistantText: null }
        if (event.type !== 'assistant/message') return state
        const text = publicText(event.data.message?.content)
        return { ...state, assistantTurn: event.data.turn, assistantText: text.trim() === '' ? null : text }
      },
    })
    return agent => projections.stateOf(agent?.session, key) ?? { turn: 0, assistantTurn: 0, assistantText: null }
  }
  return agent => {
    const events = agent?.session?.events
    if (!Array.isArray(events)) throw new Error('当前 Host 缺少 Hook 会话 projection；不能伪造 turn=0 或最后回复')
    const turn = [...events].reverse().find(event => event?.type === 'turn/start')?.data?.turn ?? 0
    const message = [...events].reverse().find(event => event?.type === 'assistant/message' && event.data?.turn === turn)
    const text = publicText(message?.data?.message?.content)
    return { turn, assistantTurn: message?.data?.turn ?? 0, assistantText: text.trim() === '' ? null : text }
  }
}
