import type { CompatDiagnostic } from './diagnostic.js'
import type { CompatFormat } from './plugin.js'

/** 用户提供的 Source，以及完成获取后记录的不可变版本信息。 */
export type InstallSource =
  | { type: 'directory'; path: string; contentHash?: string }
  | { type: 'archive'; path: string; sha256?: string }
  | { type: 'git'; url: string; ref?: string; commit?: string }

export interface ResolvedInstallSource {
  source: InstallSource
  display: string
  suggestedId?: string
}

export type SourceOwnership = 'implicit' | 'explicit'

/** Marketplace 中一个插件的规范化位置。 */
export type CompatPluginLocation =
  | {
      type: 'source-path'
      /** 相对于 Source package/ 根目录；`.` 表示根目录。 */
      path: string
    }
  | {
      type: 'git'
      url: string
      ref?: string
      sha?: string
    }
  | {
      type: 'git-subdir'
      url: string
      path: string
      ref?: string
      sha?: string
    }
  | {
      type: 'npm'
      package: string
      version?: string
      registry?: string
    }
  | {
      type: 'archive'
      url: string
      sha256?: string
    }
  | {
      type: 'unsupported'
      sourceType: string
    }

/** Source 中可安装或可诊断的一个具体旧插件。 */
export interface CompatSourcePlugin {
  /** Source 内部的稳定插件标识；不会改写插件内部能力名称。 */
  id: string
  name: string
  displayName?: string
  description?: string
  version?: string
  formats: CompatFormat[]
  location: CompatPluginLocation
  /** Marketplace 可声明安装后默认禁用。 */
  defaultEnabled?: boolean
  /** false 表示条目可见但当前来源类型或位置不能可靠安装。 */
  installable: boolean
  diagnostics: CompatDiagnostic[]
}

/** source.json：只记录来源身份、归属、获取位置和当前内容版本。 */
export interface SourceMetadata {
  id: string
  name?: string
  origin: InstallSource
  ownership: SourceOwnership
  /** Source 内容版本，用于使 Plugin scan.json 失效。 */
  revision: string
  createdAt: string
  updatedAt?: string
}

/** scan.json：Source parser 的可重建缓存。 */
export interface SourceScanCache {
  parserVersion: string
  scannedAt: string
  formats: CompatFormat[]
  plugins: CompatSourcePlugin[]
  diagnostics: CompatDiagnostic[]
  marketplaceFiles: string[]
  discovery: 'marketplace' | 'single-plugin' | 'manual-paths'
  /** 无 Marketplace 时用户显式提供的 paths；用于更新时重放相同定位规则。 */
  manualPaths?: string[]
}

export interface InstalledSourceRecord {
  source: SourceMetadata
  scan: SourceScanCache
}

/** 对外展示时合并 source.json 与 scan.json。 */
export interface CompatSource extends SourceMetadata {
  formats: CompatFormat[]
  plugins: CompatSourcePlugin[]
  diagnostics: CompatDiagnostic[]
  marketplaceFiles: string[]
  discovery: SourceScanCache['discovery']
}
