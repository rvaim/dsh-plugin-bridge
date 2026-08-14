import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { extractArchive } from '../../src/source/archive.js'
import { copyPluginDirectory } from '../../src/source/directory.js'
import { resolveInstallSource } from '../../src/source/resolver.js'
import { createStoredZip, createTar } from '../helpers/archive-builder.js'
import { temporaryDirectory } from '../helpers/temp.js'

test('安全解压普通 ZIP', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'plugin.zip')
    const output = resolve(temp.path, 'out')
    await createStoredZip(archive, [
      { name: 'plugin/.claude-plugin/plugin.json', data: '{"name":"zip-plugin"}' },
      { name: 'plugin/skills/a/SKILL.md', data: '---\nname: a\ndescription: A\n---\n正文' },
    ])
    await extractArchive(archive, output)
    assert.equal(await readFile(resolve(output, 'plugin/.claude-plugin/plugin.json'), 'utf8'), '{"name":"zip-plugin"}')
  } finally {
    await temp.cleanup()
  }
})


test('ZIP 内容被篡改时 CRC 校验失败', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'corrupt.zip')
    const name = 'file.txt'
    await createStoredZip(archive, [{ name, data: 'original' }])
    const buffer = Buffer.from(await readFile(archive))
    buffer[30 + Buffer.byteLength(name)] ^= 0xff
    await writeFile(archive, buffer)
    await assert.rejects(extractArchive(archive, resolve(temp.path, 'out')), /CRC 校验失败/)
  } finally {
    await temp.cleanup()
  }
})

test('ZIP 路径穿越被拒绝且不会写到目标外', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'evil.zip')
    const output = resolve(temp.path, 'out')
    await createStoredZip(archive, [{ name: '../escaped.txt', data: 'owned' }])
    await assert.rejects(extractArchive(archive, output), /逃逸/)
    await assert.rejects(readFile(resolve(temp.path, 'escaped.txt')), /ENOENT/)
  } finally {
    await temp.cleanup()
  }
})

test('ZIP 恶意符号链接被拒绝', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'evil-symlink.zip')
    await createStoredZip(archive, [
      { name: 'plugin/link', data: '../../outside', mode: 0o120777 },
    ])
    await assert.rejects(extractArchive(archive, resolve(temp.path, 'out')), /符号链接逃逸/)
  } finally {
    await temp.cleanup()
  }
})

test('TAR 恶意符号链接被拒绝', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'evil.tar')
    await createTar(archive, [
      { name: 'plugin/', type: '5' },
      { name: 'plugin/link', type: '2', linkname: '../../outside' },
    ])
    await assert.rejects(extractArchive(archive, resolve(temp.path, 'out')), /符号链接逃逸/)
  } finally {
    await temp.cleanup()
  }
})

test('解压预算限制阻止超大成员', async () => {
  const temp = await temporaryDirectory()
  try {
    const archive = resolve(temp.path, 'large.zip')
    await createStoredZip(archive, [{ name: 'large.txt', data: '1234567890' }])
    await assert.rejects(
      extractArchive(archive, resolve(temp.path, 'out'), { maxFileBytes: 5 }),
      /成员过大/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('本地目录复制拒绝指向目录外的符号链接', async () => {
  const temp = await temporaryDirectory()
  try {
    const source = resolve(temp.path, 'source')
    const outside = resolve(temp.path, 'outside.txt')
    await mkdir(source)
    await writeFile(outside, 'secret')
    await symlink('../outside.txt', resolve(source, 'link'))
    await assert.rejects(copyPluginDirectory(source, resolve(temp.path, 'dest')), /逃逸/)
  } finally {
    await temp.cleanup()
  }
})

test('安装来源解析覆盖 GitHub 简写、本地目录和归档', async () => {
  const temp = await temporaryDirectory()
  try {
    const directory = resolve(temp.path, 'plugin')
    const archive = resolve(temp.path, 'plugin.zip')
    await mkdir(directory)
    await writeFile(archive, 'not parsed at resolver stage')
    const github = await resolveInstallSource('github:owner/repo#v1.2.0')
    assert.deepEqual(github.source, { type: 'git', url: 'https://github.com/owner/repo.git', ref: 'v1.2.0' })
    assert.equal((await resolveInstallSource(directory)).source.type, 'directory')
    assert.equal((await resolveInstallSource(archive)).source.type, 'archive')
  } finally {
    await temp.cleanup()
  }
})
