import { resolve } from 'node:path'
import type { CompatFormat } from '../types/plugin.js'
import { DiagnosticCollector } from './shared/diagnostics.js'
import { pathExists } from './shared/fs.js'

export interface DetectionResult {
  formats: CompatFormat[]
  implicitClaude: boolean
}

/** 只做静态格式识别，不执行插件中的任何代码。 */
export async function detectPluginFormat(
  packageRoot: string,
  collector: DiagnosticCollector,
): Promise<DetectionResult> {
  const claude = await pathExists(resolve(packageRoot, '.claude-plugin/plugin.json'))
  const codex = await pathExists(resolve(packageRoot, '.codex-plugin/plugin.json'))
  const formats: CompatFormat[] = []
  if (claude) formats.push('claude-code')
  if (codex) formats.push('codex')
  if (formats.length > 0) return { formats, implicitClaude: false }

  const conventional = await Promise.all([
    'skills', 'commands', 'agents', 'hooks/hooks.json', '.mcp.json', 'SKILL.md',
  ].map(path => pathExists(resolve(packageRoot, path))))
  if (conventional.some(Boolean)) return { formats: ['claude-code'], implicitClaude: true }

  collector.add('error', 'PLUGIN_FORMAT_UNKNOWN', 'plugin', '无法识别 Claude Code 或 Codex 插件格式')
  return { formats: [], implicitClaude: false }
}
