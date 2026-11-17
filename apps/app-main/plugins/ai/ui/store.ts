/**
 * AI 面板 · 状态机（**唯一可写状态**，零 DOM）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这一层
 * ══════════════════════════════════════════════════════════════════════
 * 面板由十来个视图拼成。若每个视图各自 `ai.state()`、各自订阅五条事件、
 * 各自把流式帧拼成气泡，就会出现 N 份不一致的"真相" —— 改一个交互要改 N 处。
 * 这里把「引擎事件流 → 面板可画的状态」收敛成一份，视图只读。
 *
 * 三条硬规矩：
 *   1. **通知走 rAF 合批**：一个 token 一帧会把主线程打断成筛子，同帧内的多次
 *      变更只通知一次（与引擎侧 16ms 合批同一条理由）。
 *   2. **settlement 只裁"请求发出前"的流式片段**：`usage` 到达时记录 cut，
 *      拉回权威投影后 `splice(0, cut)` —— 请求期间新到的文本不会被误删。
 *   3. **内存只是缓存**：会话切换 / 崩溃恢复一律以 `ai:messages` 的投影为准，
 *      流式片段只是"还没落库的那一段"。
 *
 * 事件形状见 `contracts/ai.js` 与 `turn-runner.cjs` 文件头（不在渲染层重抄一遍）。
 */

/**
 * 会话 / 模型 / 推理档位 / 审批模式**不再各存一份**。
 *
 * 侧栏面板、独立窗口、内部页是三个渲染进程，各持一份内存状态就会出现
 * "窗口里换了模型，侧栏还是旧的"。真源统一在主进程（`main/ui-state.cjs`
 * + `ai_ui_state` 表），三者共用同一份：谁改谁 `uiState.set(patch)` 上报，
 * 主进程落库后广播，其余宿主只**对齐**、不回写（否则会回声）。
 *
 * 这里只保留"对齐"与"上报"两个动作，不再有 settings 读写。
 */

import type {
  AiActionResult,
  AiApproval,
  AiClientPort,
  AiContextItem,
  AiIntent,
  AiMessage,
  AiProvider,
  AiSession,
  AiSnapshot,
  AiSkill,
  AiStreamDelta,
  AiStreamEvent,
  AiStreaming,
  AiUiError,
  AiUiState,
  ApprovalDecision,
  ApprovalMode,
  ReasoningLevel
} from './types.js'

type AiSendResult = {
  ok: boolean
  sessionId?: string | null
  reason?: string
  steered?: boolean
  error?: AiUiError | null
}

type AiReasoningOption = { value: ReasoningLevel; label: string }
type AiModelOption = {
  key: string
  providerId: string
  modelId: string
  label: string
  providerLabel: string
  reasoning: string
}
type TimerHandle = ReturnType<typeof setTimeout>

/** 审批模式的可读名（两态控件只有这两个）。 */
const APPROVAL_LABEL: Record<string, string> = Object.freeze({ allow: '允许', ask: '询问' })

/** 审批模式的说明（按钮 tooltip；语义与 `tool-gate#evaluate` 对齐）。 */
const APPROVAL_HINT: Record<string, string> = Object.freeze({
  allow: '除破坏性操作外不再询问（正在跑的回合立刻生效）',
  ask: '工具调用前先询问（点「始终允许」可按工具记住）'
})

/** 推理等级的可读名（下拉里显示）。 */
const REASONING_LABEL: Record<string, string> = Object.freeze({ auto: '自动', low: '低', medium: '中', high: '高' })

/** 会话切换时一次拉多少条事件（更早的靠"加载更早"补，本版先不做无限回滚）。 */
const HISTORY_LIMIT = 300

const KIND_LABEL = Object.freeze({
  page: '页面',
  selection: '选区',
  screenshot: '截图',
  bookmark: '书签',
  history: '历史',
  note: '笔记',
  file: '文件',
  text: '文本',
  tab: '标签',
  'closed-tab': '已关闭',
  workspace: '工作区'
})

/** 只有上下文、没有文字时也要能发出去（`send` 契约要求 text 与 blocks 至少一个）。 */
const DEFAULT_PROMPT = '请阅读我引用的内容，说明它的要点。'

function errorText(err: unknown): string {
  if (!err) return '未知错误'
  const msg = err instanceof Error ? err.message : String(err)
  if (/No handler registered|not found|AI_NO_ENGINE/i.test(msg)) return 'AI 引擎不可用（插件可能已禁用）'
  return msg
}

function errorPayload(err: unknown): AiUiError {
  const record = err && typeof err === 'object' ? err as Record<string, unknown> : null
  return {
    message: errorText(err),
    code: String(record?.code || ''),
    // 只有引擎明确标了可重试（超时 / 限流 / 5xx）才给"重试"按钮
    retryable: record?.retryable === true
  }
}

export type AiStore = ReturnType<typeof createAiStore>

/**
 * 回合**正常收尾**但没写完时的说明（`frame:'end'` 的 `stopReason`）。
 *
 * 这两种情况不重试（重试会整轮重答，白花钱），所以 `retryable: false`；
 * 但一定要说清楚，否则用户看到的是"答到一半就停了、也没显示完成"。
 * @returns {{message:string, code:string, retryable:boolean}|null}
 */
function stopNotice(stopReason: unknown): AiUiError | null {
  const reason = String(stopReason || '')
  if (reason === 'length') {
    return {
      message: '已达到模型输出长度上限，回答被截断。可在模型设置里调大「最大输出 Tokens」，或直接说「继续」。',
      code: 'length',
      retryable: false
    }
  }
  if (reason === 'max-steps') {
    return {
      message: '本轮工具步骤达到安全上限，已暂停并保留当前进度。回复「继续」即可接着执行。',
      code: 'max-steps',
      retryable: false
    }
  }
  return null
}

