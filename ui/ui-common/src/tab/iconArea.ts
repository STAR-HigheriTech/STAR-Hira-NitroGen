/**
 * 标签行的**图标区** —— favicon（或无痕标识，或**标题首字兜底**）+ 音频/静音指示按钮。
 *
 * 拆成三个导出，是因为**两种模式的排布不同、但每一件都必须只有一份实现**：
 *   · `createTabFavicon()`     —— 图标位：favicon / 🕶 无痕标识 / 标题首字（三选一），
 *                                并交回 `render()` 这条**共用渲染规则**；
 *   · `createTabAudioButton()` —— 音频按钮（三态规则见 `renderAudioState`）；
 * `createTabIconArea()` 是这三件在**横向标签条**里的那种排布；纵向列表
 * （`tabRowList`）的行里音频按钮在**行的右端**（贴近关闭按钮，与 Edge 一致），
 * 所以它只取前两件、自己决定往哪摆 —— 而"图标位画什么 / 无痕怎么标 / 三态怎么换"
 * 仍然只有一份实现（无痕判断此前只写在横向那一处，数据一旦带上 `incognito`，两端同时生效）。
 *
 * 点击只上抛**无参意图**：调用方（记录）负责把当前 tabId 补上 ——
 * 于是本模块不需要知道「标签 id」这个概念。
 */

import { VolumeX, Volume2 } from '../icons'
import { isPageIconUrl } from '@hira-ng/shared-types/src/page-icon.mjs'
// 首字兜底同样必须显式指定字体（纯文字节点，继承链可能落到系统默认宋体点阵）。
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack.mjs'
import { audioToggleLabel } from './audioLabel'
import { TAB_FAVICON_BG_VAR, TAB_FAVICON_FG_VAR } from '../faviconColor'

/** 类名缺省值（两种模式的行各自一套 CSS 口径，故允许调用方注入）。 */
const DEFAULT_NAMES = Object.freeze({
  area: 'tab-icon-area',
  iconBox: 'tab-icon-box',
  favicon: 'tab-favicon',
  letter: 'tab-icon-letter',
  incognito: 'tab-incognito-icon',
  audio: 'tab-audio-button'
})

type IconPart = keyof typeof DEFAULT_NAMES
export type TabIconClassNames = Partial<Record<IconPart, string>>

export interface TabIconData {
  favicon?: string
  title?: string
  url?: string
  incognito?: boolean
  muted?: boolean
  isPlaying?: boolean
}

export interface TabFaviconController {
  element: HTMLElement
  favicon: HTMLImageElement | null
  letter: HTMLElement | null
  render: (patch?: TabIconData) => void
}

export interface TabAudioController {
  element: HTMLButtonElement
  update: (state: Pick<TabIconData, 'muted' | 'isPlaying'>) => void
}

export interface TabIconAreaController {
  element: HTMLElement
  favicon: HTMLImageElement | null
  audioBtn: HTMLButtonElement
  update: (next: TabIconData) => void
}

/**
 * 图标格的**唯一尺寸口径**（横向标签条 / 纵向标签列 / 三态侧栏全部引用这一份）。
 *
 *   glyph —— 图标本体边长（`<img>` 的内容框）
 *   pad   —— 图标本体与底板边缘之间的留白
 *   box   —— 底板的边长 = glyph + 2 × pad，同时也是**图标槽**的边长
 *
 * 为什么收成常量：此前横向标签条把 16/2/5 写在 CSS、纵向行把同一组字面量写在 JS 内联，
 * 同一个格子在两处各有一份 —— 一改就漂，且"纵向看起来比横向小一圈"这种差异
 * 根本无从对齐（用户原话）。现在是**一份数字、两处消费**。
 */
export const FAVICON_GLYPH = 18
export const FAVICON_PAD = 2
export const FAVICON_BOX = FAVICON_GLYPH + FAVICON_PAD * 2
/** 底板圆角（favicon / 首字兜底 / 内部页图标共用一套观感）。 */
const FAVICON_RADIUS = 5

