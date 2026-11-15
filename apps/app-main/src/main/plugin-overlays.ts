// @ts-check
/**
 * 插件浮层宿主（Plugin Overlay Host）—— PART18「开放世界」里浮层的**主进程唯一实现处**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么浮层内容是一个 URL，而不是描述符里带 render 函数
 * ══════════════════════════════════════════════════════════════════════
 * 外部插件跑在独立进程里，函数过不了 IPC；而"浮层里放什么"本来就该是插件自己的
 * 内部页（`contributes.pages`）。于是浮层在数据上只有一件事：**在某个窗口上开一个
 * iframe 容器，指向某个 URL**。渲染侧只负责画容器（拖动 / 关闭 / 锚点），
 * 内容与样式全部归插件 —— 与面板 / 内部页同一条哲学。
 *
 * 三种打开方式共用这一处：
 *   · 声明式：`contributes.overlays` → `overlay.slot`（渲染侧列出来）
 *   · 命令式：`ctx.browser.ui.overlay.show(...)` / `.hide(id)`
 *   · 动作：菜单 / 命令的 `action.type === 'overlay'`（走 runAction）
 *
 * 记录按**窗口**分桶：同一个浮层在两个窗口里是两份状态（关掉一个不该顺手关掉另一个）。
 */

import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { PluginOverlayRecord } from '@hira-ng/shared-types/src/plugin-overlay.mjs'

interface PluginOverlayDescriptor {
  id?: unknown
  title?: unknown
  label?: unknown
  page?: unknown
  url?: unknown
  anchor?: unknown
  width?: unknown
  height?: unknown
  modal?: unknown
  windowId?: unknown
}

export type { PluginOverlayRecord } from '@hira-ng/shared-types/src/plugin-overlay.mjs'

interface PluginOverlayHubPort { emit(name: string, payload?: unknown): unknown }

export interface PluginOverlayHostOptions {
  emit?(route: string, payload: unknown, options?: { windowId?: number }): unknown
  pageUrl?(ref: string, pluginId: string): string
  hub?: PluginOverlayHubPort | null
  getWindowId?(): number
  isWindowAlive?(windowId: number): boolean
  logger?: { warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

export interface PluginOverlayHost {
  show(descriptor: unknown, pluginId: unknown): { ok: boolean; key?: string; url?: string; reason?: string }
  hide(id: unknown, pluginId?: unknown): boolean
  closeFromRenderer(key: unknown, windowId: unknown): boolean
  disposePlugin(pluginId: unknown): number
  disposeWindow(windowId: unknown): number
  list(windowId: unknown): PluginOverlayRecord[]
  listAll(): Array<PluginOverlayRecord & { windowId: number }>
}

/**
 * 浮层内容只认「能被安全加载的地址」。
 *
 * 浮层在渲染侧是一个 `iframe.src`（见 renderer/plugin-overlay/main.js），
 * 描述符里的 `url` 又是插件 / AI 工具直接给的字符串 —— 不校验协议就等于
 * 允许 `javascript:` / `data:` / `file:` 进 iframe。这里在**唯一落库处**拦掉，
 * 渲染侧不必再写第二份判据。
 */
const FORBIDDEN_OVERLAY_SCHEME = /^(?:javascript|data|blob|vbscript|file|filesystem|about):/i
const MAX_OVERLAYS_PER_WINDOW = 64

function overlayDimension(value: unknown, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : 0
}

function safeOverlayUrl(raw: unknown): string {
  // 去掉控制字符：`java\tscript:` 这类绕过协议匹配的写法先归一化。
  const text = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!text || text.length > 4096) return ''
  if (FORBIDDEN_OVERLAY_SCHEME.test(text)) return ''
  return text
}

/** 浮层 key 的插件前缀分隔符（与贡献注册表的命名空间同一套直觉）。 */
export function overlayKey(pluginId: unknown, id: unknown): string {
  const pid = String(pluginId || '').trim()
  const oid = String(id || '').trim().slice(0, 128) || 'overlay'
  return `${pid}:${oid}`
}

/**
 * @param {{
 *   emit?: (route: string, payload: unknown, opts?: object) => unknown,
 *   pageUrl?: (ref: string, pluginId: string) => string,
 *   hub?: { emit: (name: string, payload?: unknown) => unknown } | null,
 *   getWindowId?: () => number,
 *   logger?: { warn?: Function, error?: Function }
 * }} [options]
 */
export function createPluginOverlayHost(options: PluginOverlayHostOptions = {}): PluginOverlayHost {
  const emit: NonNullable<PluginOverlayHostOptions['emit']> = typeof options.emit === 'function' ? options.emit : () => 0
  const pageUrl = typeof options.pageUrl === 'function' ? options.pageUrl : () => ''
  const hub = options.hub || null
  const getWindowId = typeof options.getWindowId === 'function' ? options.getWindowId : () => 0
  const isWindowAlive = typeof options.isWindowAlive === 'function' ? options.isWindowAlive : () => true
  const logger = options.logger || console

  /** windowId → Map<key, record>。windowId=0 表示"当前窗口"（未解析到窗口时降级）。 */
  const buckets = new Map<number, Map<string, PluginOverlayRecord>>()

  function bucketOf(windowId: unknown): Map<string, PluginOverlayRecord> {
    const id = Number(windowId) || 0
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = new Map()
      buckets.set(id, bucket)
    }
    return bucket
  }

