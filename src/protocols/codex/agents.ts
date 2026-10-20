import { basename, extname, resolve } from 'node:path'
import type { CompatAgent } from '../../types/agent.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { discoverCapabilityFiles, isMarkdownFile } from '../../shared/discovery.js'
import { parseFrontmatter } from '../../shared/frontmatter.js'
import { readUtf8 } from '../../shared/fs.js'

export async function parseAgentsForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatAgent[]> {
  const files = await discoverCapabilityFiles({
    packageRoot,
    declaredPaths: descriptor.agentPaths,
    defaultPaths: descriptor.defaultCapabilityPaths.agents ? ['agents'] : [],
    predicate: isMarkdownFile,
    collector,
    capability: 'agent',
  })
  const agents: CompatAgent[] = []
  for (const file of files) {
    try {
      const parsed = parseFrontmatter(await readUtf8(resolve(packageRoot, file)))
      const name = typeof parsed.attributes.name === 'string'
        ? parsed.attributes.name
        : basename(file, extname(file))
      const description = typeof parsed.attributes.description === 'string' ? parsed.attributes.description : undefined
      agents.push({
        name,
        ...(description === undefined ? {} : { description }),
        contentPath: file,
        sourceFormat: 'codex',
        ...(Object.keys(parsed.attributes).length === 0 ? {} : { metadata: parsed.attributes }),
      })
      collector.add('warning', 'AGENT_RUNTIME_UNSUPPORTED', 'agent', `已识别 Agent ${name}，第一版暂不注册运行`, file)
    } catch (error) {
      collector.add('error', 'AGENT_PARSE_FAILED', 'agent', `Agent 解析失败：${String(error)}`, file)
    }
  }
  return agents
}
