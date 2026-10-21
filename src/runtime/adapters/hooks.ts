import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { CompatHook } from '../../types/hook.js'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CapabilityRuntimeHealth } from '../../types/runtime.js'
import type { DshContextLike } from '../context.js'
import type { HookOutputLike, MergedHookOutcomeLike, RuntimeDependencies } from '../dependencies.js'
import { buildPluginEnvironment } from '../environment.js'
import { createHookExecutor } from '../hook-executor.js'
import { createHookSessionReader } from '../hook-session.js'
import { redactSensitiveText } from '../redaction.js'
import { resolveRuntimeValue } from '../value.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin-bridge': { kind: 'plugin-bridge'; plugin: string }
  }
}

interface BridgeHookInvocation {
  turn?: number
  point: string
  handlerId: string
  dialect: string
  matcher?: string
}

interface BridgeHookResult {
  turn?: number
  point: string
  handlerId: string
  decision: string
  exitCode?: number
  stderrSummary?: string
  durationMs: number
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:plugin-bridge/hook-invoked': BridgeHookInvocation
    'plugin:plugin-bridge/hook-result': BridgeHookResult
  }
}

interface HookAdapterOptions {
  workspaceRoot: string
  sourceRoot?: string
  defaultTimeoutMs?: number
  stderrSummaryMaxChars?: number
  modelName?: string
  onHealth?(health: CapabilityRuntimeHealth): void
}

interface RunPointOptions {
  agent?: Agent
  turn?: number
  signal: AbortSignal
}

function flattenText(content: UserMessage['content']): string {
  return content.filter(item => item.type === 'text').map(item => item.text).join('')
}

function injectedContext(pluginId: string, texts: readonly string[]): UserMessage | undefined {
  if (texts.length === 0) return undefined
  return {
    id: MessageId(randomUUID()),
    role: 'user',
    content: texts.map(text => ({ type: 'text', text })),
    source: { kind: 'plugin-bridge', plugin: `plugin-bridge:${pluginId}` },
  }
}

function matches(hook: CompatHook, query: string): boolean {
  const pattern = hook.matcher
  if (pattern === undefined || pattern === '' || pattern === '*') return true
  const syntax = hook.runtime.matcherSyntax
  if (syntax === 'all') return true
  if (syntax === 'exact') return pattern.split(hook.runtime.matcherSeparator === 'pipe' ? /\|/ : /[|,]/)
    .some(value => value.trim() === query)
  return new RegExp(pattern).test(query)
}

function blockOutput(reason: string, output?: HookOutputLike): HookOutputLike {
  return { exitCode: undefined, stdout: '', stderr: reason, ...output, decision: 'block', reason }
}

