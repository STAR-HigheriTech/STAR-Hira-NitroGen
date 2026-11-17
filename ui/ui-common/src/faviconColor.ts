/**
 * @hira-ng/ui-common / faviconColor —— 跟随 favicon 取色
 *
 * 学 Hira `js/navbar/tabColor.js` 的取色算法，但把两处**过时/不可控**的部分现代化：
 *
 *   1. 像素来源：Hira 在渲染层直接把站点原始 favicon 塞进 canvas —— 在 NG 这里行不通，
 *      因为 tab 的 favicon 是异源 https://，而渲染层 origin 是 file:// / localhost，
 *      `getImageData` 会因为「画布被污染」直接抛 SecurityError。NG 改走
 *      `hira://favicon/?url=…`（主进程代理取回字节 + ACAO，见 apps/app-main/src/main/
 *      hira-protocol.js#serveFavicon），于是同源、可安全取色。
 *   2. 文字色：Hira 那个神经网络判定**原样保留**（见 ./textColor.js）——
 *      试过用 WCAG 对比度替代，结果就是 bilibili 粉/蓝、Spotify 绿这类中深饱和色
 *      全被算成黑字，糊成一团。数值规则替代不了它，所以不做替代；
 *      只在它之上补了一条「饱和中深色 → 白字」的放宽（Hira 的 NN 对 B 站高亮蓝、
 *      初音青这类色给黑字，正是要放宽的那一段），详见 pickTextColor 的注释。
 *
 * 算法本身（量化分桶 + 权重）**照搬 Hira**，因为它的取舍很到位：
 *   · RGB 各通道量化到 5 的倍数（把相近颜色并到同一个桶）
 *   · 越暗的像素权重越低（sum<310 → .35，sum<50 → .01）—— 网站图标普遍带描边/阴影，
 *     不压掉的话取出来的永远是黑色
 *   · 过亮的像素权重随亮度线性衰减（任一分量 >210）
 *   · 纯白 / 纯黑两个桶再乘 0.05（它们当背景没有信息量）
 * 只补一条：几乎全透明的像素不携带颜色信息，直接跳过（Hira 靠权重间接压，这里显式跳过）。
 */
import { pickTextColor } from './textColor'
// 代理 URL 的规则只有一份（shared-types/src/favicon-src.mjs）——取色用的图和
// 行首显示用的图必须**同一个 URL**，否则同一张 favicon 会被取两次、缓存也各存一份。
import { faviconProxyUrl as buildFaviconProxyUrl } from '@hira-ng/shared-types/src/favicon-src.mjs'
// 「算不算普通网页」的唯一判据（代理侧白名单同一条）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 「内部页图标」的判据也只有一份：渲染侧靠它分支，取色侧也靠它分支。
import { isPageIconUrl } from '@hira-ng/shared-types/src/page-icon.mjs'

/** 取色只在小图上做：favicon 普遍 ≤64px，缩到 32 足够且省一大截像素遍历 */
const CANVAS_MAX = 32
/** 取色结果缓存上限（按 favicon URL 键，命中即用，跨标签/跨面板共享） */
const CACHE_MAX = 400
/** 单张 favicon 的取色超时：加载挂了就放弃，绝不让它悬着 */
const LOAD_TIMEOUT_MS = 5000

export interface FaviconColors {
  bg: string
  fg: string
  rgb: number[]
}

/**
 * 标签图标底板的统一令牌。所有标签视图（横向标签条、纵向标签列、总览、标签面板、
 * rail 展开列表、固定标签网格）都只消费这两个变量，不再各自写死白色。
 */
export const TAB_FAVICON_BG_VAR = '--hira-tab-favicon-bg'
export const TAB_FAVICON_FG_VAR = '--hira-tab-favicon-fg'

/** @type {Map<string, Promise<{bg:string, fg:string, rgb:number[]}|null>>} */
const colorCache: Map<string, Promise<{bg:string, fg:string, rgb:number[]}|null>> = new Map<string, Promise<FaviconColors | null>>()
/** @type {HTMLCanvasElement|null} */
let canvas: HTMLCanvasElement | null = null
/** @type {CanvasRenderingContext2D|null} */
let ctx: CanvasRenderingContext2D | null = null

interface PendingColorPaint {
  url: string
  active: boolean
  isCurrent: () => boolean
}

