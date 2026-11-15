/**
 * pwa-hints —— 「这个页面能不能安装成应用」的线索上报（PWA 安装链路的最上游）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 页面把「文档地址 / manifest 地址 / 标题 / 主题色 / favicon」推给主进程一次；
 * 主进程据此决定地址栏要不要亮「安装」图标（见 apps/app-main/src/main/pwa/detect.js）。
 *
 * ── 与 `page-text` 的差别 ─────────────────────────────────────────
 *  · 这里**不需要正文**，只需要 head 里几个标签 → 读数极轻；
 *  · 用**单向 send**（没有回执需求）而不是 invoke：探测是高频、可丢弃的信号，
 *    主进程失败也不该在页面侧留下 Promise 噪音；
 *  · **SPA 必须能反复上报**：title / manifest / 路由变化后要重新判定。
 *
 * ── 性能纪律 ─────────────────────────────────────────────────────
 *  · 只在顶层文档跑（iframe 里的 manifest 属于嵌入内容，装出来是错的）；
 *  · 只在 http(s) 页面跑；
 *  · **首次扫描与 observer 都推到 DOMContentLoaded 之后的空闲帧**：DOMContentLoaded /
 *    load 是页面最忙的时刻，安装图标晚几十毫秒无感，不值得往首屏关键路径上加同步开销；
 *  · manifest 与 favicon 用**同一趟** `link[rel]` 扫描取出（原来各扫一遍）；
 *  · head 变更用 300ms 防抖合并（装扩展、注入脚本会连续改动 head）；
 *  · 同一次内容只发一次（key = 文档地址 + manifest + 标题 + favicon）；
 *  · 所有异常静默 —— 探测绝不能让页面报错。
 */

import { ipcRenderer } from 'electron'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'

/** 单向通道。 */
const CHANNEL = `ngipc:send:${PRELOAD_ROUTES.pwaCandidate}`
/** head 变更合并窗口：足够吸收批量注入，又不至于让按钮迟到一个节拍。 */
const DEBOUNCE_MS = 300
const MAX_URL = 2048
const MAX_TITLE = 300

function isHttpPage(): boolean {
  try {
    return isHttpProtocol(String(window.location.protocol || ''))
  } catch (_) {
    return false
  }
}

/** 相对地址 → 绝对 http(s) 地址；其它协议（data:/blob:/javascript:）一律丢弃。 */
function absoluteHttpUrl(raw: unknown): string | null {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) return null
  try {
    const u = new URL(value, document.baseURI)
    if (!isHttpProtocol(u.protocol)) return null
    const href = u.href
    return href.length > MAX_URL ? null : href
  } catch (_) {
    return null
  }
}

function relTokens(node: Element): string[] {
  try {
    return String(node.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean)
  } catch (_) {
    return []
  }
}

/** rel 分词里是否含图标语义（含 Safari 的 apple-touch-icon 与 shortcut icon）。 */
function isIconRel(tokens: string[]): boolean {
  return tokens.includes('icon') || tokens.includes('apple-touch-icon') ||
    tokens.includes('apple-touch-icon-precomposed') || tokens.includes('shortcut')
}

/** 从 "32x32 192x192" 里取面积最大的边长，用于挑 favicon。 */
function declaredSize(node: Element): number {
  try {
    const raw = String(node.getAttribute('sizes') || '').toLowerCase()
    let best = 0
    for (const token of raw.split(/\s+/)) {
      const m = /^(\d+)x(\d+)$/.exec(token)
      if (!m) continue
      best = Math.max(best, Math.min(Number(m[1]), Number(m[2])))
    }
    if (best) return best
    if (raw.includes('any')) return 1024 // SVG 按最大算
  } catch (_) {}
  return 0
}

/**
 * 一趟 `link[rel]` 扫描同时取 manifest 与 favicon。
 *
 * 原来是两次 `querySelectorAll('link[rel]')`（manifest 一次、favicon 一次）——
 * head 里通常有几十个 link，等于把同一个选择器 + rel 分词做了两遍。合并后语义不变：
 *  · manifest 取**第一个**合法的 http(s) 地址；
 *  · favicon 取**声明尺寸最大**的那张，一张都没有才回落 `/favicon.ico`。
 */
