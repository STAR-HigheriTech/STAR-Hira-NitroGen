/**
 * 新标签页 · 看板状态持久化
 *
 * 纯页面本地状态（localStorage），**不碰主进程、不碰插件系统**：
 * 新标签页的摆放是用户资产，但它属于「这个页面」，不属于浏览器内核。
 *
 * 结构刻意拆成互相独立的三块，各自演进互不牵连：
 *   instances —— 身份：这一格是哪个组件（增删改只动这里）
 *   configs   —— 配置：组件自己的选项（改配置不动布局）
 *   layouts   —— 位置：**按断点分桶**（宽屏 16 列 / 窄屏 8 列）
 *
 * 为什么位置要按断点分桶，而不是存一份再换算：
 * 拖拽是用户亲手摆的资产。在窄窗口里拖动，不该偷偷改写宽窗口里的摆放。
 * 「一个视图两种模式」的差异因此由**这一个模块统一管理**，而不是散到各处判断——
 * 上层（board）只问 `layoutFor(bp)`，永远拿不到"另一套模式"的残影。
 */

import { GAP, ROW_H } from './grid.js'
import type { BreakpointId, LayoutMap, Rect, WidgetState } from './types.js'

// 存储键**不带版本号** —— 版本存在载荷里（`version` 字段），键永远不变。
// 这样升级网格/结构时老数据仍然读得到，可以走迁移而不是被丢下。
const STORAGE_KEY = 'hira.ntp.board.v1'

/** 数据版本：结构变化时 +1，并在 migrate 里补一条迁移。 */
const VERSION = 3

/**
 * v1 → v2 的网格迁移。
 *
 * v1 的网格：宽屏 12 列 / 行高 84 / 间距 14（行步长 98px）
 * v2 的网格：宽屏 16 列 / 行高 52 / 间距 12（行步长 64px）
 *
 * 为什么要迁移而不是直接丢：列数变了 ⇒ 存下来的 x / w 必须等比放大；
 * 行步长变了 ⇒ y / h 必须等比放大。否则老布局会缩在左上角、每张卡还矮一截 ——
 * 而摆放是用户亲手摆的资产，不能因为一次"把格子调细"就报废。
 */
const LEGACY_GRID = Object.freeze({
  cols: Object.freeze({ wide: 12, narrow: 6 }),
  rowH: 84,
  gap: 14
})

function migrateV1toV2(state: WidgetState): void {
  const newRowStep = ROW_H + GAP
  const oldRowStep = LEGACY_GRID.rowH + LEGACY_GRID.gap
  for (const bpId of BREAKPOINT_IDS) {
    const bucket = state.layouts[bpId]
    const colsNew = breakpoint(bpId).cols
    const colsOld = LEGACY_GRID.cols[bpId] || colsNew
    const rx = colsNew / colsOld
    const ry = oldRowStep / newRowStep
    for (const i in bucket) {
      const r: Rect = bucket[i]
      bucket[i] = {
        x: Math.max(0, Math.round(r.x * rx)),
        y: Math.max(0, Math.round(r.y * ry)),
        w: Math.max(1, Math.round(r.w * rx)),
        h: Math.max(1, Math.round(r.h * ry))
      }
    }
  }
}

/**
 * v2 → v3：丢弃**非主断点**的布局桶。
 *
 * v2 里缺失的档是这么推导的：按比例算出 x/y，然后 `firstFreeSlot` 从左上角找洞 ——
 * 算出来的对称位置被整块丢掉，于是窄屏第一次出现时所有卡片塌成一列、搜索框也不再居中，
 * 而且这份坏布局随后被持久化，之后怎么缩放都不会自愈。
 *
 * 这些桶里已经分不清"哪一格是用户亲手摆的、哪一格是推导坏的"，所以整桶丢弃、
 * 交给新的 `ensureLayout`（按视觉顺序 + 三锚点 + 只向下压）重新推导。
 * 主断点是用户亲手摆的资产，**原样保留**。
 */
function migrateV2toV3(state: WidgetState): void {
  for (const bpId of BREAKPOINT_IDS) {
    if (bpId === MAIN_BREAKPOINT) continue
    state.layouts[bpId] = {}
  }
}

/**
 * 断点表。`minWidth` 同时是 board 的判定阈值。
 * cols 是这一档的网格列数：它决定**卡片宽度的粒度** —— 横向那三处对称锚点
 * （贴左 / 正中 / 贴右）的坐标就是按「卡宽 + cols」算出来的（见 grid#hAnchors），
 * 所以换断点不只是换步长，连"能摆在哪"都跟着变，这正是位置要按断点分桶的原因。
 * （纵向步长与它无关，由 grid 的 ROW_H / GAP 决定。）
 */
export const BREAKPOINTS = Object.freeze([
  Object.freeze({ id: 'wide', cols: 16, minWidth: 900 }),
  Object.freeze({ id: 'narrow', cols: 8, minWidth: 0 })
])
export const BREAKPOINT_IDS: readonly BreakpointId[] = Object.freeze(
  BREAKPOINTS.map((b) => b.id as BreakpointId)
)
export const MAIN_BREAKPOINT: BreakpointId = 'wide'

