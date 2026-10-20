import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Harness Home；省略时读取 DSH_HOME 或 ~/.dsh。 */
  harnessHome?: string
  /** MCP 启动与无会话 Hook 的默认工作区。 */
  workspaceRoot?: string
  /** 插件启动时是否恢复 state.json 中 enabled 的旧插件。 */
  autoStart?: boolean
  /** 省略启用全部已装配解析器；[] 保留管理服务但不解析任何协议。 */
  parsers?: string[]
  /** 可选的统一毫秒覆盖；省略时使用各平台事件默认超时。 */
  hookDefaultTimeoutMs?: number
  /** 持久化 Hook stderr 摘要的字符上限。 */
  hookStderrSummaryMaxChars?: number
  /** 写入声明 model 字段的 Hook payload；省略时使用空字符串。 */
  modelName?: string
}

/** 当前 DSH 插件约定使用 Schemastery 暴露配置模式和部署默认值。 */
export const Config = z.object({
  harnessHome: z.string(),
  workspaceRoot: z.string(),
  autoStart: z.boolean().default(true),
  parsers: z.array(z.string()),
  hookDefaultTimeoutMs: z.number().min(1),
  hookStderrSummaryMaxChars: z.number().min(0).default(500),
  modelName: z.string(),
})
