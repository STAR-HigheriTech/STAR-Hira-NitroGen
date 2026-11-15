/**
 * page-text —— 「页面正文抽取 → 上报主进程」（E3 正文全文检索的上游那一半）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 页面加载稳定后，从 DOM 里挑出**正文区域**，抽成一段纯文本，经桥上报给主进程；
 * 主进程存进 SQLite 的 `page_texts`（+ FTS5），于是"我记得那篇文章讲过 X"可以按
 * **页面上出现过的话**搜历史，而不只是标题与网址。
 *
 * ── 性能纪律（与密码 / 地址引擎同一条）────────────────────────────
 *   · **只在顶层文档跑**（iframe 里抽出来的多半是广告/嵌入件，且会重复上报）；
 *   · **只在 `load` 之后的空闲回调里跑一次**（`requestIdleCallback`；读数会触发布局，
 *     不能塞在首屏关键路径上）；
 *   · **只抽"一个容器"**：按候选选择器打分取最佳块，而不是遍历整棵 DOM 找文本；
 *   · **有上限**：正文截到 `MAX_TEXT`，低于 `MIN_TEXT` 直接放弃（导航页/空页不占索引）。
 *   · **同一 URL 只报一次**（同一文档内去重；SPA 的 hash 变化不重抽）。
 *
 * ── 为什么不用 executeJavaScript ──────────────────────────────────
 * 阅读模式（reader-mode-script.js）是「当场渲染」：主进程注入一段固定脚本，由页面
 * 自己抽正文、盖覆盖层 —— 它要的是 DOM，不是纯文本。这里做成 **preload 引擎**
 * （与自动填充同一形态）：代码随 tab.js 内联，页面自己决定何时抽、抽完推一次，主进程
 * 只收结果。两条路解决的问题不同（阅读模式是"当场渲染"，E3 是"静默入索引"）。
 */

import { ipcRenderer } from 'electron'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
// 协议白名单走 shared-types 的唯一判据（与自动填充、PWA 线索同一条）。
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'

/** 上报通道。 */
const ROUTE = PRELOAD_ROUTES.pageTextCaptured
/** 正文上限：足够覆盖长文，又不至于把库撑爆（超出部分对检索没有增量价值）。 */
const MAX_TEXT = 200000
/** 低于这个长度视为"没有正文"（导航页 / 空白页 / 视频页），不入索引。 */
const MIN_TEXT = 200

/** 只处理普通网页：hira:// / about: / 扩展页等没有"正文"这个概念。 */
function isIndexablePage() {
  try {
    return isHttpProtocol(String(window.location.protocol || ''))
  } catch (_) {
    return false
  }
}

/** 正文候选容器（按"最可能装正文"的顺序；与阅读模式同一套思路，但不做渲染）。 */
const CANDIDATES = [
  'article', 'main', '[role="main"]',
  '#content', '#main', '#article', '#post',
  '.post', '.article', '.article-content', '.post-content',
  '.entry', '.entry-content', '.content', '.markdown-body'
]

/**
 * 抽正文时需要跳过的噪音节点（导航 / 脚本 / 表单 / 嵌入式）。
 *
 * 与旧实现的 `NOISE` 选择器**逐项等价**，只是换成「遍历时跳过子树」而不是
 * 「克隆后 `remove()`」—— 见 `extractText` 里关于内存尖峰的说明。
 */
const NOISE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME',
  'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'
])
const NOISE_ROLES = new Set(['navigation', 'banner', 'contentinfo'])
/** 扫描字符上限：与后续归一空白 / 截断共用同一余量（压缩比远小于 2）。 */
const MAX_SCAN = MAX_TEXT * 2
/** 单个空闲切片的主线程预算。正文抽取是后台索引，不允许抢一整帧。 */
const SLICE_BUDGET_MS = 4
/** 页面一直不空闲时也必须启动；晚于这段时间对索引没有用户可见损失。 */
const START_IDLE_TIMEOUT_MS = 8000

/**
 * 取第一个强语义正文容器。
 *
 * 旧实现为每个候选读一次完整 `textContent.length` 找最大块。这虽然不触发布局，
 * 但仍然是多次 O(DOM) 遍历；搜索页、信息流这类大页面会在后台索引启动时集中付账。
 * 这里按语义优先级取首个命中：`main/article` 已经覆盖绝大多数正文页，少数无语义
 * 小站直接退到 `body`。抽取阶段仍有字符上限和空闲分片，不会因为容器更大而卡一帧。
 *
 * @returns {Element|null}
 */
function pickContainer(): Element | null {
  try {
    return document.querySelector(CANDIDATES.join(',')) || document.body || null
  } catch (_) {
    return document.body || null
  }
}

