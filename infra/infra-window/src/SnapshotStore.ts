/**
 * SnapshotStore —— 标签截图内存仓库（对齐 RT flow-internal/tab-snapshot 的 store 部分）。
 *
 * 为什么需要它：标签 hover 预览要展示「该标签上次可见时的画面」，而标签的
 * WebContentsView 在切走后仍存活（甚至可能被休眠销毁），渲染层拿不到位图。
 * 因此主进程在「标签即将隐藏/休眠」的瞬间用 capturePage 抓一帧，编码成 JPEG
 * 暂存于此，渲染层再经 hira://tab-snapshot?id=… 读回。
 *
 * **彻底解耦**：本模块不 import electron，不碰任何 web/electron 全局，也不做
 * 采集（capturePage）与编码（toJPEG）—— 那些属于「采集方」的职责。
 * 它只负责三件事：
 *   1. 按**不透明 id** 暂存 (Buffer, contentType)（id 每次采集都新，天然防缓存）
 *   2. 按 key（如 tabId）反查当前 id，同一 key 重复 put 自动替换旧的
 *   3. TTL + 条数上限双约束的淘汰（getter 懒淘汰 + 后台 sweep），
 *      长时间运行内存不增长（对齐「极致低内存」目标）
 *
 * 后台 sweep 定时器是**按需**的：有帧才开表、空了立刻停（首个 put 自启、最后一个
 * drop 自停）。所以「没人悬停标签预览」的整个会话里，它是 0 定时器、0 CPU 的。
 *
 * 全部外部交互（时钟 / id 生成 / 定时器）可注入 → 可单测、可替换实现。
 */

import { randomUUID } from 'node:crypto'

interface SnapshotRecord {
  buffer: Buffer
  contentType: string
  at: number
  key: string
}

interface SnapshotStoreOptions {
  ttlMs?: number
  maxEntries?: number
  sweepMs?: number
  now?: () => number
  generateId?: () => string
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void
}

export interface SnapshotStore {
  put(key: string, buffer: Buffer, contentType?: string): string | null
  get(id: string): SnapshotRecord | null
  getId(key: string): string | null
  remove(id: string): void
  removeByKey(key: string): void
  clear(): void
  sweep(): void
  start(): boolean
  stop(): void
  readonly size: number
  readonly running: boolean
}

/** 存活时长：镜像 RT（30s）。实际消费方可按其寿命（hover 预览）注入更长的值。 */
const DEFAULT_TTL_MS = 30_000
/** 条数上限：超出即淘汰最旧，避免后台 sweep 间隔内无限堆积。 */
const DEFAULT_MAX_ENTRIES = 64
/** 后台淘汰扫描间隔（镜像 RT 的 5s）。 */
const DEFAULT_SWEEP_MS = 5_000
/** 缺省内容类型，仅当 put 未显式指定时使用。 */
const DEFAULT_CONTENT_TYPE = 'image/jpeg'

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs=30000]
 * @param {number} [options.maxEntries=64]
 * @param {number} [options.sweepMs=5000]
 * @param {() => number} [options.now] 注入时钟（默认 Date.now）
 * @param {() => string} [options.generateId] 注入 id 生成（默认 randomUUID）
 * @param {(fn:Function, ms:number) => any} [options.setTimer] 注入定时器（默认 setInterval）
 * @param {(t:any) => void} [options.clearTimer] 注入清定时器（默认 clearInterval）
 */
