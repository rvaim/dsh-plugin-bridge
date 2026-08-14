import { basename, dirname } from 'node:path'
import type { CompatSkill } from '../../types/skill.js'
import type { HarnessDescriptor } from '../harness/types.js'
import type { DiagnosticCollector } from '../shared/diagnostics.js'
import { discoverCapabilityFiles, isSkillFile } from '../shared/discovery.js'
import { parseFrontmatter } from '../shared/frontmatter.js'
import { readUtf8 } from '../shared/fs.js'
import { resolve } from 'node:path'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function stringAttribute(attributes: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof attributes[key] === 'string' && (attributes[key] as string).trim() !== '') return (attributes[key] as string).trim()
  return undefined
}

function booleanAttribute(attributes: Record<string, unknown>, key: string): boolean | undefined {
  return typeof attributes[key] === 'boolean' ? attributes[key] as boolean : undefined
}

function inferDescription(body: string): string | undefined {
  const paragraphs = body.split(/\n\s*\n/).map(value => value.replace(/^#+\s+/gm, '').trim()).filter(Boolean)
  return paragraphs.find(value => !value.startsWith('```'))?.replace(/\s+/g, ' ').slice(0, 300)
}

export async function parseSkillsForHarness(
  packageRoot: string,
  descriptor: HarnessDescriptor,
  collector: DiagnosticCollector,
): Promise<CompatSkill[]> {
  const files = await discoverCapabilityFiles({
    packageRoot,
    declaredPaths: descriptor.skillPaths,
    defaultPaths: descriptor.defaultCapabilityPaths.skills ? ['SKILL.md', 'skills'] : [],
    predicate: isSkillFile,
    collector,
    capability: 'skill',
  })
  const skills: CompatSkill[] = []
  for (const file of files) {
    let parsed
    try {
      parsed = parseFrontmatter(await readUtf8(resolve(packageRoot, file)))
    } catch (error) {
      collector.add('error', 'SKILL_FRONTMATTER_INVALID', 'skill', `Skill frontmatter 无法解析：${String(error)}`, file)
      continue
    }
    const fallbackName = basename(dirname(file)).toLowerCase()
    const explicitName = stringAttribute(parsed.attributes, 'name')
    const name = explicitName ?? fallbackName
    if (explicitName === undefined) {
      collector.add('warning', 'SKILL_NAME_INFERRED', 'skill', `Skill 未声明 name，使用目录名 ${name}`, file)
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      collector.add('error', 'SKILL_NAME_INVALID', 'skill', `Skill 名称必须为 kebab-case，且不会被自动改名：${name}`, file)
      continue
    }
    const explicitDescription = stringAttribute(parsed.attributes, 'description')
    const description = explicitDescription ?? inferDescription(parsed.body)
    if (description === undefined) {
      collector.add('error', 'SKILL_DESCRIPTION_MISSING', 'skill', `Skill ${name} 缺少 description`, file)
      continue
    }
    if (explicitDescription === undefined) {
      collector.add('warning', 'SKILL_DESCRIPTION_INFERRED', 'skill', `Skill ${name} 未声明 description，已从正文首段推导`, file)
    }
    const modelInvocable = booleanAttribute(parsed.attributes, 'model-invocable')
      ?? !(booleanAttribute(parsed.attributes, 'disable-model-invocation') ?? false)
    const userInvocable = booleanAttribute(parsed.attributes, 'user-invocable') ?? true
    const known = new Set([
      'name', 'description', 'when-to-use', 'whenToUse', 'model-invocable',
      'disable-model-invocation', 'user-invocable',
    ])
    const metadata = Object.fromEntries(Object.entries(parsed.attributes).filter(([key]) => !known.has(key)))
    skills.push({
      name,
      description,
      ...(stringAttribute(parsed.attributes, 'when-to-use', 'whenToUse') === undefined
        ? {}
        : { whenToUse: stringAttribute(parsed.attributes, 'when-to-use', 'whenToUse') }),
      contentPath: file,
      rootPath: dirname(file).replaceAll('\\', '/'),
      invocation: { modelInvocable, userInvocable },
      sourceFormat: descriptor.format,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    })
    collector.add('info', 'SKILL_DISCOVERED', 'skill', `发现 Skill：${name}`, file)
  }
  return skills
}
