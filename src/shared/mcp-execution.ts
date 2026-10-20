import { mkdir, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { CompatPluginEnvironmentBindings } from '../types/environment.js'
import type { CompatPath } from '../types/path.js'
import { inspectContainedPath, resolveContainedPath } from './contained-path.js'

/** Replace only explicitly supplied placeholders, exactly once. */
export function expandPluginPaths(value: string, paths: Record<string, string> = {}): string {
  return value.replace(/\$\{([^{}]*)\}/g, (match, name: string) => Object.hasOwn(paths, name) ? paths[name] : match)
}

/** Check explicit reserved names using the platform's own name equivalence. */
export function isReservedPathEnvironmentName(
  name: string, bindings: CompatPluginEnvironmentBindings = {}, platform: NodeJS.Platform = process.platform,
): boolean {
  const normalize = (value: string): string => platform === 'win32' ? value.toUpperCase() : value
  return Object.keys(bindings).some(reserved => normalize(reserved) === normalize(name))
}

export function validateProcessEnvironment(
  env: Record<string, string>, bindings: CompatPluginEnvironmentBindings = {}, platform: NodeJS.Platform = process.platform,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (isReservedPathEnvironmentName(name, bindings, platform)) throw new Error('受限 MCP env 不能声明保留路径变量')
    if (name === '' || /[=\0]/.test(name) || value.includes('\0')) throw new Error('受限 MCP env 名称或值无法传给子进程')
  }
}

/** DSH supplies the ambient environment; explicit reserved paths take precedence. */
export function buildProcessEnvironment(
  env: Record<string, string>, reservedEnvironment: Record<string, string> = {}, platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const normalize = (values: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(values)
    .map(([name, value]) => [platform === 'win32' ? name.toUpperCase() : name, value]))
  return { ...normalize(env), ...normalize(reservedEnvironment) }
}

/** A command is one executable token; never a shell command or an expanded path. */
export function validateExecutableToken(command: string): 'plugin' | 'bare' {
  if (command === '' || /[\0-\x1f\x7f]/.test(command)) throw new Error('受限 MCP command 不能包含控制字符')
  if (command.startsWith('./')) return 'plugin'
  if (/[\s"'`|;&<>()]/.test(command)) throw new Error('受限 MCP bare command 必须是单个可执行文件名')
  if (command === '.' || command === '..' || /[\\/:]/.test(command)) throw new Error('受限 MCP command 必须是裸可执行文件名或 ./ 插件相对路径')
  return 'bare'
}

export async function resolveContainedCommand(pluginRoot: string, command: string): Promise<string> {
  if (validateExecutableToken(command) === 'bare') return command
  const inspected = await inspectContainedPath(pluginRoot, resolve(pluginRoot, command), 'file')
  if (inspected.status !== 'ok') throw new Error('受限 MCP command 必须解析为插件根目录内的实际文件')
  return inspected.path
}

/** Store an explicit cwd anchor independently from the eventual installation. */
export function parseAnchoredCwd(value: string | undefined, bindings: CompatPluginEnvironmentBindings = {}): CompatPath {
  if (value === undefined) return { type: 'plugin', path: '.' }
  if (value.includes('\0')) throw new Error('受限 MCP cwd 无效')
  if (value.startsWith('./')) return { type: 'plugin', path: value }
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding !== 'plugin-root' && binding !== 'plugin-data') continue
    const placeholder = '${' + name + '}'
    if (value === placeholder || value.startsWith(`${placeholder}/`)) {
      return { type: binding === 'plugin-root' ? 'plugin' : 'data', path: `.${value.slice(placeholder.length)}` }
    }
  }
  throw new Error('受限 MCP cwd 必须以 ./ 或显式绑定的插件、数据路径变量为根')
}

function executionPaths(bindings: CompatPluginEnvironmentBindings, pluginRoot: string, dataRoot: string): Record<string, string> {
  return Object.fromEntries(Object.entries(bindings)
    .filter(([, binding]) => binding === 'plugin-root' || binding === 'plugin-data')
    .map(([name, binding]) => [name, binding === 'plugin-root' ? pluginRoot : dataRoot]))
}

