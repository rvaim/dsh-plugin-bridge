/** 生成可用于目录名和锁名的管理标识，不改变插件内部能力名称。 */
export function normalizeManagementId(raw: string, kind: 'plugin' | 'source' = 'plugin'): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80)
  if (normalized === '') throw new Error(`无法从 ${JSON.stringify(raw)} 生成安全 ${kind}Id`)
  return normalized
}
