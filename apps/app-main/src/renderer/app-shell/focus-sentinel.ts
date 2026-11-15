/**
 * 外壳的「键盘焦点哨兵」（app-shell 渲染层，唯一一份）。
 *
 * 为什么需要它：外壳（本 webContents）与网页（标签 / 侧栏 / 面板各自的 WebContentsView）
 * 同处一个窗口，原生键盘焦点同一时刻只属于其中一个。点击标签栏、地址栏空白、侧栏等
 * **外壳界面**，焦点就被外壳拿走；主进程那侧 `LayerManager.reallocateFocus()` 在外壳持焦时
 * 直接早退（保护地址栏输入），于是**没有任何人把焦点还回网页** —— 表现就是
 * 「点了下标签栏，网页里的输入框失焦、再敲键盘没反应」。
 *
 * 本模块只做两件事，且**只上报事实、不自己抢焦点**（焦点归主进程唯一裁决）：
 *   1. 外壳当前是否由「可编辑元素」持焦 → `IPC_ROUTES.shellFocusState`。
 *      主进程据此判断「用户正在地址栏/搜索框里打字，别还焦」，以及「点空白处后可以还焦」。
 *   2. 在外壳里按下鼠标时分类：这次点击是「要键盘输入」（输入框 / 按钮 / 标签 / 菜单项…）
 *      还是「只想点一下外壳」→ 后者上报 `IPC_ROUTES.contentFocus`，由主进程把焦点还给
 *      用户上一次打字的那个内容面。
 *
 * 为什么分类必须放在渲染层：只有这里知道 DOM 语义（谁是输入框、谁是标签、谁是菜单项）。
 * 主进程只有 webContents 粒度，判断不出「点的是标签栏的空白还是地址栏」。
 *
 * 覆盖开关（供其它 UI 模块声明自己的点击语义，避免本模块硬编码它们的结构）：
 *   · `data-content-focus="keep"`    —— 命中即**不**还焦（例：地址栏整块字段，点空白也该
 *                                       留在输入框里）。
 *   · `data-content-focus="release"` —— 命中即**强制**还焦（无视按钮/标签之类豁免）。
 *
 * 扩展方式：新增「点了就该保住键盘」的界面时，加 `data-content-focus="keep"` 即可；
 * 无需改本文件，也无需在主进程加判据。
 */

import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge } from '../shared/bridge.js'

/** 真正吃键盘输入的元素：外壳持焦 + 命中它 = 用户正在打字。 */
const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]'
].join(', ')

/**
 * 点击后**仍应把键盘留给外壳**的元素（键盘操作有意义：回车触发、方向键切换、Esc 关闭…）。
 * 这些一律不触发「还焦网页」——否则点完按钮焦点就跑进网页，菜单的 Esc 兜底与
 * 键盘导航会当场失效。
 */
const KEYBOARD_OWNER_SELECTOR = [
  EDITABLE_SELECTOR,
  'button',
  'label',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="tablist"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="slider"]',
  '[data-keyboard-owner]'
].join(', ')

/** 标签条目：点它 = 切标签，焦点归属由主进程的标签激活流程决定，这里绝不插手。 */
const TAB_ITEM_SELECTOR = '[data-tab-id]'

const DIRECTIVE_ATTR = 'data-content-focus'

function closestOf(el: EventTarget | null, selector: string): Element | null {
  if (!(el instanceof Element) || typeof el.closest !== 'function') return null
  try {
    return el.closest(selector)
  } catch (_) {
    return null
  }
}

/** 某个元素（或其祖先）是不是可编辑的键盘输入目标。 */
function isEditableTarget(el: EventTarget | null): boolean {
  return !!closestOf(el, EDITABLE_SELECTOR)
}

/** 读取最近的 `data-content-focus` 声明（`keep` / `release` / 空）。 */
function directiveOf(el: EventTarget | null): string {
  const holder = closestOf(el, `[${DIRECTIVE_ATTR}]`)
  if (!holder) return ''
  return String(holder.getAttribute(DIRECTIVE_ATTR) || '').trim()
}

/**
 * 安装哨兵。
 * @param {Document} [doc] 外壳文档（默认当前文档；测试/多文档场景可注入）
 */
