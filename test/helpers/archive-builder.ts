import { writeFile } from 'node:fs/promises'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data?: string | Buffer
  mode?: number
}

export async function createStoredZip(path: string, entries: ZipEntry[]): Promise<void> {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralOffset = offset
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  await writeFile(path, Buffer.concat([...locals, central, eocd]))
}

function tarString(header: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value).copy(header, offset, 0, length)
}

function tarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0') + '\0'
  tarString(header, offset, length, text)
}

export interface TarEntry {
  name: string
  data?: string | Buffer
  type?: '0' | '2' | '5'
  linkname?: string
}

export async function createTar(path: string, entries: TarEntry[]): Promise<void> {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    const type = entry.type ?? '0'
    const header = Buffer.alloc(512)
    tarString(header, 0, 100, entry.name)
    tarOctal(header, 100, 8, type === '5' ? 0o755 : 0o644)
    tarOctal(header, 108, 8, 0)
    tarOctal(header, 116, 8, 0)
    tarOctal(header, 124, 12, type === '0' ? data.length : 0)
    tarOctal(header, 136, 12, Math.floor(Date.now() / 1000))
    header.fill(0x20, 148, 156)
    header[156] = type.charCodeAt(0)
    if (entry.linkname) tarString(header, 157, 100, entry.linkname)
    tarString(header, 257, 6, 'ustar\0')
    tarString(header, 263, 2, '00')
    let checksum = 0
    for (const byte of header) checksum += byte
    tarString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
    blocks.push(header)
    if (type === '0') {
      blocks.push(data)
      const padding = (512 - data.length % 512) % 512
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024))
  await writeFile(path, Buffer.concat(blocks))
}
