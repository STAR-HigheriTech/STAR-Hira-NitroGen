import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export interface FileStat { size: number; mtimeMs: number; isFile: boolean }
export interface TextReadOptions { encoding?: BufferEncoding }
export interface TextWriteOptions { encoding?: BufferEncoding; mode?: number }
export interface JsonWriteOptions { space?: number; mode?: number }
export interface FilePort {
  join(...parts: string[]): string
  resolve(...parts: string[]): string
  dirname(path: string): string
  basename(path: string): string
  sep: string
  existsSync(path: string): boolean
  pathExists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  mkdirSync(path: string): void
  readdirSync(path: string): string[]
  statSync(path: string): FileStat | null
  unlinkSync(path: string): boolean
  readText(path: string, options?: TextReadOptions): Promise<string>
  readTextSync(path: string, options?: TextReadOptions): string
  readJson<T = unknown>(path: string): Promise<T>
  readJsonSync<T = unknown>(path: string): T
  writeTextAtomic(path: string, text: string, options?: TextWriteOptions): Promise<void>
  writeJsonAtomic(path: string, value: unknown, options?: JsonWriteOptions): Promise<void>
  writeTextAtomicSync(path: string, text: string, options?: TextWriteOptions): void
  writeJsonAtomicSync(path: string, value: unknown, options?: JsonWriteOptions): void
  writeFileSync(path: string, text: string, options?: TextWriteOptions): void
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true })
}

export async function readText(filePath: string, { encoding = 'utf8' }: TextReadOptions = {}): Promise<string> {
  return fsp.readFile(filePath, encoding)
}

export async function writeTextAtomic(filePath: string, text: string, { encoding = 'utf8', mode }: TextWriteOptions = {}): Promise<void> {
  await ensureDir(path.dirname(filePath))
  return writeFileAtomic(filePath, text, { encoding, mode })
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 为什么必须做：Windows 记事本 / PowerShell 的 `Set-Content -Encoding UTF8` 会写入
 * `EF BB BF` 前缀，而 `JSON.parse` 见到 BOM 会直接抛错。对于 settings.json 这类
 * **用户可能会手工编辑**的文件，一次 BOM 就等于整份配置静默失效（所有设置回到默认值，
 * 且没有任何报错提示）—— 这类"看起来只是没生效"的问题极难排查，因此在读入口统一剥掉。
 */
function stripBom(text: string): string {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await readText(filePath, { encoding: 'utf8' })
  return JSON.parse(stripBom(raw)) as T
}

export async function writeJsonAtomic(filePath: string, value: unknown, { space = 2, mode }: JsonWriteOptions = {}): Promise<void> {
  const text = JSON.stringify(value, null, space)
  await writeTextAtomic(filePath, text, { encoding: 'utf8', mode })
}

export function readJsonSync<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(stripBom(raw)) as T
}

export function writeJsonAtomicSync(filePath: string, value: unknown, { space = 2, mode }: JsonWriteOptions = {}): void {
  const text = JSON.stringify(value, null, space)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileAtomic.sync(filePath, text, { encoding: 'utf8', mode })
}

/**
 * 文件端口（FilePort）—— **domain / ui 层唯一允许的磁盘能力入口**。
 *
 * 分层铁律（PART3 §3.5 R3）要求 domain 不得 `require('fs' | 'path')`：
 * 那会让领域逻辑无法脱离 Electron/Node 单测。所以领域服务不 import 任何磁盘能力，
 * 而是接收这个 POJO 端口（依赖注入）。
 *
 * 用法：
 *   // APPS / INFRA 侧：把真实能力装进端口
 *   createXxxService({ dataDir, filePort: createFilePort() })
 *   // domain 侧：只用端口，单测时传 3 个假函数就能顶掉整个磁盘
 *   function createXxxService({ dataDir, filePort }) { filePort.readJsonSync(...) }
 *
 * 刻意做成"函数集合"而不是 class，就是为了让单测替换成本接近于零。
 */
export function createFilePort(): FilePort {
  return {
    // 路径（domain 连 require('path') 都不行，所以拼接也由端口提供）
    join: (...parts: string[]) => path.join(...parts),
    resolve: (...parts: string[]) => path.resolve(...parts),
    dirname: (p: string) => path.dirname(p),
    basename: (p: string) => path.basename(p),
    /** 平台分隔符（'\\' | '/'），供 domain 做纯字符串路径判断 */
    sep: path.sep,

    // 查询
    existsSync: (filePath: string) => fs.existsSync(filePath),
    pathExists,
    ensureDir,
    /** 同步建目录（domain 的下载安全路径等同步路径需要） */
    mkdirSync: (dirPath: string) => { fs.mkdirSync(dirPath, { recursive: true }) },

    // 目录操作（备份保留策略 / 清单枚举等特性模块需要）
    readdirSync: (dirPath: string) => {
      try { return fs.readdirSync(dirPath) } catch (_) { return [] }
    },
    statSync: (filePath: string) => {
      try {
        const st = fs.statSync(filePath)
        return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
      } catch (_) { return null }
    },
    unlinkSync: (filePath: string) => {
      try { fs.unlinkSync(filePath); return true } catch (_) { return false }
    },

    // 读
    readText,
    readTextSync: (filePath: string, { encoding = 'utf8' }: TextReadOptions = {}) => fs.readFileSync(filePath, { encoding }),
    readJson,
    readJsonSync,

    // 写（原子）
    writeTextAtomic,
    writeJsonAtomic,
    writeTextAtomicSync: (filePath: string, text: string, { encoding = 'utf8', mode }: TextWriteOptions = {}) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileAtomic.sync(filePath, text, { encoding, mode })
    },
    writeJsonAtomicSync,

    // 写（直写）。注意：**不要**用原子写替代它 —— Mark-of-the-Web 写的是
    // NTFS ADS 流（"file:Zone.Identifier"），temp+rename 会破坏 ADS 语义。
    writeFileSync: (filePath: string, text: string, { encoding = 'utf-8' }: TextWriteOptions = {}) =>
      fs.writeFileSync(filePath, text, { encoding })
  }
}

export default {
  pathExists,
  ensureDir,
  readText,
  writeTextAtomic,
  readJson,
  writeJsonAtomic,
  readJsonSync,
  writeJsonAtomicSync,
  createFilePort
}
