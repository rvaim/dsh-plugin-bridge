import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { CompatManager } from '../../src/manager/manager.js'
import { runProcess } from '../../src/source/process.js'
import { CompatLayout } from '../../src/store/layout.js'
import { createStoredZip } from '../helpers/archive-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('从带单层包装目录的 ZIP 安装并记录 SHA-256', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'zip-plugin.zip')
    await createStoredZip(archive, [
      { name: 'zip-plugin/.claude-plugin/plugin.json', data: '{"name":"zip-plugin","version":"1.0.0"}' },
      { name: 'zip-plugin/skills/demo/SKILL.md', data: '---\nname: demo\ndescription: Demo\n---\n正文' },
    ])
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    const result = await manager.install(archive, { enable: false })
    assert.equal(result.plugin.id, 'zip-plugin')
    assert.equal(result.source.source.origin.type, 'archive')
    assert.match(
      result.source.source.origin.type === 'archive' ? result.source.source.origin.sha256 ?? '' : '',
      /^[a-f0-9]{64}$/,
    )
    assert.equal(result.install.sourceId, result.source.source.id)
    assert.match(
      await readFile(resolve(layout.sourcePackageDir(result.install.sourceId), '.claude-plugin/plugin.json'), 'utf8'),
      /zip-plugin/,
    )
    await assert.rejects(
      readFile(resolve(layout.sourcePackageDir(result.install.sourceId), 'zip-plugin/.claude-plugin/plugin.json')),
      /ENOENT/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('从本地 Git 仓库安装并把实际 commit 写入 install.json', async () => {
  const temp = await temporaryDirectory()
  try {
    const repo = resolve(temp.path, 'repo')
    await mkdir(resolve(repo, '.claude-plugin'), { recursive: true })
    await writeFile(resolve(repo, '.claude-plugin/plugin.json'), '{"name":"git-install"}')
    await runProcess('git', ['init', repo])
    await runProcess('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await runProcess('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await runProcess('git', ['-C', repo, 'add', '.'])
    await runProcess('git', ['-C', repo, 'commit', '-m', 'initial'])
    const commit = (await runProcess('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
    const layout = new CompatLayout(resolve(temp.path, 'home'))
    const manager = new CompatManager(layout)
    const result = await manager.install(`file://${repo}`, { enable: false })
    assert.equal(result.source.source.origin.type, 'git')
    assert.equal(result.source.source.origin.type === 'git' ? result.source.source.origin.commit : undefined, commit)
    assert.equal(result.install.sourceId, result.source.source.id)
    await assert.rejects(readFile(resolve(layout.sourcePackageDir(result.install.sourceId), '.git/HEAD')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})
