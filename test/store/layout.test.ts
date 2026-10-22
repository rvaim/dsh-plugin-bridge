import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { CompatLayout } from '../../src/store/layout.js'

test('Source 与外部 Plugin 的存储 ID 不能逃逸插件桥根目录', () => {
  const layout = new CompatLayout(resolve('plugin-bridge-layout-test'))
  assert.equal(layout.root, resolve('plugin-bridge-layout-test', 'dsh-plugin-bridge'))
  assert.throws(() => layout.sourceExternalRoot('../escape'), /Source ID 不是安全的存储标识/)
  assert.throws(() => layout.sourceExternalPluginRoot('safe-source', '../escape'), /Plugin ID 不是安全的存储标识/)
})
