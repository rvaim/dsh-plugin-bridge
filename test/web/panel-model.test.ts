import assert from 'node:assert/strict'
import test from 'node:test'
import type { CompatWebCategory, CompatWebPlugin, CompatWebUpdateInfo } from '../../src/types/web.js'
import { categoryInventory, filterPlugins, formatLabel, inCategory, needsAttention, uniquePlugins } from '../../src/web/client/panel-model.js'

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

const categories: CompatWebCategory[] = [
  { id: 'future-z', label: { en: 'Future Z' }, order: 20 },
  { id: 'future-a', label: { en: 'Future A', zh: '新分类 A' }, order: 20 },
  { id: 'all', label: { en: 'A parser named all' }, order: 5 },
  { id: 'empty', label: { en: 'Empty parser' }, order: 30 },
]
const mixedInventory: CompatWebPlugin[] = [
  { ...ready, id: 'mixed', formats: ['future-a', 'future-a', 'future-z'] },
  { ...ready, id: 'single', formats: ['future-z'], enabled: false, runtimeStatus: 'disabled' },
  { ...ready, id: 'unavailable', formats: ['removed-parser'] },
  { ...ready, id: 'all-parser', formats: ['all'] },
]

test('分类按 Host order/id 排序，零安装分类保留且完整库存按插件 ID 去重', () => {
  const snapshot = structuredClone(categories)
  const inventory = [...mixedInventory, mixedInventory[0]]
  assert.deepEqual(categoryInventory(categories, inventory).map(({ id, count }) => ({ id, count })), [
    { id: 'all', count: 1 }, { id: 'future-a', count: 1 }, { id: 'future-z', count: 2 }, { id: 'empty', count: 0 },
  ])
  assert.equal(uniquePlugins(inventory).length, 4)
  assert.deepEqual(categories, snapshot)
  assert.equal(filterPlugins(inventory, '', 'all', {}).length, 4)
})

test('分类与搜索、状态取交集，混合插件可进入两个分类而目录计数保持不变', () => {
  const before = categoryInventory(categories, mixedInventory)
  assert.deepEqual(filterPlugins(mixedInventory, '', 'enabled', {}, 'future-z').map(plugin => plugin.id), ['mixed'])
  assert.deepEqual(filterPlugins(mixedInventory, 'workspace', 'disabled', {}, 'future-z').map(plugin => plugin.id), ['single'])
  assert.deepEqual(filterPlugins(mixedInventory, '', 'all', {}, 'future-a').map(plugin => plugin.id), ['mixed'])
  assert.deepEqual(filterPlugins(mixedInventory, 'missing', 'all', {}, 'future-a'), [])
  assert.deepEqual(filterPlugins(mixedInventory, '', 'all', {}, 'empty'), [])
  assert.deepEqual(categoryInventory(categories, mixedInventory), before)
})

test('全部使用 null，与真实 ID 为 all 的解析器独立；移除所有解析器后库存仍可管理', () => {
  assert.equal(inCategory(mixedInventory[0], null), true)
  assert.equal(inCategory(mixedInventory[0], 'all'), false)
  assert.deepEqual(filterPlugins(mixedInventory, '', 'all', {}, 'all').map(plugin => plugin.id), ['all-parser'])
  assert.deepEqual(categoryInventory([], mixedInventory), [])
  assert.deepEqual(filterPlugins(mixedInventory, '', 'all', {}, null), mixedInventory)
})

test('标签来自同一目录并在每次渲染时解析，未知或已移除的格式回退原始 ID', () => {
  let language: 'zh' | 'en' = 'zh'
  const resolveText = (label: CompatWebCategory['label']) => language === 'zh' ? label.zh ?? label.en : label.en
  assert.equal(formatLabel('future-a', categories, resolveText), '新分类 A')
  language = 'en'
  assert.equal(formatLabel('future-a', categories, resolveText), 'Future A')
  assert.equal(formatLabel('future-z', categories, resolveText), 'Future Z')
  assert.equal(formatLabel('future-a', [], resolveText), 'future-a')
  assert.equal(formatLabel('removed-parser', categories, resolveText), 'removed-parser')
})
