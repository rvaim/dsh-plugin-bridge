import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function isStorageId(value: string): boolean {
  return value !== '.'
    && value !== '..'
    && /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(value)
}

function storageId(value: string, kind: 'Source' | 'Plugin'): string {
  if (!isStorageId(value)) {
    throw new Error(`${kind} ID 不是安全的存储标识：${JSON.stringify(value)}`)
  }
  return value
}

/** 插件桥在 Harness Home 下的独立存储命名空间。 */
export class CompatLayout {
  readonly harnessHome: string
  readonly root: string
  readonly sources: string
  readonly installed: string
  /** Marketplace 指向的外部 Git Plugin 缓存根。 */
  readonly external: string
  readonly temp: string
  readonly locks: string

  constructor(harnessHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
    this.harnessHome = resolve(harnessHome)
    // 保留稳定 storage key，避免品牌重命名后无法读取已有安装与数据。
    this.root = join(this.harnessHome, 'dsh-compat')
    this.sources = join(this.root, 'sources')
    this.installed = join(this.root, 'installed')
    this.external = join(this.root, 'external')
    this.temp = join(this.root, 'temp')
    this.locks = join(this.root, 'locks')
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.sources, { recursive: true, mode: 0o700 }),
      mkdir(this.installed, { recursive: true, mode: 0o700 }),
      mkdir(this.external, { recursive: true, mode: 0o700 }),
      mkdir(this.temp, { recursive: true, mode: 0o700 }),
      mkdir(this.locks, { recursive: true, mode: 0o700 }),
    ])
  }

  sourceRoot(sourceId: string): string {
    return join(this.sources, storageId(sourceId, 'Source'))
  }

  sourcePackageDir(sourceId: string): string {
    return join(this.sourceRoot(sourceId), 'package')
  }

  sourceCacheDir(sourceId: string): string {
    return join(this.sourceRoot(sourceId), 'cache')
  }

  sourceFile(sourceId: string): string {
    return join(this.sourceRoot(sourceId), 'source.json')
  }

  sourceScanFile(sourceId: string): string {
    return join(this.sourceRoot(sourceId), 'scan.json')
  }

  sourceExternalRoot(sourceId: string): string {
    // 外部内容逻辑上归属于 Source，但物理上与 sources/ 分开保存；Source 更新
    // 会在同一锁与回滚边界中同时切换 sources/<id> 和 external/<id>。
    return join(this.external, storageId(sourceId, 'Source'))
  }

  sourceExternalPluginRoot(sourceId: string, sourcePluginId: string): string {
    return join(this.sourceExternalRoot(sourceId), storageId(sourcePluginId, 'Plugin'))
  }

  sourceExternalPackageDir(sourceId: string, sourcePluginId: string): string {
    return join(this.sourceExternalPluginRoot(sourceId, sourcePluginId), 'package')
  }

  pluginRoot(pluginId: string): string {
    return join(this.installed, storageId(pluginId, 'Plugin'))
  }

  dataDir(pluginId: string): string {
    return join(this.pluginRoot(pluginId), 'data')
  }

  cacheDir(pluginId: string): string {
    return join(this.pluginRoot(pluginId), 'cache')
  }

  installFile(pluginId: string): string {
    return join(this.pluginRoot(pluginId), 'install.json')
  }

  stateFile(pluginId: string): string {
    return join(this.pluginRoot(pluginId), 'state.json')
  }

  scanFile(pluginId: string): string {
    return join(this.pluginRoot(pluginId), 'scan.json')
  }
}
