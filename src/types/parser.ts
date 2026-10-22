import type { CompatDiagnostic } from './diagnostic.js'

/** 可供用户选择的解析器；匹配与清单预检不扫描插件能力。 */
export interface ParserMatch {
  parserId: string
  label: { en: string; zh?: string }
  available: boolean
  evidence: Array<{ kind: 'manifest' | 'catalog' | 'implicit'; file?: string }>
  diagnostics: CompatDiagnostic[]
}

/** 实现版本与标准协议版本独立；用于精确失效已生成的扫描缓存。 */
export interface ParserIdentity { id: string; version: string }
export interface ParserSnapshot { fingerprint: string; parsers: ParserIdentity[] }

/** 解析器自带的可序列化分类声明；不参与解析缓存身份。 */
export interface ParserCategoryContribution {
  label: { default: string; en?: string; zh?: string }
  order: number
}

/** 已装配解析器的分类目录；id 与解析器 id 相同。 */
export interface CompatCategory {
  id: string
  label: { en: string; zh?: string }
  order: number
}
