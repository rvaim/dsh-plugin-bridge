/** 将已解析凭据和常见 Token 形态从日志、错误消息中移除。 */
export function redactSensitiveText(input: string, sensitiveValues: Iterable<string> = []): string {
  let output = input
  const values = [...new Set([...sensitiveValues].filter(value => value.length >= 4))]
    .sort((left, right) => right.length - left.length)
  for (const value of values) output = output.split(value).join('[已脱敏]')

  output = output
    .replace(/\b(Bearer\s+)[^\s,;'"}]+/gi, '$1[已脱敏]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[已脱敏]')
    .replace(/([?&](?:access_?token|token|api_?key|key|secret|password)=)[^&#\s]+/gi, '$1[已脱敏]')
    .replace(/((?:authorization|access_?token|token|api[_-]?key|key|secret|password)\s*[:=]\s*)[^\s,;'"}]+/gi, '$1[已脱敏]')
  return output
}
