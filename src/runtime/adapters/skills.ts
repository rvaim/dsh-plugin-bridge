import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CompatSkill } from '../../types/skill.js'
import { parseFrontmatter } from '../../shared/frontmatter.js'
import type { DshContextLike } from '../context.js'

const COMPAT_SKILL_RANK = 600

/** 将统一 CompatSkill 注册为一个按需读取正文的 DSH Skill Provider。 */
export function registerSkillProvider(
  ctx: DshContextLike,
  plugin: CompatPlugin,
  packageRoot: string,
): (() => void) | undefined {
  if (plugin.skills.length === 0) return undefined
  const blocked = plugin.skills.find(skill => (skill.runtimeUnsupported?.length ?? 0) > 0)
  if (blocked !== undefined) throw new Error(`Skill ${blocked.name} 的运行语义尚未适配：${blocked.runtimeUnsupported!.join(', ')}`)
  const registry = ctx.skills
  if (registry === undefined) throw new Error('DSH 未提供 ctx.skills，无法注册 Skill')
  const providerName = `plugin-bridge:${plugin.id}`
  const byName = new Map(plugin.skills.map(skill => [skill.name, skill]))
  const describe = (skill: CompatSkill): Omit<SkillCandidate, 'rank' | 'locator'> & { path: string } => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    source: 'plugin-bridge',
    provider: providerName,
    resourceBase: { kind: 'directory', path: join(packageRoot, skill.rootPath) },
    path: join(packageRoot, skill.contentPath),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
  })

  return registry.registerProvider(control => ({
    name: providerName,
    async list(options = {}) {
      if (options.signal?.aborted === true || control.signal.aborted) throw options.signal?.reason ?? control.signal.reason
      return plugin.skills.map(skill => ({
        ...describe(skill),
        rank: COMPAT_SKILL_RANK,
        locator: skill.name,
      }))
    },
    async get(candidate, options = {}) {
      if (options.signal?.aborted === true || control.signal.aborted) throw options.signal?.reason ?? control.signal.reason
      const name = String(candidate.locator)
      const skill = byName.get(name)
      if (skill === undefined) return undefined
      const descriptor = describe(skill)
      const parsed = parseFrontmatter(await readFile(descriptor.path, 'utf8'))
      return {
        ...descriptor,
        content: parsed.body,
      }
    },
  }))
}
