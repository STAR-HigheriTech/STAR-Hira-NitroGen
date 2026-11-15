/**
 * extensions-toolbar-controller.js —— 固定扩展条的行为编排
 *
 * 与 `download-controller.js` 同一姿势：**依赖注入 + 单一职责**。
 *   · 数据从哪来：注入的 `extensionsClient`（列表 / 启停 / 固定 / 开弹窗）；
 *   · 画在哪：注入的 `toolbar`（`{ render(entries) }`，即 ui-navbar 的哑组件）；
 *   · 点了会怎样：本文件按「有弹窗且能用 → 开弹窗；否则 → 打开扩展侧栏面板」分派；
 *   · 右键菜单的模板在 `ui-common#extensionActionMenu`（与图标条共享同一套可用性判据）。
 *
 * 为什么这些逻辑不写在 app-shell/main.js：
 *   那个文件已经是外壳装配的单子（标签 / 布局 / 书签 / 权限……）。固定扩展条是
 *   **一个完整的小功能**（取数 → 过滤 → 渲染 → 交互 → 刷新），把它塞进装配文件
 *   只会再多一段"只有读到这里才知道它存在"的代码；也挡住将来把扩展条挪到别处
 *   （侧栏扩展槽 / 独立窗口）的可能 —— 换宿主只需换一个 `toolbar` 实现。
 *
 * 刷新策略：
 *   · `onChanged`（安装 / 卸载 / 启停 / 固定）→ 合并一次列表拉取；
 *   · 自身动作完成后主动补一次（不等广播，避免个别事件丢包后 UI 停在旧态）；
 *   · **空闲零 IPC**：没有事件就永远不轮询（固定态是用户意图，不是随时间变化的量）。
 */

import { EXTENSION_ACTION, createExtensionActionMenu, extensionAvailability, type ExtensionLike, type PopMenu } from '@hira-ng/ui-common'
import type { ExtensionActionEntry } from '@hira-ng/ui-navbar'

/**
 * @typedef {Object} ExtensionsToolbarDeps
 * @property {object} extensionsClient 扩展域客户端（list / toggle / setPinned / openPopup / openOptions / onChanged）
 * @property {{ render: (entries: Array<object>) => void }} toolbar 哑组件渲染口（ui-navbar#renderExtensionActions）
 * @property {(payload: { items: Array<object>, x: number, y: number }) => Promise<string|null>} popMenu 原生菜单
 * @property {() => void} openPanel 打开扩展侧栏面板（就地查看，不离开当前页面）
 * @property {(featureId: string) => boolean} [isFeatureAvailable] 引擎可用性（§10.4）
 * @property {(error: unknown) => void} [onError] 失败上报（缺省写 console）
 */
/** 广播合并窗口：安装 / 启停常常连发几条事件，一次刷新就够。 */
const CHANGE_COALESCE_MS = 60

interface ExtensionToolbarItem {
  id: string
  name?: string
  iconDataUrl?: string
  iconUrl?: string
  iconPath?: string
  pinned?: boolean
  enabled?: boolean
  hasPopup?: boolean
  hasOptionsPage?: boolean
  actionTitle?: string
  badgeText?: string
  badgeColor?: string
  [key: string]: unknown
}

interface ExtensionToolbarPosition {
  anchorRect?: unknown
  x?: number
  y?: number
}

type ExtensionToolbarEntry = ExtensionActionEntry

interface ExtensionsToolbarClient {
  list(): Promise<unknown>
  onChanged?(listener: () => void): () => void
  toggle(id: string, enabled: boolean): Promise<unknown>
  setPinned(id: string, pinned: boolean): Promise<unknown>
  openPopup(id: string, options?: { anchorRect: unknown }): Promise<unknown>
  openOptions(id: string): Promise<unknown>
}

export interface ExtensionsToolbarDeps {
  extensionsClient: ExtensionsToolbarClient
  toolbar: { render(entries: ExtensionToolbarEntry[]): void }
  popMenu: PopMenu
  openPanel(): void
  isFeatureAvailable?(featureId: string): boolean
  onError?(error: unknown): void
}

interface ExtensionsToolbarController {
  start(): void
  refresh(): Promise<void>
  syncEngineAvailability(): void
  activate(entry: ExtensionToolbarEntry, pos?: { anchorRect?: unknown; x?: number; y?: number }): Promise<void>
  openContextMenu(entry: ExtensionToolbarEntry, pos?: { anchorRect?: unknown; x?: number; y?: number }): void
  dispose(): void
}

