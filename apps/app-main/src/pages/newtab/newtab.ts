/**
 * hira://newtab · 新标签页引导
 *
 * 这一层刻意很薄，只做三件事：
 *   1. 主题（配色令牌 + 「有没有壁纸」标记；壁纸本身由窗口外壳唯一绘制）
 *   2. 点链接的统一出口（openUrl）—— 全页唯一的"打开链接"通道
 *   3. 装配：点名分区与新闻源 → 建分区切换器
 *
 * 页面本身**不认识任何具体内容**：不认识搜索框（那是首页里的常驻组件）、
 * 不认识时间/日期/新闻卡片（那是首页的组件清单）、也不认识推广页里有什么。
 *
 * ── 扩展点（加分区 / 加组件 / 加新闻源都只改这一个文件的清单）──────────
 *   · 加分区：新增 sections/<name>.js（内部 defineSection 自注册），
 *             在这里加一行 `import './sections/<name>.js'`。
 *             **注册顺序 = 顶部选项卡顺序。**
 *   · 加组件：新增 widgets/defs/<name>.js，在 sections/home.js 的清单里加一行。
 *   · 加新闻源：在 `@hira-ng/shared-types/src/news/providers/` 新增一个 .mjs，
 *             并在 `.../news/index.mjs` 的清单里加一行。
 *             **顺序 = 降级链顺序**，离线兜底放最后。（源已抽到共享层，
 *             NTP 与侧栏「实时更新」面板共用同一批 —— 在这里只为触发注册。）
 */
import { rpc, openLink, initTheme, initThemeWallpaperFlag } from 'hira://shared/runtime.js'
import type { LinkIntentEvent } from 'hira://shared/link-intent.mjs'
import { createSectionSwitcher } from './sections/switcher.js'
import { mountCornerClock } from './corner-clock.js'
import { mountQuickLinks } from './quick-links.js'

// 新闻源：注册内置源（首页卡片与新闻页共用同一套；顺序即降级链，curated 必须最后）。
// **只接第一方接口** —— 2026-10-07 排查发现：原来那两个第三方热榜聚合站
// （api-hot.imsyy.top / api.vvhan.com）**域名已解析不到**，而这三家的官方接口
// 实测可用且带 CORS 头。第三方聚合是会被关掉的，第一方不会。
// 源实现住在共享层（`packages/shared-types/src/news/`），NTP 与 Live Folders 面板同源共用。
// 源码里照写 workspace 裸名即可 —— 复制到 out/ 时会由 electron.vite.config.js
// 自动改写成 `hira://shared/news/index.mjs`（内部页是不打包的静态页，只认 URL；
// 裸名留到运行期 = 模块图解析失败 = **整页白屏**，不是"少个组件"）。
// 新增跨层共享模块时，记得同时登记进那边的 SHARED_PAGES_MODULES / _DIRS / _ASSETS。
import '@hira-ng/shared-types/src/news/index.mjs'

// 分区清单。注册顺序 = 选项卡顺序。
// 默认分区（首页）静态 import：首屏就要用；
// 其余分区只登记「选项卡元数据 + 取模块的方式」，**代码等首次切过去才下载**
// （见 sections/registry.js#declareSection）—— 开新标签时不再为没点开的分区付费。
import './sections/home.js'
import { declareSection } from './sections/registry.js'

declareSection({
  id: 'promotion',
  name: '推广',
  description: 'Higheri 产品与伙伴内容',
  load: () => import('./sections/promotion.js')
})
declareSection({
  id: 'news',
  name: '新闻',
  description: '整页新闻热点',
  load: () => import('./sections/news.js')
})

// ── 主题：配色（令牌表）+ 壁纸标记，两者来自主进程的同一次发布 ──────────────
initTheme()
// 壁纸**只有窗口外壳那一份**（`#chrome-theme-background`，在所有 WebContentsView 之下）：
// 本页视图是透明画布、body 在有壁纸时也透明，看到的直接就是外壳那张图。
// 这里只留「当前有没有壁纸」这一个标记，供 CSS 决定卡片要不要换玻璃材质 ——
// 页面里不再画任何背景层，也就不会在面板 / 侧栏动画时被拖着一起动。
initThemeWallpaperFlag()

/**
 * 全页唯一的"打开链接"出口：链接、搜索结果、新闻条目、推广按钮全部走这里。
 *
 * **打开方式由点击手势决定**（真源见 hira://shared/link-intent.mjs）：
 * 普通点击 = 当前标签页；Ctrl/Cmd/中键 = 后台新标签；Ctrl+Shift = 前台新标签。
 * 具体落地在 `openLink`（内部页统一出口）—— 这里不再自己判断修饰键，
 * 也不直接 `nav:go`，否则「Ctrl+点击开新标签」在内部页就会失效。
 * 拿不到应用桥（例如把内部页单独丢进浏览器调试）时由 openLink 退回 window.open。
 * @param {string} url
 * @param {unknown} [event] 触发这次打开的鼠标事件（缺省 = 当前标签页）
 */
function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`New tab element #${id} is unavailable`)
  return element as unknown as T
}

async function openUrl(url?: string, event?: LinkIntentEvent) {
  await openLink(url, event)
}

// ── 外壳：顶部时间 + 顶部选项卡 + 内部页快捷入口 + 分区 ─────────────────────
// 前两样都是**页面外壳**的一部分：三个分区上都在，所以它们不属于任何分区。
mountCornerClock(requiredElement<HTMLElement>('ntp-clock'))
mountQuickLinks(requiredElement<HTMLElement>('ntp-quicklinks'), openUrl)

createSectionSwitcher({
  stripHost: requiredElement<HTMLElement>('ntp-sections'),
  viewsHost: requiredElement<HTMLElement>('ntp-views'),
  openUrl
})