function pickLinks() {
  let manifest = null
  let icon = null
  let iconSize = -1
  try {
    for (const link of document.querySelectorAll('link[rel]')) {
      const tokens = relTokens(link)
      if (!manifest && tokens.includes('manifest')) {
        manifest = absoluteHttpUrl(link.getAttribute('href'))
      }
      if (!isIconRel(tokens)) continue
      const href = absoluteHttpUrl(link.getAttribute('href'))
      if (!href) continue
      const size = declaredSize(link)
      if (size > iconSize) { icon = href; iconSize = size }
    }
  } catch (_) {}
  return { manifestUrl: manifest, faviconUrl: icon || absoluteHttpUrl('/favicon.ico') }
}

function pickThemeColor() {
  try {
    const meta = document.querySelector('meta[name="theme-color"]')
    const value = meta ? String(meta.getAttribute('content') || '').trim() : ''
    return value ? value.slice(0, 64) : null
  } catch (_) {
    return null
  }
}

function collect() {
  const documentUrl = absoluteHttpUrl(window.location.href)
  if (!documentUrl) return null
  let title = ''
  try { title = String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) } catch (_) {}
  const links = pickLinks()
  return {
    documentUrl,
    manifestUrl: links.manifestUrl,
    title,
    themeColor: pickThemeColor(),
    faviconUrl: links.faviconUrl
  }
}

/** 上一次真正发出去的 key（内容不变就不再发）。 */
let lastKey = ''

function report() {
  if (!isHttpPage()) return
  const hints = collect()
  if (!hints) return
  const key = [hints.documentUrl, hints.manifestUrl, hints.title, hints.faviconUrl].join('\n')
  if (key === lastKey) return
  lastKey = key
  try {
    ipcRenderer.send(CHANNEL, hints)
  } catch (_) {}
}

let timer: ReturnType<typeof setTimeout> | null = null
/** 防抖上报：head 连续变更只在安静 300ms 后发一次。 */
function schedule() {
  try { if (timer !== null) clearTimeout(timer) } catch (_) {}
  timer = setTimeout(() => {
    timer = null
    try { report() } catch (_) {}
  }, DEBOUNCE_MS)
}

function scheduleSoon() {
  // 页面生命周期事件（load/pageshow/popstate）不需要防抖：立刻就发，让图标尽早出现。
  try { if (timer !== null) clearTimeout(timer) } catch (_) {}
  timer = null
  try { report() } catch (_) {}
}

/** 首次扫描最迟等这么久（页面一直不空闲时也必须给出结果）。 */
const IDLE_TIMEOUT_MS = 2000

/**
 * 把「首次扫描 / 挂 observer」推到空闲帧。
 *
 * 它们不属于首屏内容：PWA 安装图标晚几十毫秒出现，用户完全无感；
 * 而 DOMContentLoaded / load 都是页面最忙的时刻（解析收尾、首帧、字体与图片解码），
 * 在这里跑 `querySelectorAll('link[rel]')` 等于往关键路径上加一笔不必要的同步开销。
 */
function whenIdle(fn: () => void): void {
  try {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => { try { fn() } catch (_) {} }, { timeout: IDLE_TIMEOUT_MS })
      return
    }
  } catch (_) {}
  setTimeout(() => { try { fn() } catch (_) {} }, 0)
}

function setupObserver() {
  try {
    const head = document.head || document.documentElement
    if (!head) return
    const observer = new MutationObserver(() => schedule())
    observer.observe(head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['rel', 'href', 'content', 'name', 'sizes']
    })
  } catch (_) {}
}

try {
  // 只在顶层文档：iframe 里的 manifest 不属于当前标签的安装目标。
  if (window.top === window) {
    /** DOM 就绪后执行（preload 通常跑在 document_start，那时还拿不到 head）。 */
    const afterDomReady = (fn: () => void): void => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn, { once: true })
      } else {
        fn()
      }
    }
    // 首次探测与 observer 一起等到 DOM 就绪后的**空闲帧**：
    //  · 解析期的每一次 head 插入都不会再叫醒 observer（否则整段解析都在空转防抖）；
    //  · 两趟全量 link 扫描（现已合并成一趟）也不再压在 DOMContentLoaded 上。
    afterDomReady(() => whenIdle(() => { scheduleSoon(); setupObserver() }))
    window.addEventListener('load', () => whenIdle(scheduleSoon), { once: true })
    window.addEventListener('pageshow', scheduleSoon)
    window.addEventListener('popstate', schedule)
    window.addEventListener('hashchange', schedule)
  }
} catch (_) {}
