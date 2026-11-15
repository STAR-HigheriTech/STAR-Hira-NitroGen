/**
 * automation —— 「自动化」控制器（D2 命令链 + D3 鼠标手势）的主进程侧。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 *   · **存**：命令链与手势映射都落在设置项里（`automation.*`），天然随 profile 隔离，
 *     不必新建表、也不必新开一套持久化。
 *   · **跑**：把一条链（或一个手势映射到的）命令交给 APPS 注入的 `dispatch` 执行。
 *     本模块**不认识**任何具体命令 —— 它只知道"有个 id 要执行"，怎么执行由 main.js 决定
 *     （先 `keybindingActions`、再 `omniboxAction`，两条既有命名空间，不新造第三条）。
 *   · **判**：手势上报 → 查映射 → 执行；同时记一个"刚刚发生了手势"的时间戳，
 *     供 `tabEvents` 的右键菜单判据吞掉紧随其后的那一次菜单（见 shouldSuppressContextMenu）。
 *
 * ── 为什么 dispatch 由外部注入 ────────────────────────────────────
 * 命令的真实执行者散在 main.js 的动作表与 TabManager 上；本模块要能在**单测**里跑，
 * 就不能反向依赖它们。这与 domain 层"端口注入"是同一条纪律，只是这里落在 APPS 层。
 */

import {
  AUTOMATION_ACTIONS,
  GESTURE_DIRECTIONS,
  DEFAULT_GESTURE_MAP,
  parseChains,
  serializeChains,
  parseGestureMap,
  serializeGestureMap,
  normalizeGestureMap,
  normalizeChains,
  matchChains,
  actionLabel
} from '@hira-ng/shared-types/src/automation.mjs'
import {
  WORKSPACE_RULE_SETTING_KEYS,
  parseWorkspaceRules,
  serializeWorkspaceRules,
  matchWorkspaceRules,
  type WorkspaceRule,
  type WorkspaceRuleEvent
} from '@hira-ng/shared-types/src/workspace-rules.mjs'

interface AutomationSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface AutomationChain {
  id: string
  name: string
  steps: string[]
}

type GestureMap = Record<string, string>

export interface AutomationControllerOptions {
  settings: AutomationSettingsPort
  dispatch?(action: string, payload?: Record<string, unknown>): boolean
  slots?: { multi(id: string, payload: unknown): unknown[] } | null
}

export interface AutomationRunResult { ok: boolean; ran: number }

export interface AutomationController {
  getConfig(): Record<string, unknown>
  save(payload?: { chains?: unknown[]; gestures?: GestureMap; gesturesEnabled?: boolean; rules?: unknown[]; rulesEnabled?: boolean }): { ok: true }
  run(payload?: { chainId?: string; action?: string }): Promise<AutomationRunResult>
  runAction(action: unknown): boolean
  runChain(chainId: string): Promise<AutomationRunResult>
  handleGesture(gesture: string, webContents: object | null | undefined): { ok: boolean; handled: boolean }
  shouldSuppressContextMenu(webContents: object | null | undefined): boolean
  suggestChains(query: string, limit?: number): Array<Record<string, unknown>>
  getGestureMap(): Record<string, { action: string; label: string }>
  getChains(): AutomationChain[]
  getGestures(): GestureMap
  isGesturesEnabled(): boolean
  getRules(): WorkspaceRule[]
  getRuleTriggers(): Array<{ id: string; label: string }>
  isRulesEnabled(): boolean
  handleTabEvent(event: WorkspaceRuleEvent): Promise<{ matched: number; ran: number }>
  KEYS: typeof KEYS
}

/** 设置项键（与 settings/registry.js 的声明逐字一致）。 */
const KEYS = {
  chains: 'automation.chains',
  gestures: 'automation.gestures',
  enabled: 'automation.gestures_enabled',
  rules: WORKSPACE_RULE_SETTING_KEYS.rules,
  rulesEnabled: WORKSPACE_RULE_SETTING_KEYS.enabled
}

/** 链内相邻两步之间的间隔：让"新建标签 → 打开某站"这类链真的按顺序落到同一个窗口。 */
const STEP_DELAY_MS = 150
/** 手势结束后抑制右键菜单的时长（与 preload 侧同值，互为兜底）。 */
const SUPPRESS_MS = 800

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} deps
 * @param {{ get: (k: string) => any, set: (k: string, v: any) => void }} deps.settings
 * @param {(action: string) => boolean} deps.dispatch 执行一个命令 id（返回是否有人认领）
 */
