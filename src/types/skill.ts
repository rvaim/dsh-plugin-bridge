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
  sourceFormat: 'claude-code' | 'codex'
  metadata?: Record<string, unknown>
}
