/** 路径在运行时才结合插件目录或当前工作区解析。 */
export type CompatPath =
  | { type: 'plugin'; path: string }
  | { type: 'workspace'; path: string }
  | { type: 'absolute'; path: string }

/** 字符串模板中的单个部分。 */
export type CompatTemplatePart =
  | { type: 'text'; value: string }
  | { type: 'env'; name: string }
  | { type: 'plugin-root' }
  | { type: 'plugin-data' }
  | { type: 'workspace-root' }

/** 保留路径变量和环境变量引用，避免在安装阶段读取凭据。 */
export interface CompatTemplate {
  type: 'template'
  parts: CompatTemplatePart[]
}

/**
 * JSON 指针引用用于延迟读取插件包中的值。
 * MCP env/header 中的明文可能是凭据，scan.json 只保存位置，不保存值。
 */
export interface CompatDeferredJsonValue {
  type: 'deferred-json'
  file: string
  pointer: string
  /** 运行时解析后是否应作为敏感值参与异常消息脱敏。 */
  sensitive?: boolean
}

export type CompatRuntimeValue = CompatTemplate | CompatDeferredJsonValue
