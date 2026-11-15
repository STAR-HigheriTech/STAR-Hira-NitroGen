/**
 * panels/host.js —— 面板**宿主**（通用装配层）。
 *
 * 与 `main.js`（薄引导）分工：
 *   · main.js：注入基底样式 → 画壳 → 起主题 → 预取面板实现 → `import('./host.js')`
 *   · 本文件：一切"重活" —— 端口（IPC 客户端 / 菜单 / 插槽 / 图标）、工具栏插槽、
 *     宽度拖拽手柄、面板实现的解析与挂载。
 *
 * 为什么必须分开：面板视图**关闭即销毁**，每开一次都是冷进程。本文件静态引入的
 * 十来个客户端 + 插件系统，全部只在"壳已经出现在屏幕上"之后才有意义 ——
 * 把它们放进首帧，就是让用户盯着旧面板多等一次模块求值。
 *
 * 这个文件不认识任何一个具体面板。它的职责只剩 4 件：
 *   1. 问主进程要**面板目录**（拿标题）—— 目录源自插件 manifest，是唯一事实源
 *   2. 解析这块面板的实现（插件自带 render 入口 优先，回落到 `ui/ui-panel-*` 包）
 *   3. 把「端口」（IPC 客户端、菜单、确认框、图标…）注入面板并挂载
 *   4. 装配宿主自己的 chrome（工具栏插槽 / 拖拽手柄 / 事件订阅）
 *
 * 于是「加一个面板」= 加一个 ui-panel-* 包 + 一个插件 manifest，**不需要动这两个文件**。
 *
 * 为什么是「端口注入」而不是让面板包自己 import 客户端：`renderer/shared/*-client.js`
 * 属于 APPS 层，`ui/*` 包若直接 import 就成了 UI → APPS 反向依赖（违反 CONTRACT-11）。
 * 端口注入让面板包对「怎么跟主进程说话」保持零知识，同时不破坏分层。
 */

import { iconByName } from '@hira-ng/ui-common/src/icons'
import { injectPanelStyles } from '@hira-ng/ui-common/src/panelKit'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { panelsClient, settingsClient, pluginsClient } from '../shared/hira-client.js'
import { slotsClient } from '../shared/slots-client.js'
import type { SlotRenderItem } from '../shared/slots-client.js'
import { defineRendererSlots, callRendererSlotMulti, reduceRendererSlot, activateRendererSlots } from '../shared/plugin-slots.js'
import { layoutClient } from '../shared/layout-client'
import { getHiraBridge } from '../shared/bridge.js'
import type { RendererBridge } from '../shared/bridge.js'
import type { PanelDefinition, PanelInstance } from '../shared/panel-definition.js'
import type { PanelCatalogEntry } from '../shared/panels-client.js'
// 端口工厂 / 实现解析 / 标签菜单工厂：与 detached-panel 窗口**共用同一份**（见各文件头）。
import { createPanelContext, createTabRowMenu, setPanelRefresh, refreshPanel } from '../shared/panel-context.js'
import { slotPort } from '../shared/panel-slot-port.js'
import { resolvePanelDefinition, getPanelResolveError } from '../shared/panel-resolve.js'
import { normalizePanelInstance } from '../shared/panel-instance.js'
// 面板换宿主（侧栏 ↔ 独立窗口）的渲染侧薄客户端 —— 与 detached-panel 窗口共用同一份。
import {
  mountPanelSideSwapButton,
  mountPanelTransferButton,
  mountPanelPageButton,
  takePanelTransferState
} from '../shared/panel-transfer.js'

// 原子层（`.hp-*`）此刻才补齐：它只服务面板**内容**，不该挡住第一帧的壳。
injectPanelStyles(document)

// ─────────────────────────────────────────────────────────────
// 渲染侧插槽（`plugin-slots.js`）—— 面板进程宿主中的那几个
// ─────────────────────────────────────────────────────────────
//
// 这一进程是**所有面板**的共同宿主，因此"往面板的某个位置挂东西"的插槽都在这里声明。
// 声明的意义不是"我要用"，而是**过滤**：激活时会把没人宿主的实现挑出来告警
// （见 plugin-slots.js#activateRendererSlots）—— 静默丢弃是插件作者最查不到的一类问题。
//
//   · `side-panel.panel-render-slot`   MULTI —— 往侧栏展开区（面板内容区）追加面板主体
//   · `side-panel.panel-header-renderer` REDUCE —— 改写面板头部的渲染描述符
//   · `download.state-badge-renderer`  SINGLE —— 下载行的状态角标
//   · `bookmark.tree-renderer-item`    REDUCE —— 逐层包裹书签树的行
//   · `note.card-renderer`             SINGLE —— 替换集锦卡片主体
//   · `note.capture-provider`          MULTI —— 往「添加当前页面」注入新抓取源
//   · `note.export-format`             MULTI —— 往集锦「导出」注入新格式
//
// `download.state-badge-renderer` / `bookmark.tree-renderer-item` 的**调用方在 ui 包里**
// （ui-panel-downloads / ui-panel-favorites）。它们不该
// import 插件系统（CONTRACT-11：ui 不得依赖 apps），所以通过下面这份**通用端口**反向注入：
// 面板只拿到 `slots.call(id, payload, fallback)` 这样的函数，对"谁实现、怎么注册"零知识。
defineRendererSlots([
  'side-panel.panel-render-slot',
  'side-panel.panel-header-renderer',
  'download.state-badge-renderer',
  'bookmark.tree-renderer-item',
  // 笔记 / 集锦：调用方是插件自带的面板（apps/app-main/plugins/panel-notes.renderer.js），
  // 走同一个 ctx.slots 端口 —— 扩展点开在公开插槽表里，面板本身不认识插件系统。
  'note.card-renderer',
  'note.capture-provider',
  'note.export-format'
])

