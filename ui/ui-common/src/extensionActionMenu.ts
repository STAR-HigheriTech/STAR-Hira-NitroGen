/**
 * 固定扩展图标的右键菜单 —— **唯一实现**。
 *
 * 与 `navHistoryMenu.ts` / `bookmarkContextMenu.ts` 同一姿势：
 *   · 本模块只认识两件事：`popMenu({x,y,items})` 与 `onAction(action, extension)`；
 *   · 不认识 IPC / 扩展客户端 / 管理页地址 —— 宿主（编排层）注入并决定动作怎么落地；
 *   · 菜单项的**可用性判据**与图标条共享同一个 `extensionAvailability`，
 *     不会出现「图标灰着、菜单里却能点开弹窗」这种两处各判一次的漂移。
 *
 * 为什么标题行 + 状态行都是禁用项：原生菜单没有分组标题，用 disabled 项当小标题
 * 是既有惯例（见 navHistoryMenu 的分组写法）；而「已停用 / 加载失败」必须写在
 * 菜单最上面 —— 用户右键一颗灰图标，第一件想知道的就是它为什么灰。
 */

import { extensionStatusLabel } from '@hira-ng/shared-types/src/extension-labels.mjs'
import type { MenuItem, PopMenu } from './menuTypes'

export type ExtensionMenuItem = MenuItem

export interface ExtensionLike {
  id?: string
  name?: string
  version?: string
  enabled?: boolean
  loadError?: unknown
  runtimeStatus?: string
  hasPopup?: boolean
  hasOptionsPage?: boolean
  [key: string]: unknown
}

export interface ExtensionAvailability {
  enabled: boolean
  disabled: boolean
  failed: boolean
  detail: string
  label: string
}

export interface ExtensionActionMenuOptions {
  popMenu?: PopMenu
  onAction?: (action: string, extension: ExtensionLike) => void
}

/** 菜单项 action（渲染层自洽的字符串，语义落地在编排层）。 */
export const EXTENSION_ACTION = Object.freeze({
  OPEN_POPUP: 'extension:open-popup',
  OPEN_OPTIONS: 'extension:open-options',
  TOGGLE: 'extension:toggle',
  /** 打开扩展侧栏面板（`extensions-panel`）—— 与「管理页」不是一回事：不离开当前页面。 */
  OPEN_PANEL: 'extension:open-panel',
  UNPIN: 'extension:unpin'
})

/**
 * 扩展的交互可用性 —— **图标条与右键菜单共用的唯一判据**。
 *
 * 三态（停用 / 加载失败 / 正常）不是三种散落的分支，而是一次算清：
 *   · `disabled`：用户主动停用 → 不能开弹窗 / 选项页，但可以启用、取消固定；
 *   · `failed`  ：启用了却加载出错 → 同上（先修好它，再谈用）；
 *   · `enabled` ：真正能打开界面的那一态。
 *
 * @param {ExtensionLike|null|undefined} extension 列表项（`enabled` / `loadError` / `runtimeStatus`）
 * @returns {{ enabled: boolean, disabled: boolean, failed: boolean, detail: string, label: string }}
 */
export function extensionAvailability(extension?: ExtensionLike | null): ExtensionAvailability {
  const disabled = extension?.enabled === false
  const failed = !disabled && Boolean(extension && (extension.loadError || extension.runtimeStatus === 'error'))
  if (disabled) return { enabled: false, disabled, failed, detail: extensionStatusLabel('disabled'), label: '启用扩展' }
  if (failed) return { enabled: false, disabled, failed, detail: extensionStatusLabel('error'), label: '停用扩展' }
  return { enabled: true, disabled, failed, detail: '', label: '停用扩展' }
}

/** 版本号只在真有的时候才拼进标题行（占位版本会让标题看起来像坏了）。 */
function headline(extension?: ExtensionLike | null): string {
  const name = String((extension && extension.name) || (extension && extension.id) || '').trim() || '扩展'
  const version = String((extension && extension.version) || '').trim()
  return version ? `${name}  ${version}` : name
}

/**
 * 扩展 → 菜单项（**纯函数**，便于单测；与菜单通道无关）。
 * @param {ExtensionLike|null|undefined} extension
 * @returns {ExtensionMenuItem[]}
 */
export function buildExtensionMenuItems(extension?: ExtensionLike | null): ExtensionMenuItem[] {
  const availability = extensionAvailability(extension)
  const items: ExtensionMenuItem[] = [{ label: headline(extension), enabled: false }]
  if (availability.detail) items.push({ label: `（${availability.detail}）`, enabled: false })

  items.push({ type: 'separator' as const, action: null })

  // 开界面：只有「真的能打开」才给可用项；没有 popup / options 的扩展对应项直接不给
  //（而不是给一个灰项）—— 灰着的「打开弹窗」会让人以为是加载慢。
  let hasOpenable = false
  if (extension && extension.hasPopup) {
    items.push({
      label: '打开弹出窗口',
      enabled: availability.enabled,
      action: EXTENSION_ACTION.OPEN_POPUP
    })
    hasOpenable = true
  }
  if (extension && extension.hasOptionsPage) {
    items.push({
      label: '扩展选项',
      enabled: availability.enabled,
      action: EXTENSION_ACTION.OPEN_OPTIONS
    })
    hasOpenable = true
  }
  // 只有真加了「打开」组才补分隔线：两个分隔项贴在一起会画成一条粗线。
  if (hasOpenable) items.push({ type: 'separator' as const, action: null })

  // 启停：文案随当前态反转（点它会发生什么，而不是它现在是什么）。
  items.push({ label: availability.label, action: EXTENSION_ACTION.TOGGLE })
  // 打开面板 = 就地查看，不顶掉当前页面；因此不再给「管理扩展」这种跳页入口。
  items.push({ label: '打开扩展面板', action: EXTENSION_ACTION.OPEN_PANEL })

  items.push({ type: 'separator' as const, action: null })
  items.push({ label: '取消固定', action: EXTENSION_ACTION.UNPIN })

  return items
}

/**
 * 造一个「在 (x, y) 处弹扩展菜单」的函数。
 *
 * @param {{
 *   popMenu?: (payload: { x: number, y: number, items: Array<object>, context?: object }) => Promise<string|null>,
 *   onAction?: (action: string, extension: ExtensionLike) => void
 * }} [deps]
 * @returns {(arg: { extension?: ExtensionLike|null, x: number, y: number }) => Promise<void>}
 */
export function createExtensionActionMenu({
  popMenu,
  onAction
}: ExtensionActionMenuOptions = {}) : (arg: { extension?: ExtensionLike | null, x: number, y: number }) => Promise<void> {
  return async function openExtensionActionMenu({
    extension,
    x,
    y
  }: {
    extension?: ExtensionLike | null
    x: number
    y: number
  }): Promise<void> {
    if (typeof popMenu !== 'function' || !extension) return

    // 不传 `context`：扩展菜单目前没有官方插槽（主进程白名单里没有 kind=extension），
    // 传一个未登记的 kind 只会白走一遍插槽查找。
    //
    // ⚠ **不在这里 catch**：弹菜单失败（契约校验 / 原生构建 / 坐标非法）必须冒泡给
    //   宿主 —— 本模块没有"上报"这个职责，就地吞掉只会让「右键毫无反应」永远查不出
    //   原因（历史上就是这样丢过一条真 bug）。宿主的 catch 负责记日志。
    const action = await popMenu({ x, y, items: buildExtensionMenuItems(extension) })

    if (!action || typeof onAction !== 'function') return
    onAction(action, extension)
  }
}
