import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { readFile, realpath } from 'node:fs/promises'
import { isPathInside } from '../source/safety.js'
import { isAbsolute, join, resolve } from 'node:path'
import type { CompatPath, CompatRuntimeValue, CompatTemplate } from '../types/path.js'
import type { DshContextLike } from './context.js'
import { parseTemplate } from '../shared/template.js'
import { expandPluginPaths } from '../shared/mcp-execution.js'
import { buildPluginEnvironment } from './environment.js'

function decodePointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~')
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  if (!pointer.startsWith('/')) throw new Error(`JSON Pointer 无效：${pointer}`)
  let current = root
  for (const raw of pointer.slice(1).split('/')) {
    const key = decodePointerSegment(raw)
    if (current === null || typeof current !== 'object') throw new Error(`JSON Pointer 不存在：${pointer}`)
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

async function resolveEnvironment(ctx: DshContextLike, name: string, fallback?: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('环境变量或凭据引用名称无效')
  const credentials = ctx.get('credentials')
  // The POSIX identifier check above is the SDK credentialRef validation rule.
  const reference = name as Parameters<CredentialProvider['resolve']>[0]
  const resolved = credentials === undefined ? undefined : await credentials.resolve(reference)
  const value = resolved?.value || process.env[name] || fallback
  if (value === undefined) throw new Error(`缺少环境变量或凭据引用：${name}`)
  return value
}

export async function resolveTemplate(
  ctx: DshContextLike,
  template: CompatTemplate,
  pluginRoot: string,
  dataRoot: string,
  workspaceRoot: string,
  sensitiveValues?: Set<string>,
): Promise<string> {
  const values: string[] = []
  for (const part of template.parts) {
    if (part.type === 'text') values.push(part.value)
    else if (part.type === 'plugin-root') values.push(pluginRoot)
    else if (part.type === 'plugin-data') values.push(dataRoot)
    else if (part.type === 'workspace-root') values.push(workspaceRoot)
    else {
      const value = await resolveEnvironment(ctx, part.name, part.fallback)
      if (value !== '') sensitiveValues?.add(value)
      values.push(value)
    }
  }
  return values.join('')
}

export async function resolveRuntimeValue(
  ctx: DshContextLike,
  value: CompatRuntimeValue,
  pluginRoot: string,
  dataRoot: string,
  workspaceRoot: string,
  sensitiveValues?: Set<string>,
  sourceRoot?: string,
): Promise<string> {
  if (value.type === 'template') {
    return await resolveTemplate(ctx, value, pluginRoot, dataRoot, workspaceRoot, sensitiveValues)
  }
  if (value.base === 'source' && sourceRoot === undefined) throw new Error('Marketplace 延迟配置缺少 Source 根目录')
  const base = value.base === 'source' ? sourceRoot! : pluginRoot
  const file = resolve(base, value.file)
  const [baseReal, fileReal] = await Promise.all([realpath(base), realpath(file)])
  if (!isPathInside(baseReal, fileReal)) throw new Error('延迟配置文件逃逸声明根目录')
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(fileReal, 'utf8')) as unknown } catch {
    throw new Error(`延迟配置文件无法读取或不是有效 JSON：${value.file}`)
  }
  const resolvedValue = readJsonPointer(parsed, value.pointer)
  if (typeof resolvedValue !== 'string') throw new Error(`延迟配置值不是字符串：${value.file}#${value.pointer}`)
  if (value.sensitive === true && resolvedValue !== '') sensitiveValues?.add(resolvedValue)
  if (value.expansion === 'none') return resolvedValue
  if (value.expansion === 'exact-plugin-vars') {
    const paths = buildPluginEnvironment(value.templateBindings, pluginRoot, dataRoot, workspaceRoot)
    const expanded = expandPluginPaths(resolvedValue, paths)
    if (value.sensitive === true && expanded !== '') sensitiveValues?.add(expanded)
    return expanded
  }
  if (value.templateSyntax === 'environment') {
    const expanded = await resolveTemplate(ctx, parseTemplate(resolvedValue, value.templateBindings), pluginRoot, dataRoot, workspaceRoot, sensitiveValues)
    if (value.sensitive === true && expanded !== '') sensitiveValues?.add(expanded)
    return expanded
  }
  return resolvedValue
}

export function resolveCompatPath(path: CompatPath, pluginRoot: string, workspaceRoot: string): string {
  if (path.type === 'plugin') return join(pluginRoot, path.path)
  if (path.type === 'workspace') return join(workspaceRoot, path.path)
  if (!isAbsolute(path.path) && !/^[A-Za-z]:[\\/]/.test(path.path)) throw new Error(`absolute 路径无效：${path.path}`)
  return path.path
}