/** 注入给面板的通用插槽端口在 `shared/panel-context.js`（两个宿主共用）。 */

// ─────────────────────────────────────────────────────────────
// 面板宽度拖拽手柄
// ─────────────────────────────────────────────────────────────
/**
 * 为什么手柄归**面板渲染进程**所有，而不是 rail：
 *
 *   rail 的 WebContentsView 只有 48px 宽，而手柄必须出现在「面板右边缘」
 *   （48 + 面板宽 ≈ 400px 处）—— 一旦定位过去就落在 view 之外**被原生裁剪**：
 *   既看不见、也点不到；第一次拖拽后 mousemove / mouseup 全部丢失，
 *   表现就是「调节条在 rail 边上」+「只能调一次」。
 *
 *   本进程的 view 宽度**恰好就是**面板宽度：手柄贴边即在 view 之内；
 *   拖拽时面板随光标扩张，光标始终留在 view 边缘，事件不会丢 —— 可反复调节且完全跟手。
 *
 * 位置随侧栏所在侧翻转：靠左贴右边缘（向右拖变宽），靠右贴左边缘（向左拖变宽）。
 * 区间与主进程 LayoutCoordinator#setPanelWidth 的校验保持一致（200~600）。
 */
const PANEL_MIN_WIDTH = 200
const PANEL_MAX_WIDTH = 600

let sidebarOnRight = false
/** 本面板当前所在的一侧 —— 宽度读写都要带上它（两侧各有独立宽度与记忆）。 */
let currentSide: 'left' | 'right' = 'left'
/**
 * 本面板此刻是否在**钉住位**（常驻那一格）。
 *
 * 同一侧有普通位与钉住位两格，宽度**各记各的** —— 拖钉住面板的边不该改到普通位的宽度。
 * 真值在主进程，随 `panel:side` / `panel:side-changed` 一起下发（`pinned`）。
 */
let currentPinned = false
/** 是否已经从主进程拿到过**确定的侧**（决定第一次推送要不要补一次宽度记忆）。 */
let sideSynced = false
let resizing = false
let resizeStartX = 0
let resizeStartWidth = 0
let requestedWidth = 0
let pendingWidth = 0
let pendingFrame = 0
let resizeHandle: HTMLDivElement | null = null
let resizeStyleInjected = false

function ensureResizeHandle() {
  if (resizeHandle) return resizeHandle
  if (!resizeStyleInjected) {
    resizeStyleInjected = true
    const resizeStyle = document.createElement('style')
    resizeStyle.textContent = `
  .panel-resize-handle {
    position: fixed; top: 0; bottom: 0; width: 6px; cursor: col-resize;
    background: transparent; z-index: var(--hira-z-controls, 40);
  }
  .panel-resize-handle::after {
    content: ''; position: absolute; top: 0; bottom: 0; width: 1px;
    background: transparent; transition: background 0.12s ease;
  }
  .panel-resize-handle--left { left: 0; }
  .panel-resize-handle--right { right: 0; }
  .panel-resize-handle--left::after { left: 0; }
  .panel-resize-handle--right::after { right: 0; }
  .panel-resize-handle:hover::after,
  .panel-resize-handle--dragging::after { background: var(--hira-accent, #3b82f6); }
`
    document.head.appendChild(resizeStyle)
  }
  const handle = document.createElement('div')
  resizeHandle = handle
  handle.className = 'panel-resize-handle panel-resize-handle--right'
  document.body.appendChild(handle)
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    resizing = true
    // ⚠ 必须用 screenX（屏幕坐标），不能用 clientX：
    // 右侧面板的视图 x 会随宽度改变（贴右缘 → x = 窗口宽 − 宽），拖拽时视图自己也在动，
    // 而 clientX 是**相对本视图**的坐标 —— 手柄在视图左缘、视图跟着指针跑，指针在视图里
    // 几乎没位移，算出来的 delta 恒接近 0，宽度就在原点附近来回微调（抖动 + 逐帧重设原生
    // bounds 的残影）。屏幕坐标与视图无关，两侧都稳。左侧之所以一直正常，正是因为它的
    // 视图 x 恒定（= sidebarWidth），clientX 恰好等价于屏幕位移。
    resizeStartX = e.screenX
    // 本进程视口宽度即面板宽度，直接读 —— 省一次与主进程的往返
    resizeStartWidth = Math.round(window.innerWidth)
    requestedWidth = resizeStartWidth
    handle.classList.add('panel-resize-handle--dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return
    const delta = sidebarOnRight ? resizeStartX - e.screenX : e.screenX - resizeStartX
    const next = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, resizeStartWidth + delta))
    requestedWidth = next
    pendingWidth = next
    if (!pendingFrame) pendingFrame = requestAnimationFrame(flushResizeWidth)
  })
  window.addEventListener('mouseup', endResize)
  window.addEventListener('blur', endResize)
  return handle
}

