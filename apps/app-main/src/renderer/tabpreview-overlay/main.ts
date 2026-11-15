// 标签 hover 预览浮层（独立 WebContentsView）
//
// 展示内容分三层（对齐 RT tab preview）：
//   1. 缩略图 —— 「该标签上次可见时的画面」，由主进程 capturePage 抓帧后经
//      hira://tab-snapshot?id=… 直吐。**渲染层只持有地址，不持有字节**，
//      无可用帧时整块隐藏并回退到纯文字卡。
//   2. 文字行 —— favicon + 标题 + URL（截图不可用时的全部信息量）。
//   3. 内存行 —— 「这个标签占多少内存」。数值只能由主进程给（与任务管理器同源，
//      见 main/ipc/tab-memory.ts）；休眠标签显示状态词，问不到时**整行不显示**
//      （不留空行、更不拿 0 充数）。
//
// 本文件不反向依赖 ui-tabbar：payload 里的 tabId 是唯一约定，
// 组件层（ui-tabbar）只负责把 id 传出来，取图 / 取内存与排版都发生在浮层内。
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { tabsClient } from '../shared/hira-client.js'
// 落位真源（渲染层与主进程共用同一份；见该文件头的三条不变式）。
import { resolvePreviewPlacement } from '@hira-ng/shared-types/src/preview-placement.mjs'
// 图标来源的唯一真源（代理 → 众所周知兜底 → 无）：
// 发起方没带 favicon 时退回站点图标，卡片才不会只有一个空图标位。
import { faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
// 体积文本的唯一实现（任务管理器与这里显示的是**同一个数**，取整口径必须一致）。
import { formatMemoryKB } from '@hira-ng/shared-types/src/format-size.mjs'

const themeController = createThemeController({ document, bridge: getHiraBridge() })
themeController.start()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing tab preview root')
const root = rootElement

type PreviewPlacementMode = 'below' | 'beside-row' | 'beside-panel'
type PreviewSide = 'left' | 'right'
interface PreviewAnchorRect {
  left: number
  top: number
  width: number
  height: number
}
interface PreviewPanelRect {
  x: number
  y: number
  width: number
  height: number
}
interface PreviewAnchorState {
  placement: PreviewPlacementMode
  side?: PreviewSide
  anchor: PreviewAnchorRect | null
  stripRight?: number
  stripBottom?: number
  windowWidth?: number
  windowHeight?: number
  panel?: PreviewPanelRect | null
  panelSide?: PreviewSide
  railWidth?: number
}
/**
 * 卡片自身的尺寸上限（`max-width` / `max-height`）—— 这是**卡片自己的版式**，故住在这里。
 *
 * 而「卡片摆在窗口哪儿、view 多大、卡片在 view 里怎么内缩、放不下怎么收窄」是**落位**，
 * 全部由 `@hira-ng/shared-types/src/preview-placement.mjs` 一处算 —— 渲染层与主进程共用
 * 同一份（见那份文件头的三条不变式）。本文件因此不再出现任何落位字面量：
 * 以前这里三段算术（普通 / 面板外侧 / 行外侧）+ 主进程第四段，任一处漂移就是
 * 「卡片与 view 错位」或「view 压住锚点 → hover 反复进出 → 无限闪烁」。
 */
const PREVIEW_MAX_HEIGHT = 320
const PREVIEW_MAX_WIDTH = 360
/** 缩略图显示尺寸上限（16:9 主流视口比例，超出用 object-fit 裁切，不拉伸变形）。 */
const THUMB_MAX_WIDTH = 336
const THUMB_MAX_HEIGHT = 189

const preview = document.createElement('div')
preview.className = 'tab-preview'
// 阴影刻意做成**只朝下**（offset-y 8 / spread -8）：水平的扩散半径 = blur/2 + spread = 0，
// 于是它**绝不向两侧溢出**。
// 为什么必须如此：卡片常常紧贴一条 chrome 栏（面板外侧 / 纵向标签列外侧就是 rail + 面板），
// 原来那点侧向扩散会把**面板那一列染上一层灰**（面板是玻璃面，看着就像"背景色变了"）。
// 朝下的投影在视觉上也更自然 —— 卡片像浮在内容之上（同 comments 里既有的口径）。
// ⚠ view 顶边恒**不高于锚点下缘**（below 的 top 恒为 0），否则浮层会盖住标签栏、
// 吃掉鼠标事件，hover 就会反复进出（表现为预览一直重跳）。
preview.style.cssText = `position:fixed;background:var(--hira-bg-elevated,#fff);border:1px solid var(--hira-border-subtle,rgba(0,0,0,.1));border-radius:var(--hira-theme-radius,6px);box-shadow:0 8px 16px -8px rgba(0,0,0,.18);padding:8px;display:none;pointer-events:none;max-width:${PREVIEW_MAX_WIDTH}px;max-height:${PREVIEW_MAX_HEIGHT}px;overflow:hidden;font-size:12px;`

// ── 缩略图（无截图时整块 display:none，不占高度）──
const thumb = document.createElement('img')
thumb.className = 'tab-preview__thumb'
thumb.alt = ''
thumb.style.cssText = `display:none;width:${THUMB_MAX_WIDTH}px;max-width:100%;height:${THUMB_MAX_HEIGHT}px;object-fit:cover;object-position:top center;border-radius:var(--hira-radius-2xs,4px);background:var(--hira-bg-subtle,#f3f4f6);margin-bottom:8px;`
preview.appendChild(thumb)

const row = document.createElement('div')
row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 4px;'
preview.appendChild(row)

const favicon = document.createElement('img')
favicon.style.cssText = 'width:14px;height:14px;flex:0 0 auto;'
favicon.alt = ''
row.appendChild(favicon)

const body = document.createElement('div')
body.style.cssText = 'min-width:0;flex:1 1 auto;'
const title = document.createElement('div')
title.style.cssText = 'color:var(--hira-text-primary,#1a1a1a);font-weight:500;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
const url = document.createElement('div')
url.style.cssText = 'color:var(--hira-text-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
body.appendChild(title)
body.appendChild(url)
/** 内存行标签与「已休眠」文案 —— 与标签体系既有用词一致（见 domain-tabs#TabRules 的休眠语义）。 */
const MEMORY_LABEL = '内存：'
const MEMORY_SLEEPING_TEXT = '已休眠'
/**
 * 内存行 —— 卡片里最下面那一条。
 *
 * 单独一个元素而不是拼进 URL 那行：它是**异步**来的（要先问主进程），而 URL 是同步就有的；
 * 挤在一行会让 URL 的省略号宽度随内存文本回填而跳。
 */
const memoryLine = document.createElement('div')
memoryLine.style.cssText = 'color:var(--hira-text-secondary,#6b7280);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;'
body.appendChild(memoryLine)
row.appendChild(body)
root.appendChild(preview)

/** 最近一次的锚点：缩略图是异步加载的，图片撑开高度后需要用同一锚点重算 bounds。 */
let lastAnchor: PreviewAnchorState | null = null
/** 代际计数：快速划过多个标签时，丢弃迟到的截图回调，避免错配。 */
let showGeneration = 0
/** 退场动效是否在途（决定 hidden 回执要不要发、以及新 show 是否要打断它） */
let exitPending = false
let exitTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 卡片此刻**是否真的挂着**（本层的权威可见态）。
 *
 * 为什么不用 `preview.style.display` 反推：退场动效播完之前 DOM 仍是 `block`
 * （动效是 `fill: forwards` 的 opacity 动画，不是 display 切换），那个字符串值
 * 分不清「在台上」与「正在退场」，会让三处判据全部判错 ——
 * 换锚动效该走轻档还是重档（isSwap）、收起是否幂等、兜底计时器要不要计时。
 * 于是这里立一个**唯一**的布尔，show 置 true / ackHidden 置 false，
 * 上面三处一律读它。
 */
let visible = false
/**
 * 上一次真正发出去的 display 载荷签名（见 `display`）。
 * `null` = 缓存失效，下一趟必须重发（收起后必须如此，否则主进程那边 bounds 仍是 0）。
 */
let lastDisplaySignature: string | null = null
/**
 * 时间兜底 —— 卡片从「上次显示」起最多存活这么久，到点不问原因自收。
 *
 * 为什么必须有它（而不是"把丢掉的信号都补齐"）：预览的收起信号**全部**来自外部
 * —— 宿主列表的 mouseout / mouseover(项以外) / mousedown / 锚点消失（见 ui-common#hoverPreview 六条规则），
 * 以及主进程的切标签 / 关标签 / 窗口失焦 / 面板被关。这些信号任何一条都可能丢：
 * 标签节点被 remove 时不派发 mouseout；光标停在标签上不动时、别处发生的布局变化
 * 也不会产生任何指针事件；视图被闲置回收重建后订阅晚于推送（那一次推送必然丢）。
 * 补信号能治常见的几种，但永远补不全 —— 于是留一条与任何信号都无关的底线。
 *
 * 每次 show 重新计时（换锚 = 用户还在用，不该被上一轮的计时收掉）；收起时拆表。
 */
const AUTO_CLOSE_MS = 6000
/** 兜底计时器（见 AUTO_CLOSE_MS）。 */
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 打开 / 关闭动效 —— **三个入口共用这一个浮层**（tabbar 与两个面板的 hover 预览
 * 都发到同一条 tabpreview-overlay 通道），所以动效只写这一处，三处天然一致。
 *
 * 退场为什么必须由浮层自己回执：主进程一收到 hide 就把 view 的 bounds 收成 0 的话，
 * 画面瞬间消失，动画根本来不及画。所以这次把顺序反过来 ——
 * 主进程先留着 bounds 并通知 hide，浮层播完动画再发 hidden 让它收（带兜底超时，
 * 见 LayoutCoordinator#hideFloat / #finishFloatHide）。
 */
const ENTER_MS = 240
const SWAP_MS = 130
const EXIT_MS = 190
/**
 * 柔和曲线：入场用「缓起 + 长减速段」—— 缩放过程要**看得见**（前段别一下冲到位），
 * 落位又要软。退场用标准柔和进出。
 */
const EASE_SOFT_OUT = 'cubic-bezier(0.25, 0.9, 0.35, 1)'
const EASE_SOFT = 'cubic-bezier(0.4, 0, 0.2, 1)'

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (_) { return false }
}