export function createAutomationController(deps: AutomationControllerOptions): AutomationController {
  const settings = deps.settings
  const dispatch = typeof deps.dispatch === 'function' ? deps.dispatch : () => false
  const slots = deps.slots || null
  /** 手势刚发生的 webContents → 时间戳（右键菜单判据用）。 */
  const gestureAt = new WeakMap<object, number>()

  function read(key: string, fallback: unknown): unknown {
    try {
      const v = settings && typeof settings.get === 'function' ? settings.get(key) : null
      return v == null ? fallback : v
    } catch (_) {
      return fallback
    }
  }

  function write(key: string, value: unknown): void {
    try { if (settings && typeof settings.set === 'function') settings.set(key, value) } catch (_) {}
  }

  function getChains(): AutomationChain[] {
    return parseChains(read(KEYS.chains, '')) as AutomationChain[]
  }

  /**
   * 手势映射：**没配过就用出厂映射**（用户没进过自动化页也能直接用手势）；
   * 配过（哪怕是空对象）就完全以用户的为准 —— 空对象 = "我全删了"，不该被默认值覆盖。
   */
  function getGestures(): GestureMap {
    const raw = read(KEYS.gestures, null)
    if (raw == null || raw === '') return { ...DEFAULT_GESTURE_MAP }
    return parseGestureMap(raw) as GestureMap
  }

  function isGesturesEnabled(): boolean {
    const v = read(KEYS.enabled, true)
    return v !== false && v !== 'false' && v !== 0 && v !== '0'
  }

  function getRules(): WorkspaceRule[] {
    return parseWorkspaceRules(read(KEYS.rules, ''))
  }

  function getRuleTriggers(): Array<{ id: string; label: string }> {
    const seen = new Set(['open', 'navigate'])
    const output: Array<{ id: string; label: string }> = []
    for (const item of slots?.multi('workspace.rule-trigger', {}) || []) {
      if (!item || typeof item !== 'object') continue
      const source = item as Record<string, unknown>
      const id = String(source.id || '').trim().slice(0, 80)
      if (!id || seen.has(id)) continue
      seen.add(id)
      output.push({ id, label: String(source.label || source.title || id).trim().slice(0, 80) })
    }
    return output
  }

  function isRulesEnabled(): boolean {
    const value = read(KEYS.rulesEnabled, true)
    return value !== false && value !== 'false' && value !== 0 && value !== '0'
  }

  /** 完整配置快照（自动化页 / 地址栏建议共用）。 */
  function getConfig(): Record<string, unknown> {
    return {
      chains: getChains(),
      gestures: getGestures(),
      gesturesEnabled: isGesturesEnabled(),
      rules: getRules(),
      rulesEnabled: isRulesEnabled(),
      ruleTriggers: getRuleTriggers(),
      actions: AUTOMATION_ACTIONS,
      directions: GESTURE_DIRECTIONS
    }
  }

  /**
   * 写配置。**只写传进来的字段**（`undefined` 一律跳过）——
   * 否则"只改手势开关"会顺手把命令链清空。
   * @param {{ chains?: any[], gestures?: Record<string,string>, gesturesEnabled?: boolean }} payload
   */
  function save(payload: { chains?: unknown[]; gestures?: GestureMap; gesturesEnabled?: boolean; rules?: unknown[]; rulesEnabled?: boolean } = {}): { ok: true } {
    if (Object.prototype.hasOwnProperty.call(payload, 'chains') && payload.chains !== undefined) {
      write(KEYS.chains, serializeChains(payload.chains))
    }
    if (payload.gestures !== undefined) {
      write(KEYS.gestures, serializeGestureMap(payload.gestures))
    }
    if (payload.gesturesEnabled !== undefined) {
      write(KEYS.enabled, Boolean(payload.gesturesEnabled))
    }
    if (payload.rules !== undefined) {
      write(KEYS.rules, serializeWorkspaceRules(payload.rules))
    }
    if (payload.rulesEnabled !== undefined) {
      write(KEYS.rulesEnabled, Boolean(payload.rulesEnabled))
    }
    return { ok: true }
  }

  /**
   * 跑一条命令：**两个既有命名空间的联合查找**（不新造命令表）。
   * @param {string} action
   * @returns {boolean} 是否有动作认领
   */
  function runAction(action: unknown, payload?: Record<string, unknown>): boolean {
    const id = String(action || '')
    if (!id) return false
    try {
      return Boolean(dispatch(id, payload))
    } catch (e) {
      console.warn('[automation] 执行失败:', id, e instanceof Error ? e.message : String(e))
      return false
    }
  }

  const recentRuleHits = new Map<string, number>()
  const RULE_HIT_TTL_MS = 15_000

  async function handleTabEvent(event: WorkspaceRuleEvent): Promise<{ matched: number; ran: number }> {
    if (!isRulesEnabled() || !event || !event.url || !event.tabId || event.active === false) return { matched: 0, ran: 0 }
    const now = Date.now()
    for (const [key, at] of recentRuleHits) {
      if (now - at > RULE_HIT_TTL_MS) recentRuleHits.delete(key)
    }
    const events: WorkspaceRuleEvent[] = [event]
    for (const item of slots?.multi('workspace.rule-trigger', { event }) || []) {
      if (!item || typeof item !== 'object') continue
      const source = item as Record<string, unknown>
      const id = String(source.id || '').trim()
      const resolve = typeof source.resolve === 'function' ? source.resolve : null
      if (!id || id === 'open' || id === 'navigate' || !resolve) continue
      try {
        const resolved = await resolve(event)
        const triggers = Array.isArray(resolved) ? resolved : resolved ? [resolved] : []
        if (triggers.some((trigger) => String(trigger || '').trim() === id)) {
          events.push({ ...event, trigger: id })
        }
      } catch (error) {
        console.warn('[automation] workspace trigger failed:', id, error)
      }
    }
    const matches = events.flatMap((candidate) => matchWorkspaceRules(getRules(), candidate))
    let ran = 0
    for (const match of matches) {
      const hitKey = `${event.tabId}\u0000${match.rule.id}\u0000${event.url}`
      if (recentRuleHits.has(hitKey)) continue
      recentRuleHits.set(hitKey, now)
      for (const action of match.actions) {
        if (action.startsWith('chain:')) {
          const result = await runChain(action.slice('chain:'.length))
          if (result.ok) ran++
        } else if (runAction(action, {
          tabId: event.tabId,
          url: event.url,
          title: event.title || '',
          ruleId: match.rule.id
        })) {
          ran++
        }
        await sleep(80)
      }
    }
    return { matched: matches.length, ran }
  }

  /**
   * 跑一条命令链：逐步执行，步与步之间留一个短间隔。
   * @param {string} chainId
   * @returns {Promise<{ ok: boolean, ran: number }>}
   */
  async function runChain(chainId: string): Promise<AutomationRunResult> {
    const chain = getChains().find((c) => c.id === chainId)
    if (!chain) {
      console.warn('[automation] 没有这条命令链:', chainId)
      return { ok: false, ran: 0 }
    }
    let ran = 0
    for (const step of chain.steps) {
      if (runAction(step)) ran++
      await sleep(STEP_DELAY_MS)
    }
    return { ok: ran > 0, ran }
  }

  /** 执行请求的统一入口（`{chainId}` 或 `{action}`）。 */
  async function run(payload: { chainId?: string; action?: string } = {}): Promise<AutomationRunResult> {
    if (payload.chainId) return runChain(payload.chainId)
    const ran = runAction(payload.action) ? 1 : 0
    return { ok: ran > 0, ran }
  }

  /**
   * 手势上报：查映射 → 执行。
   * @param {string} gesture 方向序列（如 `'DR'`）
   * @param {any} wc 上报方（记抑制时间戳用）
   * @returns {{ ok: boolean, handled: boolean }}
   */
  function handleGesture(gesture: string, wc: object | null | undefined): { ok: boolean; handled: boolean } {
    if (!gesture) return { ok: true, handled: false }
    if (!isGesturesEnabled()) return { ok: true, handled: false }
    const action = getGestures()[gesture]
    if (!action) return { ok: true, handled: false }
    // 先记抑制：右键菜单可能在 dispatch 期间到达（见 tabEvents 的判据）。
    if (wc) { try { gestureAt.set(wc, Date.now()) } catch (_) {} }
    const handled = runAction(action)
    return { ok: true, handled }
  }

  /**
   * 该 webContents 是不是"刚做完手势"（< SUPPRESS_MS）→ 这一次右键菜单应当吞掉。
   * 供 `tabEvents` 的通用钩子调用（infra 不认识"手势"，只问"要不要吞"）。
   * @param {any} wc
   */
  function shouldSuppressContextMenu(wc: object | null | undefined): boolean {
    if (!wc) return false
    let at = 0
    try { at = gestureAt.get(wc) || 0 } catch (_) { return false }
    if (!at) return false
    if (Date.now() - at > SUPPRESS_MS) return false
    try { gestureAt.delete(wc) } catch (_) {}
    return true
  }

  /**
   * 方向序列 → `{ action, label }`（页面手势引擎取一次并缓存）。
   *
   * 页面要在"画的过程中"实时显示这一笔会触发什么，而映射表是设置项、中文命令名表在
   * 纯层 —— 与其让页面各抄一份，不如主进程查好给它（见 preload/gestures 的说明）。
   */
  function getGestureMap(): Record<string, { action: string; label: string }> {
    const gestures = getGestures()
    const out: Record<string, { action: string; label: string }> = {}
    for (const [dir, action] of Object.entries(gestures)) {
      out[dir] = { action, label: actionLabel(action) }
    }
    return out
  }

  /** 地址栏建议：按关键词匹配命令链（`chain:<id>` 是 omnibox 侧的约定动作前缀）。 */
  function suggestChains(query: string, limit = 5): Array<Record<string, unknown>> {
    return (matchChains(getChains(), query, limit) as AutomationChain[]).map((c) => ({
      type: 'pedal',
      action: `chain:${c.id}`,
      title: `运行命令链：${c.name}`,
      relevance: 420,
      source: 'chain'
    }))
  }

  return {
    getConfig,
    save,
    run,
    runAction,
    runChain,
    handleGesture,
    shouldSuppressContextMenu,
    suggestChains,
    getGestureMap,
    getChains,
    getGestures,
    isGesturesEnabled,
    getRules,
    getRuleTriggers,
    isRulesEnabled,
    handleTabEvent,
    KEYS
  }
}

export { KEYS as AUTOMATION_KEYS }