/** 每帧最多上报一次：拖拽期 mousemove 频率远高于一次布局重算的成本。 */
function flushResizeWidth() {
  pendingFrame = 0
  const width = pendingWidth
  if (!width) return
  pendingWidth = 0
  // side / slot：两侧 × 两位各有独立宽度 —— 拖钉住位不该改到同侧普通位的宽度
  layoutClient.setPanelWidthLive(width, currentSide, currentPinned ? 'pinned' : 'normal')
}

/** 宽度记忆的设置键：普通位 / 钉住位各一条（按侧再分）。 */
function widthSettingKey() {
  return currentPinned
    ? `app.panel_pinned_width_${currentSide}`
    : `app.panel_width_${currentSide}`
}

function endResize() {
  if (!resizing) return
  resizing = false
  if (resizeHandle) resizeHandle.classList.remove('panel-resize-handle--dragging')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  if (pendingFrame) {
    cancelAnimationFrame(pendingFrame)
    pendingFrame = 0
  }
  pendingWidth = 0
  // 宽度记忆：按**本面板所在的那一侧 × 所在的位**存（设置项，随 profile 落盘）。
  // 不复用 rail 那套 localStorage：它是全局单值，两侧会互相覆盖，也不随 profile 隔离。
  const w = requestedWidth || Math.round(window.innerWidth)
  // 拖动帧已经单向跟手；松手这一次才需要主进程回包确认，并作为最终几何落点。
  layoutClient.setPanelWidth(w, currentSide, currentPinned ? 'pinned' : 'normal').catch(() => {})
  settingsClient.set(widthSettingKey(), w).catch(() => {})
}

/**
 * 本面板的位状态（侧 + 是否钉住）—— 手柄贴哪条边、宽度写哪个槽，全由它决定。
 * @param {'left'|'right'} position
 * @param {boolean} [pinned]
 */
function setHandleSide(position: 'left'|'right', pinned?: boolean) {
  sidebarOnRight = position === 'right'
  currentSide = sidebarOnRight ? 'right' : 'left'
  currentPinned = pinned === true
  if (!resizeHandle) return
  resizeHandle.classList.toggle('panel-resize-handle--right', !sidebarOnRight)
  resizeHandle.classList.toggle('panel-resize-handle--left', sidebarOnRight)
}

/**
 * 采用「本侧记着的宽度」。
 *
 * 为什么要渲染侧推：宽度状态在主进程（LayoutCoordinator），而它只知道自己那份默认值 ——
 * 新开的窗口 / 刚启动时，某个位可能还没被 applier 灌过记忆值。面板宿主每次知道自己
 * 是哪一侧时顺便把这条记忆推一次，就自愈了（同值会被主进程短路，不会白重排）。
 */
function restorePanelWidth() {
  const key = widthSettingKey()
  const slot: 'pinned' | 'normal' = currentPinned ? 'pinned' : 'normal'
  return settingsClient.get(key)
    .then((saved) => {
      const n = Math.floor(Number(saved))
      if (Number.isFinite(n) && n >= PANEL_MIN_WIDTH && n <= PANEL_MAX_WIDTH) {
        return layoutClient.setPanelWidth(n, currentSide, slot)
      }
      return null
    })
    .catch(() => {})
}

/**
 * 面板内容区的**补充主体**（`side-panel.panel-render-slot`，MULTI）。
 *
 * 与 `entry.render` 那条路的分工：
 *   · `entry.render` 导出 `panelDefinition` —— 插件**拥有**这块面板（标题、样式、自己的
 *     生命周期都要自己管），适合"我就是这个面板"；
 *   · 本插槽 —— 插件只**补一块内容**，宿主的面板本体照旧渲染，补的那块接在下面。
 * 于是"给任意面板加一段自己的东西"不需要先写一整个 panelDefinition。
 *
 * 只收元素节点：插件返回字符串/数字会被静默忽略（与 tabbar 装饰层同一条判据 ——
 * 拿到一段没法定位样式的文本，挂上去只会是丑陋的裸字）。
 *
 * @param {HTMLElement} container 面板内容区（createPanelShell 的 content）
 * @param {string} panelId
 * @param {string} title
 * @returns {number} 实际挂上去的块数（调用方据此决定要不要跳过「未实现」占位）
 */
function mountPanelBodies(container: HTMLElement, panelId: string, title: string) : number {
  const out = callRendererSlotMulti('side-panel.panel-render-slot', { panelId, title })
  let mounted = 0
  for (const node of out) {
    if (!(node instanceof HTMLElement)) continue
    node.classList.add('side-panel__plugin-body')
    container.appendChild(node)
    mounted += 1
  }
  return mounted
}

/**
 * 标签行右键菜单工厂 / 刷新目标：与 detached-panel 窗口共用（见 shared/panel-context.js）。
 * 侧栏面板、独立面板窗口、横向标签条、纵向标签列因此逐项一致。
 */

