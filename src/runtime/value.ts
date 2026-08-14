import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { CompatPath, CompatRuntimeValue, CompatTemplate } from '../types/path.js'
import type { DshContextLike } from './context.js'

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

async function resolveEnvironment(ctx: DshContextLike, name: string): Promise<string> {
  const credentials = ctx.credentials ?? ctx.get?.('credentials')
  const resolved = credentials === undefined ? undefined : await credentials.resolve(name)
  const value = resolved?.value ?? process.env[name]
  if (value === undefined || value === '') throw new Error(`缺少环境变量或凭据引用：${name}`)
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
      const value = await resolveEnvironment(ctx, part.name)
      sensitiveValues?.add(value)
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
): Promise<string> {
  if (value.type === 'template') {
    return await resolveTemplate(ctx, value, pluginRoot, dataRoot, workspaceRoot, sensitiveValues)
  }
  const file = resolve(pluginRoot, value.file)
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
  const resolvedValue = readJsonPointer(parsed, value.pointer)
  if (typeof resolvedValue !== 'string') throw new Error(`延迟配置值不是字符串：${value.file}#${value.pointer}`)
  if (value.sensitive === true) sensitiveValues?.add(resolvedValue)
  return resolvedValue
}

export function resolveCompatPath(path: CompatPath, pluginRoot: string, workspaceRoot: string): string {
  if (path.type === 'plugin') return join(pluginRoot, path.path)
  if (path.type === 'workspace') return join(workspaceRoot, path.path)
  if (!isAbsolute(path.path) && !/^[A-Za-z]:[\\/]/.test(path.path)) throw new Error(`absolute 路径无效：${path.path}`)
  return path.path
}
