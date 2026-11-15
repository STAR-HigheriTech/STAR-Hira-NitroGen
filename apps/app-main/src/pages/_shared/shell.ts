/**
 * 内部页外壳（左侧导航）· 挂载器
 *
 * 职责只有一件事：读 `shell-registry.ts`，把那条导航**注入当前文档**。
 * 它不认识任何具体页面、不复制任何页面的业务逻辑、不读写任何存储 ——
 * 页面的数据与交互仍旧由页面自己负责（这与旧 Hira `pages/manager` 那种
 * 「把所有页面逻辑复制进一个大文件再用 hidden 切换」的做法是两个物种）。
 *
 * 由 `runtime.js` 在模块求值时调用一次（所有内部页都 import 它）：
 *   - host 未登记        → 直接 return（jsdialog / pdf / error / newtab… 全部不受影响）
 *   - 登记但 shell='own' → 直接 return（设置页自带导航，避免两条一模一样的侧栏）
 *   - 其余               → 建导航并 prepend 进 `<body>`
 *
 * 左侧**占位**不在这里做：构建期已经把 `SHELL_ATTR` 写进页面的 `<html>`
 * （`electron.vite.config.js#markShellPlaceholder`），CSS 在首帧就按"有侧栏"排版，
 * 所以切页不会出现"内容先满宽、再被挤到右边"的抖动。这里补一次标记只是给
 * 运行期动态生成的页面（磁盘发现出来的新页）兜底，对已构建的页面是幂等覆盖。
 *
 * ── 与插件开关联动（侧栏也走"插件化同步"）─────────────────────────────
 *   条目的引擎归属**不在这里判**：每一页背后的功能面由 `pages.mjs#pageFeature()`
 *   回答（与 ⋮ 菜单 / 应用菜单 / 页面右键同一份真源）。本文件只负责在渲染时
 *   问一句 `features-client.js#isFeatureAvailable()` —— 引擎被显式关掉 → 条目不出现。
 *   插件启停经 `plugins:changed` 广播回来，侧栏就地重画，不需要刷新页面。
 *
 *   冷启动**挂载即可见**，不等可用性答案：答案到达后 `renderNav` 幂等重画，
 *   被关掉的条目就地消失。之前"先隐形等第一条答案"会让侧栏凭空晚 0.5s 才出现，
 *   那正是内部页"感觉加载慢"的来源之一 —— 侧栏本来就该是首帧的一部分。
 *   fail-open 与占位（`SHELL_ATTR`，构建期就写进 `<html>`）都是既有取向，不变。
 *
 * 跳转用**原生 `<a href>`**：深链接、前进/后退、中键、Ctrl+点击、右键菜单全部沿用
 * 浏览器既有语义，不需要拦截点击，也不需要 postMessage 中继。
 */

import { SHELL_SECTIONS, SHELL_ATTR, usesSharedShell } from './shell-registry.js'
import { pageIconSvg } from './icons.js'
import { pageFeature, pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import { isFeatureAvailable, onFeatureAvailability } from './features-client.js'

/** 导航标题（侧栏顶部那行小字）。 */
const SHELL_TITLE = '内部页面'

/**
 * 建一个导航项。
 * @param {Document} doc
 * @param {{ host: string, label: string }} page
 * @param {string} currentHost
 * @returns {HTMLAnchorElement}
 */
interface ShellPage { host: string; label: string; shell: string }

function buildItem (doc: Document, page: ShellPage, currentHost: string): HTMLAnchorElement {
  const active = page.host === currentHost
  const item = doc.createElement('a')
  item.className = 'hira-shell-item' + (active ? ' active' : '')
  item.href = pageUrl(page.host)
  if (active) item.setAttribute('aria-current', 'page')

  const ico = doc.createElement('span')
  ico.className = 'ico'
  const svg = pageIconSvg(doc, page.host)
  if (svg) ico.appendChild(svg)

  const label = doc.createElement('span')
  label.className = 'label'
  label.textContent = page.label

  item.append(ico, label)
  return item
}

/**
 * 这一页现在该不该出现在侧栏里。
 *
 * 未登记 `feature` 的页面（设置 / 插件中心 / 键盘快捷键 / 工具页…）恒显示；
 * 登记了的页面在引擎被**显式关掉**时消失（不知道答案时按可用处理，fail-open）。
 * @param {{ host: string }} page
 * @returns {boolean}
 */
function isPageVisible (page: ShellPage): boolean {
  const feature = pageFeature(page.host)
  return !feature || isFeatureAvailable(feature)
}

/**
 * 按最新可用性重画整条导航（幂等：可重复调用）。
 * @param {HTMLElement} nav
 * @param {string} currentHost
 * @returns {number} 画出来的条目总数（0 = 一个入口都没有，调用方据此收起侧栏占位）
 */
function renderNav (nav: HTMLElement, currentHost: string): number {
  const doc = nav.ownerDocument
  nav.textContent = ''

  const title = doc.createElement('div')
  title.className = 'hira-shell-title'
  title.textContent = SHELL_TITLE
  nav.appendChild(title)

  let count = 0
  for (const section of SHELL_SECTIONS) {
    // 只含「现在要显示的条目」：自带导航的页面（shell='own'）仍然是可跳转目的地，
    // 所以 filter 只按"是否在当前文档里画"来分，不在这里剔条目。
    const pages = section.pages.filter(isPageVisible)
    if (!pages.length) continue
    const group = doc.createElement('div')
    group.className = 'hira-shell-group'
    if (section.label) {
      const groupLabel = doc.createElement('div')
      groupLabel.className = 'hira-shell-group-label'
      groupLabel.textContent = section.label
      group.appendChild(groupLabel)
    }
    for (const page of pages) group.appendChild(buildItem(doc, page, currentHost))
    nav.appendChild(group)
    count += pages.length
  }
  return count
}

/**
 * 在当前文档挂载内部页导航（重复调用幂等）。
 * @returns {HTMLElement | null} 新建的导航；不该挂载时返回 null
 */
export function mountShell (): HTMLElement | null {
  const host = String(location.hostname || '').toLowerCase()
  if (!usesSharedShell(host)) return null
  if (document.querySelector('.hira-shell')) return null

  const mount = (): HTMLElement => {
    // 已构建页面的标记在 HTML 里，这里再写一次是幂等的（动态页兜底）。
    document.documentElement.setAttribute(SHELL_ATTR, '1')

    const nav = document.createElement('nav')
    nav.className = 'hira-shell'
    nav.setAttribute('aria-label', SHELL_TITLE)
    // 先按 fail-open 画一遍并**立刻可见**：答案到达后在 apply 里幂等重画。
    renderNav(nav, host)
    ;(document.body || document.documentElement).prepend(nav)

    const apply = (): void => {
      const count = renderNav(nav, host)
      // 所有条目都被关掉时：连标题一起收起来，并撤掉占位让内容回到全宽。
      // 只撤占位不藏 nav 会把「内部页面」那行字留在空白处、压在内容上。
      // 重新启用插件后同一段逻辑把占位与条目一起恢复。
      nav.style.display = count ? '' : 'none'
      if (count) document.documentElement.setAttribute(SHELL_ATTR, '1')
      else document.documentElement.removeAttribute(SHELL_ATTR)
    }
    onFeatureAvailability(apply)
    return nav
  }

  if (document.body) return mount()
  document.addEventListener('DOMContentLoaded', mount, { once: true })
  return null
}