/**
 * @param {ExtensionsToolbarDeps} deps
 * @returns {{
 *   start: () => void,
 *   refresh: () => Promise<void>,
 *   syncEngineAvailability: () => void,
 *   activate: (entry: object, pos?: { anchorRect?: object, x?: number, y?: number }) => Promise<void>,
 *   openContextMenu: (entry: object, pos?: { anchorRect?: object, x?: number, y?: number }) => void,
 *   dispose: () => void
 * }}
 */
export function createExtensionsToolbarController({
  extensionsClient,
  toolbar,
  popMenu,
  openPanel,
  isFeatureAvailable,
  onError
}: ExtensionsToolbarDeps): ExtensionsToolbarController {
  const featureAvailable = typeof isFeatureAvailable === 'function' ? isFeatureAvailable : () => true
  const report = typeof onError === 'function'
    ? onError
    : (error: unknown) => console.error('[extensions-toolbar]', error)

  /** 当前列表的原始项（菜单要 `hasPopup` / `hasOptionsPage` / `enabled` 这些上下文，
   *  图标条的 entry 是它的**投影**，只带画按钮需要的字段）。 */
  const itemsById = new Map<string, ExtensionToolbarItem>()

  let started = false
  let disposed = false
  let engineAvailable = featureAvailable('extensions')
  /** 进行中的列表请求（并发合并：事件连发时只飞一个）。 */
  let inflight: Promise<void> | null = null
  /** 请求飞行中又来了刷新请求 → 落地后再补一次。 */
  let queued = false
  /** 广播合并定时器。 */
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null
  /** `onChanged` 退订函数。 */
  let unsubscribeChanged: (() => void) | null = null
  /** 最近一次右键的锚点（菜单里选「打开弹出窗口」时沿用，弹窗才会贴着图标而不是窗口角）。 */
  let lastAnchorRect: unknown = null

  /** 列表项 → 图标条 entry（只投影，不改语义）。 */
  function toEntry(item: ExtensionToolbarItem): ExtensionToolbarEntry {
    const availability = extensionAvailability(item)
    return {
      id: item.id,
      name: item.actionTitle || item.name || item.id,
      icon: item.iconDataUrl || item.iconUrl || item.iconPath || '',
      state: availability.enabled ? 'active' : 'inactive',
      detail: String(availability.detail || ''),
      badgeText: item.badgeText || '',
      badgeColor: item.badgeColor || ''
    }
  }

  function apply(items: unknown): void {
    if (disposed) return
    itemsById.clear()
    const entries: ExtensionToolbarEntry[] = []
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object' || typeof (item as ExtensionToolbarItem).id !== 'string') continue
      const extension = item as ExtensionToolbarItem
      const normalized = {
        ...extension,
        name: extension.actionTitle || extension.name
      }
      itemsById.set(extension.id, normalized)
      // 停用 / 加载失败的扩展**同样展示**（灰化）：固定是用户意图，不该随启停漂移；
      // 灰着的图标本身就是"它坏了/关了"的提示，右键还能启用或撤下它。
      if (normalized.pinned !== true) continue
      entries.push(toEntry(normalized))
    }
    toolbar.render(entries)
  }

  /**
   * 拉列表并落地。**并发合并**：飞行中再被调用只记一个"再来一次"，
   * 不为每次广播各飞一趟 IPC。
   */
  async function refresh() {
    if (disposed) return
    if (!engineAvailable) return
    if (inflight) {
      queued = true
      return inflight
    }
    inflight = (async () => {
      try {
        const items = await extensionsClient.list()
        apply(items)
      } catch (error) {
        report(error)
      } finally {
        inflight = null
      }
    })()
    await inflight
    if (queued && !disposed) {
      queued = false
      await refresh()
    }
  }

  /** 广播 → 合并一次刷新（同步连发的事件只拉一次列表）。 */
  function scheduleRefresh() {
    if (disposed || !engineAvailable) return
    if (coalesceTimer !== null) return
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null
      refresh()
    }, CHANGE_COALESCE_MS)
  }

  function cancelScheduled() {
    if (coalesceTimer === null) return
    clearTimeout(coalesceTimer)
    coalesceTimer = null
  }

  /**
   * 左键分派（Chrome 口径）：**有弹窗就开弹窗**。
   * 没有弹窗、或它现在打不开（停用 / 加载失败）→ 打开扩展侧栏面板，
   * 让用户就地看到状态与开关，而不是"点了没反应"。
   */
  async function activate(entry: ExtensionToolbarEntry, pos: ExtensionToolbarPosition = {}) {
    const item = itemsById.get(entry && entry.id)
    if (!item) return
    const availability = extensionAvailability(item)

    if (availability.enabled && item.hasPopup) {
      try {
        await extensionsClient.openPopup(item.id, pos && pos.anchorRect
          ? { anchorRect: pos.anchorRect }
          : undefined)
      } catch (error) {
        report(error)
      }
      return
    }
    openPanel()
  }

  /** 菜单动作 → 客户端调用；完成后补一次刷新（不等广播）。 */
  async function runAction(action: string, entry: ExtensionLike | undefined) {
    const item = entry?.id ? itemsById.get(entry.id) : undefined
    if (!item) return
    try {
      switch (action) {
        case EXTENSION_ACTION.OPEN_POPUP:
          await extensionsClient.openPopup(
            item.id,
            lastAnchorRect ? { anchorRect: lastAnchorRect } : undefined
          )
          return
        case EXTENSION_ACTION.OPEN_OPTIONS:
          await extensionsClient.openOptions(item.id)
          break
        case EXTENSION_ACTION.TOGGLE:
          await extensionsClient.toggle(item.id, item.enabled === false)
          break
        case EXTENSION_ACTION.OPEN_PANEL:
          openPanel()
          return
        case EXTENSION_ACTION.UNPIN:
          await extensionsClient.setPinned(item.id, false)
          break
        default:
          return
      }
    } catch (error) {
      report(error)
      return
    }
    await refresh()
  }

  const openMenu = createExtensionActionMenu({ popMenu, onAction: runAction })

  function openContextMenu(entry: ExtensionToolbarEntry, pos: ExtensionToolbarPosition = {}) {
    const item = itemsById.get(entry && entry.id)
    if (!item) return
    lastAnchorRect = (pos && pos.anchorRect) || null
    // 菜单是异步弹的（原生菜单存续期间一直不 resolve）：失败必须**打得出来**，
    // 否则「右键没反应」会被这层 await 链条彻底吞掉、无从排查。
    Promise.resolve(openMenu({
      extension: item,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0
    })).catch(report)
  }

  /**
   * 引擎可用性收敛点（由编排层在 `onFeaturesChanged` 里调用）。幂等。
   * 引擎被禁用 → 撤掉订阅并清空图标条（留着也点不开）；
   * 恢复 → 重新订阅并立刻补一次列表。
   */
  function syncEngineAvailability() {
    if (disposed) return
    const next = featureAvailable('extensions')
    if (next === engineAvailable) return
    engineAvailable = next
    if (!next) {
      cancelScheduled()
      if (unsubscribeChanged) {
        try { unsubscribeChanged() } catch (_) {}
        unsubscribeChanged = null
      }
      itemsById.clear()
      toolbar.render([])
      return
    }
    if (started) {
      subscribeChanged()
      refresh()
    }
  }

  function subscribeChanged() {
    if (unsubscribeChanged || disposed || !engineAvailable) return
    if (typeof extensionsClient.onChanged !== 'function') return
    try {
      const off = extensionsClient.onChanged(scheduleRefresh)
      unsubscribeChanged = typeof off === 'function' ? off : () => {}
    } catch (error) {
      report(error)
    }
  }

  /** 首帧：只在引擎可用时拉列表；订阅与之一并挂上。 */
  function start() {
    if (started || disposed) return
    started = true
    if (!engineAvailable) {
      toolbar.render([])
      return
    }
    subscribeChanged()
    refresh()
  }

  return {
    start,
    refresh,
    syncEngineAvailability,
    activate,
    openContextMenu,
    dispose() {
      if (disposed) return
      disposed = true
      cancelScheduled()
      if (unsubscribeChanged) {
        try { unsubscribeChanged() } catch (_) {}
        unsubscribeChanged = null
      }
      itemsById.clear()
      // 只清内容、不摘 DOM：组件归 ui-navbar 所有，退出由外壳整体收尾。
      try { toolbar.render([]) } catch (_) {}
    }
  }
}


