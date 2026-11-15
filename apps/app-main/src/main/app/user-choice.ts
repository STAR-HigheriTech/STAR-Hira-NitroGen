/**
 * app/user-choice.ts —— Windows `UserChoice` 的**合法 Hash 计算**（全项目唯一实现）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * Win8+ 把「某个类型 / 协议默认交给谁」存在
 *   HKCU\...\Explorer\FileExts\<ext>\UserChoice
 *   HKCU\...\Shell\Associations\UrlAssociations\<scheme>\UserChoice
 * 里，并且要求旁边带一个 `Hash`。系统在读取时**会重算这个 Hash**：
 * 对不上就判定「被第三方篡改」，直接把用户的选择丢弃、退回默认。
 * 所以程序想静默改默认程序，必须自己算出与系统一致的 Hash —— 这就是本模块。
 *
 * ── 算法来源（不是自创，是复现系统的算法）──────────────────────────
 * 逆向结论（看雪 / PS-SFTA，MIT）：把下面五个字段拼成一个字符串、
 * 整体转小写，先做 MD5，再以 MD5 摘要为密钥跑一遍系统私有的 8 字节摘要，
 * 最后 Base64 就是 `Hash` 值：
 *
 *   类型 + 用户 SID + ProgId + 时间戳(FILETIME 的 16 位十六进制) + UserExperience
 *
 *   · 类型：文件扩展名**带点**（`.html`）；协议名**不带点**（`http`）；
 *   · SID：当前登录用户的 SID，小写；
 *   · 时间戳：**当前时间截断到整分钟**再转 FILETIME 十六进制 —— 关键细节，
 *     系统校验时用的是这个键自身的 LastWriteTime（也截断到分钟），
 *     双方都按分钟对齐才能在「秒」级别容忍写入耗时；
 *   · UserExperience：从 shell32.dll 里读出的一段固定字符串
 *     （`User Choice set via Windows User Experience {GUID}`），
 *     不同系统版本这段 GUID 可能不同，所以运行时读、读不到才用兜底常量。
 *
 * 全项目实测校验：用本模块对**系统自己写下的** 4 个 UserChoice（`.htm` / `.html` /
 * `http` / `https`）回算，4 个全部逐字节相同。
 *
 * 纯函数 + 极小副作用（读一个 DLL、取一次 SID 后缓存），不 require electron。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface UserChoiceTarget {
  kind: 'file' | 'url'
  key: string
}

export interface UserChoiceHashInput extends UserChoiceTarget {
  progId: string
  stamp: string
}

/** 兜底：读不到 shell32.dll 里的 UserExperience 时用这条（Win10/11 通用）。 */
const EXPERIENCE_FALLBACK =
  'User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}'

/**
 * @typedef {{ kind: 'file' | 'url', key: string }} UserChoiceTarget
 *   kind='file' → key 是带点的扩展名（`.html`）；kind='url' → key 是协议名（`http`）
 */



/**
 * 读取系统的那段 UserExperience 字符串（进程内缓存）。
 *
 * 位置：`%SystemRoot%\SysWOW64\Shell32.dll`（32 位版，与系统计算 Hash 时用的那份一致）。
 * 只读前 8MB：这段字符串实测落在 ~130KB 处，8MB 已足够且不会拖慢启动。
 * @returns {string}
 */
let experienceCache: string | null = null
export function userExperience(): string {
  if (experienceCache) return experienceCache
  experienceCache = EXPERIENCE_FALLBACK
  try {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const dll = path.join(systemRoot, 'SysWOW64', 'Shell32.dll')
    const head = fs.readFileSync(dll).subarray(0, 8 * 1024 * 1024)
    const text = head.toString('utf16le')
    const needle = 'User Choice set via Windows User Experience'
    const start = text.indexOf(needle)
    const end = start < 0 ? -1 : text.indexOf('}', start)
    if (end > start) experienceCache = text.slice(start, end + 1)
  } catch (_) {
    /* 读不到就用兜底常量：Win10/11 上两者逐字一致 */
  }
  return experienceCache || EXPERIENCE_FALLBACK
}

/**
 * 当前登录用户的 SID（小写，进程内缓存）。
 *
 * Node 没有直接暴露 SID；`whoami /user /fo csv /nh` 是唯一不需要额外依赖的取值方式
 * （输出 `"domain\user","S-1-5-21-..."`）。只取一次，后续全部走缓存。
 * @returns {string}
 */
let sidCache: string | null = null
export function currentUserSid(): string | null {
  if (sidCache) return sidCache
  try {
    const out = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const match = /"(S-1-[0-9-]+)"/i.exec(out)
    if (match && match[1]) sidCache = match[1].toLowerCase()
  } catch (_) {
    /* 取不到 SID 时无法算 Hash，调用方会跳过 UserChoice 改写 */
  }
  return sidCache
}

/**
 * 把一个时间点转成「截断到整分钟」的 FILETIME 十六进制（16 位小写）。
 *
 * 为什么用 BigInt：FILETIME 是 100ns 单位的 64 位整数（约 1.34e17），
 * 超出 JS 双精度能精确表示的 2^53，用 Number 会丢低位、算出错误 Hash。
 * @param {Date} [date]
 * @returns {string}
 */
export function minuteStamp(date: Date = new Date()): string {
  const truncated = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0,
    0
  )
  // 1601-01-01 起的 100ns 数 = (本地时间戳的 UTC 毫秒 + 偏移) * 10000
  const fileTime = (BigInt(truncated.getTime()) + 11644473600000n) * 10000n
  return fileTime.toString(16).padStart(16, '0')
}

/** 32 位无符号右移：与系统算法里的「右移 16 位」逐位一致（负数的符号位不参与）。 */
function shr(x: number, n: number): number {
  return x >>> n
}

