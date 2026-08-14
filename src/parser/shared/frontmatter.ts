export interface FrontmatterResult {
  attributes: Record<string, unknown>
  body: string
}

interface YamlLine {
  indent: number
  text: string
  raw: string
  number: number
}

function splitInline(value: string): string[] {
  const result: string[] = []
  let start = 0
  let quote: string | undefined
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote !== undefined) {
      if (char === quote && value[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      result.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '') return ''
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as unknown } catch { throw new Error(`双引号字符串无效：${value}`) }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInline(value.slice(1, -1)).map(parseScalar)
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const object: Record<string, unknown> = {}
    for (const item of splitInline(value.slice(1, -1))) {
      const colon = item.indexOf(':')
      if (colon <= 0) throw new Error(`行内对象无效：${value}`)
      object[item.slice(0, colon).trim()] = parseScalar(item.slice(colon + 1))
    }
    return object
  }
  return value.replace(/\s+#.*$/, '').trimEnd()
}

function tokenizeYaml(text: string): YamlLine[] {
  return text.split(/\r?\n/).map((raw, index) => {
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? '')) throw new Error(`第 ${index + 1} 行使用了 Tab 缩进`)
    const indent = raw.length - raw.trimStart().length
    return { indent, text: raw.trim(), raw, number: index + 1 }
  })
}

function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = tokenizeYaml(text)
  let index = 0

  const skipEmpty = (): void => {
    while (index < lines.length && (lines[index].text === '' || lines[index].text.startsWith('#'))) index += 1
  }

  const parseBlockScalar = (parentIndent: number, folded: boolean): string => {
    const values: string[] = []
    let minimum = Number.POSITIVE_INFINITY
    let scan = index
    while (scan < lines.length) {
      const line = lines[scan]
      if (line.text !== '' && line.indent <= parentIndent) break
      if (line.text !== '') minimum = Math.min(minimum, line.indent)
      scan += 1
    }
    if (!Number.isFinite(minimum)) minimum = parentIndent + 2
    while (index < scan) {
      const line = lines[index]
      values.push(line.raw.length >= minimum ? line.raw.slice(minimum) : '')
      index += 1
    }
    return folded ? values.join('\n').replace(/([^\n])\n([^\n])/g, '$1 $2') : values.join('\n')
  }

  const parseBlock = (indent: number): unknown => {
    skipEmpty()
    if (index >= lines.length || lines[index].indent < indent) return {}
    const arrayMode = lines[index].indent === indent && lines[index].text.startsWith('-')
    if (arrayMode) {
      const values: unknown[] = []
      while (index < lines.length) {
        skipEmpty()
        if (index >= lines.length || lines[index].indent < indent) break
        const line = lines[index]
        if (line.indent !== indent || !line.text.startsWith('-')) break
        const remainder = line.text.slice(1).trimStart()
        index += 1
        if (remainder === '') {
          values.push(parseBlock(indent + 2))
          continue
        }
        const colon = remainder.indexOf(':')
        if (colon > 0 && !remainder.startsWith('http://') && !remainder.startsWith('https://')) {
          const object: Record<string, unknown> = {}
          const key = remainder.slice(0, colon).trim()
          const rest = remainder.slice(colon + 1).trim()
          object[key] = rest === '' ? parseBlock(indent + 2) : parseScalar(rest)
          while (index < lines.length) {
            skipEmpty()
            if (index >= lines.length || lines[index].indent <= indent) break
            const nested = lines[index]
            if (nested.indent !== indent + 2) throw new Error(`第 ${nested.number} 行缩进不一致`)
            const nestedColon = nested.text.indexOf(':')
            if (nestedColon <= 0) throw new Error(`第 ${nested.number} 行不是键值对`)
            const nestedKey = nested.text.slice(0, nestedColon).trim()
            const nestedRest = nested.text.slice(nestedColon + 1).trim()
            index += 1
            object[nestedKey] = nestedRest === '' ? parseBlock(indent + 4) : parseScalar(nestedRest)
          }
          values.push(object)
        } else {
          values.push(parseScalar(remainder))
        }
      }
      return values
    }

    const object: Record<string, unknown> = {}
    while (index < lines.length) {
      skipEmpty()
      if (index >= lines.length || lines[index].indent < indent) break
      const line = lines[index]
      if (line.indent !== indent) throw new Error(`第 ${line.number} 行缩进不一致`)
      const colon = line.text.indexOf(':')
      if (colon <= 0) throw new Error(`第 ${line.number} 行不是键值对`)
      const key = line.text.slice(0, colon).trim()
      const rest = line.text.slice(colon + 1).trim()
      index += 1
      if (rest === '|' || rest === '|-' || rest === '|+') object[key] = parseBlockScalar(indent, false)
      else if (rest === '>' || rest === '>-' || rest === '>+') object[key] = parseBlockScalar(indent, true)
      else if (rest === '') object[key] = parseBlock(indent + 2)
      else object[key] = parseScalar(rest)
    }
    return object
  }

  const parsed = parseBlock(0)
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') throw new Error('frontmatter 顶层必须是对象')
  return parsed as Record<string, unknown>
}

/** 解析 SKILL.md/命令/Agent 常用 YAML frontmatter；正文保持原样。 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { attributes: {}, body: normalized }
  }
  const lines = normalized.split(/\r?\n/)
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) throw new Error('frontmatter 缺少结束分隔符 ---')
  return {
    attributes: parseYamlSubset(lines.slice(1, closing).join('\n')),
    body: lines.slice(closing + 1).join('\n'),
  }
}
