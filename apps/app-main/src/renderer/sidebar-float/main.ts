/**
 * sidebar-float —— Edge 型侧栏的**展开浮层**（独立原生视图）。
 *
 * ── 它在三形态里的位置（真源：shared-types#planChromeLayout）────────────────
 *   · `attached`（已固定）→ 侧栏是 chrome 里**真占位**的一条；本浮层不存在。
 *   · `floating`（未固定）→ chrome 里常驻一条 56px 图标 rail（仍占位），
 *     指针贴上那一侧窗口边缘时，主进程把**本浮层**盖在网页上 —— 网页不缩进、不重排。
 *     用户口径：「固定就是占位，取消固定就是标签 rail + 展开浮层」。
 *
 * ── 为什么它是一块独立视图 ────────────────────────────────────────────────
 * chrome 是窗口本体（假视图），天生位于 contentView 所有子视图**之下** ——
 * 它画得再高也盖不住网页。所以"浮出来"这件事只能由一个真正的 WebContentsView 做。
 *
 * ── 分工 ──────────────────────────────────────────────────────────────────
 *   · 几何（何时出、出在哪、多宽多高）**全在主进程**（LayoutCoordinator#_syncSideOverlayFloat），
 *     渲染层只收一条 `sidebar-float:show { side }` —— 不测尺寸、不上报 display，
 *     因此不存在"浮层自己算一遍轨道"的第二份算术。
 *   · 内容（骨架 + 标签列）与外壳里的侧栏**同一份装配**：`shared/sidebar-surface.js`。
 *     这里只交出端口，不重写任何"侧栏长什么样"。
 *   · 标签数据：浮层是**独立进程**，外壳那边的渲染回调到不了这里，
 *     故开 `autoSubscribe` 自己订阅 `tabs.onChanged`（面板同一条口径）。
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { LAYOUT_SETTING_KEYS } from '@hira-ng/shared-types/src/layout.mjs'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { tabsClient, settingsClient } from '../shared/hira-client.js'
import { menuClient } from '../shared/menu-client.js'
import { createTabRowMenuFactory } from '../shared/tab-row-menu.js'
import { createSidebarSurface, injectSidebarSurfaceStyles } from '../shared/sidebar-surface.js'
import { createOverlayAdapter } from '../controllers/overlay-adapter.js'
import { createSpaceController } from '../controllers/space-controller.js'
import { createSpaceSwitcher } from '@hira-ng/ui-space-switcher'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectSidebarSurfaceStyles(document)

/**
 * ── 空间胶囊（顶行左侧那颗）──────────────────────────────────────────────
 * 浮层是**独立 renderer**，外壳那份 `spaceController` / `overlayClient` 到不了这里，
 * 所以按与 app-shell **完全同一份实现**再起一套：哑组件（ui-space-switcher）+
 * 编排层（controllers/space-controller）+ 浮层适配器（controllers/overlay-adapter）。
 * 不重写任何"空间长什么样"的逻辑 —— 只把端口接上。
 *
 * 数据与订阅：控制器自己拉 `space:list-all` + `space:using`，并订阅 `space:changed` /
 * `space:window-changed`，与外挂载时一模一样（浮层常驻预热，不会反复起停）。
 *
 * 打开「总览」：触发器报的是**本视图**里的 client 坐标，主进程在 `normalizeFloatShow`
 * 里按视图偏移平移成窗口坐标（同一套换算，浮层里不自己再算一份）。
 * 卡片本体住在 overview-overlay 浮层（z 高于本侧栏浮层），数据与开合全在那一侧。
 */
const overlayClient = createOverlayAdapter({ provider, document })

/** 打开总览：锚点 = 本视图里那颗胶囊的实时矩形（主进程会补上视图偏移）。 */
function openOverview() {
  const anchor = typeof spaceSwitcher.getAnchor === 'function' ? spaceSwitcher.getAnchor() : null
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  overlayClient.showOverview(
    anchor && anchor.width > 0 ? { x: anchor.x, y: anchor.y, viewport } : { x: 12, y: 8, viewport }
  )
}

