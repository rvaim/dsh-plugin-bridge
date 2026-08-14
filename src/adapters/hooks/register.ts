import type { CompatHook } from '../../types/hook.js'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CapabilityRuntimeHealth } from '../../types/runtime.js'
import type { DshContextLike } from '../../runtime/context.js'
import type { HookOutputLike, HookProtocolLike, MergedHookOutcomeLike, RuntimeDependencies } from '../../runtime/dependencies.js'
import { buildPluginEnvironment } from '../../runtime/environment.js'
import { redactSensitiveText } from '../../runtime/redaction.js'
import { composeHookCommand } from '../../runtime/shell-command.js'
import { resolveRuntimeValue } from '../../runtime/value.js'

interface HookAdapterOptions {
  workspaceRoot: string
  defaultTimeoutMs?: number
  stderrSummaryMaxChars?: number
  codexModel?: string
}

interface RunPointOptions {
  agent?: any
  turn?: number
  signal: AbortSignal
  workspaceRoot: string
}

function flattenText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter((item): item is { type: string; text?: string } => item !== null && typeof item === 'object' && 'type' in item)
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('')
}

function sessionOf(agent: any): any {
  return agent?.session
}

function workspaceOf(agent: any, fallback: string): string {
  return agent?.session?.header?.cwd ?? fallback
}

function lastTurn(agent: any): number {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return 0
  const match = [...events].reverse().find(item => item?.type === 'turn/start')
  return typeof match?.data?.turn === 'number' ? match.data.turn : 0
}

/** Stop 发生在 assistant/message 已写入、turn/end 尚未提交的边界。 */
function lastAssistantMessage(agent: any, turn: number): string | null {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return null
  const event = [...events].reverse().find(item =>
    item?.type === 'assistant/message' && item?.data?.turn === turn)
  const text = flattenText(event?.data?.message?.content)
  return text.trim() === '' ? null : text
}

function transcriptPath(ctx: DshContextLike, agent: any): string | null {
  const persistence = ctx.get?.('sessionPersistence')
  try {
    return persistence?.locate?.(agent?.session?.header)?.path ?? null
  } catch {
    return null
  }
}

function basePayload(
  ctx: DshContextLike,
  agent: any,
  hook: CompatHook,
  workspaceRoot: string,
  turn: number | undefined,
  codexModel: string,
): Record<string, unknown> {
  const locatedTranscript = transcriptPath(ctx, agent)
  const payload: Record<string, unknown> = {
    session_id: agent?.session?.header?.id ?? '',
    transcript_path: locatedTranscript ?? (hook.runtime.missingTranscriptPath === 'null' ? null : ''),
    cwd: workspaceOf(agent, workspaceRoot),
    hook_event_name: hook.runtime.wireEventName,
  }
  if (hook.runtime.includeCodexBaseFields) {
    payload.model = codexModel
    payload.permission_mode = 'default'
  }
  if (hook.runtime.includeTurnId) payload.turn_id = String(turn ?? lastTurn(agent))
  return payload
}

function commandOf(argumentsValue: unknown): string {
  if (argumentsValue !== null && typeof argumentsValue === 'object' && 'command' in argumentsValue) {
    const value = (argumentsValue as { command?: unknown }).command
    if (typeof value === 'string') return value
  }
  return ''
}

function toolInputFor(hook: CompatHook, argumentsValue: unknown): unknown {
  return hook.runtime.toolInputShape === 'command'
    ? { command: commandOf(argumentsValue) }
    : argumentsValue
}

function hookEnvironment(
  hook: CompatHook,
  packageRoot: string,
  dataRoot: string,
  workspaceRoot: string,
): Record<string, string> {
  return buildPluginEnvironment(hook.runtime.environmentMode, packageRoot, dataRoot, workspaceRoot)
}

