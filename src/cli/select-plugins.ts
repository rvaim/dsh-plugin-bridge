import { stdin, stdout } from 'node:process'
import type { Readable, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import {
  isCI,
  multiselect,
  type MultiSelectOptions,
  type Option,
} from '@clack/prompts'
import type { CompatSourcePlugin } from '../types/source.js'

interface TtyReadable extends Readable {
  isTTY?: boolean
}

interface TtyWritable extends Writable {
  isTTY?: boolean
}

type PluginMultiSelect = (
  options: MultiSelectOptions<string>,
) => Promise<string[] | symbol>

interface PluginSelectionDependencies {
  input?: Readable
  output?: Writable
  prompt?: PluginMultiSelect
  ci?: boolean
}

export class PromptCancelledError extends Error {
  constructor() {
    super('已取消交互操作。')
    this.name = 'PromptCancelledError'
  }
}

function singleLine(value: string): string {
  return stripVTControlCharacters(value).replace(/[\r\n]+/g, ' ').trim()
}

function pluginOption(plugin: CompatSourcePlugin): Option<string> {
  const label = plugin.displayName === undefined || plugin.displayName === plugin.id
    ? plugin.id
    : `${plugin.id} (${singleLine(plugin.displayName)})`
  const hint = [
    plugin.formats.join('/'),
    plugin.installable ? undefined : '不可安装',
    plugin.description === undefined ? undefined : singleLine(plugin.description),
  ].filter((value): value is string => value !== undefined && value !== '').join(' · ')
  return {
    value: plugin.id,
    label,
    ...(hint === '' ? {} : { hint }),
    ...(!plugin.installable ? { disabled: true } : {}),
  }
}

export function isInteractiveTerminal(
  input: Readable = stdin,
  output: Writable = stdout,
  ci = isCI(),
): boolean {
  return !ci && (input as TtyReadable).isTTY === true && (output as TtyWritable).isTTY === true
}

/** 在交互终端中选择 Source Plugin；无 TTY 时返回空数组，由 manager 给出 --plugin 提示。 */
export async function selectPluginsInteractively(
  plugins: readonly CompatSourcePlugin[],
  dependencies: PluginSelectionDependencies = {},
): Promise<string[]> {
  const input = dependencies.input ?? stdin
  const output = dependencies.output ?? stdout
  if (
    !isInteractiveTerminal(input, output, dependencies.ci ?? isCI())
    || !plugins.some(plugin => plugin.installable)
  ) return []

  const prompt: PluginMultiSelect = dependencies.prompt ?? multiselect
  const result = await prompt({
    message: '选择要安装的 Plugin（↑/↓ 移动，Space 选中/反选，Enter 确认）',
    options: plugins.map(pluginOption),
    input,
    output,
    maxItems: Math.min(10, plugins.length),
    required: true,
    showInstructions: false,
  })
  if (typeof result === 'symbol') throw new PromptCancelledError()
  return result
}
