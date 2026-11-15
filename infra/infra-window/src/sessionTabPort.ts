/**
 * 会话服务的 **tabPort 适配器**（domain-session 的窄接口 ↔ TabManager 大对象）。
 *
 * 为什么必须显式收口：
 *   main.js 曾用 `{ ...tabManager, list: () => tabManager.listAll() }` 临时拼端口。
 *   但对象展开**只复制自有数据属性**，原型上的方法（getActiveTabId / newTab /
 *   listStacks / createStack…）一个都拿不到——只是"恰好"只用到 list 才没炸。
 *   阶段D 给契约新增 `listForPersist` 时，这种隐式依赖会**静默失效**：
 *   端口看着有、实际 undefined，导航历史悄悄写不进盘，且无任何报错。
 *   这里把契约字段逐条列出，缺一个就是显式 undefined，漂移立刻暴露。
 *
 * 分层：本模块只做「方法转发 + 参数收窄」，不 import electron/fs，可脱离运行时单测。
 *
 * @param {object} tabManager 运行期 TabManager 实例（鸭子类型）
 * @param {{ allTabs?: boolean, space?: {profileId:string, spaceId:string}|null }} [opts]
 *   allTabs=true → `list()/listForPersist()` 取**全部空间**标签（profile 级会话文件）；
 *   space 非空    → 端口**钉死**在这一格空间上（与当前环境是哪个空间无关）；
 *   默认两者都不给 → 只取当前空间（space 级会话文件，与 markDirty 的目录语义一致）。
 * @returns {{
 *   list: () => any[],
 *   listForPersist: () => any[],
 *   getActiveTabId: () => (string|null),
 *   listStacks: () => any[],
 *   newTab: (opts?: object) => any,
 *   switchTo: (tabId: string) => any,
 *   createStack: (opts?: object) => any
 * }}
 */
interface SessionSpace { profileId?: string; spaceId?: string }
interface SessionTabPortOptions {
  allTabs?: boolean
  space?: SessionSpace | null
  /** allTabs 时只取该 profile 的标签（profile 级会话落盘用）。 */
  profileId?: string
  /** 切换前已捕获的活动标签；避免延迟落盘时读到目标空间的 active id。 */
  activeTabId?: string | null
}

interface TabManagerPort {
  list(): unknown[]
  listAll?(): unknown[]
  listBySpace?(profileId: string, spaceId: string): unknown[]
  listForPersist?(options: { allTabs: boolean; space: SessionSpace | null; profileId?: string }): unknown[]
  getActiveTabId?(): string | null
  getActiveTabIdForSpace?(profileId: string, spaceId: string): string | null
  listStacks?(): unknown[]
  listSplits?(): unknown[]
  listGlances?(): unknown[]
  newTab(options?: unknown): unknown
  switchTo?(tabId: string): unknown
  createStack?(options?: unknown): unknown
  adoptLoosePinnedTabs?(): unknown
  createSplitGroup?(options?: unknown): unknown
  createGlanceGroup?(options?: unknown): unknown
}

export interface SessionTabPort {
  list(): unknown[]
  listForPersist(): unknown[]
  getActiveTabId(): string | null
  listStacks(): unknown[]
  listSplits(): unknown[]
  listGlances(): unknown[]
  newTab(options?: unknown): unknown
  switchTo(tabId: string): unknown
  createStack(options?: unknown): unknown
  adoptPinnedTabs(): unknown
  createSplit(options?: unknown): unknown
  createGlance(options?: unknown): unknown
}

export function createSessionTabPort(
  tabManager: TabManagerPort,
  { allTabs = false, space = null, profileId = '', activeTabId = null }: SessionTabPortOptions = {}
): SessionTabPort {
  if (!tabManager || typeof tabManager.list !== 'function') {
    throw new Error('createSessionTabPort: tabManager.list 必填')
  }
  /**
   * 钉死的空间（null = 跟随环境的当前空间）。
   *
   * 为什么必须显式钉：端口是**异步消费**的 —— 切 space 前的保存会延后一拍，
   * markDirty 还有 2s 合批。若端口读「环境当前空间」，切完之后再读就是**目标空间**
   * 的标签，会被写进旧空间的文件（跨空间串档：重启后旧空间里冒出别人的标签）。
   */
  const pinned = !allTabs && space && space.spaceId
    ? { profileId: String(space.profileId || 'default'), spaceId: String(space.spaceId || 'default') }
    : null
  const pinnedProfileId = allTabs && profileId ? String(profileId) : ''
  const listBySpace = tabManager.listBySpace
  const list = allTabs
    ? () => {
        const all = typeof tabManager.listAll === 'function' ? tabManager.listAll() : tabManager.list()
        if (!pinnedProfileId || !Array.isArray(all)) return all
        return all.filter((tab) => String((tab as { profileId?: unknown } | null)?.profileId || '') === pinnedProfileId)
      }
    : (pinned && typeof listBySpace === 'function'
      ? () => listBySpace.call(tabManager, pinned.profileId, pinned.spaceId)
      : () => tabManager.list())

  return {
    list,
    // 带导航历史的落盘投影；宿主未实现该可选方法时退回 list()（兼容旧宿主）。
    listForPersist: () => (typeof tabManager.listForPersist === 'function'
      ? tabManager.listForPersist({ allTabs, space: pinned, ...(pinnedProfileId ? { profileId: pinnedProfileId } : {}) })
      : list()),
    getActiveTabId: () => {
      if (activeTabId) return String(activeTabId)
      // 钉死空间时活动标签也必须取自那一格 —— 见 TabManager#getActiveTabIdForSpace。
      if (pinned && typeof tabManager.getActiveTabIdForSpace === 'function') {
        return tabManager.getActiveTabIdForSpace(pinned.profileId, pinned.spaceId)
      }
      return typeof tabManager.getActiveTabId === 'function' ? tabManager.getActiveTabId() : null
    },
    listStacks: () => (typeof tabManager.listStacks === 'function' ? tabManager.listStacks() : []),
    // 分屏组（与栈**正交**）：落盘与恢复各要一条 —— 见 SessionStore#toRecord / 恢复段。
    listSplits: () => (typeof tabManager.listSplits === 'function' ? tabManager.listSplits() : []),
    newTab: (options?: unknown) => tabManager.newTab(options),
    switchTo: (tabId: string) => (typeof tabManager.switchTo === 'function' ? tabManager.switchTo(tabId) : undefined),
    createStack: (options?: unknown) => (typeof tabManager.createStack === 'function' ? tabManager.createStack(options) : undefined),
    // 固定分组收编（旧会话里 pinned 但无分组的标签 → 并入默认固定组）。
    // 恢复流程末尾调用一次；宿主未实现时是纯 no-op。
    adoptPinnedTabs: () => (typeof tabManager.adoptLoosePinnedTabs === 'function' ? tabManager.adoptLoosePinnedTabs() : undefined),
    createSplit: (options?: unknown) => (typeof tabManager.createSplitGroup === 'function' ? tabManager.createSplitGroup(options) : undefined),
    // 速览组（A1；与栈/分屏三者正交）：落盘与恢复各要一条，见 SessionStore#toRecord / 恢复段。
    listGlances: () => (typeof tabManager.listGlances === 'function' ? tabManager.listGlances() : []),
    createGlance: (options?: unknown) => (typeof tabManager.createGlanceGroup === 'function' ? tabManager.createGlanceGroup(options) : undefined)
  }
}

