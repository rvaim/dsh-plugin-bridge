import type { CompatHookRuntimeProfile } from '../../types/hook.js'

type MatcherProfile = Pick<CompatHookRuntimeProfile, 'matcherSyntax' | 'matcherSeparator'>

/** Claude Code 的 FileChanged 与 StopFailure 使用窄 exact 字符集。 */
export function classifyMatcher(
  matcher: string | undefined,
  eventName?: string,
): MatcherProfile {
  const narrow = eventName === 'FileChanged' || eventName === 'StopFailure'
  const matcherSeparator = narrow ? 'pipe' : 'pipe-or-comma'
  if (matcher === undefined || matcher === '' || matcher === '*') return { matcherSyntax: 'all', matcherSeparator }
  const exact = narrow ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\- ,|]+$/
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
