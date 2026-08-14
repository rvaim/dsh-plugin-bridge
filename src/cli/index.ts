#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  CompatManager,
  CompatibilityError,
  PluginSelectionRequiredError,
  SharedSourceUpdateError,
} from '../manager/manager.js'
import type { CompatSourcePlugin } from '../types/source.js'
import { CompatLayout } from '../store/layout.js'
import { flagBoolean, flagString, flagStrings, parseArguments } from './args.js'
import {
  formatInspection,
  formatList,
  formatSourceInspection,
  formatSourceList,
} from './format.js'

const HELP = `dsh-compat：Claude Code / Codex 旧插件兼容管理器

用法：
  dsh-compat source add <source> [--as source-id] [--path path ...]
  dsh-compat source remove <source-id>
  dsh-compat source update <source-id> [--source replacement]
  dsh-compat source list
  dsh-compat source inspect <source-id>

  dsh-compat install <source|source-id|plugin@source-id>
                     [--plugin plugin ...] [--path path ...]
                     [--as plugin-id] [--source-as source-id]
                     [--no-enable] [--priority n]
  dsh-compat update <plugin-id> [--source replacement] [--yes]
  dsh-compat enable <plugin-id>
  dsh-compat disable <plugin-id>
  dsh-compat uninstall <plugin-id>
  dsh-compat list
  dsh-compat inspect <plugin-id>

通用参数：
  --home path    指定 DSH_HOME
  --json         输出 JSON
  --help         显示帮助

说明：
  * Marketplace Source 不会默认安装全部 Plugin。交互终端会要求选择；CI 或无交互
    环境必须重复传入 --plugin。
  * --path 只在 Source 没有 Claude/Codex Marketplace 时作为明确兜底，不递归猜目录。
  * 独立 CLI 采用离线管理模式。对正在运行的 DSH 执行 disable/update/uninstall 前，
    应通过 DSH 内的 dsh-compat 服务操作，或先停止该 DSH 进程。`

function required(value: string | undefined, description: string): string {
  if (value === undefined || value === '') throw new Error(`缺少${description}`)
  return value
}

function parsePriority(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^-?\d+$/.test(value)) throw new Error('--priority 必须是整数')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('--priority 超出安全整数范围')
  return result
}

function print(value: unknown, json: boolean, text: () => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text())
}

async function selectPluginsInteractively(plugins: readonly CompatSourcePlugin[]): Promise<string[]> {
  if (!stdin.isTTY || !stdout.isTTY) return []
  console.log('Source 包含多个 Plugin，请选择一个或多个：')
  for (const [index, plugin] of plugins.entries()) {
    const notes = [
      plugin.formats.join('/'),
      plugin.installable ? undefined : '不可安装',
      plugin.description,
    ].filter((value): value is string => typeof value === 'string' && value !== '')
    console.log(`  ${index + 1}. ${plugin.id}${plugin.displayName ? ` (${plugin.displayName})` : ''}${notes.length > 0 ? ` — ${notes.join('；')}` : ''}`)
  }
  const readline = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await readline.question('输入编号或 Plugin ID，多个值用逗号分隔（空输入取消）：')).trim()
    if (answer === '') return []
    const result: string[] = []
    for (const token of answer.split(',').map(value => value.trim()).filter(Boolean)) {
      if (/^\d+$/.test(token)) {
        const item = plugins[Number(token) - 1]
        if (item === undefined) throw new Error(`选择编号超出范围：${token}`)
        result.push(item.id)
      } else {
        result.push(token)
      }
    }
    return [...new Set(result)]
  } finally {
    readline.close()
  }
}

async function confirmSharedUpdateInteractively(error: SharedSourceUpdateError): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false
  console.log(error.message)
  const readline = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await readline.question('确认整体更新该 Source 及以上全部 Plugin？[y/N] ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    readline.close()
  }
}

