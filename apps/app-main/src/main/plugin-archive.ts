// @ts-check
/**
 * 最小 ZIP **读写器** —— 只为「插件/主题包的装与卸」这一件事存在。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么自己写而不是引一个库
 * ══════════════════════════════════════════════════════════════════════
 * 安装插件是**主进程**的职责，而主进程的依赖会被打进每个安装包 ——
 * 为一个「读一次 zip、解到临时目录、然后就不用了」的动作引入一个上万行的
 * 压缩库不划算。这里需要的子集极小：**只解压、不压缩、不加密**。
 *
 * 写（导出主题包）现在也需要了，而且比读简单得多：**一律用 store（不压缩）**。
 * 主题包的内容是 JSON 加几张图，其中图片本来就是已压缩格式，再 deflate 一遍
 * 换来的是"要自己实现压缩"这一整类风险（CRC/长度/位对齐），收益却只有几个百分点。
 * 所以写入端刻意只支持 method 0 —— 也让"导出的包"能被任何解压工具打开。
 *
 * 明确不支持的（遇到就报清楚的错，而不是解错）：
 *   · ZIP64（4GB+ / 65535+ 条目）—— 插件包永远不该那么大，支持它只会引入
 *     一堆 32/64 位分支，而模板串里最容易被漏掉的恰恰是这些分支；
 *   · 加密条目、`method` 非 0(store)/8(deflate) 的压缩方式。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全边界（**调用方**必须做的那一步）
 * ══════════════════════════════════════════════════════════════════════
 * 本模块只负责"把字节读出来 / 把字节拼起来"，**不做**路径合法性判断 ——
 * 但会把条目名原样交出去、也原样写进去。解开 zip-slip（条目名里写 `../../`）
 * 是落盘那一侧的事，见 `plugin-installer.js` 的 `resolveInside`；
 * 写入端由调用方保证名字是我们自己生成的（见 theme-package.js）。
 * **两者必须成对使用。**
 */

import zlib from 'node:zlib'

export interface ZipEntry {
  name: string
  isDir: boolean
  method: number
  compSize: number
  rawSize: number
  data: Buffer
}

export interface ZipWriteEntry { name: string; data: Buffer | string }

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
/** EOCD 之后最多还有 65535 字节的注释 */
const MAX_COMMENT = 0xffff
const EOCD_MIN_SIZE = 22
const CEN_FIXED_SIZE = 46
const LOC_FIXED_SIZE = 30
/** 条目数上限：一个插件包不该有几千个文件，超了多半是选错了文件 */
const MAX_ENTRIES = 4096
/** Installer transport cap; uncompressed content is checked by the installer budget. */
export const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * 从尾部往前找 EOCD（目录结尾记录）。
 * 之所以要"往前扫"而不是取末尾 22 字节：zip 允许在 EOCD 之后附加注释。
 */
function findEocd(buf: Buffer): number {
  const from = buf.length - EOCD_MIN_SIZE
  const to = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT)
  for (let i = from; i >= to; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 读出压缩包内的**全部条目**（含目录条目）。
 *
 * 刻意**只读中央目录**再按偏移取数据，而不是顺序扫本地头：中央目录是权威索引，
 * 顺序扫会被"数据描述符"（流式写入时大小写在数据之后）坑到。
 *
 * @param {Buffer} buf
 * @returns {Array<{ name: string, isDir: boolean, method: number, compSize: number, rawSize: number, data: Buffer }>}
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN_SIZE) {
    throw new Error('不是有效的压缩包（文件过小）')
  }
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的压缩包（找不到目录结尾记录）')

  const count = buf.readUInt16LE(eocd + 10)
  const cenSize = buf.readUInt32LE(eocd + 12)
  const cenOffset = buf.readUInt32LE(eocd + 16)
  // ZIP64 的三个"哨兵值"。判到就明确拒绝 —— 猜着解出来的东西比直接报错危险得多。
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff || cenOffset === 0xfffffffe) {
    throw new Error('暂不支持 ZIP64 格式的压缩包，请改用普通 zip 或直接放入一个文件夹')
  }
  if (count > MAX_ENTRIES) throw new Error(`压缩包内文件过多（${count} 个，上限 ${MAX_ENTRIES}）`)
  if (cenOffset + cenSize > buf.length) throw new Error('压缩包已损坏（目录区越界）')

  const entries: ZipEntry[] = []
  let p = cenOffset
  for (let i = 0; i < count; i += 1) {
    if (p + CEN_FIXED_SIZE > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('压缩包已损坏（目录项签名不正确）')
    }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + CEN_FIXED_SIZE, p + CEN_FIXED_SIZE + nameLen)
    p += CEN_FIXED_SIZE + nameLen + extraLen + commentLen

    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的压缩包')
    }
    if (rawSize > MAX_ENTRY_BYTES) throw new Error(`条目解压后过大：${name}`)
    if (localOffset + LOC_FIXED_SIZE > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error('压缩包已损坏（本地头签名不正确）')
    }
    // 本地头里的 name/extra 长度**可能与中央目录不同**（额外字段可以在两处不一样），
    // 所以必须读本地头自己的那一份来算数据起点 —— 用中央目录的长度会整体错位。
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + LOC_FIXED_SIZE + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`压缩包已损坏（条目数据越界：${name}）`)

    entries.push({
      name,
      isDir: name.endsWith('/'),
      method,
      compSize,
      rawSize,
      data: buf.subarray(dataStart, dataStart + compSize)
    })
  }
  return entries
}

