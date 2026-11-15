/**
 * 可编辑按钮的**账本** —— 「有哪些按钮、属于哪一段、当前顺序、谁被隐藏」的唯一真相源。
 *
 * 只做三件事：登记（`add` / `declare` / `prune`）、施加顺序与显隐（`setOrder` / `applyOrder`）、
 * 以及把状态**窄接口**地读出去（给几何模块量投放区用）。
 *
 * 它**不量任何几何**（那是 `zones.ts` 的事），也**不认识任何具体按钮** ——
 * 导航按钮、书签星、面板按钮一律由外部 `add(id, el)` 注入；容器由外部 `hosts` 注入。
 *
 * 「段」的概念：一次编辑只能在**同一段内**生效 —— 三段的容器不同，
 * 跨段移动没有物理意义，编辑浮层里也按段投放。
 *
 * ⚠ 为什么不把 `items` / `hosts` 直接暴露成 Map/对象：几何模块只需要「按 id 拿节点」
 *   「按段名拿容器」两件查询。给出这两件查询函数，几何模块就不必知道账本内部
 *   是用 Map 还是对象存的 —— 换存储不牵动它。
 */

import type { ToolbarCatalogEntry } from '../types'

/**
 * @param {{
 *   catalog: Array<{ id: string, segment?: string }>,
 *   hosts: Record<string, HTMLElement>,
 *   anchors?: Record<string, HTMLElement>
 * }} options
 *   hosts   —— 段名 → 该段的物理容器（重排只在自己的容器内发生）
 *   anchors —— 段名 → 段内**固定在最前**的非编辑成员（nav: rail 开关）
 * @returns {{
 *   add: (id: string, el: HTMLElement) => HTMLElement,
 *   declare: (id: string, segment?: string) => void,
 *   declareSegment: (segment: string) => void,
 *   prune: (host: HTMLElement, liveIds: Set<string>) => void,
 *   pruneGroup: (segment: string, liveIds: Set<string>) => void,
 *   setOrder: (ids: string[]) => void,
 *   setSegments: (segments: Record<string,string>|null) => void,
 *   applyOrder: () => void,
 *   order: () => string[],
 *   segments: () => string[],
 *   segmentOf: (id: string) => string,
 *   itemOf: (id: string) => HTMLElement|undefined,
 *   hostOf: (segName: string) => HTMLElement|undefined
 * }}
 */