export async function validateCwdAtScan(pluginRoot: string, cwd: CompatPath, bindings: CompatPluginEnvironmentBindings = {}): Promise<void> {
  if (cwd.type === 'data') return
  if (cwd.type !== 'plugin') throw new Error('受限 MCP cwd 锚点无效')
  // Data paths become available at launch; the final target is still contained.
  if (Object.entries(bindings).some(([name, binding]) => binding === 'plugin-data' && cwd.path.includes('${' + name + '}'))) return
  const root = await realpath(pluginRoot)
  const path = expandPluginPaths(cwd.path, executionPaths(bindings, root, ''))
  const inspected = await inspectContainedPath(root, resolve(root, path), 'directory')
  if (inspected.status !== 'ok') throw new Error('受限 MCP cwd 必须解析为插件根目录内的实际目录')
}

export async function prepareExecutionRoots(pluginRoot: string, dataRoot: string): Promise<{ pluginRoot: string; dataRoot: string }> {
  const root = await realpath(pluginRoot)
  if (!(await stat(root)).isDirectory()) throw new Error('受限 MCP 插件根目录不是目录')
  await mkdir(dataRoot, { recursive: true })
  const data = await realpath(dataRoot)
  if (!(await stat(data)).isDirectory()) throw new Error('受限 MCP 数据根目录不是目录')
  return { pluginRoot: root, dataRoot: data }
}

export async function resolveAnchoredCwd(
  cwd: CompatPath | undefined, pluginRoot: string, dataRoot: string, bindings: CompatPluginEnvironmentBindings = {},
): Promise<string> {
  const configured = cwd ?? { type: 'plugin', path: '.' }
  if (configured.type !== 'plugin' && configured.type !== 'data') throw new Error('受限 MCP cwd 锚点无效')
  const root = configured.type === 'data' ? dataRoot : pluginRoot
  const expanded = expandPluginPaths(configured.path, executionPaths(bindings, pluginRoot, dataRoot))
  const path = await resolveContainedPath(root, resolve(root, expanded))
  const inspected = await inspectContainedPath(root, path, 'directory')
  if (inspected.status !== 'ok') throw new Error('受限 MCP cwd 必须解析为声明根目录内的实际目录')
  return inspected.path
}

export function validateEndpointUrl(value: string): void {
  if (!/^https?:\/\//i.test(value) || /[\s\0-\x1f\x7f]/.test(value) || value.includes('#')) throw new Error('受限 MCP URL 必须是无用户信息和 fragment 的绝对 HTTP(S) URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('受限 MCP URL 无效') }
  if (url.username !== '' || url.password !== '') throw new Error('受限 MCP URL 不能包含用户信息')
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1] ?? ''
  if (authority.includes('@') || authority.includes('\\')) throw new Error('受限 MCP URL 不能包含用户信息或反斜杠')
  const rawHost = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0]!
  const loopback = rawHost.toLowerCase() === 'localhost'
    || (isIP(rawHost) === 4 && rawHost.split('.')[0] === '127')
    || (isIP(rawHost) === 6 && url.hostname === '[::1]')
  if (url.protocol !== 'https:' && !loopback) throw new Error('受限 MCP 非 loopback URL 必须使用 HTTPS')
}

export function validateHttpHeaders(headers: Record<string, string>): void {
  const names = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error('受限 MCP HTTP Header 名称或值无效')
    const normalized = name.toLowerCase()
    if (names.has(normalized)) throw new Error('受限 MCP HTTP Header 名称存在大小写重复')
    names.add(normalized)
  }
}

/** The MCP client currently cannot restrict configured headers across redirects. */
export function assertConfiguredHeadersSupported(headers: Record<string, unknown>): void {
  if (Object.keys(headers).length > 0) throw new Error('当前 DSH MCP client 不支持限制 configured headers 跨 origin 重定向；此受限 MCP HTTP entry 尚不能运行')
}
