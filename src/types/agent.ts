export interface CompatAgent {
  name: string
  description?: string
  contentPath: string
  sourceFormat: 'claude-code' | 'codex'
  metadata?: Record<string, unknown>
}
