import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { cloneGitPlugin } from '../../src/source/git.js'
import { resolveInstallSource, validatePersistableGitUrl } from '../../src/source/resolver.js'
import { runProcess } from '../../src/source/process.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('Git 来源记录实际 commit 且不保留 .git', async () => {
  const temp = await temporaryDirectory()
  try {
    const repo = resolve(temp.path, 'repo')
    const destination = resolve(temp.path, 'clone')
    await mkdir(repo)
    await runProcess('git', ['init', repo])
    await runProcess('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await mkdir(resolve(repo, '.claude-plugin'))
    await writeFile(resolve(repo, '.claude-plugin/plugin.json'), '{"name":"git-plugin"}')
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'initial'])
    const expected = (await runProcess('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    const result = await cloneGitPlugin(repo, destination)
    assert.equal(result.source.commit, expected)
    assert.equal(await readFile(resolve(destination, '.claude-plugin/plugin.json'), 'utf8'), '{"name":"git-plugin"}')
    await assert.rejects(readFile(resolve(destination, '.git/HEAD')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})


test('Git 获取不创建 checkout，因此不会触发 smudge 过滤器', async () => {
  const temp = await temporaryDirectory()
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM
  try {
    const repo = resolve(temp.path, 'filter-repo')
    const destination = resolve(temp.path, 'filter-clone')
    const marker = resolve(temp.path, 'smudge-ran')
    const globalConfig = resolve(temp.path, 'gitconfig')
    await mkdir(repo)
    await runProcess('git', ['init', repo])
    await runProcess('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await writeFile(resolve(repo, '.gitattributes'), '*.txt filter=compat-evil\n')
    await writeFile(resolve(repo, 'payload.txt'), '原始内容\n')
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'filter'])
    const filterScript = resolve(temp.path, 'smudge.sh')
    await writeFile(filterScript, `#!/bin/sh\necho executed > \"${marker}\"\ncat\n`, { mode: 0o700 })
    await writeFile(globalConfig, `[filter "compat-evil"]\n\trequired = true\n\tsmudge = ${filterScript.replaceAll('\\', '/')}\n`)
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_NOSYSTEM = '1'

    await cloneGitPlugin(repo, destination)
    assert.equal(await readFile(resolve(destination, 'payload.txt'), 'utf8'), '原始内容\n')
    await assert.rejects(access(marker), /ENOENT/)
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
    await temp.cleanup()
  }
})

test('Git URL 拒绝内嵌凭据和查询参数，避免写入安装元数据', async () => {
  await assert.rejects(
    resolveInstallSource('https://token@example.com/owner/repo.git'),
    /不得内嵌用户名、密码或 Token/,
  )
  await assert.rejects(
    resolveInstallSource('https://example.com/owner/repo.git?access_token=secret'),
    /不得包含查询参数/,
  )
  const ssh = await resolveInstallSource('ssh://git@example.com/owner/repo.git')
  assert.equal(ssh.source.type, 'git')
})

test('Git URL 只允许明确支持的协议，并拒绝把 fragment 混入持久化 URL', async () => {
  assert.throws(() => validatePersistableGitUrl('ftp://example.com/owner/repo.git'), /不支持的 Git URL 协议/)
  assert.throws(() => validatePersistableGitUrl('https://example.com/owner/repo.git#main'), /不得包含 fragment/)
  await assert.rejects(resolveInstallSource('ftp://example.com/owner/repo.git'), /不支持的 Git URL 协议/)
})

test('Git ref 支持分支、标签和提交 SHA，并记录最终提交', async () => {
  const temp = await temporaryDirectory()
  try {
    const repo = resolve(temp.path, 'ref-repo')
    await mkdir(repo)
    await runProcess('git', ['init', repo])
    await runProcess('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await mkdir(resolve(repo, '.claude-plugin'))
    await writeFile(resolve(repo, '.claude-plugin/plugin.json'), '{"name":"first"}')
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'first'])
    const firstCommit = (await runProcess('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    await runProcess('git', ['-C', repo, 'tag', 'v1.0.0', firstCommit])
    await runProcess('git', ['-C', repo, 'branch', 'legacy', firstCommit])

    await writeFile(resolve(repo, '.claude-plugin/plugin.json'), '{"name":"second"}')
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'second'])

    for (const [label, ref] of [
      ['branch', 'legacy'],
      ['tag', 'v1.0.0'],
      ['commit', firstCommit],
    ] as const) {
      const destination = resolve(temp.path, `clone-${label}`)
      const result = await cloneGitPlugin(repo, destination, ref)
      assert.equal(result.source.ref, ref)
      assert.equal(result.source.commit, firstCommit)
      assert.equal(await readFile(resolve(destination, '.claude-plugin/plugin.json'), 'utf8'), '{"name":"first"}')
    }
  } finally {
    await temp.cleanup()
  }
})

test('Git 导出使用批量对象读取，并支持取消且清理目标', { timeout: 30_000 }, async () => {
  const temp = await temporaryDirectory()
  try {
    const repo = resolve(temp.path, 'batch-repo')
    const destination = resolve(temp.path, 'batch-clone')
    await mkdir(repo)
    await runProcess('git', ['init', repo])
    await runProcess('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', repo, 'config', 'user.name', 'Test'])
    for (let index = 0; index < 250; index += 1) {
      const directory = resolve(repo, 'nested', `part-${index % 10}`)
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, `file-${index}.txt`), `content-${index}`)
    }
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'many files'])

    await cloneGitPlugin(repo, destination)
    assert.equal(await readFile(resolve(destination, 'nested/part-9/file-249.txt'), 'utf8'), 'content-249')

    const cancelled = resolve(temp.path, 'cancelled-clone')
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(new Error('cancelled by test')), 1)
    try {
      await assert.rejects(cloneGitPlugin(repo, cancelled, undefined, controller.signal), /cancelled by test|aborted/i)
    } finally {
      clearTimeout(abort)
    }
    await assert.rejects(access(cancelled), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('Git ref 拒绝选项注入、rev 表达式和空值', async () => {
  for (const source of [
    'github:owner/repo#--upload-pack=evil',
    'github:owner/repo#main^{commit}',
    'github:owner/repo#',
    'https://example.com/owner/repo.git#refs/heads/../secret',
  ]) {
    await assert.rejects(resolveInstallSource(source), /Git ref/)
  }
  const valid = await resolveInstallSource('github:owner/repo#refs/tags/v1.2.0')
  assert.equal(valid.source.type, 'git')
  assert.equal(valid.source.ref, 'refs/tags/v1.2.0')
})
