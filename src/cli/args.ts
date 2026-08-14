export interface ParsedArguments {
  command?: string
  positionals: string[]
  flags: Map<string, string[] | boolean>
}

const BOOLEAN_FLAGS = new Set(['help', 'json', 'no-enable', 'yes'])
const VALUE_FLAGS = new Set([
  'as',
  'source-as',
  'home',
  'priority',
  'source',
  'plugin',
  'path',
])
const REPEATABLE_VALUE_FLAGS = new Set(['plugin', 'path'])

/**
 * 解析独立 CLI 参数。
 *
 * `--plugin` 与 `--path` 可以重复出现；其余带值参数重复时明确报错，避免
 * “最后一个值静默覆盖前一个值”造成难以审计的安装行为。
 */
export function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv
  const positionals: string[] = []
  const flags = new Map<string, string[] | boolean>()

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }

    const equals = value.indexOf('=')
    const name = equals > 2 ? value.slice(2, equals) : value.slice(2)
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) throw new Error(`未知参数：--${name}`)

    if (BOOLEAN_FLAGS.has(name)) {
      if (equals > 2) throw new Error(`布尔参数 --${name} 不接受值`)
      if (flags.has(name)) throw new Error(`参数 --${name} 重复出现`)
      flags.set(name, true)
      continue
    }

    const supplied = equals > 2 ? value.slice(equals + 1) : rest[index + 1]
    if (supplied === undefined || supplied.startsWith('--')) throw new Error(`参数 --${name} 缺少值`)
    if (supplied === '') throw new Error(`参数 --${name} 不能为空`)

    const previous = flags.get(name)
    if (previous !== undefined && !REPEATABLE_VALUE_FLAGS.has(name)) {
      throw new Error(`参数 --${name} 不能重复出现`)
    }
    const values = Array.isArray(previous) ? previous : []
    flags.set(name, [...values, supplied])
    if (equals <= 2) index += 1
  }

  return { command, positionals, flags }
}

export function flagStrings(args: ParsedArguments, name: string): string[] {
  const value = args.flags.get(name)
  return Array.isArray(value) ? [...value] : []
}

export function flagString(args: ParsedArguments, name: string): string | undefined {
  const values = flagStrings(args, name)
  return values.length === 0 ? undefined : values[values.length - 1]
}

export function flagBoolean(args: ParsedArguments, name: string): boolean {
  return args.flags.get(name) === true
}
