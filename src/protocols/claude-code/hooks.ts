import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  CompatHook,
  CompatHookCommand,
  CompatHookDialect,
  CompatHookHandlerDeclaration,
  CompatHookRuntimeProfile,
} from '../../types/hook.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { readJson } from '../../shared/fs.js'
import { classifyMatcher, validateMatcher } from './matcher.js'
import { asObject } from '../../shared/object.js'
import { deferredJson, escapeJsonPointer, parsePotentialSecretValue } from './template.js'
import { hookEventDefinition, type HookEventDefinition } from './events.js'

const LEGAL_HANDLERS: Record<CompatHookDialect, ReadonlySet<string>> = {
  codex: new Set(['command', 'mcp_tool']),
  'claude-code': new Set(['command', 'http', 'mcp_tool', 'prompt', 'agent']),
}
const FORMAT = 'claude-code' as CompatHookDialect
const DISPLAY_FIELDS = new Set(['description', 'name', 'label', 'displayName'])
const METADATA_FIELDS = new Set(['description', '$schema', 'modules'])
const COMMON_FIELDS = new Set(['type', 'timeout', 'timeoutSec', 'statusMessage', 'once', 'if'])
const COMMAND_FIELDS = new Set([...COMMON_FIELDS, 'command', 'args', 'async', 'asyncRewake', 'detached', 'shell', 'onFailure'])
const NON_COMMAND_FIELDS: Record<string, ReadonlySet<string>> = {
  http: new Set([...COMMON_FIELDS, 'url', 'headers', 'allowedEnvVars', 'onFailure']),
  mcp_tool: new Set([...COMMON_FIELDS, 'server', 'tool', 'input']),
  prompt: new Set([...COMMON_FIELDS, 'prompt', 'model']),
  agent: new Set([...COMMON_FIELDS, 'prompt', 'model']),
}

function runtimeProfile(
  _dialect: CompatHookDialect,
  definition: HookEventDefinition,
  matcher: string | undefined,
): CompatHookRuntimeProfile {
  const event = definition.event
  return {
    wireEventName: definition.wireEventName,
    ...classifyMatcher(matcher, definition.wireEventName),
    trailingNewline: true,
    plainStdoutAsContext: event === 'session-start' || event === 'user-prompt-submit',
    environmentBindings: { CLAUDE_PLUGIN_ROOT: 'plugin-root', CLAUDE_PLUGIN_DATA: 'plugin-data', CLAUDE_PROJECT_DIR: 'workspace-root' },
    defaultTimeoutSec: event === 'user-prompt-submit' ? 30 : 600,
    missingTranscriptPath: 'empty-string',
    includeModelPermissionFields: false,
    includeTurnId: false,
    toolInputShape: 'raw',
    honorPreToolAsk: true,
    includeNullLastAssistantMessage: false,
  }
}

function stableId(values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)
}

function declaration(
  object: Record<string, unknown>,
  type: CompatHookHandlerDeclaration['type'],
  sourceFile: string,
  pointer: string,
): CompatHookHandlerDeclaration {
  return {
    type, sourceFile, pointer, runtimeSupport: 'unsupported',
    configuration: deferredJson(sourceFile, pointer, true),
    ...((object.if !== undefined || object.async !== undefined || object.asyncRewake !== undefined || object.onFailure !== undefined) ? {
      behavior: {
        ...(object.if === undefined ? {} : { if: deferredJson(sourceFile, `${pointer}/if`, true) }),
        ...(typeof object.async === 'boolean' ? { async: object.async } : {}),
        ...(typeof object.asyncRewake === 'boolean' ? { asyncRewake: object.asyncRewake } : {}),
        ...((object.onFailure === 'continue' || object.onFailure === 'block') ? { onFailure: object.onFailure } : {}),
      },
    } : {}),
  }
}

interface ParsedHandler {
  command?: CompatHookCommand
  declaration?: CompatHookHandlerDeclaration
}