const BY_ID = new Map<BreakpointId, (typeof BREAKPOINTS)[number]>(
  BREAKPOINTS.map((b) => [b.id as BreakpointId, b])
)

export function breakpoint(id: BreakpointId): (typeof BREAKPOINTS)[number] {
  return BY_ID.get(id) || BY_ID.get(MAIN_BREAKPOINT)!
}

export function breakpointFor(width: number): BreakpointId {
  for (const bp of BREAKPOINTS) if (width >= bp.minWidth) return bp.id
  return BREAKPOINTS[BREAKPOINTS.length - 1].id
}

/** 非主断点（用于「从另一档推导布局」）。 */
export function siblingBreakpoint(id: BreakpointId): BreakpointId {
  return BREAKPOINT_IDS.find((x?) => x !== id) || MAIN_BREAKPOINT
}

/** 生成实例 id（不依赖 crypto，避免非安全上下文下不可用）。 */
export function newInstanceId(): string {
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function emptyState(): WidgetState {
  const layouts: LayoutMap = { wide: {}, narrow: {} }
  // seeded：是否已经放过"首次默认摆放"。一旦为 true 就永不再自动铺 ——
  // 用户把组件全删光也是他的选择，系统不该下次又给他摆回去（同 app.speed_dial 的口径）。
  return { version: VERSION, seeded: false, instances: [], configs: {}, layouts }
}

/**
 * 任意历史/脏数据 → 规范状态。永不抛错：拿不准的一律丢弃，
 * 页面宁可回到"空看板"也不能因为一条坏记录整页白屏。
 * @param {unknown} raw
 */
function normalize(raw: unknown): WidgetState {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  const input = raw as Record<string, unknown>
  state.seeded = input.seeded === true

  const seen = new Set<string>()
  const instances = Array.isArray(input.instances) ? input.instances : []
  for (const value of instances) {
    const it = isRecord(value) ? value : null
    const i = typeof it?.i === 'string' ? it.i : ''
    const widget = typeof it?.widget === 'string' ? it.widget : ''
    if (!i || !widget || seen.has(i)) continue
    seen.add(i)
    state.instances.push({ i, widget })
  }

  if (isRecord(input.configs)) {
    for (const i of seen) {
      const cfg = input.configs[i]
      if (isRecord(cfg)) state.configs[i] = { ...cfg }
    }
  }

  const rawLayouts = isRecord(input.layouts) ? input.layouts : {}
  for (const bpId of BREAKPOINT_IDS) {
    const bucket = rawLayouts[bpId]
    if (!isRecord(bucket)) continue
    for (const i of seen) {
      const record = bucket[i]
      if (!isRecord(record)) continue
      const x = Number(record.x)
      const y = Number(record.y)
      const w = Number(record.w)
      const h = Number(record.h)
      if (![x, y, w, h].every(Number.isFinite)) continue
      if (w < 1 || h < 1) continue
      state.layouts[bpId][i] = {
        // ⚠ 横坐标**不取整**：横向的合法落点是三处对称锚点，而"正中"可能是半格
        //（(cols − w)/2，见 grid#hAnchors）。这里一 round 就会把居中偷偷挪半格，
        // 而 0.5 格在 16 列下是 30+px —— 看得见的"没居中"。合法性由板层 clampSizeFor 统一收口。
        x: Math.max(0, x),
        y: Math.max(0, Math.round(y)),
        w: Math.max(1, Math.round(w)),
        h: Math.max(1, Math.round(h))
      }
    }
  }

  // 老数据逐级迁移到当前版本。
  // ⚠ 必须链式（< 2 跑 v1→v2、< 3 再跑 v2→v3），不能写成「不等于当前版本就重跑第一条」——
  // 那会把 v2 的数据再按 v1 的旧网格缩放一遍，布局直接报废。
  const from = Number(input.version) || 1
  if (from < 2) migrateV1toV2(state)
  if (from < 3) migrateV2toV3(state)
  state.version = VERSION
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

let cache: WidgetState | null = null

/** 读取（进程内缓存，同一次页面生命周期只解析一次 JSON）。 */
export function load(): WidgetState {
  if (cache) return cache
  let raw = null
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
  } catch (_) {
    raw = null
  }
  cache = normalize(raw)
  return cache
}

let writeTimer = 0

function write(state: WidgetState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (_) {
    /* 隐私模式 / 配额满：静默降级为「本次会话内存态」，不影响使用 */
  }
}

/**
 * 合并写入（拖拽过程中会高频调用）。
 * 120ms 内的多次调用只落一次盘 —— 拖拽跟手与落盘开销彻底解耦。
 */
export function save(state: WidgetState): void {
  cache = state
  if (writeTimer) return
  writeTimer = window.setTimeout(() => {
    writeTimer = 0
    if (cache) write(cache)
  }, 120)
}

/** 立即落盘（页面卸载前调用，保证最后一次拖拽不丢）。 */
export function flush(state?: WidgetState): void {
  if (state) cache = state
  if (writeTimer) {
    window.clearTimeout(writeTimer)
    writeTimer = 0
  }
  if (cache) write(cache)
}
