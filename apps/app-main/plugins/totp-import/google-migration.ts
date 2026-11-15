/**
 * Google Authenticator 迁移格式 —— `otpauth-migration://offline?data=<base64url protobuf>`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么手写 protobuf 读取器而不是引 protobufjs
 * ══════════════════════════════════════════════════════════════════════
 * 这个格式只用到 **两种 wire type**（varint 与 length-delimited）和**两层嵌套**。
 * 手写读取器不到 60 行、零依赖；引 protobufjs 是"为了一件事背一整个运行时"，
 * 而且 protobufjs 的代码生成/反射两种用法都不便宜。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 格式（Google 未公开文档，社区逆向的 MigrationPayload）
 * ══════════════════════════════════════════════════════════════════════
 *   MigrationPayload
 *     1: repeated OtpParameters otp_parameters
 *     2: int32  version
 *     3: int32  batch_size      ← 一次导出可能拆成多张二维码
 *     4: int32  batch_index
 *     5: int32  batch_id
 *   OtpParameters
 *     1: bytes  secret          ← **原始字节**，不是 base32
 *     2: string name            ← 账号
 *     3: string issuer
 *     4: enum   algorithm       (0 未指定 / 1 SHA1 / 2 SHA256 / 3 SHA512 / 4 MD5)
 *     5: enum   digits          (0 未指定 / 1 六位 / 2 八位)
 *     6: enum   type            (0 未指定 / 1 HOTP / 2 TOTP)
 *     7: int64  counter
 *
 * ⚠ 一个必须如实处理的细节：**多张二维码**。Google 每个导出上限约 10 条，
 * 30 条账号会拆成 3 张。用户可能只粘了一张 —— 那时要明确说"这是第 1 批，共 3 批"，
 * 否则他导入完 10 条就会以为剩下的丢了。分批信息在 `warnings` 里报出来。
 */

import { bytesToBase32, buildOtpauthUri } from './uri.js'

type MigrationBytes = Uint8Array
type MigrationEntry = {
  secret: string
  account: string
  issuer: string
  algorithm: string
  digits: number
  type: string
  counter: number
}
type FieldHandler = (field: number, num: number | null, bytes: MigrationBytes | null) => void

const ALGORITHM: Record<number, string> = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' }
const DIGITS: Record<number, number> = { 1: 6, 2: 8 }
const TYPE: Record<number, string> = { 1: 'HOTP', 2: 'TOTP' }

const MIGRATION_RE = /otpauth-migration:\/\/[^\s"'<>]+/gi

/** varint。用乘法而不是 `<<` —— JS 的位运算只有 32 位，counter 是 int64。 */
function readVarint(bytes: MigrationBytes, pos: number): [number, number] {
  let result = 0
  let shift = 0
  let b
  do {
    if (pos >= bytes.length) throw new Error('protobuf 数据被截断')
    b = bytes[pos++]
    result += (b & 0x7f) * Math.pow(2, shift)
    shift += 7
    if (shift > 70) throw new Error('varint 过长（数据可能不是这个格式）')
  } while (b & 0x80)
  return [result, pos]
}

/** 逐字段扫一遍消息，把值交给回调 —— 不认识/不关心的字段按 wire type 跳过。 */
function readMessage(bytes: MigrationBytes, onField: FieldHandler): void {
  let pos = 0
  while (pos < bytes.length) {
    let tag
    ;[tag, pos] = readVarint(bytes, pos)
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      let v
      ;[v, pos] = readVarint(bytes, pos)
      onField(field, v, null)
    } else if (wire === 2) {
      let len
      ;[len, pos] = readVarint(bytes, pos)
      if (pos + len > bytes.length) throw new Error('protobuf 长度越界')
      const slice = bytes.subarray(pos, pos + len)
      pos += len
      onField(field, null, slice)
    } else if (wire === 5) {
      pos += 4
    } else if (wire === 1) {
      pos += 8
    } else {
      throw new Error(`protobuf 里有不支持的 wire type ${wire}`)
    }
  }
}