function cancelPreviewAnimations() {
  try { preview.getAnimations().forEach((a) => a.cancel()) } catch (_) {}
}

/** 拆掉时间兜底计时器（每次收起、每次重新显示都要先拆——幂等）。 */
function clearAutoClose() {
  if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null }
}

/**
 * 装上时间兜底（见 AUTO_CLOSE_MS）：从**此刻**起算，到点请主进程把本层收起。
 * 每次 show 都重新装一次 → 换锚（用户还在用）不会沿用上一轮的计时。
 */
function armAutoClose() {
  clearAutoClose()
  autoCloseTimer = setTimeout(() => {
    autoCloseTimer = null
    requestAutoClose()
  }, AUTO_CLOSE_MS)
}

/**
 * 兜底到点：**请主进程收起**，而不是在本层悄悄把 DOM 藏掉。
 *
 * 为什么要绕一圈走正规 hide 通道：本层藏完 DOM 只是"画面上没了"，而主进程那边
 * 逻辑可见态仍是可见、bounds 还留着 —— 一层 0 内容的视图继续占着那块矩形，
 * 会挡住浮层的闲置回收，也会让拖拽落点判定以为指针正压在这层上（见
 * LayoutCoordinator#_reclaimFloatView / #isPointInOtherFloat）。走 hide 通道则一次全齐：
 * 主进程置逻辑隐藏 + 回推 `:hide` 让本层播退场动效 + 收 bounds（它还有 420ms 兜底，
 * 本层真卡死也能收掉）。于是"自己收"与"鼠标离开时收"**是同一条路径**，没有第二套语义。
 *
 * 主进程若早已收起本层（逻辑态非可见）：hideFloat 幂等，这次请求等价于无操作。
 * 通道异常（极罕见）：退到本地收起 —— 至少把画面收掉，绝不空转。
 */
