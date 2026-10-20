import { basename, dirname, resolve } from 'node:path'
import type { CompatSkill } from '../../types/skill.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { discoverCapabilityFiles, isSkillFile } from '../../shared/discovery.js'
import { frontmatterBoolean, parseFrontmatter } from '../../shared/frontmatter.js'
import { readUtf8 } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'

const DSH_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function stringAttribute(attributes: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof attributes[key] === 'string' && (attributes[key] as string).trim() !== '') return (attributes[key] as string).trim()
  return undefined
}

function inferDescription(body: string): string | undefined {
  return body.split(/\r?\n/).map(value => value.replace(/^#+\s+/, '').trim()).find(Boolean)?.slice(0, 300)
}

function isStringList(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'))
}

/** 只识别原平台会解释的字段；合法字段与无法兑现的运行语义分开诊断。 */
function claudeExecutionLimits(attributes: Record<string, unknown>, body: string, collector: DiagnosticCollector, file: string): string[] {
  const unsupported: string[] = []
  const invalid = (field: string): void => {
    collector.add('error', 'SKILL_FIELD_INVALID', 'skill', `Claude Code Skill 字段 ${field} 的类型或值无效`, file, { field })
    unsupported.push(field)
  }
  const limit = (field: string): void => {
    collector.add('error', 'SKILL_EXECUTION_UNSUPPORTED', 'skill', `DSH 尚未适配 Claude Code Skill 的 ${field} 运行语义`, file, { field })
    unsupported.push(field)
  }
  for (const field of ['disable-model-invocation', 'user-invocable', 'model-invocable', 'background']) {
    if (attributes[field] !== undefined && frontmatterBoolean(attributes[field], true) === undefined) invalid(field)
  }
  for (const field of ['name', 'description', 'when_to_use', 'argument-hint', 'model', 'agent', 'license', 'compatibility']) {
    if (attributes[field] !== undefined && typeof attributes[field] !== 'string') invalid(field)
  }
  if (typeof attributes.compatibility === 'string' && attributes.compatibility.length > 500) invalid('compatibility')
  if (attributes.metadata !== undefined && asObject(attributes.metadata) === undefined) {
    collector.add('warning', 'SKILL_METADATA_INVALID', 'skill', 'Claude Code Skill metadata 不是 map，将不作为 metadata 使用', file)
  }
  for (const field of ['allowed-tools', 'disallowed-tools', 'arguments', 'paths']) {
    const value = attributes[field]
    if (value === undefined) continue
    if (!isStringList(value)) invalid(field)
    else if ((Array.isArray(value) && value.length > 0) || (typeof value === 'string' && value.trim() !== '')) limit(field)
  }
  if (attributes.model !== undefined && typeof attributes.model === 'string' && attributes.model !== 'inherit') limit('model')
  if (attributes.effort !== undefined) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(String(attributes.effort))) invalid('effort')
    else limit('effort')
  }
  if (attributes.context !== undefined) {
    if (attributes.context !== 'fork') invalid('context')
    else limit('context:fork')
  }
  if (attributes.agent !== undefined && typeof attributes.agent === 'string') limit('agent')
  if (attributes.background !== undefined && frontmatterBoolean(attributes.background, true) !== undefined) limit('background')
  if (attributes.hooks !== undefined) {
    if (asObject(attributes.hooks) === undefined) invalid('hooks')
    else if (Object.keys(attributes.hooks as object).length > 0) limit('hooks')
  }
  if (attributes.shell !== undefined) {
    if (attributes.shell !== 'bash' && attributes.shell !== 'powershell') invalid('shell')
    else limit('shell')
  }
  if (/!`|^\s*```!/m.test(body)) limit('dynamic-shell-content')
  if (/(?:^|[^\\])(?:\\\\)*\$(?:ARGUMENTS(?:\[\d+\])?|\d+)\b|\$\{(?:CLAUDE_[A-Z_]+|user_config\.[^}]+)\}/m.test(body)) limit('content-substitution')
  if (attributes['argument-hint'] !== undefined) {
    collector.add('warning', 'SKILL_ARGUMENT_HINT_UNSUPPORTED', 'skill', 'DSH Skill Provider 不提供 Claude Code 参数补全提示', file)
  }
  return [...new Set(unsupported)]
}

export async function parseSkillsForHarness(packageRoot: string, descriptor: HarnessDescriptor, collector: DiagnosticCollector): Promise<CompatSkill[]> {
  const files = await discoverCapabilityFiles({
    packageRoot, declaredPaths: descriptor.skillPaths,
    defaultPaths: descriptor.defaultCapabilityPaths.skills ? ['SKILL.md', 'skills'] : [],
    predicate: isSkillFile, collector, capability: 'skill',
  })
  const skills: CompatSkill[] = []
  for (const file of files) {
    let parsed
    try { parsed = parseFrontmatter(await readUtf8(resolve(packageRoot, file))) } catch {
      collector.add('error', 'SKILL_FRONTMATTER_INVALID', 'skill', 'Skill frontmatter 无法解析', file)
      continue
    }
    const explicitName = stringAttribute(parsed.attributes, 'name')
    const fallbackName = basename(resolve(packageRoot, dirname(file)))
    const name = (explicitName ?? fallbackName).replace(/\s+/g, ' ')
    if (explicitName === undefined) collector.add('warning', 'SKILL_NAME_INFERRED', 'skill', `Skill 未声明 name，使用目录名 ${name}`, file)
    if (!DSH_SKILL_NAME_PATTERN.test(name)) {
      collector.add('error', 'SKILL_NAME_DSH_UNSUPPORTED', 'skill', `Skill 名称无法映射到 DSH kebab-case 名称且不会自动改名：${name}`, file)
      continue
    }
    const explicitDescription = stringAttribute(parsed.attributes, 'description')
    const description = explicitDescription ?? inferDescription(parsed.body)
    if (description === undefined) {
      collector.add('error', 'SKILL_DESCRIPTION_MISSING', 'skill', `Skill ${name} 缺少 description`, file)
      continue
    }
    if (explicitDescription === undefined) collector.add('warning', 'SKILL_DESCRIPTION_INFERRED', 'skill', `Skill ${name} 未声明 description，已从正文首行推导`, file)
    const loose = true
    const modelInvocable = frontmatterBoolean(parsed.attributes['model-invocable'], loose)
      ?? !(frontmatterBoolean(parsed.attributes['disable-model-invocation'], loose) ?? false)
    const userInvocable = frontmatterBoolean(parsed.attributes['user-invocable'], loose) ?? true
    const unsupported = claudeExecutionLimits(parsed.attributes, parsed.body, collector, file)
    const known = new Set(['name', 'description', 'when_to_use', 'when-to-use', 'whenToUse', 'model-invocable', 'disable-model-invocation', 'user-invocable'])
    const metadata = Object.fromEntries(Object.entries(parsed.attributes).filter(([key]) => !known.has(key)))
    const whenToUse = stringAttribute(parsed.attributes, ...(loose ? ['when_to_use', 'when-to-use', 'whenToUse'] : ['when-to-use', 'whenToUse']))
    skills.push({
      name, description, ...(whenToUse === undefined ? {} : { whenToUse }),
      contentPath: file, rootPath: dirname(file).replaceAll('\\', '/'),
      invocation: { modelInvocable: modelInvocable, userInvocable },
      sourceFormat: 'claude-code',
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      ...(unsupported.length === 0 ? {} : { runtimeUnsupported: [...new Set(unsupported)] }),
    })
    collector.add('info', 'SKILL_DISCOVERED', 'skill', `发现 Skill：${name}`, file)
  }
  return skills
}
