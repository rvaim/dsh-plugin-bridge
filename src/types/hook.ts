import type { CompatPluginEnvironmentBindings } from './environment.js'
import type { CompatRuntimeValue } from './path.js'

/** 来源标识仅供诊断，不限制可接入的解析协议。 */
export type CompatHookDialect = string

export type CompatHookEvent =
  | 'session-start'
  | 'session-end'
  | 'setup'
  | 'user-prompt-submit'
  | 'user-prompt-expansion'
  | 'pre-tool-use'
  | 'permission-request'
  | 'permission-denied'
  | 'post-tool-use'
  | 'post-tool-use-failure'
  | 'post-tool-batch'
  | 'notification'
  | 'message-display'
  | 'stop'
  | 'stop-failure'
  | 'interrupt'
  | 'subagent-start'
  | 'subagent-stop'
  | 'task-created'
  | 'task-completed'
  | 'teammate-idle'
  | 'instructions-loaded'
  | 'config-change'
  | 'cwd-changed'
  | 'directory-added'
  | 'file-changed'
  | 'worktree-create'
  | 'worktree-remove'
  | 'pre-compact'
  | 'post-compact'
  | 'pre-model-switch'
  | 'post-model-switch'
  | 'elicitation'
  | 'elicitation-result'

export type CompatHookWireEventName =
  | 'SessionStart' | 'SessionEnd' | 'Setup'
  | 'UserPromptSubmit' | 'UserPromptExpansion'
  | 'PreToolUse' | 'PermissionRequest' | 'PermissionDenied'
  | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch'
  | 'Notification' | 'MessageDisplay'
  | 'Stop' | 'StopFailure' | 'Interrupt'
  | 'SubagentStart' | 'SubagentStop'
  | 'TaskCreated' | 'TaskCompleted' | 'TeammateIdle'
  | 'InstructionsLoaded' | 'ConfigChange' | 'CwdChanged' | 'DirectoryAdded' | 'FileChanged'
  | 'WorktreeCreate' | 'WorktreeRemove'
  | 'PreCompact' | 'PostCompact' | 'PreModelSwitch' | 'PostModelSwitch'
  | 'Elicitation' | 'ElicitationResult'

export type DshHookEvent =
  | 'agent/created'
  | 'agent/pre-step'
  | 'tools/pre-execute'
  | 'tools/post-execute'
  | 'agent/turn-stopping'
  | 'subagent/start'
  | 'subagent/end'
  | 'unsupported'

/**
 * parser 已经完成旧 Hook 方言到运行语义的归一化。
 * adapter 只读取这些字段，不再根据原始配置文件或插件来源猜测行为。
 */
export interface CompatHookRuntimeProfile {
  /** 传给 hook 协议 codec 的事件判别名；两个当前方言都使用 PascalCase。 */
  wireEventName: CompatHookWireEventName
  /** 已验证的 matcher 语法，不从来源标识推断。 */
  matcherSyntax: 'all' | 'exact' | 'regex'
  matcherSeparator: 'pipe' | 'pipe-or-comma'
  /** 事件默认超时由解析模块显式提供，宿主可配置覆盖。 */
  defaultTimeoutSec?: number
  /** stdin JSON 后是否追加换行。 */
  trailingNewline: boolean
  /** 成功的非 JSON stdout 是否转换为 additionalContext。 */
  plainStdoutAsContext: boolean
  /** 解析协议显式提供路径变量绑定。 */
  environmentBindings?: CompatPluginEnvironmentBindings
  /** transcript_path 缺失时的约定。 */
  missingTranscriptPath: 'empty-string' | 'null'
  /** 是否加入 model / permission_mode 字段。 */
  includeModelPermissionFields: boolean
  /** 是否加入字符串形式的 turn_id。 */
  includeTurnId: boolean
  /** tool_input 的兼容形状。 */
  toolInputShape: 'raw' | 'command'
  /** PreToolUse 的 ask 是否映射为 DSH ask。 */
  honorPreToolAsk: boolean
  /** Stop payload 是否加入 last_assistant_message（没有文本时为 null）。 */
  includeNullLastAssistantMessage: boolean
}

export interface CompatHookCommand {
  command: CompatRuntimeValue
  /** 存在时按 argv 直接执行，即使数组为空也不经过 Shell。 */
  args?: CompatRuntimeValue[]
  timeoutSec?: number
  detached?: boolean
  onFailure?: 'continue' | 'block'
  executionMode?: 'shell' | 'exec'
  shell?: 'bash' | 'powershell'
  /** 仅保留无凭据风险的展示文本；其他文本给出诊断后省略。 */
  statusMessage?: string
}

/** 可检查但不可执行的合法 handler；原配置只保留包内 JSON 引用。 */
export interface CompatHookHandlerDeclaration {
  type: 'command' | 'http' | 'mcp_tool' | 'prompt' | 'agent'
  sourceFile: string
  pointer: string
  runtimeSupport: 'unsupported'
  configuration?: CompatRuntimeValue
  groupConfiguration?: CompatRuntimeValue
  behavior?: {
    if?: CompatRuntimeValue
    async?: boolean
    asyncRewake?: boolean
    onFailure?: 'continue' | 'block'
  }
}

export interface CompatHook {
  id: string
  event: CompatHookEvent
  dshEvent: DshHookEvent
  dialect: CompatHookDialect
  runtime: CompatHookRuntimeProfile
  /** 保持旧插件 matcher 的原始语义，不在 parser 中改名。 */
  matcher?: string
  commands: CompatHookCommand[]
  /** 合法事件或组中没有可运行 handler 时为 unsupported。 */
  runtimeSupport?: 'supported' | 'unsupported'
  handlers?: CompatHookHandlerDeclaration[]
  sourceFile: string
}
