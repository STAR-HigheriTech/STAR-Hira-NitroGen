/**
 * AI 面板 · 上下文 chip（输入区与已发送消息共用）。
 *
 * 一个 chip 只回答三个问题：**它是什么**（图标）、**叫什么**（标题）、**怎么去掉**。
 * 采集、去重、上限都在 store 里；这里只画。
 */

import { h, icon, clip } from './dom.js'
import { createFaviconImg, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
import type { AiContextItem } from './types.js'

/** kind → 图标名（chip 与上下文摘要条共用同一份，避免两套图标表）。 */
export const KIND_GLYPH: Record<string, string> = Object.freeze({
  page: 'Globe',
  selection: 'MessageSquare',
  screenshot: 'Camera',
  file: 'Folder',
  workspace: 'Folder',
  note: 'MessageSquare',
  bookmark: 'Star',
  history: 'Clock',
  text: 'MessageSquare',
  tab: 'Globe',
  'closed-tab': 'Clock'
})

/** kind → 人话（chip 尾标与顶部摘要条共用同一份，避免两处措辞漂移）。 */
export const KIND_TEXT: Record<string, string> = Object.freeze({
  page: '页面',
  selection: '选区',
  screenshot: '截图',
  file: '文件',
  workspace: '工作区',
  note: '笔记',
  bookmark: '书签',
  history: '历史',
  text: '文本',
  tab: '标签',
  'closed-tab': '已关闭'
})

/** 这些 kind 的 chip 点一下能跳回原页面（选中态 vs 已发送态都一样）。 */
const REVEALABLE = new Set(['page', 'tab', 'closed-tab', 'bookmark', 'history', 'selection'])

/** 从 URL 取个可读的主机名（chip 比整条链接好认）。 */
function hostOf(url: unknown): string {
  try { return new URL(String(url)).hostname.replace(/^www\./, '') } catch (_) { return '' }
}

/**
 * chip 的可读标题（优先级：标题 > 域名 > 正文摘要 > 类型名）。
 * @param {any} item
 */
export function chipLabel(item: AiContextItem): string {
  const payload = item.payload && typeof item.payload === 'object'
    ? item.payload as Record<string, unknown>
    : {}
  if (item.kind === 'screenshot') return item.title || '当前屏幕'
  if (item.kind === 'file') return String(payload.name || item.title || '文件')
  if (item.kind === 'workspace') return String(payload.name || item.title || '工作区')
  if (item.kind === 'selection') {
    return item.title ? `《${clip(item.title, 28)}》选区` : clip(payload.text || '选区内容', 40)
  }
  if (item.kind === 'page') return item.title || hostOf(item.url) || '页面'
  if (item.kind === 'text') return item.title || clip(payload.text || '文本', 40)
  return item.title || item.url || KIND_TEXT[item.kind] || '引用'
}

/** 无图时的类型图标（favicon 加载失败也回落到这里，不留破图占位）。 */
function chipGlyph(doc: Document, item: AiContextItem): HTMLElement {
  const box = h(doc, 'span', 'ai-chip__glyph')
  const glyph = icon(doc, KIND_GLYPH[item.kind] || 'Paperclip', 13)
  if (glyph) box.appendChild(glyph)
  return box
}

/**
 * chip 左侧的视觉锚点：**截图缩略图 > 站点图标 > 类型图标**。
 * 页面 / 书签 / 历史都指向一个站 —— 图标比同类符号更能让人一眼认出"是哪一篇"。
 * 图标规则不在这里推导（`favicon-src` 是唯一真源，代理 / 直连 / 超时降级都在那边）。
 */
function chipLeading(doc: Document, item: AiContextItem): HTMLElement {
  const payload = item.payload && typeof item.payload === 'object'
    ? item.payload as Record<string, unknown>
    : {}

  // 截图：本身就是内容，直接铺满缩略图
  if (item.kind === 'screenshot' && payload.thumb) {
    const shot: HTMLImageElement = /** @type {HTMLImageElement} */ (h(doc, 'img', 'ai-chip__thumb'))
    shot.src = String(payload.thumb)
    shot.alt = ''
    return shot
  }

  const pageUrl = String(item.url || payload.url || '')
  const candidates = faviconSourceCandidates(pageUrl, item.favicon || null)
  if (!candidates.primary) return chipGlyph(doc, item)

  const img = createFaviconImg(doc, candidates, {
    className: 'ai-chip__thumb ai-chip__thumb--icon',
    size: 24,
    // 代理 / 直连都拿不到图标 → 回落到类型图标，不留空白图标位
    onFail: () => {
      const parent = img.parentNode
      if (parent) parent.replaceChild(chipGlyph(doc, item), img)
    }
  })
  img.loading = 'lazy'
  img.style.objectFit = 'contain'
  return img
}

/**
 * 画一个 chip。
 * @param {Document} doc
 * @param {any} item 上下文项（含本地 `key`）
 * @param {((key: string) => void)|null} onRemove 传 null 表示只读（已发送的消息里）
 * @param {((url: string) => void)|null} [onActivate] 点击跳回原页面（可选）
 * @returns {HTMLElement}
 */
export function chipElement(doc: Document, item: AiContextItem, onRemove: ((key: string) => void)|null, onActivate?: ((url: string) => void)|null) : HTMLElement {
  const chip = h(doc, 'span', 'ai-chip')
  chip.title = item.title || item.url || ''

  chip.appendChild(chipLeading(doc, item))

  chip.appendChild(h(doc, 'span', 'ai-chip__label', chipLabel(item)))
  chip.appendChild(h(doc, 'span', 'ai-chip__kind', KIND_TEXT[item.kind] || '引用'))

  if (onRemove && item.key) {
    const key = item.key
    const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-chip__x'))
    btn.type = 'button'
    btn.title = '移除'
    btn.setAttribute('aria-label', '移除引用')
    const x = icon(doc, 'X', 10)
    if (x) btn.appendChild(x)
    else btn.textContent = '×'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onRemove(key)
    })
    chip.appendChild(btn)
  }

  // 引用回跳：只有"确实指向一个页面"的 kind 才可点（截图/文件点了没意义）。
  if (onActivate && item.url && REVEALABLE.has(item.kind)) {
    chip.classList.add('ai-chip--link')
    chip.setAttribute('role', 'button')
    chip.setAttribute('tabindex', '0')
    chip.title = `${chip.title}\n点击跳转到该页面`
    const jump = () => { try { onActivate(String(item.url)) } catch (_) {} }
    chip.addEventListener('click', jump)
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump() }
    })
  }
  return chip
}

/**
 * 画一组 chip。空数组返回 null（调用方据此决定要不要插入容器）。
 * @param {Document} doc
 * @param {any[]} items
 * @param {((key: string) => void)|null} [onRemove]
 * @param {((url: string) => void)|null} [onActivate]
 * @returns {HTMLElement|null}
 */
export function renderChips(doc: Document, items: unknown[], onRemove?: ((key: string) => void)|null, onActivate?: ((url: string) => void)|null) : HTMLElement|null {
  const list = (Array.isArray(items) ? items.filter(Boolean) : []) as AiContextItem[]
  if (!list.length) return null
  const box = h(doc, 'div', 'ai-chips')
  for (const item of list) box.appendChild(chipElement(doc, item, onRemove || null, onActivate || null))
  return box
}
