import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(new URL('../', import.meta.url))
const target = fileURLToPath(new URL('../dist', import.meta.url))
const actual = await realpath(target).catch(error => {
  if (error.code === 'ENOENT') return target
  throw error
})
if (actual !== join(root, 'dist')) throw new Error('Refusing unexpected build cleanup target')
await rm(actual, { recursive: true, force: true })
