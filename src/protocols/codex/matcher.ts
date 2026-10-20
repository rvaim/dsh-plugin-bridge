import type { CompatHookRuntimeProfile } from '../../types/hook.js'

type MatcherProfile = Pick<CompatHookRuntimeProfile, 'matcherSyntax' | 'matcherSeparator'>

/** Codex 所有事件使用自身的窄 exact 字符集。 */
export function classifyMatcher(
  matcher: string | undefined,
  _eventName?: string,
): MatcherProfile {
  const matcherSeparator = 'pipe'
  if (matcher === undefined || matcher === '' || matcher === '*') return { matcherSyntax: 'all', matcherSeparator }
  const exact = /^[A-Za-z0-9_|]+$/
  return { matcherSyntax: exact.test(matcher) ? 'exact' : 'regex', matcherSeparator }
}

export function validateMatcher(
  matcher: unknown,
  eventName?: string,
): string | undefined {
  if (matcher === undefined || matcher === '') return undefined
  if (typeof matcher !== 'string') throw new Error('matcher 必须是字符串')
  if (matcher === '*') return undefined
  if (classifyMatcher(matcher, eventName).matcherSyntax === 'regex') {
    try { new RegExp(matcher) } catch { throw new Error('matcher 不是有效正则表达式') }
  }
  return matcher
}
