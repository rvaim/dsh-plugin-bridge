import { basename, dirname, relative, resolve } from 'node:path'
import type { CompatSkill } from '../../types/skill.js'
import type { HarnessDescriptor } from '../../types/protocol.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { discoverCapabilityFiles, isSkillFile } from '../../shared/discovery.js'
import { frontmatterBoolean, parseFrontmatter, parseYamlObject } from '../../shared/frontmatter.js'
import { readUtf8 } from '../../shared/fs.js'
import { asObject } from '../../shared/object.js'

const DSH_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function stringAttribute(attributes: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof attributes[key] === 'string' && (attributes[key] as string).trim() !== '') return (attributes[key] as string).trim()
  return undefined
}

async function codexSidecar(packageRoot: string, skillFile: string, collector: DiagnosticCollector): Promise<{
  modelInvocable?: boolean
  metadata?: Record<string, unknown>
  unsupported: string[]
}> {
  const file = `${dirname(skillFile).replaceAll('\\', '/')}/agents/openai.yaml`
  let text: string
  try { text = await readUtf8(resolve(packageRoot, file)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unsupported: [] }
    collector.add('error', 'SKILL_CODEX_CONFIG_INVALID', 'skill', 'Codex agents/openai.yaml 无法读取', file)
    return { unsupported: ['agents/openai.yaml'] }
  }
  let config: Record<string, unknown>
  try { config = parseYamlObject(text) } catch {
    collector.add('error', 'SKILL_CODEX_CONFIG_INVALID', 'skill', 'Codex agents/openai.yaml 必须为有效 YAML map', file)
    return { unsupported: ['agents/openai.yaml'] }
  }
  const unsupported: string[] = []
  const invalid = (field: string): void => {
    collector.add('error', 'SKILL_CODEX_CONFIG_FIELD_INVALID', 'skill', `Codex agents/openai.yaml 字段 ${field} 无效`, file, { field })
    unsupported.push(field)
  }
  const metadata: Record<string, unknown> = {}
  const policy = asObject(config.policy)
  let modelInvocable: boolean | undefined
  if (config.policy !== undefined && policy === undefined) invalid('policy')
  if (policy !== undefined) {
    if (policy.allow_implicit_invocation !== undefined) {
      if (typeof policy.allow_implicit_invocation !== 'boolean') invalid('policy.allow_implicit_invocation')
      else modelInvocable = policy.allow_implicit_invocation
    }
    if (policy.products !== undefined) {
      if (!Array.isArray(policy.products) || policy.products.some(item => typeof item !== 'string' || !['chatgpt', 'codex', 'atlas', 'CHATGPT', 'CODEX', 'ATLAS'].includes(item))) invalid('policy.products')
      else if (policy.products.length > 0) {
        collector.add('error', 'SKILL_PRODUCT_POLICY_UNSUPPORTED', 'skill', 'DSH 无法兑现 Codex Skill 的产品限制', file)
        unsupported.push('policy.products')
      }
    }
    for (const key of Object.keys(policy)) {
      if (!['allow_implicit_invocation', 'products'].includes(key)) {
        collector.add('error', 'SKILL_POLICY_UNSUPPORTED', 'skill', `DSH 未适配 Codex Skill policy.${key}`, file)
        unsupported.push(`policy.${key}`)
      }
    }
  }
  if (config.interface !== undefined) {
    const ui = asObject(config.interface)
    if (ui === undefined) invalid('interface')
    else {
      const checked: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(ui)) {
        const max = key === 'display_name' ? 64 : 1024
        if (typeof value !== 'string') { invalid(`interface.${key}`); continue }
        const singleLine = value.trim().replace(/\s+/g, ' ')
        if (['display_name', 'short_description', 'default_prompt'].includes(key) && (singleLine === '' || [...singleLine].length > max)) {
          collector.add('warning', 'SKILL_INTERFACE_FIELD_INVALID', 'skill', `Codex interface.${key} 为空或超过上游长度限制，忽略`, file)
          continue
        }
        if (key === 'brand_color' && !/^#[0-9a-f]{6}$/i.test(value.trim())) {
          collector.add('warning', 'SKILL_INTERFACE_FIELD_INVALID', 'skill', 'Codex interface.brand_color 必须为 #RRGGBB，忽略', file)
          continue
        }
        if (key === 'icon_small' || key === 'icon_large') {
          const target = resolve(packageRoot, dirname(skillFile), value)
          const localAsset = relative(resolve(packageRoot, dirname(skillFile), 'assets'), target)
          const sharedAsset = relative(resolve(packageRoot, 'assets'), target)
          if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || (localAsset.startsWith('..') && sharedAsset.startsWith('..'))) {
            collector.add('warning', 'SKILL_INTERFACE_FIELD_INVALID', 'skill', `Codex interface.${key} 必须位于技能或插件 assets 目录，忽略`, file)
            continue
          }
        }
        checked[key] = singleLine
      }
      metadata.interface = checked
      if (Object.keys(checked).length > 0) collector.add('warning', 'SKILL_INTERFACE_UNSUPPORTED', 'skill', 'Codex Skill 展示字段已校验；DSH Skill Provider 不渲染这些字段或 default_prompt', file)
    }
  }
  if (config.dependencies !== undefined) {
    const dependencies = asObject(config.dependencies)
    if (dependencies === undefined || (dependencies.tools !== undefined && !Array.isArray(dependencies.tools))) invalid('dependencies.tools')
    else if (Array.isArray(dependencies.tools)) {
      for (const [index, item] of dependencies.tools.entries()) {
        const tool = asObject(item)
        if (tool === undefined || typeof tool.type !== 'string' || tool.type.trim() === '' || typeof tool.value !== 'string' || tool.value.trim() === '') {
          invalid(`dependencies.tools[${index}]`)
          continue
        }
        for (const key of ['description', 'transport', 'command', 'url']) if (tool[key] !== undefined && typeof tool[key] !== 'string') invalid(`dependencies.tools[${index}].${key}`)
        if (tool.oauth_callback_port !== undefined && (typeof tool.oauth_callback_port !== 'number' || !Number.isInteger(tool.oauth_callback_port) || tool.oauth_callback_port < 0 || tool.oauth_callback_port > 65535)) invalid(`dependencies.tools[${index}].oauth_callback_port`)
      }
      if (dependencies.tools.length > 0) {
        collector.add('error', 'SKILL_DEPENDENCIES_UNSUPPORTED', 'skill', 'DSH 尚未适配 Codex Skill 工具依赖发现/授权；不会自动安装依赖', file)
        unsupported.push('dependencies.tools')
      }
    }
  }
  for (const key of Object.keys(config)) {
    if (['interface', 'policy', 'dependencies'].includes(key)) continue
    collector.add('warning', 'SKILL_CODEX_CONFIG_FIELD_UNSUPPORTED', 'skill', `Codex Skill sidecar 字段 ${key} 未适配`, file)
  }
  return { modelInvocable, metadata: Object.keys(metadata).length === 0 ? undefined : metadata, unsupported }
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
    if (descriptor.format === 'codex') {
      const invalidField = ['name', 'description'].find(key => parsed.attributes[key] !== undefined && typeof parsed.attributes[key] !== 'string')
      const metadata = parsed.attributes.metadata
      const metadataObject = asObject(metadata)
      if (invalidField !== undefined || (metadata !== undefined && metadataObject === undefined)
        || (metadataObject?.['short-description'] !== undefined && typeof metadataObject['short-description'] !== 'string')) {
        collector.add('error', 'SKILL_FIELD_INVALID', 'skill', 'Codex Skill name/description 必须为字符串，metadata 必须为 map 且 short-description 必须为字符串', file)
        continue
      }
    }
    const explicitName = stringAttribute(parsed.attributes, 'name')
    const fallbackName = basename(resolve(packageRoot, dirname(file)))
    const name = (explicitName ?? fallbackName).replace(/\s+/g, ' ')
    if (explicitName === undefined) collector.add('warning', 'SKILL_NAME_INFERRED', 'skill', `Skill 未声明 name，使用目录名 ${name}`, file)
    if (descriptor.format === 'codex' && [...name].length > 64) {
      collector.add('error', 'SKILL_NAME_INVALID', 'skill', 'Codex Skill name 超过 64 字符上游限制', file)
      continue
    }
    if (!DSH_SKILL_NAME_PATTERN.test(name)) {
      collector.add('error', 'SKILL_NAME_DSH_UNSUPPORTED', 'skill', `Skill 名称无法映射到 DSH kebab-case 名称且不会自动改名：${name}`, file)
      continue
    }
    const explicitDescription = stringAttribute(parsed.attributes, 'description')
    const description = explicitDescription ?? undefined
    if (description === undefined) {
      collector.add('error', 'SKILL_DESCRIPTION_MISSING', 'skill', `Skill ${name} 缺少 description`, file)
      continue
    }
    if (explicitDescription === undefined) collector.add('warning', 'SKILL_DESCRIPTION_INFERRED', 'skill', `Skill ${name} 未声明 description，已从正文首行推导`, file)
    const loose = false
    const modelInvocable = frontmatterBoolean(parsed.attributes['model-invocable'], loose)
      ?? !(frontmatterBoolean(parsed.attributes['disable-model-invocation'], loose) ?? false)
    const userInvocable = frontmatterBoolean(parsed.attributes['user-invocable'], loose) ?? true
    const unsupported: string[] = []
    const sidecar = await codexSidecar(packageRoot, file, collector)
    unsupported.push(...sidecar?.unsupported ?? [])
    const known = new Set(['name', 'description', 'when_to_use', 'when-to-use', 'whenToUse', 'model-invocable', 'disable-model-invocation', 'user-invocable'])
    const metadata = Object.fromEntries(Object.entries(parsed.attributes).filter(([key]) => !known.has(key)))
    if (sidecar?.metadata !== undefined) metadata.codex = sidecar.metadata
    const whenToUse = stringAttribute(parsed.attributes, ...(loose ? ['when_to_use', 'when-to-use', 'whenToUse'] : ['when-to-use', 'whenToUse']))
    skills.push({
      name, description, ...(whenToUse === undefined ? {} : { whenToUse }),
      contentPath: file, rootPath: dirname(file).replaceAll('\\', '/'),
      invocation: { modelInvocable: sidecar?.modelInvocable ?? modelInvocable, userInvocable },
      sourceFormat: 'codex',
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      ...(unsupported.length === 0 ? {} : { runtimeUnsupported: [...new Set(unsupported)] }),
    })
    collector.add('info', 'SKILL_DISCOVERED', 'skill', `发现 Skill：${name}`, file)
  }
  return skills
}
