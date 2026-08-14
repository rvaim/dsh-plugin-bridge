import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { writeExclusive } from './filesystem.js'
import {
  DEFAULT_EXTRACTION_LIMITS,
  type ExtractionLimits,
  normalizeArchivePath,
  validateSymlinkTarget,
  verifyExtractedTree,
} from './safety.js'

interface PendingSymlink {
  path: string
  target: string
}

interface ExtractionBudget {
  entries: number
  bytes: number
}

function mergeLimits(overrides: Partial<ExtractionLimits>): ExtractionLimits {
  return { ...DEFAULT_EXTRACTION_LIMITS, ...overrides }
}

function consumeBudget(
  budget: ExtractionBudget,
  size: number,
  limits: ExtractionLimits,
  name: string,
): void {
  budget.entries += 1
  if (budget.entries > limits.maxEntries) throw new Error(`归档成员数量超过限制：${limits.maxEntries}`)
  if (size > limits.maxFileBytes) throw new Error(`归档成员过大：${name}`)
  budget.bytes += size
  if (budget.bytes > limits.maxTotalBytes) throw new Error(`归档解压总大小超过限制：${limits.maxTotalBytes}`)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('ZIP 缺少 End of Central Directory')
}

async function extractZip(buffer: Buffer, destination: string, limits: ExtractionLimits): Promise<void> {
  const eocd = findZipEndOfCentralDirectory(buffer)
  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new Error('不支持多卷 ZIP')
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('暂不支持 ZIP64')
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP 中央目录越界')

  const seen = new Set<string>()
  const symlinks: PendingSymlink[] = []
  const budget: ExtractionBudget = { entries: 0, bytes: 0 }
  let cursor = centralOffset

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if ([compressedSize, uncompressedSize, localOffset].some(value => value === 0xffffffff)) throw new Error('暂不支持 ZIP64 成员')
    if ((flags & 0x1) !== 0) throw new Error('不支持加密 ZIP')
    const nameEnd = cursor + 46 + nameLength
    if (nameEnd + extraLength + commentLength > buffer.length) throw new Error('ZIP 成员元数据越界')
    const rawName = buffer.subarray(cursor + 46, nameEnd).toString('utf8')
    const name = normalizeArchivePath(rawName)
    cursor = nameEnd + extraLength + commentLength
    if (name === '') continue
    if (seen.has(name)) throw new Error(`ZIP 包含重复成员：${name}`)
    seen.add(name)

    const unixPlatform = (versionMadeBy >>> 8) === 3
    const unixMode = unixPlatform ? externalAttributes >>> 16 : 0
    const fileType = unixMode & 0o170000
    const isDirectory = rawName.endsWith('/') || fileType === 0o040000
    const isSymlink = fileType === 0o120000
    consumeBudget(budget, isDirectory ? 0 : uncompressedSize, limits, name)

    const outputPath = resolve(destination, name)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error(`ZIP 压缩数据越界：${name}`)

    if (isDirectory) {
      await mkdir(outputPath, { recursive: true, mode: 0o700 })
      continue
    }
    let data: Buffer
    const compressed = buffer.subarray(dataStart, dataEnd)
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes })
    else throw new Error(`ZIP 使用不支持的压缩方法 ${method}：${name}`)
    if (data.length !== uncompressedSize) throw new Error(`ZIP 成员大小不匹配：${name}`)
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP 成员 CRC 校验失败：${name}`)

    if (isSymlink) {
      const target = data.toString('utf8')
      validateSymlinkTarget(destination, outputPath, target)
      symlinks.push({ path: outputPath, target })
    } else {
      const mode = unixMode === 0 ? 0o600 : unixMode & 0o777
      await writeExclusive(outputPath, data, mode)
    }
  }

  for (const link of symlinks) {
    await mkdir(dirname(link.path), { recursive: true, mode: 0o700 })
    await symlink(link.target, link.path)
  }
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset)
  const actualEnd = end === -1 || end > offset + length ? offset + length : end
  return buffer.subarray(offset, actualEnd).toString('utf8').trimEnd()
}

function readTarNumber(buffer: Buffer, offset: number, length: number): number {
  const first = buffer[offset]
  if ((first & 0x80) !== 0) {
    let value = BigInt(first & 0x7f)
    for (let index = offset + 1; index < offset + length; index += 1) value = (value << 8n) | BigInt(buffer[index])
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TAR 数值超过安全整数范围')
    return Number(value)
  }
  const text = buffer.subarray(offset, offset + length).toString('ascii').replaceAll('\0', '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`TAR 八进制字段无效：${text}`)
  return Number.parseInt(text, 8)
}

function verifyTarChecksum(header: Buffer): void {
  const expected = readTarNumber(header, 148, 8)
  let actual = 0
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]
  if (expected !== actual) throw new Error('TAR 头校验和错误')
}

function parsePax(payload: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space < 0) throw new Error('PAX 记录缺少长度分隔符')
    const length = Number.parseInt(payload.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isInteger(length) || length <= 0 || offset + length > payload.length) throw new Error('PAX 记录长度无效')
    const record = payload.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return result
}

async function extractTar(buffer: Buffer, destination: string, limits: ExtractionLimits): Promise<void> {
  const seen = new Set<string>()
  const symlinks: PendingSymlink[] = []
  const budget: ExtractionBudget = { entries: 0, bytes: 0 }
  let cursor = 0
  let globalPax: Record<string, string> = {}
  let nextPax: Record<string, string> = {}
  let longName: string | undefined
  let longLink: string | undefined

  while (cursor + 512 <= buffer.length) {
    const header = buffer.subarray(cursor, cursor + 512)
    cursor += 512
    if (header.every(byte => byte === 0)) break
    verifyTarChecksum(header)
    const rawName = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const headerName = prefix === '' ? rawName : `${prefix}/${rawName}`
    const headerSize = readTarNumber(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] || 0)
    const headerLink = readTarString(header, 157, 100)
    const paddedSize = Math.ceil(headerSize / 512) * 512
    if (cursor + paddedSize > buffer.length) throw new Error(`TAR 成员数据越界：${headerName}`)
    const payload = buffer.subarray(cursor, cursor + headerSize)
    cursor += paddedSize

    if (typeFlag === 'g' || typeFlag === 'x') {
      const values = parsePax(payload)
      if (typeFlag === 'g') globalPax = { ...globalPax, ...values }
      else nextPax = values
      continue
    }
    if (typeFlag === 'L') {
      longName = payload.toString('utf8').replace(/\0.*$/s, '').trimEnd()
      continue
    }
    if (typeFlag === 'K') {
      longLink = payload.toString('utf8').replace(/\0.*$/s, '').trimEnd()
      continue
    }

    const pax = { ...globalPax, ...nextPax }
    nextPax = {}
    const effectiveName = pax.path ?? longName ?? headerName
    const effectiveLink = pax.linkpath ?? longLink ?? headerLink
    longName = undefined
    longLink = undefined
    const declaredSize = pax.size === undefined ? headerSize : Number(pax.size)
    if (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize !== headerSize) {
      throw new Error(`TAR PAX size 与成员数据不一致：${effectiveName}`)
    }
    const name = normalizeArchivePath(effectiveName)
    if (name === '') continue
    if (seen.has(name)) throw new Error(`TAR 包含重复成员：${name}`)
    seen.add(name)
    const outputPath = resolve(destination, name)

    if (typeFlag === '5') {
      consumeBudget(budget, 0, limits, name)
      await mkdir(outputPath, { recursive: true, mode: 0o700 })
    } else if (typeFlag === '0' || typeFlag === '\0') {
      consumeBudget(budget, payload.length, limits, name)
      await writeExclusive(outputPath, Buffer.from(payload), readTarNumber(header, 100, 8) & 0o777)
    } else if (typeFlag === '2') {
      consumeBudget(budget, 0, limits, name)
      validateSymlinkTarget(destination, outputPath, effectiveLink)
      symlinks.push({ path: outputPath, target: effectiveLink })
    } else if (typeFlag === '1') {
      throw new Error(`TAR 硬链接不受支持：${name}`)
    } else {
      throw new Error(`TAR 包含不支持的成员类型 ${JSON.stringify(typeFlag)}：${name}`)
    }
  }

  for (const link of symlinks) {
    await mkdir(dirname(link.path), { recursive: true, mode: 0o700 })
    await symlink(link.target, link.path)
  }
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

/** 安全解压 ZIP、TAR、TGZ；任何成员都不得逃出 destination。 */
export async function extractArchive(
  archivePath: string,
  destination: string,
  overrides: Partial<ExtractionLimits> = {},
): Promise<void> {
  const limits = mergeLimits(overrides)
  const info = await stat(archivePath)
  if (!info.isFile()) throw new Error(`不是归档文件：${archivePath}`)
  if (info.size > limits.maxArchiveBytes) throw new Error(`归档文件超过限制：${limits.maxArchiveBytes}`)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const original = await readFile(archivePath)

  if (original.length >= 4 && original.readUInt32LE(0) === 0x04034b50) {
    await extractZip(original, destination, limits)
  } else {
    const tar = original[0] === 0x1f && original[1] === 0x8b
      ? gunzipSync(original, { maxOutputLength: limits.maxTotalBytes + limits.maxEntries * 512 })
      : original
    if (tar.length < 512 || readTarString(tar, 257, 6) !== 'ustar') {
      throw new Error('无法识别归档格式；仅支持 ZIP、TAR、TGZ/TAR.GZ')
    }
    await extractTar(tar, destination, limits)
  }
  await verifyExtractedTree(destination)
}
