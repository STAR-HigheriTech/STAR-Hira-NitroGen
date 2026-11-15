/**
 * automation —— 自动化模型（D2 命令链 + D3 鼠标手势）的**规则层**。
 *
 * ── 为什么两者同一份模型 ────────────────────────────────────────────
 * 命令链与鼠标手势都是"把已有的浏览器命令重新编排成一条入口"：链是**一串**命令，
 * 手势是**一个**方向映射到命令。它们共享命令目录、命令 id 命名空间、以及"命令 id
 * 交给谁执行"。所以放同一个模块、同一条线，而不是各写一份 id 表
 * （两份 id 表必然漂移，漂移的表现就是"配了但点了没反应"）。
 *
 * ── 命令目录：**不手抄，从既有真源派生** ─────────────────────────────
 * 本文件只维护一份**选取清单**（哪些动作值得被编排）；每个动作的**中文名与分组**
 * 一律回既有真源查，不在这里抄第二遍：
 *   · `keybindings.mjs#KEYBINDING_GROUPS` —— 快捷键动作（`tab:close` / `zoom:in` …）
 *   · `commands.mjs#COMMANDS`              —— 地址栏命令（`open_settings` / `capture_page` …）
 * 执行侧同样是这两个命名空间的联合查找（见 `main/automation.js#runAction`）。
 * 于是改一个动作的名字只改它自己的真源，自动化页 / 手势标签 / 链摘要同时跟着变；
 * 清单里写错 id（真源里根本没有）会在模块求值时**直接报错**，不会变成一条
 * "下拉框里有、点了没反应"的幽灵命令。
 *
 * ── 手势识别在哪 ────────────────────────────────────────────────────
 * 纯几何识别在 `automation-gestures.mjs`（零依赖，preload 直接加载）；本文件不重复实现。
 */

import { KEYBINDING_GROUPS } from './keybindings.js'
import { COMMANDS } from './commands.js'

/** 链 / 手势的容量与形状约束（超限一律截断，不抛 —— 它们来自用户手改的设置）。 */
export const AUTOMATION_LIMITS = Object.freeze({
  maxChains: 50,
  maxSteps: 20,
  maxNameLength: 60
})

/** 动作 id → { label, group }：快捷键真源优先。 */
const KEYBINDING_ACTION_META = new Map()
for (const group of KEYBINDING_GROUPS) {
  for (const action of group.actions) {
    KEYBINDING_ACTION_META.set(action.id, { label: action.name, group: group.label })
  }
}

/**
 * 地址栏命令的分组口径（命令真源本身没有"分组"字段，只有"是不是内部页"）：
 * 有 `page` = 跳去另一个页面，归「内部页」；没有 = 操作当前页，归「页面」。
 */
const COMMAND_GROUP_INTERNAL = '内部页'
const COMMAND_GROUP_PAGE = '页面'

/** 动作 id → { label, group }：地址栏命令兜底。 */
const COMMAND_META = new Map(
  COMMANDS.map((cmd) => [
    cmd.id,
    { label: cmd.title, group: cmd.page ? COMMAND_GROUP_INTERNAL : COMMAND_GROUP_PAGE }
  ])
)

/**
 * 可编排命令的**选取清单**（只有 id；名称与分组不在这里抄）。
 * 顺序 = 自动化页下拉框里 optgroup 的出现顺序，所以按分组排好，
 * 「内部页」放最后（它们是"跳走"，不是"操作当前页"）。
 */
const AUTOMATION_ACTION_IDS = Object.freeze([
  // 标签页
  'tab:new',
  'tab:new-incognito',
  'tab:close',
  'tab:next',
  'tab:prev',
  'tab:undo-close',
  'tab:sleep',
  'tab:back',
  'tab:forward',
  'tab:reload',
  'tab:split-toggle',
  'tab:glance-toggle',
  // 分屏
  'split:focus-left',
  'split:focus-right',
  'split:focus-up',
  'split:focus-down',
  // 导航与查找
  'nav:focus-url',
  'find:open',
  // 书签
  'bookmark:toggle',
  'bookmarkbar:toggle',
  'bookmarks:open',
  // 视图与布局
  'zoom:in',
  'zoom:out',
  'zoom:reset',
  'view:reader-mode',
  'view:devtools',
  'view:toggle-fullscreen',
  'layout:toggle-vertical-tabs',
  // 窗口
  'window:new',
  'window:new-incognito',
  // 页面（地址栏命令里没有内部页的那些）
  'capture_page',
  // 内部页
  'open_history',
  'open_downloads',
  'open_settings',
  'open_extensions',
  'open_passwords',
  'open_task_manager',
  'open_spaces',
  'open_profiles',
  'open_about',
  'open_automation'
])

/**
 * 可编排命令目录（D2/D3 共用；自动化页下拉框的选项来源）。
 * 名称与分组来自 `keybindings.mjs` / `commands.mjs`，本文件不做第二份文案。
 */
export const AUTOMATION_ACTIONS = Object.freeze(
  AUTOMATION_ACTION_IDS.map((id) => {
    const meta = KEYBINDING_ACTION_META.get(id) || COMMAND_META.get(id)
    if (!meta) {
      throw new Error(
        `[automation] 动作 id「${id}」不在 keybindings.mjs#KEYBINDING_GROUPS 或 commands.mjs#COMMANDS 里`
      )
    }
    return Object.freeze({ id, label: meta.label, group: meta.group })
  })
)

