import { mkdir, readFile, writeFile } from 'node:fs/promises'

const sections = ['# Third-party notices', '', 'The browser client bundles code from the following MIT-licensed packages.', '']
for (const name of ['zod', '@deepseek-ai/dsh-typert-protocol']) {
  const manifestUrl = new URL(import.meta.resolve(`${name}/package.json`))
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  if (manifest.license !== 'MIT') throw new Error(`Review the changed license for ${name}`)
  const license = await readFile(new URL('./LICENSE', manifestUrl), 'utf8')
  sections.push(`## ${name} ${manifest.version}`, '', license.trim(), '')
}
const output = new URL('../dist/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('THIRD_PARTY_NOTICES.txt', output), `${sections.join('\n')}\n`)
