/**
 * 旧 Hook 的 `command + args` 最终必须交给 DSH Shell 的命令字符串接口。
 * 只有显式提供 args 时才把 command 当作单个可执行文件 Token；没有 args 的
 * command 仍保持原始 Shell 语义，兼容管道、重定向和已有的完整命令行。
 */
export function quoteShellToken(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `'${value.replaceAll("'", "''")}'`
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function composeHookCommand(
  command: string,
  args: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (args === undefined) return command
  return [command, ...args].map(value => quoteShellToken(value, platform)).join(' ')
}
