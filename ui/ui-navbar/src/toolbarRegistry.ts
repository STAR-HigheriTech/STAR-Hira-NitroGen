/**
 * 可编辑按钮登记表 —— 「按钮编辑浮层」与三个物理容器之间的**唯一中介**（薄装配器）。
 *
 * 背景：导航栏的按钮物理上分住三个容器（左导航区 / 地址栏内 / 右侧面板区），
 * 用户可以在编辑浮层里排序与显隐，面板插件还会动态增删按钮。若让每个部件各自
 * 记一份「有哪些按钮、什么顺序、哪些被隐藏」，三份状态必然漂移。
 * 所以顺序、显隐、段归属、以及给编辑浮层的**投放区几何**全部收在这一层。
 *
 * 这里只做**装配**，两件真本事各住自己的家：
 *   toolbar/ledger.ts  账本：登记 / 顺序 / 显隐（状态）
 *   toolbar/zones.ts   尺子：把按钮量成窗口坐标矩形（几何）
 *
 * 解耦要点：
 *   · 不认识任何具体按钮（导航按钮、书签星、面板按钮都由外部注入 `add(id, el)`）；
 *   · 不认识布局（容器由外部注入 `hosts`）；
 *   · 不认识几何（量测被关在 zones.ts 里，账本对像素零知识）。
 */

import { createToolbarLedger } from './toolbar/ledger'
import { createToolbarZones } from './toolbar/zones'
import type {
  ToolbarCatalogEntry,
  ToolbarZone
} from './types'

/**
 * @param {{
 *   catalog: Array<{ id: string, segment?: string }>,
 *   hosts: Record<string, HTMLElement>,
 *   anchors?: Record<string, HTMLElement>,
 *   refs?: Record<string, HTMLElement>
 * }} options
 *   hosts   —— 段名 → 该段的物理容器（重排只在自己的容器内发生）
 *   anchors —— 段名 → 段内**固定在最前**的非编辑成员（nav: rail 开关）
 *   refs    —— 段名 → 该段「空无一物时」用来量投放区的参照物（panel: 菜单按钮）
 * @returns {{
 *   add: (id: string, el: HTMLElement) => HTMLElement,
 *   declare: (id: string, segment?: string) => void,
 *   prune: (host: HTMLElement, liveIds: Set<string>) => void,
 *   pruneGroup: (segment: string, liveIds: Set<string>) => void,
 *   setOrder: (ids: string[]) => void,
 *   setSegments: (segments: Record<string,string>|null) => void,
 *   setGroupOrder: (ids: string[]) => void,
 *   order: () => string[],
 *   applyOrder: () => void,
 *   zones: () => Array<object>
 * }}
 */
export function createToolbarRegistry(options: {
  catalog: ToolbarCatalogEntry[]
  hosts: Record<string, HTMLElement>
  anchors?: Record<string, HTMLElement>
  refs?: Record<string, HTMLElement>
}): {
  add<T extends HTMLElement>(id: string, element: T): T
  declare(id: string, segment?: string): void
  declareSegment(segment: string): void
  prune(host: HTMLElement, liveIds: Set<string>): void
  pruneGroup(segment: string, liveIds: Set<string>): void
  setOrder(ids: string[]): void
  setSegments(segments: Record<string, string> | null): void
  setGroupOrder(ids: string[]): void
  order(): string[]
  applyOrder(): void
  zones(): ToolbarZone[]
} {
  const ledger = createToolbarLedger({
    catalog: options.catalog,
    hosts: options.hosts,
    anchors: options.anchors || {}
  })
  const geo = createToolbarZones({ ledger, refs: options.refs || {} })

  function setGroupOrder(ids: string[]): void {
    const order = (Array.isArray(ids) ? ids : []).filter((id, index, list) => list.indexOf(id) === index)
    const complete = [...order, ...ledger.segments().filter((id) => !order.includes(id))]
    for (const id of ledger.segments()) {
      const host = ledger.hostOf(id)
      if (!host) continue
      const index = complete.indexOf(id)
      host.style.order = index >= 0 ? String(index) : ''
    }
  }

  return {
    add<T extends HTMLElement>(id: string, element: T): T {
      return ledger.add(id, element) as T
    },
    declare: ledger.declare,
    declareSegment: ledger.declareSegment,
    prune: ledger.prune,
    pruneGroup: ledger.pruneGroup,
    setOrder: ledger.setOrder,
    setSegments: ledger.setSegments,
    setGroupOrder,
    order: ledger.order,
    applyOrder: ledger.applyOrder,
    zones: geo.zones
  }
}