/**
 * 图标槽：**glyph + 2 × pad = FAVICON_BOX**（与行内按钮同高，容得下完整的底板）。
 *
 * 为什么槽位固定而不管里面有没有图标：图标位**必须在场**。
 * 没有 favicon 时若整个槽位消失（旧实现：`img` 一 `display:none`，槽位一起没），
 * 图标条形态（侧栏折叠 / 悬停浮出的静止态）下标题也被隐藏 —— 那一行就只剩一条细缝
 * （用户原话："缩起时变成薄薄一条"）。固定槽位 + 首字兜底，行高与图标位永远稳定。
 *
 * 观感走内联而不是写进两种模式各自的 CSS：这些数字是**图标槽自己**的口径，
 * 与"横向留多宽 / 纵向留多高"无关；写在这里，横竖两端永远同一份。
 */
const ICON_SLOT_CSS = `display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:${FAVICON_BOX}px;height:${FAVICON_BOX}px;border-radius:${FAVICON_RADIUS}px;background-color:var(${TAB_FAVICON_BG_VAR},currentColor);transition:background-color var(--ng-anim-fast,120ms) var(--ng-anim-ease,ease);`

/**
 * favicon 本体：glyph 内容框 + pad 边 = box 的跟随前景色底板。
 *
 * `box-sizing: content-box` 是硬要求：纵向列表的宿主有 `.vtabs * { box-sizing: border-box }`，
 * border-box 下 padding 会**吃掉**图标本体（16px 只剩 12px 画图）——
 * 那正是"侧栏图标比别处小一圈"的另一半来历。内联优先级高过那条通配规则。
 */
const FAVICON_CSS = `width:${FAVICON_GLYPH}px;height:${FAVICON_GLYPH}px;box-sizing:content-box;padding:${FAVICON_PAD}px;border-radius:${FAVICON_RADIUS}px;background-color:transparent;object-fit:contain;flex-shrink:0;`
/**
 * 内部页图标（`hira://page-icon/?p=…`）**自带白底**：字形与底色画在同一张位图里，
 * 所以这一格不再套 CSS 白底与内边距 —— 否则半像素吸附会让字形偏离白底中心。
 * 盒子仍是 FAVICON_BOX，布局零变化；白底与圆角由图标自己画。
 * 判据只有一处（`isPageIconUrl`），且**每次渲染都按当前 src 重算** ——
 * 标签的 favicon 可能从普通图标变成内部页图标（反之亦然），不能只在建行时定死。
 */
const FAVICON_SELF_BADGED_CSS = `width:${FAVICON_BOX}px;height:${FAVICON_BOX}px;box-sizing:content-box;padding:0;border-radius:${FAVICON_RADIUS}px;background:transparent;object-fit:contain;flex-shrink:0;`
/**
 * 首字兜底块：与 favicon 的底板**逐像素同尺寸**（同色同圆角），只是内容换成一个字。
 *
 * `line-height` 取**内容框高（glyph）**而不是 `1`：字形是按**行盒**排的，行盒比字形矮时
 * 上下留白不对称，同一个字看起来就偏沉一点（用户："有的图标会下沉一点点" —— 「有的」正是
 * 这些没有 favicon、显示首字的行）。行盒 = 格子高，字形的 em 盒才会真正居中。
 */
