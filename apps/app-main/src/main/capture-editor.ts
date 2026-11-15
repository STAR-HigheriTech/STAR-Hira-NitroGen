// @ts-check
/**
 * capture-editor —— 截图标注的**主进程暂存 / 交付**。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────
 * 三种截图（可见区域 / 整页 / 选区）都只发生一次「取图」，但标注编辑器是**独立窗口**：
 * 图片必须跨越一次进程边界。走「窗口 URL 里塞 base64」会把整页图撑成几 MB 的地址
 * （Windows 对命令行长度有限制，且 URL 会进 DevTools 历史），因此这里做一层**带 TTL 的
 * 内存暂存**：取图方 `stage()` 拿一个 id，编辑器窗口挂载后 `take(id)` 一次取走。
 *
 * ── 为什么 take 是「取走」而不是「读取」─────────────────────────────
 * 编辑器只需要底图一次（之后的复制 / 保存都由画布重新编码）。取走即释放，
 * 无需再设计一条「窗口关闭时释放」的生命周期协议 —— 窗口崩溃 / 刷新也不会泄漏。
 * 打开失败会主动丢弃；TTL 扫描只在有暂存数据时运行，空表不占定时器。
 *
 * ── 分层 ──────────────────────────────────────────────────────────
 * 本模块只依赖 Electron 能力（clipboard / nativeImage / dialog）与 Node fs，
 * 不认识窗口、不认识 IPC 路由。IPC 转发在 `ipc/capture.ts`，开窗在浏览器窗口运行时。
 */

const { randomUUID } = require('crypto')
const fs = require('fs')
const { clipboard, nativeImage, dialog } = require('electron')
import type { BrowserWindow } from 'electron'

/** 暂存条目的存活时间：超过即视为没人来取（窗口没开起来 / 渲染层崩了）。 */
const CAPTURE_TTL_MS = 10 * 60 * 1000
/** 同时最多暂存几张：截图是模态交互，正常只会有一两张；上限只防异常堆积。 */
const CAPTURE_MAX_ENTRIES = 8
/** 有暂存数据时才运行的过期扫描间隔。 */
const CAPTURE_SWEEP_MS = 60 * 1000
/** 主进程截图暂存总预算（整页截图可能是大 PNG）。 */
const CAPTURE_MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** @type {Map<string, { bytes: Buffer, createdAt: number, meta: object }>} */
const entries: Map<string, { bytes: Buffer, createdAt: number, meta: object }> = new Map<string, { bytes: Buffer; createdAt: number; meta: Record<string, unknown> }>()
let sweepTimer: ReturnType<typeof setInterval> | null = null
let totalBytes = 0

function removeEntry(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  entries.delete(id)
  totalBytes = Math.max(0, totalBytes - entry.bytes.length)
  return true
}

function stopSweep(): void {
  if (!sweepTimer) return
  clearInterval(sweepTimer)
  sweepTimer = null
}

function startSweep(): void {
  if (sweepTimer || entries.size === 0) return
  sweepTimer = setInterval(sweep, CAPTURE_SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

function sweep(now = Date.now()) {
  for (const [id, entry] of entries) {
    if (now - entry.createdAt > CAPTURE_TTL_MS) removeEntry(id)
  }
  if (entries.size === 0) stopSweep()
}

/**
 * 把一张 PNG 暂存起来，返回编辑器窗口要携带的 id。
 * @param {Buffer|Uint8Array} buffer PNG 字节
 * @param {object} [meta] 诊断信息（模式 / 来源标题），不参与渲染
 * @returns {string|null}
 */
function stageCapture(buffer: Uint8Array | null | undefined, meta: Record<string, unknown> = {}): string | null {
  if (!buffer || !buffer.length) return null
  if (buffer.length > CAPTURE_MAX_TOTAL_BYTES) return null
  const now = Date.now()
  sweep(now)
  // 双上限：条数与总字节；Map 的插入顺序即时间顺序，删最旧的一条。
  while (entries.size >= CAPTURE_MAX_ENTRIES || totalBytes + buffer.length > CAPTURE_MAX_TOTAL_BYTES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    removeEntry(oldest)
  }
  const id = randomUUID()
  entries.set(id, { bytes: Buffer.from(buffer), createdAt: now, meta: meta || {} })
  totalBytes += buffer.length
  startSweep()
  return id
}

/**
 * 取走一张暂存截图（取走即释放）。
 * @param {string} id
 * @returns {{ bytes: Uint8Array }|null}
 */
function takeCapture(id: string): { bytes: Uint8Array } | null {
  const key = String(id || '')
  const entry = entries.get(key)
  if (!entry) return null
  removeEntry(key)
  if (entries.size === 0) stopSweep()
  // 显式转成 Uint8Array：Electron 的结构化克隆对 Buffer 会还原成 Uint8Array，
  // 这里先统一，渲染层拿到的类型就是确定的。
  return { bytes: new Uint8Array(entry.bytes) }
}

/** 打开编辑器失败时主动丢弃底图，不必等 TTL。 */
function discardCapture(id: string): boolean {
  const key = String(id || '')
  if (!key) return false
  const removed = removeEntry(key)
  if (entries.size === 0) stopSweep()
  return removed
}

/**
 * 把调用方给的二进制归一成 Buffer。
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function toBuffer(value: unknown): Buffer | null {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    const data = (value as { data: unknown[] }).data
    if (data.every((entry) => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255)) {
      return Buffer.from(data.map(Number))
    }
  }
  return null
}

/**
 * 写系统剪贴板（PNG）。
 * @param {unknown} value
 * @returns {boolean}
 */
function copyPngToClipboard(value: unknown): boolean {
  const buffer = toBuffer(value)
  if (!buffer || !buffer.length) return false
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return false
    clipboard.writeImage(image)
    return true
  } catch (error) {
    console.error('[capture-editor] 写剪贴板失败:', error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * 弹「另存为」并把 PNG 落盘。
 * @param {Electron.BrowserWindow|null|undefined} ownerWindow 宿主的父窗口（对话框锚点）
 * @param {unknown} value PNG 字节
 * @param {string} [suggestedName]
 * @returns {Promise<{ ok: boolean, canceled?: boolean, filePath?: string, reason?: string }>}
 */
async function savePngToFile(ownerWindow: BrowserWindow | null | undefined, value: unknown, suggestedName?: string): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; reason?: string }> {
  const buffer = toBuffer(value)
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty-image' }
  try {
    const result = await dialog.showSaveDialog(ownerWindow || undefined, {
      defaultPath: suggestedName || '截图.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (!result || result.canceled || !result.filePath) return { ok: false, canceled: true }
    await fs.promises.writeFile(result.filePath, buffer)
    return { ok: true, filePath: result.filePath }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'save-failed' }
  }
}

module.exports = {
  CAPTURE_TTL_MS,
  CAPTURE_MAX_ENTRIES,
  CAPTURE_MAX_TOTAL_BYTES,
  stageCapture,
  takeCapture,
  discardCapture,
  copyPngToClipboard,
  savePngToFile
}
