/**
 * TabSync —— 跨窗口标签同步（A5 / J15）。
 *
 * ── 这是什么 ────────────────────────────────────────────────────────
 * 把多个窗口视作"显示器"，而不是"各装一套标签"：焦点切到哪个窗口，**当前活动标签的
 * 真实视图就移动到那个窗口**，原窗口留下一张截图占位（避免"移动"时出现空白/闪烁）。
 * 于是用户在任何窗口看到的都是同一份标签集合，只是物理屏幕不同。
 *
 * ── 为什么是「移动」而不是「复制/新开」──────────────────────────────
 * 复制会把一个页面变成两条互不相干的记录（表单/滚动/前进后退各一份）；新开则等于重新
 * 加载（丢状态）。只有**整体迁移 webContents**（宿主接 `TabManager#detachTab/adoptTab`，
 * 见 `main.js#moveTabToWindow`）才是真同步 —— 用户看到的是"这一页换了个屏幕"。
 * 本模块只做**编排**，迁移动作由宿主注入。
 *
 * ── 两条硬机制（都为了对付真实世界的抖动）──────────────────────────
 *  1. **代际计数器**：`browser-window-focus` 在切窗时会连续触发多次（点 A → A 获焦 →
 *     系统把 B 的 blur 也补发一次）。每次通知把代数 +1，队列里的任务**开跑前**比对
 *     代数，不等就整条丢弃 —— 否则会出现"照着一秒前的焦点去做陈旧迁移"，表现为
 *     标签在两个窗口之间来回弹。
 *  2. **串行队列**：采集截图（async）与迁移（async）之间不能交错 —— 两次并发迁移
 *     会各自 `detachTab` 同一个 webContents，第二遍拿到空 bundle。所有动作排进一条
 *     Promise 链，任何时刻只有一个在跑。
 *
 * ── 彻底解耦 ────────────────────────────────────────────────────────
 * 本文件不 require electron、不引用任何全局单例。窗口集合、活动标签、迁移动作、
 * 截图来源、占位渲染**全部由宿主注入**，因此可单测、可替换实现（同
 * `tab-drag-controller.js` 的口径）。
 *
 * 宿主注入（deps）：
 *   isEnabled()                      → boolean        设置项 `tabs.sync_across_windows`（**现读**）
 *   getActiveTabId(windowId)         → string|null    该窗口当前的活动标签
 *   isEligible(tabId)                → boolean        是否可迁移（排除无痕 / 内部页）
 *   captureSnapshot(tabId)           → Promise<string|null>  截图读取地址（hira://tab-snapshot?id=…）
 *   moveTab({tabId,targetWindowId})  → Promise<{ok,error?}>  实际迁移（宿主接 moveTabToWindow）
 *   showPlaceholder(windowId, {url}) → void           让该窗口外壳显示截图占位
 *   clearPlaceholder(windowId)       → void           收起该窗口的截图占位
 *   listWindowIds()                  → number[]       用于停用时清理全部占位
 *   onError({where, error})          → void           可选：诊断出口
 *
 * 宿主调用（本模块对外）：
 *   notifyFocus(windowId)            窗口获焦（`browser-window-focus`）
 *   notifyTabMoved(tabId, windowId)  手动拖拽迁移后同步"当前宿主"记账
 *   notifyDisabled()                 设置关闭时调用：清全部占位并复位
 *   forgetWindow(windowId)           窗口关闭
 */

/**
 * @param {object} deps
 */
interface TabSyncDependencies {
  isEnabled?(): boolean
  getActiveTabId?(windowId: number): string | null
  isEligible?(tabId: string): boolean
  captureSnapshot?(tabId: string): Promise<string | null> | string | null
  moveTab?(options: { tabId: string; targetWindowId: number }): Promise<{ ok: boolean; error?: string } | null | undefined>
  showPlaceholder?(windowId: number, options: { url: string }): void
  clearPlaceholder?(windowId: number): void
  listWindowIds?(): number[]
  onError?(error: { where: string; error: unknown }): void
}

interface TabSyncController {
  notifyFocus(windowId: number): void
  notifyTabMoved(tabId: string, windowId: number): void
  notifyDisabled(): void
  forgetWindow(windowId: number): void
  readonly hostWindowId: number | null
  readonly idle: Promise<void>
}

