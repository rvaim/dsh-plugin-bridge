import { basename, extname, resolve } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'
import type { ResolvedInstallSource } from '../types/source.js'

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, '')
}


export function validatePersistableGitUrl(value: string, input = value): void {
  if (/^git@[^:]+:.+/.test(value)) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`无效 Git URL：${input}`)
  }
  const allowedProtocols = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:'])
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(`不支持的 Git URL 协议：${parsed.protocol}`)
  }
  const httpLike = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'git:'
  if (parsed.password !== '' || (httpLike && parsed.username !== '')) {
    throw new Error('Git URL 不得内嵌用户名、密码或 Token；请使用 SSH、凭据助手或目标环境的认证配置')
  }
  if (parsed.search !== '') {
    throw new Error('Git URL 不得包含查询参数，以免敏感参数写入 install.json')
  }
  if (parsed.hash !== '') {
    throw new Error('Git URL 本体不得包含 fragment；请通过独立 Git ref 字段指定分支、标签或提交')
  }
}

/**
 * 校验可安全传给 Git 的 ref。
 *
 * 这里有意采用 Git ref 名称的安全子集：支持常见分支、标签、完整 refs/*
 * 和提交 SHA，同时拒绝选项注入、rev 语法和歧义控制字符。
 */
export function validateGitRef(ref: string, input = ref): string {
  if (ref.length === 0) throw new Error(`Git ref 不能为空：${input}`)
  if (ref.length > 256) throw new Error(`Git ref 过长：${input}`)
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/@+\-]*$/.test(ref)) {
    throw new Error(`Git ref 包含不安全字符：${input}`)
  }
  if (
    ref === '@'
    || ref.includes('..')
    || ref.includes('//')
    || ref.includes('@{')
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error(`Git ref 格式无效：${input}`)
  }
  return ref
}

function splitRef(value: string): { value: string; ref?: string } {
  const hash = value.lastIndexOf('#')
  if (hash <= value.indexOf('://') + 2) return { value }
  const ref = value.slice(hash + 1)
  return { value: value.slice(0, hash), ref: validateGitRef(ref, value) }
}

/** 解析 github:、Git URL、本地目录和归档来源，不访问网络。 */
export async function resolveInstallSource(input: string, cwd = process.cwd()): Promise<ResolvedInstallSource> {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('安装来源不能为空')
  if (trimmed.startsWith('github:')) {
    const split = splitRef(trimmed.slice('github:'.length))
    if (!/^[^/\s]+\/[^/\s]+$/.test(split.value)) throw new Error(`无效 GitHub 简写：${input}`)
    const repo = stripGitSuffix(split.value)
    return {
      source: { type: 'git', url: `https://github.com/${repo}.git`, ...(split.ref === undefined ? {} : { ref: split.ref }) },
      display: input,
      suggestedId: repo.split('/').at(-1),
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) || /^git@[^:]+:.+/.test(trimmed)) {
    const split = splitRef(trimmed)
    validatePersistableGitUrl(split.value, input)
    const pathPart = split.value.replace(/[?#].*$/, '').split('/').at(-1) ?? 'plugin'
    return {
      source: { type: 'git', url: split.value, ...(split.ref === undefined ? {} : { ref: split.ref }) },
      display: input,
      suggestedId: stripGitSuffix(pathPart),
    }
  }

  const localPath = resolve(cwd, trimmed)
  let info
  try {
    info = await lstat(localPath)
  } catch {
    throw new Error(`安装来源不存在：${localPath}`)
  }
  if (info.isDirectory()) {
    return { source: { type: 'directory', path: localPath }, display: input, suggestedId: basename(localPath) }
  }
  if (info.isFile()) {
    const lower = localPath.toLowerCase()
    if (!['.zip', '.tgz', '.tar', '.gz'].some(suffix => lower.endsWith(suffix))) {
      throw new Error(`不支持的本地文件类型：${extname(localPath) || '(无扩展名)'}`)
    }
    const name = basename(localPath).replace(/\.(?:tar\.gz|zip|tgz|tar|gz)$/i, '')
    return { source: { type: 'archive', path: localPath }, display: input, suggestedId: name }
  }
  throw new Error(`安装来源不是普通目录或文件：${localPath}`)
}

/** 常见仓库归档会额外包一层目录；仅在顶层只有该目录时去掉这一层。 */
export async function selectExtractedPluginRoot(extractionRoot: string): Promise<string> {
  const entries = await readdir(extractionRoot, { withFileTypes: true })
  return entries.length === 1 && entries[0].isDirectory()
    ? resolve(extractionRoot, entries[0].name)
    : extractionRoot
}
