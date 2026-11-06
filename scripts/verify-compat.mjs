#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtimeVersion = getDshRuntimeVersion()

const issue = evaluatePluginCompatibility(pkg, {}, runtimeVersion)
assert.equal(
  issue,
  undefined,
  `manifest 会被 DSH ${runtimeVersion} 跳过：${JSON.stringify(issue?.requirements)}`,
)
assert.match(
  pkg.engines?.dsh ?? '',
  /^(\^|~|>=)/,
  'engines.dsh 必须是 semver 范围，不能是精确版本',
)
for (const version of new Set([runtimeVersion, '0.2.3-rc.1'])) {
  assert.equal(
    evaluatePluginCompatibility(pkg, {}, version),
    undefined,
    `manifest 必须接纳受支持的 DSH ${version}`,
  )
}
assert.notEqual(
  evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.5'),
  undefined,
  'manifest 不得接纳缺少 ProjectionHandle 契约的 DSH 0.2.1',
)
assert.notEqual(
  evaluatePluginCompatibility(pkg, {}, '0.3.0-rc.1'),
  undefined,
  'manifest 不得接纳未经实测的 DSH 0.3.x',
)

for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(pkg[section] ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, runtimeVersion, `${section}.${name} 必须对齐运行时版本线`)
    const installed = require(`${name}/package.json`)
    assert.equal(installed.version, runtimeVersion, `磁盘上的 ${name} 必须对齐运行时版本线`)
  }
}
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  assert.equal(range, pkg.engines.dsh, `peerDependencies.${name} 必须使用有界兼容范围`)
}

const gateway = require('@deepseek-ai/dsh-api-gateway/package.json')
assert.equal(gateway.version, runtimeVersion, '@deepseek-ai/dsh-api-gateway 版本必须与运行时版本线一致')
assert.ok(
  semver.satisfies(
    pkg.devDependencies?.['@deepseek-ai/cordis'],
    gateway.peerDependencies['@deepseek-ai/cordis'],
  ),
  '@deepseek-ai/cordis 必须满足 gateway 声明的 peer 范围',
)

console.log(`PASS compatibility gate: DSH ${runtimeVersion}, engines.dsh ${pkg.engines.dsh}`)
console.log('PASS compatibility matrix: current / 0.2.3-rc.1 admitted; 0.2.1-rc.5 / 0.3.0-rc.1 blocked')
