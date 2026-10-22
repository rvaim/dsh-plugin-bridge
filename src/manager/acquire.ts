import { lstat, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CompatPluginLocation, InstallSource, ResolvedInstallSource } from '../types/source.js'
import { extractArchive, sha256File } from '../source/archive.js'
import { copyPluginDirectory } from '../source/directory.js'
import { cloneGitPlugin } from '../source/git.js'
import { isPathInside } from '../source/safety.js'
import { hashDirectory } from '../source/snapshot.js'

export interface AcquiredSource {
  /** 获取后的原始 Source 根；归档可能仍带一层包装目录。 */
  acquiredRoot: string
  origin: InstallSource
  revision: string
  /** 只有归档允许 Source parser 安全剥离一层包装目录。 */
  allowSingleWrapper: boolean
}

export interface MaterializedExternalPlugin {
  /** 完整外部 Git 仓库的根目录。 */
  packageRoot: string
  /** 已固定实际 commit SHA 的位置。 */
  location: Extract<CompatPluginLocation, { type: 'git' | 'git-subdir' }>
}

/** 获取完整 Source 到事务目录；只下载、复制、解压和静态检查。 */
export async function acquireSource(
  resolved: ResolvedInstallSource,
  stagedSourceRoot: string,
  signal?: AbortSignal,
): Promise<AcquiredSource> {
  signal?.throwIfAborted()
  const acquiredRoot = join(stagedSourceRoot, 'acquired-source')
  await mkdir(stagedSourceRoot, { recursive: true, mode: 0o700 })

  if (resolved.source.type === 'directory') {
    await copyPluginDirectory(resolved.source.path, acquiredRoot, signal)
    const contentHash = await hashDirectory(acquiredRoot, signal)
    return {
      acquiredRoot,
      origin: { type: 'directory', path: resolved.source.path, contentHash },
      revision: `directory:${contentHash}`,
      allowSingleWrapper: false,
    }
  }

  if (resolved.source.type === 'archive') {
    await extractArchive(resolved.source.path, acquiredRoot, signal)
    const sha256 = await sha256File(resolved.source.path, signal)
    return {
      acquiredRoot,
      origin: { type: 'archive', path: resolved.source.path, sha256 },
      revision: `archive:${sha256}`,
      allowSingleWrapper: true,
    }
  }

  const result = await cloneGitPlugin(resolved.source.url, acquiredRoot, resolved.source.ref, signal)
  const commit = result.source.commit
  if (commit === undefined) throw new Error('Git 获取成功但未得到 commit SHA')
  return {
    acquiredRoot,
    origin: result.source,
    revision: `git:${commit}`,
    allowSingleWrapper: false,
  }
}

function effectiveRef(location: Extract<CompatPluginLocation, { type: 'git' | 'git-subdir' }>): string | undefined {
  return location.sha ?? location.ref
}

/**
 * 获取 Marketplace 指向的外部 Git Plugin。
 *
 * git-subdir 也保留完整仓库，运行时再定位子目录；每个所选 Plugin 独立获取并
 * 记录实际提交，Source 更新在同一事务中切换这些外部快照。
 */
export async function materializeExternalPlugin(
  location: CompatPluginLocation,
  stagedPluginRoot: string,
  signal?: AbortSignal,
): Promise<MaterializedExternalPlugin> {
  signal?.throwIfAborted()
  if (location.type !== 'git' && location.type !== 'git-subdir') {
    throw new Error(`当前不能获取 Marketplace 插件来源类型：${location.type}`)
  }
  const packageRoot = join(stagedPluginRoot, 'package')
  await mkdir(stagedPluginRoot, { recursive: true, mode: 0o700 })
  const result = await cloneGitPlugin(location.url, packageRoot, effectiveRef(location), signal)
  const commit = result.source.commit
  if (commit === undefined) throw new Error('外部 Git Plugin 获取成功但未得到 commit SHA')

  if (location.type === 'git-subdir') {
    const selected = resolve(packageRoot, location.path)
    if (!isPathInside(packageRoot, selected)) throw new Error(`git-subdir 路径逃逸仓库：${location.path}`)
    const stat = await lstat(selected).catch(() => undefined)
    if (stat === undefined || !stat.isDirectory()) throw new Error(`git-subdir 插件目录不存在：${location.path}`)
  }

  return {
    packageRoot,
    location: {
      ...location,
      sha: commit,
    },
  }
}

export async function cleanAcquisition(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