/** 标准 base64 或 urlsafe base64 → Uint8Array。 */
function base64ToBytes(b64: unknown): MigrationBytes {
  const norm = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** utf8 字节 → 字符串（protobuf 的 string 字段是 utf8）。 */
function utf8(bytes: MigrationBytes): string {
  if (typeof TextDecoder === 'function') {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes) } catch (_) { /* 落到下面 */ }
  }
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** 解析一个 `otpauth-migration://` 链接。 */
function parseOne(link: string): {
  entries: MigrationEntry[]
  batchSize: number
  batchIndex: number
  batchId: number
} {
  const m = /[?&]data=([^&]+)/i.exec(link)
  if (!m) throw new Error('迁移链接里没有 data 参数')
  const payload = base64ToBytes(decodeURIComponent(m[1]))

  const entries: MigrationEntry[] = []
  let batchSize = 0
  let batchIndex = 0
  let batchId = 0

  readMessage(payload, (field, num, bytes) => {
    if (field === 1 && bytes) {
      const e: MigrationEntry = { secret: '', account: '', issuer: '', algorithm: 'SHA1', digits: 6, type: 'TOTP', counter: 0 }
      readMessage(bytes, (f, n, b) => {
        if (f === 1 && b) e.secret = bytesToBase32(b)          // 原始字节 → base32
        else if (f === 2 && b) e.account = utf8(b)
        else if (f === 3 && b) e.issuer = utf8(b)
        else if (f === 4 && n != null) e.algorithm = ALGORITHM[n] || 'SHA1'
        else if (f === 5 && n != null) e.digits = DIGITS[n] || 6
        else if (f === 6 && n != null) e.type = TYPE[n] || 'TOTP'
        else if (f === 7 && n != null) e.counter = n
      })
      entries.push(e)
      return
    }
    if (num == null) return
    if (field === 3) batchSize = num
    else if (field === 4) batchIndex = num
    else if (field === 5) batchId = num
  })

  return { entries, batchSize, batchIndex, batchId }
}

/** 从任意文本里抽出所有迁移链接（可能跨多行 = 多张二维码）。 */
function findLinks(text: unknown): string[] {
  const s = String(text || '')
  const out: string[] = []
  const re = new RegExp(MIGRATION_RE.source, 'gi')
  let m
  while ((m = re.exec(s)) !== null) {
    out.push(m[0].replace(/[),，。；;、】\]}）》」"']+$/, ''))
  }
  return out
}

export const googleMigrationAdapter = {
  id: 'google-migration',
  label: 'Google Authenticator 迁移码',
  match(text: string): boolean {
    return findLinks(text).length > 0
  },
  decode(text: string) {
    const links = findLinks(text)
    const uris: string[] = []
    const warnings: string[] = []
    /** batch_id → { batches: Set, size } 用来判断"是不是只给了一部分" */
    const batches = new Map<number, { indexes: Set<number>; size: number }>()

    for (const link of links) {
      const { entries, batchSize, batchIndex, batchId } = parseOne(link)
      for (const e of entries) {
        if (!e.secret) continue
        uris.push(buildOtpauthUri(e))
      }
      if (batchSize > 1) {
        const rec = batches.get(batchId) || { indexes: new Set(), size: batchSize }
        rec.indexes.add(batchIndex)
        rec.size = batchSize
        batches.set(batchId, rec)
      }
    }

    // 分批没给全 → 说出来。不说的话用户会以为"导入完了但少了一半"，而重新导出一次成本很高
    for (const rec of batches.values()) {
      if (rec.indexes.size < rec.size) {
        warnings.push(`这是分批导出的一部分（已包含 ${rec.indexes.size}/${rec.size} 张二维码）——请把其余的二维码也扫出来一起粘贴`)
      }
    }
    return { uris, warnings }
  }
}
