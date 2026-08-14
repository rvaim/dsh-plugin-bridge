import assert from 'node:assert/strict'
import test from 'node:test'
import { composeHookCommand, quoteShellToken } from '../../src/runtime/shell-command.js'

test('POSIX Hook 参数逐 Token 引用并阻止引号逃逸', () => {
  assert.equal(quoteShellToken("a'b", 'darwin'), `'a'"'"'b'`)
  assert.equal(
    composeHookCommand('node', ['/tmp/a b.js', '--value', "x'; touch /tmp/pwned"], 'linux'),
    `'node' '/tmp/a b.js' '--value' 'x'"'"'; touch /tmp/pwned'`,
  )
})

test('PowerShell Hook 参数使用单引号双写，完整命令保持原始 Shell 语义', () => {
  assert.equal(quoteShellToken("a'b", 'win32'), `'a''b'`)
  assert.equal(composeHookCommand('echo ok | more', undefined, 'win32'), 'echo ok | more')
})
