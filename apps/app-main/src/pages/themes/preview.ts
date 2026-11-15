// @ts-check
/**
 * themes/preview.js —— 编辑器里的**迷你浏览器窗口**（所见即所得的那一半）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是"真窗口的缩略"而不是一张静态 mock
 * ══════════════════════════════════════════════════════════════════════
 * 静态图只能告诉你"这个主题长什么样"，改一个颜色它就骗人。这里画的每一块
 * 用的都是真实结构（标签栏 / 地址栏 / 页面区 / 背景层），**颜色全部来自令牌**
 * —— 编辑器每改一个值，预览立刻是那个值，不需要维护第二份"预览用配色表"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条关键做法
 * ══════════════════════════════════════════════════════════════════════
 *  1. **令牌写在预览子树的根上**（`previewRoot.style.setProperty`），绝不碰
 *     `documentElement`：管理窗口自己是真实主题的皮肤，预览是草稿的皮肤，
 *     两者必须互不污染（否则"编辑到一半，整个窗口跟着变花"）。
 *     内联变量天然只对子树生效 —— 这正是当初不做全局覆写的那条判据。
 *  2. **背景层铺满整个窗口**（含标签栏/地址栏底下），chrome 两行压在其上 ——
 *     与真实外壳的层级一致。于是"透明度"这一档在预览里是有反馈的：
 *     chrome 越透明，背景越透出来（真实窗口里正是这个观感）。
 *  3. **背景取值口径由主进程算好**（`theme:preview` 的 `background.window`），
 *     这里只做纯赋值 —— 预览与真实窗口不可能"看起来不一样"。
 *
 * 样式在 `themes/styles.js` 的 `.thm-preview*` 段（与这里一一对应）。
 */

import { el } from '@hira-ng/shared-types/src/themes/dom.js'
// 背景层渲染器（图片 / 渐变 / 视频）—— canonical 真源在 shared-types；
// 外壳与新标签页用的是**同一份**，所以预览不可能与真实窗口"看起来不一样"。
import { applyThemeBackground } from '@hira-ng/shared-types/src/theme-background.mjs'
import type { ThemeBackgroundSpec } from '@hira-ng/shared-types/src/theme-background.mjs'
// 地址栏里显示的就是「新标签页」的真实地址 —— 拼法只有 pageUrl 一份。
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'

/** 预览里画几个标签（够看出"标签栏被着色"即可，不必多）。 */
const TAB_TITLES = ['新标签页', '文档', '搜索']

/**
 * @param {Document} doc
 * @returns {{
 *   element: HTMLElement,
 *   applyTokens: (tokens: Record<string, string>) => void,
 *   applyBackground: (background: unknown) => void
 * }}
 */
export function createPreview(doc: Document) : {
  element: HTMLElement,
  applyTokens: (tokens: Record<string, string>) => void,
  applyBackground: (background: unknown) => void
} {
  const root = el(doc, 'div', 'thm-preview')
  const frame = el(doc, 'div', 'thm-preview__frame')

  // 背景铺满整个窗口（绝对定位在 frame 内，位于 chrome 之下）。
  // 壁纸自身的 blur 由 applyThemeBackground 写进 bg；UI blur 只挂在 chrome 玻璃面。
  const bg = el(doc, 'div', 'thm-preview__bg')
  const overlay = el(doc, 'div', 'thm-preview__overlay')
  frame.append(bg, overlay)

  // chrome（标签栏 + 地址栏）：作为一组，透明度整组一起调。
  const chrome = el(doc, 'div', 'thm-preview__chrome')

  const top = el(doc, 'div', 'thm-preview__top')
  const dots = el(doc, 'div', 'thm-preview__dots')
  for (let i = 0; i < 3; i++) dots.appendChild(el(doc, 'span', 'thm-preview__dot'))
  const tabs = el(doc, 'div', 'thm-preview__tabs')
  TAB_TITLES.forEach((title, i) => {
    const tab = el(doc, 'div', 'thm-preview__tab', title)
    if (i === 0) tab.dataset.active = '1'
    tabs.appendChild(tab)
  })
  top.append(dots, tabs)

  const nav = el(doc, 'div', 'thm-preview__nav')
  const navLeft = el(doc, 'div', 'thm-preview__nav-left')
  for (const glyph of ['‹', '›', '⟳']) navLeft.appendChild(el(doc, 'span', 'thm-preview__nav-btn', glyph))
  const address = el(doc, 'div', 'thm-preview__address', pageUrl('newtab'))
  const navRight = el(doc, 'div', 'thm-preview__nav-right')
  for (let i = 0; i < 3; i++) navRight.appendChild(el(doc, 'span', 'thm-preview__nav-btn', '·'))
  nav.append(navLeft, address, navRight)

  chrome.append(top, nav)

  // 页面区：内容压在最上层（`bg` 铺满时页面区自己不再画背景）。
  const stage = el(doc, 'div', 'thm-preview__stage')
  const content = el(doc, 'div', 'thm-preview__content')
  const hero = el(doc, 'div', 'thm-preview__hero')
  hero.append(
    el(doc, 'div', 'thm-preview__hero-title', '12:30'),
    el(doc, 'div', 'thm-preview__hero-sub', '新标签页')
  )
  const grid = el(doc, 'div', 'thm-preview__grid')
  for (let i = 0; i < 5; i++) {
    const tile = el(doc, 'div', 'thm-preview__tile')
    tile.append(el(doc, 'span', 'thm-preview__tile-dot'), el(doc, 'span', 'thm-preview__tile-bar'))
    grid.appendChild(tile)
  }
  content.append(hero, grid)
  stage.appendChild(content)

  frame.append(chrome, stage)
  root.appendChild(frame)

  /**
   * 上一次**真正写进预览子树**的令牌（键 → 字符串）。
   *
   * 编辑器每改一个值都会重算整份令牌（约 60 个键）推过来，拖动滑杆时这是每帧一次。
   * 只写"值真变了"的键，拖动期间通常只有 1~2 次样式写入，预览才不会拖慢手感。
   * 同时承担"上一批有、这一批没有的键要清掉"的差集（Map 而不是数组的 indexOf）。
   */
  let appliedTokens = new Map<string, string>()
  /** 上一次写过的遮罩底色（`style.background` 读回来未必与写入串相同，只能自己记）。 */
  let appliedOverlay = ''

  const applyTokens = (tokens: Record<string, string>) => {
    if (!tokens || typeof tokens !== 'object') return
    const next = new Map<string, string>()
    for (const key in tokens) {
      const value = tokens[key]
      if (value == null || value === '') continue
      const text = String(value)
      next.set(key, text)
      if (appliedTokens.get(key) === text) continue
      root.style.setProperty(key, text)
    }
    for (const key of appliedTokens.keys()) {
      if (next.has(key)) continue
      root.style.removeProperty(key)
    }
    appliedTokens = next
  }

  const applyBackground = (background: unknown) => {
    const outer = background && typeof background === 'object' ? background as { window?: unknown } : null
    const s = outer?.window && typeof outer.window === 'object' ? outer.window as ThemeBackgroundSpec : null
    const visible = !!(s && s.visible)
    applyThemeBackground(bg, s)
    const overlayColor = visible ? String(s?.overlayColor || 'transparent') : 'transparent'
    if (overlayColor !== appliedOverlay) {
      appliedOverlay = overlayColor
      overlay.style.background = overlayColor
    }
    const flag = visible ? '1' : '0'
    if (root.dataset.bg !== flag) root.dataset.bg = flag
  }

  return { element: root, applyTokens, applyBackground }
}
