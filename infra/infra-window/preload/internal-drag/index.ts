/**
 * internal-drag —— 「外壳里的拖拽项经过任意 WebContents 视图」的页面侧接管。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────
 * HTML5 拖拽的光标由**指针底下那个视图**决定：拖标签时指针一进网页区域，
 * 事件就交给那一格网页的 webContents。网页没写过 drop 处理 → 默认 `dropEffect='none'`
 * → 光标一路显示「禁止」（Windows 的 no-drop 圈叉），与"正在拖动一个标签"的手感完全相反。
 *
 * 外壳（标签条 / 导航栏 / 侧栏）里的 `dragover` 各自 `preventDefault()` 过，所以从标签
 * 拖到外壳其它地方光标是正常的；**唯独网页区域没人接**。这里补上的就是那一格：
 * `dataTransfer.types` 里带统一拖拽协议（`shared-types#drag-item`）→ 认成合法落点。
 *
 * ── 为什么按 MIME 判、而不是等主进程报"拖动中" ─────────────────────────
 * 拖拽是浏览器进程内的一等公民：`types` 在 `dragover` 阶段就能读（`getData` 要到 drop
 * 才可读），所以判据完全在页面侧自足 —— 不需要一条 IPC、不需要跨进程状态同步，
 * 也就没有"信号晚到一拍 → 光标先闪一下禁止"的中间帧。
 *
 * ── 与网页自带 drop zone 的边界（与 file-drop 同一条规矩）─────────────
 * 监听挂在 `window` 的**冒泡阶段**（事件链最后一站），且只在 `defaultPrevented === false`
 * 时接管：网页自己的拖放区（上传框 / 编辑器 / 画板）先写了 `preventDefault` 的，
 * 本模块一个字都不改，光标语义仍归它。
 *
 * ── 落点语义不在本模块 ──────────────────────────────────────────────
 * 这里只负责「别显示禁止光标」+「别让网页把这一下当默认动作（导航 / 打开）吃掉」。
 * 真正落在左/右/上是主进程按屏幕光标算的（`tabDropZone`），提交在拖拽源的
 * `dragend` 里（见 ui-tabbar#tabRecord）—— 两边都不需要知道这里存在。
 *
 * ── 为什么通道名是字面量 ──────────────────────────────────────────
 * preload 是沙箱环境、且是启动最早期执行的代码：不能 require 本地模块。
 * 与 file-drop 同口径，这里保留唯一一处 MIME 字面量（与 shared-types#DRAG_ITEM_MIME 同值）。
 */

/** 统一拖拽协议（`shared-types/src/drag-item.mjs#DRAG_ITEM_MIME`）。 */
const DRAG_ITEM_MIME = 'application/x-hira-item'
/** 旧版标签拖拽 MIME（只写不读的历史包袱，见 tabRecord 的 dragstart）。 */
const LEGACY_TAB_MIME = 'application/x-ng-tab'

/**
 * 这次拖拽是不是我们自己的拖拽项。
 *
 * 只读 `types`（`dragover` 阶段唯一可靠的东西）—— 不碰 `getData`：
 * 跨视图时 `getData` 在 `dragover` 一律返回空串（保护机制），拿它判会永远判成"不是"。
 */
function hasInternalItem(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  const types = dataTransfer.types
  if (!types) return false
  for (let i = 0; i < types.length; i += 1) {
    const t = String(types[i]).toLowerCase()
    if (t === DRAG_ITEM_MIME || t === LEGACY_TAB_MIME) return true
  }
  return false
}

/**
 * 这次落点该报哪个 dropEffect。
 *
 * 必须落在源端 `effectAllowed` 的允许集合里 —— 否则 Chromium 判成"不许放下"，
 * 光标照样是禁止（书签 / 集锦等非标签源可能只允许 copy，不能一律报 move）。
 * 判据与 `shared-types#pickDropEffect` 一致；preload 不能引它（沙箱 + 不背依赖），
 * 这里保留同名语义的最小副本。
 */
function dropEffectFor(dataTransfer: DataTransfer): string {
  let allowed = ''
  try { allowed = String(dataTransfer.effectAllowed || '') } catch (_) {}
  switch (allowed) {
    case 'copy': return 'copy'
    case 'move': return 'move'
    case 'link': return 'link'
    case 'copyLink': return 'copy'
    case 'linkMove': return 'move'
    // copyMove / all / uninitialized / 空：搬一格是默认语义（标签条就是 copyMove）。
    default: return 'move'
  }
}

let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true

  /**
   * 这一场拖拽是否由我们接管（与 file-drop 的 `accepted` 同一套状态机）：
   * 只有「上一次 dragenter / dragover 没有被内层 preventDefault」才置 true ——
   * 网页自己的 drop zone 一 preventDefault，我们就退出，光标与落点仍归它。
   */
  let accepted = false

  const accept = (event: DragEvent): void => {
    // 取消默认 = 把当前视图认成合法落点（Chromium 的判据，dragenter 也必须有）。
    try { event.preventDefault() } catch (_) {}
    // 在源端允许的集合里挑：标签用 move（搬一格），书签等只许 copy 的源才不会被判成禁止。
    try {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer) as DataTransfer['dropEffect']
      }
    } catch (_) {}
    accepted = true
  }

  window.addEventListener('dragenter', (event: DragEvent) => {
    if (!hasInternalItem(event.dataTransfer)) return
    if (event.defaultPrevented) { accepted = false; return }
    accept(event)
  }, false)

  window.addEventListener('dragover', (event: DragEvent) => {
    if (!hasInternalItem(event.dataTransfer)) return
    if (event.defaultPrevented) { accepted = false; return }
    accept(event)
  }, false)

  window.addEventListener('dragleave', (event: DragEvent) => {
    if (!hasInternalItem(event.dataTransfer)) return
    // relatedTarget 非空 = 只是在元素之间移动；为空 = 真的离开了本视图（与 file-drop 同）
    if (event.relatedTarget == null) accepted = false
  }, false)

  window.addEventListener('drop', (event: DragEvent) => {
    const wasAccepted = accepted
    accepted = false
    if (!wasAccepted) return
    if (!hasInternalItem(event.dataTransfer)) return
    // 吃掉网页的默认落点动作。真正"落在哪一格"由主进程按松手时的屏幕光标算，
    // 网页不需要、也不应该参与（见文件头「落点语义不在本模块」）。
    try { event.preventDefault() } catch (_) {}
  }, false)
}

install()
