import assert from 'node:assert/strict'
import test from 'node:test'
import type { CompatWebPlugin, CompatWebUpdateInfo } from '../../src/types/web.js'
import { filterPlugins, needsAttention } from '../../src/web/client/panel-model.js'

const ready: CompatWebPlugin = {
  id: 'alpha', name: 'Workspace Tools', sourceId: 'team-library', version: '1.0', enabled: true,
  priority: 0, runtimeStatus: 'running', formats: ['claude-code'], skills: 1, mcpServers: 0,
  hooks: 0, errors: 0, warnings: 0, diagnostics: [],
}
const plugins = [ready, { ...ready, id: 'beta', name: 'Review Assistant', enabled: false, runtimeStatus: 'disabled' as const },
  { ...ready, id: 'gamma', name: 'Audit', sourceId: 'security', runtimeStatus: 'degraded' as const, warnings: 1 }]
const updates: Record<string, CompatWebUpdateInfo> = {
  alpha: { pluginId: 'alpha', sourceId: 'team-library', available: true, sharedSource: true, affectedPluginIds: ['alpha', 'beta'] },
  beta: { pluginId: 'beta', sourceId: 'team-library', available: false, sharedSource: true, affectedPluginIds: ['alpha', 'beta'] },
}

test('本地检索组合名称、ID、来源与格式，支持多个词且不改写原列表', () => {
  const snapshot = structuredClone(plugins)
  assert.deepEqual(filterPlugins(plugins, ' WORKSPACE  TEAM ', 'all', updates).map(item => item.id), ['alpha'])
  assert.deepEqual(filterPlugins(plugins, 'beta', 'all', updates).map(item => item.id), ['beta'])
  assert.equal(filterPlugins(plugins, 'claude-code', 'all', updates).length, 3)
  assert.deepEqual(plugins, snapshot)
})

test('状态筛选区分启用意愿、运行问题与真实可用更新', () => {
  assert.deepEqual(filterPlugins(plugins, '', 'enabled', updates).map(item => item.id), ['alpha', 'gamma'])
  assert.deepEqual(filterPlugins(plugins, '', 'disabled', updates).map(item => item.id), ['beta'])
  assert.deepEqual(filterPlugins(plugins, '', 'attention', updates).map(item => item.id), ['gamma'])
  assert.deepEqual(filterPlugins(plugins, '', 'updates', updates).map(item => item.id), ['alpha'])
})

test('更新检查错误需要关注，同时不能误报为可更新', () => {
  const error = { ...updates.beta, error: 'Offline' }
  assert.equal(needsAttention(plugins[1], error), true)
  assert.deepEqual(filterPlugins(plugins, '', 'attention', { ...updates, beta: error }).map(item => item.id), ['beta', 'gamma'])
  assert.deepEqual(filterPlugins(plugins, '', 'updates', { beta: error }), [])
})

test('无结果与清除筛选是同一数据集上的可逆投影', () => {
  assert.deepEqual(filterPlugins(plugins, 'missing', 'all', updates), [])
  assert.deepEqual(filterPlugins(plugins, 'audit', 'disabled', updates), [])
  assert.deepEqual(filterPlugins(plugins, '', 'all', updates), plugins)
})
