import type { ParserSignature } from '../parser/contracts.js'

/** 仅有识别元数据，无实现或依赖；取消注册实现时仍保留拒绝误识别的边界。 */
export const knownParserSignatures: readonly ParserSignature[] = [
  { id: 'agent-plugins', manifestPaths: ['plugin.json'], manifestSchemaPrefix: 'https://agent-plugins.org/schemas/', marketplacePaths: [], exclusive: true, priority: 100 },
  { id: 'claude-code', manifestPaths: ['.claude-plugin/plugin.json'], marketplacePaths: ['.claude-plugin/marketplace.json'], catalogIndex: { entriesField: 'plugins', nameField: 'name' } },
  { id: 'codex', manifestPaths: ['.codex-plugin/plugin.json'], marketplacePaths: ['.agents/plugins/marketplace.json'], catalogIndex: { entriesField: 'plugins', nameField: 'name' } },
]
