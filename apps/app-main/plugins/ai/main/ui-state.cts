/**
 * AI 引擎 · 跨宿主共享的界面状态（**唯一真源**）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════
 * 同一份面板有**三种宿主**：
 *   · 侧栏面板 — `panels/index.html?panelId=ai-panel`（WebContentsView）
 *   · 独立窗口 — `subwindow/index.html?type=detached-panel`
 *   · 内部页   — `hira://ai`
 * 三者跑在**各自独立的渲染进程**里。此前「当前会话 / 模型 / 推理档位 / 审批模式」
 * 分别存在各自的 `store.js` 内存里（还各自去 settings 读写），于是同一个用户
 * 在面板里选了「高」，窗口里还是「自动」—— 同一件事三份真相。
 *
 * 这里把它们收成**一份**：主进程持有 + `ai_ui_state` 落库 + 变更广播。
 * 渲染层只做两件事：`get()` 拿当前值、`set(patch)` 报自己的选择；
 * 谁改的、改成什么、其它宿主怎么跟，全部由这一层决定。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 四条硬规矩
 * ══════════════════════════════════════════════════════════════════════
 * 1. **只在真变化时落库 + 广播**：三个宿主会重复上报同一次选择（先本地乐观、
 *    再收到自己的回声），没变化就不写、不发，避免"回声 → 再上报"的无限循环。
 * 2. **枚举在入口收敛**：推理只认 `auto|low|medium|high`，审批只认 `allow|ask`；
 *    越界值一律丢弃而不是写进去（写进去会让另一端的控件没有可选项）。
 * 3. **值是"原始选择"，不是"解析结果"**：`modelChoice` 存 `providerId:modelId`
 *    原文；某个模型被删掉时由各宿主按自己的模型目录回落（目录是同一份，回落也一致）。
 * 4. **会话按宿主分槽，模型/档位/审批共用一份**：三种宿主可以各自停在不同对话上
 *    （`sessionIdByHost`），但「用哪个模型、想多深、审批松紧」是同一个用户的偏好，
 *    不该因为换了个壳就翻脸。`sessionId` 只作"最近活动"的兜底（旧版迁移 / 无宿主调用）。
 */

/** 宿主的合法身份（与 `shared/panel-context.js#ctx.host` 同一份口径）。 */
const HOSTS: readonly UiHost[] = Object.freeze(['panel', 'window', 'page'])
const HOST_SET = new Set<string>(HOSTS)

type UiHost = 'panel' | 'window' | 'page'
interface UiState extends Record<string, unknown> {
  sessionId: string | null
  sessionIdByHost: Record<UiHost, string | null>
  modelChoice: string | null
  reasoning: string
  approvalMode: string
}
interface UiStatePatch extends Record<string, unknown> {
  host?: string
  sessionId?: string | null
  modelChoice?: string | null
  reasoning?: string
  approvalMode?: string
}
interface UiStateDatabase {
  prepare(sql: string): {
    all<T = Record<string, unknown>>(): T[]
    run(...params: unknown[]): unknown
  }
}

/** 把任意输入收敛成一个宿主身份（未知一律当侧栏面板）。 */
function normalizeHost(host: unknown): UiHost {
  const key = String(host || '').trim().toLowerCase()
  return HOST_SET.has(key) ? key as UiHost : 'panel'
}

/** 推理档位（与 contracts/ai.js 的 enum 同一份口径）。 */
const REASONING_VALUES = new Set(['auto', 'low', 'medium', 'high'])
/** 网页内容审批模式。 */
const APPROVAL_VALUES = new Set(['allow', 'ask'])

/** 默认值 = 一个全新用户的起点。 */
function defaultState(): UiState {
  return {
    sessionId: null,
    sessionIdByHost: { panel: null, window: null, page: null },
    modelChoice: null,
    reasoning: 'auto',
    approvalMode: 'ask'
  }
}
const DEFAULTS = Object.freeze(defaultState())

const KEYS = Object.freeze(Object.keys(DEFAULTS))
/** 以 JSON 落库的字段（其余都是原始字符串）。 */
const JSON_KEYS = new Set(['sessionIdByHost'])

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  return str || null
}

/**
 * @param {{
 *   sqlite: any,
 *   emit: (route: string, payload: any) => void,
 *   event: string,
 *   logger?: { warn?: Function }
 * }} deps
 */
