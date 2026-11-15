/**
 * panel-transfer.js —— 面板**宿主迁移 / 左右换位**按钮的渲染侧唯一入口（与任何具体面板无关）。
 *
 * 主进程的 `PanelPresentationService` 负责裁决与迁移，本文件只做三件事：
 *   1. 发 `panel:transfer` / 拉 `panel:transfer-state`（薄客户端，给所有宿主共用）；
 *   2. 在面板标题栏的按钮区画**同一个**切换按钮（侧栏 → 窗口 / 窗口 → 侧栏）；
 *   3. 面板声明了 `hostPage` 时，在同一个按钮区画「在页面中打开」（`hira://<host>`）。
 *
 * 为什么不放在各面板里：按钮是否出现由 manifest 声明（`presentation` / `hostPage`），
 * 位置由**宿主**统一决定 —— 面板作者写一遍就会和别处漂移一次（见 Doc PART15 §11.2 第 4 条）。
 *
 * 宿主差异只有两处，都由调用方以参数给出：
 *   · `detached` —— 我在窗口里还是侧栏里（决定按钮方向与文案）；
 *   · `compact`  —— 窄栏里按钮更小（32/28px），窗口里可以宽一点（32px）。
 */

import { iconByName } from '@hira-ng/ui-common/src/icons'
import { openUrlPreferExistingTab } from '@hira-ng/ui-common/src/bookmark-open'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'
import { tabsClient } from './tabs-client.js'

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/**
 * 请求换宿主。state 是面板自己的 `serialize()` 快照（只有数据，没有历史）。
 * @param {string} panelId
 * @param {'detach'|'dock'} direction
 * @param {unknown} [state]
 */
export function transferPanel(panelId: string, direction: 'detach'|'dock', state?: unknown) {
  return invoke(IPC_ROUTES.panelTransfer, {
    panelId: String(panelId),
    direction,
    ...(state === undefined ? {} : { state })
  })
}

/**
 * 把侧栏面板移到另一侧，并与对侧同类型槽位里的面板互换。
 * 主进程负责原子交换；渲染侧只发意图，不碰槽位或视图。
 */
export function swapPanelSides(panelId: string) {
  return invoke(IPC_ROUTES.panelSwapSides, { panelId: String(panelId) })
}

/**
 * 取走「迁移到本宿主」的状态（一次即焚）。
 * 新造的宿主（尤其是停靠回侧栏时那一个全新渲染进程）收不到迁移那一刻的广播 ——
 * 所以在 mount 之后调用一次，拿到就 `restore()`。
 * @param {string} panelId
 * @returns {Promise<unknown|null>}
 */
export function takePanelTransferState(panelId: string) : Promise<unknown|null> {
  return invoke(IPC_ROUTES.panelTransferState, { panelId: String(panelId) })
    .then((res) => (res && res.state !== undefined ? res.state : null))
    .catch(() => null)
}

/**
 * 标题栏「形态」按钮的**唯一**画法（换宿主 / 在页面中打开都走它）。
 *
 * 两个按钮必须同尺寸、同悬停、同层级 —— 各写一份样式，下次改一处就会漂移一处。
 * @param {Document} doc
 * @param {{ label: string, iconName: string, fallbackText: string }} opts
 */
function createHeaderActionButton(doc: Document, opts: { label: string, iconName: string, fallbackText: string }) {
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.setAttribute('aria-label', opts.label)
  btn.title = opts.label
  btn.style.cssText = `
    width: 28px; height: 28px; border: none; background: transparent;
    color: var(--hira-text-secondary, #6b7280); cursor: pointer;
    border-radius: var(--hira-radius-sm, 8px);
    display: flex; align-items: center; justify-content: center;
    -webkit-app-region: no-drag;
    transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  `
  const glyph = iconByName(opts.iconName, doc, { size: 15 })
  if (glyph) btn.appendChild(glyph)
  else btn.textContent = opts.fallbackText

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'var(--hira-surface-soft, rgba(0,0,0,0.04))'
    btn.style.color = 'var(--hira-text-primary, #1a1a1a)'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent'
    btn.style.color = 'var(--hira-text-secondary, #6b7280)'
  })
  return btn
}

/**
 * 在面板标题栏的按钮区挂上切换按钮。
 *
 * @param {HTMLElement} actionsEl `createPanelShell(...).actions`（`margin-left:auto` 的那一格）
 * @param {{
 *   panelId: string,
 *   presentation?: 'dock'|'both',
 *   detached?: boolean,
 *   compact?: boolean,
 *   doc?: Document,
 *   serialize?: () => unknown
 * }} opts
 * @returns {HTMLButtonElement|null} 未挂载（`presentation !== 'both'`）时返回 null
 */
