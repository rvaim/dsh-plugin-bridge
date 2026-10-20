export interface CompatCommand {
  name: string
  description?: string
  contentPath: string
  /** 内联正文保留 JSON 来源，扫描缓存不复制清单内容。 */
  contentSource?: { type: 'inline'; pointer: string }
  sourceFormat: string
  metadata?: Record<string, unknown>
}
