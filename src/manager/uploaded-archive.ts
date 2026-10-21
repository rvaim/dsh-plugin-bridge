import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompatLayout } from '../store/layout.js'
import type { InstallSource } from '../types/source.js'
import { pluginArchiveSuffix } from '../shared/archive-input.js'

/** Recognize only the reserved Source-owned origin path. */
export function isUploadedArchive(layout: CompatLayout, sourceId: string, origin: InstallSource): boolean {
  if (origin.type !== 'archive') return false
  const suffix = pluginArchiveSuffix(origin.path)
  return suffix !== undefined && origin.path === join(layout.sourceRoot(sourceId), `uploaded-origin${suffix}`)
}

/** Transfer uploaded bytes into the Source ownership boundary before intake is removed. */
export async function retainUploadedArchive(layout: CompatLayout, sourceId: string, origin: InstallSource, stagedSource: string): Promise<InstallSource> {
  if (origin.type !== 'archive') throw new Error('上传来源必须是归档文件')
  const suffix = pluginArchiveSuffix(origin.path)
  if (suffix === undefined) throw new Error('不支持的上传归档格式')
  const name = `uploaded-origin${suffix}`
  await copyFile(origin.path, join(stagedSource, name))
  return { ...origin, path: join(layout.sourceRoot(sourceId), name) }
}

/** Keep the managed origin through Source replacement; ordinary external archive paths stay external. */
export async function preserveUploadedArchive(layout: CompatLayout, sourceId: string, origin: InstallSource, stagedSource: string): Promise<void> {
  if (origin.type !== 'archive') return
  const suffix = pluginArchiveSuffix(origin.path)
  if (suffix === undefined) return
  const name = `uploaded-origin${suffix}`
  if (origin.path !== join(layout.sourceRoot(sourceId), name)) return
  await copyFile(origin.path, join(stagedSource, name))
}
