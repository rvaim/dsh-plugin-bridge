import { readdir, readFile } from 'node:fs/promises'
import type { CompatSkill } from '../../types/skill.js'
import type { DiagnosticCollector } from '../../shared/diagnostics.js'
import { parseFrontmatter } from '../../shared/frontmatter.js'
import { asObject } from '../../shared/object.js'
import { inspectContainedPath } from '../../shared/contained-path.js'

const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KNOWN_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])

function characterLength(value: string): number {
  return [...value].length
}

function validName(value: string): boolean {
  return characterLength(value) >= 1 && characterLength(value) <= 64
    && /^[\p{L}\p{N}-]+$/u.test(value) && value === value.toLowerCase()
    && !value.startsWith('-') && !value.endsWith('-') && !value.includes('--')
}

/**
 * 只扫描固定 skills/ 的直接子目录，复用项目现有 YAML 子集解析器。
 * 只输出路径与 frontmatter 元数据，正文留给 Skill Provider 按需加载。
 */
export async function parseAgentPluginSkills(root: string, collector: DiagnosticCollector): Promise<CompatSkill[]> {
  const warn = (code: string, message: string, file: string, field?: string): void => {
    collector.add('warning', code, 'skill', message, file, field === undefined ? undefined : { field })
  }
  let rootEntries: string[]
  try { rootEntries = await readdir(root) } catch {
    warn('AGENT_PLUGIN_SKILLS_PATH_INVALID', 'Agent Plugins skills/ 无法读取，已禁用 Skill 组件', 'skills')
    return []
  }
  if (!rootEntries.includes('skills')) return []
  const location = await inspectContainedPath(root, 'skills', 'directory')
  if (location.status !== 'ok') {
    warn('AGENT_PLUGIN_SKILLS_PATH_INVALID', 'Agent Plugins skills/ 必须是插件真实根目录内的目录，已禁用 Skill 组件', 'skills')
    return []
  }
  let children: string[]
  try { children = (await readdir(location.path)).sort() } catch {
    warn('AGENT_PLUGIN_SKILLS_PATH_INVALID', 'Agent Plugins skills/ 无法读取，已禁用 Skill 组件', 'skills')
    return []
  }
  const skills: CompatSkill[] = []
  for (const child of children) {
    const folder = `skills/${child}`
    const directory = await inspectContainedPath(root, folder, 'directory')
    if (directory.status !== 'ok') {
      // 普通文件不是 skill 候选；逃逸、坏链接或其他访问失败单独报告。
      if (directory.status === 'invalid' && directory.reason !== 'kind') warn('AGENT_PLUGIN_SKILL_PATH_INVALID', 'Skill 目录不可访问或真实路径逃逸，已跳过', folder)
      continue
    }
    let entries: string[]
    try { entries = await readdir(directory.path) } catch {
      warn('AGENT_PLUGIN_SKILL_PATH_INVALID', 'Skill 目录无法读取，已跳过', folder)
      continue
    }
    if (!entries.includes('SKILL.md')) continue
    const file = `${folder}/SKILL.md`
    const content = await inspectContainedPath(root, file, 'file')
    if (content.status !== 'ok') {
      warn('AGENT_PLUGIN_SKILL_PATH_INVALID', 'SKILL.md 必须是插件真实根目录内的普通文件，已跳过', file)
      continue
    }
    let attributes: Record<string, unknown>
    try { attributes = parseFrontmatter(await readFile(content.path, 'utf8')).attributes } catch {
      warn('AGENT_PLUGIN_SKILL_FRONTMATTER_INVALID', 'Skill frontmatter 无法使用当前支持的 YAML 子集解析，已跳过', file)
      continue
    }
    const { name, description } = attributes
    if (typeof name !== 'string' || !validName(name) || name !== child) {
      warn('AGENT_PLUGIN_SKILL_NAME_INVALID', 'Agent Skills name 必须满足 1–64 字符命名规则且与所在目录名一致，已跳过', file, 'name')
      continue
    }
    if (typeof description !== 'string' || description.trim() === '' || characterLength(description) > 1024) {
      warn('AGENT_PLUGIN_SKILL_DESCRIPTION_INVALID', 'Agent Skills description 必须是非空且不超过 1024 字符的字符串，已跳过', file, 'description')
      continue
    }
    const invalidString = ['license', 'compatibility', 'allowed-tools'].find(field => attributes[field] !== undefined && typeof attributes[field] !== 'string')
    const compatibility = attributes.compatibility
    const metadata = asObject(attributes.metadata)
    if (invalidString !== undefined
      || (typeof compatibility === 'string' && (compatibility.trim() === '' || characterLength(compatibility) > 500))
      || (attributes.metadata !== undefined && (metadata === undefined || Object.values(metadata).some(value => typeof value !== 'string')))) {
      warn('AGENT_PLUGIN_SKILL_FIELD_INVALID', 'Agent Skills 已知字段类型或长度无效；metadata 必须是 string 到 string 的映射，已跳过', file)
      continue
    }
    if (!DSH_SKILL_NAME.test(name)) {
      warn('SKILL_NAME_DSH_UNSUPPORTED', 'Agent Skills 名称合法，但 DSH 仅支持 ASCII kebab-case Skill 名称，已跳过且不会自动改名', file, 'name')
      continue
    }
    if (attributes['allowed-tools'] !== undefined) {
      warn('AGENT_PLUGIN_SKILL_BEHAVIOR_UNSUPPORTED', 'DSH 尚未实现 Agent Skills allowed-tools 预授权语义，已跳过该 Skill', file, 'allowed-tools')
      continue
    }
    // Agent Skills 未识别字段不具备 CC/Codex 语义，也不复制到扫描结果。
    for (const field of Object.keys(attributes)) {
      if (!KNOWN_FIELDS.has(field)) warn('AGENT_PLUGIN_SKILL_UNKNOWN_FIELD', `Agent Skills 未识别字段已忽略：${field}`, file, field)
    }
    const preserved = Object.fromEntries(['license', 'compatibility', 'metadata']
      .filter(field => attributes[field] !== undefined).map(field => [field, attributes[field]]))
    skills.push({
      name,
      description,
      contentPath: file,
      rootPath: folder,
      invocation: { modelInvocable: true, userInvocable: true },
      sourceFormat: 'agent-plugins',
      ...(Object.keys(preserved).length === 0 ? {} : { metadata: preserved }),
    })
    collector.add('info', 'SKILL_DISCOVERED', 'skill', `发现 Agent Plugins Skill：${name}`, file)
  }
  return skills
}