export function installFocusSentinel(doc: Document = document): () => void {
  const win = doc.defaultView || window

  const send = (route: string, payload: unknown): void => {
    try {
      const provider = getHiraBridge() && getHiraBridge().provider
      if (!provider || typeof provider.send !== 'function') return
      provider.send(route, payload)
    } catch (_) {}
  }

  // ── 1. 可编辑态上报（去重：只在翻转时发） ──────────────────────────────
  // 用「已上报值」而不是每次 focusin 都发：键盘 Tab 在按钮间移动会连续 focusin，
  // 那些事件对主进程毫无信息量，白占 IPC。
  let reportedEditable: boolean | null = null
  let reportTimer: number | null = null
  /** `onFocusOut` 的延时判定（单实例，见该函数的说明） */
  let focusOutTimer: number | null = null
  /** 「点外壳空白处 → 稍后请求还焦」的延时投递（dispose 要能撤销） */
  let pointerTimer: number | null = null

  const flushEditable = (editable: boolean): void => {
    reportTimer = null
    if (editable === reportedEditable) return
    reportedEditable = editable
    send(IPC_ROUTES.shellFocusState, { editable })
  }

  /**
   * 「用户意图」标记：只有**真实的人**在外壳输入框里操作，它才为真。
   *
   * 这里为什么不能信「`activeElement` 是输入框」这类状态快照：
   *   Alt+Tab 切走时 Chromium 收走 native focus，但**不清 DOM 焦点** —— 地址栏
   *   input 仍是 activeElement；切回来时外壳先拿到 native focus，`hasFocus()`
   *   立刻为真。于是在用户**一个字都没敲**的情况下，「hasFocus() + activeElement」
   *   会判成 true，主进程据此认为"他在地址栏打字"，把整条回焦链拦死 ——
   *   用户看到的就是"切回来什么都没焦点，得手动点网页"。
   *
   * 判定必须基于**意图**而非**快照**：
   *   · `focusin` 命中输入框         → 置真（他确实要在这里打字）；
   *   · `focusout` 且新焦点已不在输入框 → 置假（意图随人离开而消失）；
   *   · 窗口失活                     → 置假（切回来**永不**自动恢复）。
   * 最后一条是关键：切回来时人想继续看网页，不是继续敲地址栏。
   */
  let userEditingShell = false

  /** 此刻的「用户可编辑意图」：真人已在外壳输入框里操作，且焦点仍在输入框。 */
  const editableNow = (): boolean => userEditingShell && isEditableTarget(doc.activeElement)

  const scheduleEditableReport = (): void => {
    if (!reportTimer) reportTimer = win.setTimeout(() => flushEditable(editableNow()), 0)
  }

  const forceEditableReport = (editable: boolean): void => {
    if (reportTimer) {
      clearTimeout(reportTimer)
      reportTimer = null
    }
    flushEditable(editable)
  }

  // ── 2. 指针分类：点外壳空白处 → 请求把键盘还给内容面 ────────────────────
  const requestContentFocus = (reason: string): void => {
    send(IPC_ROUTES.contentFocus, { reason })
  }

  const onPointerDown = (event: PointerEvent): void => {
    // 中键 / 右键（含菜单）不改变键盘归属
    if (!event || event.button !== 0) return
    const target = event.target
    const directive = directiveOf(target)
    if (directive === 'keep') return
    // 点到任何非「keep」区域 = 明确的外壳点击：先把「正在输入框里打字」的意图清零，
    // 再分派后续动作。不清零的话，主进程闸口② 还拿着上一次 focusin 的 true，
    // 会把紧随其后的还焦 / 切标签回焦**当场拦下** —— 这正是"点标签栏或空白处后
    // 网页就收不到键盘"的成因。`keep` 之外的点击本就宣告了人已离开输入框。
    userEditingShell = false
    forceEditableReport(false)
    if (directive !== 'release') {
      if (closestOf(target, TAB_ITEM_SELECTOR)) return
      if (closestOf(target, KEYBOARD_OWNER_SELECTOR)) return
    }
    // 让本次点击自己的处理（收起菜单 / 激活条目标号 / DOM focus）先跑完，
    // 再请求还焦 —— 否则可能刚把焦点还回去就被 click 处理又拽回外壳。
    if (pointerTimer) clearTimeout(pointerTimer)
    pointerTimer = win.setTimeout(() => {
      pointerTimer = null
      requestContentFocus('shell-pointer')
    }, 0)
  }

  // ── 3. 外壳 webContents 自身的获得/失去焦点 ─────────────────────────────
  // 窗口失活 = 人离开了外壳：意图当场清零并上报 false，主进程立刻获得还焦资格
  // （不能等切回来再算 —— 那时残留的 DOM 焦点会把人骗过去）。
  const onWindowBlur = (): void => {
    userEditingShell = false
    forceEditableReport(false)
  }
  // 窗口回到前台**不恢复**意图：只按当前（已清零的）意图重算。
  const onWindowFocus = (): void => scheduleEditableReport()

  /**
   * focusin 命中输入框 = **当场**就要打字的强信号：立即置真并上报 true，不等下一拍。
   * 其余情况走延时校验（新焦点可能只是落在按钮上）。
   */
  const onFocusIn = (event: FocusEvent): void => {
    if (isEditableTarget(event && event.target)) {
      userEditingShell = true
      forceEditableReport(true)
      return
    }
    scheduleEditableReport()
  }

  /**
   * 焦点离开某元素：延时一拍再判断**新焦点**落在哪里（focusout 先于 focusin）。
   * 已不在输入框 → 意图结束；仍在（Tab 在几个输入框间移动）→ 保持。
   *
   * 定时器必须**只留一个**：连续 focusout（Tab 快速穿过一串按钮）会每拍排一个回调，
   * 旧回调拿到的 `doc.activeElement` 已是过去时，会把刚置真的意图误判成假。
   * 同时必须可被 `dispose` 清掉 —— 卸载后仍跑一次回调 = 往已销毁的桥发 IPC。
   */
  const onFocusOut = (): void => {
    if (focusOutTimer) clearTimeout(focusOutTimer)
    focusOutTimer = win.setTimeout(() => {
      focusOutTimer = null
      if (!isEditableTarget(doc.activeElement)) userEditingShell = false
      scheduleEditableReport()
    }, 0)
  }

  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('pointerdown', onPointerDown, true)
  win.addEventListener('blur', onWindowBlur)
  win.addEventListener('focus', onWindowFocus)

  // 安装时先同步一次现状（启动瞬间外壳通常无人持焦；有残留 DOM 焦点也不算数）
  forceEditableReport(editableNow())

  return function disposeFocusSentinel() {
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('pointerdown', onPointerDown, true)
    win.removeEventListener('blur', onWindowBlur)
    win.removeEventListener('focus', onWindowFocus)
    if (reportTimer) {
      clearTimeout(reportTimer)
      reportTimer = null
    }
    if (focusOutTimer) {
      clearTimeout(focusOutTimer)
      focusOutTimer = null
    }
    if (pointerTimer) {
      clearTimeout(pointerTimer)
      pointerTimer = null
    }
  }
}
