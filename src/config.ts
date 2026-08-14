import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Harness Home；省略时读取 DSH_HOME 或 ~/.dsh。 */
  harnessHome?: string
  /** MCP 启动与无会话 Hook 的默认工作区。 */
  workspaceRoot?: string
  /** 插件启动时是否恢复 state.json 中 enabled 的旧插件。 */
  autoStart?: boolean
  /** Hook 未单独指定 timeout 时的默认毫秒数。 */
  hookDefaultTimeoutMs?: number
  /** 持久化 Hook stderr 摘要的字符上限。 */
  hookStderrSummaryMaxChars?: number
  /** 写入 Codex Hook payload 的模型名；省略时保持官方桥的空字符串默认值。 */
  codexModel?: string
}

/** 当前 DSH 插件约定使用 Schemastery 暴露配置模式和部署默认值。 */
export const Config = z.object({
  harnessHome: z.string(),
  workspaceRoot: z.string(),
  autoStart: z.boolean().default(true),
  hookDefaultTimeoutMs: z.number().min(1).default(600_000),
  hookStderrSummaryMaxChars: z.number().min(0).default(500),
  codexModel: z.string(),
})