function applyOutputCompatibility(hook: CompatHook, output: HookOutputLike): HookOutputLike {
  if (hook.runtime.plainStdoutAsContext
    && output.exitCode === 0
    && output.additionalContext === undefined
    && typeof output.stdout === 'string'
    && output.stdout.length > 0
    && !output.stdout.startsWith('{')) {
    output.additionalContext = output.stdout
  }
  if (hook.event === 'pre-tool-use' && output.decision === 'ask' && !hook.runtime.honorPreToolAsk) {
    return { ...output, decision: undefined, reason: undefined }
  }
  return output
}

function injectedContext(pluginId: string, texts: readonly string[]): any | undefined {
  if (texts.length === 0) return undefined
  return {
    content: texts.map(text => ({ type: 'text', text })),
    source: { kind: 'plugin', plugin: `dsh-compat:${pluginId}` },
  }
}

function neutral(protocol: HookProtocolLike): MergedHookOutcomeLike {
  return protocol.mergeHookOutputs([])
}

/** 将统一 CompatHook 直接映射到当前 DSH 原生扩展点。 */
export async function registerHooks(
  ctx: DshContextLike,
  plugin: CompatPlugin,
  packageRoot: string,
  dataRoot: string,
  dependencies: RuntimeDependencies,
  options: HookAdapterOptions,
): Promise<CapabilityRuntimeHealth[]> {
  if (plugin.hooks.length === 0) return []
  if (ctx.on === undefined || ctx.shell === undefined) throw new Error('DSH 未提供 ctx.on/ctx.shell，无法注册 Hook')
  const protocol = await dependencies.loadHookProtocol()
  const detached = protocol.createDetachedRuns()
  const defaultTimeoutMs = options.defaultTimeoutMs ?? protocol.DEFAULT_HOOK_TIMEOUT_MS ?? 600_000
  const stderrSummaryMaxChars = options.stderrSummaryMaxChars ?? protocol.DEFAULT_STDERR_SUMMARY_MAX_CHARS ?? 500
  const codexModel = options.codexModel ?? ''
  ctx.effect?.(() => () => detached.drain(), `dsh-compat:${plugin.id}:清理 Hook`)
  const subagentChildren = new Map<unknown, any>()

  const byEvent = new Map<string, CompatHook[]>()
  for (const hook of plugin.hooks) {
    const list = byEvent.get(hook.dshEvent) ?? []
    list.push(hook)
    byEvent.set(hook.dshEvent, list)
  }

  const runPoint = async (
    dshEvent: string,
    matchQuery: string,
    payloadFactory: (hook: CompatHook) => unknown,
    runOptions: RunPointOptions,
  ): Promise<MergedHookOutcomeLike> => {
    const outputs: HookOutputLike[] = []
    const hooks = byEvent.get(dshEvent) ?? []
    for (const hook of hooks) {
      if (!protocol.matchesMatcher(hook.matcher, matchQuery, hook.runtime.matcherMode)) continue
      const point = hook.runtime.wireEventName
      for (const [index, command] of hook.commands.entries()) {
        const operation = async (): Promise<HookOutputLike | undefined> => {
          const workspaceRoot = workspaceOf(runOptions.agent, runOptions.workspaceRoot)
          const sensitiveValues = new Set<string>()
          const resolvedCommand = await resolveRuntimeValue(
            ctx,
            command.command,
            packageRoot,
            dataRoot,
            workspaceRoot,
            sensitiveValues,
          )
          const resolvedArgs = command.args === undefined
            ? undefined
            : await Promise.all(command.args.map(arg => resolveRuntimeValue(
              ctx,
              arg,
              packageRoot,
              dataRoot,
              workspaceRoot,
              sensitiveValues,
            )))
          const commandLine = composeHookCommand(resolvedCommand, resolvedArgs)
          const session = sessionOf(runOptions.agent)
          const handlerId = `${hook.id}:${index}`
          if (session !== undefined && runOptions.turn !== undefined) {
            protocol.appendHookInvoked?.(session, {
              turn: runOptions.turn,
              point,
              dialect: hook.dialect,
              handlerId,
              ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
            })
          }
          let output: HookOutputLike
          let durationMs: number
          try {
            const result = await protocol.runHook(ctx.shell, {
              command: commandLine,
              ...(command.timeoutSec === undefined ? {} : { timeoutSec: command.timeoutSec }),
            }, {
              payload: payloadFactory(hook),
              env: hookEnvironment(hook, packageRoot, dataRoot, workspaceRoot),
              cwd: workspaceRoot,
              signal: runOptions.signal,
              trailingNewline: hook.runtime.trailingNewline,
              defaultTimeoutMs,
              expectedEventName: point,
            }, () => performance.now())
            output = applyOutputCompatibility(hook, result.output)
            durationMs = result.durationMs
          } catch (error) {
            throw new Error(redactSensitiveText(String(error), sensitiveValues), { cause: error })
          }
          if (output.updatedInput !== undefined) {
            ctx.logger.warn(`dsh-compat: ${plugin.id}/${point} 请求 updatedInput，当前 DSH 桥不采纳该字段`)
          }
          if (output.systemMessage !== undefined) {
            ctx.logger.warn(`dsh-compat: ${plugin.id}/${point} 返回 systemMessage，当前仅记录、不注入系统消息`)
          }
          if (session !== undefined && runOptions.turn !== undefined) {
            protocol.appendHookResult?.(session, {
              turn: runOptions.turn,
              point,
              handlerId,
              output,
              stderrSummaryMaxChars,
              durationMs,
            })
          }
          return output
        }
        if (command.detached === true) {
          detached.track(operation().catch(error => {
            ctx.logger.warn(`dsh-compat: detached Hook 执行失败：${String(error)}`)
            return undefined
          }))
        } else {
          try {
            const output = await operation()
            if (output !== undefined) outputs.push(output)
          } catch (error) {
            ctx.logger.warn(`dsh-compat: Hook ${plugin.id}/${point} 执行失败：${String(error)}`)
          }
        }
      }
    }
    return outputs.length === 0 ? neutral(protocol) : protocol.mergeHookOutputs(outputs)
  }

  const on = ctx.on.bind(ctx)
  if (byEvent.has('agent/session-start')) {
    on('agent/session-start', ({ agent, source }: any) => {
      detached.track(runPoint('agent/session-start', String(source ?? ''), hook => ({
        ...basePayload(ctx, agent, hook, options.workspaceRoot, undefined, codexModel),
        source,
      }), { agent, signal: detached.signal, workspaceRoot: options.workspaceRoot }).then(merged => {
        const context = injectedContext(plugin.id, merged.additionalContext)
        if (context !== undefined) agent?.inject?.(context)
      }))
    })
  }
  if (byEvent.has('agent/pre-step')) {
    on('agent/pre-step', async ({ agent, messages, turn, signal }: any, next: () => Promise<any>) => {
      if (!Array.isArray(messages) || messages.length === 0) return await next()
      const prompt = messages.map((message: any) => flattenText(message?.content)).join('')
      const merged = await runPoint('agent/pre-step', '', hook => ({
        ...basePayload(ctx, agent, hook, options.workspaceRoot, turn, codexModel),
        prompt,
      }), { agent, turn, signal, workspaceRoot: options.workspaceRoot })
      if (merged.decision === 'deny') return { kind: 'reject' }
      const downstream = await next()
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (context === undefined || downstream?.kind !== 'enter') return downstream
      return { ...downstream, messages: [...(downstream.messages ?? []), context] }
    })
  }
  if (byEvent.has('tools/pre-execute')) {
    on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      const agent = exec?.agent
      const merged = await runPoint('tools/pre-execute', String(exec?.name ?? ''), hook => ({
        ...basePayload(ctx, agent, hook, options.workspaceRoot, lastTurn(agent), codexModel),
        tool_name: exec?.name,
        tool_input: toolInputFor(hook, exec?.arguments),
        tool_use_id: exec?.callId,
      }), { agent, turn: lastTurn(agent), signal: exec?.signal ?? detached.signal, workspaceRoot: options.workspaceRoot })
      if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? '被 dsh-compat PreToolUse Hook 阻止' }
      if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason === undefined ? {} : { reason: merged.reason }) }
      return await next()
    })
  }
  if (byEvent.has('tools/post-execute')) {
    on('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
      const agent = exec?.agent
      const merged = await runPoint('tools/post-execute', String(exec?.name ?? ''), hook => ({
        ...basePayload(ctx, agent, hook, options.workspaceRoot, lastTurn(agent), codexModel),
        tool_name: exec?.name,
        tool_input: toolInputFor(hook, exec?.arguments),
        tool_use_id: exec?.callId,
        tool_response: flattenText(result?.content),
      }), { agent, turn: lastTurn(agent), signal: exec?.signal ?? detached.signal, workspaceRoot: options.workspaceRoot })
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (merged.decision === 'deny') {
        return {
          kind: 'block',
          feedback: [{ type: 'text', text: merged.reason ?? '被 dsh-compat PostToolUse Hook 阻止' }],
          ...(context === undefined ? {} : { additionalContexts: [context] }),
        }
      }
      const downstream = await next()
      if (context === undefined) return downstream
      return { ...downstream, additionalContexts: [context, ...(downstream?.additionalContexts ?? [])] }
    })
  }
  if (byEvent.has('agent/turn-stopping')) {
    on('agent/turn-stopping', async ({ agent, turn, signal }: any) => {
      const merged = await runPoint('agent/turn-stopping', '', hook => ({
        ...basePayload(ctx, agent, hook, options.workspaceRoot, turn, codexModel),
        stop_hook_active: false,
        ...(hook.runtime.includeNullLastAssistantMessage
          ? { last_assistant_message: lastAssistantMessage(agent, turn) }
          : {}),
      }), { agent, turn, signal, workspaceRoot: options.workspaceRoot })
      if (merged.decision === 'deny') {
        agent?.steer?.({
          content: [{ type: 'text', text: merged.reason ?? 'continue: 被 dsh-compat Stop Hook 阻止' }],
          source: { kind: 'plugin', plugin: `dsh-compat:${plugin.id}` },
        })
      }
    })
  }
  if (byEvent.has('subagent/start')) {
    on('subagent/start', (info: any) => {
      const child = ctx.get?.('agents')?.get?.(info?.id)
      if (child !== undefined) subagentChildren.set(info?.runId, child)
      detached.track(runPoint('subagent/start', 'general-purpose', hook => ({
        ...basePayload(ctx, child, hook, options.workspaceRoot, undefined, codexModel),
        agent_id: info?.id,
        agent_type: 'general-purpose',
      }), { agent: child, signal: detached.signal, workspaceRoot: options.workspaceRoot }).then(merged => {
        const context = injectedContext(plugin.id, merged.additionalContext)
        if (context !== undefined) child?.inject?.(context)
      }))
    })
  }
  if (byEvent.has('subagent/end')) {
    on('subagent/end', (info: any) => {
      const child = subagentChildren.get(info?.runId) ?? ctx.get?.('agents')?.get?.(info?.id)
      subagentChildren.delete(info?.runId)
      detached.track(runPoint('subagent/end', 'general-purpose', hook => ({
        ...basePayload(ctx, child, hook, options.workspaceRoot, undefined, codexModel),
        agent_id: info?.id,
        agent_type: 'general-purpose',
        stop_hook_active: false,
      }), { agent: child, signal: detached.signal, workspaceRoot: options.workspaceRoot }))
    })
  }

  return plugin.hooks.map(hook => ({ capability: 'hook', name: hook.id, status: 'running' }))
}