function requestAutoClose() {
  if (!visible) return
  try {
    getHiraBridge().provider.send(IPC_EVENTS.tabpreviewOverlayHide, {})
  } catch (_) {
    hideTabPreview()
  }
}

/**
 * 入场动效，分两种：
 *   · 新打开（鼠标停在标签上 700ms 后浮现）→ 缩放 + 淡入 + 轻微下沉。
 *     起点刻意做小（0.93）+ 时长 240ms：缩放「从小长到大」的过程要看得出来，
 *     幅度太小 / 太快都会退化成"闪一下出现"。
 *   · 换标签（预览已可见、鼠标横扫标签栏换锚）→ **只做极轻的淡入，不做缩放**。
 *     换锚时如果每次都重新缩放一遍，横扫多个标签就会变成一连串"弹一下、弹一下"，
 *     这正是最明显的顿挫感来源；这里让内容只是柔和地换过去。
 * @param {boolean} isSwap
 */
function playEnter(isSwap: boolean) {
  cancelPreviewAnimations()
  if (prefersReducedMotion()) return
  const frames = isSwap
    ? [{ opacity: 0.65 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: 'scale(0.93) translateY(-6px)' },
        { opacity: 1, transform: 'none' }
      ]
  try {
    preview.animate(frames, {
      duration: isSwap ? SWAP_MS : ENTER_MS,
      easing: isSwap ? 'ease-out' : EASE_SOFT_OUT
    })
  } catch (_) {}
}

