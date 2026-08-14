import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  CompatHook,
  CompatHookCommand,
  CompatHookEvent,
  CompatHookRuntimeProfile,
  DshHookEvent,
} from '../../types/hook.js'
import type { HarnessDescriptor } from '../harness/types.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { readJson } from '../shared/fs.js'
import { validateMatcher } from '../shared/matcher.js'
import { asObject } from '../shared/object.js'
import { escapeJsonPointer, parsePotentialSecretValue } from '../shared/template.js'

const CLAUDE_EVENTS: Record<string, [CompatHookEvent, DshHookEvent]> = {
  SessionStart: ['session-start', 'agent/session-start'],
  UserPromptSubmit: ['user-prompt-submit', 'agent/pre-step'],
  PreToolUse: ['pre-tool-use', 'tools/pre-execute'],
  PostToolUse: ['post-tool-use', 'tools/post-execute'],
  Stop: ['stop', 'agent/turn-stopping'],
  SubagentStart: ['subagent-start', 'subagent/start'],
  SubagentStop: ['subagent-stop', 'subagent/end'],
}

const CODEX_EVENTS: Record<string, [CompatHookEvent, DshHookEvent]> = {
  session_start: ['session-start', 'agent/session-start'],
  user_prompt_submit: ['user-prompt-submit', 'agent/pre-step'],
  pre_tool_use: ['pre-tool-use', 'tools/pre-execute'],
  post_tool_use: ['post-tool-use', 'tools/post-execute'],
  stop: ['stop', 'agent/turn-stopping'],
  SessionStart: ['session-start', 'agent/session-start'],
  UserPromptSubmit: ['user-prompt-submit', 'agent/pre-step'],
  PreToolUse: ['pre-tool-use', 'tools/pre-execute'],
  PostToolUse: ['post-tool-use', 'tools/post-execute'],
  Stop: ['stop', 'agent/turn-stopping'],
}

const WIRE_EVENT_NAMES: Record<CompatHookEvent, CompatHookRuntimeProfile['wireEventName']> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop',
}

/** 把旧方言差异编译成 adapter 可直接执行的统一运行配置。 */
function runtimeProfile(
  format: HarnessDescriptor['format'],
  event: CompatHookEvent,
): CompatHookRuntimeProfile {
  const codex = format === 'codex'
  return {
    wireEventName: WIRE_EVENT_NAMES[event],
    matcherMode: format,
    trailingNewline: !codex,
    plainStdoutAsContext: codex && (event === 'session-start' || event === 'user-prompt-submit'),
    environmentMode: codex ? 'codex-plugin' : 'claude-plugin',
    missingTranscriptPath: codex ? 'null' : 'empty-string',
    includeCodexBaseFields: codex,
    includeTurnId: codex && event !== 'session-start',
    toolInputShape: codex ? 'command' : 'raw',
    honorPreToolAsk: !codex,
    includeNullLastAssistantMessage: codex && event === 'stop',
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value]
}

function stableId(values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)
}

function parseCommand(
  raw: unknown,
  collector: DiagnosticCollector,
  sourceFile: string,
  eventName: string,
  handlerPointer: string,
): CompatHookCommand | undefined {
  const object = asObject(raw)
  if (object === undefined) {
    collector.add('error', 'HOOK_HANDLER_INVALID', 'hook', `Hook ${eventName} handler 必须是对象`, sourceFile)
    return undefined
  }
  const type = typeof object.type === 'string' ? object.type : 'command'
  if (type !== 'command') {
    collector.add('error', 'HOOK_UNSUPPORTED_HANDLER', 'hook', `Hook ${eventName} 的 handler 类型 ${type} 暂不支持`, sourceFile)
    return undefined
  }
  if (typeof object.command !== 'string' || object.command.trim() === '') {
    collector.add('error', 'HOOK_COMMAND_MISSING', 'hook', `Hook ${eventName} command 为空`, sourceFile)
    return undefined
  }
  if (object.args !== undefined && (!Array.isArray(object.args) || object.args.some(item => typeof item !== 'string'))) {
    collector.add('error', 'HOOK_ARGS_INVALID', 'hook', `Hook ${eventName} 的 args 必须是字符串数组`, sourceFile)
    return undefined
  }
  const timeout = typeof object.timeoutSec === 'number'
    ? object.timeoutSec
    : typeof object.timeout === 'number'
      ? object.timeout
      : undefined
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    collector.add('error', 'HOOK_TIMEOUT_INVALID', 'hook', `Hook ${eventName} timeout 必须为正数`, sourceFile)
    return undefined
  }
  return {
    command: parsePotentialSecretValue(object.command, sourceFile, `${handlerPointer}/command`, false),
    ...(object.args === undefined ? {} : {
      args: (object.args as string[]).map((arg, index) =>
        parsePotentialSecretValue(arg, sourceFile, `${handlerPointer}/args/${index}`, false)),
    }),
    ...(timeout === undefined ? {} : { timeoutSec: timeout }),
    ...((object.async === true || object.detached === true) ? { detached: true } : {}),
  }
}

