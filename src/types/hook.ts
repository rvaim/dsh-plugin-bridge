import type { CompatPluginEnvironmentMode } from './environment.js'
import type { CompatRuntimeValue } from './path.js'

export type CompatHookDialect = 'claude-code' | 'codex'

export type CompatHookEvent =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'subagent-start'
  | 'subagent-stop'

export type DshHookEvent =
  | 'agent/session-start'
  | 'agent/pre-step'
  | 'tools/pre-execute'
  | 'tools/post-execute'
  | 'agent/turn-stopping'
  | 'subagent/start'
  | 'subagent/end'

/**
 * parser 已经完成旧 Hook 方言到运行语义的归一化。
 * adapter 只读取这些字段，不再根据原始配置文件或插件来源猜测行为。
 */
export interface CompatHookRuntimeProfile {
  /** 传给 hook 协议 codec 的事件判别名；两个当前方言都使用 PascalCase。 */
  wireEventName: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop'
  /** matcher 的解释方式。 */
  matcherMode: CompatHookDialect
  /** stdin JSON 后是否追加换行。 */
  trailingNewline: boolean
  /** 成功的非 JSON stdout 是否转换为 additionalContext。 */
  plainStdoutAsContext: boolean
  /** Hook 子进程应获得的标准插件环境变量集合。 */
  environmentMode: CompatPluginEnvironmentMode
  /** transcript_path 缺失时的方言约定。 */
  missingTranscriptPath: 'empty-string' | 'null'
  /** 是否加入 Codex 的 model / permission_mode 字段。 */
  includeCodexBaseFields: boolean
  /** 是否加入字符串形式的 turn_id。 */
  includeTurnId: boolean
  /** tool_input 的兼容形状。 */
  toolInputShape: 'raw' | 'command'
  /** PreToolUse 的 ask 是否映射为 DSH ask。 */
  honorPreToolAsk: boolean
  /** Stop payload 是否加入 Codex 的 last_assistant_message（没有文本时为 null）。 */
  includeNullLastAssistantMessage: boolean
}

export interface CompatHookCommand {
  command: CompatRuntimeValue
  /** 与 command 分离的参数；存在时由 adapter 按当前 Shell 逐项安全引用。 */
  args?: CompatRuntimeValue[]
  timeoutSec?: number
  detached?: boolean
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
  sourceFile: string
}