/**
 * 落位：**量卡片 → 交给落位真源 → 贴内缩 + 发出 bounds**。
 *
 * 本函数只做这三件事 —— 「摆在哪、view 多大、放不下怎么收窄」一律读
 * `@hira-ng/shared-types/src/preview-placement.mjs` 的结果（那份文件头写了三条不变式：
 * 绝不压到锚点 / 整个落在窗口内 / 放不下就收窄）。
 *
 * 以前这里散着三段各自的算术（普通 / 面板外侧 / 行外侧）、主进程还有第四段，
 * 任一处漂移就是「卡片与 view 错位」或「view 压住锚点 → hover 反复进出 → 无限闪烁」。
 */
function layout() {
  if (!lastAnchor) return
  // 权威可见态（不是 DOM 的 display，见 visible 的说明）：收起后迟到的截图 / 内存回调
  // 会走到这里（缩略图 load / error 也直接调本函数），那时绝不能再算一次落位并回传 display。
  if (!visible) return
  // 用 offsetWidth/Height 而不是 getBoundingClientRect：入场动画正在 scale 时，
  // 后者返回的是**变换后**的尺寸（动画结束也不会再纠正）。
  const card = { width: preview.offsetWidth, height: preview.offsetHeight }
  const out = resolvePreviewPlacement({
    placement: lastAnchor.placement,
    card,
    maxCard: { width: PREVIEW_MAX_WIDTH, height: PREVIEW_MAX_HEIGHT },
    anchor: lastAnchor.anchor,
    previewSide: lastAnchor.side,
    panelSide: lastAnchor.panelSide,
    // 「列表容器外缘」的两个字段必须**成对**进出（见 tabPreviewFacts）：
    //   · stripRight  —— 行外侧（beside-row）朝内那条边的基准；
    //   · stripBottom —— 标签下方（below）顶边的基准。
    // 少传 stripBottom 时 below() 会退回「标签底边」，view 顶边正好压在标签条
    // 腾出来的那条凹槽上（#tabs 是 align-self: stretch，比标签高）→ 指针进凹槽
    // 就落到浮层上、外壳拿不到 relatedTarget → 判成"离开标签条"→ 收起 → 指针
    // 微动回标签 → 规则③立即补显 → 再收起 …… 即「靠标签条下缘 hover 一直跳」。
    stripRight: lastAnchor.stripRight,
    stripBottom: lastAnchor.stripBottom,
    window: { width: lastAnchor.windowWidth, height: lastAnchor.windowHeight },
    panel: lastAnchor.panel || null,
    railWidth: lastAnchor.railWidth
  })
  // 卡片在 view 内的内缩：贴锚点的那条边归零 —— view 被收窄时裁掉的必须是外侧。
  preview.style.left = out.card.left == null ? 'auto' : `${out.card.left}px`
  preview.style.right = out.card.right == null ? 'auto' : `${out.card.right}px`
  preview.style.top = `${out.card.top}px`
  if (lastAnchor.placement === 'beside-panel') {
    // 面板外侧：x 与 view 尺寸只有主进程算得出（面板 bounds 在它手里）→ 只把**事实**
    // 交出去，由它用同一份落位真源解析。卡片内缩已在上方贴好（它只依赖卡片尺寸）。
    display({ position: 'beside-panel', card, anchor: lastAnchor.anchor, margin: 0, interactive: false })
    return
  }
  display({ x: out.x, y: out.y, width: out.width, height: out.height, interactive: false })
}

function applyThumbnail(src: string | null): void {
  if (!src) {
    thumb.removeAttribute('src')
    thumb.style.display = 'none'
    return
  }
  if (thumb.getAttribute('src') === src) return
  thumb.style.display = ''
  thumb.src = src
}