/**
 * 把容器抽成纯文本：迭代遍历 → 跳过噪音子树 → 分片取文本 → 归一空白。
 *
 * ── 为什么不克隆（这是本函数的核心取舍）────────────────────────────
 * 旧实现是 `container.cloneNode(true)` 再 `querySelectorAll(NOISE).remove()`。
 * 结果正确，但克隆整棵 DOM 是页面空闲期里**唯一**的 O(页面规模) 内存尖峰：
 * 候选 `.content` / `#main` 在真实站点上经常就是整页容器，克隆会临时复制
 * 几十万个节点（大页面上百 MB），与视频解码 / 合成器抢内存，观感就是
 * "页面刚出来卡一下"，重媒体页更明显。
 *
 * 改为「按文档序迭代遍历、遇到噪音节点整棵跳过」：
 *   · 零节点复制 —— 只压一个节点栈（几千个指针的量级）；
 *   · 凑够 `MAX_SCAN` 立刻停 —— 反正结果要 `.slice(MAX_TEXT)`，后面的根本用不到；
 *   · 文本节点直接拼（`textContent` 语义：不补分隔符），语义与克隆版逐字一致。
 *   · 每 4ms 让出主线程 —— 超长页面只延长后台完成时间，不制造交互长任务。
 *
 * @param {Element} container
 * @returns {Promise<string>}
 */
function extractText(container: Element | null | undefined): Promise<string> {
  if (!container) return Promise.resolve('')
  const parts: string[] = []
  let total = 0
  const stack: Node[] = [container]

  return new Promise<string>((resolve) => {
    function finish(): void {
      resolve(parts.join('').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT))
    }

    function step(): void {
      const startedAt = performance.now()
      while (stack.length > 0 && total < MAX_SCAN) {
        if (performance.now() - startedAt >= SLICE_BUDGET_MS) break
        const node = stack.pop()
        if (!node) break
        const type = node.nodeType
        // 3 = TEXT_NODE：直接累积
        if (type === 3) {
          const value = node.nodeValue
          if (value) {
            parts.push(value)
            total += value.length
          }
          continue
        }
        // 只关心元素（1 = ELEMENT_NODE）；注释 / CDATA 等一律跳过
        if (type !== 1) continue
        const element = node as Element
        const tag = String(element.tagName || '').toUpperCase()
        if (!tag || NOISE_TAGS.has(tag)) continue
        try {
          if (element.getAttribute('aria-hidden') === 'true') continue
          const role = element.getAttribute('role')
          if (role && NOISE_ROLES.has(role.toLowerCase())) continue
        } catch (_) {}
        const kids = node.childNodes
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i])
      }
      if (stack.length === 0 || total >= MAX_SCAN) {
        finish()
        return
      }
      scheduleSlice(step)
    }
    step()
  })
}

/** 已上报过的 URL（同一文档内只报一次）。 */
let reportedUrl = ''

async function report(): Promise<void> {
  if (!isIndexablePage()) return
  const url = String(window.location.href || '')
  if (!url || url === reportedUrl) return
  const container = pickContainer()
  if (!container) return
  const text = await extractText(container)
  // 分片期间可能已经跳走：旧页面正文绝不能落到新地址上。
  if (String(window.location.href || '') !== url) return
  if (text.length < MIN_TEXT) return
  reportedUrl = url
  const title = String(document.title || '')
  try {
    // invoke 而不是 send：主进程那侧要回执（写库失败要在控制台看得见，
    // 且沿用 preload 已有的 provider 形态 —— 这里没有裸 send 通道）。
    ipcRenderer.invoke(`ngipc:invoke:${ROUTE}`, { url, title, text }).catch(() => {})
  } catch (_) {}
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

function schedule() {
  const run = () => {
    void report().catch(() => {})
  }
  try {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: START_IDLE_TIMEOUT_MS })
      return
    }
  } catch (_) {}
  setTimeout(run, 4000)
}

/**
 * 触发时机：**页面首次转入后台**，或一段较长的稳定空闲窗口。
 *
 * 首次交互不再作为触发点：用户刚开始滚动时正是最需要跟手的时刻，后台索引没有理由
 * 与它抢主线程。页面转入后台时立刻开始；否则等较长的 `requestIdleCallback` 超时。
 * 抽取本身还会继续 4ms 分片，因此即使是数万节点的大型搜索结果页也不会形成长任务。
 */
let triggered = false

function detachTriggers() {
  try { document.removeEventListener('visibilitychange', onVisibilityChange) } catch (_) {}
}

function onVisibilityChange() {
  try {
    if (document.visibilityState === 'hidden') trigger()
  } catch (_) {}
}

function trigger() {
  if (triggered) return
  triggered = true
  detachTriggers()
  schedule()
}

// 只在顶层文档挂触发点（iframe 里的正文由主文档那份统一采集）。
try {
  if (window.top === window) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
  }
} catch (_) {}