/**
 * 系统的私有摘要（8 字节，Base64 后就是 `Hash` 值）。
 *
 * 逐行对应公开的逆向实现（PS-SFTA 的 Get-Hash）：两轮相同的循环，
 * 每轮分别把 (本轮结果) 与 (上一轮结果) 拼成 16 字节，再对半异或成 8 字节。
 * 所有乘法都必须按 32 位回绕（Math.imul），PowerShell 侧的 Int64 也只在
 * 低 32 位上有效 —— 少了这一步，算出来就是另一个值。
 *
 * @param {string} baseInfo 已转小写的拼接串
 * @returns {string} Base64（12 字符）；字符串太短时返回空串
 */
function digest(baseInfo: string): string {
  const data = Buffer.concat([Buffer.from(baseInfo, 'utf16le'), Buffer.from([0, 0])])
  const md5 = crypto.createHash('md5').update(data).digest()

  const lengthBase = baseInfo.length * 2 + 2
  // 与逆向实现同式：length = ((lengthBase & 4) <= 1) + (lengthBase >>> 2) - 1
  const length = ((lengthBase & 4) === 0 ? 1 : 0) + shr(lengthBase, 2) - 1
  if (length <= 1) return ''
  const counter = shr(length - 2, 1) + 1

  /** 单轮循环；`offset` 为 0 时用带偏移的密钥常量（第一轮），否则用裸摘要（第二轮）。 */
  const run = (offset: boolean): { out1: number; out2: number } => {
    const k1 = offset
      ? (md5.readInt32LE(0) | 1) + 0x69fb0000
      : md5.readInt32LE(0) | 1
    const k2 = offset
      ? (md5.readInt32LE(4) | 1) + 0x13db0000
      : md5.readInt32LE(4) | 1
    let pdata = 0
    let cache = 0
    let out1 = 0
    let out2 = 0
    for (let i = 0; i < counter; i++) {
      const r0 = (data.readInt32LE(pdata) + out1) | 0
      const r1 = data.readInt32LE(pdata + 4)
      pdata += 8
      if (offset) {
        const r2a = (Math.imul(r0, k1) - Math.imul(0x10fa9605, shr(r0, 16))) | 0
        const r2b = (Math.imul(0x79f8a395, r2a) + Math.imul(0x689b6b9f, shr(r2a, 16))) | 0
        const r3 = (Math.imul(0xea970001, r2b) - Math.imul(0x3c101569, shr(r2b, 16))) | 0
        const r4 = (r3 + r1) | 0
        const r5 = (cache + r3) | 0
        const r6a = (Math.imul(r4, k2) - Math.imul(0x3ce8ec25, shr(r4, 16))) | 0
        const r6b = (Math.imul(0x59c3af2d, r6a) - Math.imul(0x2232e0f1, shr(r6a, 16))) | 0
        out1 = (Math.imul(0x1ec90001, r6b) + Math.imul(0x35bd1ec9, shr(r6b, 16))) | 0
        out2 = (r5 + out1) | 0
      } else {
        const r1a = (Math.imul(r0, k1)) | 0
        const r1b = (Math.imul(0xb1110000, r1a) - Math.imul(0x30674eef, shr(r1a, 16))) | 0
        const r2a = (Math.imul(0x5b9f0000, r1b) - Math.imul(0x78f7a461, shr(r1b, 16))) | 0
        const r2b = (Math.imul(0x12ceb96d, shr(r2a, 16)) - Math.imul(0x46930000, r2a)) | 0
        const r3 = (Math.imul(0x1d830000, r2b) + Math.imul(0x257e1d83, shr(r2b, 16))) | 0
        const r4a = (Math.imul(k2, (r3 + data.readInt32LE(pdata - 4)) | 0)) | 0
        const r4b = (Math.imul(0x16f50000, r4a) - Math.imul(0x5d8be90b, shr(r4a, 16))) | 0
        const r5a = (Math.imul(0x96ff0000, r4b) - Math.imul(0x2c7c6901, shr(r4b, 16))) | 0
        const r5b = (Math.imul(0x2b890000, r5a) + Math.imul(0x7c932b89, shr(r5a, 16))) | 0
        out1 = (Math.imul(0x9f690000, r5b) - Math.imul(0x405b6097, shr(r5b, 16))) | 0
        out2 = (out1 + cache + r3) | 0
      }
      cache = out2
    }
    return { out1, out2 }
  }

  const first = run(true)
  const second = run(false)
  // 两轮结果拼成 16 字节后，对半异或成 8 字节
  const buffer = Buffer.alloc(8)
  buffer.writeInt32LE((second.out1 ^ first.out1) | 0, 0)
  buffer.writeInt32LE((second.out2 ^ first.out2) | 0, 4)
  return buffer.toString('base64')
}

/**
 * 算一个类型的 UserChoice Hash。
 *
 * @param {UserChoiceTarget & { progId: string, stamp: string }} target
 *   `stamp` 必须是「这次写入落在哪个整分钟」，见 minuteStamp()。
 * @returns {string|null} 取不到 SID 时返回 null（调用方跳过改写，保持系统现状）
 */
export function userChoiceHash({ key, progId, stamp }: UserChoiceHashInput): string | null {
  const sid = currentUserSid()
  if (!sid) return null
  const baseInfo = `${key}${sid}${progId}${stamp}${userExperience()}`.toLowerCase()
  const hash = digest(baseInfo)
  return hash || null
}

/**
 * UserChoice 的注册表路径（不含 HKCU 前缀）。
 * @param {UserChoiceTarget} target
 * @returns {string}
 */
export function userChoiceKeyPath({ kind, key }: UserChoiceTarget): string {
  return kind === 'url'
    ? `Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${key}\\UserChoice`
    : `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${key}\\UserChoice`
}