/**
 * 内存行该显示什么 —— 三种输入三种结果（判据全部来自契约，这里不重新猜）：
 *   · `null`（IPC 出错 / 标签已不在）→ 空串（整行不显示）；
 *   · `sleeping` → 「已休眠」（那一刻它没有活着的渲染进程，没有内存可言）；
 *   · `memoryKB` 有值 → 「内存：128.0 MB」；仍为 null（刚创建 / 刚销毁的竞态）→ 空串。
 * 文本统一由 `shared-types#format-size` 产出，与任务管理器显示的是同一份取整规则。
 */
interface TabMemoryInfo { sleeping?: boolean; memoryKB?: string | number | null }

function memoryTextFor(info: TabMemoryInfo | null): string {
  if (!info) return ''
  if (info.sleeping) return MEMORY_LABEL + MEMORY_SLEEPING_TEXT
  const size = formatMemoryKB(info.memoryKB)
  return size ? MEMORY_LABEL + size : ''
}

/** 文本真变了才动 DOM 并重算落位：这一行出现 / 消失会改卡片高度，而浮层 bounds 按卡片量。 */
function applyMemory(info: TabMemoryInfo | null): void {
  const text = memoryTextFor(info)
  if (memoryLine.textContent === text) return
  memoryLine.textContent = text
  memoryLine.style.display = text ? '' : 'none'
  layout()
}

// 图片尺寸变化（加载完成 / 解码后）都要重算浮层 bounds，否则底部会被裁掉。
thumb.addEventListener('load', layout)
thumb.addEventListener('error', () => {
  thumb.style.display = 'none'
  layout()
})

interface TabPreviewShowPayload {
  tab?: Record<string, unknown>
  besidePanel?: boolean
  placement?: 'below' | 'beside-row'
  side?: PreviewSide
  panelSide?: PreviewSide
  anchor?: PreviewAnchorRect
  stripRight?: number
  stripBottom?: number
  windowWidth?: number
  windowHeight?: number
  panel?: PreviewPanelRect | null
  railWidth?: number
}

type PreviewDisplayPayload =
  | {
      position: 'beside-panel'
      card: { width: number; height: number }
      anchor: PreviewAnchorRect | null
      margin: number
      interactive: false
    }
  | {
      position?: undefined
      x: number
      y: number
      width: number
      height: number
      interactive: false
    }