export function mountPanelTransferButton(actionsEl: HTMLElement, opts: {
  panelId: string,
  presentation?: 'dock'|'both',
  detached?: boolean,
  compact?: boolean,
  doc?: Document,
  serialize?: () => unknown
}) : HTMLButtonElement|null {
  if (!actionsEl) return null
  const { panelId } = opts || {}
  if (!panelId) return null
  // 只在面板自己声明了可拆时才画 —— 缺省（dock）与改造前一字不差：没有这颗按钮。
  if (opts.presentation !== 'both') return null

  const doc = opts.doc || actionsEl.ownerDocument || document
  const detached = !!opts.detached
  const label = detached ? '停靠回侧栏' : '在窗口中打开'
  /**
   * 字形分工（别借别人的语义）：
   *   · 拆出去 = `DetachWindow`（一块窗口 + 后方错位探出的另一块窗口）；
   *   · 收回来 = `PanelRight`（矩形被竖线分成侧栏一格 —— 与 rail 的面板入口同源）。
   * `ExternalLink` 说得是"去外部页面"，放这里会被读成"上网"。
   */
  const iconName = detached ? 'PanelRight' : 'DetachWindow'

  const btn = createHeaderActionButton(doc, {
    label,
    iconName,
    fallbackText: detached ? '⇤' : '⇱'
  })
  btn.dataset.panelTransfer = panelId

  let busy = false
  btn.addEventListener('click', async () => {
    if (busy) return
    busy = true
    btn.disabled = true
    btn.style.opacity = '0.5'
    let state
    try { state = typeof opts.serialize === 'function' ? opts.serialize() : undefined } catch (_) { state = undefined }
    try {
      await transferPanel(panelId, detached ? 'dock' : 'detach', state)
      // 成功时本宿主会被主进程关掉（侧栏面板销毁 / 窗口 destroy），不必复位。
    } catch (e) {
      console.error('[panel-transfer] 切换形态失败:', e)
      busy = false
      btn.disabled = false
      btn.style.opacity = ''
    }
  })

  actionsEl.appendChild(btn)
  return btn
}

/**
 * 侧栏面板标题栏的「左右换位」按钮。
 *
 * 只给真正拥有“侧”的宿主挂载（侧栏面板）；独立窗口没有左右槽位，不渲染这一颗。
 * 对侧普通位 / 钉住位分别与当前面板互换，具体裁决全在布局层。
 */
export function mountPanelSideSwapButton(
  actionsEl: HTMLElement,
  opts: { panelId: string, doc?: Document }
): HTMLButtonElement | null {
  if (!actionsEl) return null
  const panelId = String((opts && opts.panelId) || '')
  if (!panelId) return null

  const doc = opts.doc || actionsEl.ownerDocument || document
  const label = '移到另一侧（与对方面板互换）'
  const btn = createHeaderActionButton(doc, {
    label,
    iconName: 'ArrowLeftRight',
    fallbackText: '⇄'
  })
  btn.dataset.panelSideSwap = panelId

  let busy = false
  btn.addEventListener('click', async () => {
    if (busy) return
    busy = true
    btn.disabled = true
    btn.style.opacity = '0.5'
    try {
      const res = await swapPanelSides(panelId)
      if (!res || res.ok !== true) console.warn('[panel-swap] 换边请求未生效:', panelId)
    } catch (e) {
      console.error('[panel-swap] 换边失败:', e)
    } finally {
      busy = false
      btn.disabled = false
      btn.style.opacity = ''
    }
  })

  actionsEl.appendChild(btn)
  return btn
}

/**
 * 在面板标题栏的按钮区挂上「在页面中打开」。
 *
 * 只在目录项声明了 `hostPage` 时才画（manifest 一行，面板作者零实现）：
 * 同一块面板在内部页 `hira://<host>` 里有一份完整形态，用户需要**并排对照**
 * 或把它钉在标签栏里长驻时走这条路（侧栏放不下、独立窗口又不能并排阅读）。
 *
 * 三种形态的关系：
 *   · 侧栏面板 / 独立窗口 —— `panel:transfer` 负责来回搬；
 *   · 内部页             —— 本函数，开一个新标签。
 * 页面形态**不在**面板自己的实现里画按钮：谁宿主就该谁画，否则三处各画一遍。
 *
 * @param {HTMLElement} actionsEl 面板标题栏动作区
 * @param {{ hostPage?: string|null, doc?: Document }} opts
 * @returns {HTMLButtonElement|null} 没有页面形态时返回 null
 */
export function mountPanelPageButton(actionsEl: HTMLElement, opts: { hostPage?: string|null, doc?: Document }) : HTMLButtonElement|null {
  if (!actionsEl) return null
  const hostPage = String((opts && opts.hostPage) || '').trim()
  if (!hostPage) return null

  const doc = opts.doc || actionsEl.ownerDocument || document
  const label = '在页面中打开'
  /**
   * `AppWindow` = 本项目里"在标签页打开"的既有语义（见 ui-common/webSidebarHeader 的
   * open-in-tab），与窗口形态的 `DetachWindow` 成一对面：一格页面 / 一块独立窗口。
   * 原先借 `Globe` 会被读成"打开某个网站"，与"开内部页"不是一回事。
   */
  const btn = createHeaderActionButton(doc, { label, iconName: 'AppWindow', fallbackText: '↗' })
  btn.dataset.panelPage = hostPage

  let busy = false
  btn.addEventListener('click', () => {
    if (busy) return
    busy = true
    btn.disabled = true
    btn.style.opacity = '0.5'
    // `pageUrl()` 负责 host → `hira://<host>/`，未登记的 host 由页面层落兜底。
    openUrlPreferExistingTab(pageUrl(hostPage), tabsClient)
      .catch((e) => console.error('[panel-page] 打开页面失败:', hostPage, e && e.message))
      .finally(() => {
        busy = false
        btn.disabled = false
        btn.style.opacity = ''
      })
  })

  actionsEl.appendChild(btn)
  return btn
}



