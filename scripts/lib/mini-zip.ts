// @ts-check
/**
 * 最小 ZIP **写入器** —— 只服务于验证脚本（造样本，含合法的与恶意的）。
 *
 * 为什么不 shell 出去调系统压缩工具：`pnpm verify:plugin-install` 最需要测的那条边界是
 * **zip-slip**（条目名里写 `../`），而系统自带的压缩工具**不会**让你造出这种包 ——
 * 而"造不出攻击样本"恰恰意味着那条防线从没被验过。所以条目名必须完全由我们控制。
 *
 * 支持：store(0) 与 deflate(8) 两种方式、目录条目。不支持 ZIP64 / 加密
 * （要测"ZIP64 被拒"这条边界时，直接改 EOCD 里的条目数为 `0xffff` 即可）。
 */

const zlib = require('zlib')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/**
 * @param {Array<{ name: string, data?: Buffer|string, dir?: boolean, deflate?: boolean }>} entries
 * @returns {Buffer}
 */
function makeZip(entries: Array<{ name: string, data?: Buffer|string, dir?: boolean, deflate?: boolean }>) : Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = e.dir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8')
    const method = e.deflate ? 8 : 0
    const stored = e.deflate ? zlib.deflateRawSync(raw) : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, stored)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(stored.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(e.dir ? 0x10 : 0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + stored.length
  }
  const cenBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cenBuf, eocd])
}

/**
 * 造一个「能通过安装器体检」的最小插件包。
 * @param {{ id: string, name?: string, version?: string, main?: string, extra?: Array<{name:string,data:any,deflate?:boolean}>, signature?: any }} spec
 */
interface ZipPluginSpec {
  id: string
  name?: string
  version?: string
  main?: string
  extra?: Array<{ name: string; data: Buffer | string; deflate?: boolean }>
  signature?: unknown
}

function makePluginZip(spec: ZipPluginSpec): Buffer {
  const main = spec.main || 'index.cjs'
  const manifest: {
    id: string
    name: string
    version: string
    main: string
    signature?: unknown
  } = {
    id: spec.id,
    name: spec.name || spec.id,
    version: spec.version || '1.0.0',
    main
  }
  if (spec.signature) manifest.signature = spec.signature
  return makeZip([
    { name: 'hira-plugin.json', data: JSON.stringify(manifest, null, 2) },
    { name: main, data: 'module.exports = { install() {}, enable() {}, disable() {} }\n', deflate: true },
    ...(spec.extra || [])
  ])
}

module.exports = { makeZip, makePluginZip, crc32 }