/** 只为「即将进入视口」的行取色；离屏标签页不请求图片、不跑 canvas。 */
const pendingColorPaints = new WeakMap<HTMLElement, PendingColorPaint>()
const visibleColorRows = new WeakSet<Element>()
let visibilityObserver: IntersectionObserver | null = null
let visibilityObserverDocument: Document | null = null

function ensureVisibilityObserver(row: HTMLElement): IntersectionObserver | null {
  const doc = row.ownerDocument
  if (visibilityObserver && visibilityObserverDocument === doc) return visibilityObserver
  const Ctor = doc && doc.defaultView ? doc.defaultView.IntersectionObserver : undefined
  if (typeof Ctor !== 'function') return null
  visibilityObserverDocument = doc
  visibilityObserver = new Ctor((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement
      if (!entry.isIntersecting) {
        visibleColorRows.delete(target)
        continue
      }
      visibleColorRows.add(target)
      const pending = pendingColorPaints.get(target)
      if (pending) runColorPaint(target, pending)
    }
  }, { rootMargin: '160px 0px', threshold: 0 })
  return visibilityObserver
}

function runColorPaint(row: HTMLElement, request: PendingColorPaint): void {
  if (pendingColorPaints.get(row) !== request || !request.isCurrent()) return
  getFaviconColors(request.url)
    .then((colors) => {
      if (pendingColorPaints.get(row) !== request || !request.isCurrent()) return
      if (visibilityObserver && !visibleColorRows.has(row)) return
      paintFaviconColor(row, colors, request.active)
    })
    .catch(() => {})
}

/**
 * 站外 favicon 的同源化代理 URL（主进程负责取字节并带上 ACAO）。
 * 真源在 `shared-types/src/favicon-src.mjs`，这里只转发（见文件头的 import 说明）。
 * @param {string} url
 * @returns {string}
 */
export function faviconProxyUrl(url: string): string {
  return buildFaviconProxyUrl(url)
}

/**
 * 空闲时执行：取色是纯装饰性工作，不该和首帧渲染抢同一帧
 * @param {() => void} fn
 */
function idle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 500 })
  else setTimeout(fn, 0)
}

/**
 * 这张图标该不该走主进程字节代理。
 *
 * 只有 http(s) 才走 —— 这正是代理侧（main/hira-protocol.js#serveFavicon）的白名单，
 * 也是 shared-types/src/favicon-src.mjs 给「显示用图」定下的同一条规则。
 * 两处必须一致：此处若把非 http 也塞进代理，只会得到 400（拿不到字节），
 * 而显示侧却直接用了原 URL —— 同一张图两条路不同命，取色永远缺席。
 * @param {string} url
 * @returns {boolean}
 */
function asProxyable(url: string): boolean {
  return isHttpUrl(url)
}

/**
 * 强制取色表 —— 「这类图标的主色不由像素决定」的唯一登记处。
 *
 * 为什么需要它：内部页图标（hira://page-icon/…）是**白底 + 黑字形**的自绘位图，
 * 直接采样得到的会是黑/灰 —— 选中态于是变成一整块深色砖，和"内部页"这个身份完全不符。
 * 所以这类图标**不采样**，主色恒定取白（文字色仍走同一套对比色判定，白底自然得黑字）。
 *
 * 新增条目只往这张表里加，取色流程本身不再长分支 —— 登记即可生效，
 * 与 packages/shared-types/src/page-icon.mjs 的 isPageIconUrl 共用同一个判据。
 */
const FORCED_COLOR_RULES = [
  { test: isPageIconUrl, rgb: [255, 255, 255] }
]

/**
 * 命中强制规则就返回成品色，否则 null（交给真实采样）。
 * @param {string} url
 * @returns {{bg:string, fg:string, rgb:number[]}|null}
 */
function forcedColorsFor(url: string): FaviconColors | null {
  for (const rule of FORCED_COLOR_RULES) {
    if (!rule.test(url)) continue
    const rgb = rule.rgb
    return {
      bg: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
      fg: pickTextColor(rgb),
      rgb
    }
  }
  return null
}

/**
 * 从 RGBA 像素里取主色（Hira `getColorFromImage` 的等价实现）。
 * @param {Uint8ClampedArray} data
 * @returns {number[]|null} [r,g,b]，全透明/无有效像素时 null
 */
