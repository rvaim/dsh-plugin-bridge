import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import type { MarketplacePluginDefinition } from '../types/catalog.js'
import type { CompatCategory, ParserSignature, ParserSnapshot, PluginParser } from './contracts.js'
import { PARSER_VERSION, SOURCE_PARSER_VERSION } from './version.js'

/** 仅保存分类 DTO；每次登记持有独立所有权，返回值可交给宿主 effect。 */
export class ParserCategoryRegistry {
  private readonly entries = new Map<string, { owner: object; category: CompatCategory }>()

  register(owner: object, category: CompatCategory): () => void {
    if (!category.id || typeof category.label.en !== 'string' || !category.label.en.trim()
      || (category.label.zh !== undefined && (typeof category.label.zh !== 'string' || !category.label.zh.trim()))
      || !Number.isFinite(category.order)) throw new Error('分类 id/label/order 无效')
    if (this.entries.has(category.id)) throw new Error(`分类 id 重复：${category.id}`)
    const entry = { owner, category: structuredClone(category) }
    this.entries.set(category.id, entry)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.entries.get(entry.category.id) === entry && entry.owner === owner) this.entries.delete(entry.category.id)
    }
  }

  list(owner?: object): CompatCategory[] {
    return [...this.entries.values()]
      .filter(entry => owner === undefined || entry.owner === owner)
      .map(entry => structuredClone(entry.category))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }
}

function parserCategory(parser: PluginParser): CompatCategory {
  const { label, order } = parser.category
  if (typeof label.default !== 'string' || !label.default.trim()) throw new Error(`解析器 ${parser.id} 的默认分类名无效`)
  return { id: parser.id, label: { en: label.en ?? label.default, ...(label.zh === undefined ? {} : { zh: label.zh }) }, order }
}

export interface DetectedParser { signature: ParserSignature; parser?: PluginParser; implicit: boolean }

export async function pathPresent(root: string, path: string): Promise<boolean> {
  try { await lstat(resolve(root, path)); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 仅管理注入的模块与声明性格式边界，不加载任何协议实现。 */
export class ParserRegistry {
  readonly modules: readonly PluginParser[]
  readonly signatures: readonly ParserSignature[]
  private readonly byId: Map<string, PluginParser>
  private readonly identity: ParserSnapshot
  private readonly categoryDisposers: (() => void)[] = []

  constructor(
    modules: readonly PluginParser[],
    signatures: readonly ParserSignature[] = modules.map(module => module.signature),
    private readonly categoryRegistry = new ParserCategoryRegistry(),
  ) {
    this.byId = new Map()
    for (const module of modules) {
      if (!module.id || !module.version || module.signature.id !== module.id || this.byId.has(module.id)) throw new Error('解析器 id/version 无效或重复')
      this.byId.set(module.id, module)
    }
    this.modules = [...modules].sort((a, b) => a.id.localeCompare(b.id))
    const boundaries = new Map<string, ParserSignature>()
    for (const signature of [...signatures, ...modules.map(module => module.signature)]) {
      // 装配声明的边界必须在移除实现后保持有效。
      if (!boundaries.has(signature.id)) boundaries.set(signature.id, structuredClone(signature))
    }
    this.signatures = [...boundaries.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
    const parsers = this.modules.map(({ id, version }) => ({ id, version }))
    const fingerprint = createHash('sha256').update(JSON.stringify({ parserVersion: PARSER_VERSION, sourceVersion: SOURCE_PARSER_VERSION, parsers, boundaries: this.signatures })).digest('hex')
    this.identity = { fingerprint, parsers }
    try {
      for (const parser of this.modules) this.categoryDisposers.push(this.categoryRegistry.register(this, parserCategory(parser)))
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  get snapshot(): ParserSnapshot { return structuredClone(this.identity) }
  get categories(): readonly CompatCategory[] { return this.categoryRegistry.list(this) }

  /** 撤销该装配实例贡献的分类，不影响共享目录中的其他 owner。 */
  dispose(): void {
    for (const dispose of this.categoryDisposers.splice(0).reverse()) dispose()
  }

  getParser(id: string): PluginParser | undefined { return this.byId.get(id) }

  async explicit(root: string): Promise<ParserSignature[]> {
    const present: ParserSignature[] = []
    for (const signature of this.signatures) {
      if ((await Promise.all(signature.manifestPaths.map(path => pathPresent(root, path)))).some(Boolean)) present.push(signature)
    }
    const exclusive = present.find(signature => signature.exclusive)
    return exclusive === undefined ? present : [exclusive]
  }

  async detect(root: string, collector: DiagnosticCollector, definitions: readonly MarketplacePluginDefinition[] = []): Promise<DetectedParser[]> {
    const explicit = await this.explicit(root)
    const exclusive = explicit.some(signature => signature.exclusive)
    const selected = new Map(explicit.map(signature => [signature.id, signature]))
    if (!exclusive) {
      for (const definition of definitions) {
        const signature = this.signatures.find(item => item.id === definition.format)
          ?? { id: definition.format, manifestPaths: [], marketplacePaths: [] }
        selected.set(signature.id, signature)
      }
    }
    const detected: DetectedParser[] = [...selected.values()].map(signature => ({ signature, parser: this.getParser(signature.id), implicit: false }))
    if (selected.size === 0) {
      for (const parser of this.modules) {
        try {
          const result = await parser.detect(root)
          if (result.matched) detected.push({ signature: parser.signature, parser, implicit: result.implicit ?? false })
        } catch {
          collector.add('error', 'PARSER_DETECTION_FAILED', 'plugin', `解析器 ${parser.id} 的格式检测失败`, undefined, { parserId: parser.id })
        }
      }
    }
    if (detected.length === 0) collector.add('error', 'PLUGIN_FORMAT_UNKNOWN', 'plugin', '没有已注册解析器能识别此插件格式')
    for (const item of detected) {
      if (item.parser === undefined) collector.add('error', 'PARSER_UNAVAILABLE', 'plugin', `格式 ${item.signature.id} 的解析器未注册，不能由其他格式接管`, undefined, { parserId: item.signature.id })
    }
    return detected.sort((a, b) => a.signature.id.localeCompare(b.signature.id))
  }
}
