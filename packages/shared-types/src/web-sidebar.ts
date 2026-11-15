/**
 * web-sidebar.mjs —— 独立侧栏（Web Sidebar）的**纯规则**（跨进程共用，零依赖）。
 *
 * 三件事，且都必须在纯层（两端共用同一份，否则会出现"入口一套、主进程另一套"的半生效状态）：
 *   · **url 判据**：什么样的地址才配放进侧栏；
 *   · **标题回落**：页面还没给出 `<title>` 之前，侧栏顶部该显示什么；
 *   · **视图模式 → UA**：侧栏默认以**手机端**打开，可切到桌面端 —— "移动 UA 长什么样"
 *     是纯字符串变换，两端（主进程施加 / 顶条显示）都该引这一份，不各写一套。
 *
 * **这里没有的东西**（都是当"面板"时被迫背上的包袱，独立子系统不再需要）：
 *   没有 id 派生（侧栏是"一个"，不是"一列条目"）、没有 zoom 规整 ——
 *   它们是"把一个远程站当面板塞进槽位"才需要的适配层。
 */

import { isHttpProtocol } from './url-protocols.js'

export type WebSidebarViewMode = 'mobile' | 'desktop'
export type WebSidebarSide = 'left' | 'right'
export type WebSidebarPosition = 'auto' | WebSidebarSide

/**
 * url 能不能放进侧栏；不能则返回 `null`（调用方据此**拒绝**，而不是打开一个永远白屏的块）。
 */
export function normalizeSidebarUrl(value: unknown): string | null {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return null
  let parsed = null
  try { parsed = new URL(raw) } catch (_) { return null }
  if (!isHttpProtocol(parsed.protocol)) return null
  return parsed.toString()
}

/**
 * 标题回落：页面 `<title>` 到位之前显示主机名（去掉 `www.`）。
 */
export function sidebarTitleForUrl(value: string): string {
  const url = normalizeSidebarUrl(value)
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch (_) {
    return ''
  }
}

/**
 * 两个地址是不是**同一个站**（决定侧栏里的链接"留在侧栏"还是"去主浏览区开新标签"）。
 *
 * 判据刻意只有两条（可预测优先，不做公共后缀表）：
 *   ① 主机名相同（忽略开头的 `www.`）；
 *   ② 其一是另一个的**子域**（按 `标签.` 边界匹配，不是字符串包含）。
 *
 * 于是 `docs.google.com` → `docs.google.com/docs`：同站（留在侧栏，站点工作区不碎开）；
 * `docs.google.com` → `mail.google.com`：**不同站**（去主浏览区开新标签）。
 *
 * 为什么"跨子域也算不同站"：这条判据要的是**可预测**。做成"注册域相同就算同站"就必须
 * 背一张公共后缀表（`co.uk` / `github.io` …），表一过期就会把 `a.github.io` 与
 * `b.github.io` 判成同一站 —— 那种错法会让"点了外部链接却留在侧栏"重新出现。
 * 跨子域多开一个标签是可接受的代价，判错方向也安全。
 *
 */
