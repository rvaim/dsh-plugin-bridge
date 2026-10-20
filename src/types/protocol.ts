import type { CompatFormat } from './plugin.js'

export interface ConfigSource {
  file: string
  inline?: unknown
  pointer?: string
  /** Marketplace hooks 按事件替换；保留原文件和 pointer 供凭据读取。 */
  excludedEvents?: string[]
}

export interface CommandDefinition {
  name: string
  file: string
  pointer: string
  value: unknown
}

export interface HarnessDescriptor {
  format: CompatFormat
  manifestPath?: string
  manifest: Record<string, unknown>
  name?: string
  displayName?: string
  version?: string
  defaultEnabled?: boolean
  commandDefinitions?: CommandDefinition[]
  skillPaths: string[]
  commandPaths: string[]
  agentPaths: string[]
  /** 是否扫描旧生态约定的默认能力目录。共享 Source 根条目可关闭，避免跨 Plugin 泄漏。 */
  defaultCapabilityPaths: {
    skills: boolean
    commands: boolean
    agents: boolean
  }
  hookSources: ConfigSource[]
  mcpSources: ConfigSource[]
}
