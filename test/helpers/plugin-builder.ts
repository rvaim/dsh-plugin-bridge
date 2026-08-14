import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface PluginBuildOptions {
  name: string
  version?: string
  skillName?: string
  mcpName?: string
  mcpCommand?: string
  hookEvent?: string
  hookCommand?: string
  unsupportedHook?: boolean
  marker?: string
}

export async function buildClaudePlugin(root: string, options: PluginBuildOptions): Promise<void> {
  await mkdir(resolve(root, '.claude-plugin'), { recursive: true })
  await writeFile(resolve(root, '.claude-plugin/plugin.json'), JSON.stringify({
    name: options.name,
    ...(options.version === undefined ? {} : { version: options.version }),
  }, null, 2))
  if (options.marker !== undefined) await writeFile(resolve(root, 'marker.txt'), options.marker)
  if (options.skillName !== undefined) {
    await mkdir(resolve(root, 'skills', options.skillName), { recursive: true })
    await writeFile(resolve(root, 'skills', options.skillName, 'SKILL.md'), `---\nname: ${options.skillName}\ndescription: ${options.skillName} 描述\n---\n${options.marker ?? '正文'}\n`)
  }
  if (options.mcpName !== undefined) {
    await writeFile(resolve(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        [options.mcpName]: {
          command: options.mcpCommand ?? 'fake-mcp',
          args: [],
        },
      },
    }, null, 2))
  }
  if (options.hookEvent !== undefined || options.unsupportedHook === true) {
    await mkdir(resolve(root, 'hooks'), { recursive: true })
    await writeFile(resolve(root, 'hooks/hooks.json'), JSON.stringify({
      hooks: {
        [options.unsupportedHook ? 'Notification' : options.hookEvent ?? 'PreToolUse']: [
          { hooks: [{ type: 'command', command: options.hookCommand ?? 'allow:ok' }] },
        ],
      },
    }, null, 2))
  }
}