async function handleSource(manager: CompatManager, positionals: string[], json: boolean, args: ReturnType<typeof parseArguments>): Promise<void> {
  const action = required(positionals[0], 'Source 子命令')
  switch (action) {
    case 'add': {
      const result = await manager.sourceAdd(required(positionals[1], 'Source 来源'), {
        ...(flagString(args, 'as') === undefined ? {} : { as: flagString(args, 'as') }),
        ...(flagStrings(args, 'path').length === 0 ? {} : { paths: flagStrings(args, 'path') }),
      })
      print(result, json, () => formatSourceInspection(result))
      return
    }
    case 'remove': {
      const sourceId = required(positionals[1], 'Source ID')
      await manager.sourceRemove(sourceId)
      print({ removed: sourceId }, json, () => `已移除 Source ${sourceId}`)
      return
    }
    case 'update': {
      const result = await manager.sourceUpdate(required(positionals[1], 'Source ID'), {
        ...(flagString(args, 'source') === undefined ? {} : { source: flagString(args, 'source') }),
      })
      print(result, json, () => formatSourceInspection(result.source))
      return
    }
    case 'list': {
      const result = await manager.sourceList()
      print(result, json, () => formatSourceList(result))
      return
    }
    case 'inspect': {
      const result = await manager.sourceInspect(required(positionals[1], 'Source ID'))
      print(result, json, () => formatSourceInspection(result))
      return
    }
    default:
      throw new Error(`未知 Source 子命令：${action}`)
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.command === undefined || args.command === 'help' || flagBoolean(args, 'help')) {
    console.log(HELP)
    return
  }

  const layout = new CompatLayout(flagString(args, 'home'))
  const manager = new CompatManager(layout)
  const json = flagBoolean(args, 'json')

  switch (args.command) {
    case 'source':
      await handleSource(manager, args.positionals, json, args)
      return
    case 'install': {
      const priority = parsePriority(flagString(args, 'priority'))
      const disableAfterInstall = flagBoolean(args, 'no-enable')
      const result = await manager.install(required(args.positionals[0], '安装来源或 Source ID'), {
        ...(flagString(args, 'as') === undefined ? {} : { as: flagString(args, 'as') }),
        ...(flagString(args, 'source-as') === undefined ? {} : { sourceAs: flagString(args, 'source-as') }),
        ...(flagStrings(args, 'plugin').length === 0 ? {} : { plugins: flagStrings(args, 'plugin') }),
        ...(flagStrings(args, 'path').length === 0 ? {} : { paths: flagStrings(args, 'path') }),
        // 未传 --no-enable 时保留 Marketplace 的默认启用策略；不能由 CLI
        // 无条件写成 true，否则会覆盖 Codex 的 AVAILABLE 等语义。
        ...(disableAfterInstall ? { enable: false } : {}),
        ...(priority === undefined ? {} : { priority }),
        selectPlugins: selectPluginsInteractively,
      })
      print(result, json, () => [
        `Source: ${result.source.source.id}`,
        ...result.plugins.map(item => `已安装 ${item.plugin.id}；启用状态：${item.enabled ? '待 DSH 加载' : '未启用'}`),
      ].join('\n'))
      return
    }
    case 'update': {
      const pluginId = required(args.positionals[0], 'Plugin ID')
      const source = flagString(args, 'source')
      let confirmShared = flagBoolean(args, 'yes')
      let result
      try {
        result = await manager.update(pluginId, {
          ...(source === undefined ? {} : { source }),
          confirmShared,
        })
      } catch (error) {
        if (!(error instanceof SharedSourceUpdateError) || confirmShared || json) throw error
        confirmShared = await confirmSharedUpdateInteractively(error)
        if (!confirmShared) throw error
        result = await manager.update(pluginId, {
          ...(source === undefined ? {} : { source }),
          confirmShared: true,
        })
      }
      print(result, json, () => formatInspection(result))
      return
    }
    case 'enable': {
      const result = await manager.enable(required(args.positionals[0], 'Plugin ID'))
      print(result, json, () => `${result.scan.plugin.id} 已标记启用；将在 DSH 下次加载时生效`)
      return
    }
    case 'disable': {
      const result = await manager.disable(required(args.positionals[0], 'Plugin ID'))
      print(result, json, () => `${result.scan.plugin.id} 已禁用`)
      return
    }
    case 'uninstall': {
      const pluginId = required(args.positionals[0], 'Plugin ID')
      await manager.uninstall(pluginId)
      print({ uninstalled: pluginId }, json, () => `已卸载 ${pluginId}`)
      return
    }
    case 'list': {
      const result = await manager.list()
      print(result, json, () => formatList(result))
      return
    }
    case 'inspect': {
      const result = await manager.inspect(required(args.positionals[0], 'Plugin ID'))
      print(result, json, () => formatInspection(result))
      return
    }
    default:
      throw new Error(`未知命令：${args.command}\n\n${HELP}`)
  }
}

main().catch((error: unknown) => {
  if (error instanceof CompatibilityError) {
    console.error(error.message)
    for (const item of error.diagnostics.filter(item => item.level === 'error')) {
      console.error(`ERROR ${item.code}: ${item.message}`)
    }
    process.exitCode = 2
    return
  }
  if (error instanceof PluginSelectionRequiredError) {
    console.error(error.message)
    for (const plugin of error.plugins) console.error(`  - ${plugin.id}${plugin.description ? `：${plugin.description}` : ''}`)
    console.error('无交互环境请重复使用 --plugin <id> 指定需要安装的 Plugin。')
    process.exitCode = 2
    return
  }
  if (error instanceof SharedSourceUpdateError) {
    console.error(error.message)
    console.error('确认更新全部受影响 Plugin 时，请重新执行并加入 --yes。')
    process.exitCode = 2
    return
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
