import { lstat, realpath, stat } from 'node:fs/promises'
import { posix, relative, resolve } from 'node:path'
import type { CompatDiagnostic } from '../../types/diagnostic.js'
import { diagnostic } from '../../types/diagnostic.js'
import type { CompatFormat } from '../../types/plugin.js'
import type { CompatPluginLocation } from '../../types/source.js'
import { validateGitRef, validatePersistableGitUrl } from '../../source/resolver.js'
import { isPathInside } from '../../source/safety.js'
import { validateMetadata } from './harness-common.js'
import { DiagnosticCollector } from '../../shared/diagnostics.js'
import { normalizeManagementId } from '../../shared/id.js'
import { asObject } from '../../shared/object.js'
import type { MarketplacePluginDefinition, SourcePluginCandidate } from '../../types/catalog.js'

export function stringField(object: Record<string, unknown>, name: string): string | undefined {
  const value = object[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function normalizeRelativeSourcePath(raw: string): string {
  if (raw.includes('\0')) throw new Error('路径包含 NUL 字符')
  const portable = raw.replaceAll('\\', '/')
  if (portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`插件位置必须是 Source 内相对路径：${raw}`)
  }
  const parts = portable.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error(`插件位置不能逃逸 Source：${raw}`)
  const normalized = parts.join('/')
  if (normalized === '') return '.'
  if (normalized.startsWith('.claude-plugin/') || normalized.startsWith('.agents/plugins/')) {
    throw new Error(`插件位置不能指向 Marketplace 控制目录：${raw}`)
  }
  return normalized
}

export function combinePluginRoot(pluginRoot: string | undefined, raw: string): string {
  const root = pluginRoot === undefined ? '.' : normalizeRelativeSourcePath(pluginRoot)
  const path = normalizeRelativeSourcePath(raw)
  if (root === '.') return path
  if (path === '.') return root
  return normalizeRelativeSourcePath(posix.join(root, path))
}

/**
 * 验证 Source 内插件目录，并返回基于 Source 真根目录的规范相对路径。
 * 符号链接的最终目标也必须位于 Source 内。
 */
export async function validateSourceDirectory(sourceRoot: string, rawPath: string): Promise<string> {
  const path = normalizeRelativeSourcePath(rawPath)
  const target = resolve(sourceRoot, path)
  let info
  try {
    info = await lstat(target)
  } catch {
    throw new Error(`插件目录不存在：${path}`)
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`插件位置不是目录：${path}`)
  const [rootReal, targetReal] = await Promise.all([realpath(sourceRoot), realpath(target)])
  if (!isPathInside(rootReal, targetReal)) throw new Error(`插件目录逃逸 Source：${path}`)
  const targetInfo = await stat(targetReal)
  if (!targetInfo.isDirectory()) throw new Error(`插件位置的真实目标不是目录：${path}`)
  const canonical = relative(rootReal, targetReal).replaceAll('\\', '/')
  return canonical === '' ? '.' : canonical
}

export async function sourcePathIdentity(
  sourceRoot: string,
  path: string,
  marketplaceFile: string,
): Promise<{ key: string; diagnostics: CompatDiagnostic[]; installable: boolean }> {
  const absolute = resolve(sourceRoot, path)
  if (!isPathInside(sourceRoot, absolute)) {
    return {
      key: `invalid:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_ESCAPE', 'source', `Marketplace 插件路径逃逸 Source：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  let info
  try {
    info = await lstat(absolute)
  } catch {
    return {
      key: `missing:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_MISSING', 'source', `Marketplace 指向的插件目录不存在：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    return {
      key: `not-directory:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_NOT_DIRECTORY', 'source', `Marketplace 插件位置不是目录：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  let canonical: string
  let canonicalRoot: string
  try {
    [canonicalRoot, canonical] = await Promise.all([realpath(sourceRoot), realpath(absolute)])
  } catch {
    return {
      key: `missing:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_MISSING', 'source', `Marketplace 指向的插件目录不存在或符号链接已损坏：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  if (!isPathInside(canonicalRoot, canonical)) {
    return {
      key: `escape:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_ESCAPE', 'source', `Marketplace 插件目录的真实路径位于 Source 外：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  try {
    const targetInfo = await stat(canonical)
    if (!targetInfo.isDirectory()) {
      return {
        key: `not-directory:${path}`,
        diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_NOT_DIRECTORY', 'source', `Marketplace 插件位置的真实目标不是目录：${path}`, marketplaceFile)],
        installable: false,
      }
    }
  } catch {
    return {
      key: `missing:${path}`,
      diagnostics: [diagnostic('error', 'SOURCE_PLUGIN_PATH_MISSING', 'source', `Marketplace 指向的插件目录不存在或无法读取：${path}`, marketplaceFile)],
      installable: false,
    }
  }
  return { key: `source-path:${canonical}`, diagnostics: [], installable: true }
}

function fullSha(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${field} 必须是 40 位 Git commit SHA`)
  return value.toLowerCase()
}

function optionalRef(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  return validateGitRef(value, field)
}

function gitRevision(object: Record<string, unknown>): { ref?: string; sha?: string } {
  const ref = optionalRef(object.ref, 'ref')
  const sha = fullSha(object.sha, 'sha')
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(sha === undefined ? {} : { sha }),
  }
}

function githubUrl(repo: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`GitHub repo 必须是 owner/repo：${repo}`)
  return `https://github.com/${repo.replace(/\.git$/i, '')}.git`
}

function normalizeExternalGitUrl(raw: string): string {
  const value = /^[^/\s]+\/[^/\s]+$/.test(raw) && !raw.includes('://')
    ? githubUrl(raw)
    : raw
  validatePersistableGitUrl(value)
  return value
}

export function locationKey(location: CompatPluginLocation): string {
  switch (location.type) {
    case 'source-path': return `source-path:${location.path}`
    case 'git': return `git:${location.url}#${location.sha ?? location.ref ?? ''}`
    case 'git-subdir': return `git-subdir:${location.url}#${location.sha ?? location.ref ?? ''}:${location.path}`
    case 'npm': return `npm:${location.package}@${location.version ?? ''}:${location.registry ?? ''}`
    case 'archive': return `archive:${location.url}#${location.sha256 ?? ''}`
    case 'unsupported': return `unsupported:${location.sourceType}`
  }
}

/** Marketplace 位置解析结果；位置身份只用于比较，不改写插件名称。 */
export interface ParsedLocation {
  location: CompatPluginLocation
  installable: boolean
  diagnostics: CompatDiagnostic[]
}

export async function parseMarketplaceLocation(options: {
  sourceRoot: string
  raw: unknown
  marketplaceFile: string
  format: CompatFormat
  pluginRoot?: string
}): Promise<ParsedLocation & { key: string }> {
  const diagnostics: CompatDiagnostic[] = []
  const { raw, marketplaceFile } = options
  let location: CompatPluginLocation

  try {
    if (typeof raw === 'string') {
      const rootPath = raw === '.' || raw === './'
      if (options.format === 'claude-code' && options.pluginRoot === undefined && !rootPath && !raw.startsWith('./')) {
        throw new Error('Claude Marketplace 相对路径必须以 ./ 开头；设置 metadata.pluginRoot 后可省略')
      }
      if (options.format === 'codex' && !rootPath && !raw.startsWith('./')) {
        throw new Error('Codex Marketplace 本地插件路径必须以 ./ 开头')
      }
      const path = combinePluginRoot(options.pluginRoot, raw)
      location = { type: 'source-path', path }
      const identity = await sourcePathIdentity(options.sourceRoot, path, marketplaceFile)
      return { location, key: identity.key, diagnostics: identity.diagnostics, installable: identity.installable }
    }

    const object = asObject(raw)
    if (object === undefined) throw new Error('source 必须是路径字符串或对象')
    const type = stringField(object, 'source')
    if (type === undefined) throw new Error('source 对象缺少 source 类型')

    if (type === 'local') {
      const rawPath = stringField(object, 'path')
      if (rawPath === undefined) throw new Error('local source 缺少 path')
      const rootPath = rawPath === '.' || rawPath === './'
      if (options.format === 'codex' && !rootPath && !rawPath.startsWith('./')) {
        throw new Error('Codex Marketplace local.path 必须以 ./ 开头')
      }
      const path = combinePluginRoot(options.pluginRoot, rawPath)
      location = { type: 'source-path', path }
      const identity = await sourcePathIdentity(options.sourceRoot, path, marketplaceFile)
      return { location, key: identity.key, diagnostics: identity.diagnostics, installable: identity.installable }
    }

    if (type === 'github') {
      if (options.format !== 'claude-code') throw new Error('Codex Marketplace 不支持 github source；请使用 url')
      const repo = stringField(object, 'repo')
      if (repo === undefined) throw new Error('github source 缺少 repo')
      location = {
        type: 'git',
        url: githubUrl(repo),
        ...gitRevision(object),
      }
      return { location, key: locationKey(location), diagnostics, installable: true }
    }

    if (type === 'url') {
      const url = stringField(object, 'url')
      if (url === undefined) throw new Error('url source 缺少 url')
      const rawPath = stringField(object, 'path')
      if (rawPath !== undefined && options.format !== 'codex') {
        throw new Error('Claude Marketplace 的 url source 不接受 path；请使用 git-subdir')
      }
      if (rawPath !== undefined) {
        const path = normalizeRelativeSourcePath(rawPath)
        if (path === '.') throw new Error('url.path 不能是仓库根目录；请省略 path')
        location = {
          type: 'git-subdir',
          url: normalizeExternalGitUrl(url),
          path,
          ...gitRevision(object),
        }
      } else {
        location = {
          type: 'git',
          url: normalizeExternalGitUrl(url),
          ...gitRevision(object),
        }
      }
      return { location, key: locationKey(location), diagnostics, installable: true }
    }

    if (type === 'git-subdir') {
      const url = stringField(object, 'url')
      const rawPath = stringField(object, 'path')
      if (url === undefined || rawPath === undefined) throw new Error('git-subdir source 需要 url 和 path')
      const path = normalizeRelativeSourcePath(rawPath)
      if (path === '.') throw new Error('git-subdir path 不能是仓库根目录；请使用 url source')
      location = {
        type: 'git-subdir',
        url: normalizeExternalGitUrl(url),
        path,
        ...gitRevision(object),
      }
      return { location, key: locationKey(location), diagnostics, installable: true }
    }

    if (type === 'npm') {
      const packageName = stringField(object, 'package')
      if (packageName === undefined) throw new Error('npm source 缺少 package')
      const version = stringField(object, 'version')
      const registry = stringField(object, 'registry')
      location = {
        type: 'npm',
        package: packageName,
        ...(version === undefined ? {} : { version }),
        ...(registry === undefined ? {} : { registry }),
      }
      diagnostics.push(diagnostic('error', 'SOURCE_LOCATION_NPM_UNSUPPORTED', 'source', '为避免安装阶段执行 npm 生命周期脚本，第一版不自动安装 npm Marketplace 来源', marketplaceFile))
      return { location, key: locationKey(location), diagnostics, installable: false }
    }

    if (type === 'archive') {
      if (options.format !== 'claude-code') throw new Error('Codex Marketplace 当前不支持 archive source')
      const url = stringField(object, 'url')
      if (url === undefined) throw new Error('archive source 缺少 url')
      const sha256 = stringField(object, 'sha256')
      if (sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error('archive sha256 必须是 64 位十六进制')
      location = { type: 'archive', url, ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }) }
      diagnostics.push(diagnostic('error', 'SOURCE_LOCATION_ARCHIVE_URL_UNSUPPORTED', 'source', '第一版不从 Marketplace 下载远程 archive；可先下载后作为本地 Source 安装', marketplaceFile))
      return { location, key: locationKey(location), diagnostics, installable: false }
    }

    location = { type: 'unsupported', sourceType: type }
    diagnostics.push(diagnostic(
      'error',
      type === 'command' ? 'SOURCE_LOCATION_COMMAND_UNSUPPORTED' : 'SOURCE_LOCATION_UNSUPPORTED',
      'source',
      type === 'command'
        ? '已识别合法的 Claude Marketplace command source；当前安装适配器未支持，不执行其命令或安装脚本'
        : `当前不支持 Marketplace 插件来源类型：${type}`,
      marketplaceFile,
    ))
    return { location, key: locationKey(location), diagnostics, installable: false }
  } catch (error) {
    location = { type: 'unsupported', sourceType: 'invalid' }
    diagnostics.push(diagnostic('error', 'SOURCE_LOCATION_INVALID', 'source', `Marketplace 插件来源无效：${String(error)}`, marketplaceFile))
    return { location, key: locationKey(location), diagnostics, installable: false }
  }
}

export function createCandidate(options: {
  format: CompatFormat
  marketplaceFile: string
  pointer: string
  entry: Record<string, unknown>
  location: CompatPluginLocation
  locationKey: string
  installable: boolean
  diagnostics: CompatDiagnostic[]
  fallbackId: string
}): SourcePluginCandidate {
  const rawName = stringField(options.entry, 'name') ?? options.fallbackId
  const textFields = {
    displayName: stringField(options.entry, 'displayName'),
    description: stringField(options.entry, 'description'),
    version: stringField(options.entry, 'version'),
  }
  const normalizedTextFields = {
    ...(textFields.displayName === undefined ? {} : { displayName: textFields.displayName }),
    ...(textFields.description === undefined ? {} : { description: textFields.description }),
    ...(textFields.version === undefined ? {} : { version: textFields.version }),
  }
  const candidateDiagnostics = [...options.diagnostics]
  const metadataCollector = new DiagnosticCollector()
  validateMetadata(options.entry, metadataCollector, options.marketplaceFile, 'claude-code', true)
  candidateDiagnostics.push(...metadataCollector.items)
  for (const field of ['displayName', 'description', 'version'] as const) {
    if (options.entry[field] !== undefined && textFields[field] === undefined) {
      candidateDiagnostics.push(diagnostic(
        'error',
        `SOURCE_PLUGIN_${field.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}_INVALID`,
        'source',
        `Marketplace 插件字段 ${field} 必须是非空字符串`,
        options.marketplaceFile,
      ))
    }
  }
  if (options.entry.defaultEnabled !== undefined && typeof options.entry.defaultEnabled !== 'boolean') {
    candidateDiagnostics.push(diagnostic('error', 'SOURCE_PLUGIN_DEFAULT_ENABLED_INVALID', 'source', 'Marketplace 插件字段 defaultEnabled 必须是布尔值', options.marketplaceFile))
  }
  if (options.entry.strict !== undefined && typeof options.entry.strict !== 'boolean') {
    candidateDiagnostics.push(diagnostic('error', 'SOURCE_PLUGIN_STRICT_INVALID', 'source', 'Marketplace 插件字段 strict 必须是布尔值', options.marketplaceFile))
  }
  let id: string
  try {
    id = normalizeManagementId(rawName, 'plugin')
  } catch (error) {
    id = options.fallbackId
    candidateDiagnostics.push(diagnostic('error', 'SOURCE_PLUGIN_ID_INVALID', 'source', `Marketplace 插件管理 ID 无效：${String(error)}`, options.marketplaceFile))
  }
  const strict = typeof options.entry.strict === 'boolean' ? options.entry.strict : undefined
  const manifestFields = { ...options.entry }
  for (const field of ['source', 'policy', 'category', 'defaultEnabled', 'strict'] as const) {
    delete manifestFields[field]
  }
  const definition: MarketplacePluginDefinition = {
    format: options.format,
    file: options.marketplaceFile,
    pointer: options.pointer,
    name: rawName,
    installable: options.installable && !candidateDiagnostics.some(item => item.level === 'error'),
    diagnostics: candidateDiagnostics,
    ...normalizedTextFields,
    ...(strict === undefined ? {} : { strict }),
    ...(typeof options.entry.defaultEnabled === 'boolean' ? { defaultEnabled: options.entry.defaultEnabled } : {}),
    sourcePathIsRoot: options.location.type === 'source-path' && options.location.path === '.',
    manifestFields,
    ...(options.entry.skills === undefined ? {} : { skills: options.entry.skills }),
    ...(options.entry.commands === undefined ? {} : { commands: options.entry.commands }),
    ...(options.entry.agents === undefined ? {} : { agents: options.entry.agents }),
    ...(options.entry.hooks === undefined ? {} : { hooks: options.entry.hooks }),
    ...(options.entry.mcpServers === undefined && options.entry.mcp_servers === undefined
      ? {}
      : { mcpServers: options.entry.mcpServers ?? options.entry.mcp_servers }),
  }
  return {
    id,
    name: rawName,
    ...normalizedTextFields,
    formats: [options.format],
    location: options.location,
    ...(typeof options.entry.defaultEnabled === 'boolean' ? { defaultEnabled: options.entry.defaultEnabled } : {}),
    installable: options.installable && !candidateDiagnostics.some(item => item.level === 'error'),
    diagnostics: candidateDiagnostics,
    definitions: [definition],
    locationKey: options.locationKey,
  }
}
