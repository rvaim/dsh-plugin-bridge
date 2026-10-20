import { basename, extname, resolve } from 'node:path'
import type { CompatCommand } from '../../types/command.js'
import { normalizeDeclaredPaths } from './harness-common.js'
import { asObject } from '../../shared/object.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { discoverCapabilityFiles, isMarkdownFile } from '../../shared/discovery.js'
import { parseFrontmatter } from '../../shared/frontmatter.js'
import { readUtf8 } from '../../shared/fs.js'

export async function parseCommandsForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatCommand[]> {
  const files = await discoverCapabilityFiles({
    packageRoot,
    declaredPaths: descriptor.commandPaths,
    defaultPaths: descriptor.defaultCapabilityPaths.commands ? ['commands'] : [],
    predicate: isMarkdownFile,
    collector,
    capability: 'command',
  })
  const commands: CompatCommand[] = []
  for (const file of files) {
    try {
      const parsed = parseFrontmatter(await readUtf8(resolve(packageRoot, file)))
      const name = typeof parsed.attributes.name === 'string'
        ? parsed.attributes.name
        : basename(file, extname(file))
      const description = typeof parsed.attributes.description === 'string' ? parsed.attributes.description : undefined
      commands.push({
        name,
        ...(description === undefined ? {} : { description }),
        contentPath: file,
        sourceFormat: 'claude-code',
        ...(Object.keys(parsed.attributes).length === 0 ? {} : { metadata: parsed.attributes }),
      })
      collector.add('warning', 'COMMAND_RUNTIME_UNSUPPORTED', 'command', `已识别 Command ${name}，第一版暂不注册运行`, file)
    } catch (error) {
      collector.add('error', 'COMMAND_PARSE_FAILED', 'command', `Command 解析失败：${String(error)}`, file)
    }
  }
  for (const definition of descriptor.commandDefinitions ?? []) {
    const value = asObject(definition.value)
    if (value === undefined || definition.name.trim() === '' || /[\s/\\\u0000-\u001f]/.test(definition.name)) {
      collector.add('error', 'COMMAND_DEFINITION_INVALID', 'command', 'Command 对象条目必须有有效名称和对象值', definition.file)
      continue
    }
    const hasSource = value.source !== undefined
    const hasContent = value.content !== undefined
    if (hasSource === hasContent || (hasSource && typeof value.source !== 'string') || (hasContent && typeof value.content !== 'string')) {
      collector.add('error', 'COMMAND_CONTENT_SOURCE_INVALID', 'command', `Command ${definition.name} 必须且只能设置一个字符串 source 或 content`, definition.file)
      continue
    }
    let valid = true
    for (const key of ['description', 'argumentHint', 'model']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        collector.add('error', 'COMMAND_METADATA_INVALID', 'command', `Command ${definition.name} 的 ${key} 必须是字符串`, definition.file)
        valid = false
      }
    }
    if (value.allowedTools !== undefined && (!Array.isArray(value.allowedTools) || value.allowedTools.some(item => typeof item !== 'string'))) {
      collector.add('error', 'COMMAND_METADATA_INVALID', 'command', `Command ${definition.name} 的 allowedTools 必须是字符串数组`, definition.file)
      valid = false
    }
    if (!valid) continue
    let contentPath = definition.file
    let attributes: Record<string, unknown> = {}
    if (hasSource) {
      const paths = await normalizeDeclaredPaths(packageRoot, [value.source as string], collector, 'command', definition.file, { kind: 'file', requireExists: true })
      if (paths.length === 0) continue
      contentPath = paths[0]
      try { attributes = parseFrontmatter(await readUtf8(resolve(packageRoot, contentPath))).attributes }
      catch (error) {
        collector.add('error', 'COMMAND_PARSE_FAILED', 'command', `Command 解析失败：${String(error)}`, contentPath)
        continue
      }
    }
    const metadata = { ...attributes }
    for (const key of ['description', 'argumentHint', 'model', 'allowedTools']) if (value[key] !== undefined) metadata[key] = value[key]
    const description = typeof metadata.description === 'string' ? metadata.description : undefined
    commands.push({
      name: definition.name,
      ...(description === undefined ? {} : { description }),
      contentPath,
      ...(hasContent ? { contentSource: { type: 'inline' as const, pointer: `${definition.pointer}/content` } } : {}),
      sourceFormat: 'claude-code',
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    })
    collector.add('warning', 'COMMAND_RUNTIME_UNSUPPORTED', 'command', `已识别 Command ${definition.name}，当前暂不注册运行`, contentPath)
  }
  return commands
}