export async function parseHooksForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatHook[]> {
  const hooks: CompatHook[] = []
  const eventMap = descriptor.format === 'claude-code' ? CLAUDE_EVENTS : CODEX_EVENTS
  for (const source of descriptor.hookSources) {
    let raw: unknown
    try {
      raw = source.inline ?? await readJson(resolve(packageRoot, source.file))
    } catch (error) {
      collector.add('error', 'HOOK_CONFIG_INVALID', 'hook', `Hook 配置无法解析：${String(error)}`, source.file)
      continue
    }
    const root = asObject(raw)
    if (root === undefined) {
      collector.add('error', 'HOOK_CONFIG_INVALID', 'hook', 'Hook 配置顶层必须是对象', source.file)
      continue
    }
    const wrapped = asObject(root.hooks) !== undefined
    const eventRoot = asObject(root.hooks) ?? root
    const pointerBase = `${source.pointer ?? ''}${wrapped ? '/hooks' : ''}`
    for (const [eventName, rawGroups] of Object.entries(eventRoot)) {
      const mapped = eventMap[eventName]
      if (mapped === undefined) {
        collector.add('error', 'HOOK_EVENT_UNSUPPORTED', 'hook', `当前 DSH 接口无法映射 Hook 事件：${eventName}`, source.file)
        continue
      }
      for (const [groupIndex, rawGroup] of asArray(rawGroups).entries()) {
        const group = asObject(rawGroup)
        if (group === undefined) {
          collector.add('error', 'HOOK_GROUP_INVALID', 'hook', `Hook ${eventName} 第 ${groupIndex + 1} 组必须是对象`, source.file)
          continue
        }
        let matcher: string | undefined
        try {
          matcher = validateMatcher(group.matcher, descriptor.format)
        } catch (error) {
          collector.add('error', 'HOOK_MATCHER_INVALID', 'hook', `Hook ${eventName} matcher 无效：${String(error)}`, source.file)
          continue
        }
        const directHandler = group.hooks === undefined && group.command !== undefined
        const rawHandlers = group.hooks ?? (directHandler ? [group] : undefined)
        if (!Array.isArray(rawHandlers)) {
          collector.add('error', 'HOOK_HANDLERS_INVALID', 'hook', `Hook ${eventName} 的 hooks 必须是数组`, source.file)
          continue
        }
        const eventPointer = `${pointerBase}/${escapeJsonPointer(eventName)}`
        const groupPointer = Array.isArray(rawGroups) ? `${eventPointer}/${groupIndex}` : eventPointer
        const commands = rawHandlers
          .map((handler, handlerIndex) => parseCommand(
            handler,
            collector,
            source.file,
            eventName,
            directHandler ? groupPointer : `${groupPointer}/hooks/${handlerIndex}`,
          ))
          .filter((item): item is CompatHookCommand => item !== undefined)
        if (commands.length === 0) continue
        hooks.push({
          id: `${descriptor.format}:${stableId([source.file, eventName, groupIndex, matcher, commands])}`,
          event: mapped[0],
          dshEvent: mapped[1],
          dialect: descriptor.format,
          runtime: runtimeProfile(descriptor.format, mapped[0]),
          ...(matcher === undefined ? {} : { matcher }),
          commands,
          sourceFile: source.file,
        })
        collector.add('info', 'HOOK_DISCOVERED', 'hook', `发现 Hook：${eventName}`, source.file)
      }
    }
  }
  return hooks
}
