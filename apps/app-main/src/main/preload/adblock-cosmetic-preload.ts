/**
 * adblock-cosmetic-preload —— 广告拦截的「页面侧」极小 preload。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有自己的一份（而不是用 @ghostery/adblocker-electron-preload）
 * ══════════════════════════════════════════════════════════════════
 * `session.registerPreloadScript({ type: 'frame' })` 是**每个 frame（含 iframe）的固定税**：
 * 注册了就必然被 V8 解析 / 执行，与这一帧到底有没有 DOM 可扫毫无关系。
 * 上游那份 9,141 B 的 preload 在关键路径上做了三件我们不想要的事：
 *
 *   1. `DOMContentLoaded` 时刻**同步**跑一次全文档
 *      `querySelectorAll('[id]…,[class]…,[href]…')`，再逐个建 ids/classes/hrefs 集合。
 *      这正是页面首屏最忙的时刻（页面自己的 DOMContentLoaded 回调、布局、首帧都在排队），
 *      大页面（几万个节点）几十毫秒的同步扫描直接表现为「加载完成那一下卡住」。
 *   2. 扫描完发两条 IPC：先 `{type:'elements'}`（主进程只拿它当 DOM 规则输入，
 *      实际不带任何 features，等于空转一次往返），再 `{type:'features'}`。
 *   3. 再 invoke 一次 `is-mutation-observer-enabled` 问「要不要挂 MutationObserver」——
 *      而本项目的引擎固定是 `enableMutationObserver:false`（见 infra-extensions 的
 *      buildEngineFromNetwork），这一问的答案永远是否，纯属白跑一趟。
 *
 * 本文件的做法：
 *   · **初始规则照旧在 document-start 就发**（无 DOM 依赖的 base + hostname + injection
 *     规则，主进程 `insertCSS` 尽早生效，广告不至于先闪一下再消失）；
 *   · DOM 规则扫描推迟到**首次空闲回调**（`requestIdleCallback`，带 1.2s 兜底超时），
 *     不再和首屏抢主线程；只发一条 IPC，且没有任何 features 时干脆不发；
 *   · 不挂 MutationObserver（与引擎配置一致），因此不查、不等、不留常驻监听。
 *
 * 契约与上游完全一致（主进程侧一行都不用改）：
 *   ipcRenderer.invoke('@ghostery/adblocker/inject-cosmetic-filters', url[, msg])
 *   msg 缺省 = 首轮（拿 base/hostname/injection 规则）；
 *   msg = { type:'features', classes, hrefs, ids } = 补扫（拿 DOM 规则）。
 *
 * 只在顶层文档执行（iframe 里再扫一遍没有意义，规则是按文档注入的）。
 */

import { ipcRenderer } from 'electron'

interface CosmeticFeaturesMessage {
  type: 'features'
  ids: string[]
  classes: string[]
  hrefs: string[]
}

const CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters'
/** 上游 `extractFeaturesFromDOM` 的同款忽略表：这些标签上的 id/class/href 不参与匹配。 */
const IGNORED_TAGS = new Set<string>(['br', 'head', 'link', 'meta', 'script', 'style', 's'])
/** 空闲回退：页面一直忙时最长等这么久再把补扫做掉。 */
const SCAN_IDLE_TIMEOUT = 1200
/** 兜底定时器（没有 requestIdleCallback 的极端环境）。 */
const SCAN_FALLBACK_DELAY = 250
const MAX_SCAN_ELEMENTS = 12_000
const MAX_FEATURES = 3_000
const MAX_FEATURE_CHARS = 512
/** 单次空闲切片预算：DOM 补扫是增强能力，永远不能占满一帧。 */
const SCAN_SLICE_BUDGET_MS = 3

function addFeature(set: Set<string>, raw: string | null): void {
  if (raw === null || !raw || raw.length > MAX_FEATURE_CHARS || set.size >= MAX_FEATURES) return
  set.add(raw)
}

function isTopFrame(): boolean {
  try {
    return window === window.top
  } catch (_) {
    // 跨源访问 top 抛错 = 自己就在子框架里
    return false
  }
}

if (isTopFrame() && String(window.location.href).indexOf('devtools://') !== 0) {
  const url = String(window.location.href)

  /**
   * 发一次注入请求。失败只吞掉（主进程还没注册 handler / 页面正在销毁）——
   * 拦截是增强能力，任何异常都不该污染页面。
   * @param {any} [msg] 缺省 = 首轮
   */
  function inject(msg?: CosmeticFeaturesMessage): void {
    try {
      const pending: Promise<unknown> = msg === undefined
        ? ipcRenderer.invoke(CHANNEL, url)
        : ipcRenderer.invoke(CHANNEL, url, msg)
      pending.catch(() => {})
    } catch (_) { /* 通道不可用：忽略 */ }
  }

  // 首轮：不依赖 DOM，越早越好（主进程据此 insertCSS，避免广告先渲染再消失）。
  inject()

  let scanStarted = false
  /** 一次性 DOM 补扫：把当前文档里出现过的 id / class / href 交给主进程算 DOM 规则。 */
  function scanDom(): void {
    if (scanStarted) return
    scanStarted = true
    const root = document.documentElement
    if (!root || typeof root.querySelectorAll !== 'function') return

    const ids = new Set<string>()
    const classes = new Set<string>()
    const hrefs = new Set<string>()
    // 一条选择器拿全三类（上游是同样的三合一写法）：
    // `[id],[class],[href]` 命中所有可能贡献 features 的元素。
    const nodes = root.querySelectorAll('[id],[class],[href]')
    const limit = Math.min(nodes.length, MAX_SCAN_ELEMENTS)
    let cursor = 0
    const featureCount = (): number => ids.size + classes.size + hrefs.size

    const finish = (): void => {
      // 一个 feature 都没有 = 主进程那边算出空集合，这一趟往返可以彻底省掉。
      if (featureCount() === 0) return
      inject({
        type: 'features',
        ids: Array.from(ids),
        classes: Array.from(classes),
        hrefs: Array.from(hrefs)
      })
    }

    const step = (): void => {
      const startedAt = performance.now()
      while (cursor < limit) {
        if (performance.now() - startedAt >= SCAN_SLICE_BUDGET_MS) break
        const el = nodes[cursor++]
        if (!el) continue
        if (IGNORED_TAGS.has(el.nodeName.toLowerCase())) continue
        addFeature(ids, el.getAttribute('id'))
        addFeature(hrefs, el.getAttribute('href'))
        const classList = el.classList
        for (let j = 0; j < classList.length; j++) {
          addFeature(classes, classList[j] || null)
        }
        if (featureCount() >= MAX_FEATURES) break
      }
      if (cursor >= limit || featureCount() >= MAX_FEATURES) {
        finish()
        return
      }
      scheduleSlice(step)
    }

    step()
  }

  function scheduleSlice(callback: () => void): void {
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => callback(), { timeout: 1000 })
        return
      }
    } catch (_) {}
    setTimeout(callback, 0)
  }

  /** 把补扫排到空闲时段；页面已解析完就别再等 DOMContentLoaded。 */
  function scheduleScan(): void {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(scanDom, { timeout: SCAN_IDLE_TIMEOUT })
      return
    }
    setTimeout(scanDom, SCAN_FALLBACK_DELAY)
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', scheduleScan, { once: true, passive: true })
  } else {
    scheduleScan()
  }
}