function showTabPreview({
  tab,
  besidePanel,
  placement,
  side,
  anchor,
  stripRight,
  stripBottom,
  windowWidth,
  windowHeight,
  panel,
  panelSide,
  railWidth
}: TabPreviewShowPayload = {}) {
  const currentTab = tab || {}
  // 已经可见（或正处在退场中途）→ 这次是"换锚"，入场动效要走轻的那一档（见 playEnter）。
  // 判据是权威可见态而不是 DOM：退场动效播完前 DOM 仍是 block，用 DOM 会把
  // "被打断的退场"误判成"新打开"，从而重播一次缩放（横扫时就是一连串弹跳）。
  const isSwap = visible
  // 上一次的退场动效还在播 → 直接打断复用它（快速划过多个标签时不能等它播完）
  if (exitPending) cancelExit()
  /**
   * 三种摆放在这里**归一到一个字段**，后面只认它：
   *   · 横向标签条 → 发起方给 `placement: 'below'`（缺省）；
   *   · 纵向标签列 / 侧栏覆盖层 → 发起方给 `placement: 'beside-row'`
   *                                （见 ui-common#tabListHost#withBesideRowPreview）；
   *   · 两个面板   → 走主进程判定的 `besidePanel` 标记 —— 面板 bounds 只有它知道，
   *                  故它的摆放只能由主进程认领（见 preview-placement 的 beside-panel 分支）。
   * 于是"谁摆在哪"只有一处判断，不再散在 show/layout/主进程三处各判一次。
   *
   * ⚠ **`besidePanel` 的优先级高于发起方给的 `placement`**。
   *   纵向列表的 `withBesideRowPreview` 会对**所有**纵向宿主统一打上 `placement: 'beside-row'`
   *   （它当时也只服务纵向标签列）—— 面板因此也带着这个标记，可面板的 `innerWidth` 只是
   *   **面板宽**、不是窗口宽，beside-row 那套「按窗口宽算行外侧还剩多少」必然算错：
   *   `room` 被算成几像素 → view 宽度被夹成 1px → 预览**整个显示不出来**。
   *   而"这是不是面板"只有主进程判得准（`isPanelWebContents`），所以那个标记必须让位。
   */
  const mode = besidePanel
    ? 'beside-panel'
    : (placement === 'beside-row' ? 'beside-row' : 'below')
  // ⚠ 「列表容器外缘」成对保存（stripRight / stripBottom）：两者都是**发送方视图内**的坐标
  //   （主进程的 normalizeFloatShow 会一并搬偏移），也是 below / beside-row 两种落位
  //   顶/内侧边的基准。任何一次只存一个，重算 bounds 时那一侧就会退回锚点自身的边。
  lastAnchor = {
    placement: mode,
    side,
    anchor: anchor || null,
    stripRight,
    stripBottom,
    windowWidth,
    windowHeight,
    panel: panel || null,
    panelSide,
    railWidth
  }

  const titleText = typeof currentTab.title === 'string' ? currentTab.title : ''
  const urlText = typeof currentTab.url === 'string' ? currentTab.url : ''
  title.textContent = titleText || urlText
  url.textContent = urlText
  // 图标：数据里带 favicon 就用它；没带（历史条目只有 url）→ 按站点众所周知的
  // `favicon.ico` 兜底。规则本身在 shared-types#favicon-src，这里不重复推导。
  const faviconSrc = faviconSourceCandidates(
    urlText,
    typeof currentTab.favicon === 'string' ? currentTab.favicon : null
  ).primary
  if (faviconSrc) {
    favicon.src = faviconSrc
    favicon.style.display = ''
  } else {
    favicon.removeAttribute('src')
    favicon.style.display = 'none'
  }

  // 首帧永不空等：先按「无缩略图」的尺寸显示，拿到截图后自动增高。
  // ⚠ 换标签（预览已在台上）时**不动缩略图**：先清掉再补回来会让卡片"缩一下又长回来"，
  //    每换一个标签就闪一下。保留旧图直到新图就绪，再一次性换过去（新标签确实没有截图时
  //    才清掉 —— 那一下就一次收缩，不再来回抽动；且外层视图尺寸恒定，不会牵动别的图层）。
  if (!isSwap) applyThumbnail(null)
  // 内存行同理：换标签时**留着上一条**直到新值回来（内容柔和换过去），
  // 但"从没显示过 → 重新打开"这一档要先清掉，否则会先闪一下上一个标签的内存。
  if (!isSwap) applyMemory(null)
  preview.style.display = 'block'
  visible = true
  // 新的一次展示：主进程那边上一轮可能已把 bounds 收成 0（主进程驱动的收起不发 `:hide`），
  // 所以**必须**让这一趟的 display 真的发出去（见 `display` 的去重）。
  lastDisplaySignature = null
  // 时间兜底从这一刻起算（见 AUTO_CLOSE_MS）—— 每次显示都重新计时
  armAutoClose()
  const generation = ++showGeneration
  layout()
  playEnter(isSwap)

  const tabId = typeof currentTab.tabId === 'string' ? currentTab.tabId : ''
  if (!tabId) return
  tabsClient
    .snapshot(tabId)
    .then((snapshotUrl) => {
      // 期间已切到别的标签 → 丢弃这次结果
      if (generation !== showGeneration) return
      applyThumbnail(typeof snapshotUrl === 'string' && snapshotUrl ? snapshotUrl : null)
      layout()
    })
    .catch(() => {})
  // 内存与截图**各走各的**（不必互相等）：截图慢是加载慢，内存慢只是主进程那一刻忙；
  // 串起来只会让先到的那个也一起晚到。
  tabsClient
    .memory(tabId)
    .then((value) => {
      if (generation !== showGeneration) return
      applyMemory(value && typeof value === 'object' ? value as TabMemoryInfo : null)
    })
    .catch(() => {})
}

/** 结束退场：清定时器、复位动画帧、真正隐藏 DOM，并回执让主进程收 bounds */
function ackHidden() {
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null }
  clearAutoClose()
  exitPending = false
  visible = false
  lastAnchor = null
  // 收起 = 主进程随后把 bounds 归 0 → 下一次展示必须重发 display（见其去重说明）。
  lastDisplaySignature = null
  preview.style.display = 'none'
  cancelPreviewAnimations() // 清掉动画残留帧，否则下次 show 会带着上一帧的透明度
  try { getHiraBridge().provider.send('tabpreview-overlay:hidden', {}) } catch (_) {}
}