const LETTER_CSS = `display:none;align-items:center;justify-content:center;width:${FAVICON_GLYPH}px;height:${FAVICON_GLYPH}px;box-sizing:content-box;padding:${FAVICON_PAD}px;border-radius:${FAVICON_RADIUS}px;background-color:transparent;font-family:${uiFontVar()};font-size:${Math.round(FAVICON_GLYPH * 0.66)}px;font-weight:600;line-height:${FAVICON_GLYPH}px;color:var(${TAB_FAVICON_FG_VAR},var(--hira-bg-elevated,#fff));user-select:none;-webkit-user-select:none;transition:color var(--ng-anim-fast,120ms) var(--ng-anim-ease,ease);`
/** 无痕标识：与图标槽同尺寸，字号随槽位等比放大（此前写死 14px/16px 会显得空）。 */
const INCOGNITO_CSS = `font-size:${Math.round(FAVICON_BOX * 0.68)}px;line-height:${FAVICON_GLYPH}px;display:flex;align-items:center;justify-content:center;width:${FAVICON_BOX}px;height:${FAVICON_BOX}px;color:var(${TAB_FAVICON_FG_VAR},var(--hira-bg-elevated,#fff));`

/**
 * @param {{ classNames?: object }} [opts]
 * @returns {(key: keyof typeof DEFAULT_NAMES, extra?: string) => string}
 */
function classPicker(opts: { classNames?: TabIconClassNames } = {}) : (key: keyof typeof DEFAULT_NAMES, extra?: string) => string {
  const names = (opts && opts.classNames) || {}
  return (key: IconPart, extra?: string): string => {
    const base = names[key] || DEFAULT_NAMES[key]
    return extra ? `${base} ${extra}` : base
  }
}

/**
 * 图标兜底字符：**标题（没有标题就用 URL）的第一个字**。
 *
 * @param {{ title?: string, url?: string }} tab
 * @returns {string} 空串 = 连一个字都取不到（调用方据此决定要不要画）
 */
export function faviconLetter(tab?: Pick<TabIconData, 'title' | 'url'> | null): string {
  const raw = String((tab && (tab.title || tab.url)) || '').trim()
  if (!raw) return ''
  // 只有 URL 时先去掉协议头 —— 否则首字永远是 "h"（https / http）
  const text = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  // 按字素取首字：`slice(0,1)` 会把 emoji / 代理对切成半个字符
  const first = Array.from(text)[0] || ''
  return first.toUpperCase()
}

/**
 * 图标位：favicon、**无痕标识**、或**标题首字兜底**（三选一）。
 *
 * @param {Document} doc
 * @param {{ favicon?: string, title?: string, url?: string, incognito?: boolean }} tab
 * @param {{ classNames?: object }} [opts] 允许注入类名（纵向行的 CSS 口径不同）
 * @returns {{ element: HTMLElement, favicon: HTMLImageElement|null, letter: HTMLElement|null, render: (patch?: object) => void }}
 *   · `element` —— 固定 FAVICON_BOX 的图标槽（**永远在场**）；
 *   · `favicon` —— 图片节点，无痕时为 null（`render` 对它天然免疫）；
 *   · `render(patch)` —— 共用渲染规则：**有 favicon 显图标，没有则显示标题首字**。
 *     横向标签条与纵向列表都调它（两处各写一遍必然出现"横排有兜底、纵排一条缝"）。
 *     补丁只给**变化的字段**（宿主 diff 只给变化项），故内部记着上一次的值。
 */