export function createToolbarLedger(options: {
  catalog: ToolbarCatalogEntry[]
  hosts: Record<string, HTMLElement>
  anchors?: Record<string, HTMLElement>
}) : {
  add: (id: string, el: HTMLElement) => HTMLElement,
  declare: (id: string, segment?: string) => void,
  declareSegment: (segment: string) => void,
  prune: (host: HTMLElement, liveIds: Set<string>) => void,
  pruneGroup: (segment: string, liveIds: Set<string>) => void,
  setOrder: (ids: string[]) => void,
  setSegments: (segments: Record<string,string>|null) => void,
  applyOrder: () => void,
  order: () => string[],
  segments: () => string[],
  segmentOf: (id: string) => string,
  itemOf: (id: string) => HTMLElement|undefined,
  hostOf: (segName: string) => HTMLElement|undefined
} {
  const { catalog, hosts, anchors = {} } = options
  /** 目录 id → DOM。 */
  const items = new Map<string, HTMLElement>()
  /** 目录 id → 段名。 */
  const segmentOf: Record<string, string> = {}
  /** 段名的规范顺序（决定施加与报几何时的遍历次序）。 */
  const segOrder: string[] = []
  for (const p of catalog || []) {
    if (!p || !p.id) continue
    segmentOf[p.id] = p.segment || 'panel'
    if (!segOrder.includes(segmentOf[p.id])) segOrder.push(segmentOf[p.id])
  }
  /** 当前可见顺序（默认 = 目录顺序）；编辑结果由编排层经 setOrder 灌入。 */
  let order = Object.keys(segmentOf)

  /**
   * 登记一个可编辑按钮：加标记类（编辑模式靠它隐身）+ 记录 id。
   * @param {string} id
   * @param {HTMLElement} el
   */
  function add<T extends HTMLElement>(id: string, el: T): T {
    if (!el) return el
    const previous = items.get(id)
    if (previous && previous !== el) previous.remove()
    el.classList.add('hira-toolbar-item')
    items.set(id, el)
    return el
  }

  /**
   * 声明某按钮属于哪一段。
   * 新面板插件可能带来**新的段**，段集合因此是运行时生长的（不是一张写死的表）。
   */
  function declare(id: string, segment?: string): void {
    const seg = segment || 'panel'
    segmentOf[id] = seg
    if (!segOrder.includes(seg)) segOrder.push(seg)
  }

  function declareSegment(segment: string): void {
    const seg = String(segment || '')
    if (seg && !segOrder.includes(seg)) segOrder.push(seg)
  }

  /** 按容器清理已下线的按钮（插件被禁用时，它的按钮不能留下幽灵）。 */
  function prune(host: HTMLElement, liveIds: Set<string>): void {
    for (const [id, el] of Array.from(items.entries())) {
      if (el.parentNode !== host) continue
      if (!liveIds.has(id)) {
        el.remove()
        items.delete(id)
      }
    }
  }

  function pruneGroup(segment: string, liveIds: Set<string>): void {
    for (const [id, el] of Array.from(items.entries())) {
      if (segmentOf[id] !== segment || liveIds.has(id)) continue
      el.remove()
      items.delete(id)
    }
  }

  /**
   * 把某段的可编辑按钮按给定顺序重排。
   * 只重排可编辑成员，段内**非编辑**成员保持原位（见 anchors）。
   */
  function reorderSegment(segName: string, ids: string[]): void {
    const host = hosts[segName]
    if (!host) return
    const list: HTMLElement[] = []
    const anchor = anchors[segName]
    if (anchor && anchor.parentNode === host) list.push(anchor)
    for (const id of ids) {
      const el = items.get(id)
      if (!el) continue
      // 段归属是编辑结果的真源：用户可把固定控件或面板按钮移到另一个物理容器，
      // 这里必须按最新 segment 归位；再按 parentNode 过滤会吞掉跨段拖动。
      list.push(el)
    }
    // appendChild 对已存在的子节点 = 移到末尾，因此按目标顺序依次追加即完成重排
    for (const el of list) host.appendChild(el)
  }

  /** 按当前顺序施加：不在顺序表里的一律隐藏（display:none，不留空位）。 */
  function applyOrder(): void {
    const keep = new Set(order)
    for (const [id, el] of items) {
      el.classList.toggle('hira-toolbar-hidden', !keep.has(id))
    }
    for (const segName of segOrder) {
      reorderSegment(segName, order.filter((id) => segmentOf[id] === segName))
    }
  }

  /**
   * 施加用户给单个按钮选择的段。段仍必须是本块已有的物理容器；
   * 未知 id / 未知容器直接忽略，避免坏设置把按钮搬到不存在的位置。
   */
  function setSegments(overrides: Record<string, string> | null): void {
    const src = overrides && typeof overrides === 'object' ? overrides : {}
    let changed = false
    for (const [id, segment] of Object.entries(src)) {
      if (!items.has(id) || !hosts[segment]) continue
      if (!segOrder.includes(segment)) segOrder.push(segment)
      if (segmentOf[id] !== segment) {
        segmentOf[id] = segment
        changed = true
      }
    }
    if (changed) applyOrder()
  }

  return {
    add,
    declare,
    declareSegment,
    prune,
    pruneGroup,
    setOrder(visibleIds: string[]): void {
      order = (Array.isArray(visibleIds) ? visibleIds : []).filter((id) => items.has(id))
      applyOrder()
    },
    setSegments,
    applyOrder,
    order: () => order.slice(),
    segments: () => segOrder.slice(),
    segmentOf: (id: string) => segmentOf[id],
    itemOf: (id: string) => items.get(id),
    hostOf: (segName: string) => hosts[segName]
  }
}
