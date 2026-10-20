import type { CompatPluginEnvironmentBindings } from './environment.js'

/** 路径在运行时才结合插件目录或当前工作区解析。 */
export type CompatPath =
  | { type: 'plugin'; path: string }
  | { type: 'data'; path: string }
  | { type: 'workspace'; path: string }
  | { type: 'absolute'; path: string }

/** 字符串模板中的单个部分。 */
export type CompatTemplatePart =
  | { type: 'text'; value: string }
  | { type: 'env'; name: string; fallback?: string }
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
  /** Marketplace 内联声明读取 Source 根，其余默认读取插件根。 */
  base?: 'source'
  /** 运行时解析后是否应作为敏感值参与异常消息脱敏。 */
  sensitive?: boolean
  /** 从包中读取后按显式语法解析，避免敏感字面量和 fallback 写入扫描结果。 */
  templateSyntax?: 'environment'
  /** 由解析协议声明的路径变量；省略时没有路径别名。 */
  templateBindings?: CompatPluginEnvironmentBindings
  /** 按 templateBindings 精确替换路径变量；none 始终保持字面，不查凭据。 */
  expansion?: 'exact-plugin-vars' | 'none'
}

export type CompatRuntimeValue = CompatTemplate | CompatDeferredJsonValue
