import assert from 'node:assert/strict'
import test from 'node:test'
import { uniqueDiagnostics } from '../../src/types/diagnostic.js'

test('完全相同的诊断只保留一次，不同位置或详情仍分别保留', () => {
  const item = { level: 'warning' as const, code: 'X', capability: 'plugin' as const, message: 'same', file: 'plugin.json' }
  assert.deepEqual(uniqueDiagnostics([
    item,
    { ...item },
    { ...item, file: 'other.json' },
    { ...item, details: { entries: ['hooks'] } },
  ]), [item, { ...item, file: 'other.json' }, { ...item, details: { entries: ['hooks'] } }])
})