export function createTabFavicon(
  doc: Document,
  tab: TabIconData,
  opts: { classNames?: TabIconClassNames } = {}
): TabFaviconController {
  const cls = classPicker(opts)
  const data = tab || {}

  const box = doc.createElement('span')
  box.className = cls('iconBox')
  box.style.cssText = ICON_SLOT_CSS

  if (data.incognito) {
    const incognitoIcon = doc.createElement('span')
    incognitoIcon.className = cls('incognito')
    incognitoIcon.title = '无痕标签'
    incognitoIcon.textContent = '🕶'
    incognitoIcon.style.cssText = INCOGNITO_CSS
    box.appendChild(incognitoIcon)
    // 无痕标识是"这一格的唯一内容"：没有可换的图标，也没有兜底首字可言。
    return { element: box, favicon: null, letter: null, render() {} }
  }

  const img = doc.createElement('img')
  img.className = cls('favicon')
  img.alt = ''

  const letter = doc.createElement('span')
  letter.className = cls('letter')
  letter.setAttribute('aria-hidden', 'true')
  letter.style.cssText = LETTER_CSS
  box.append(img, letter)

  /** 当前状态（增量渲染用；见上面的 render 说明）。 */
  const state = { favicon: data.favicon || '', title: data.title, url: data.url }
  /** 最近一次**加载失败**的图标地址：同一张破图不再反复发请求（换图即自动重试）。 */
  let failedSrc = ''

  /**
   * 图标本体的几何**只在这里写一份**（横向标签条 / 纵向行都不再各写一套）。
   * 内部页图标自带白底，要换一套盒子；而 favicon 是**可变**的（可能从普通图标变成
   * 内部页图标），所以按当前 src 重算，并记住上一次的值免去重复写样式。
   */
  let selfBadged: boolean | null = null
  function paintFaviconBox() {
    const next = isPageIconUrl(state.favicon)
    if (next === selfBadged) return
    selfBadged = next
    img.style.cssText = next ? FAVICON_SELF_BADGED_CSS : FAVICON_CSS
  }

  /** 退回标题首字 —— 「本来就没有图标」与「图标加载失败」共用这一条渲染。 */
  function showLetter() {
    // 清 src 而不是只隐藏 —— 否则会残留上一站的图标字节，元素被复用时还会闪出旧图标。
    img.removeAttribute('src')
    img.style.display = 'none'
    const ch = faviconLetter(state)
    letter.textContent = ch
    letter.style.display = ch ? 'flex' : 'none'
  }

  // 破图降级：`hira://extension-icon` 在「扩展没有图标」时返回 404，不处理就会留下
  // 破图占位。只在**当前这张图**失败时回退（旧图的迟到 error 不能把新图标打掉）。
  img.addEventListener('error', () => {
    const failed = img.getAttribute('src') || ''
    if (!failed || failed !== state.favicon) return
    failedSrc = failed
    showLetter()
  })

  function render(patch?: TabIconData): void {
    if (patch) {
      // 只吸收**确实送来**的字段：`undefined` 是"本次没变"，不是"变成空"
      if (patch.favicon !== undefined) state.favicon = patch.favicon || ''
      if (patch.title !== undefined) state.title = patch.title
      if (patch.url !== undefined) state.url = patch.url
    }
    paintFaviconBox()
    if (state.favicon && state.favicon !== failedSrc) {
      // 同值不重设：避免每次标题变化都让浏览器对同一地址重新发起加载
      if (img.getAttribute('src') !== state.favicon) img.src = state.favicon
      img.style.display = ''
      letter.textContent = ''
      letter.style.display = 'none'
      return
    }
    showLetter()
  }
  render()

  return { element: box, favicon: img, letter, render }
}

/**
 * 音频 / 静音按钮（三态渲染见 `renderAudioState`）。
 *
 * 点击里 `stopPropagation` 是必需的：标签行的点击 = 切标签，
 * 音频按钮的点击必须止步于此，否则会顺带把标签选中。
 *
 * @param {Document} doc
 * @param {{ onToggleAudio?: () => void, size?: number }} [handlers]
 * @param {{ classNames?: object }} [opts]
 * @returns {{ element: HTMLButtonElement, update: (state: { muted?: boolean, isPlaying?: boolean }) => void }}
 */
export function createTabAudioButton(
  doc: Document,
  handlers: { onToggleAudio?: () => void; size?: number } = {},
  opts: { classNames?: TabIconClassNames } = {}
): TabAudioController {
  const cls = classPicker(opts)
  const audioBtn = doc.createElement('button')
  audioBtn.className = cls('audio')
  audioBtn.type = 'button'
  audioBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (typeof handlers.onToggleAudio === 'function') handlers.onToggleAudio()
  })
  const update = (state: Pick<TabIconData, 'muted' | 'isPlaying'>) =>
    renderAudioState(doc, audioBtn, state, { size: handlers.size })
  return { element: audioBtn, update }
}