  function notifyHub(name: string, payload: unknown): void {
    if (!hub || typeof hub.emit !== 'function') return
    try {
      hub.emit(name, payload)
    } catch (_) {}
  }

  /**
   * 展示一个浮层。
   * @param {unknown} descriptor `{ id?, title?, page?, url?, anchor?, width?, height?, modal?, windowId? }`
   * @param {string} pluginId
   * @returns {{ ok: boolean, key?: string, url?: string, reason?: string }}
   */
  function show(descriptor: unknown, pluginId: unknown): { ok: boolean; key?: string; url?: string; reason?: string } {
    const d = descriptor && typeof descriptor === 'object' ? descriptor as PluginOverlayDescriptor : {}
    const pid = String(pluginId || '').trim()
    if (!pid) return { ok: false, reason: '缺少 pluginId' }
    // URL 两种写法：`url` 直接给绝对地址；`page` 指向本插件（或 `pluginId:pageId`）的内部页。
    let url = safeOverlayUrl(d.url)
    if (!url && d.page) {
      try {
        url = safeOverlayUrl(pageUrl(String(d.page), pid))
      } catch (_) {
        url = ''
      }
    }
    if (!url) return { ok: false, reason: '浮层缺少可加载的内容（不允许 javascript: / data: / file: 等地址）' }

    const overlayId = String(d.id || 'overlay').trim().slice(0, 128) || 'overlay'
    const key = overlayKey(pid, overlayId)
    const requestedWindowId = Number(d.windowId) || 0
    const fallbackWindowId = Number(getWindowId()) || 0
    const windowId = requestedWindowId > 0 && isWindowAlive(requestedWindowId)
      ? requestedWindowId
      : fallbackWindowId
    const bucket = bucketOf(windowId)
    if (!bucket.has(key) && bucket.size >= MAX_OVERLAYS_PER_WINDOW) {
      return { ok: false, reason: `浮层数量已达上限（${MAX_OVERLAYS_PER_WINDOW}）` }
    }
    const record: PluginOverlayRecord = {
      key,
      pluginId: pid,
      id: overlayId,
      title: String(d.title || d.label || '').trim().slice(0, 512),
      url,
      anchor: String(d.anchor || 'center').trim().slice(0, 64) || 'center',
      // 0 = 让渲染侧用默认尺寸（与 `overlay.slot` 描述符同口径）
      width: overlayDimension(d.width, 3840),
      height: overlayDimension(d.height, 2160),
      modal: d.modal === true
    }
    bucket.set(key, record)
    emit(IPC_EVENTS.pluginOverlayShow, record, windowId ? { windowId } : undefined)
    notifyHub('overlay:shown', record)
    return { ok: true, key, url }
  }

