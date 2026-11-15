/**
 * 标签记录的**唯一**构造入口 + 稳定自增 id 生成器。
 *
 * 为什么必须收口：此前「新建 / 复制 / 撤销关闭」三条路径各自手写一份 tab 对象，
 * 字段子集各不相同，直接造成两类真实缺陷：
 *   1. 复制 / 撤销关闭出来的标签缺 `spaceId` → 不属于任何空间 →
 *      面板列表里不显示，且切空间时 `destroySpaceTabs` 永远匹配不到 → webContents 泄漏；
 *   2. 缺 `lastActivated` → `sleepCandidates` 按领域契约把缺失当 0 →
 *      **下一个休眠 tick 就被秒睡** → 用户切回去要整页重载 →「网页加载极慢」。
 *
 * 稳定自增 id（`t1` / `t2` / …）替代 randomUUID：
 *   - 单调递增 → 顺序可预测，调试/日志可读（对齐 RT 的稳定 tab id）；
 *   - 免去每次建 tab 的 UUID 生成开销（新建标签是热路径）；
 *   - 会话持久化只存投影后的记录、恢复时重新分配 id，故格式变更安全。
 *
 * @param {{ prefix?: string }} [opts]
 * @returns {() => string}
 */
import type { NavigationEntry } from 'electron'
import type { PreSleepState } from './tabPreSleep'

export interface TabIdentity { profileId?: string; spaceId?: string }

export interface TabRecord {
  tabId: string
  profileId: string
  spaceId: string
  url: string
  title: string
  favicon: string
  position: number
  pinned: boolean
  muted: boolean
  audioPlaying: boolean
  incognito: boolean
  incognitoPartitionId: string | null
  stackId: string | null
  containerProfileId: string | null
  splitId: string | null
  glanceId: string | null
  sleeping: boolean
  preSleep: PreSleepState | null
  navHistory: NavigationEntry[]
  navHistoryIndex: number
  lastActivated: number
  error?: { code?: number; description?: string; url?: string } | null
  [key: string]: unknown
}

export function createTabIdGenerator(opts: { prefix?: string } = {}): () => string {
  const prefix = opts.prefix || 't'
  let seq = 0
  return function nextTabId() {
    seq += 1
    return `${prefix}${seq.toString(36)}`
  }
}

/**
 * 构造标签记录工厂。identity 由外部（APPS 层空间运行态）注入，
 * 本模块不认识 profile/space 领域，只认"当前身份是什么"。
 *
 * @param {{ nextId: () => string, getIdentity?: () => { profileId?: string, spaceId?: string } }} deps
 * @returns {(overrides?: object) => object}
 */
export function createTabRecordFactory({
  nextId,
  getIdentity
}: {
  nextId: () => string
  getIdentity?: () => TabIdentity
}): (overrides?: Partial<TabRecord>) => TabRecord {
  if (typeof nextId !== 'function') {
    throw new Error('createTabRecordFactory: nextId 必填')
  }
  return function makeTabRecord(overrides: Partial<TabRecord> = {}): TabRecord {
    const current = typeof getIdentity === 'function' ? getIdentity() : {}
    return {
      tabId: nextId(),
      profileId: String(current.profileId || 'default'),
      spaceId: String(current.spaceId || 'default'),
      url: '',
      title: '',
      favicon: '',
      // 排序位置（对齐 RT `Tab.position`）：标签顺序的**唯一真源**是记录上的数值字段，
      // 而非 `Map` 的插入顺序。读侧按 position 排序，写侧只改这一个数字，
      // 因此新建/重排/撤销都不再需要整体重建 Map（旧实现的 O(n) 重建是卡顿来源）。
      position: 0,
      pinned: false,
      muted: false,
      audioPlaying: false,
      incognito: false,
      incognitoPartitionId: null,
      stackId: null,
      // 容器标签（N10）的**身份 profile**：非空表示"这个标签的 cookie / 存储走另一个
      // profile 的 Session"，而 profileId / spaceId 仍是**归属**（标签留在当前空间）。
      // 缺字段 = 普通标签（身份即归属）。会话解析读它的唯一一处在
      // TabManager 注入的 setTabProfileResolver（见 TabManager.js）。
      containerProfileId: null,
      // 分屏组归属（与 stackId **正交**：栈是收纳、分屏是并列，见 domain-tabs#TabSplits）。
      // 只加"归属指针"，不改标签的身份语义 —— 缺这个字段的历史路径会被当成"不在任何分屏"。
      splitId: null,
      // 速览组归属（A1；第三条正交维度：叠放，见 domain-tabs#TabGroups）。
      // 同样是纯指针；缺字段 = 不在任何速览组。
      glanceId: null,
      sleeping: false,
      // 休眠前抓取的导航快照（对齐 RT PreSleepState）：{ url, navHistory, navHistoryIndex }。
      // 销毁 webContents 会丢导航历史，唤醒/持久化都依赖它，故记录里必须预留该字段。
      preSleep: null,
      // 导航历史（对齐 RT `Tab.navHistory`）：**只在建标签 / 会话恢复时写入**。
      // 不再随每次导航刷新 —— `navigationHistory.getAllEntries()` 的每一项都带 base64
      // 的 pageState，放在导航提交那一拍是纯浪费。真正需要它的两个低频路径
      //（休眠前抓快照、落盘）都改成从活的 webContents **现读**，见
      // tabPreSleep#capture 与 TabManager#listForPersist。
      // 渲染进程不读，故不参与投影。
      navHistory: [],
      navHistoryIndex: 0,
      // 创建即视为「刚激活」：休眠判定以它为基准，缺失会被当成 0（= 极其陈旧）
      lastActivated: Date.now(),
      ...overrides
    }
  }
}

