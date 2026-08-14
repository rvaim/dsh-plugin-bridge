import type { CompatFormat } from '../../types/plugin.js'

export interface HarnessDescriptor {
  format: CompatFormat
  manifestPath?: string
  manifest: Record<string, unknown>
  name?: string
  displayName?: string
  version?: string
  skillPaths: string[]
  commandPaths: string[]
  agentPaths: string[]
  /** 是否扫描旧生态约定的默认能力目录。共享 Source 根条目可关闭，避免跨 Plugin 泄漏。 */
  defaultCapabilityPaths: {
    skills: boolean
    commands: boolean
    agents: boolean
  }
  hookSources: Array<{ file: string; inline?: unknown; pointer?: string }>
  mcpSources: Array<{ file: string; inline?: unknown; pointer?: string }>
}