  /**
   * 关掉一个浮层。`id` 可以是完整 key（`pluginId:id`）或裸 id。
   * @param {string} id
   * @param {string} [pluginId] 给了插件时只在该插件的记录里找（越权保护）
   * @returns {boolean}
   */
  function hide(id: unknown, pluginId?: unknown): boolean {
    const wanted = String(id || '').trim()
    if (!wanted) return false
    const pid = String(pluginId || '').trim()
    const key = pid && !wanted.startsWith(`${pid}:`) ? overlayKey(pid, wanted) : wanted
    let hit = false
    for (const [windowId, bucket] of buckets.entries()) {
      if (!bucket.has(key)) continue
      bucket.delete(key)
      if (bucket.size === 0) buckets.delete(windowId)
      hit = true
      emit(IPC_EVENTS.pluginOverlayHide, { key }, windowId ? { windowId } : undefined)
    }
    if (hit) notifyHub('overlay:hidden', { key })
    return hit
  }

  /** 渲染侧回报"用户点了关闭"：与 hide 同一条落点，但事件名区分来源。 */
  function closeFromRenderer(key: unknown, windowId: unknown): boolean {
    const wanted = String(key || '').trim()
    if (!wanted) return false
    const id = Number(windowId) || 0
    // 先找发送方窗口的桶；找不到再退回 0 号桶 —— show 时若没解析到窗口会落在 0，
    // 而关闭请求一定带着真实 windowId，不兜底就会"点了 × 但浮层关不掉"。
    const bucketKey = buckets.has(id) ? id : 0
    const bucket = buckets.get(bucketKey)
    const record = bucket ? bucket.get(wanted) : null
    if (bucket) {
      bucket.delete(wanted)
      if (bucket.size === 0) buckets.delete(bucketKey)
    }
    emit(IPC_EVENTS.pluginOverlayHide, { key: wanted }, id ? { windowId: id } : undefined)
    notifyHub('overlay:closed', record || { key: wanted })
    return true
  }

  /** 插件被禁用 / 卸载时清空它的全部浮层（否则会留下指向已卸载页面的空壳）。 */
  function disposePlugin(pluginId: unknown): number {
    const pid = String(pluginId || '').trim()
    if (!pid) return 0
    let count = 0
    for (const [windowId, bucket] of buckets.entries()) {
      for (const key of Array.from(bucket.keys())) {
        if (!key.startsWith(`${pid}:`)) continue
        bucket.delete(key)
        count += 1
        emit(IPC_EVENTS.pluginOverlayHide, { key }, windowId ? { windowId } : undefined)
      }
      if (bucket.size === 0) buckets.delete(windowId)
    }
    return count
  }

  /** 窗口销毁时释放该窗口的全部浮层记录（不再向已销毁窗口广播）。 */
  function disposeWindow(windowId: unknown): number {
    const id = Number(windowId) || 0
    const bucket = buckets.get(id)
    if (!bucket) return 0
    const count = bucket.size
    buckets.delete(id)
    return count
  }

  /** 某窗口当前开着的浮层（诊断 / 未来的"恢复上次浮层"用）。 */
  function list(windowId: unknown): PluginOverlayRecord[] {
    const bucket = buckets.get(Number(windowId) || 0)
    return bucket ? Array.from(bucket.values()) : []
  }

  /** 全部窗口的浮层（带 windowId）—— 诊断 / AI 工具需要「现在都开着什么」的全局视图。 */
  function listAll(): Array<PluginOverlayRecord & { windowId: number }> {
    const out: Array<PluginOverlayRecord & { windowId: number }> = []
    for (const [windowId, bucket] of buckets.entries()) {
      for (const record of bucket.values()) out.push({ ...record, windowId })
    }
    return out
  }

  return { show, hide, closeFromRenderer, disposePlugin, disposeWindow, list, listAll }
}