/** 打断在途退场（新的 show 进来）：不发回执，主进程那边由新的 show 作废退场态 */
function cancelExit() {
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null }
  exitPending = false
  cancelPreviewAnimations()
}

/**
 * 收起（幂等）。
 *
 * 幂等判据是**权威可见态**而不是 DOM 的 display：主进程驱动的收起（切标签 / 关标签 /
 * 窗口失焦 / 面板被关）**不发 `:hide` 给本层**（见 apps/main/ipc/layout.js 的 hide 通道说明），
 * 于是"主进程已收、本层 DOM 还挂着"是一种正常状态；这时再收到一次 hide（例如本层
 * 的兜底到点、或主进程随后补发），必须老老实实把它收干净并回执 —— 否则主进程那边
 * 永远等不到 `hidden`，几何就一直留着（这正是"卡着关不掉"的一条来路）。
 * 所以这里**不做**"display 已是 none 就直接返回"，而是"真的不在台上就补一次回执"。
 */
function hideTabPreview() {
  showGeneration++
  lastAnchor = null
  if (!visible) { ackHidden(); return }
  hideFloatPreview()   // 见下：把"确实在台上"这一支单独成函数，判据只有一处
}

/** "确实在台上"这一支的收起实现（与上面的幂等判据同一处收口，避免两处各判一次）。 */
function hideFloatPreview() {
  // 退场已在途 → 不再重开一次动画（第二次 hide 是幂等请求；重开会让卡片在
  // 已经淡到 0 的时候又跳回不透明再淡一次，横扫时看得见）。在途那一支自会回执。
  if (exitPending) return
  if (prefersReducedMotion()) { ackHidden(); return }
  exitPending = true
  try {
    const anim = preview.animate(
      [
        { opacity: 1, transform: 'none' },
        // 退场幅度与入场呼应：淡出为主，缩到 0.97 给「收走」一点方向感
        { opacity: 0, transform: 'scale(0.97) translateY(-3px)' }
      ],
      { duration: EXIT_MS, easing: EASE_SOFT, fill: 'forwards' }
    )
    anim.onfinish = () => ackHidden()
    anim.oncancel = () => { if (exitPending) ackHidden() }
  } catch (_) {
    ackHidden()
    return
  }
  // 兜底：窗口被隐藏 / 动画被节流时 onfinish 可能不来，绝不能让浮层卡在"半透明"状态
  exitTimer = setTimeout(() => { if (exitPending) ackHidden() }, EXIT_MS + 120)
}

function display(payload: PreviewDisplayPayload): void {
  /**
   * 同一份载荷不重复上报。
   *
   * 一次 show 里 `layout()` 至少跑三趟（首帧 / 缩略图到 / 内存到），后两趟多数情况下
   * 与原值完全相同 —— 而主进程收到重复的 display 只是把**同一个矩形**再 setBounds 一遍
   * （还带一次跨进程序列化）。这里按"载荷完全决定结果"做去重。
   *
   * ⚠ 收起时必须清缓存（见 `ackHidden` / `showTabPreview`）：bounds 被收成 0 之后，
   * 同一份载荷必须重新发一次才会再摆出来。
   */
  const signature = payload.position === 'beside-panel'
    ? `p|${payload.card.width}|${payload.card.height}|${anchorSignature(payload.anchor)}`
    : `b|${payload.x}|${payload.y}|${payload.width}|${payload.height}`
  if (signature === lastDisplaySignature) return
  lastDisplaySignature = signature
  try {
    getHiraBridge().provider.send('tabpreview-overlay:display', payload)
  } catch {}
}

/** 锚点矩形的廉价签名（`display` 去重按它比较，不为了比一个字串去 JSON.stringify）。 */
function anchorSignature(a: PreviewAnchorRect | null): string {
  if (!a) return ''
  return `${a.left == null ? '' : Math.round(a.left)},${a.top == null ? '' : Math.round(a.top)},${a.width == null ? '' : Math.round(a.width)},${a.height == null ? '' : Math.round(a.height)}`
}

const bridge = getHiraBridge()
bridge.on.subscribe(IPC_EVENTS.tabpreviewOverlayShow, (payload) => {
  showTabPreview((payload || {}) as unknown as TabPreviewShowPayload)
})
bridge.on.subscribe(IPC_EVENTS.tabpreviewOverlayHide, hideTabPreview)

;(async () => {
  try { await bridge.provider.invoke('tabpreview-overlay:ready', {}) } catch {}
})()