/** 官方插槽 id（PART7 §7.3）。主进程侧只放行白名单里的插槽。 */
const TOOLBAR_SLOT = 'side-panel.toolbar-action-slot'

/**
 * 动作区里属于「工具栏插槽」的那一组按钮（懒建、插在最前）。
 *
 * 与「面板换宿主」按钮共用同一个 `actions` 容器，但各管各的子树：
 * 工具栏重挂时只清自己这一组，切换按钮不受影响（见 mountToolbarActions 的注释）。
 *
 * @param {HTMLElement} container createPanelShell 的 actions 容器
 * @returns {HTMLDivElement}
 */
function toolbarActionGroup(container: HTMLElement) : HTMLDivElement {
  let group = container.querySelector<HTMLDivElement>('[data-panel-toolbar]')
  if (group) return group
  group = document.createElement('div')
  group.setAttribute('data-panel-toolbar', '')
  group.style.cssText = 'display: flex; align-items: center; gap: 4px; flex-shrink: 0;'
  container.insertBefore(group, container.firstChild)
  return group
}

/**
 * 把插件贡献的工具栏按钮挂进面板头部。
 *
 * 分工：**描述符由主进程给，画由渲染层做** —— 实现（含 onSelect 闭包）住在主进程，
 * 过 IPC 前函数已被剥掉，这里只拿到纯数据 + 一个稳定 key；点击时把 key 送回主进程派发。
 * 见 `shared/slots-client.js` 与 `main/slot-render.js` 的说明。
 *
 * 按钮样式与关闭按钮同一套（透明的图标按钮 + hover 变亮）—— 工具栏是同一行里的
 * 同级元素，视觉上不该像"另一套控件"。
 *
 * @param {HTMLElement} container createPanelShell 的 actions 容器
 * @param {string} panelId
 */
async function mountToolbarActions(container: HTMLElement, panelId: string) {
  // 动作区里不止工具栏（宿主统一渲染的「面板换宿主」按钮也住在这里），
  // 所以本函数只清**自己那一组** —— 整块 `textContent = ''` 会把切换按钮一起抹掉，
  // 且 `plugins:changed` 重挂工具栏时就会静默消失。
  const group = toolbarActionGroup(container)
  let items: SlotRenderItem[] = []
  try {
    items = await slotsClient.render(TOOLBAR_SLOT, { panelId })
  } catch (e) {
    // 插槽取不到不是错误路径：没有插件贡献时返回的就是空数组，
    // 这里只兜住 IPC 本身失败（主进程未就绪 / 通道异常）。
    return
  }
  group.textContent = ''
  for (const item of items) {
    const descriptor = item.descriptor
    const d = descriptor && typeof descriptor === 'object'
      ? descriptor as Record<string, unknown>
      : {}
    const label = typeof d.label === 'string' ? d.label.trim() : ''
    // descriptor 没有可用 label 的项直接跳过：主进程侧已剥掉函数，
    // 一个既没名字也画不出来的按钮只会占位。
    if (!label) continue

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.title = label
    btn.style.cssText = `
      width: 24px; height: 24px; border: none; background: transparent;
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px); padding: 0; display: flex; align-items: center;
      justify-content: center; -webkit-app-region: no-drag;
      transition: background 0.15s ease, color 0.15s ease;
    `
    if (d.active === true) btn.style.color = 'var(--hira-accent, #3b82f6)'
    const iconEl = typeof d.icon === 'string' ? iconByName(d.icon, document, { size: 15 }) : null
    if (iconEl) btn.appendChild(iconEl)
    else btn.textContent = typeof d.text === 'string' && d.text ? d.text : label.slice(0, 1)

    if (d.disabled === true) {
      btn.disabled = true
      btn.style.opacity = '0.45'
      btn.style.cursor = 'default'
    } else {
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'var(--hira-hover-bg, rgba(0,0,0,0.06))'
        btn.style.color = 'var(--hira-text-primary, #1a1a1a)'
      })
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent'
        btn.style.color = d.active === true ? 'var(--hira-accent, #3b82f6)' : 'var(--hira-text-secondary, #6b7280)'
      })
      btn.addEventListener('click', () => {
        slotsClient.dispatch(TOOLBAR_SLOT, item.key, { panelId })
          .then((res) => { if (res && res.ok === false) console.warn('[panels] toolbar action failed:', res.reason) })
          .catch(() => {})
      })
    }
    group.appendChild(btn)
  }
}

/**
 * 解析某块面板的实现 —— 三级顺序与理由见 `shared/panel-resolve.js`（两个宿主共用）。
 */

/**
 * 「这块面板没有实现」到底为什么 —— 把 `panel-resolve.js` 记下的诊断翻成人话。
 *
 * 以前不论哪种原因都写「插件未提供 render 入口，也没有对应的 ui-panel-* 包」：
 * 对"插件写了 render 但加载崩了"、"面板 id 与模块导出不一致"这些情况全是误导，
 * 用户唯一能做的就是去翻控制台。现在每种失败都有自己的句子。
 *
 * @param {string} panelId
 * @param {object|null} entry 目录条目（有 = 目录承认这块面板存在）
 * @returns {string}
 */
