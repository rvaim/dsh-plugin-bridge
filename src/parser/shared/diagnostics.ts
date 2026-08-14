import type { CompatCapability, CompatDiagnostic, CompatDiagnosticLevel } from '../../types/diagnostic.js'
import { diagnostic } from '../../types/diagnostic.js'

export class DiagnosticCollector {
  readonly items: CompatDiagnostic[] = []

  add(
    level: CompatDiagnosticLevel,
    code: string,
    capability: CompatCapability,
    message: string,
    file?: string,
    details?: Record<string, unknown>,
  ): void {
    this.items.push(diagnostic(level, code, capability, message, file, details))
  }

  capture<T>(
    capability: CompatCapability,
    code: string,
    message: string,
    action: () => T,
    file?: string,
  ): T | undefined {
    try {
      return action()
    } catch (error) {
      this.add('error', code, capability, `${message}：${String(error)}`, file)
      return undefined
    }
  }
}