function extractDominant(data: Uint8ClampedArray): number[] | null {
  const buckets = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 128) continue // 几乎全透明：不带颜色信息
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const sum = r + g + b
    const qr = Math.round(r / 5) * 5
    const qg = Math.round(g / 5) * 5
    const qb = Math.round(b / 5) * 5
    const key = (qr << 16) | (qg << 8) | qb

    let add = 1
    if (sum < 310) add = 0.35
    if (sum < 50) add = 0.01
    if (r > 210 || g > 210 || b > 210) add = 0.5 - 0.0001 * sum
    buckets.set(key, (buckets.get(key) || 0) + add)
  }
  let bestKey = -1
  let best = 0
  for (const [key, weight] of buckets) {
    const r = (key >> 16) & 255
    const g = (key >> 8) & 255
    const b = key & 255
    // 纯白 / 纯黑当背景没有信息量：几乎不计（Hira 同款）
    const w = (r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0)
      ? weight * 0.05
      : weight
    if (w > best) {
      best = w
      bestKey = key
    }
  }
  if (bestKey < 0) return null
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255]
}

/**
 * 把已经加载好的图片画进离屏 canvas 并取色。
 * @param {HTMLImageElement} img
 * @returns {{bg:string, fg:string, rgb:number[]}|null}
 */
function readColors(img: HTMLImageElement): FaviconColors | null {
  const w = img.naturalWidth || img.width || 0
  const h = img.naturalHeight || img.height || 0
  if (!w || !h) return null
  const size = Math.max(1, Math.min(CANVAS_MAX, w, h))
  if (!canvas) {
    canvas = document.createElement('canvas')
    // willReadFrequently：这张 canvas 的唯一用途就是 getImageData
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!ctx) return null
  canvas.width = size
  canvas.height = size
  ctx.clearRect(0, 0, size, size)
  try {
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    const rgb = extractDominant(data)
    if (!rgb) return null
    return { bg: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, fg: pickTextColor(rgb), rgb }
  } catch (_) {
    // 理论上不会走到（代理已同源化）；万一被污染也只是一次取色失败，不影响图标显示
    return null
  }
}

/**
 * 真正去加载 + 取色（每个 favicon URL 只会执行一次）
 * @param {string} url
 * @returns {Promise<{bg:string, fg:string, rgb:number[]}|null>}
 */
function extract(url: string): Promise<FaviconColors | null> {
  return new Promise((resolve) => {
    const img = new Image()
    // **必须**在 src 之前设 crossOrigin：否则浏览器先发一个无 CORS 的请求，画布照样被污染
    img.crossOrigin = 'anonymous'
    let settled = false
    /** @param {{bg:string, fg:string, rgb:number[]}|null} v */
    const finish = (v: FaviconColors | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), LOAD_TIMEOUT_MS)
    img.onload = () => {
      // 交给空闲帧：取色是装饰性工作，不该挤在首帧里
      idle(() => {
        clearTimeout(timer)
        finish(readColors(img))
      })
    }
    img.onerror = () => {
      clearTimeout(timer)
      finish(null)
    }
    // 代理**只认 http(s)**（见 shared-types/src/favicon-src.mjs 的统一规则）——
    // 非 http 的图标（hira:// 内部页 / data: / blob: …）走代理只会拿到 400，
    // 那就等于永远取不到色。这类图标直接取：带 crossOrigin 就要过 CORS，
    // 而 hira:// 已登记 corsEnabled + 静态层带 ACAO，返回 null 也会被下面的 catch 兜住。
    img.src = asProxyable(url) ? faviconProxyUrl(url) : url
  })
}

/**
 * 取某个 favicon 的主色与配套文字色（带缓存 + 并发去重）。
 * 取不到（无网络 / 非图片 / 全透明 / canvas 异常）一律 resolve(null)，调用方按「无色」处理。
 * @param {string} faviconUrl
 * @returns {Promise<{bg:string, fg:string, rgb:number[]}|null>}
 */
export function getFaviconColors(faviconUrl: string): Promise<FaviconColors | null> {
  const url = String(faviconUrl || '')
  if (!url) return Promise.resolve(null)
  // 强制色先于缓存与采样：命中就完全不碰图片（连请求都不发）
  const forced = forcedColorsFor(url)
  if (forced) return Promise.resolve(forced)
  const hit = colorCache.get(url)
  if (hit) return hit
  const task = Promise.resolve().then(() => extract(url)).catch(() => null)
  colorCache.set(url, task)
  if (colorCache.size > CACHE_MAX) {
    const oldest = colorCache.keys().next().value
    if (oldest && oldest !== url) colorCache.delete(oldest)
  }
  return task
}