function parseHandler(
  raw: unknown,
  dialect: CompatHookDialect,
  definition: HookEventDefinition,
  collector: DiagnosticCollector,
  sourceFile: string,
  pointer: string,
  directHandler: boolean,
  unsupportedGroupPointer?: string,
): ParsedHandler {
  const object = asObject(raw)
  const eventName = definition.wireEventName
  const add = (level: 'error' | 'warning', code: string, message: string): void =>
    collector.add(level, code, 'hook', `Hook ${eventName} ${message}`, sourceFile, { pointer })
  if (object === undefined) {
    add('error', 'HOOK_HANDLER_INVALID', 'handler 必须是对象')
    return {}
  }
  // 旧本地格式允许省略 type；保留扩展但不把它当上游原生格式。
  const type = object.type === undefined && object.command !== undefined ? 'command' : object.type
  if (typeof type !== 'string' || !LEGAL_HANDLERS[dialect].has(type)) {
    add('error', 'HOOK_HANDLER_TYPE_INVALID', 'handler type 不是当前平台的合法类型')
    return {}
  }
  const handlerType = type as CompatHookHandlerDeclaration['type']
  const retained = declaration(object, handlerType, sourceFile, pointer)
  if (unsupportedGroupPointer !== undefined) retained.groupConfiguration = deferredJson(sourceFile, unsupportedGroupPointer, true)
  if (object.type === undefined) add('warning', 'HOOK_LEGACY_HANDLER', '省略 type 的 command handler 是历史兼容扩展')
  let invalid = false
  const invalidField = (code: string, message: string): void => { invalid = true; add('error', code, message) }
  const fields = type === 'command' ? COMMAND_FIELDS : NON_COMMAND_FIELDS[type]
  for (const field of Object.keys(object)) {
    if (fields.has(field) || (directHandler && field === 'matcher')) continue
    if (DISPLAY_FIELDS.has(field)) {
      add('warning', 'HOOK_DISPLAY_FIELD_IGNORED', '展示字段未映射，扫描结果不复制其文本')
    } else {
      invalidField('HOOK_HANDLER_FIELD_UNSUPPORTED', '含尚未实现的 handler 字段，保留声明并停止该 handler 的运行映射')
    }
  }
  for (const field of ['timeout', 'timeoutSec']) {
    const value = object[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      invalidField('HOOK_TIMEOUT_INVALID', 'timeout 必须为正数')
    }
  }
  if (object.timeout !== undefined && object.timeoutSec !== undefined && object.timeout !== object.timeoutSec) {
    invalidField('HOOK_TIMEOUT_CONFLICT', 'timeout 与历史 timeoutSec 扩展冲突')
  }
  for (const field of ['async', 'asyncRewake', 'detached', 'once']) {
    if (object[field] !== undefined && typeof object[field] !== 'boolean') invalidField('HOOK_HANDLER_FIELD_INVALID', '布尔行为字段类型无效')
  }
  if (object.if !== undefined) {
    invalidField(typeof object.if === 'string' ? 'HOOK_CONDITION_RUNTIME_UNSUPPORTED' : 'HOOK_HANDLER_FIELD_INVALID',
      'if 条件尚未实现，保留条件声明且不运行该 handler')
  }
  if (object.asyncRewake === true) invalidField('HOOK_ASYNC_REWAKE_RUNTIME_UNSUPPORTED', 'asyncRewake 尚未实现，保留声明且不运行该 handler')
  if (object.once !== undefined) add('warning', 'HOOK_ONCE_IGNORED', 'once 对普通 plugin hook 不生效，仅 skill frontmatter 支持')
  if (object.statusMessage !== undefined) {
    if (typeof object.statusMessage !== 'string') invalidField('HOOK_HANDLER_FIELD_INVALID', 'statusMessage 必须是字符串')
    else add('warning', 'HOOK_STATUS_MESSAGE_IGNORED', 'statusMessage 尚未显示，扫描结果不复制其文本')
  }
  if (object.onFailure !== undefined && object.onFailure !== 'continue' && object.onFailure !== 'block') {
    invalidField('HOOK_ON_FAILURE_INVALID', 'onFailure 必须为 continue 或 block')
  }
  if (object.onFailure !== undefined && (object.async === true || object.asyncRewake === true || object.detached === true)) {
    if (object.onFailure === 'block') invalidField('HOOK_ON_FAILURE_ASYNC_CONFLICT', 'onFailure:block 不能为后台 hook 提供失败阻断保证')
    else add('warning', 'HOOK_ON_FAILURE_IGNORED', '后台 hook 的 onFailure 按上游规则不生效')
  }
  if (object.onFailure !== undefined && ['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle'].includes(eventName)) {
    add('warning', 'HOOK_ON_FAILURE_IGNORED', '当前事件的 onFailure 按上游规则不生效')
  }
  if (type !== 'command') {
    const required = type === 'http' ? ['url'] : type === 'mcp_tool' ? ['server', 'tool'] : ['prompt']
    if (required.some(field => typeof object[field] !== 'string' || (object[field] as string).trim() === '')) {
      invalidField('HOOK_HANDLER_INVALID', 'handler 缺少必需的非空字符串字段')
    }
    add('error', 'HOOK_UNSUPPORTED_HANDLER', 'handler 类型合法但 DSH 尚未实现其运行语义，已保留声明')
    return { declaration: retained }
  }
  if (typeof object.command !== 'string' || object.command.trim() === '') invalidField('HOOK_COMMAND_MISSING', 'command 必须是非空字符串')
  if (object.args !== undefined && (!Array.isArray(object.args) || object.args.some(item => typeof item !== 'string'))) {
    invalidField('HOOK_ARGS_INVALID', 'args 必须是字符串数组')
  }
  if (object.shell !== undefined && object.shell !== 'bash' && object.shell !== 'powershell') invalidField('HOOK_SHELL_INVALID', 'shell 必须为 bash 或 powershell')
  if (object.args !== undefined && object.shell !== undefined) add('warning', 'HOOK_SHELL_IGNORED', 'exec form 按上游规则忽略 shell')
  if (object.args === undefined && object.shell === 'powershell') invalidField('HOOK_SHELL_RUNTIME_UNSUPPORTED', '显式 PowerShell shell form 尚未适配，已保留声明')
  if (object.async !== undefined && object.detached !== undefined && object.async !== object.detached) invalidField('HOOK_ASYNC_CONFLICT', 'async 与历史 detached 扩展冲突')
  if (object.detached !== undefined) add('warning', 'HOOK_LEGACY_HANDLER', 'detached 是历史兼容扩展，请使用 async')
  if (object.timeoutSec !== undefined && dialect === 'claude-code') add('warning', 'HOOK_LEGACY_HANDLER', 'timeoutSec 是历史兼容扩展，请使用 timeout')
  if (dialect === 'codex' && ['args', 'shell', 'onFailure', 'once'].some(field => object[field] !== undefined)) {
    add('warning', 'HOOK_LEGACY_HANDLER', '含传统 Codex 原生 schema 以外的历史 command 扩展')
  }
  if (invalid || definition.dshEvent === 'unsupported' || unsupportedGroupPointer !== undefined) return { declaration: retained }
  const timeout = object.timeoutSec ?? object.timeout
  try {
    return { command: {
      command: parsePotentialSecretValue(object.command, sourceFile, `${pointer}/command`, false),
      ...(object.args === undefined ? {} : {
        args: (object.args as string[]).map((arg, index) => parsePotentialSecretValue(arg, sourceFile, `${pointer}/args/${index}`, false)),
      }),
      executionMode: object.args === undefined ? 'shell' : 'exec',
      ...(timeout === undefined ? {} : { timeoutSec: timeout as number }),
      ...((object.async === true || object.detached === true) ? { detached: true } : {}),
      ...((object.onFailure === 'continue' || object.onFailure === 'block') ? { onFailure: object.onFailure } : {}),
      ...((object.shell === 'bash' || object.shell === 'powershell') ? { shell: object.shell } : {}),
    } }
  } catch {
    add('error', 'HOOK_TEMPLATE_UNSUPPORTED', 'command 或 args 模板语法尚未实现，已保留声明且不会运行')
    return { declaration: retained }
  }
}

