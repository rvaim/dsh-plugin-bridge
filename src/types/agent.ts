export interface CompatAgent {
  name: string
  description?: string
  contentPath: string
  sourceFormat: string
  metadata?: Record<string, unknown>
}