/** Recognized output that the Host cannot faithfully honor must never become an allow. */
function applyOutput(hook: CompatHook, output: HookOutputLike): HookOutputLike {
  let raw: unknown
  if (/^[\[{]/.test(output.stdout.trim())) {
    try { raw = JSON.parse(output.stdout) } catch { return output }
  }
  const specific = typeof raw === 'object' && raw !== null && 'hookSpecificOutput' in raw ? raw.hookSpecificOutput : undefined
  if (typeof specific === 'object' && specific !== null
    && ('updatedInput' in specific || 'updatedMCPToolOutput' in specific
      || ('permissionDecision' in specific && specific.permissionDecision === 'defer'))) {
    return blockOutput('Hook 请求了当前 DSH 未适配的输入、结果重写或延迟执行，已阻止继续', output)
  }
  if (hook.event === 'pre-tool-use' && output.decision === 'ask' && !hook.runtime.honorPreToolAsk) {
    return blockOutput('当前 Hook 运行配置不支持此 PreToolUse ask 决策，未降级为 allow', output)
  }
  if (hook.runtime.plainStdoutAsContext && output.exitCode === 0 && output.additionalContext === undefined
    && output.stdout !== '' && !/^[\[{]/.test(output.stdout.trim())) {
    return { ...output, additionalContext: output.stdout }
  }
  return output
}

function malformedOutput(output: HookOutputLike, eventName: string): boolean {
  if (!/^[\[{]/.test(output.stdout.trim())) return false
  try {
    const value = JSON.parse(output.stdout)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
    for (const key of ['continue', 'suppressOutput']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return true
    for (const key of ['stopReason', 'systemMessage', 'reason', 'terminalSequence']) if (value[key] !== undefined && typeof value[key] !== 'string') return true
    if (value.decision !== undefined && !['approve', 'block'].includes(value.decision)) return true
    const specific = value.hookSpecificOutput
    if (specific !== undefined) {
      if (specific === null || typeof specific !== 'object' || Array.isArray(specific) || specific.hookEventName !== eventName) return true
      if (specific.permissionDecision !== undefined && !['allow', 'deny', 'ask', 'defer'].includes(specific.permissionDecision)) return true
      for (const key of ['permissionDecisionReason', 'additionalContext']) if (specific[key] !== undefined && typeof specific[key] !== 'string') return true
    }
    return false
  } catch { return true }
}

export async function registerHooks(
  ctx: DshContextLike,
  plugin: CompatPlugin,
  packageRoot: string,
  dataRoot: string,
  dependencies: RuntimeDependencies,
  options: HookAdapterOptions,
): Promise<CapabilityRuntimeHealth[]> {
  if (plugin.hooks.length === 0) return []
  if (ctx.on === undefined) throw new Error('DSH 未提供 ctx.on，无法注册 Hook')
  if (ctx.shell === undefined && plugin.hooks.some(hook => hook.commands.some(command => command.args === undefined))) {
    throw new Error('DSH 未提供 ctx.shell，无法注册 Shell Hook')
  }
  if (plugin.hooks.some(hook => hook.runtimeSupport === 'unsupported' || hook.dshEvent === 'unsupported' || (hook.handlers?.length ?? 0) > 0)) {
    throw new Error('插件含运行未适配的 Hook，不能部分注册后宣称整体运行')
  }
  const protocol = await dependencies.loadHookProtocol()
  const detached = protocol.createDetachedRuns()
  const sessionState = createHookSessionReader(ctx, plugin.id)
  const stderrSummaryMaxChars = options.stderrSummaryMaxChars ?? protocol.DEFAULT_STDERR_SUMMARY_MAX_CHARS ?? 500
  ctx.effect(() => () => detached.drain(), `plugin-bridge:${plugin.id}:清理 Hook`)
  const byEvent = new Map<string, CompatHook[]>()
  for (const hook of plugin.hooks) {
    const list = byEvent.get(hook.dshEvent) ?? []
    list.push(hook)
    byEvent.set(hook.dshEvent, list)
  }
  const workspaceOf = (agent?: Agent): string => agent === undefined
    ? options.workspaceRoot
    : ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd ?? options.workspaceRoot
  const lastTurn = (agent?: Agent): number => agent === undefined ? 0 : sessionState(agent).turn
  const basePayload = (agent: Agent | undefined, hook: CompatHook, turn?: number): Record<string, unknown> => ({
    session_id: agent?.session?.header?.id ?? '',
    // Current persistence handles expose no transcript location.
    transcript_path: hook.runtime.missingTranscriptPath === 'null' ? null : '',
    cwd: workspaceOf(agent),
    hook_event_name: hook.runtime.wireEventName,
    ...(hook.runtime.includeModelPermissionFields ? { model: options.modelName ?? '', permission_mode: 'default' } : {}),
    ...(hook.runtime.includeTurnId ? { turn_id: String(turn ?? lastTurn(agent)) } : {}),
  })
  const cancel = (agent: Agent | undefined, merged: MergedHookOutcomeLike): void => {
    if (merged.stop) agent?.cancel({ kind: 'hook', reason: merged.stopReason ?? 'Hook 请求停止' })
  }
  const report = (hook: CompatHook, failure?: string): void => {
    options.onHealth?.({ capability: 'hook', name: hook.id, status: failure === undefined ? 'running' : 'degraded',
      ...(failure === undefined ? {} : { message: failure }) })
  }

  const runPoint = async (
    dshEvent: string,
    matchQuery: string,
    payloadFactory: (hook: CompatHook) => unknown,
    run: RunPointOptions,
  ): Promise<MergedHookOutcomeLike> => {
    const outputs: HookOutputLike[] = []
    for (const hook of byEvent.get(dshEvent) ?? []) {
      if (!matches(hook, matchQuery)) continue
      const failures: string[] = []
      for (const [index, command] of hook.commands.entries()) {
        const operation = async (): Promise<HookOutputLike> => {
          const sensitive = new Set<string>()
          const session = run.agent?.session
          const point = hook.runtime.wireEventName
          const handlerId = `${hook.id}:${index}`
          const started = performance.now()
          let output: HookOutputLike
          let failure: string | undefined
          const recordTurn = run.turn
          const writeRecord = session !== undefined
          if (writeRecord) appendPluginRecord(session, 'plugin:plugin-bridge/hook-invoked', {
            ...(recordTurn === undefined ? {} : { turn: recordTurn }), point, handlerId, dialect: hook.dialect,
            ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          })
          try {
            const cwd = workspaceOf(run.agent)
            const resolvedCommand = await resolveRuntimeValue(ctx, command.command, packageRoot, dataRoot, cwd, sensitive, options.sourceRoot)
            const args = command.args === undefined ? undefined : await Promise.all(command.args.map(arg =>
              resolveRuntimeValue(ctx, arg, packageRoot, dataRoot, cwd, sensitive, options.sourceRoot)))
            const signal = AbortSignal.any([run.signal, detached.signal])
            const executor = createHookExecutor(ctx, { args, shell: command.shell, signal })
            const result = await protocol.runHook(executor, {
              command: resolvedCommand,
              ...(command.timeoutSec === undefined ? {} : { timeoutSec: command.timeoutSec }),
            }, {
              payload: payloadFactory(hook),
              env: buildPluginEnvironment(hook.runtime.environmentBindings, packageRoot, dataRoot, cwd),
              cwd,
              signal,
              trailingNewline: hook.runtime.trailingNewline,
              defaultTimeoutMs: options.defaultTimeoutMs ?? (hook.runtime.defaultTimeoutSec === undefined
                ? protocol.DEFAULT_HOOK_TIMEOUT_MS ?? 600_000 : hook.runtime.defaultTimeoutSec * 1_000),
              expectedEventName: point,
            }, () => performance.now())
            output = result.output
            failure = executor.failure ?? (output.exitCode === undefined ? output.stderr || 'Hook 未执行成功'
              : output.exitCode !== 0 && output.exitCode !== 2 ? `Hook 异常退出：${output.exitCode}`
                : malformedOutput(output, point) ? 'Hook 输出不是有效的结构化 JSON' : undefined)
            if (failure !== undefined && command.onFailure === 'block' && hook.event !== 'stop' && hook.event !== 'subagent-stop') output = blockOutput(failure, output)
            output = applyOutput(hook, output)
          } catch (error) {
            failure = redactSensitiveText(String(error), sensitive)
            output = command.onFailure === 'block' && hook.event !== 'stop' && hook.event !== 'subagent-stop' ? blockOutput(failure) : { exitCode: undefined, stdout: '', stderr: failure }
          }
          output = {
            ...output,
            stderr: redactSensitiveText(output.stderr, sensitive),
            ...(output.reason === undefined ? {} : { reason: redactSensitiveText(output.reason, sensitive) }),
            ...(output.stopReason === undefined ? {} : { stopReason: redactSensitiveText(output.stopReason, sensitive) }),
            ...(output.systemMessage === undefined ? {} : { systemMessage: redactSensitiveText(output.systemMessage, sensitive) }),
            ...(output.additionalContext === undefined ? {} : { additionalContext: redactSensitiveText(output.additionalContext, sensitive) }),
          }
          if (failure !== undefined) {
            const summary = redactSensitiveText(failure, sensitive)
            failures.push(summary)
            ctx.logger.warn(`plugin-bridge: ${plugin.id}/${point}：${summary}`)
          }
          if (output.systemMessage !== undefined) ctx.logger.warn(`plugin-bridge: ${plugin.id}/${point}：${redactSensitiveText(output.systemMessage, sensitive)}`)
          if (writeRecord) appendPluginRecord(session, 'plugin:plugin-bridge/hook-result', {
            ...(recordTurn === undefined ? {} : { turn: recordTurn }), point, handlerId,
            decision: output.decision ?? (failure === undefined ? output.continue === false ? 'stop' : 'pass' : 'error'),
            ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
            stderrSummary: output.stderr.slice(0, stderrSummaryMaxChars), durationMs: performance.now() - started,
          })
          return output
        }
        if (command.detached === true) {
          detached.track(operation().then(output => {
            report(hook, failures[0])
            if (output.additionalContext !== undefined) {
              const context = injectedContext(plugin.id, [output.additionalContext])
              if (!detached.signal.aborted && context !== undefined) run.agent?.inject?.(context)
            }
          }).catch(error => {
            report(hook, '异步 Hook 执行失败')
            ctx.logger.warn(`plugin-bridge: ${plugin.id} 异步 Hook 执行失败：${redactSensitiveText(String(error))}`)
          }))
        } else outputs.push(await operation())
      }
      report(hook, failures[0])
    }
    return protocol.mergeHookOutputs(outputs)
  }

  const on = ctx.on.bind(ctx)
  if (byEvent.has('agent/created')) {
    on('agent/created', async ({ agent, source, signal }) => {
      const merged = await runPoint('agent/created', String(source ?? ''), hook => ({ ...basePayload(agent, hook), source }),
        { agent, signal: signal ?? detached.signal })
      cancel(agent, merged)
      if (merged.decision === 'deny' || merged.stop) throw new Error(merged.stopReason ?? merged.reason ?? 'SessionStart Hook 阻止初始化')
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (context !== undefined) agent?.inject?.(context)
    })
  }
  if (byEvent.has('agent/pre-step')) {
    on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
      if (!Array.isArray(messages) || messages.length === 0) return await next()
      const prompt = messages.map(message => flattenText(message.content)).join('')
      const merged = await runPoint('agent/pre-step', '', hook => ({ ...basePayload(agent, hook, turn), prompt }), { agent, turn, signal })
      cancel(agent, merged)
      if (merged.decision === 'deny' || merged.stop) return { kind: 'reject' }
      const downstream = await next()
      const context = injectedContext(plugin.id, merged.additionalContext)
      return context === undefined || downstream?.kind !== 'enter' ? downstream
        : { ...downstream, messages: [...(downstream.messages ?? []), context] }
    })
  }
  if (byEvent.has('tools/pre-execute')) {
    on('tools/pre-execute', async (exec, next) => {
      const agent = exec.agent
      const turn = lastTurn(agent)
      const merged = await runPoint('tools/pre-execute', String(exec.name ?? ''), hook => ({
        ...basePayload(agent, hook, turn), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId,
      }), { agent, turn, signal: exec.signal ?? detached.signal })
      cancel(agent, merged)
      if (merged.stop || merged.decision === 'deny') return { kind: 'deny', reason: merged.stopReason ?? merged.reason ?? '被 PreToolUse Hook 阻止' }
      if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason === undefined ? {} : { reason: merged.reason }) }
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (context !== undefined) agent?.inject?.(context)
      return await next()
    })
  }
  if (byEvent.has('tools/post-execute')) {
    on('tools/post-execute', async (exec, result, next) => {
      if (result?.isError === true) return await next()
      const agent = exec.agent
      const turn = lastTurn(agent)
      const merged = await runPoint('tools/post-execute', String(exec.name ?? ''), hook => ({
        ...basePayload(agent, hook, turn), tool_name: exec.name, tool_input: exec.arguments,
        tool_use_id: exec.callId, tool_response: result?.value ?? result?.content ?? null,
      }), { agent, turn, signal: exec.signal ?? detached.signal })
      cancel(agent, merged)
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (merged.stop || merged.decision === 'deny') return {
        kind: 'block', feedback: [{ type: 'text', text: merged.stopReason ?? merged.reason ?? '被 PostToolUse Hook 阻止' }],
        ...(context === undefined ? {} : { additionalContexts: [context] }),
      }
      const downstream = await next()
      return context === undefined ? downstream : { ...downstream, additionalContexts: [context, ...(downstream?.additionalContexts ?? [])] }
    })
  }
  const stopContinuations = new WeakMap<object, { turn: number; count: number }>()
  if (byEvent.has('agent/turn-stopping')) {
    on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      const state = sessionState(agent)
      const prior = stopContinuations.get(agent)
      const count = prior !== undefined && prior.turn === turn ? prior.count : 0
      const merged = await runPoint('agent/turn-stopping', '', hook => ({
        ...basePayload(agent, hook, turn), stop_hook_active: count > 0,
        ...(hook.runtime.includeNullLastAssistantMessage ? { last_assistant_message: state.assistantTurn === turn ? state.assistantText : null } : {}),
      }), { agent, turn, signal })
      cancel(agent, merged)
      const feedback = [...(merged.decision === 'deny' ? [merged.reason ?? 'Stop Hook 请求继续'] : []), ...merged.additionalContext]
      if (!merged.stop && feedback.length > 0) {
        if (count >= 8) ctx.logger.warn(`plugin-bridge: ${plugin.id} Stop Hook 已达到八次续步上限`)
        else {
          stopContinuations.set(agent, { turn, count: count + 1 })
          const context = injectedContext(plugin.id, feedback)
          if (context !== undefined) agent.steer(context)
        }
      } else stopContinuations.delete(agent)
    })
  }
  if (byEvent.has('subagent/start')) on('subagent/start', info => {
    const child = ctx.get('agents')?.get(info.id)
    detached.track(runPoint('subagent/start', 'general-purpose', hook => ({
      ...basePayload(child, hook), agent_id: info.id, agent_type: 'general-purpose',
    }), { agent: child, signal: detached.signal }).then(merged => {
      const context = injectedContext(plugin.id, merged.additionalContext)
      if (!detached.signal.aborted && context !== undefined) child?.inject?.(context)
    }))
  })
  return plugin.hooks.map(hook => ({ capability: 'hook', name: hook.id, status: 'running' }))
}