function describeMissingPanel(panelId: string, entry: PanelCatalogEntry|null) : string {
  const diag = getPanelResolveError(panelId)
  if (!diag) {
    return entry
      ? `面板 ${panelId} 尚未实现（插件未提供 render 入口，也没有对应的 ui-panel-* 包）`
      : `未知面板：${panelId}`
  }
  if (diag.stage === 'load') {
    return `面板 ${panelId} 的渲染入口加载失败：${diag.message || '未知错误'}（详情见控制台）`
  }
  if (diag.stage === 'no-panel') {
    const ids = (diag.panelIds || []).filter(Boolean)
    return ids.length
      ? `插件 ${diag.pluginId} 的渲染入口里没有面板 ${panelId}（它导出的是：${ids.join('、')}）`
      : `插件 ${diag.pluginId} 的渲染入口没有导出任何面板`
  }
  if (diag.stage === 'no-entry') {
    return `面板 ${panelId} 尚未实现：${diag.message}`
  }
  return `面板 ${panelId} 不可用：${diag.message}`
}

/**
 * 启动作业：装配端口、挂工具栏与拖拽手柄、解析并挂载面板。
 *
 * 所有"本进程唯一"的状态都在这一次调用里建立（`ctx` / 侧栏订阅 / 刷新目标），
 * 所以**只该被调用一次** —— 由 main.js 在壳出现后调用。
 *
 * @param {{
 *   root: HTMLElement,
 *   shellApi: { shell: HTMLElement, content: HTMLElement, header: HTMLElement, actions: HTMLElement, closeBtn: HTMLElement, pinBtn: HTMLElement|null, setPinned: (pinned: boolean) => void, onPinnedChange: (fn: (pinned: boolean) => void) => () => void, updateHeader: (v: object) => void },
 *   panelId: string,
 *   urlTitle: string,
 *   urlPluginId: string,
 *   prefetched: Promise<object|null>|null,
 *   bridge: { provider: unknown, on: { subscribe: (route: string, fn: Function) => unknown } }
 * }} options
 */
