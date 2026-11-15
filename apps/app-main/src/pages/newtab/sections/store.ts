/**
 * 起始页外壳状态：停留在哪个分区 + 各分区自己的偏好。
 *
 * 刻意**与 widgets/store.js 分开存**：
 *   · widgets/store.js 存的是"用户摆的组件" —— 用户资产，丢了是事故；
 *   · 这里存的是"界面停在哪一页"—— 使用痕迹，丢了无所谓。
 * 两者的重要性与生命周期完全不同，混在一个 key 里，
 * 以后想单独清理/迁移任意一边都会被另一边牵制。
 *
 * 落盘方式与 widgets/store.js 保持一致：改动先合并、120ms 落一次、pagehide 兜底。
 */
const STORAGE_KEY = 'hira.ntp.shell.v1'
const VERSION = 1

type PrefBag = Record<string, unknown>

interface ShellState {
  version: number
  active: string
  prefs: Record<string, PrefBag>
}

function emptyState(): ShellState {
  return { version: VERSION, active: '', prefs: {} }
}

function normalize(raw: unknown): ShellState | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const state = emptyState()
  state.active = typeof input.active === 'string' ? input.active : ''
  if (input.prefs && typeof input.prefs === 'object' && !Array.isArray(input.prefs)) {
    const prefs = input.prefs as Record<string, unknown>
    for (const key of Object.keys(prefs)) {
      const bag = prefs[key]
      if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
        state.prefs[key] = { ...(bag as PrefBag) }
      }
    }
  }
  return state
}

let state = emptyState()
try {
  state = normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')) || emptyState()
} catch (_) {
  /* 脏数据：直接用空状态，键会在下次 push 时被覆盖 */
}

let timer = 0

function flush() {
  if (timer) {
    window.clearTimeout(timer)
    timer = 0
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (_) {
    /* 配额满：不落盘也能用，只是下次打开回到默认分区 */
  }
}

function push() {
  if (timer) return
  timer = window.setTimeout(flush, 120)
}

window.addEventListener('pagehide', flush)

/** 上次停留的分区 id（可能已被移除，由调用方校验）。 */
export function activeSectionId() {
  return state.active
}

export function setActiveSectionId(id: string): void {
  if (state.active === id) return
  state.active = id
  push()
}

/**
 * 读某个分区的偏好项。分区自己的零碎选择（比如新闻页选了哪个源）
 * 走这里，不必各开一个 localStorage 键。
 */
export function getPref(sectionId: string, key: string, fallback?: unknown): unknown {
  const bag = state.prefs[sectionId]
  const value = bag ? bag[key] : undefined
  return value === undefined ? fallback : value
}

/**
 */
export function setPref(sectionId: string, key: string, value: unknown): void {
  if (!state.prefs[sectionId]) state.prefs[sectionId] = {}
  state.prefs[sectionId][key] = value
  push()
}
