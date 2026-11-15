import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { NavHistorySnapshot } from '@hira-ng/ui-common'
import { getHiraBridge, type JsonRecord } from './bridge.js'

// 标签领域客户端 —— 与 bookmarks-client 同构（引用计数桥订阅）：
// invoke 全走 IPC_ROUTES 枚举、推送全走 IPC_EVENTS 枚举，不留裸字符串通道。
//
// 关键修复（内存/监听器归零）：旧实现每次 onChanged(fn) 都新挂一个
// ipcRenderer 监听，N 个订阅者 = N 条桥通道 + N 次广播放大。
// 现在改为引用计数单例：全局只挂 1 条桥订阅，最后一个订阅者退订时才拆。

const listeners = new Set<(payload: JsonRecord) => void>()
/** 桥订阅单例：onChanged 调 N 次也只挂一个 ipcRenderer 监听（防广播放大） */
let bridgeSubscription: (() => void) | null = null

function ensureBridgeSubscription() {
  if (bridgeSubscription) return
  bridgeSubscription = getHiraBridge().on.subscribe<JsonRecord>(IPC_EVENTS.tabChanged, (payload) => {
    broadcast(payload)
  })
}

function broadcast(payload: JsonRecord): void {
  for (const fn of listeners) {
    try {
      fn(payload)
    } catch (e) {
      console.error('[tabs-client] listener error', e)
    }
  }
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/** fire-and-forget 上报（拖动路径上的高频消息，不值得配一个 Promise —— 失败由下次覆盖）。 */
function send(route: string, payload?: unknown): void {
  try {
    getHiraBridge().provider.send(route, payload)
  } catch (_) {}
}

/**
 * 与 onChanged 同构的「引用计数单例桥订阅」工厂：N 个订阅者只挂 1 条 ipcRenderer 监听。
 */
function createEventChannel<T extends JsonRecord = JsonRecord>(route: string) {
  const set = new Set<(payload: T) => void>()
  let sub: (() => void) | null = null
  return (fn: (payload: T) => void): (() => void) => {
    set.add(fn)
    if (!sub) {
      sub = getHiraBridge().on.subscribe<T>(route, (payload) => {
        for (const f of set) {
          try {
            f(payload)
          } catch (e) {
            console.error('[tabs-client] event listener error', e)
          }
        }
      })
    }
    return () => {
      set.delete(fn)
      if (set.size === 0 && sub) {
        sub()
        sub = null
      }
    }
  }
}

/** 分屏几何推送（本窗口）—— 与 tab:changed 分开，见 ipc-channels 的说明。 */
const subscribeSplitChanged = createEventChannel(IPC_EVENTS.splitChanged)
/** 独立侧栏聚焦框几何推送（本窗口）—— 与 split 同一条思路，只是只有一个面。 */
const subscribeWebSidebarChanged = createEventChannel(IPC_EVENTS.webSidebarChanged)
/** 速览（A1）装饰面（外环阴影 + 聚焦框）的几何推送（本窗口）—— 与 split / web-sidebar 同一族。 */
const subscribeGlanceChanged = createEventChannel(IPC_EVENTS.glanceChanged)
/** 跨窗口标签同步的截图占位（本窗口）—— 见 ipc-channels 的说明（A5/J15）。 */
const subscribeSyncPlaceholder = createEventChannel(IPC_EVENTS.tabSyncPlaceholder)

export const tabsClient = {
  list() {
    return invoke(IPC_ROUTES.tabList)
  },
  projection() {
    return invoke(IPC_ROUTES.tabProjection)
  },
  createStack({ tabIds, label, accent, collapsed, pinned }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabStackCreate, { tabIds, label, accent, collapsed, pinned })
  },
  setTabStack(tabId: string | number, stackId: string | null) {
    return invoke(IPC_ROUTES.tabStackSet, { tabId, stackId })
  },
  toggleStack(stackId: string) {
    return invoke(IPC_ROUTES.tabStackToggle, { stackId })
  },
  renameStack(stackId: string, label: string) {
    return invoke(IPC_ROUTES.tabStackRename, { stackId, label })
  },
  setStackColor(stackId: string, accent: string) {
    return invoke(IPC_ROUTES.tabStackSetColor, { stackId, accent })
  },
  mergeStacks(sourceStackId: string, targetStackId: string) {
    return invoke(IPC_ROUTES.tabStackMerge, { sourceStackId, targetStackId })
  },
  /**
   * 解散标签组：成员全部回到散标签、组元数据删掉（"全部恢复正常状态"）。
   * 与 domain 的 `splitStack`（把部分成员迁到另一个新组）不是同一件事 —— 见 ui-common#tab/chipMenu。
   */
  dissolveStack(stackId: string) {
    return invoke(IPC_ROUTES.tabStackDissolve, { stackId: String(stackId == null ? '' : stackId) })
  },
  /** 全部标签栈（带 count/children）—— 右键菜单 / 面板一次拿全量。 */
  async listStacks() {
    const res = await invoke(IPC_ROUTES.tabStackList)
    return Array.isArray(res && res.stacks) ? res.stacks : []
  },
  /** 单个标签栈；不存在 → null。 */
  getStack(stackId: string) {
    return invoke(IPC_ROUTES.tabStackGet, { stackId: String(stackId == null ? '' : stackId) })
  },
  /** 某标签所属的栈；不在栈里 → null。 */
  getStackOfTab(tabId: string | number) {
    return invoke(IPC_ROUTES.tabStackOfTab, { tabId: String(tabId == null ? '' : tabId) })
  },
  /** 标签是否归属任一现存栈。 */
  async isTabInAnyStack(tabId: string | number) {
    const res = await invoke(IPC_ROUTES.tabStackIsTabInAny, { tabId: String(tabId == null ? '' : tabId) })
    return !!(res && res.inStack)
  },
  /**
   * 通用字段 patch（label / accent / collapsed）。
   * 一次改多项只触发一次 tab:changed —— 比连续调 renameStack + setStackColor 少一次渲染。
   */
  updateStack(stackId: string, patch: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabStackUpdate, {
      stackId: String(stackId == null ? '' : stackId),
      patch
    })
  },
  /**
   * 新建标签。
   * `containerProfileId`（N10 容器标签，可选）：用**另一个 profile 的身份**开这个标签 ——
   * cookie / 存储走那个 profile 的 Session，但标签仍归属当前空间（不切 profile、不切 space）。
   */
  newTab({ url, containerProfileId }: JsonRecord = {}) {
    const payload: JsonRecord = { url }
    if (containerProfileId) payload.containerProfileId = String(containerProfileId)
    return invoke(IPC_ROUTES.tabNew, payload)
  },
  /**
   * 新建无痕标签页。
   *
   * 为什么单独一个方法而不是给 newTab 多传一个开关：无痕是**另一条通道**
   *（主进程侧落到 `newIncognitoTab`，与 `tab:new-incognito` 键盘动作同一条路），
   * 在旧通道里加字段会与那条键盘动作分叉。
   */
  newIncognitoTab({ url }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabNewIncognito, { url })
  },
  switchTab(tabId: string | number) {
    return invoke(IPC_ROUTES.tabSwitch, { tabId })
  },
  closeTab(tabId: string | number) {
    return invoke(IPC_ROUTES.tabClose, { tabId })
  },
  closeOthers(tabId: string | number) {
    return invoke(IPC_ROUTES.tabCloseOthers, { tabId })
  },
  closeRight(tabId: string | number) {
    return invoke(IPC_ROUTES.tabCloseRight, { tabId })
  },
  /**
   * 归档单个标签（J9）：关闭 + 记入「归档区」（可在归档面板里恢复）。
   * 与自动归档（`tabs.archiveAfter`）走同一条引擎 —— 区别只在谁来触发。
   */
  archive(tabId: string | number) {
    return invoke(IPC_ROUTES.tabArchive, { tabId })
  },
  reorder({ draggedId, targetId, insertAfter, targetStackId }: {
    draggedId: string
    targetId?: string
    insertAfter?: boolean
    targetStackId?: string | null
  }) {
    return invoke(IPC_ROUTES.tabReorder, {
      draggedId,
      targetId,
      insertAfter,
      targetStackId
    })
  },
  togglePin(tabId: string | number) {
    return invoke(IPC_ROUTES.tabTogglePin, { tabId })
  },
  /**
   * 把标签放进固定文件夹（= pin 动作）。`stackId` 省略 → 默认固定组（没有就新建）。
   *
   * 为什么不复用 `setTabStack`：那条只搬运**同种类**标签（真源 tab-policy），
   * 普通标签 → 固定文件夹属于跨种类，必须走这条显式 pin 通道，否则会被策略拒绝。
   * 已固定标签换文件夹走这里也成立（引擎内部会退化成同种类搬动）。
   */
  addToPinnedGroup(tabId: string | number, stackId?: string | null) {
    const payload: JsonRecord = { tabId: String(tabId == null ? '' : tabId) }
    if (stackId != null && String(stackId) !== '') payload.stackId = String(stackId)
    return invoke(IPC_ROUTES.tabPinnedGroupAdd, payload)
  },
  toggleMute(tabId: string | number) {
    return invoke(IPC_ROUTES.tabToggleMute, { tabId })
  },
  /** 周期性自动刷新（C7）：`intervalMs` = 0 关闭；返回实际生效的间隔（服务端有下界夹取）。 */
  setAutoRefresh(tabId: string | number, intervalMs: number) {
    return invoke(IPC_ROUTES.tabAutoRefresh, { tabId, intervalMs })
  },
  duplicate(tabId: string | number) {
    return invoke(IPC_ROUTES.tabDuplicate, { tabId })
  },
  undoClose() {
    return invoke(IPC_ROUTES.tabUndoClose)
  },
  /**
   * 已关闭标签页列表（最近关闭在前）。
   * 契约响应为 `{ tabs: [...] }`，这里原样返回，由消费方取 `.tabs`。
   */
  recentlyClosed() {
    return invoke(IPC_ROUTES.tabRecentlyClosed)
  },
  /** 清空已关闭标签页列表 → `{ cleared: number }` */
  clearRecentlyClosed() {
    return invoke(IPC_ROUTES.tabRecentlyClosedClear)
  },
  /**
   * 恢复「最近关闭」列表里的指定一项。
   * `index` 口径 = `recentlyClosed()` 返回顺序（0 = 最近关闭在前），与 Ctrl+Shift+T
   * 共用同一份主进程撤销栈；恢复成功会把那个标签切到前台。
   */
  restoreRecentlyClosed(index: number) {
    return invoke(IPC_ROUTES.tabRecentlyClosedRestore, { index })
  },
  stats() {
    return invoke(IPC_ROUTES.tabStats)
  },
  /**
   * 标签截图「读取地址」（对齐 RT tab-snapshot）：无可用帧返回 null，消费方回退 favicon。
   * 只取地址，字节仍由主进程 hira://tab-snapshot 直吐 —— 渲染层零位图驻留。
   * @param {string} tabId
   * @returns {Promise<string|null>}
   */
  async snapshot(tabId: string) : Promise<string|null> {
    try {
      const res = await invoke<{ url?: string | null }>(IPC_ROUTES.tabSnapshot, { tabId })
      return (res && res.url) || null
    } catch (_) {
      return null
    }
  },
  /**
   * 该标签此刻的内存占用（hover 预览浮层显示用）。
   *
   * 数值只能由主进程给出（与任务管理器同源，见 `main/ipc/tab-memory.ts`），渲染层不估算。
   * 返回 `null` = 这次问不到（IPC 出错 / 标签已不在），调用方**不显示**这一行；
   * 拿到对象时看两个字段：`sleeping`（该标签没有活着的渲染进程）与 `memoryKB`（KB，可能为 null）。
   *
   * @param {string} tabId
   * @returns {Promise<{tabId:string, sleeping:boolean, memoryKB:number|null}|null>}
   */
  async memory(tabId: string) : Promise<{tabId:string, sleeping:boolean, memoryKB:number|null}|null> {
    try {
      return await invoke<{ tabId: string; sleeping: boolean; memoryKB: number | null }>(IPC_ROUTES.tabMemory, { tabId })
    } catch (_) {
      return null
    }
  },
  visibleAfter(tabId: string) {
    return invoke(IPC_ROUTES.tabVisibleAfter, { tabId })
  },
  navigate({ url, typed }: JsonRecord = {}) {
    // typed 只在地址栏手动提交时为 true；其余入口（书签 / 搜索建议 / 内部页）
    // 不传，保持「非 typed」语义，避免把 typedCount 刷成噪音。
    return invoke(IPC_ROUTES.navGo, typed ? { url, typed: true } : { url })
  },
  back(tabId?: string) {
    return invoke(IPC_ROUTES.navBack, tabId ? { tabId } : undefined)
  },
  forward(tabId?: string) {
    return invoke(IPC_ROUTES.navForward, tabId ? { tabId } : undefined)
  },
  /**
   * 导航历史条目（右键前进/后退菜单 / Ctrl 新标签 / Alt 预览共用）。
   * 失败一律回落空集：调用方（菜单、预览）只需要"有没有东西可展示"，
   * 不该因为主进程一次异常就抛断整个右键流程。
   */
  async navigationEntries(tabId?: string): Promise<NavHistorySnapshot> {
    try {
      const res = await invoke(IPC_ROUTES.navEntries, tabId ? { tabId } : undefined)
      if (!res || !Array.isArray(res.entries)) {
        return { entries: [], activeIndex: -1, canGoBack: false, canGoForward: false }
      }
      return res as unknown as NavHistorySnapshot
    } catch (_) {
      return { entries: [], activeIndex: -1, canGoBack: false, canGoForward: false }
    }
  },
  /** 跳到导航历史里的指定条目（右键菜单选中项）。 */
  goToEntry(tabId: string | undefined, index: number) {
    const req: JsonRecord = { index }
    if (tabId) req.tabId = tabId
    return invoke(IPC_ROUTES.navGoToEntry, req)
  },
  reload(tabId?: string) {
    return invoke(IPC_ROUTES.navReload, tabId ? { tabId } : undefined)
  },
  /** 中止加载 —— 刷新按钮在「加载中」形态下的动作（见 ui-navbar 的刷新/停止切换）。 */
  stop(tabId?: string) {
    return invoke(IPC_ROUTES.navStop, tabId ? { tabId } : undefined)
  },
  onChanged(fn: (payload: JsonRecord) => void): () => void {
    listeners.add(fn)
    ensureBridgeSubscription()
    return () => {
      listeners.delete(fn)
      // 最后一个监听器退订时才拆桥订阅；引用计数归零前桥订阅永不重复
      if (listeners.size === 0 && bridgeSubscription) {
        bridgeSubscription()
        bridgeSubscription = null
      }
    }
  },

  // ── 分屏（Split View）───────────────────────────────────────────────────
  // 与标签栈**正交**：栈是收纳（一次只见一个成员），分屏是并列（全部成员同时可见）。
  // 所有"不合法"由主进程返回 null（成员不足两个 / 超上限 / 组不存在）——
  // 调用方据 null 给出原因，不出现"点了没反应"。
  /** 建组：`tabIds` 顺序 = **格的顺序**（不是标签条顺序）。 */
  createSplit({ tabIds, layout, activeTabId }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabSplitCreate, { tabIds, layout, activeTabId })
  },
  /**
   * 「与当前活动标签分屏」—— Alt/Option + 点击标签的入口（对齐 Firefox / Zen）。
   * 只报被点的那个标签；"另一个格子"由主进程解析（活动标签只有主进程是权威）。
   */
  splitWithActive(tabId: string) {
    return invoke(IPC_ROUTES.tabSplitWith, { tabId })
  },
  /** 解散组：全部成员保留（对齐 Edge 的 "Separate two tabs"）。 */
  dissolveSplit(splitId: string) {
    return invoke(IPC_ROUTES.tabSplitDissolve, { splitId })
  },
  /** 单标签入组 / 出组（splitId 传 null 即出组）。 */
  setTabSplit(tabId: string, splitId: string | null) {
    return invoke(IPC_ROUTES.tabSplitSet, { tabId, splitId })
  },
  /** 改形态：'row'（左右）| 'column'（上下）| 'grid'（网格）。 */
  setSplitLayout(splitId: string, layout: 'row' | 'column' | 'grid') {
    return invoke(IPC_ROUTES.tabSplitLayout, { splitId, layout })
  },
  /** 换活动格（地址栏 / 快捷键 / Find 随之指向那一格）。 */
  setSplitActive(splitId: string, tabId: string) {
    return invoke(IPC_ROUTES.tabSplitActive, { splitId, tabId })
  },
  /** 反转格的顺序（只换格，不动标签条）。 */
  reverseSplit(splitId: string) {
    return invoke(IPC_ROUTES.tabSplitReverse, { splitId })
  },
  /**
   * 按**预设**改比例：'even' | 'main-70' | 'main-30'。
   * 只报预设名 —— 预设 → 比例的换算在主进程（格数是变量，渲染层不该各算一遍）。
   */
  setSplitRatioPreset(splitId: string, preset: 'even' | 'main-70' | 'main-30') {
    return invoke(IPC_ROUTES.tabSplitRatioPreset, { splitId, preset })
  },
  /** 键盘格导航：'left' | 'right' | 'up' | 'down'（从活动格找相邻格并切过去）。 */
  focusSplitPane(direction: 'left' | 'right' | 'up' | 'down') {
    return invoke(IPC_ROUTES.tabSplitFocus, { direction })
  },
  /** 复原**最近解散**的分屏组（成员仍在才可复原）。 */
  restoreSplit() {
    return invoke(IPC_ROUTES.tabSplitRestore)
  },
  /**
   * 「把标签拖到了网页区域」（Arc / Edge 拖动式分屏）。
   *
   * **单向**：dragend 是一次性事件，不需要回值。只报"哪个标签 / 拖前在看哪个" ——
   * **落点与判定全在主进程**（见 TabManager#dropTabOnContent）：
   *   · 四个纵向宿主的渲染进程里没有主窗口外壳 DOM；
   *   · 而且原生拖拽离开源视口后 `dragend` 的坐标已不是"松手在哪"，
   *     只有主进程读 `screen.getCursorScreenPoint()` 才是权威。
   */
  dropTabOnContent({ tabId, baseTabId }: JsonRecord = {}) {
    send(IPC_ROUTES.tabDragDropContent, { tabId, baseTabId })
  },
  /**
   * 「开始拖一个标签了」（`dragstart` 那一刻）。
   *
   * 为什么必须有这条：**拖动期间渲染层收不到任何指针事件** —— 指针一进网页原生视图就
   * 离开了外壳视口，`dragover` 全部落在网页那边。而"要落在哪一边"的预览必须在拖动期间
   * 算出来，所以只有一条路：告诉主进程"我开始拖了"，由它按 30fps 采样屏幕光标
   * （见 main/tab-drop-zone.js）。单向，无回值。
   */
  beginTabDropOnContent({ tabId, baseTabId }: JsonRecord = {}) {
    send(IPC_ROUTES.tabDragDropBegin, { tabId, baseTabId })
  },
  /**
   * 「这次拖动结束了，但**没有**落在网页上」（dragend 的兜底收尾）。
   *
   * 与 `dropTabOnContent` 成对：那条报"我落下了，且落点可能是网页"（主进程拿最后一次意图
   * 决定分不分屏），这条只报"这场拖结束了、不必再采样"。**整场收尾不能只挂在 commit 上** ——
   * 在标签列表里松手（排序 / 成组）根本不走 commit，主进程的采样表与侧栏唤出冻结就会永远留着
   * （表现：落位框黏在屏上、侧栏悬停不再收起）。单向，无回值。
   */
  cancelTabDropOnContent() {
    send(IPC_ROUTES.tabDragDropCancel, {})
  },
  /** 跨窗口拖放：由目标窗口发起，主进程按 tabId 找回源窗口后整体迁移。 */
  moveTabToWindow({ tabId, targetId, insertAfter }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabMoveToWindow, {
      tabId,
      targetId: targetId == null ? null : targetId,
      insertAfter: insertAfter === true
    })
  },
  listSplits() {
    return invoke(IPC_ROUTES.tabSplitList)
  },
  // ── 速览（Glance，A1）—— 与分屏并列的一组；恰好两张卡叠放。
  /** 建组：`tabIds` 恰好两个；`frontTabId` 指定谁在最上面（缺省取第二个）。 */
  createGlance({ tabIds, frontTabId }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.tabGlanceCreate, { tabIds, frontTabId })
  },
  /** 「与被点标签叠成速览」：另一个成员由主进程解析（活动标签只有主进程权威）。 */
  glanceWithActive(tabId: string) {
    return invoke(IPC_ROUTES.tabGlanceWith, { tabId })
  },
  /** 解散速览组：两张标签都保留，只清归属。 */
  dissolveGlance(glanceId: string) {
    return invoke(IPC_ROUTES.tabGlanceDissolve, { glanceId })
  },
  /** 交换前后（把某成员提为前台大卡）。 */
  setGlanceFront(glanceId: string, tabId: string) {
    return invoke(IPC_ROUTES.tabGlanceFront, { glanceId, tabId })
  },
  /** 列出全部速览组（右键菜单弹出前问一次，与 listSplits 同款）。 */
  listGlances() {
    return invoke(IPC_ROUTES.tabGlanceList)
  },
  /** 分隔条拖拽：只报指针位置，比例由主进程用共享算术算（见 split-layout.mjs）。 */
  dragSplitDivider({ index, axis, position }: JsonRecord = {}) {
    return invoke(IPC_ROUTES.layoutSplitDrag, { index, axis, position })
  },
  /**
   * 分隔条拖动帧：单向发送，不等回包。
   *
   * 拖动帧只要把最新指针位置推给主进程；失败可由下一帧或松手时的最终调用覆盖。
   */
  dragSplitDividerLive({ index, axis, position }: JsonRecord = {}) {
    send(IPC_ROUTES.layoutSplitDrag, { index, axis, position })
  },
  /** 分屏几何快照（挂载时拉一次；推送首帧可能早于订阅）。 */
  splitGeometry() {
    return invoke(IPC_ROUTES.layoutSplitGeometry)
  },
  /** 分屏几何变化（本窗口）—— 外壳据此重画分隔条与格标记。 */
  onSplitChanged(fn: (payload: JsonRecord) => void) {
    return subscribeSplitChanged(fn)
  },
  /** 独立侧栏**聚焦框**几何快照（挂载时拉一次；推送首帧可能早于订阅）。 */
  webSidebarGeometry() {
    return invoke(IPC_ROUTES.layoutWebSidebarGeometry)
  },
  /**
   * 独立侧栏聚焦框几何变化（本窗口）。
   *
   * 与 `onSplitChanged` **刻意分成两条**：侧栏与分屏是两套系统，只是"画个淡蓝框"
   * 长得一样。合起来的话，侧栏一开就会把分屏的框刷没（两条状态互相覆盖）。
   */
  onWebSidebarChanged(fn: (payload: JsonRecord) => void) {
    return subscribeWebSidebarChanged(fn)
  },
  /** 速览（A1）**外环阴影**的几何快照（挂载时拉一次；推送首帧可能早于订阅）。 */
  glanceGeometry() {
    return invoke(IPC_ROUTES.layoutGlanceGeometry)
  },
  /**
   * 速览外环阴影的几何变化（本窗口）—— 外壳据此重画那圈影子。
   * 载荷 `{ back: rect|null, radius }`（窗口内容区坐标；`back: null` = 收起）。
   * ⚠ 卡间投影 + 蓝聚焦框不走这里（它们注入进 **back 卡**那一页，见
   *   infra-window/glance-deck-chrome.js）。
   */
  onGlanceChanged(fn: (payload: JsonRecord) => void) {
    return subscribeGlanceChanged(fn)
  },
  /**
   * 跨窗口标签同步的截图占位（J15/A5）—— 活动标签被同步迁走后，本窗口内容区留一张截图。
   * 载荷 `{ url: string|null }`（`null` = 收起）。
   */
  onSyncPlaceholder(fn: (payload: JsonRecord) => void) {
    return subscribeSyncPlaceholder(fn)
  }
}