export async function parseHooksForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatHook[]> {
  const hooks: CompatHook[] = []
  for (const source of descriptor.hookSources) {
    const inline = source.inline !== undefined
    let raw: unknown
    try {
      raw = inline ? source.inline : await readJson(resolve(packageRoot, source.file))
    } catch {
      collector.add('error', 'HOOK_CONFIG_INVALID', 'hook', 'Hook 配置无法读取为 JSON 对象', source.file)
      continue
    }
    const root = asObject(raw)
    if (root === undefined) {
      collector.add('error', 'HOOK_CONFIG_INVALID', 'hook', 'Hook 配置顶层必须是对象', source.file)
      continue
    }
    if (FORMAT === 'claude-code' && Object.hasOwn(root, 'modules')) {
      collector.add('error', 'HOOK_MODULES_RUNTIME_UNSUPPORTED', 'hook', 'Claude Code JavaScript hook modules 尚未支持；此配置不会导入模块或映射运行', source.file)
      continue
    }
    const wrapped = Object.hasOwn(root, 'hooks')
    const eventRoot = wrapped ? asObject(root.hooks) : root
    if (eventRoot === undefined || (FORMAT === 'claude-code' && !inline && !wrapped)) {
      collector.add('error', 'HOOK_CONFIG_INVALID', 'hook', 'Hook 配置文件必须具有 hooks 对象包装；inline 使用事件映射', source.file)
      continue
    }
    if (inline && wrapped) collector.add('warning', 'HOOK_LEGACY_WRAPPED_INLINE', 'hook', 'inline hooks 的 hooks 包装是历史兼容扩展', source.file)
    if (!inline && !wrapped) collector.add('warning', 'HOOK_LEGACY_UNWRAPPED_CONFIG', 'hook', '无 hooks 包装的配置文件是历史兼容扩展', source.file)
    const unsupportedConfig = (wrapped && Object.keys(root).some(field => field !== 'hooks' && !METADATA_FIELDS.has(field) && !DISPLAY_FIELDS.has(field)))
      || (FORMAT === 'codex' && Object.hasOwn(root, 'modules'))
    if (unsupportedConfig) collector.add('error', 'HOOK_CONFIG_FIELD_UNSUPPORTED', 'hook', 'Hook 配置含未实现的顶层行为字段，已保留声明且不会映射运行', source.file)
    const pointerBase = `${source.pointer ?? ''}${wrapped ? '/hooks' : ''}`
    for (const [eventName, rawGroups] of Object.entries(eventRoot)) {
      // Marketplace 高优先级覆盖必须在验证或产生诊断之前排除低优先级事件。
      const excluded = (source as typeof source & { excludedEvents?: string[] }).excludedEvents
      if (excluded?.includes(eventName)) continue
      if (METADATA_FIELDS.has(eventName)) continue
      const definition = hookEventDefinition(eventName)
      if (definition === undefined) {
        collector.add('error', 'HOOK_EVENT_UNKNOWN', 'hook', 'Hook 事件不在当前平台的合法事件目录中', source.file)
        continue
      }
      if (definition.legacyAlias) collector.add('warning', 'HOOK_LEGACY_EVENT_ALIAS', 'hook', `Hook ${definition.wireEventName} 的 snake_case 名称是历史兼容扩展`, source.file)
      if (definition.dshEvent === 'unsupported') collector.add('error', 'HOOK_EVENT_RUNTIME_UNSUPPORTED', 'hook', `Hook ${definition.wireEventName} 合法，但当前 DSH 尚无运行映射；已保留声明`, source.file)
      if (!Array.isArray(rawGroups)) collector.add('warning', 'HOOK_LEGACY_DIRECT_GROUP', 'hook', `Hook ${definition.wireEventName} 的单组对象是历史兼容扩展`, source.file)
      const groups = Array.isArray(rawGroups) ? rawGroups : [rawGroups]
      for (const [groupIndex, rawGroup] of groups.entries()) {
        const group = asObject(rawGroup)
        if (group === undefined) {
          collector.add('error', 'HOOK_GROUP_INVALID', 'hook', `Hook ${definition.wireEventName} 分组必须是对象`, source.file)
          continue
        }
        let matcher: string | undefined
        if (!definition.supportsMatcher) {
          if (group.matcher !== undefined) collector.add('warning', 'HOOK_MATCHER_IGNORED', 'hook', `Hook ${definition.wireEventName} 不适用 matcher，已按上游规则忽略`, source.file)
        } else {
          try { matcher = validateMatcher(group.matcher, definition.wireEventName) }
          catch {
            collector.add('error', 'HOOK_MATCHER_INVALID', 'hook', `Hook ${definition.wireEventName} matcher 类型或正则语法无效`, source.file)
            continue
          }
        }
        const directHandler = group.hooks === undefined && (group.command !== undefined || group.type !== undefined)
        const rawHandlers = group.hooks ?? (directHandler ? [group] : undefined)
        if (!Array.isArray(rawHandlers)) {
          collector.add('error', 'HOOK_HANDLERS_INVALID', 'hook', `Hook ${definition.wireEventName} 的 hooks 必须是数组`, source.file)
          continue
        }
        if (directHandler) collector.add('warning', 'HOOK_LEGACY_DIRECT_HANDLER', 'hook', `Hook ${definition.wireEventName} 的直接 handler 是历史兼容扩展`, source.file)
        const unsupportedGroup = !directHandler && Object.keys(group).some(field => field !== 'matcher' && field !== 'hooks' && !DISPLAY_FIELDS.has(field))
        if (unsupportedGroup) collector.add('error', 'HOOK_GROUP_FIELD_UNSUPPORTED', 'hook', `Hook ${definition.wireEventName} 分组含未实现的行为字段，已保留声明`, source.file)
        if (!directHandler && Object.keys(group).some(field => DISPLAY_FIELDS.has(field))) collector.add('warning', 'HOOK_DISPLAY_FIELD_IGNORED', 'hook', 'Hook 分组展示字段未映射，扫描结果不复制其文本', source.file)
        const eventPointer = `${pointerBase}/${escapeJsonPointer(eventName)}`
        const groupPointer = Array.isArray(rawGroups) ? `${eventPointer}/${groupIndex}` : eventPointer
        const commands: CompatHookCommand[] = []
        const handlers: CompatHookHandlerDeclaration[] = []
        for (const [handlerIndex, rawHandler] of rawHandlers.entries()) {
          const parsed = parseHandler(rawHandler, 'claude-code', definition, collector, source.file,
            directHandler ? groupPointer : `${groupPointer}/hooks/${handlerIndex}`, directHandler,
            unsupportedConfig ? source.pointer ?? '' : unsupportedGroup ? groupPointer : undefined)
          if (parsed.command !== undefined) commands.push(parsed.command)
          if (parsed.declaration !== undefined) handlers.push(parsed.declaration)
        }
        if (commands.length === 0 && handlers.length === 0) continue
        hooks.push({
          id: `${'claude-code'}:${stableId([source.file, pointerBase, eventName, groupIndex, matcher, commands, handlers])}`,
          event: definition.event,
          dshEvent: definition.dshEvent,
          dialect: 'claude-code',
          runtime: runtimeProfile('claude-code', definition, matcher),
          runtimeSupport: definition.dshEvent === 'unsupported' || commands.length === 0 ? 'unsupported' : 'supported',
          ...(matcher === undefined ? {} : { matcher }),
          commands,
          ...(handlers.length === 0 ? {} : { handlers }),
          sourceFile: source.file,
        })
        collector.add('info', 'HOOK_DISCOVERED', 'hook', `发现 Hook：${definition.wireEventName}`, source.file)
      }
    }
  }
  return hooks
}
