/** 运行时动态加载；独立构建不要求安装这个 DSH 可选 peer。 */
declare module '@deepseek-ai/dsh-mcp-client' {
  const plugin: unknown
  export = plugin
}