const spaceSwitcher = createSpaceSwitcher(document, {
  onToggle: () => { openOverview() },
  onIntent: () => overlayClient.warmOverview()
})
const spaceController = createSpaceController({
  view: spaceSwitcher,
  onSubscribe: (route, cb) => bridge.on.subscribe(route, cb)
})
spaceController.start()

/**
 * 浮层此刻是否在台上（主进程只在展开 / 收起时下发 `:show` / `:hide`）。
 * 它是本文件**唯一**的可见真源：标签列表的隐藏期闸门（`isActive`）读它，
 * 显示时用它触发一次 `flush()` 补齐隐藏期的列表变更。
 */
let revealed = false

const surface = createSidebarSurface(document, {
  tabs: tabsClient,
  // 独立视图：自己订阅标签变更（外壳那份推不到这里来）。
  autoSubscribe: true,
  /**
   * 隐藏期闸门：浮层收起时视图是 0×0（主进程只改 bounds），标签推送照样会到。
   * 判据只有这条端口，重建逻辑统一在 ui-common#tabListHost —— 本文件不写 "if (!visible)"。
   */
  isActive: () => revealed,
  // 标签行右键菜单 —— 与外壳 / 面板 / 覆盖层**同一份动作表**，本文件只交端口。
  createTabRowMenu: createTabRowMenuFactory(),
  menu: menuClient,
  /**
   * 顶部那颗「固定 / 悬停」按钮：浮层是**未固定**形态，点它就是"固定"。
   *
   * 只写设置键 —— `app.sidebar_visibility` 是唯一下游真源：
   * 落盘后主进程重算计划 → 外壳换成真占位侧栏、本浮层退场，
   * 这里不另存一份"我固定了"的状态（那必然与计划漂移）。
   */
  onTogglePin: () => {
    try {
      settingsClient.set(LAYOUT_SETTING_KEYS.sideColumnVisibility, 'attached').catch(() => {})
    } catch (_) {}
  },
  /**
   * hover 预览：只把意图转发到浮层通道，摆放方式不在这里定。
   *
   * ⚠ `windowWidth/windowHeight` **必须剥掉**：列表的预览适配器按"自己所在的视图宽"
   * 填这两个值（见 ui-common#withBesideRowPreview），而本视图只有浮层那么宽。
   * 剥掉之后由主进程按**真窗口内容区**补上（main/ipc/layout.js#normalizeFloatShow）。
   * anchor / stripRight / stripBottom 是视图内坐标，主进程会按本视图的偏移平移。
   */
  previewOverlay: {
    showTabPreview(payload: unknown) {
      const next = { ...(payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}) }
      delete next.windowWidth
      delete next.windowHeight
      try { provider.send(IPC_EVENTS.tabpreviewOverlayShow, next) } catch (_) {}
    },
    hideTabPreview() {
      try { provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (_) {}
    },
    warmTabPreview() {
      try { provider.send(IPC_ROUTES.floatWarm, { name: 'tabpreview-overlay' }) } catch (_) {}
    }
  }
})

// 浮层永远是**展开**形态（宽度由主进程给到 revealWidth），也不需要图标条形态。
surface.setCollapsed(false)
surface.setPinned(false)
/**
 * 顶行两件东西，与外壳侧栏**同一口径**（用户口径：「固定按钮和 profile 同行」+「固定按钮靠右」）：
 *   · 空间切换器在左（浮层整块盖住了 chrome 的 rail，不在这儿放一颗就看不到当前空间）；
 *   · 固定钮紧随其后、由 CSS 的 margin-left:auto 推到这一行最右端
 *     （见 ui-vertical-tabs#styles 的 .vtabs__pin-btn）。
 * 顺序必须是「切换器 → 固定钮」：靠右那条规则是 auto margin，只吃它后面的空位。
 */
surface.slots.top.appendChild(spaceSwitcher.element)
surface.slots.top.appendChild(surface.slots.pin)
/** 本视图的根（展开动画裁在它身上，见下）。 */
const rootEl = document.getElementById('root') as HTMLElement
rootEl.appendChild(surface.element)