function createUiState({ sqlite, emit, event, logger = console }: {
  sqlite: UiStateDatabase
  emit: (route: string, payload: unknown) => void
  event: string
  logger?: Pick<Console, 'warn'>
}) {
  /** 内存缓存（读路径不碰库：面板首帧要快）。 */
  const state: UiState = defaultState()
  let loaded = false

  // 与 core/store.cjs 同一条理由：`kernel.sqlite` 是按 profile 路由的 Proxy，
  // 换空间会换底层连接，语句不能缓存。
  const db = () => sqlite

  function readRows(): Array<{ key: string; value: string | null }> {
    try {
      return db().prepare('SELECT key, value FROM ai_ui_state').all<{ key: string; value: string | null }>()
    } catch (_) {
      // 表还不存在（enable 早于迁移）→ 按默认值走，不抛
      return []
    }
  }

  function load() {
    if (loaded) return
    loaded = true
    for (const row of readRows()) {
      if (!row || !KEYS.includes(row.key)) continue
      if (JSON_KEYS.has(row.key)) {
        let parsed = null
        try { parsed = row.value ? JSON.parse(row.value) : null } catch (_) { parsed = null }
        if (parsed && typeof parsed === 'object') state[row.key] = parsed
        continue
      }
      state[row.key] = row.value === null || row.value === '' ? null : String(row.value)
    }
    sanitize()
  }

  /** 把库里的历史值收敛回合法域（老库可能写过别的档位名 / 没有分槽字段）。 */
  function sanitize() {
    state.sessionId = text(state.sessionId)
    state.modelChoice = text(state.modelChoice)
    const slots: Record<string, unknown> = state.sessionIdByHost && typeof state.sessionIdByHost === 'object'
      ? state.sessionIdByHost
      : {}
    const clean: Record<UiHost, string | null> = { panel: null, window: null, page: null }
    for (const host of HOSTS) clean[host] = text(slots[host])
    state.sessionIdByHost = clean
    if (!REASONING_VALUES.has(state.reasoning)) state.reasoning = DEFAULTS.reasoning
    if (!APPROVAL_VALUES.has(state.approvalMode)) state.approvalMode = DEFAULTS.approvalMode
  }

  function write(key: string, value: unknown): void {
    // JSON 字段（会话分槽）整块序列化；其余是原始字符串。
    const stored = value === null || value === undefined
      ? null
      : JSON_KEYS.has(key) ? JSON.stringify(value) : String(value)
    try {
      db().prepare(
        `INSERT INTO ai_ui_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, stored, Date.now())
    } catch (e) {
      // 写入失败不影响本进程的共享（下一次 set 还会再试）
      logger.warn && logger.warn('[ai] 共享状态落库失败：', e instanceof Error ? e.message : String(e))
    }
  }

  function broadcast() {
    // 统一信封 `{ uiState }`：与 IPC 响应同形，渲染层两处共用一份解包逻辑。
    try { emit(event, { uiState: get() }) } catch (_) {}
  }

  /** 当前共享状态（副本：调用方改不到内部）。 */
  function get() {
    load()
    return { ...state, sessionIdByHost: { ...state.sessionIdByHost } }
  }

  /**
   * 合并一次用户选择。
   * 只接受合法字段；没有真变化时**不落库、不广播**（回声去重）。
   *
   * 带 `host` 的 `sessionId` 只改**该宿主**那一格 —— 三种宿主因此可以各自停在
   * 不同对话上；`sessionId` 同步记为"最近活动"，供无宿主调用与旧库兜底。
   * @param {Partial<{host: string, sessionId: string|null, modelChoice: string|null, reasoning: string, approvalMode: string}>} patch
   */
  function set(patch: UiStatePatch) {
    load()
    if (!patch || typeof patch !== 'object') return get()

    const changed: string[] = []
    const host = Object.hasOwn(patch, 'host') ? normalizeHost(patch.host) : null
    if (Object.hasOwn(patch, 'sessionId')) {
      const next = text(patch.sessionId)
      if (host) {
        if (state.sessionIdByHost[host] !== next) {
          state.sessionIdByHost[host] = next
          changed.push('sessionIdByHost')
        }
      }
      if (next !== state.sessionId) { state.sessionId = next; changed.push('sessionId') }
    }
    if (Object.hasOwn(patch, 'modelChoice')) {
      const next = text(patch.modelChoice)
      if (next !== state.modelChoice) { state.modelChoice = next; changed.push('modelChoice') }
    }
    if (Object.hasOwn(patch, 'reasoning') && typeof patch.reasoning === 'string' && REASONING_VALUES.has(patch.reasoning)) {
      if (patch.reasoning !== state.reasoning) { state.reasoning = patch.reasoning; changed.push('reasoning') }
    }
    if (Object.hasOwn(patch, 'approvalMode') && typeof patch.approvalMode === 'string' && APPROVAL_VALUES.has(patch.approvalMode)) {
      if (patch.approvalMode !== state.approvalMode) { state.approvalMode = patch.approvalMode; changed.push('approvalMode') }
    }

    if (!changed.length) return get()
    for (const key of changed) write(key, (state as Record<string, unknown>)[key])
    broadcast()
    return get()
  }

  /**
   * 会话被删 / 数据被彻底移除：把**所有宿主**指向失效会话的引用清掉。
   * 与 `set({ sessionId })` 分开是为了表达意图（这里不是"用户切了会话"）。
   */
  function forgetSession(sessionId: unknown, nextSessionId?: unknown) {
    load()
    if (!sessionId) return get()
    const id = String(sessionId)
    const next = text(nextSessionId)
    const changed: string[] = []
    if (state.sessionId === id) { state.sessionId = next; changed.push('sessionId') }
    let slotsChanged = false
    for (const host of HOSTS) {
      if (state.sessionIdByHost[host] !== id) continue
      state.sessionIdByHost[host] = next
      slotsChanged = true
    }
    if (!slotsChanged) return changed.length ? finish(changed) : get()
    changed.push('sessionIdByHost')
    return finish(changed)
  }

  /** `forgetSession` 的公共收尾（落库 + 广播）。 */
  function finish(changed: string[]) {
    for (const key of changed) write(key, (state as Record<string, unknown>)[key])
    broadcast()
    return get()
  }

  /** 彻底移除后：库被 DROP 重建，缓存必须跟着回到默认值（并让三个宿主同步）。 */
  function reset() {
    loaded = true
    Object.assign(state, defaultState())
    broadcast()
    return get()
  }

  return { get, set, forgetSession, reset }
}

module.exports = { createUiState, normalizeHost, UI_STATE_DEFAULTS: DEFAULTS }
