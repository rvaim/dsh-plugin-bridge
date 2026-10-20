export interface CompatSkillInvocation {
  modelInvocable: boolean
  userInvocable: boolean
}

export interface CompatSkill {
  name: string
  description: string
  whenToUse?: string
  /** 相对于 package/ 的 SKILL.md 路径。 */
  contentPath: string
  /** 相对于 package/ 的技能目录。 */
  rootPath: string
  invocation: CompatSkillInvocation
  sourceFormat: string
  metadata?: Record<string, unknown>
  /** 关键执行语义尚未适配；运行层不得把它当作普通正文注册。 */
  runtimeUnsupported?: string[]
}