/**
 * 把颜色画到一行上 —— tabbar 的 `.tab-item` 与面板的 `.tabrow-row` **共用这一个实现**，
 * 两处视觉不可能分叉。规则学 Hira：
 *   · 选中项：整块底色 = favicon 主色，文字 = 按对比度选出的黑/白
 *   · 未选中项：只给一条该色的指示线（形状由各组件 CSS 决定，颜色走 `--favicon-tab-color`）
 *   · favicon 底板固定使用「选中态文字色」（白/深自动切换）—— 与当前是否选中无关
 *
 * 「无视深色模式压暗」：深浅色用同一份色值，不做任何按主题调暗/调透明。
 * @param {HTMLElement} row
 * @param {{bg:string, fg:string}|null} colors
 * @param {boolean} active
 */
export function paintFaviconColor(
  row: HTMLElement | null | undefined,
  colors: Pick<FaviconColors, 'bg' | 'fg'> | null,
  active: boolean
): void {
  if (!row) return
  if (!colors) {
    clearFaviconPaint(row)
    return
  }
  row.classList.add('has-favicon-color')
  row.style.setProperty('--favicon-tab-color', colors.bg)
  // 选中与否都消费同一份前景色：未选中行仍显示"选中时会是白字还是深字"。
  row.style.setProperty(TAB_FAVICON_BG_VAR, colors.fg)
  row.style.setProperty(TAB_FAVICON_FG_VAR, colors.bg)
  if (active) {
    row.style.background = colors.bg
    row.style.color = colors.fg
    // 边框与底色同色 → 实心圆角块，不留一条与主色打架的异色描边
    row.style.borderColor = colors.bg
  } else {
    row.style.background = ''
    row.style.color = ''
    row.style.borderColor = ''
  }
  // 面板里的标题是独立 button（自身有 color 规则），必须显式给；tabbar 的 .title 继承即可，写了也无害
  for (const el of tabTitleNodes(row)) el.style.color = active ? colors.fg : ''
}

function tabTitleNodes(row: HTMLElement): NodeListOf<HTMLElement> {
  return row.querySelectorAll<HTMLElement>('[data-tab-title], .title, .tabrow-label')
}

/** 回到“尚未取色”的白色底板，同时清掉上一站点残留的行级颜色。 */
function clearFaviconPaint(row: HTMLElement): void {
  row.classList.remove('has-favicon-color')
  row.style.removeProperty('--favicon-tab-color')
  row.style.removeProperty(TAB_FAVICON_BG_VAR)
  row.style.removeProperty(TAB_FAVICON_FG_VAR)
  row.style.background = ''
  row.style.color = ''
  row.style.borderColor = ''
  for (const el of tabTitleNodes(row)) el.style.color = ''
}

/**
 * 请求并应用取色 —— 两个组件都只调这一个入口。
 *
 * 为什么需要失效守卫：取色是异步的，等它回来时这一行可能已经被复用（keyed 复用）、
 * 被移除，或该标签已经导航到别的站点。守卫返回 false 就丢弃这次结果，绝不画到别人身上。
 * @param {HTMLElement} row
 * @param {string} faviconUrl
 * @param {boolean} active
 * @param {() => boolean} isCurrent
 */
export function applyFaviconColor(
  row: HTMLElement,
  faviconUrl: string | null | undefined,
  active: boolean,
  isCurrent: () => boolean
): void {
  if (!faviconUrl) {
    pendingColorPaints.delete(row)
    visibleColorRows.delete(row)
    try { visibilityObserver?.unobserve(row) } catch (_) {}
    row.dataset.faviconColorUrl = ''
    clearFaviconPaint(row)
    return
  }
  const url = String(faviconUrl)
  if (row.dataset.faviconColorUrl !== url) {
    row.dataset.faviconColorUrl = url
    clearFaviconPaint(row)
  }
  const request: PendingColorPaint = {
    url,
    active: !!active,
    isCurrent: typeof isCurrent === 'function' ? isCurrent : () => true
  }
  pendingColorPaints.set(row, request)
  const observer = ensureVisibilityObserver(row)
  if (!observer || visibleColorRows.has(row)) {
    runColorPaint(row, request)
    return
  }
  try { observer.observe(row) } catch (_) {}
}
