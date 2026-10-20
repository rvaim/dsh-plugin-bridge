import type { CompatHookEvent, CompatHookWireEventName, DshHookEvent } from '../../types/hook.js'

/** 协议事件目录独立于 DSH 的可运行事件映射。 */
const EVENTS: Partial<Record<CompatHookWireEventName, CompatHookEvent>> = {
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool-use',
  PermissionRequest: 'permission-request',
  PostToolUse: 'post-tool-use',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
  PreCompact: 'pre-compact',
  PostCompact: 'post-compact',
}

const RUNTIME_EVENTS: Partial<Record<CompatHookEvent, DshHookEvent>> = {
  'session-start': 'agent/created',
  'user-prompt-submit': 'agent/pre-step',
  'pre-tool-use': 'tools/pre-execute',
  'post-tool-use': 'tools/post-execute',
  stop: 'agent/turn-stopping',
  'subagent-start': 'subagent/start',
  // subagent/end is emitted after settlement; it cannot honor SubagentStop gates.

}

const NO_MATCHER_EVENTS = new Set<CompatHookWireEventName>([
  'UserPromptSubmit', 'Stop', 'Interrupt',
])

export interface HookEventDefinition {
  event: CompatHookEvent
  wireEventName: CompatHookWireEventName
  dshEvent: DshHookEvent
  supportsMatcher: boolean
  legacyAlias: boolean
}

export function hookEventDefinition(name: string): HookEventDefinition | undefined {
  // snake_case 是本协议此前已接受的输入事件拼写。
  const wire = (Object.keys(EVENTS) as CompatHookWireEventName[]).find(candidate =>
    candidate === name || candidate.replace(/[A-Z]/g, (char, offset: number) =>
      `${offset === 0 ? '' : '_'}${char.toLowerCase()}`) === name)
  if (wire === undefined) return undefined
  const event = EVENTS[wire]!
  return {
    event,
    wireEventName: wire,
    dshEvent: RUNTIME_EVENTS[event] ?? 'unsupported',
    supportsMatcher: !NO_MATCHER_EVENTS.has(wire),
    legacyAlias: wire !== name,
  }
}
