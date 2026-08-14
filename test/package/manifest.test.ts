import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('发布清单是可安装 DSH bundle，且运行包不夹带测试目录', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as any
  assert.equal(packageJson.name, 'dsh-compat')
  assert.equal(packageJson.version, '0.2.2')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.bin['dsh-compat'], './dist/src/cli/index.js')
  assert(packageJson.files.includes('dist/src/'))
  assert.equal(packageJson.files.includes('dist/'), false)
  assert.equal(packageJson.peerDependenciesMeta?.['@deepseek-ai/schemastery'], undefined)
  assert.equal(packageJson.dependencies?.['@deepseek-ai/dsh-hook-protocol'], '0.0.1-rc.5')
  assert.equal(packageJson.peerDependencies?.['@deepseek-ai/dsh-hook-protocol'], undefined)
  assert.equal(packageJson.peerDependenciesMeta?.['@deepseek-ai/dsh-hook-protocol'], undefined)

  const patch = await readFile(resolve('cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*dsh-compat/)
  assert.match(patch, /name:\s*dsh-compat/)
  for (const file of [
    'README.md',
    'CHANGELOG.md',
    'docs/ARCHITECTURE.md',
    'docs/COMPATIBILITY.md',
    'docs/SECURITY.md',
    'docs/TESTING.md',
    'docs/USAGE.md',
  ]) {
    await access(resolve(file))
  }
})