/**
 * ── 展开动画（"面板从贴窗缘的一侧划开"）──────────────────────────────────
 *
 * 为什么在**渲染层**做而不是补间原生 bounds：
 *   · 补间 view 宽度 = 每一帧都改布局 → 标签行的名字/图标每帧重排，观感是"字在跳"；
 *   · 这里 view 一次性就是最终矩形（布局只算一次），只在 `#root` 上跑一条
 *     clip-path 划开：内容全程停在最终位置，零重排、零抖动（纯合成层裁剪）。
 * 视图本身是透明的（见 WebContentsManager#createFloatView），所以还没划到的区域
 * 天然透出下面的 chrome rail / 网页 —— 这正是 Edge 那条浮出面板的观感。
 *
 * 与时序的配合（**这条容易踩**）：
 *   · 浮层显隐只靠 bounds（主进程从不 setVisible），所以本页看不到"收起"；
 *   · 静息态由 index.html 的 critical CSS 定成**闭合**，否则 show 到达前会先
 *     露出整块面板（闪一帧全开）；
 *   · 收起方向由主进程补一条 `:hide`（见 LayoutCoordinator#_hideSideOverlayFloat），
 *     把本页复位成闭合，下一次展开才有起跑线。
 * 收起**不做**动画（用户口径：Edge 型指针一出圈就立即关）。
 *
 * 时长 / 曲线与 `--ng-anim-base` 同一口径（180ms / cubic-bezier(.4,0,.2,1)），
 * 见 infra `BoundsTween` 的默认值。
 */
const ENTER_MS = 180
const ENTER_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** 在播的展开动画（同一时刻只留一条；重入即重播）。 */
let enterAnim: Animation | null = null

/** 落定"全开 / 闭合"（闭合 = 去掉 phase，回到 CSS 默认的裁剪）。 */
function setOpen(open: boolean) {
  if (!rootEl) return
  if (open) rootEl.dataset.sbPhase = 'open'
  else delete rootEl.dataset.sbPhase
}

/** 复位成闭合（收起时只有这一件事要做）。 */
function playLeave() {
  if (enterAnim) {
    try { enterAnim.cancel() } catch (_) {}
    enterAnim = null
  }
  setOpen(false)
}

function playEnter(side: 'left' | 'right') {
  if (!rootEl) return
  if (typeof rootEl.animate !== 'function') { setOpen(true); return }
  // 重入：先撤掉上一条（同时把 phase 复位成闭合，作为本次的起跑线）。
  if (enterAnim) {
    try { enterAnim.cancel() } catch (_) {}
    enterAnim = null
  }
  setOpen(false)
  rootEl.dataset.sbSide = side
  // 强制一次样式结算，确保动画从"闭合"起跑（否则首帧可能与上一次的全开合并）。
  void rootEl.offsetWidth
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setOpen(true)
    return
  }
  // inset(top right bottom left)：左侧贴窗缘由**左缘**划开，右侧贴窗缘由**右缘**划开。
  const closed = side === 'right' ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)'
  const anim = rootEl.animate(
    [{ clipPath: closed }, { clipPath: 'inset(0)' }],
    { duration: ENTER_MS, easing: ENTER_EASE, fill: 'forwards' }
  )
  enterAnim = anim
  anim.onfinish = () => {
    if (enterAnim !== anim) return
    enterAnim = null
    // 先把"全开"写进样式、再撤掉动画的 fill —— 同一任务内完成，不会漏出一帧闭合。
    setOpen(true)
    try { anim.cancel() } catch (_) {}
  }
}

// 靠哪一侧只由主进程说（分隔线画在内缘、列表内容的朝向都认它）。
// show / hide 只在「每次重新展开 / 换边 / 收起」时下发
// （见 LayoutCoordinator#_syncSideOverlayFloat / #_hideSideOverlayFloat）。
bridge.on.subscribe('sidebar-float:show', (payload) => {
  const side = payload && payload.side === 'right' ? 'right' : 'left'
  revealed = true
  surface.setSide(side)
  // 先把隐藏期攒下的列表变更同步补上（零 IPC），再起划开动画 —— 首帧就是最新，
  // 不会出现"面板已经划开、列表还停在上次唤出的状态"。
  surface.flush()
  playEnter(side)
})
bridge.on.subscribe('sidebar-float:hide', () => {
  revealed = false
  playLeave()
})

window.addEventListener('pagehide', () => {
  playLeave()
  spaceController.dispose()
  surface.dispose()
}, { once: true })