export function createAiStore({ doc, ai, host = 'panel', onIntentComplete }: {
  doc: Document
  ai: AiClientPort
  host?: 'panel' | 'window' | 'page'
  onIntentComplete?: (intent: AiIntent) => void
}) {
  /**
   * **本 store 的宿主身份**（'panel' | 'window' | 'page'）。
   *
   * 会话记忆按宿主分槽（见 `main/ui-state.cjs#sessionIdByHost`）：三种宿主可以各自
   * 停在不同对话上互不干扰；换宿主（拆窗 / 停靠）时会话由 `serialize/restore` 带着走。
   * 模型 / 推理 / 审批仍然三宿主共用一份 —— 那是用户偏好，不是"这块界面在看什么"。
   */
  const HOST = host === 'window' || host === 'page' ? host : 'panel'
  // ── 状态（视图只读；只有本文件的动作能写） ──────────────────────────
  const state: AiUiState = {
    ready: false,
    /** null = 可用；否则是「引擎不可用」的说明。 */
    unavailable: null,
    sessionId: null,
    session: null,
    sessions: [],
    providers: [],
    skills: [],
    /** 技能类型清单（内置 + 扩展点 `ai.skill.kind` 的实现），`[{kind,label,icon,external}]`。 */
    skillKinds: [],
    /** 已落库的投影（按 seq 递增）。 */
    messages: [],
    lastSeq: 0,
    /** 正在跑的回合：sessionId → turnId。 */
    running: new Map<string, string>(),
    /**
     * 还没落库的那一段：`{ turnId, parts[], orphan, done }`。
     * part = `{ type:'text', key, text }` 或 `{ type:'tool', key, id, name, args, result, status }`
     */
    streaming: null,
    approvals: [],
    pendingUser: null,
    error: null,
    modelChoice: null,
    /** 推理等级 `auto|low|medium|high`（模型不支持时恒为 auto）。 */
    reasoning: 'auto',
    /** 网页内容审批模式 `allow|ask`（与其它宿主共用，见文件头）。 */
    approvalMode: 'ask',
    chips: [],
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }
  }

  // ── 通知（rAF 合批） ────────────────────────────────────────────────
  const listeners = new Set<(state: AiUiState) => void>()
  let scheduled: number | TimerHandle = 0
  const win = doc.defaultView

  function flushListeners(): void {
    scheduled = 0
    const snapshot = state
    for (const fn of [...listeners]) {
      try { fn(snapshot) } catch (e) { console.error('[ai-panel] 视图更新失败：', e) }
    }
  }

  function notify(): void {
    if (!listeners.size || scheduled) return
    if (win && typeof win.requestAnimationFrame === 'function') {
      scheduled = win.requestAnimationFrame(flushListeners)
    } else {
      scheduled = setTimeout(flushListeners, 16)
    }
  }

  /**
   * 订阅状态变化。**立即回调一次**（视图首帧不用等下一个事件）。
   * @param {(state: any) => void} fn
   * @returns {() => void}
   */
  function subscribe(fn: (state: AiUiState) => void): () => void {
    listeners.add(fn)
    try { fn(state) } catch (e) { console.error('[ai-panel] 视图首帧失败：', e) }
    return () => { listeners.delete(fn) }
  }

  // ── 事件订阅句柄（dispose 时逐个退订） ──────────────────────────────
  const unsubscribers: Array<() => void> = []
  let subscribed = false

  // ── 读取小工具 ──────────────────────────────────────────────────────
  function isRunning(sessionId: string | null = state.sessionId): boolean {
    return !!(sessionId && state.running.has(sessionId))
  }

  function modelOptions(): AiModelOption[] {
    const out: AiModelOption[] = []
    for (const p of state.providers) {
      if (!p || p.enabled === false) continue
      for (const m of p.models || []) {
        if (!m || !m.id) continue
        out.push({
          key: `${p.id}:${m.id}`,
          providerId: p.id,
          modelId: m.id,
          label: m.label || m.id,
          providerLabel: p.label || p.id,
          // 模型目录里的推理档位（`none` = 端点不支持；空 = 未标注，按支持处理）
          reasoning: m.reasoning || ''
        })
      }
    }
    return out
  }

  function ensureModelChoice(): void {
    const options = modelOptions()
    const keys = new Set(options.map((o) => o.key))
    if (!state.modelChoice || !keys.has(state.modelChoice)) {
      const s = state.session
      const bound = s && s.providerId && s.modelId ? `${s.providerId}:${s.modelId}` : ''
      state.modelChoice = bound && keys.has(bound) ? bound : (options[0] ? options[0].key : null)
    }
    ensureReasoning()
  }

  function currentModel(): AiModelOption | null {
    const key = state.modelChoice
    return key ? modelOptions().find((o) => o.key === key) || null : null
  }

  /**
   * 可选的推理档位，**从左到右按"思考强度"递增**：低 → 中 → 高 → 自动。
   *
   * 「自动」排在**最右（最高档）**：语义是"由服务端按任务决定，必要时给到最深"，
   * 所以它是强度轴的顶端而不是中间的一档。模型目录里的 `reasoning` 表示
   * **端点最高支持到哪一档**；`none` = 不支持 → 空数组（输入区不出现按钮）。
   */
  function reasoningOptions(): AiReasoningOption[] {
    const model = currentModel()
    const cap = model ? model.reasoning : ''
    if (cap === 'none') return []
    const allowed: ReasoningLevel[] = cap === 'low' ? ['low', 'auto']
      : cap === 'medium' ? ['low', 'medium', 'auto']
        : ['low', 'medium', 'high', 'auto']
    return allowed.map((value) => ({ value, label: REASONING_LABEL[value] }))
  }

  /** 换模型后档位可能越界（例如从 high 切到只支持 low 的模型）。 */
  function ensureReasoning(): void {
    const levels = reasoningOptions().map((o) => o.value)
    if (!levels.includes(state.reasoning as ReasoningLevel)) state.reasoning = 'auto'
  }

  // ── 跨宿主共享状态（窗口 / 面板 / 内部页同一份） ───────────────────
  const hasOwn = (obj: unknown, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(obj, key)

  /** 上报一次变更。失败静默：宿主离线不该影响本地操作。 */
  function pushShared(patch: Record<string, unknown>): void {
    try {
      const call = ai.uiState && typeof ai.uiState.set === 'function' ? ai.uiState.set(patch) : null
      if (call && typeof call.catch === 'function') call.catch(() => {})
    } catch (_) {}
  }

  /**
   * 对齐主进程广播的共享状态。**只对齐、不回写** ——
   * 回写会让「A 广播 → B 对齐 → B 再上报」形成回声。
   * @returns {boolean} 是否有字段真的变了（变了才需要重画）
   */
  function alignShared(next: unknown): boolean {
    if (!next || typeof next !== 'object') return false
    const shared = next as Record<string, unknown>
    let dirty = false
    if (hasOwn(shared, 'modelChoice')) {
      const value = shared.modelChoice ? String(shared.modelChoice) : null
      if (state.modelChoice !== value) { state.modelChoice = value; dirty = true }
    }
    if (hasOwn(shared, 'reasoning')) {
      const value = String(shared.reasoning || 'auto')
      if (state.reasoning !== value) { state.reasoning = value; dirty = true }
    }
    if (hasOwn(shared, 'approvalMode')) {
      const value: ApprovalMode = shared.approvalMode === 'allow' ? 'allow' : 'ask'
      if (state.approvalMode !== value) {
        state.approvalMode = value
        // 切到允许 = 主进程已放行所有非破坏性待决审批（`approvals.allowPending`）。
        // 本宿主的卡只是那次等待的镜像，这里一并收掉，避免留下点不动的僵尸卡。
        if (value === 'allow' && state.approvals.length) state.approvals = []
        dirty = true
      }
    }
    return dirty
  }

  /** `ai:ui-state-changed` 的入口：模型/档位/审批对齐 + **本宿主槽位**的会话跟随。 */
  function handleUiState(payload: unknown): void {
    const wrapper = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    const next = wrapper?.uiState || wrapper
    if (!next || typeof next !== 'object') return
    if (alignShared(next)) { ensureModelChoice(); notify() }
    // 只跟自己的那一格：别的宿主切会话不该把这边拽走（这正是三宿主独立对话的前提）。
    const slots = (next as Record<string, unknown>).sessionIdByHost
    if (slots && typeof slots === 'object') {
      const hostSlots = slots as Record<string, unknown>
      const id = hostSlots[HOST] ? String(hostSlots[HOST]) : null
      if (id !== state.sessionId) switchSessionLocal(id)
    }
  }

  // ── 会话 ────────────────────────────────────────────────────────────
  function syncSession(): void {
    if (!state.sessionId) { state.session = null; return }
    state.session = state.sessions.find((s) => s.id === state.sessionId) ||
      (state.session && state.session.id === state.sessionId ? state.session : null)
  }

  let sessionsRefreshSerial = 0
  const forgottenSessionIds = new Set<string>()
  async function refreshSessions(): Promise<void> {
    const serial = ++sessionsRefreshSerial
    try {
      const res = await ai.sessions.list({ limit: 50 })
      if (serial !== sessionsRefreshSerial) return
      const list = (Array.isArray(res.sessions) ? res.sessions.slice() : [])
        .filter((session) => !forgottenSessionIds.has(String(session.id || '')))
      const currentId = state.sessionId
      if (currentId && !forgottenSessionIds.has(currentId) && !list.some((session) => session.id === currentId)) {
        const current = state.session && state.session.id === currentId ? state.session : null
        if (current) list.push(current)
      }
      list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(b.id).localeCompare(String(a.id)))
      state.sessions = list
      syncSession()
    } catch (_) { /* 引擎不可用时保持旧列表 */ }
  }

  /**
   * 本地切会话（不碰共享状态）。
   * 供「别处已经切了，我跟随」与「引擎广播 created/deleted」使用 ——
   * 那两种场景真源已经改过，再上报就是回声。
   */
  let sessionSwitchSerial = 0

  async function applySessionSwitch(sessionId: string | null, serial: number): Promise<boolean> {
    const id = sessionId ? String(sessionId) : null
    if (id === state.sessionId && (state.messages.length || !id)) return true
    const changed = id !== state.sessionId
    state.sessionId = id
    syncSession()
    state.messages = []
    state.lastSeq = 0
    state.streaming = null
    state.error = null
    state.pendingUser = null
    // 引用项属于具体上下文。换对话时继续携带会把上一段对话的页面/文件悄悄串进来。
    if (changed) state.chips = []
    ensureModelChoice()
    notify()
    if (!id) return serial === sessionSwitchSerial
    try {
      const snap = await ai.state({ host: HOST, sessionId: id, consumePending: false, select: false })
      if (serial !== sessionSwitchSerial || state.sessionId !== id) return false
      const resolvedId = snap.sessionId ? String(snap.sessionId) : null
      if (resolvedId !== id || !snap.session) {
        // 目标会话刚好被删除 / 被其它窗口清理：采用主进程给出的安全回退，
        // 绝不把旧会话正文挂在新的 sessionId 下。
        state.sessionId = resolvedId
        state.sessions = snap.sessions ?? state.sessions
        state.session = snap.session ?? null
        state.messages = snap.messages ?? []
        state.lastSeq = Number(snap && snap.lastSeq) || 0
        state.running = new Map((snap.running ?? []).map((run) => [run.sessionId, run.turnId]))
        state.approvals = Array.isArray(snap.approvals) ? snap.approvals : state.approvals
        syncSession()
        notify()
        return false
      }
      state.sessions = snap.sessions ?? state.sessions
      state.session = snap.session ?? null
      state.messages = snap.messages ?? []
      state.lastSeq = Number(snap && snap.lastSeq) || 0
      state.running = new Map((snap.running ?? []).map((run) => [run.sessionId, run.turnId]))
      state.approvals = Array.isArray(snap.approvals) ? snap.approvals : state.approvals
      alignShared(snap.uiState)
      // 切进来时回合还在跑：先立一个占位，等 `turn-end` 补齐（否则界面像死了）
      if (state.running.has(id) && !state.streaming) {
        state.streaming = { turnId: state.running.get(id) ?? null, parts: [], orphan: true, done: false }
      }
      syncSession()
    } catch (e) {
      if (serial === sessionSwitchSerial && state.sessionId === id) state.error = errorPayload(e)
    }
    if (serial === sessionSwitchSerial) notify()
    return serial === sessionSwitchSerial && state.sessionId === id
  }

  async function switchSessionLocal(sessionId: string | null): Promise<boolean> {
    return applySessionSwitch(sessionId, ++sessionSwitchSerial)
  }

  /** 用户主动切会话：本地切完把选择写进**本宿主**那一格（其它宿主不受影响）。 */
  async function switchSession(sessionId: string | null): Promise<void> {
    const serial = ++sessionSwitchSerial
    const applied = await applySessionSwitch(sessionId, serial)
    // 快速连续切 A→B 时，A 的慢请求不能在上报时把宿主槽位改回 A。
    if (applied && serial === sessionSwitchSerial) {
      pushShared({ host: HOST, sessionId: state.sessionId })
    }
  }

  async function ensureSession(): Promise<string | null> {
    if (state.sessionId) return state.sessionId
    if (state.sessions.length) {
      await switchSession(state.sessions[0].id)
      return state.sessionId
    }
    const res = await ai.sessions.create('', HOST)
    const session = res && res.session
    if (!session) throw new Error('无法创建会话')
    state.sessions = [session, ...state.sessions]
    await switchSession(session.id)
    return state.sessionId
  }

  /**
   * 在**当前宿主**新建会话并切过去。
   *
   * 返回新会话 id 是关键：所有外部提问入口（深链 / 右键意图 / 快捷入口）都要在
   * 同一个原子动作里"建新会话 → 发送"，不能依赖随后读取 state 猜测是否切成功。
   */
  async function newSession(): Promise<string | null> {
    try {
      const res = await ai.sessions.create('', HOST)
      const session = res && res.session
      if (!session || !session.id) {
        setError({ message: '无法创建 AI 会话', code: 'AI_NO_SESSION' })
        return null
      }
      if (!state.sessions.some((s) => s.id === session.id)) state.sessions = [session, ...state.sessions]
      await switchSession(session.id)
      return state.sessionId === session.id ? session.id : null
    } catch (e) {
      setError(e)
      return null
    }
  }

  /**
   * 一个**新的**对话 + 第一条消息。
   *
   * 深链 ?ask= 与所有"替用户发起提问"的入口都只走这一条；不要在调用点各写一遍
   * newSession().then(send)，否则并发点击会串到上一条会话，正是本次修复的根因。
   */
  async function askNew(text: unknown): Promise<AiSendResult> {
    const value = String(text == null ? '' : text).trim()
    if (!value) return { ok: false, reason: 'empty' }
    const sessionId = await newSession()
    if (!sessionId) return { ok: false, reason: 'no-session', error: state.error }
    return send({ text: value })
  }

  async function renameSession(sessionId: string, title: unknown): Promise<void> {
    const clean = String(title || '').trim()
    if (!sessionId || !clean) return
    try {
      const res = await ai.sessions.rename(sessionId, clean)
      const session = res && res.session
      const item = state.sessions.find((s) => s.id === sessionId)
      if (item) item.title = (session && session.title) || clean
      if (state.session && state.session.id === sessionId) state.session.title = (session && session.title) || clean
      notify()
    } catch (e) { setError(e) }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    if (!sessionId) return
    try {
      await ai.sessions.remove(sessionId)
      forgottenSessionIds.add(sessionId)
      state.sessions = state.sessions.filter((s) => s.id !== sessionId)
      if (state.sessionId === sessionId) {
        await switchSession(state.sessions[0] ? state.sessions[0].id : null)
      } else {
        notify()
      }
    } catch (e) { setError(e) }
  }

  // ── 消息 / 流式 ─────────────────────────────────────────────────────
  function mergeMessages(list: unknown): boolean {
    let added = false
    /** 本次并入的最新一条用户消息 seq（决定乐观气泡什么时候退场）。 */
    let landedUserSeq = 0
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw !== 'object') continue
      const m = raw as AiMessage
      if (!m || typeof m.seq !== 'number' || m.seq <= state.lastSeq) continue
      state.messages.push(m)
      state.lastSeq = m.seq
      added = true
      if (m.role === 'user' && m.seq > landedUserSeq) landedUserSeq = m.seq
    }
    if (state.messages.length > 1600) state.messages.splice(0, state.messages.length - 1600)
    // 乐观气泡只做一件事：**发送那一刻就上屏**。权威投影里出现了这次发送的用户消息，
    // 它就退场（否则会和投影里的同一条并排出现）。
    // 注意：不能用"回合开始"当退场信号 —— 用户消息要等 settle 才并进 messages，
    // 那样的结果就是"AI 输出完，气泡才出现"。
    const pending = state.pendingUser
    if (pending && landedUserSeq > (Number(pending.sinceSeq) || 0)) state.pendingUser = null
    return added
  }

  let partSeq = 0
  const nextKey = () => `p${++partSeq}`

  let settleSerial = 0

  /**
   * 把流式片段提交成权威投影。
   * @param {{ clear?: boolean }} [opts] clear=true 表示这是回合终点（连同 streaming 一起收掉）
   */
  async function settle(opts: { clear?: boolean } = {}): Promise<void> {
    const shown = state.streaming
    const sessionId = state.sessionId
    if (!shown || !sessionId) return
    const serial = ++settleSerial
    const cut = shown.parts.length
    const after = state.lastSeq
    let res
    try {
      res = await ai.messages(sessionId, { after, limit: 400 })
    } catch (_) {
      // 拉不到就留着流式片段 —— 宁可重复显示，也不要凭空消失
      return
    }
    if (state.sessionId !== sessionId) return
    mergeMessages(res && res.messages)
    if (res && typeof res.lastSeq === 'number' && res.lastSeq > state.lastSeq) state.lastSeq = res.lastSeq

    // 只有**最后一次** settle 能裁剪：并发时旧请求晚回不该动新片段
    if (state.streaming === shown && serial === settleSerial) {
      // 只裁"请求发出前"就在的片段：请求期间新到的下一段仍留在界面上
      if (cut > 0) shown.parts.splice(0, Math.min(cut, shown.parts.length))
      // 回合结束且没有新片段留下：投影已包含全部内容，流式层收掉
      if (opts.clear && !shown.parts.length) state.streaming = null
      // 乐观气泡（含 steer 追加的那一条）此刻一定已经落库
      if (opts.clear) state.pendingUser = null
    }
    notify()
  }

  /**
   * 一条流式帧归并进 `state.streaming`。
   * @param {any} payload
   */
  function handleStream(payload: unknown) {
    if (!payload || typeof payload !== 'object') return
    const event = payload as AiStreamEvent
    if (event.sessionId !== state.sessionId) return
    const frame = event.frame

    if (frame === 'start') {
      // 不在这里清 pendingUser：用户消息还没进投影（要等 settle），
      // 清了就等于把用户刚发出的气泡藏到回合结束。退场由 mergeMessages 负责。
      state.error = null
      state.running.set(event.sessionId, event.turnId || '')
      state.streaming = { turnId: event.turnId || null, parts: [], orphan: false, done: false }
      notify()
      return
    }

    if (frame === 'error') {
      state.error = {
        message: String(event.message || '执行失败'),
        code: String(event.code || ''),
        retryable: !!event.retryable
      }
      notify()
      return
    }

    // 没有 start（面板半路挂载/切换会话）也要能接住后续帧
    if (!state.streaming) {
      state.streaming = { turnId: event.turnId || null, parts: [], orphan: true, done: false }
    }
    const st = state.streaming

    if (frame === 'chunk') {
      applyDelta(st, event.delta)
      return
    }

    if (frame === 'end') {
      state.running.delete(event.sessionId)
      st.done = true
      const u = event.usage
      if (u) {
        state.usage = {
          promptTokens: Number(u.promptTokens) || 0,
          completionTokens: Number(u.completionTokens) || 0,
          cachedTokens: Number(u.cachedTokens) || 0
        }
      }
      // 「为什么停了」必须可见：截断与步数上限都是**正常收尾**（不重试），
      // 但不提示的话界面上就是"说到一半没了"，看着像挂了。
      const notice = stopNotice(event.stopReason)
      if (notice) state.error = notice
      notify()
      settle({ clear: true })
    }
  }

  function applyDelta(st: AiStreaming, delta: AiStreamDelta | undefined) {
    if (!delta || !delta.type) return

    if (delta.type === 'text') {
      if (!delta.text) return
      const last = st.parts[st.parts.length - 1]
      if (last && last.type === 'text') last.text += delta.text
      else st.parts.push({ type: 'text', key: nextKey(), text: delta.text })
      notify()
      return
    }

    if (delta.type === 'reasoning') {
      if (!delta.text) return
      const last = st.parts[st.parts.length - 1]
      if (last && last.type === 'reasoning') last.text += delta.text
      else st.parts.push({ type: 'reasoning', key: nextKey(), text: delta.text })
      notify()
      return
    }

    if (delta.type === 'sources') {
      const items = Array.isArray(delta.items) ? delta.items : []
      if (!items.length) return
      // 来源挂在本回合的 streaming 上（不再进 parts）：它属于"这次回答参考了什么"，
      // 而不是正文里的一个段落；同 url 去重，工具多次命中同一页只留一条。
      const bucket = Array.isArray(st.sources) ? st.sources : (st.sources = [])
      const seen = new Set(bucket.map((s) => s.url))
      let changed = false
      for (const raw of items) {
        const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
        const url = String(source?.url || '').trim()
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
        seen.add(url)
        bucket.push({
          title: String(source?.title || url),
          url,
          kind: String(source?.kind || 'page')
        })
        changed = true
      }
      if (changed) notify()
      return
    }

    if (delta.type === 'tool-call') {
      const id = delta.id || nextKey()
      const existing = st.parts.find((part) => part.type === 'tool' && part.id === id)
      if (existing) {
        existing.name = delta.name || existing.name
        existing.args = delta.args !== undefined ? delta.args : existing.args
        if (existing.status !== 'ok' && existing.status !== 'error') existing.status = 'running'
        return
      }
      st.parts.push({
        type: 'tool',
        key: nextKey(),
        id,
        name: delta.name || 'tool',
        args: delta.args,
        status: 'running'
      })
      notify()
      return
    }

    if (delta.type === 'tool-result') {
      const id = delta.id || ''
      let card = st.parts.find((p) => p.type === 'tool' && p.id === id)
      if (!card) {
        card = { type: 'tool', key: nextKey(), id, name: delta.name || 'tool', args: null, status: 'running' }
        st.parts.push(card)
      }
      card.result = delta.result
      card.isError = !!delta.isError
      card.status = delta.isError ? 'error' : 'ok'
      if (!card.name || card.name === 'tool') card.name = delta.name || card.name
      notify()
      return
    }

    if (delta.type === 'usage') {
      state.usage = {
        promptTokens: Number(delta.promptTokens) || 0,
        completionTokens: Number(delta.completionTokens) || 0,
        cachedTokens: Number(delta.cachedTokens) || 0
      }
      // 一步的文本已落库：提交并裁掉这一步的流式片段（工具卡随后重新流入）
      notify()
      settle()
    }
  }

  // ── 审批 ────────────────────────────────────────────────────────────
  function handleApproval(payload: AiApproval): void {
    if (!payload || !payload.approvalId) return
    if (state.approvals.some((a) => a.approvalId === payload.approvalId)) return
    state.approvals.push(payload)
    notify()
  }

  async function resolveApproval(approvalId: string, decision: ApprovalDecision, remember: boolean = false): Promise<void> {
    const item = state.approvals.find((a) => a.approvalId === approvalId)
    state.approvals = state.approvals.filter((a) => a.approvalId !== approvalId)
    notify()
    try {
      await ai.approval({
        sessionId: (item && item.sessionId) || state.sessionId,
        approvalId,
        decision,
        ...(remember ? { remember: true } : {})
      })
    } catch (e) { setError(e) }
  }

  /**
   * 「始终允许」= 记住这个工具在当前站点的授权 + 放行当前这一条。
   *
   * 它**不会**顺带打开全局允许模式：用户只授权了一个动作，不能因此让后续所有
   * 非破坏性工具都静默放行。需要全局免问时应由输入栏的独立开关明确开启。
   */
  async function allowAlways(approvalId: string): Promise<void> {
    await resolveApproval(approvalId, 'allow', true)
  }

  // ── 状态变化（引擎广播） ────────────────────────────────────────────
  async function handleStateChanged(payload: Record<string, unknown>): Promise<void> {
    const reason = String(payload.reason || '')
    if (!reason) return
    const changedSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const changedHost = typeof payload.host === 'string' ? payload.host : ''
    const changedTitle = typeof payload.title === 'string' ? payload.title : ''

    if (reason === 'providers') {
      await refreshProviders()
    } else if (reason === 'skills') {
      await refreshSkills()
    } else if (reason === 'created') {
      await refreshSessions()
      // 只跟**自己**新建的会话；别处开的新会话只是列表多一条，不拽走当前对话。
      if (changedHost === HOST && changedSessionId && changedSessionId !== state.sessionId) {
        await switchSessionLocal(changedSessionId)
      }
    } else if (reason === 'renamed' || reason === 'title') {
      const id = changedSessionId
      if (id) {
        const item = state.sessions.find((s) => s.id === id)
        if (item && changedTitle) item.title = changedTitle
        if (state.session && state.session.id === id && changedTitle) state.session.title = changedTitle
      }
      // 标题/时间变了，列表顺序也可能变
      refreshSessions().then(notify)
    } else if (reason === 'deleted') {
      if (changedSessionId) forgottenSessionIds.add(changedSessionId)
      if (changedSessionId === state.sessionId) state.session = null
      const wasCurrent = changedSessionId === state.sessionId
      await refreshSessions()
      // 引擎删除时已把共享状态指向下一条 —— 本地跟随即可
      if (wasCurrent) await switchSessionLocal(state.sessions[0] ? state.sessions[0].id : null)
    } else if (reason === 'turn-end') {
      if (changedSessionId) state.running.delete(changedSessionId)
      if (changedSessionId === state.sessionId) {
        state.approvals = state.approvals.filter((a) => a.sessionId !== changedSessionId)
        await settle({ clear: true })
        // 回合结束后同步一次会话标题/排序
        refreshSessions().then(notify)
      }
    } else if (reason === 'purged') {
      await init({ consumePending: false })
    }
    notify()
  }

  // ── 上下文 chip ─────────────────────────────────────────────────────
  let chipSeq = 0

  function normalizeChip(raw: unknown): AiContextItem | null {
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const meta = record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {}
    const payload = record.payload && typeof record.payload === 'object'
      ? { ...(record.payload as Record<string, unknown>) }
      : record.payload
    const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    return {
      kind: String(record.kind || 'text'),
      payload,
      title: String(record.title || meta.title || payloadRecord.title || ''),
      url: String(record.url || meta.url || payloadRecord.url || ''),
      favicon: String(record.favicon || ''),
      // 主进程采集时算好的 token 粗估（摘要条用；渲染层拿不到页面正文，无从重算）
      tokens: Number(record.tokens) || 0,
      // 页面/选区/文件一律按不可信内容处理（§9.4）；截图是用户主动给的，不算
      untrusted: record.untrusted !== undefined ? !!record.untrusted : String(record.kind) !== 'screenshot'
    }
  }

  function chipSignature(item: AiContextItem): string {
    if (item.kind === 'screenshot') return ''
    const payload = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : {}
    const text = payload.text || payload.url || payload.path || payload.workspaceId
    return `${item.kind}|${item.url || ''}|${String(text || '').slice(0, 64)}`
  }

  function addChip(raw: unknown): void {
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    if (!record || !record.kind) return
    const item = normalizeChip(raw)
    if (!item) return
    const payload = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : {}

    // 意图里的截图只有「去抓一张」的提示：真正采集在面板侧完成（要落到附件目录）
    if (item.kind === 'screenshot' && payload.hint && !payload.path) {
      captureInto('screenshot', { title: item.title })
      return
    }
    if (state.chips.length >= 20) return

    const sig = chipSignature(item)
    if (sig && state.chips.some((c) => chipSignature(c) === sig)) return

    item.key = `c${++chipSeq}`
    state.chips.push(item)
    notify()
  }

  function removeChip(key: string): void {
    const removing = state.chips.find((c) => c.key === key)
    const next = state.chips.filter((c) => c.key !== key)
    if (next.length === state.chips.length) return
    state.chips = next
    notify()
    if (removing && removing.kind === 'workspace' && state.sessionId) {
      void ai.capture('workspace', { sessionId: state.sessionId, clear: true }).catch(() => {})
    }
  }

  function clearChips(): void {
    if (!state.chips.length) return
    state.chips = []
    notify()
  }

  function chipToContext(item: AiContextItem): Record<string, unknown> {
    return {
      kind: item.kind,
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
      ...(item.title ? { title: item.title } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.favicon ? { favicon: item.favicon } : {}),
      ...(item.untrusted ? { untrusted: true } : {})
    }
  }

  /**
   * 采集一项上下文并挂到输入区。
   * `opts.silent` = 失败不弹错误条（技能调用方只是"顺带补个引用"，缺了就缺了）。
   * @returns {Promise<any|null>} 成功返回 `{kind,payload,title,url}`，失败返回 null
   */
  async function captureInto(kind: string, payload: unknown, opts: { silent?: boolean } = {}): Promise<AiContextItem | null> {
    try {
      if (kind === 'workspace' && !state.sessionId) await ensureSession()
      const res = await ai.capture(kind, { ...(payload || {}), sessionId: state.sessionId || 'draft' })
      if (res && res.ok && res.item) {
        if (res.item.kind === 'workspace') state.chips = state.chips.filter((item) => item.kind !== 'workspace')
        addChip(res.item)
        return res.item
      }
      if (res && res.code === 'AI_WORKSPACE_CANCELED') return null
      if (res && res.ok === false && !opts.silent) setError({ message: res.message || '采集失败' })
    } catch (e) { if (!opts.silent) setError(e) }
    return null
  }

  /**
   * 拉一批来源候选（`@` 面板的子列表）。**不写状态** —— 候选只活在输入区浮层里，
   * 放进全局状态反而会让"面板重渲染"去重画一份一次性的列表。
   * 失败时返回空数组：浮层自己显示"没有匹配项"。
   * @param {'tab'|'closed-tab'|'bookmark'|'history'} kind
   */
  async function fetchCandidates(kind: 'tab'|'closed-tab'|'bookmark'|'history', query: string = ''): Promise<unknown[]> {
    try {
      const res = await ai.candidates(kind, query)
      if (res && res.ok && Array.isArray(res.items)) return res.items
    } catch (_) { /* 引擎不可用 → 空列表 */ }
    return []
  }

  /** 引用回跳（chip 点击）：已开就切过去，没开就新标签。 */
  async function revealSource(url: unknown): Promise<AiActionResult> {
    const target = String(url || '')
    if (!target) return { ok: false }
    try {
      return await ai.reveal(target)
    } catch (e) { setError(e); return { ok: false } }
  }

  // ── 发送 / 停止 ─────────────────────────────────────────────────────
  function setError(err: unknown): void {
    state.error = errorPayload(err)
    notify()
  }

  function dismissError(): void {
    if (!state.error) return
    state.error = null
    notify()
  }

  /**
   * 发一条消息。`text` 为空但带 chip 时补一句默认 prompt（契约要求 text/blocks 至少一个）。
   * 回合进行中再发 = 追加一句（steer），不新开回合。
   * @param {{ text?: string }} [opts]
   */
  async function send(opts: { text?: string } = {}): Promise<AiSendResult> {
    const text = String(opts.text == null ? '' : opts.text).trim()
    const chips = state.chips.slice()
    if (!text && !chips.length) return { ok: false, reason: 'empty' }
    if (isRunning()) return steer({ text, chips })

    const body = text || DEFAULT_PROMPT
    let sessionId
    try {
      sessionId = await ensureSession()
    } catch (e) {
      setError(e)
      return { ok: false, reason: 'no-session' }
    }
    if (!sessionId) return { ok: false, reason: 'no-session' }

    state.error = null
    // 乐观气泡：发送这一刻就上屏，`sinceSeq` 用来判断"投影里已经出现这一条了吗"。
    state.pendingUser = { text: body, chips, sinceSeq: state.lastSeq }
    if (chips.length) state.chips = []
    const localTurn = { turnId: null, parts: [], orphan: true, done: false }
    state.streaming = localTurn
    notify()

    try {
      await ai.send(turnPayload(sessionId, {
        text: body,
        ...(chips.length ? { context: chips.map(chipToContext) } : {})
      }))
      return { ok: true, sessionId }
    } catch (e) {
      // 没发出去：把内容和 chip 还给输入区（否则用户白打一段字）
      state.streaming = null
      state.pendingUser = null
      if (chips.length) state.chips = [...chips, ...state.chips]
      setError(e)
      return { ok: false, reason: 'failed', error: state.error }
    }
  }

  /** 回合体（send / steer / retry 共用一份，避免三处各写一遍慢慢漂移）。 */
  function turnPayload(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId,
      // 谁在说话：主进程据此只更新**本宿主**那一格会话（见 main/ui-state.cjs）。
      host: HOST,
      ...extra,
      ...(state.modelChoice ? { model: state.modelChoice } : {}),
      reasoning: state.reasoning,
      approvalMode: state.approvalMode
    }
  }

  /** 回合进行中追加一句。失败时把文字与 chip 还给输入区。 */
  async function steer({ text, chips }: { text?: string; chips?: AiContextItem[] }): Promise<AiSendResult> {
    const sessionId = state.sessionId
    const list = Array.isArray(chips) ? chips : []
    const body = String(text || '') || (list.length ? DEFAULT_PROMPT : '')
    if (!body) return { ok: false, reason: 'empty' }
    if (!sessionId) return { ok: false, reason: 'no-session' }

    const prevChips = state.chips.slice()
    state.chips = []
    state.pendingUser = { text: body, chips: list, steering: true, sinceSeq: state.lastSeq }
    notify()

    try {
      const res = await ai.steer(turnPayload(sessionId, {
        text: body,
        ...(list.length ? { context: list.map(chipToContext) } : {})
      }))
      if (res && res.ok === false) {
        state.pendingUser = null
        state.chips = prevChips
        // 回合恰好刚结束：退回一次正常发送，别让用户再按一遍回车
        if (res.code === 'AI_NOT_RUNNING') return send({ text: body })
        setError({ message: res.message || '追加失败', code: res.code || '' })
        return { ok: false, reason: res.code || 'failed' }
      }
      return { ok: true, sessionId, steered: true }
    } catch (e) {
      state.pendingUser = null
      state.chips = prevChips
      setError(e)
      return { ok: false, reason: 'failed', error: state.error }
    }
  }

  /** 整段重拉投影（会话切换 / 重试前清掉旧输出）。 */
  async function reloadMessages(sessionId: string | null = state.sessionId): Promise<void> {
    if (!sessionId) return
    try {
      const res = await ai.messages(sessionId, { limit: HISTORY_LIMIT })
      if (state.sessionId !== sessionId) return
      state.messages = res.messages ?? []
      state.lastSeq = Number(res && res.lastSeq) || 0
    } catch (_) {}
  }

  /**
   * 重生成：复用最后一条用户消息重跑。
   * 投影会作废上一次尝试的输出，所以先整段重拉 —— 否则旧气泡留在屏幕上，
   * 新内容在它后面再接一段，看起来就像"重试没生效"。
   */
  async function retry(): Promise<AiSendResult> {
    const sessionId = state.sessionId
    if (!sessionId) return { ok: false, reason: 'no-session' }
    if (isRunning()) return { ok: false, reason: 'busy' }

    state.error = null
    state.pendingUser = null
    await reloadMessages(sessionId)
    state.streaming = { turnId: null, parts: [], orphan: true, done: false }
    notify()

    try {
      const res = await ai.retry(turnPayload(sessionId))
      if (res && res.ok === false) {
        state.streaming = null
        setError({ message: res.message || '重试失败', code: res.code || '' })
        return { ok: false, reason: res.code || 'failed' }
      }
      return { ok: true, sessionId }
    } catch (e) {
      state.streaming = null
      setError(e)
      return { ok: false, reason: 'failed', error: state.error }
    }
  }

  async function stop(): Promise<void> {
    if (!state.sessionId || !isRunning()) return
    try {
      await ai.stop(state.sessionId)
    } catch (e) { setError(e) }
  }

  // ── 模型 ────────────────────────────────────────────────────────────
  async function refreshProviders(): Promise<void> {
    try {
      const res = await ai.providers.list()
      state.providers = res.providers ?? []
      ensureModelChoice()
    } catch (_) {}
  }

  async function refreshSkills(): Promise<void> {
    try {
      const res = await ai.skills.list()
      // 面板的 `/` 菜单只列「启用中」的技能：停用是管理页的概念，
      // 在输入区露出来只会让人误以为它还能用（引擎 state() 也是同一口径）。
      const list = res.skills ?? []
      state.skills = list.filter((s) => s && s.enabled !== false)
      state.skillKinds = res.kinds ?? res.skillKinds ?? []
    } catch (_) {}
  }


  /** 技能类型的显示元数据（找不到就回落第一个内置；列表永远不空）。 */
  function skillKindMeta(kind: unknown): { icon: string; tone: string; label: string } {
    const key = String(kind || '')
    const list = state.skillKinds
    const hit = list.find((k) => k && k.kind === key)
    const meta = hit || list[0] || { kind: 'prompt', label: '提示词', icon: 'Zap', tone: 'accent' }
    return {
      icon: meta.icon || 'Zap',
      tone: meta.tone || 'accent',
      label: meta.label || '提示词'
    }
  }

  /**
   * 跑一条技能（`/` 选中调用）。
   * 只负责"要一份结果"，怎么用（插模板 / 回填 chip / 直接发）由调用方决定。
   * @returns {Promise<any>} 成功 `{ok:true, kind, text, needs, params, autoSend}`；失败 `{ok:false}`
   */
  async function runSkill({ id, silent }: { id?: string; silent?: boolean } = {}): Promise<AiActionResult> {
    if (!id) return { ok: false }
    try {
      const res = await ai.skills.run({ id: String(id) })
      if (res && res.ok === false && !silent) setError({ message: res.message || '技能执行失败', code: res.code || '' })
      return res || { ok: false }
    } catch (e) {
      if (!silent) setError(e)
      return { ok: false }
    }
  }

  /** 用户换模型：本地乐观更新，再共享出去（其余宿主对齐）。 */
  function chooseModel(key: string | null): void {
    state.modelChoice = key || null
    ensureModelChoice()
    notify()
    if (state.modelChoice) pushShared({ modelChoice: state.modelChoice })
  }

  function chooseReasoning(level: ReasoningLevel): void {
    const value = String(level || 'auto')
    if (!reasoningOptions().some((o) => o.value === value)) return
    if (state.reasoning === value) return
    state.reasoning = value
    notify()
    pushShared({ reasoning: value })
  }

  // ── 网页内容审批模式（允许 / 询问） ─────────────────────────────────
  /**
   * 两态控件的数据源（顺序固定：允许在前 —— 它是"少一次打扰"的那一档）。
   * 与推理档位不同，这里**不依赖模型**，任何时候都可用。
   */
  function approvalOptions(): Array<{ value: ApprovalMode; label: string; hint: string }> {
    return (['allow', 'ask'] as ApprovalMode[]).map((value) => ({
      value,
      label: APPROVAL_LABEL[value],
      hint: APPROVAL_HINT[value]
    }))
  }

  function chooseApprovalMode(mode: ApprovalMode): void {
    const value = mode === 'allow' ? 'allow' : 'ask'
    if (state.approvalMode === value) return
    state.approvalMode = value
    notify()
    pushShared({ approvalMode: value })
  }

  // ── 搜索 / 导出 ─────────────────────────────────────────────────────
  /** 会话全文检索（抽屉自己持有结果，store 只负责请求与错误归一）。 */
  async function searchSessions(query: unknown): Promise<unknown> {
    const q = String(query || '').trim()
    if (!q) return { ok: true, sessions: [] }
    try {
      const res = await ai.sessions.search(q, 20)
      return { ok: true, sessions: Array.isArray(res && res.sessions) ? res.sessions : [] }
    } catch (e) {
      setError(e)
      return { ok: false, sessions: [] }
    }
  }

  /** 导出会话（md / json）。用户取消保存框不是错误。 */
  async function exportSession(format: 'md' | 'json' = 'md', sessionId: string | null = state.sessionId): Promise<unknown> {
    if (!sessionId) return { ok: false, reason: 'no-session' }
    try {
      const res = await ai.sessions.export(sessionId, format)
      if (res && res.ok === false && res.code !== 'AI_EXPORT_CANCELED') {
        setError({ message: res.message || '导出失败', code: res.code || '' })
      }
      return res || { ok: false }
    } catch (e) {
      setError(e)
      return { ok: false }
    }
  }

  // ── 意图 ────────────────────────────────────────────────────────────
  /**
   * 一条意图最终落到哪个宿主。
   *
   * panel / window 是同一块面板的两种呈现，可互相接手；page 只处理明确发给 page 的
   * 意图。主进程仍会广播，但每个 store 在写任何状态之前先做这层过滤，避免多个 AI
   * 宿主同时切会话、同一条消息被执行多次。
   */
  function acceptsIntent(intent: AiIntent): boolean {
    const target = String(intent.targetHost || '').trim().toLowerCase()
    if (!target) return true
    const targetIsPage = target === 'page'
    const selfIsPage = HOST === 'page'
    return targetIsPage === selfIsPage
  }

  async function deliverIntent(intent: AiIntent): Promise<void> {
    if (!intent || typeof intent !== 'object' || !acceptsIntent(intent)) return

    // 外部入口默认 newSession=true。只有调用方显式指定有效会话才续写。
    if (intent.newSession === true) {
      const sessionId = await newSession()
      if (!sessionId) return
    } else if (intent.sessionId && intent.sessionId !== state.sessionId) {
      await switchSession(intent.sessionId)
    }

    for (const raw of Array.isArray(intent.items) ? intent.items : []) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      const payload = item && item.payload && typeof item.payload === 'object'
        ? item.payload as Record<string, unknown>
        : null
      if (item?.kind === 'file' && payload?.path && !payload.text) {
        await captureInto('file', { path: payload.path, name: payload.name || item.title })
        continue
      }
      addChip(raw)
    }

    if (intent.autoSend === true) {
      await send({ text: intent.prompt || intent.text || DEFAULT_PROMPT })
    } else if (typeof onIntentComplete === 'function') {
      try { onIntentComplete(intent) } catch (_) {}
    }
    notify()
  }

  /** 意图串行执行：连点右键时不会并发建会话、互相把当前会话切走。 */
  let intentChain: Promise<void> = Promise.resolve()
  function applyIntent(intent: AiIntent): Promise<void> {
    intentChain = intentChain
      .then(() => deliverIntent(intent))
      .catch((e) => {
        // 单条意图失败不能打断后续 pending 意图，也不能把整个面板标成不可用。
        console.error('[ai-panel] 意图执行失败：', e)
        setError(e)
      })
    return intentChain
  }

  // ── 快照 / 刷新 / 释放 ──────────────────────────────────────────────
  function applySnapshot(snap: unknown): void {
    const value = snap && typeof snap === 'object' ? snap as AiSnapshot : {}
    state.ready = true
    state.unavailable = null
    const sessions = (Array.isArray(value.sessions) ? value.sessions.slice() : [])
      .filter((session) => !forgottenSessionIds.has(String(session.id || '')))
    const current = value.session && typeof value.session === 'object' ? value.session : null
    if (current && !sessions.some((session) => session.id === current.id)) sessions.unshift(current)
    state.sessions = sessions
    state.providers = value.providers ?? []
    state.skills = value.skills ?? []
    state.skillKinds = value.skillKinds ?? []
    state.sessionId = value.sessionId ?? null
    state.session = current
    state.messages = value.messages ?? []
    state.lastSeq = Number(value.lastSeq) || 0
    state.running = new Map(
      (value.running ?? []).map((r) => [r.sessionId, r.turnId])
    )
    state.streaming = null
    state.approvals = Array.isArray(value.approvals) ? value.approvals : []
    state.pendingUser = null
    state.error = null
    // 模型 / 推理 / 审批来自共享状态：初始快照就带上，三个宿主天然一致
    alignShared(value.uiState)
    if (state.sessionId && state.running.has(state.sessionId)) {
      state.streaming = { turnId: state.running.get(state.sessionId) ?? null, parts: [], orphan: true, done: false }
    }
    syncSession()
  }

  function subscribeEvents(): void {
    if (subscribed) return
    subscribed = true
    const push = (fn: () => (() => void) | { dispose(): void } | false | null | undefined): void => {
      try {
        const handle = fn()
        if (typeof handle === 'function') unsubscribers.push(handle)
        else if (handle && typeof handle.dispose === 'function') unsubscribers.push(() => handle.dispose())
      } catch (e) {
        console.error('[ai-panel] 事件订阅失败：', e)
      }
    }
    push(() => ai.onStream?.(handleStream) ?? null)
    push(() => ai.onStateChanged?.(handleStateChanged) ?? null)
    push(() => ai.onUiStateChanged?.(handleUiState) ?? null)
    push(() => ai.onApprovalRequest?.(handleApproval) ?? null)
    push(() => ai.onIntent?.((intent) => { void applyIntent(intent) }) ?? null)
    push(() => ai.onUsageTick?.((payload) => {
      if (!payload || payload.sessionId !== state.sessionId) return
      state.usage = {
        promptTokens: Number(payload.promptTokens) || 0,
        completionTokens: Number(payload.completionTokens) || 0,
        cachedTokens: Number(payload.cachedTokens) || 0
      }
      notify()
    }) ?? null)
  }

  /**
   * 首次挂载：一次快照 + 一次性消费 pending 意图。
   * @param {{ sessionId?: string, consumePending?: boolean }} [opts]
   */
  async function init(opts: { sessionId?: string; consumePending?: boolean } = {}): Promise<void> {
    try {
      const snap = await ai.state({
        host: HOST,
        // 迁移过来的会话（拆窗 / 停靠）优先：直接落在它上面，避免先画旧会话再跳。
        ...(opts.sessionId ? { sessionId: String(opts.sessionId) } : {}),
        ...(opts.consumePending === false ? {} : { consumePending: true })
      })
      applySnapshot(snap)
      ensureModelChoice()
      notify()
      subscribeEvents()
      const pending = snap.pendingIntents ?? []
      for (const intent of pending) await applyIntent(intent)
    } catch (e) {
      state.ready = true
      state.unavailable = errorPayload(e)
      notify()
    }
  }

  /** 手动刷新（面板"刷新"按钮 / 菜单动作之后）。 */
  async function refresh(): Promise<void> {
    await refreshSessions()
    if (state.sessionId && !state.streaming) {
      try {
        const res = await ai.messages(state.sessionId, { limit: HISTORY_LIMIT })
        state.messages = res.messages ?? []
        state.lastSeq = Number(res && res.lastSeq) || 0
        if (res && res.running) state.streaming = { turnId: null, parts: [], orphan: true, done: false }
      } catch (_) {}
    }
    await refreshProviders()
    await refreshSkills()
    notify()
  }

  /**
   * 迁移快照：草稿 + **当前会话**。
   *
   * 会话必须跟着走 —— 否则「面板里点拆出窗口」会落在窗口上次的对话上，而不是
   * 用户眼前这条。模型 / 推理 / 审批仍由主进程共享，不放进快照（带了反而回声）。
   */
  function serialize() {
    return {
      sessionId: state.sessionId,
      // 整项带上（tokens / title 都要跟着走），`restore` 会经 normalizeChip 重新校验
      chips: state.chips.map((c) => ({ ...c }))
    }
  }

  /** 独立窗口 / 停靠回侧栏时恢复：先对齐会话，再恢复合法的上下文项。 */
  function restore(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    const id = value.sessionId ? String(value.sessionId) : null
    if (id && id !== state.sessionId) {
      // 换宿主 = 用户明确要"接着这条对话"，把这个选择写进新宿主的槽位。
      switchSession(id).catch(() => {})
    }
    for (const item of Array.isArray(value.chips) ? value.chips : []) addChip(item)
  }

  function dispose(): void {
    while (unsubscribers.length) {
      const off = unsubscribers.pop()
      try { if (off) off() } catch (_) {}
    }
    subscribed = false
    listeners.clear()
    if (scheduled) {
      try {
        if (typeof scheduled === 'number' && win && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(scheduled)
        } else {
          clearTimeout(scheduled)
        }
      } catch (_) {}
    }
    scheduled = 0
  }

  return {
    get: () => state,
    subscribe,
    init,
    refresh,
    dispose,
    serialize,
    restore,
    // 会话
    switchSession,
    newSession,
    renameSession,
    deleteSession,
    refreshSessions,
    // 消息
    send,
    askNew,
    retry,
    stop,
    settle,
    // 审批
    resolveApproval,
    allowAlways,
    // 上下文
    addChip,
    removeChip,
    clearChips,
    captureInto,
    fetchCandidates,
    revealSource,
    // 模型 / 技能 / 推理
    modelOptions,
    chooseModel,
    reasoningOptions,
    chooseReasoning,
    approvalOptions,
    chooseApprovalMode,
    refreshProviders,
    refreshSkills,
    skillKindMeta,
    runSkill,
    // 搜索 / 导出
    searchSessions,
    exportSession,
    // 其他
    applyIntent,
    isRunning,
    dismissError,
    KIND_LABEL
  }
}

