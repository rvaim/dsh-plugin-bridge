import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('adapter 不读取 Claude/Codex 原始配置文件', async () => {
  for (const file of [
    'src/adapters/skills/provider.ts',
    'src/adapters/mcp/client.ts',
    'src/adapters/hooks/register.ts',
  ]) {
    const source = await readFile(resolve(file), 'utf8')
    assert.equal(source.includes('.mcp.json'), false, file)
    assert.equal(source.includes('hooks/hooks.json'), false, file)
    assert.equal(source.includes('.claude-plugin'), false, file)
    assert.equal(source.includes('.codex-plugin'), false, file)
  }
})