/**
 * 横向标签条那一块：favicon（或无痕标识）+ 音频按钮，并排。
 *
 * @param {Document} doc
 * @param {TabIconData} tab 初始数据（favicon / muted / isPlaying / incognito）
 * @param {{ onToggleAudio?: () => void }} [handlers]
 * @param {{ classNames?: object }} [opts]
 * @returns {{ element: HTMLElement, favicon: HTMLImageElement|null, audioBtn: HTMLElement, update: (next: TabIconData)=>void }}
 */
export function createTabIconArea(
  doc: Document,
  tab: TabIconData,
  handlers: { onToggleAudio?: () => void; size?: number } = {},
  opts: { classNames?: TabIconClassNames } = {}
): TabIconAreaController {
  const cls = classPicker(opts)
  const data = tab || {}

  const element = doc.createElement('div')
  element.className = cls('area')

  const fav = createTabFavicon(doc, data, opts)
  element.appendChild(fav.element)

  const audio = createTabAudioButton(doc, handlers, opts)
  element.appendChild(audio.element)
  audio.update({ muted: data.muted, isPlaying: data.isPlaying })

  return {
    element,
    favicon: fav.favicon,
    audioBtn: audio.element,
    update(next: TabIconData) {
      const n = next || {}
      // favicon 与**兜底首字**共用同一条渲染规则：标题/URL 变了，首字也要跟着重画
      if (n.favicon !== undefined || n.title !== undefined || n.url !== undefined) {
        fav.render({ favicon: n.favicon, title: n.title, url: n.url })
      }
      if (n.muted !== undefined || n.isPlaying !== undefined) audio.update({ muted: n.muted, isPlaying: n.isPlaying })
    }
  }
}

/**
 * 渲染音频按钮的**三态**（静音 / 播放中 / 无）—— 横向标签条与纵向列表**共用**这一份。
 *
 * 为什么必须是共用函数：三态换图标 + 显隐 + 语义标签是一组**联动**规则，两处各写一遍
 * 就会出现"横排能静音、纵排点不动""一边有提示一边没有"这类只在某一模式出现的差异。
 *
 * ⚠ 语义用 `aria-label` 而不是 `title`：`title` 会冒出**系统原生**提示条，它不随主题、
 *   会盖住相邻行，在密集的标签行/侧栏行上是纯干扰。
 *
 * 同时写 `hidden` 属性与 `display` 两套显隐口径：两种模式的行各自用其中一种做判据
 * （纵向靠 `hasAttribute('hidden')` 决定是否播入场动效），两边都写才不会漏。
 *
 * @param {Document} doc
 * @param {HTMLElement} audioBtn
 * @param {{ muted?: boolean, isPlaying?: boolean }} state
 * @param {{ size?: number }} [opts]
 */
export function renderAudioState(
  doc: Document,
  audioBtn: HTMLButtonElement,
  state: Pick<TabIconData, 'muted' | 'isPlaying'> | null | undefined,
  opts: { size?: number } = {}
): void {
  if (!audioBtn) return
  const size = Number.isFinite(opts.size) ? opts.size as number : 14
  audioBtn.textContent = ''
  if (state && state.muted) {
    audioBtn.appendChild(VolumeX(doc, { size }))
    audioBtn.removeAttribute('hidden')
    audioBtn.style.display = ''
    audioBtn.setAttribute('aria-label', audioToggleLabel(true))
  } else if (state && state.isPlaying) {
    audioBtn.appendChild(Volume2(doc, { size }))
    audioBtn.removeAttribute('hidden')
    audioBtn.style.display = ''
    audioBtn.setAttribute('aria-label', audioToggleLabel(false))
  } else {
    audioBtn.setAttribute('hidden', '')
    audioBtn.style.display = 'none'
    audioBtn.removeAttribute('aria-label')
  }
}
