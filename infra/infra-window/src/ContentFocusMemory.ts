/**
 * 内容面键盘焦点的**记忆体**（纯模块，零 electron 依赖 —— 与 LayerStack / BoundsTween 同款）。
 *
 * ── 它解决的问题 ──────────────────────────────────────────────────────────
 * 浏览器窗口里，键盘焦点**同一时刻只属于一个视图**：外壳（窗口本体 webContents）或
 * 某个内容面（标签 / 独立侧栏 / 面板）。窗口失活再激活、或用户点了外壳的非输入区，
 * 焦点就可能**落在无人持焦的空档**（Chromium 不会替我们把焦点送回刚才那张网页）。
 * 要送回去，就得知道「刚才用户是在哪个视图里打字的」—— 那就是这里的全部职责。
 *
 * 为什么不在 LayoutCoordinator 里直接存一个字段：记住的必须是**一串**（用户可能在
 * 标签 ↔ 侧栏 ↔ 面板之间来回），且最新的一个失效了要能回落到次新的（面板关闭即销毁）。
 * 这层簿记是纯数据规则，独立出来才能单独推敲、也才能被未来的新内容面复用。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────────
 * · `remember(wc, kind, key)`：某个内容面拿到焦点时登记（重复登记=提到最新）。
 * · `forget(wc)`：视图销毁时摘掉（不摘也不致命 —— `resolve` 会跳过已销毁的）。
 * · `resolve(isAvailable?)`：取**最近一个仍可用**的条目；`isAvailable` 由调用方注入
 *   （「这一面现在还在屏幕上吗、还是不是打开的面板」是布局知识，不属于纯记忆体）。
 * · 条目形如 `{ wc, kind, key }`：`kind` 供可用性守卫分派，`key` 给守卫具体身份
 *   （面板 id / 侧栏名），新增内容面只需约定新的 kind，不动本文件。
 *
 * 容量上限只为「永不无限增长」：真实用户不会在同一窗口里轮换十几张内容面，
 * 超出时丢**最旧**的一条（最近的那几条才是要回焦的对象）。
 */

/** 默认记住多少个内容面。8 = 标签 + 侧栏 + 两个面板 + 若干余量。 */
const DEFAULT_CAPACITY = 8

export interface FocusableContents {
  isDestroyed?(): boolean
}

export interface ContentFocusEntry<Wc extends FocusableContents = FocusableContents> {
  wc: Wc
  kind: string
  key: string | null
}

interface ContentFocusMemoryOptions { capacity?: number }

export class ContentFocusMemory<Wc extends FocusableContents = FocusableContents> {
  private readonly _capacity: number
  private readonly _entries: ContentFocusEntry<Wc>[] = []

  constructor(options: ContentFocusMemoryOptions = {}) {
    const cap = Number(options.capacity)
    this._capacity = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAPACITY
  }

  /**
   * 登记一个内容面为「最近持焦者」。
   *
   */
  remember(wc: Wc | null | undefined, kind: string, key: string | null = null): void {
    if (!wc) return
    const k = String(kind || '').trim()
    if (!k) return
    const entry = { wc, kind: k, key: key == null ? null : String(key) }
    this.forget(wc)
    this._entries.unshift(entry)
    if (this._entries.length > this._capacity) {
      this._entries.length = this._capacity
    }
  }

  /** 摘掉某个 webContents 的登记（视图销毁时调用） */
  forget(wc: Wc | null | undefined): void {
    if (!wc) return
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      if (this._entries[i].wc === wc) this._entries.splice(i, 1)
    }
  }

  /**
   * 取最近一个**仍可用**的条目。
   *
   */
  resolve(isAvailable?: (entry: ContentFocusEntry<Wc>) => boolean): ContentFocusEntry<Wc> | null {
    for (let i = 0; i < this._entries.length; i += 1) {
      const entry = this._entries[i]
      if (!entry || !entry.wc) continue
      if (typeof entry.wc.isDestroyed === 'function' && entry.wc.isDestroyed()) {
        // 懒剪枝：销毁的条目顺手清掉，别留给下一次遍历。
        this._entries.splice(i, 1)
        i -= 1
        continue
      }
      if (typeof isAvailable === 'function' && !isAvailable(entry)) continue
      return entry
    }
    return null
  }

  /** 只读快照（调试 / 未来给「焦点历史」类 UI 用；外部不得改）。 */
  list(): ContentFocusEntry<Wc>[] {
    return this._entries.map((e) => ({ wc: e.wc, kind: e.kind, key: e.key }))
  }

  clear(): void {
    this._entries.length = 0
  }
}

export { DEFAULT_CAPACITY }