function createTabSync(deps: TabSyncDependencies = {}): TabSyncController {
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => false
  const getActiveTabId = typeof deps.getActiveTabId === 'function' ? deps.getActiveTabId : () => null
  const isEligible = typeof deps.isEligible === 'function' ? deps.isEligible : () => true
  const captureSnapshot = typeof deps.captureSnapshot === 'function' ? deps.captureSnapshot : null
  const moveTab = typeof deps.moveTab === 'function' ? deps.moveTab : null
  const showPlaceholder = typeof deps.showPlaceholder === 'function' ? deps.showPlaceholder : () => {}
  const clearPlaceholder = typeof deps.clearPlaceholder === 'function' ? deps.clearPlaceholder : () => {}
  const listWindowIds = typeof deps.listWindowIds === 'function' ? deps.listWindowIds : () => []
  const onError = typeof deps.onError === 'function' ? deps.onError : () => {}

  /** 代际计数器（见文件头「两条硬机制」①）。 */
  let generation = 0
  /** 串行变更队列（见文件头「两条硬机制」②）。 */
  let chain: Promise<void> = Promise.resolve()
  /**
   * 当前**托管**那份共享活动标签的窗口 id。
   * null = 还没有过一次成功的同步（第一次获焦只做记账，不迁移 —— 那时标签本来就在
   * 该窗口，迁移是无意义的空转）。
   */
  let hostWindowId: number | null = null

  function report(where: string, error: unknown): void {
    try { onError({ where, error }) } catch (_) {}
  }

  /** 把任务挂到串行链尾；任何异常都不允许断链。 */
  function enqueue(task: () => void | Promise<void>): Promise<void> {
    chain = chain.then(task).catch((error) => report('task', error))
    return chain
  }

  /**
   * 窗口获焦。宿主在 `browser-window-focus` 时调用（**同步返回**，实际迁移在队列里跑）。
   * @param {number} windowId
   */
  function notifyFocus(windowId: number): void {
    const id = Number(windowId)
    if (!Number.isFinite(id)) return
    // 每次获焦都推进代数：队列里任何更早的请求随即失效。
    const gen = ++generation
    enqueue(async () => {
      // 陈旧请求：中途又切过窗口 → 整条丢弃（只保留最后一次获焦的意图）。
      if (gen !== generation) return
      if (!isEnabled()) return
      if (hostWindowId == null) {
        // 首次获焦：记账，不迁移。
        hostWindowId = id
        return
      }
      if (hostWindowId === id) return
      if (!moveTab) return

      const from = hostWindowId
      const tabId = getActiveTabId(from)
      if (!tabId) {
        hostWindowId = id
        return
      }
      if (!isEligible(String(tabId))) {
        // 不可迁移（无痕 / 内部页）→ 只把记账推到新窗口，不动视图。
        hostWindowId = id
        return
      }

      // 截图**必须在迁移之前采集**：迁移后 webContents 已挂到新窗口，
      // 旧窗拿不到那一帧（会拍到新窗口或空白）。
      let url = null
      if (captureSnapshot) {
        try { url = await captureSnapshot(String(tabId)) } catch (error) { report('capture', error) }
      }
      // 采集期间可能又切了窗口 → 放弃这次迁移（代际已过期）。
      if (gen !== generation) return

      let res = null
      try {
        res = await moveTab({ tabId: String(tabId), targetWindowId: id })
      } catch (error) {
        report('move', error)
        return
      }
      if (!res || res.ok !== true) {
        // 迁移失败 → **不改记账**，下一次获焦会再试一次（避免状态与实际视图分叉）。
        report('move', new Error((res && res.error) || 'move failed'))
        return
      }
      hostWindowId = id
      if (url) {
        try { showPlaceholder(from, { url }) } catch (error) { report('placeholder', error) }
      }
      try { clearPlaceholder(id) } catch (error) { report('placeholder', error) }
    })
  }

  /**
   * 手动拖拽把标签迁到了别的窗口 → 同步"当前宿主"记账。
   *
   * 不同步的后果：用户拖一次之后 `hostWindowId` 仍指着旧窗口，下一次切窗同步会去
   * 旧窗口找活动标签 —— 拿到的其实是另一个标签，于是"同步搬错了东西"。
   * @param {string} tabId
   * @param {number} windowId
   */
  function notifyTabMoved(tabId: string, windowId: number): void {
    const id = Number(windowId)
    if (!Number.isFinite(id)) return
    // 只有"搬的正好是那份被托管的活动标签"才更新记账。
    if (tabId != null && hostWindowId != null) {
      const current = getActiveTabId(hostWindowId)
      if (current != null && String(current) !== String(tabId)) return
    }
    hostWindowId = id
    generation += 1
    try { clearPlaceholder(id) } catch (_) {}
  }

  /** 设置被关掉：清掉所有窗口的截图占位并复位记账。 */
  function notifyDisabled(): void {
    generation += 1
    hostWindowId = null
    for (const raw of listWindowIds() || []) {
      const id = Number(raw)
      if (!Number.isFinite(id)) continue
      try { clearPlaceholder(id) } catch (_) {}
    }
  }

  /** 窗口关闭：若是当前托管窗口，复位记账（下次获焦重新建立）。 */
  function forgetWindow(windowId: number): void {
    if (hostWindowId === Number(windowId)) hostWindowId = null
    generation += 1
  }

  return {
    notifyFocus,
    notifyTabMoved,
    notifyDisabled,
    forgetWindow,
    /** 当前托管窗口 id（诊断 / 测试用）。 */
    get hostWindowId() {
      return hostWindowId
    },
    /** 等待队列排空（测试用；生产不需要）。 */
    get idle() {
      return chain
    }
  }
}

export { createTabSync }
