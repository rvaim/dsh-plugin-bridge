import { basename, extname, resolve } from 'node:path'
import type { CompatCommand } from '../../types/command.js'
import type { HarnessDescriptor } from '../harness/types.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { discoverCapabilityFiles, isMarkdownFile } from '../shared/discovery.js'
import { parseFrontmatter } from '../shared/frontmatter.js'
import { readUtf8 } from '../shared/fs.js'

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
        sourceFormat: descriptor.format,
        ...(Object.keys(parsed.attributes).length === 0 ? {} : { metadata: parsed.attributes }),
      })
      collector.add('warning', 'COMMAND_RUNTIME_UNSUPPORTED', 'command', `已识别 Command ${name}，第一版暂不注册运行`, file)
    } catch (error) {
      collector.add('error', 'COMMAND_PARSE_FAILED', 'command', `Command 解析失败：${String(error)}`, file)
    }
  }
  return commands
}
