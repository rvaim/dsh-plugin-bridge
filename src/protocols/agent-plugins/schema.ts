import { Ajv2020 } from 'ajv/dist/2020.js'
import pluginSchema from './schemas/1.0.0/plugin.schema.json' with { type: 'json' }
import mcpSchema from './schemas/1.0.0/mcp.schema.json' with { type: 'json' }
import schemaLicense from './schemas/1.0.0/LICENSE.json' with { type: 'json' }

// 引用许可 JSON，确保 tsc 随 schemas 一同复制完整许可与固定版本来源。
void schemaLicense

// 官方 1.0.0 schemas 不包含 format；不联网取 schema，不需要 ajv-formats。
const ajv = new Ajv2020({ allErrors: false, strict: true })
const plugin = ajv.compile(pluginSchema)
ajv.addSchema(mcpSchema)
const server = ajv.compile({ $ref: `${mcpSchema.$id}#/$defs/server` })
const envelope = ajv.compile({
  ...mcpSchema,
  $id: 'urn:plugin-bridge:agent-plugins:1.0.0:mcp-envelope',
  // §7.2.2：envelope 与 server 分开校验，不能因坏 server 禁用全部同级。
  properties: { ...mcpSchema.properties, mcpServers: { type: 'object' } },
})

/** 严格官方 manifest schema；§5.2/8.1 非致命例外由 manifest parser 先处理。 */
export function validateAgentPluginManifest(value: unknown): boolean {
  return plugin(value)
}

/** 仅校验 MCP 顶层，不校验 mcpServers 的成员值。 */
export function validateAgentMcpEnvelope(value: unknown): boolean {
  return envelope(value)
}

/** 校验官方 closed server union；额外语义（URL、路径、headers）由 MCP parser 检查。 */
export function validateAgentMcpServer(value: unknown): boolean {
  return server(value)
}
