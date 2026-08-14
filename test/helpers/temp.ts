import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function temporaryDirectory(prefix = 'dsh-compat-test-'): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export async function copyFixture(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, dereference: false })
}
