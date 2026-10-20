import assert from 'node:assert/strict'
import test from 'node:test'
import { CompatLayout } from '../../src/store/layout.js'

test('Source 与外部 Plugin 的存储 ID 不能逃逸插件桥根目录', () => {
  const layout = new CompatLayout('/tmp/plugin-bridge-layout-test')
  assert.equal(layout.root, '/tmp/plugin-bridge-layout-test/dsh-compat')
  assert.throws(() => layout.sourceExternalRoot('../escape'), /Source ID 不是安全的存储标识/)
  assert.throws(() => layout.sourceExternalPluginRoot('safe-source', '../escape'), /Plugin ID 不是安全的存储标识/)
})