export function startPanelHost(options: {
  root: HTMLElement,
  shellApi: { shell: HTMLElement, content: HTMLElement, header: HTMLElement, actions: HTMLElement, closeBtn: HTMLElement, pinBtn: HTMLElement|null, setPinned: (pinned: boolean) => void, onPinnedChange: (fn: (pinned: boolean) => void) => () => void, updateHeader: (v: object) => void },
  panelId: string,
  urlTitle: string,
  urlPluginId: string,
  prefetched: Promise<PanelDefinition|null>|null,
  bridge: RendererBridge
}) {
  const { root, shellApi, panelId, urlTitle, urlPluginId, prefetched } = options
  const bridge = options.bridge || getHiraBridge()
  const { shell, content, header, actions } = shellApi
  let layoutEditing = false

  /**
   * 把真实面板头作为可拖动层上报。面板内容是真实 WebContentsView，不能被 DOM 覆盖，
   * 所以工坊只绘制“头 + 外框”的 clone；移动在松手后通过 panel toggle 原子落位。
   */
  function reportEditorZone() {
    if (!layoutEditing || !sideSynced || !header) return
    try {
      const r = header.getBoundingClientRect()
      const width = Math.max(1, Math.round(window.innerWidth))
      const height = Math.max(1, Math.round(window.innerHeight))
      bridge.provider.send('buttons-edit:zone', {
        surface: 'panels',
        segments: [{
          key: currentSide,
          label: currentSide === 'right' ? '右侧面板' : '左侧面板',
          rect: { x: 0, y: 0, width, height },
          axis: 'column',
          grow: 'down',
          items: [{
            id: panelId,
            x: 0,
            y: Math.max(0, Math.round(r.top)),
            width,
            height: Math.max(28, Math.round(r.height || 38))
          }]
        }]
      })
    } catch (_) {}
  }

  /**
   * 面板挂载结果（`def.mount` 的返回值）。
   *
   * 存在的理由：切换按钮**先于**面板实现挂载（它在头部，面板在内容区），
   * 而「拆出窗口」要带走的那份状态得现问面板自己 —— 所以 serialize 做成
   * 晚绑定闭包，按钮点击那一刻读这里。未挂载 / 面板没提供 → undefined。
   */
  let mountedApi: PanelInstance | null = null

  if (root && shell && shell.parentNode !== root) root.appendChild(shell)

  // 宽度拖拽手柄：只为"知道自己住在哪一侧"这件事付一次 IPC，其余全是纯 DOM。
  ensureResizeHandle()

  /**
   * 标签 hover 预览浮层适配器（面板侧）。
   *
   * 面板是独立 WebContentsView，**面板内画的浮层一超出面板边界就被原生裁剪**，
   * 而预览恰恰要落在面板外侧（靠左时贴面板右缘、靠右时贴左缘）。因此统一走
   * tabpreview-overlay 这条独立浮层链路：本适配器只发意图，落位由主进程按
   * `app.sidebar_position` + 面板实际 bounds 裁定（LayoutCoordinator#anchorFloatBesidePanel）。
   *
   * 坐标约定：这里传的是**面板视图内**的坐标（行的 top），主进程会补上视图偏移
   * 换算成窗口坐标 —— 面板不需要知道自己在窗口里的位置。
   */
  const previewOverlay = {
    showTabPreview(payload: unknown) {
      try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayShow, payload) } catch (_) {}
    },
    hideTabPreview() {
      try { bridge.provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (_) {}
    },
    // 意图预热（与外壳侧同一条）：hover 起表那一拍后台载入浮层 renderer。
    warmTabPreview() {
      try { bridge.provider.send(IPC_ROUTES.floatWarm, { name: 'tabpreview-overlay' }) } catch (_) {}
    }
  }

  /**
   * 注入给面板的端口 —— 构造在 `shared/panel-context.js`（与 detached-panel 窗口共用）。
   * 本宿主唯一要多给的是 `previewOverlay`（面板外侧的浮层，只有窄栏面板需要）。
   * `compact: true` 是**形态差异声明**：本宿主是 200~600px 的窄栏，不是独立窗口。
   * `host: 'panel'` 是**记忆归属**：本宿主自己那一格"当前会话"，与窗口 / 内部页互不干扰。
   */
  const ctx = createPanelContext({
    bridge,
    panelId,
    compact: true,
    previewOverlay,
    slots: slotPort,
    host: 'panel'
  })

  // 侧栏面板都有“左右槽位”，因此换位入口在壳就位后立即挂上，不等目录 / 插件插槽。
  mountPanelSideSwapButton(actions, { panelId, doc: document })

  /**
   * 同步「本面板实际所在侧」—— 主进程是唯一知道真值的地方，只能问它。
   *
   * 为什么不能读 app.sidebar_position：两侧各有一个面板位，面板开在「打开它的入口」
   * 那一侧（rail 跟随设置，导航栏的面板按钮看它自己住哪），所以设置说"靠左"时，
   * 本面板也可能就在右边 —— 而拖拽手柄必须落在**面向内容**的那条边上、拖拽方向也随之
   * 相反，读设置会两边都错。
   *
   * ⚠ **拿到 null（还没落位）时绝不能猜一个侧**。面板视图的创建与加载**早于**它被放进
   * 槽位，所以宿主启动那一刻问"我在哪一侧"完全可能得到 null。原实现猜成 'left'：
   * 于是面板实际在右边时，下面的 `restorePanelWidth()` 会去读 **`app.panel_width_left`**
   * 并把那个值写回**左侧**（把与它无关的另一侧占位宽度改掉）；等真值随后到达，再按右侧
   * 恢复一次 —— 两次宽度应用落在两个时刻，**面板出现之后网页又自己重排一次**。
   * 这就是「面板在非 rail 那一侧时，切换面板网页会抖一下」的来路（提示词里那个写死的
   * 'left' 恰好等于 rail 侧，所以只有另一侧会露出来）。
   * 正确做法：不知道就**不动**，等 `onSideChanged` 推来真值（落位时必推）。
   *
   * @returns {Promise<'left'|'right'|null>} 已知的侧；未知为 null
   */
  function syncPanelSide() : Promise<'left'|'right'|null> {
    return panelsClient.getSide(panelId)
      .then((state) => {
        if (!state || (state.side !== 'left' && state.side !== 'right')) return null
        setHandleSide(state.side, state.pinned)
        sideSynced = true
        // 图钉的首帧状态：与侧一起从主进程取，避免"打开时先亮后灭"。
        shellApi.setPinned(!!state.pinned)
        return state.side
      })
      .catch(() => null)
  }

  // 只有**确实知道了侧**才恢复宽度；未知则等 onSideChanged（那里同样会恢复）
  syncPanelSide().then((side) => {
    if (side) {
      restorePanelWidth()
      reportEditorZone()
    }
  })
  /**
   * 图钉状态变了（点击回执 / 主进程推送都汇到壳的 `setPinned`）→ 只切"宽度写哪个槽"。
   *
   * ⚠ **这里不再恢复宽度**：钉住位 / 普通位的宽度都已在主进程手里（含设置项记忆），
   * 面板在两格之间搬家时保持各自那一格的宽度即可。再推一次"记忆宽度"会让两块面板
   * 在钉住 ↔ 普通之间来回抢同一块地盘 —— 用户看到的就是两块互相挤。
   */
  shellApi.onPinnedChange((pinned) => { currentPinned = !!pinned })
  // 本面板被换到另一侧 / 钉住状态变了 → 主进程按 panelId 推一条；只认自己那一条。
  const offPanelSideChanged = panelsClient.onSideChanged((payload) => {
    if (!payload || String(payload.panelId) !== String(panelId)) return
    const side = payload.side
    if (side !== 'left' && side !== 'right') return
    // 需要补一次宽度记忆的两种情形：**第一次**知道真值（启动时可能还是 null），或真的换了侧。
    // 只是换个槽（普通 ↔ 钉住）时不推 —— 两格宽度都在主进程里，各用各的。
    const needRestore = !sideSynced || side !== currentSide
    sideSynced = true
    setHandleSide(side, !!payload.pinned)
    shellApi.setPinned(!!payload.pinned)
    if (needRestore) restorePanelWidth()
    reportEditorZone()
  })

  const offButtonsEditActive = bridge.on.subscribe(IPC_EVENTS.buttonsEditActive, (payload) => {
    layoutEditing = !!(payload && payload.active)
    if (layoutEditing) requestAnimationFrame(reportEditorZone)
  })
  const offButtonsEditRemeasure = bridge.on.subscribe(IPC_EVENTS.buttonsEditRemeasure, () => {
    if (layoutEditing) reportEditorZone()
  })

  /**
   * **profile 变了 → 本面板重取自己那份数据**。
   *
   * 面板内容全部是按 profile 分区的（书签 / 历史 / 下载 / 笔记 / 插件状态…），而数据域
   * 不会因为换了用户就自己发一条 changed —— 少了这条订阅，切完 profile 面板里仍是上一个
   * 用户的列表，**不手动关掉重开就一直留着**（用户报的就是这个）。
   *
   * 这里只调面板自己 mount 时交出来的 `refresh()`：**每个面板最清楚要重取什么**，
   * 宿主不必、也不该知道它们各自的数据源（否则每加一个面板都要回来改这个文件）。
   * 一处订阅即覆盖全部面板 —— 这是「宿主统一装配」换来的收益。
   *
   * 顺带把面板宽度也重推一次：它是**按 profile 记的**设置（`app.panel_width_<side>`），
   * 新用户可能有另一个宽度（见 restorePanelWidth 的注释）。
   */
  const offProfileChanged = bridge.on.subscribe(IPC_EVENTS.profileChanged, () => {
    // 扩展会话比普通 profile 数据晚一拍就绪；这里提前拉会短暂画回上一身份，
    // 等主进程的 extension:changed 再刷新这一块，避免旧图标闪一下。
    if (panelId !== 'extensions-panel') refreshPanel()
    restorePanelWidth()
  })

  // 面板顶部工具栏插槽（side-panel.toolbar-action-slot）：插件/社区 Mod 往任意面板头部加按钮。
  // 它自己走 `slots:render` IPC，与壳同时起跑 —— 取不到就少几个按钮，不该拖住面板渲染。
  mountToolbarActions(actions, panelId)
  // 插件启停后工具栏内容可能已变（启用新插件 / 禁用后主进程会销毁本视图，
  // 所以这里主要覆盖"启用"的方向）。用真实元素登记，不猜选择器。
  const offPluginsChanged = bridge.on.subscribe(IPC_EVENTS.pluginsChanged, () => {
    mountToolbarActions(actions, panelId).catch(() => {})
  })

  // 插件启停 → 渲染侧插槽重新激活（面板视图随后会被主进程销毁重建，
  // 所以本次激活的意义是覆盖重建失败时的兜底路径）。
  const offRendererSlotsChanged = pluginsClient.onChanged(() => {
    void activateRendererSlots({ withPanels: true, panelId }).catch((error) => {
      console.error('[panels] renderer slots refresh failed:', error)
    })
  })
  window.addEventListener('pagehide', () => {
    offPanelSideChanged()
    offButtonsEditActive()
    offButtonsEditRemeasure()
    offProfileChanged()
    offPluginsChanged()
    offRendererSlotsChanged()
  }, { once: true })

  /**
   * 「内容就位」的唯一出口：撤掉薄引导留下的骨架，再挂真实内容。
   *
   * 骨架只在**确实要等**的时候才看得到（延迟由 CSS 决定，见 panelShell 的注释）——
   * 快路径上 mount 先到，用户从头到尾只看见面板本身。
   */
  function finishBoot(node?: Node | null) {
    content.classList.remove('panel-booting')
    if (node) content.appendChild(node)
  }

  return boot()

  async function boot() {
    // ① 三条异步线**同时**起跑，一条都不挡画壳：
    //    · 目录（只为标题校正 / 「未实现」文案）—— 标题通常已随 URL 到达
    //    · 插槽激活（manifest + 拥有本面板的那个插件的渲染模块）
    //    · 面板实现解析（归属插件 id 也从 URL 来 → 不必先等目录）
    //
    // 实现侧的 ui 包那条路**在薄引导里就开拉了**（prefetched）—— 这里只是接手结果。
    const catalogReady = panelsClient.catalog().catch(() => [])
    const entryReady = catalogReady
      .then((catalog) => (catalog || []).find((p) => p.id === panelId) || null)
      .catch(() => null)
    const slotsReady = activateRendererSlots({ withPanels: true, panelId })
    const defReady = resolvePanelDefinition(panelId, urlPluginId, prefetched, entryReady)
    //    · 迁移快照（独立窗口 → 停靠回侧栏）：主进程暂存、一次即焚。**必须与上面几条
    //      同时起跑并赶在 mount 之前拿到** —— 面板要直接落在带过来的会话上，
    //      否则会先画侧栏上次的对话再跳一下（见 panel.js 的 init 注释）。
    const transferReady = takePanelTransferState(panelId)

    // ② 插槽就绪 → 套一次头部插槽（REDUCE 实现此刻才注册好）。
    //
    // 这是「壳先出、插件后到」的收口：初始那一帧用已知标题画（薄引导做的），
    // 这里再把 `side-panel.panel-header-renderer` 的结果落上去。
    let title = urlTitle || panelId
    const [entry] = await Promise.all([entryReady, slotsReady])
    if (entry && entry.title && entry.title !== title) title = entry.title
    shellApi.updateHeader(reduceRendererSlot('side-panel.panel-header-renderer', {
      panelId,
      title,
      titleElement: null,
      className: ''
    }))

    /**
     * 面板换宿主（侧栏 ↔ 独立窗口）—— 由**宿主**统一渲染，面板作者零实现。
     *
     * 只有目录里声明了 `presentation: 'both'` 才画按钮（缺省 dock = 一字不差，
     * 没有这颗按钮）。按钮位置在这里（头部动作区）而不是面板内容里，理由见
     * `shared/panel-transfer.js` 文件头。
     */
    mountPanelTransferButton(actions, {
      panelId,
      presentation: entry?.presentation === 'both' ? 'both' : 'dock',
      compact: true,
      serialize: () => (mountedApi && typeof mountedApi.serialize === 'function'
        ? mountedApi.serialize()
        : undefined)
    })

    // 「在页面中打开」—— 同一套宿主统一画法，仅在目录项声明了 `hostPage` 时出现
    // （AI 助手的 manifest 写了 `hostPage: 'ai'`，于是侧栏面板头部多这一颗按钮）。
    mountPanelPageButton(actions, { hostPage: entry ? entry.hostPage : null })

    // 实现可能来自"插件自带的 render 入口"或"仓库里的 ui-panel-* 包"，两者取其一
    const def = await defReady
    if (!def) {
      // 面板本体没人实现，但**内容补充插槽**可能仍有人贡献（`side-panel.panel-render-slot`
      // 就是为"我不拥有这块面板，只想补一块"设计的）。先挂补丁块，再决定要不要报"未实现" ——
      // 顺序反过来的话，明明有东西可显示也会被占位文案顶掉。
      const body = document.createElement('div')
      const mounted = mountPanelBodies(body, panelId, title)
      if (mounted) {
        finishBoot(body)
        return
      }
      const unknown = document.createElement('div')
      unknown.style.cssText = 'padding: 32px 16px; text-align: center; color: var(--hira-text-secondary, #6b7280); font-size: 12px;'
      unknown.textContent = describeMissingPanel(panelId, entry)
      // 具体原因同时留在控制台：占位文案给用户看，堆栈给插件作者看。
      const diag = getPanelResolveError(panelId)
      if (diag) console.warn(`[panels] ${panelId} 未实现（${diag.stage}）：`, diag.message || diag)
      finishBoot(unknown)
      return
    }

    // 插件是**外部边界**：样式注入失败只该丢样式，不该把内容一起打死（曾整屏白）。
    if (typeof def.injectStyles === 'function') {
      try {
        def.injectStyles(document)
      } catch (e) {
        console.error(`[panels] ${panelId} injectStyles 失败:`, e)
      }
    }
    // 迁移快照在 mount 前就位：面板首帧直接落在带过来的会话上（不闪旧对话）。
    const transferState = await transferReady.catch(() => null)
    if (transferState != null) ctx.transferState = transferState
    let mounted: PanelInstance | null = null
    try {
      mounted = normalizePanelInstance(await def.mount(document, ctx))
    } catch (e) {
      // 白屏是最差的失败态（用户只能看到一片空）。至少把「哪里坏了 + 去哪看」摆出来。
      console.error(`[panels] ${panelId} mount 失败:`, e)
      const failed = document.createElement('div')
      failed.style.cssText = 'padding: 32px 16px; text-align: center; color: var(--hira-text-secondary, #6b7280); font-size: 12px;'
      const message = e instanceof Error ? e.message : String(e)
      failed.textContent = `面板 ${panelId} 装配失败：${message}`
      finishBoot(failed)
      return
    }
    finishBoot(mounted?.element)
    // 切换按钮的 serialize 从这里取（见上面的晚绑定闭包）。
    mountedApi = mounted
    // 菜单动作后的刷新目标就位（工厂是晚绑定的，见 shared/panel-context.js）。
    setPanelRefresh(mounted && typeof mounted.refresh === 'function' ? mounted.refresh : null)
    // 面板本体之后追加插件补充块
    mountPanelBodies(content, panelId, title)
    // 从独立窗口「停靠回侧栏」时的状态（迁移快照已在 mount 前领到，见上）：
    // 会话已由面板的 init 带着走，这里只回填草稿 / 滚动锚点这类"面板自己的东西"。
    if (transferState != null && mounted && typeof mounted.restore === 'function') {
      try { mounted.restore(transferState) } catch (e) { console.error(`[panels] ${panelId} restore 失败:`, e) }
    }
    // 「打开面板即聚焦它的搜索框」——泛化判据：mount 结果暴露 focusSearch 就调。
    // 面板视图**关闭即销毁**（见 LayoutCoordinator#hidePanel），所以每次重开都是新 renderer，
    // mount == open —— 不需要任何"打开"事件，也不需要宿主认识具体面板 id。
    // 两件事都要：DOM 焦点（focusSearch 自己做了）+ **原生视图焦点**（否则键盘输入仍进网页）。
    if (mounted && typeof mounted.focusSearch === 'function') {
      try { mounted.focusSearch() } catch (_) {}
      try { layoutClient.focusPanel(panelId) } catch (_) {}
    }
  }
}


