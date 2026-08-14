export function validateMatcher(matcher: unknown, dialect: 'claude-code' | 'codex'): string | undefined {
  if (matcher === undefined || matcher === null || matcher === '') return undefined
  if (typeof matcher !== 'string') throw new Error('matcher 必须是字符串')
  if (dialect === 'codex') {
    try { new RegExp(matcher) } catch (error) { throw new Error(`Codex matcher 不是有效正则：${String(error)}`) }
  }
  return matcher
}
