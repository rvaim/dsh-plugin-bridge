declare module '@deepseek-ai/dsh-mcp-client' {
  const plugin: unknown
  export = plugin
}

declare module '@deepseek-ai/dsh-hook-protocol' {
  export function runHook(...args: any[]): Promise<any>
  export function matchesMatcher(...args: any[]): boolean
  export function mergeHookOutputs(...args: any[]): any
  export function createDetachedRuns(...args: any[]): any
}

declare module '@deepseek-ai/cordis' {
  export class Service {
    constructor(ctx: unknown, name: string)
  }
  export interface Context {}
}

declare module '@deepseek-ai/schemastery' {
  interface SchemaNode {
    default(value: unknown): SchemaNode
    min(value: number): SchemaNode
  }
  interface SchemaFactory {
    object(value: Record<string, unknown>): SchemaNode
    string(): SchemaNode
    number(): SchemaNode
    boolean(): SchemaNode
  }
  const z: SchemaFactory
  export default z
}