export function createSnapshotStore(options: SnapshotStoreOptions = {}): SnapshotStore {
  const ttlOption = Number(options.ttlMs)
  const maxEntriesOption = Number(options.maxEntries)
  const sweepOption = Number(options.sweepMs)
  const ttlMs = Number.isFinite(ttlOption) && ttlOption > 0 ? ttlOption : DEFAULT_TTL_MS
  const maxEntries =
    Number.isFinite(maxEntriesOption) && maxEntriesOption > 0
      ? Math.floor(maxEntriesOption)
      : DEFAULT_MAX_ENTRIES
  const sweepMs = Number.isFinite(sweepOption) && sweepOption > 0 ? sweepOption : DEFAULT_SWEEP_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const generateId = typeof options.generateId === 'function' ? options.generateId : randomUUID
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setInterval
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearInterval

  /** id → { buffer:Buffer, contentType:string, at:number, key:string } */
  const byId = new Map<string, SnapshotRecord>()
  /** key → id（当前有效） */
  const keyIndex = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | null = null

  function drop(id: string): void {
    const rec = byId.get(id)
    if (!rec) return
    byId.delete(id)
    if (keyIndex.get(rec.key) === id) keyIndex.delete(rec.key)
    // 空了就停表：下次 put 会自动重启（见 put 里的注释）。
    if (byId.size === 0) stop()
  }

  function isExpired(rec: SnapshotRecord): boolean {
    return now() - rec.at > ttlMs
  }

  /** 淘汰：先过期，再按时间最旧超额部分（容量兜底）。 */
  function sweep(): void {
    for (const [id, rec] of byId) {
      if (isExpired(rec)) drop(id)
    }
    const overflow = byId.size - maxEntries
    if (overflow > 0) {
      const oldest = Array.from(byId.entries()).sort((a, b) => a[1].at - b[1].at)
      for (let i = 0; i < overflow; i++) drop(oldest[i][0])
    }
    // 兜底停表：`clear()` 这类不经 drop 的清空路径也在这一拍后停下来（见 drop 的说明）。
    if (byId.size === 0) stop()
  }

  /**
   * 存入一帧。同 key 的旧帧会被替换（一个标签只保留最新一帧）。
   * @param {string} key 逻辑键（如 tabId）
   * @param {Buffer} buffer JPEG/PNG 字节
   * @param {string} [contentType='image/jpeg']
   * @returns {string|null} 不透明 id；buffer 为空时返回 null
   */
  function put(key: string, buffer: Buffer, contentType: string = DEFAULT_CONTENT_TYPE): string | null {
    if (!buffer || !buffer.length) return null
    const k = String(key)
    const prev = keyIndex.get(k)
    if (prev) drop(prev)
    const id = String(generateId())
    byId.set(id, { buffer, contentType, at: now(), key: k })
    keyIndex.set(k, id)
    // **按需开表**：本模块是「常驻但极少用到」的典型 —— 用户不悬停标签就永远不会
    // 有帧入库，此时不该有一条 5s 定时器一辈子空转。首次入库自启，空了自停（见 drop）。
    if (timer === null) start()
    if (byId.size > maxEntries) sweep()
    return id
  }

  /**
   * 按 id 读取（懒淘汰：命中过期即删除并返回 null）。
   * @param {string} id
   * @returns {{buffer:Buffer, contentType:string, at:number, key:string}|null}
   */
  function get(id: string): SnapshotRecord | null {
    const rec = byId.get(String(id))
    if (!rec) return null
    if (isExpired(rec)) {
      drop(String(id))
      return null
    }
    return rec
  }

  /**
   * 按 key 反查当前 id（懒淘汰）。
   * @param {string} key
   * @returns {string|null}
   */
  function getId(key: string): string | null {
    const id = keyIndex.get(String(key))
    if (!id) return null
    const rec = byId.get(id)
    if (!rec) {
      keyIndex.delete(String(key))
      return null
    }
    if (isExpired(rec)) {
      drop(id)
      return null
    }
    return id
  }

  /** @param {string} id */
  function remove(id: string): void {
    drop(String(id))
  }

  /** @param {string} key */
  function removeByKey(key: string): void {
    const id = keyIndex.get(String(key))
    if (id) drop(id)
    else keyIndex.delete(String(key))
  }

  function clear(): void {
    byId.clear()
    keyIndex.clear()
    stop()
  }

  function start(): boolean {
    if (timer !== null) return false
    timer = setTimer(sweep, sweepMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return true
  }

  function stop(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    put,
    get,
    getId,
    remove,
    removeByKey,
    clear,
    sweep,
    start,
    stop,
    get size() {
      return byId.size
    },
    get running() {
      return timer !== null
    }
  }
}

export { DEFAULT_TTL_MS as SNAPSHOT_TTL_MS, DEFAULT_MAX_ENTRIES as SNAPSHOT_MAX_ENTRIES, DEFAULT_SWEEP_MS as SNAPSHOT_SWEEP_MS }
