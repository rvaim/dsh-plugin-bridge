import type { CompatHookEvent, CompatHookWireEventName, DshHookEvent } from '../../types/hook.js'

/** 协议事件目录独立于 DSH 的可运行事件映射。 */
const EVENTS: Partial<Record<CompatHookWireEventName, CompatHookEvent>> = {
  SessionStart: 'session-start',
  SessionEnd: 'session-end',
  Setup: 'setup',
  UserPromptSubmit: 'user-prompt-submit',
  UserPromptExpansion: 'user-prompt-expansion',
  PreToolUse: 'pre-tool-use',
  PermissionRequest: 'permission-request',
  PermissionDenied: 'permission-denied',
  PostToolUse: 'post-tool-use',
  PostToolUseFailure: 'post-tool-use-failure',
  PostToolBatch: 'post-tool-batch',
  Notification: 'notification',
  MessageDisplay: 'message-display',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  TaskCreated: 'task-created',
  TaskCompleted: 'task-completed',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  TeammateIdle: 'teammate-idle',
  InstructionsLoaded: 'instructions-loaded',
  ConfigChange: 'config-change',
  CwdChanged: 'cwd-changed',
  DirectoryAdded: 'directory-added',
  FileChanged: 'file-changed',
  WorktreeCreate: 'worktree-create',
  WorktreeRemove: 'worktree-remove',
  PreCompact: 'pre-compact',
  PostCompact: 'post-compact',
  PreModelSwitch: 'pre-model-switch',
  PostModelSwitch: 'post-model-switch',
  Elicitation: 'elicitation',
  ElicitationResult: 'elicitation-result',
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
  'UserPromptSubmit', 'Stop', 'CwdChanged', 'PostToolBatch', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay',
])

export interface HookEventDefinition {
  event: CompatHookEvent
  wireEventName: CompatHookWireEventName
  dshEvent: DshHookEvent
  supportsMatcher: boolean
  legacyAlias: boolean
}

export function hookEventDefinition(name: string): HookEventDefinition | undefined {
  const wire = (Object.keys(EVENTS) as CompatHookWireEventName[]).find(candidate => candidate === name)
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