export function isSameSidebarSite(currentUrl: string, nextUrl: string): boolean {
  const a = hostnameOf(currentUrl)
  const b = hostnameOf(nextUrl)
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

// ═══════════════════════════════════════════════════════════════════
//  视图模式（手机端 / 桌面端）
//
//  侧栏只有一条窄栏，很多站点在桌面版 UA 下会给出「横向铺满」的版式，塞进 400px 里
//  就是横向滚动条满天飞。因此**默认以手机端打开**（用户在窄栏里看到的是为窄屏设计的
//  版式），需要时一键切回桌面版（更大信息密度 / 有些站只在桌面版给完整功能）。
//
//  实现只是**换一条 UA**：真源仍是同一条 session，登录态、cookie、扩展注入全不变 ——
//  模式不同而身份相同，这正是"一个视图、两种呈现"该有的样子。
// ═══════════════════════════════════════════════════════════════════

/**
 * ── 侧栏所在侧（设置项 `app.web_sidebar_position`）────────────────────────
 *
 * 三个取值，比两值多出来的 `'auto'` 是**默认**：
 *   · `'auto'` —— 自动落在**工具区（rail + 面板）所在的那一侧**（跟随）。
 *     为什么是"跟随"而不是"对面"：侧栏是**从工具区点出来的**（rail 上固定的书签、
 *     rail 贴底的「放进侧栏」、收藏面板……）。从左边点的东西出现在右边缘，是"手感错位"——
 *     用户报的就是这一条（"从 rail 固定的书签打开侧栏，为什么不是在 rail 那一侧"）。
 *     "跟随"才是 auto 这个名字唯一说得通的解释：跟着工具区走。
 *   · `'left'` / `'right'` —— 用户显式钉死（在设置里选，或者**拖顶条**把它拖过去）。
 *     想要"错开一侧"（工具区在左、侧栏在右）的人，选这里 —— 那是一次**显式**决定，
 *     不该由默认值替他做。
 *
 * 代价（明确写下来，因为它是真实存在的）：与工具区同侧时两段宽度相加，网页会被推窄。
 * 这是用户可感知、可自主取舍的（钉到对面 / 拖顶条 / 调窄任一段），比"从哪边点却出现在
 * 另一边"那种**猜不到**的错位要好。
 *
 * 三者都是"偏好"，与显隐无关（显隐是过程，不该被持久化成"重启自动弹出来"）。
 */
export const WEB_SIDEBAR_POSITIONS = Object.freeze(['auto', 'left', 'right'] as const)
export const DEFAULT_WEB_SIDEBAR_POSITION: WebSidebarPosition = 'auto'

/** 设置页下拉的「位置偏好」档位表（值集合与顺序同 WEB_SIDEBAR_POSITIONS，文案只此一份）。 */
export const WEB_SIDEBAR_POSITION_OPTIONS = Object.freeze([
  ['auto', '自动（跟随工具侧栏同侧）'],
  ['left', '靠左'],
  ['right', '靠右']
] as const)

export function isWebSidebarPosition(value: unknown): value is WebSidebarPosition {
  return typeof value === 'string' && WEB_SIDEBAR_POSITIONS.some((position) => position === value)
}

/**
 * 把「位置偏好」解析成**实际侧别** —— 纯函数，主进程与渲染层引同一份。
 *
 * `'auto'` 的解析依赖工具区当前在哪一侧（`app.sidebar_position`）：工具区靠左 → 侧栏靠左。
 * 即自动模式下侧栏**跟着工具区走、始终与它同侧** —— "从哪边点开，就从哪边出来"。
 *
 */
export function resolveWebSidebarSide(position: unknown, toolSide: unknown): WebSidebarSide {
  if (position === 'left' || position === 'right') return position
  return toolSide === 'right' ? 'right' : 'left'
}

/** 合法视图模式（唯一一份；主进程与顶条都引它）。 */
export const WEB_SIDEBAR_VIEW_MODES = Object.freeze(['mobile', 'desktop'] as const)

/** 默认视图模式：手机端（窄栏里的默认最优解）。 */
export const DEFAULT_WEB_SIDEBAR_VIEW_MODE: WebSidebarViewMode = 'mobile'

/**
 * 是不是一个合法的视图模式。
 */
export function isWebSidebarViewMode(value: unknown): value is WebSidebarViewMode {
  return typeof value === 'string' && WEB_SIDEBAR_VIEW_MODES.some((mode) => mode === value)
}

/** 一个"像真的"的 Android Chrome UA 模板（Chrome 版本段由调用方填）。 */
const MOBILE_ANDROID_PLATFORM = 'Linux; Android 13; Pixel 7'

/**
 * 由**桌面端 UA** 推出对应的**手机端 UA**（版本号沿用同一个 Chrome 主版本）。
 *
 * 为什么要从桌面 UA 推、而不是写死一条：桌面 UA 的真源是启动时那次伪装
 * （`app.userAgentFallback` = 标准 Chrome UA）。写死一条会带来"两个模式报告的
 * Chrome 版本不一样"的破绽 —— 站点侧一眼看出这是同一个客户端在演两套。
 *
 */
export function buildMobileUserAgent(desktopUserAgent: string): string {
  const source = String(desktopUserAgent || '')
  const version = /Chrome\/([\d.]+)/.exec(source)
  const chrome = version ? `Chrome/${version[1]}` : 'Chrome/120.0.0.0'
  return `Mozilla/5.0 (${MOBILE_ANDROID_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Mobile Safari/537.36`
}

/** 取主机名（小写、去掉开头 `www.`、非 http(s) 一律空串）。 */
function hostnameOf(value: unknown): string {
  const url = normalizeSidebarUrl(value)
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./i, '')
  } catch (_) {
    return ''
  }
}
