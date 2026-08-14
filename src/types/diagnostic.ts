/** 兼容诊断级别。error 会阻止插件启用。 */
export type CompatDiagnosticLevel = 'error' | 'warning' | 'info'

/** 诊断所属能力。 */
export type CompatCapability = 'source' | 'plugin' | 'skill' | 'mcp' | 'hook' | 'command' | 'agent'

/** parser 与运行层共享的结构化诊断。 */
export interface CompatDiagnostic {
  level: CompatDiagnosticLevel
  code: string
  capability: CompatCapability
  file?: string
  message: string
  details?: Record<string, unknown>
}

export function diagnostic(
  level: CompatDiagnosticLevel,
  code: string,
  capability: CompatCapability,
  message: string,
  file?: string,
  details?: Record<string, unknown>,
): CompatDiagnostic {
  return {
    level,
    code,
    capability,
    message,
    ...(file === undefined ? {} : { file }),
    ...(details === undefined ? {} : { details }),
  }
}

export function hasErrorDiagnostics(items: readonly CompatDiagnostic[]): boolean {
  return items.some(item => item.level === 'error')
}

export function sortDiagnostics(items: readonly CompatDiagnostic[]): CompatDiagnostic[] {
  const order: Record<CompatDiagnosticLevel, number> = { error: 0, warning: 1, info: 2 }
  return [...items].sort((a, b) =>
    order[a.level] - order[b.level]
    || a.capability.localeCompare(b.capability)
    || a.code.localeCompare(b.code)
    || (a.file ?? '').localeCompare(b.file ?? ''),
  )
}
