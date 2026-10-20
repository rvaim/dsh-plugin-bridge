import type { PluginParser } from '../parser/contracts.js'
import { claudeCodeParser } from '../protocols/claude-code/index.js'
import { codexParser } from '../protocols/codex/index.js'
import { agentPluginsParser } from '../protocols/agent-plugins/index.js'

/** 唯一引用内置协议实现的装配文件。移除实现时在这里取消注册。 */
export const builtInParsers: readonly PluginParser[] = [claudeCodeParser, codexParser, agentPluginsParser]
