/** 管理标识仅服务存储身份，不改写协议内部能力名称。 */
export function normalizeManagementId(raw: string, kind: 'plugin' | 'source' = 'plugin'): string {
  const normalized = raw.trim().toLowerCase().replace(/^@/, '').replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9_.-]+/g, '-').replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '').slice(0, 80)
  if (normalized === '') throw new Error(`无法从 ${JSON.stringify(raw)} 生成安全 ${kind}Id`)
  return normalized
}