/**
 * 解出单个条目的内容。
 *
 * 校验解压后的长度：zip 里带的是**未压缩大小**，对不上说明包被截断或改坏了。
 * 这是本模块唯一能做的完整性检查（真正的校验靠 manifest 里的签名，见 installer）。
 */
export function extractEntry(entry: ZipEntry): Buffer {
  if (entry.isDir) return Buffer.alloc(0)
  if (entry.method === 0) {
    if (entry.data.length > MAX_ENTRY_BYTES || entry.rawSize > MAX_ENTRY_BYTES) {
      throw new Error(`条目解压后过大：${entry.name}`)
    }
    const out = Buffer.from(entry.data)
    if (entry.rawSize && out.length !== entry.rawSize) {
      throw new Error(`压缩包已损坏（条目大小不符：${entry.name}）`)
    }
    return out
  }
  if (entry.method === 8) {
    if (entry.rawSize > MAX_ENTRY_BYTES) throw new Error(`条目解压后过大：${entry.name}`)
    const out = zlib.inflateRawSync(entry.data, { maxOutputLength: MAX_ENTRY_BYTES })
    if (entry.rawSize && out.length !== entry.rawSize) {
      throw new Error(`压缩包已损坏（条目大小不符：${entry.name}）`)
    }
    return out
  }
  throw new Error(`不支持的压缩方式 ${entry.method}（条目：${entry.name}）`)
}

// ══════════════════════════════════════════════════════════════════════
// 写入端（导出主题包）
// ══════════════════════════════════════════════════════════════════════

/** CRC32 查表（zip 要求每个条目带 CRC32；不校验的写入器会在严格工具里报错）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 固定时间戳（DOS 格式）= 1980-01-01 00:00。
 *
 * 为什么不用"现在"：导出的包会进版本库/云盘，**同样的主题应该导出同样的字节**
 * —— 时间戳一动，去重与 diff 全部失效。zip 允许这个最小值，解压工具都能处理。
 */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1

/**
 * 把若干条目拼成一个 ZIP（**全部 store，不压缩**）。
 *
 * @param {Array<{ name: string, data: Buffer|string }>} files
 * @returns {Buffer}
 */
export function writeZipEntries(files: readonly ZipWriteEntry[]): Buffer {
  const list = Array.isArray(files) ? files : []
  if (list.length > MAX_ENTRIES) throw new Error(`条目过多（${list.length} 个，上限 ${MAX_ENTRIES}）`)

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of list) {
    const name = String((file && file.name) || '')
    if (!name) throw new Error('条目缺少文件名')
    if (name.length > 0xffff) throw new Error(`条目文件名过长：${name.slice(0, 40)}…`)
    const data: Buffer = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data == null ? '' : String(file.data), 'utf8')
    if (data.length > 0xfffffffe) throw new Error(`条目过大（zip 不支持 4GB 以上）：${name}`)

    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(LOC_FIXED_SIZE + nameBytes.length)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0（UTF-8 名字）
    // 通用位 11（0x0800）= 文件名是 UTF-8。主题名常是中文，不带这一位会被解成乱码。
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    nameBytes.copy(local, LOC_FIXED_SIZE)

    locals.push(local, data)

    const central = Buffer.alloc(CEN_FIXED_SIZE + nameBytes.length)
    central.writeUInt32LE(CEN_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0o644 << 16, 38) // external attrs：普通文件权限
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, CEN_FIXED_SIZE)

    centrals.push(central)
    offset += local.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(EOCD_MIN_SIZE)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // disk with cd
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...locals, centralBuf, eocd])
}

