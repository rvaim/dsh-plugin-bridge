import { resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { isPathInside } from '../../source/safety.js'
import { pathExists, readJson, toPluginRelative } from '../shared/fs.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 读取清单中的能力路径列表，并对每个非法项产生诊断。
 *
 * 不使用 Array.filter 静默丢弃错误项，避免旧插件看似安装成功但能力悄然缺失。
 */
export function declaredPathList(
  value: unknown,
  collector: DiagnosticCollector,
  capability: 'skill' | 'command' | 'agent',
  fieldName: string,
  manifestPath?: string,
): string[] {
  if (value === undefined) return []
  const items = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const [index, item] of items.entries()) {
    if (typeof item === 'string' && item.trim() !== '') {
      result.push(item)
      continue
    }
    collector.add(
      'error',
      'DECLARED_PATH_INVALID',
      capability,
      `${fieldName}${Array.isArray(value) ? ` 第 ${index + 1} 项` : ''}必须是非空路径字符串`,
      manifestPath,
    )
  }
  return result
}

export async function loadManifest(
  packageRoot: string,
  relativePath: string,
  collector: DiagnosticCollector,
): Promise<Record<string, unknown>> {
  const absolute = resolve(packageRoot, relativePath)
  try {
    const value = await readJson(absolute)
    const object = asObject(value)
    if (object === undefined) throw new Error('清单顶层必须是对象')
    return object
  } catch (error) {
    collector.add('error', 'PLUGIN_MANIFEST_INVALID', 'plugin', `插件清单无法解析：${String(error)}`, relativePath)
    return {}
  }
}

export async function normalizeDeclaredPaths(
  packageRoot: string,
  values: string[],
  collector: DiagnosticCollector,
  capability: 'skill' | 'command' | 'agent',
  manifestPath?: string,
): Promise<string[]> {
  const result: string[] = []
  for (const raw of values) {
    const normalized = raw.replace(/^\.\//, '').replaceAll('\\', '/')
    const absolute = resolve(packageRoot, normalized)
    if (!isPathInside(packageRoot, absolute)) {
      collector.add('error', 'DECLARED_PATH_ESCAPE', capability, `清单路径逃逸插件目录：${raw}`, manifestPath)
      continue
    }
    result.push(normalized)
  }
  return result
}

export async function collectConfigSources(
  packageRoot: string,
  manifestPath: string | undefined,
  value: unknown,
  defaultFile: string,
  fieldName: string,
  collector: DiagnosticCollector,
  capability: 'mcp' | 'hook',
): Promise<Array<{ file: string; inline?: unknown; pointer?: string }>> {
  const result: Array<{ file: string; inline?: unknown; pointer?: string }> = []

  // 显式清单字段覆盖默认路径；显式空数组可用于关闭默认配置。
  if (value === undefined) {
    if (await pathExists(resolve(packageRoot, defaultFile))) result.push({ file: defaultFile })
    return result
  }

  const addPath = async (raw: string): Promise<void> => {
    const normalized = raw.replace(/^\.\//, '').replaceAll('\\', '/')
    const absolute = resolve(packageRoot, normalized)
    if (!isPathInside(packageRoot, absolute)) {
      collector.add('error', 'DECLARED_PATH_ESCAPE', capability, `清单路径逃逸插件目录：${raw}`, manifestPath)
      return
    }
    if (!await pathExists(absolute)) {
      collector.add('warning', 'DECLARED_PATH_MISSING', capability, `清单声明的文件不存在：${raw}`, manifestPath)
      return
    }
    const info = await lstat(absolute)
    if (!info.isFile()) {
      collector.add('error', 'DECLARED_CONFIG_NOT_FILE', capability, `清单声明的配置不是文件：${raw}`, manifestPath)
      return
    }
    result.push({ file: toPluginRelative(packageRoot, absolute) })
  }

  const addInline = (inline: Record<string, unknown>, pointer: string): void => {
    if (manifestPath === undefined) {
      collector.add('error', 'INLINE_CONFIG_WITHOUT_MANIFEST', capability, `无法定位内联 ${fieldName} 配置`, defaultFile)
      return
    }
    result.push({ file: manifestPath, inline, pointer })
  }

  const items = Array.isArray(value) ? value : [value]
  for (const [index, item] of items.entries()) {
    if (typeof item === 'string') {
      await addPath(item)
      continue
    }
    const inline = asObject(item)
    if (inline !== undefined) {
      addInline(inline, Array.isArray(value) ? `/${fieldName}/${index}` : `/${fieldName}`)
      continue
    }
    collector.add(
      'error',
      'DECLARED_CONFIG_INVALID',
      capability,
      `${fieldName}${Array.isArray(value) ? ` 第 ${index + 1} 项` : ''}必须是路径或对象`,
      manifestPath,
    )
  }

  const unique = new Map(result.map(item => [`${item.file}:${item.pointer ?? ''}`, item]))
  return [...unique.values()]
}

export async function collectMergedConfigSources(
  packageRoot: string,
  manifestPath: string | undefined,
  manifestValue: unknown,
  definition: { file: string; pointer: string; value: unknown } | undefined,
  defaultFile: string,
  fieldName: string,
  collector: DiagnosticCollector,
  capability: 'mcp' | 'hook',
): Promise<Array<{ file: string; inline?: unknown; pointer?: string }>> {
  if (manifestValue === undefined && definition === undefined) {
    return await collectConfigSources(packageRoot, manifestPath, undefined, defaultFile, fieldName, collector, capability)
  }
  const result: Array<{ file: string; inline?: unknown; pointer?: string }> = []
  if (manifestValue !== undefined) {
    result.push(...await collectConfigSources(packageRoot, manifestPath, manifestValue, defaultFile, fieldName, collector, capability))
  }
  if (definition !== undefined) {
    result.push(...await collectConfigSources(
      packageRoot,
      definition.file,
      definition.value,
      defaultFile,
      fieldName,
      collector,
      capability,
    ).then(items => items.map(item => ({ ...item, pointer: item.pointer === undefined ? definition.pointer : `${definition.pointer}${item.pointer}` }))))
  }
  const unique = new Map(result.map(item => [`${item.file}:${item.pointer ?? ''}`, item]))
  return [...unique.values()]
}