const ACTION_ID_SET = new Set(AUTOMATION_ACTIONS.map((a) => a.id))

export interface AutomationChain { id: string; name: string; steps: string[] }
export type GestureMap = Record<string, string>

/** 命令 id 是否在目录里（用于过滤用户手改设置带进来的野 id）。 */
export function isKnownAction(id: unknown): boolean {
  return ACTION_ID_SET.has(String(id || ''))
}

/** id → 中文名（找不到就回落 id 本身，绝不显示空白）。 */
export function actionLabel(id: unknown): string {
  const hit = AUTOMATION_ACTIONS.find((a) => a.id === id)
  return hit ? hit.label : String(id || '')
}

/**
 * 手势方向：4 个基本方向 + 常用的两段组合。
 * `id` 就是方向序列字符串（`automation-gestures.mjs#gestureFromPath` 的返回值），
 * 所以映射表是"序列 → 命令"。
 */
export const GESTURE_DIRECTIONS = Object.freeze([
  { id: 'L', label: '← 左' },
  { id: 'R', label: '→ 右' },
  { id: 'U', label: '↑ 上' },
  { id: 'D', label: '↓ 下' },
  { id: 'UD', label: '↑↓ 上-下' },
  { id: 'DU', label: '↓↑ 下-上' },
  { id: 'LR', label: '←→ 左-右' },
  { id: 'RL', label: '→← 右-左' },
  { id: 'DR', label: '↓→ 下-右' },
  { id: 'UR', label: '↑→ 上-右' },
  { id: 'DL', label: '↓← 下-左' },
  { id: 'UL', label: '↑← 上-左' }
])

const GESTURE_ID_SET = new Set(GESTURE_DIRECTIONS.map((g) => g.id))

/**
 * 出厂手势映射（对齐 Vivaldi 的直觉：左=后退、右=前进、上=新标签、下=关标签，
 * 两段式留给不那么常用但很顺手的动作）。
 */
export const DEFAULT_GESTURE_MAP = Object.freeze({
  L: 'tab:back',
  R: 'tab:forward',
  U: 'tab:new',
  D: 'tab:close',
  UD: 'tab:reload',
  DU: 'tab:undo-close',
  DR: 'bookmark:toggle',
  UR: 'open_settings',
  DL: 'nav:focus-url',
  LR: 'tab:prev',
  RL: 'tab:next'
})

// ── 命令链：形状归一 / 解析 / 序列化 ──────────────────────────────────

/**
 * 归一一条链：`{ id, name, steps }`。
 * 未知命令 id 一律**丢弃**（设置是用户可手改的 JSON，野 id 只会静默失效）。
 * @param {any} raw
 * @returns {{ id: string, name: string, steps: string[] }|null}
 */
export function normalizeChain(raw: unknown) : { id: string, name: string, steps: string[] }|null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = String(source.id || '').trim()
  const name = String(source.name || '').trim().slice(0, AUTOMATION_LIMITS.maxNameLength)
  if (!id || !name) return null
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step) => String(step || '')).filter(isKnownAction).slice(0, AUTOMATION_LIMITS.maxSteps)
    : []
  if (steps.length === 0) return null
  return { id, name, steps }
}

/** 归一整张链表（去重按 id、丢弃非法项、封顶）。 */
export function normalizeChains(list: unknown): AutomationChain[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: AutomationChain[] = []
  for (const raw of list) {
    const chain = normalizeChain(raw)
    if (!chain || seen.has(chain.id)) continue
    seen.add(chain.id)
    out.push(chain)
    if (out.length >= AUTOMATION_LIMITS.maxChains) break
  }
  return out
}

/** 设置里存的是 JSON 字符串（设置项只有标量类型）→ 解析；坏数据一律当空表。 */
export function parseChains(value: unknown): AutomationChain[] {
  if (!value) return []
  try {
    return normalizeChains(typeof value === 'string' ? JSON.parse(value) : value)
  } catch (_) {
    return []
  }
}

/** 序列化（存回设置项）。 */
export function serializeChains(list: unknown): string {
  return JSON.stringify(normalizeChains(list))
}

/**
 * 按关键词匹配链（地址栏建议用）。
 * 空关键词返回全部（调用方自己决定要不要在空查询时就展示 —— 见 main/ipc/search.js）。
 */
export function matchChains(chains: unknown, query: unknown, limit = 5): AutomationChain[] {
  const q = String(query || '').trim().toLowerCase()
  const all = normalizeChains(chains)
  const hit = q
    ? all.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    : all
  return hit.slice(0, Math.max(1, Number(limit) || 5))
}

// ── 手势映射：归一 / 解析 / 序列化 ────────────────────────────────────

/** 归一映射表：只有"已知方向 → 已知命令"的项保留。 */
export function normalizeGestureMap(raw: unknown): GestureMap {
  if (!raw || typeof raw !== 'object') return {}
  const out: GestureMap = {}
  for (const [dir, action] of Object.entries(raw)) {
    if (!GESTURE_ID_SET.has(dir)) continue
    if (!isKnownAction(action)) continue
    out[dir] = String(action)
  }
  return out
}

export function parseGestureMap(value: unknown): GestureMap {
  if (!value) return {}
  try {
    return normalizeGestureMap(typeof value === 'string' ? JSON.parse(value) : value)
  } catch (_) {
    return {}
  }
}

export function serializeGestureMap(map: unknown): string {
  return JSON.stringify(normalizeGestureMap(map))
}
