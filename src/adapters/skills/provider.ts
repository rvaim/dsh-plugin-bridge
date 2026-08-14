import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompatPlugin } from '../../types/plugin.js'
import type { CompatSkill } from '../../types/skill.js'
import { parseFrontmatter } from '../../parser/shared/frontmatter.js'
import type { DshContextLike, SkillRegistryLike } from '../../runtime/context.js'

const COMPAT_SKILL_RANK = 600

/** 将统一 CompatSkill 注册为一个按需读取正文的 DSH Skill Provider。 */
export function registerSkillProvider(
  ctx: DshContextLike,
  plugin: CompatPlugin,
  packageRoot: string,
): (() => void) | undefined {
  if (plugin.skills.length === 0) return undefined
  const registry = (ctx.skills ?? ctx.get?.('skills')) as SkillRegistryLike | undefined
  if (registry === undefined) throw new Error('DSH 未提供 ctx.skills，无法注册 Skill')
  const providerName = `dsh-compat:${plugin.id}`
  const byName = new Map(plugin.skills.map(skill => [skill.name, skill]))
  const describe = (skill: CompatSkill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    source: 'dsh-compat',
    provider: providerName,
    resourceBase: { kind: 'directory', path: join(packageRoot, skill.rootPath) },
    path: join(packageRoot, skill.contentPath),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
  })

  return registry.registerProvider((control: { signal: AbortSignal; invalidate(): void }) => ({
    name: providerName,
    async list(options: { cwd?: string; signal?: AbortSignal } = {}) {
      if (options.signal?.aborted === true || control.signal.aborted) throw options.signal?.reason ?? control.signal.reason
      return plugin.skills.map(skill => ({
        ...describe(skill),
        rank: COMPAT_SKILL_RANK,
        locator: skill.name,
      }))
    },
    async get(candidate: unknown, options: { cwd?: string; signal?: AbortSignal } = {}) {
      if (options.signal?.aborted === true || control.signal.aborted) throw options.signal?.reason ?? control.signal.reason
      const name = typeof candidate === 'object' && candidate !== null && 'locator' in candidate
        ? String((candidate as { locator: unknown }).locator)
        : ''
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
