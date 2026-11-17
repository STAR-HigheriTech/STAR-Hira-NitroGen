/**
 * AI 引擎 · 装配根（PART15 §3 / §4 / §9）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是"把零件接起来"，不是"再写一遍业务"
 * ══════════════════════════════════════════════════════════════════════
 * 每个能力都是一个独立模块，各自不认识别人：
 *   core/store.cjs       存储（表 ↔ 对象）
 *   core/providers.cjs   协议（SSE → 帧）
 *   core/context.cjs     上下文装配（不可信包裹 / 预算裁剪）
 *   core/tools.cjs       工具声明 + 注册表
 *   core/page.cjs        页面读取 / 截图
 *   main/turn-runner.cjs 回合生命周期
 *   main/approvals.cjs   审批（带超时的等待）
 *   main/intent.cjs      所有提问入口的收敛点
 *   main/ipc.cjs         21 条通道
 * 本文件只做四件事：**建实例、解模型、补上下文、暴露 IPC 面**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条数据流上的硬决策
 * ══════════════════════════════════════════════════════════════════════
 * 1) **截图不进 IPC 往返**：`capture` 落盘后只回 `path + 缩略 dataURL`；
 *    真正发送前 `hydrate()` 读盘成 dataURL。见 attachments.cjs 文件头。
 * 2) **页面正文延迟解析**：意图只带 `{url,title}`。若 payload 里没有正文，
 *    `hydrate()` 把 payload 摘掉，交给 `ai.context.provider` 在**回合内**异步补 ——
 *    IPC 立刻返回，不因为抓一页而卡住界面上的一次回车。
 */

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
const fs = require('fs/promises')
const path = require('path')

const { createStore, projectMessages } = require('../core/store.cjs')
const { runAiMigrations } = require('../core/db.cjs')
const { createContextBuilder, snapshotToText } = require('../core/context.cjs')
const { estimateTokens } = require('../core/tokens.cjs')
const { createBuiltinTools, createToolRegistry } = require('../core/tools.cjs')
const { readPage, capturePage } = require('../core/page.cjs')
const { fetchPage } = require('../core/fetch-page.cjs')
const { testConnection } = require('../core/providers.cjs')
const { readOffice } = require('../core/office.cjs')
const { createApprovals } = require('./approvals.cjs')
const { createApprovalGrants } = require('./approval-grants.cjs')
const { createTurnRunner } = require('./turn-runner.cjs')
const { createCompleter } = require('./completer.cjs')
const { createSubAgents } = require('./subagent.cjs')
const { createIntentService } = require('./intent.cjs')
const { createAttachments } = require('./attachments.cjs')
const { createWorkspaceService } = require('./workspaces.cjs')
const { createExporter } = require('./exporter.cjs')
const { createSkillService } = require('./skills.cjs')
// AI 工作室（PART17）：把模型写的插件 / 主题 / 用户脚本交给唯一安装链路。
const { createStudioService } = require('./studio.cjs')
const { createUiState, normalizeHost } = require('./ui-state.cjs')
const { createEngineRuntime } = require('./runtime-service.cjs')

import type {
  AiCompleterPort,
  AiCompletionRequest,
  AiEngineDeps,
  AiProvider,
  AiServicesPort,
  AiSubAgentPort,
  AiSubagentRequest,
  UnknownRecord
} from '../types'

interface AiEngineError extends Error { code: string }

/** 一条域错误：`code` 会原样进 IPC 响应（渲染层据此分支）。 */
function fail(code: string, message?: string): AiEngineError {
  const err = new Error(message || code) as AiEngineError
  err.code = code
  return err
}

/** 会话列表一次给多少条（面板只画得下几十条，再多是白搬）。 */
const SESSION_PAGE = 50
/** 打开面板时随快照带回的历史事件条数（更早的走 `ai:session-messages` 增量分页）。 */
const STATE_EVENT_LIMIT = 300

function basename(p: unknown): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
}

/** `@` 面板一次返回多少条来源候选（面板一屏也就看得到十几条）。 */
const CANDIDATE_LIMIT = 12
/** 候选列表的硬上限（契约里也钉了 50，这里再收一次，避免服务层被要求搬全库）。 */
const CANDIDATE_LIMIT_MAX = 50

/** 只有 http(s) 才谈得上"引用 / 跳回"（`about:` / `file:` 之类一律不进来源列表）。 */
function isWebUrl(url: unknown): boolean {
  return /^https?:\/\//i.test(String(url || ''))
}

/** 取 origin（站点授权闸与候选去重都用它）。非法 URL 返回空串，绝不抛。 */
function originOf(url: unknown): string {
  try { return new URL(String(url)).origin } catch (_) { return '' }
}

/** 取主机名（候选副标题展示）。 */
function hostOf(url: unknown): string {
  try { return new URL(String(url)).host } catch (_) { return '' }
}

/**
 * 一条来源候选的统一形状（`@` 面板只认这四个字段 + 可选副标题）。
 * 主进程先把字段拍平，渲染侧就不必为"标签 / 书签 / 历史"各写一遍字段名映射。
 */
function candidate(id: unknown, title: unknown, url: unknown, sub: unknown, favicon: unknown) {
  return {
    id: String(id || url || ''),
    title: String(title || url || ''),
    url: String(url || ''),
    sub: String(sub || ''),
    favicon: String(favicon || '')
  }
}

/**
 * 一条上下文项的 token 粗估（与提示词裁剪切**同一份**口径，见 core/tokens.cjs）。
 * 放在主进程算：页面快照有六万字，渲染层根本拿不到正文，无从估算。
 */
function itemTokens(item: unknown): number {
  const record = item && typeof item === 'object' ? item as UnknownRecord : {}
  const kind = String(record.kind || '')
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as UnknownRecord : {}
  if (kind === 'screenshot') return 800 // 一张图按视觉 token 保守下估（与 tokens.cjs 一致）
  if (kind === 'page') return estimateTokens(snapshotToText(payload))
  return estimateTokens(payload.text || payload.title || record.title || '')
}

/**
 * @param {{
 *   kernel: any,
 *   extensionPoints: any,
 *   contributions?: any,
 *   getDomainServices?: () => object,
 *   getPanels?: () => any[],
 *   logger?: any
 * }} deps
 */
function createEngine({ kernel, extensionPoints, contributions, getDomainServices, getPanels, logger = console }: AiEngineDeps) {
  const store = createStore({ sqlite: kernel.sqlite, secretCrypto: kernel.secretCrypto })
  const workspaces = createWorkspaceService({ store, logger })
  /**
   * 跨宿主共享的界面状态：侧栏面板 / 独立窗口 / 内部页是三个渲染进程，
   * 同一次「选会话 / 选模型 / 调档位 / 换审批」必须落成**一份**（见 ui-state.cjs）。
   */
  const uiState = createUiState({
    sqlite: kernel.sqlite,
    emit: (route: string, payload: unknown) => kernel.emit(route, payload),
    event: IPC_EVENTS.aiUiStateChanged,
    logger
  })
  const attachments = createAttachments({ userDataPath: kernel.userDataPath })
  const builder = createContextBuilder({ extensionPoints })
  const exporter = createExporter({ logger })

  const getTabManager = () => kernel.getTabManager()
  const services = (): AiServicesPort => (typeof getDomainServices === 'function' ? (getDomainServices() || {}) : {}) as AiServicesPort

  /**
   * 工具执行上下文：回合执行器与子智能体**共用同一份**（标签 / 域服务按调用时刻现取）。
   * 传 sessionId 而不是整个 state —— 工具不该看到回合内部字段。
   */
  function toolCtxOf(sessionId: string) {
    const tm = getTabManager()
    const tabId = tm && typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : null
    const workspace = workspaces.current(sessionId)
    return {
      sessionId,
      tabId,
      windowId: null,
      getTabManager,
      getServices: services,
      workspaceId: workspace?.id || null,
      workspaceRoot: workspace?.rootPath || null,
      workspaceName: workspace?.name || null,
      workspaceInstructions: workspace ? workspaces.instructions(sessionId) : ''
    }
  }

  // 这两个在「工具表建好 / 审批闸建好」之后才可实例化，但内置工具要提前拿到端口，
  // 所以先声明、后赋值（闭包在真正调用时才解引用）。
  let completer: AiCompleterPort | null = null
  let subAgents: AiSubAgentPort | null = null

  /**
   * 技能服务：插件贡献 + 用户自建合并，CRUD / 导入导出 / 按 kind 分派执行。
   * 内置技能由 `ai-skills-builtin` 插件贡献（manifest 单一真源），这里不再播种。
   */
  const skillService = createSkillService({
    store,
    extensionPoints,
    contributions,
    getPluginRegistry: () => (typeof kernel.getPluginRegistry === 'function' ? kernel.getPluginRegistry() : null),
    getTabManager,
    notify: (payload: unknown) => notify(payload),
    logger
  })

  /**
   * AI 工作室：插件 / 主题 / 用户脚本 / 技能的「生成 → 安装」。
   * 安装端口按调用时刻现取（`services()`），与其它域服务同一口径 —— 端口晚绑定，
   * 未就绪时工具返回明确原因而不是静默失败。
   */
  const studioService = createStudioService({
    getServices: services,
    skillService,
    logger
  })

  const builtin = createBuiltinTools({
    getTabManager,
    getServices: services,
    // 插件生态（PART18）：命令 / 页面 / 浮层的唯一数据源仍是 APPS 侧的两个模块，
    // 这里只把同一实例递进去（不复制、不缓存快照）。
    extensionPoints,
    pluginSurfaces: kernel.pluginSurfaces || null,
    pluginOverlayHost: kernel.pluginOverlayHost || null,
    getPluginRegistry: () => (typeof kernel.getPluginRegistry === 'function' ? kernel.getPluginRegistry() : null),
    studio: studioService,
    // 浏览器本体操作（窗口布局 / 面板宿主 / 面板目录）—— 都按调用时刻现取，
    // 与 kernel 端口「不接受某一窗口的快照」保持同一口径。
    getLayout: () => {
      try { return typeof kernel.getLayout === 'function' ? kernel.getLayout() : null } catch (_) { return null }
    },
    getPanelPresentation: () => kernel.panelPresentation || null,
    listPanels: () => (typeof getPanels === 'function' ? getPanels() : []),
    // 感知面：运行日志（主进程 + 各页面 console / 崩溃）与面板数据（含「固定」等细节标签）。
    // 两者都是主进程单例，按调用时刻现取。
    getLogHub: () => kernel.logHub || null,
    panelData: kernel.panelData || null,
    // 浏览器全部菜单动作的唯一执行入口（主进程 app-actions 实例）。
    // AI 的「接管一切」= 调这张表，不另建一套动作实现。
    appActions: kernel.appActions || null,
    // 记忆与增强（收藏摘要）与子智能体（研究 / 操作 / 写作）—— 见各文件头。
    complete: (req: AiCompletionRequest) => {
      if (!completer) return Promise.reject(new Error('补全服务尚未就绪'))
      return completer.complete(req)
    },
    runAgent: (req: AiSubagentRequest) => {
      if (!subAgents) return Promise.reject(new Error('子智能体尚未就绪'))
      return typeof subAgents.dispatch === 'function' ? subAgents.dispatch(req) : subAgents.run(req)
    }
  })
  const toolRegistry = createToolRegistry({ extensionPoints, builtin })

  const approvals = createApprovals({
    emit: (route: string, payload: unknown) => kernel.emit(route, payload),
    events: { aiApprovalRequest: IPC_EVENTS.aiApprovalRequest }
  })
  /**
   * 「始终允许」的持久化记忆（`ai_approval_grant`）。
   * 与 `approvals`（一次带超时的等待）分开：记忆是跨回合 / 跨会话 / 跨重启的事实，
   * 主链路与子智能体共用同一份实例（见 approval-grants.cjs 文件头）。
   */
  const grants = createApprovalGrants({ sqlite: kernel.sqlite, logger })

  // ── 记忆与增强（Phase 6）：一次性补全 + 子智能体 ─────────────────────
  // 补全不落事件、不推流、不占运行槽（见 completer.cjs 文件头）；
  // 子智能体只经由 `agent_delegate` 进入，审批与主链路同一道闸（见 subagent.cjs）。
  completer = createCompleter({ store, resolveModel, logger })
  if (!completer) throw fail('AI_NOT_READY', 'AI 补全服务初始化失败')
  subAgents = createSubAgents({
    store,
    toolRegistry,
    complete: completer.complete,
    buildToolCtx: toolCtxOf,
    approvals,
    grants,
    logger
  })

  // ── 活动标签（页面读取 / 截图 / 选区都从它出发） ─────────────────────
  function activeWebContents() {
    const tm = getTabManager()
    const tabId = tm && typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : null
    return tabId && typeof tm.getWebContents === 'function' ? tm.getWebContents(tabId) : null
  }

  /** 在已打开的标签里找某个 URL（同一个页面才有登录态与实时 DOM）。 */
  function findOpenWebContents(url: string) {
    const target = String(url || '').trim()
    if (!target) return null
    let tm
    try { tm = getTabManager() } catch (_) { return null }
    if (!tm || typeof tm.list !== 'function') return null
    let tabs = []
    try { tabs = tm.list() || [] } catch (_) { return [] }
    for (const t of tabs) {
      const u = String((t && t.url) || '')
      if (!u) continue
      // 逐字相等最常见；忽略 hash 的相等覆盖"锚点跳转后再次引用同一页"。
      if (u === target || u.split('#')[0] === target.split('#')[0]) {
        try { return tm.getWebContents(t.tabId) || null } catch (_) { return null }
      }
    }
    return null
  }

  // ── 模型解析：显式 `providerId:modelId` > 会话绑定 > 第一个启用项 ──────
  function resolveModel(session: unknown, requested: unknown) {
    const sessionRecord = session && typeof session === 'object' ? session as UnknownRecord : {}
    let providerId = typeof sessionRecord.providerId === 'string' ? sessionRecord.providerId : null
    let modelId = typeof sessionRecord.modelId === 'string' ? sessionRecord.modelId : null

    const asked = typeof requested === 'string' ? requested.trim() : ''
    if (asked) {
      const sep = asked.indexOf(':')
      if (sep > 0) {
        providerId = asked.slice(0, sep)
        modelId = asked.slice(sep + 1)
      } else {
        modelId = asked
      }
    }

    let provider = providerId ? store.getProvider(providerId) : null
    if (provider && provider.enabled === false) provider = null
    if (!provider) {
      const first = store.listProviders().find((provider: AiProvider) => provider.enabled)
      provider = first ? store.getProvider(first.id) : null
    }
    if (!provider) return null

    let model = modelId ? provider.models.find((candidateModel: { id: string }) => candidateModel.id === modelId) : null
    // 指定的模型不在这个 provider 里 → 回落首个（宁可回答，也不要"配了却用不了"）
    if (!model) model = provider.models[0] || null
    if (!model && providerId && providerId !== provider.id) {
      const fallback = store.listProviders().find((provider: AiProvider) => provider.enabled && provider.models.length)
      if (fallback) {
        provider = store.getProvider(fallback.id)
        model = provider.models[0] || null
      }
    }
    if (!model) return null
    return { provider, model }
  }

  // ── 上下文补全 ──────────────────────────────────────────────────────
  /**
   * 发送前的**同步**补全（截图读盘 / 文件读文本 / 描 URL 与标题）。
   * 页面正文不在这里抓（见文件头决策 2），由 `ai.context.provider` 在回合内补。
   */
  function hydrate(items: unknown) {
    const list = Array.isArray(items) ? items : []
    const out: UnknownRecord[] = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const item: UnknownRecord = { ...(raw as UnknownRecord) }
      const sourcePayload = item.payload
      const payload: UnknownRecord | unknown = sourcePayload && typeof sourcePayload === 'object'
        ? { ...(sourcePayload as UnknownRecord) }
        : sourcePayload
      if (payload && typeof payload === 'object') {
        const payloadRecord = payload as UnknownRecord
        if (!item.url && payloadRecord.url) item.url = String(payloadRecord.url)
        if (!item.title && payloadRecord.title) item.title = String(payloadRecord.title)
      }

      const payloadRecord = payload && typeof payload === 'object' ? payload as UnknownRecord : null
      if (item.kind === 'screenshot' && payloadRecord && payloadRecord.path) {
        // 只有发送时才把原图读成 dataURL（chips 用的是 payload.thumb）。
        if (!payloadRecord.dataUrl) {
          const dataUrl = attachments.readAsDataUrl(payloadRecord.path)
          if (dataUrl) payloadRecord.dataUrl = dataUrl
        }
        item.payload = payload
      } else if (item.kind === 'file' && payloadRecord && payloadRecord.path) {
        // 文件内容在用户采集时已经固化；历史事件里的 path 是展示信息，不是读取授权，
        // 不能因为数据库 / 旧事件里出现任意路径就在发送时重新读盘。
        if (!payloadRecord.name) payloadRecord.name = basename(payloadRecord.path)
        item.payload = payload
      } else if (item.kind === 'page') {
        const hasBody = payloadRecord && (payloadRecord.text || payloadRecord.selection)
        if (!hasBody) {
          // 摘掉空壳 payload，让 builder 去问 provider（异步、不阻塞本次 IPC）
          item.payload = undefined
          if (payloadRecord && payloadRecord.url && !item.url) item.url = String(payloadRecord.url)
          if (payloadRecord && payloadRecord.title && !item.title) item.title = String(payloadRecord.title)
        } else {
          item.payload = payload
        }
      } else {
        item.payload = payload
      }
      out.push(item)
    }
    return out
  }

  /**
   * 一个上下文项的**延迟解析**（`ai.context.provider` 的实现）。
   * 返回形状与 `readPage()` 对齐，`snapshotToText()` 不必区分来源。
   */
  async function resolveContextItem({ item }: { item?: unknown } = {}) {
    if (!item || typeof item !== 'object') return null
    const itemRecord = item as UnknownRecord
    const kind = String(itemRecord.kind || '')
    const payload = itemRecord.payload && typeof itemRecord.payload === 'object' ? itemRecord.payload as UnknownRecord : {}

    if (kind === 'page') {
      const url = String(itemRecord.url || payload.url || '')
      if (!url) return null
      // ① 已开标签：读实时 DOM（有登录态、有滚动/展开后的内容）
      const wc = findOpenWebContents(url)
      if (wc) {
        try { return await readPage(wc, { maxChars: 60000, maxLinks: 40 }) } catch (_) { /* 落到 ② */ }
      }
      // ② 没开：远程取一次 HTML（不新建窗口，见 fetch-page.cjs）
      const remote = await fetchPage(url)
      if (remote.ok) {
        return { url, title: remote.title || itemRecord.title || '', text: remote.text || '', links: remote.links || [], truncated: !!remote.truncated }
      }
      return { url, title: itemRecord.title || '', text: '', links: [], truncated: false, error: remote.reason }
    }

    if (kind === 'selection') {
      if (payload.text) return payload
      const wc = activeWebContents()
      if (!wc) return null
      try {
        const snap = await readPage(wc, { maxChars: 8000, maxLinks: 0 })
        return { text: snap.selection || '', url: snap.url, title: snap.title }
      } catch (_) { return null }
    }

    if (kind === 'screenshot') {
      if (payload.path) return payload
      const wc = activeWebContents()
      if (!wc) return null
      try {
        const shot = await capturePage(wc)
        const saved = attachments.saveDataUrl('capture', shot.dataUrl)
        return saved.ok ? { path: saved.path, mime: saved.mime, width: saved.width, height: saved.height } : null
      } catch (_) { return null }
    }

    if (kind === 'file' && payload.path) return payload

    return payload && Object.keys(payload).length ? payload : null
  }

  // ── 回合执行器（依赖注入完毕） ───────────────────────────────────────
  const runner = createTurnRunner({
    store,
    builder,
    toolRegistry,
    approvals,
    grants,
    emit: (route: string, payload: unknown) => kernel.emit(route, payload),
    events: {
      aiStream: IPC_EVENTS.aiStream,
      aiStateChanged: IPC_EVENTS.aiStateChanged,
      aiUsageTick: IPC_EVENTS.aiUsageTick
    },
    extensionPoints,
    resolveModel,
    buildToolCtx: toolCtxOf,
    complete: (request: AiCompletionRequest) => completer!.complete(request),
    logger
  })
  const runtimeService = createEngineRuntime({
    store,
    runner,
    workspaces,
    processRunner: kernel.processRunner || null
  })

  // 菜单 / 建议 / 快捷键的可用性判据由宿主下发（`kernel.isFeatureOn`，与渲染侧
  // `features:availability` 共用同一份 feature-map）—— 插件侧不自己翻插件状态表。
  const intent = createIntentService({
    kernel,
    store,
    skills: skillService,
    uiState,
    isFeatureOn: typeof kernel.isFeatureOn === 'function' ? kernel.isFeatureOn : undefined,
    logger
  })

  // ── 对外面（ipc.cjs 逐条对应，见那里的注册表） ────────────────────────
  function notify(payload: unknown) {
    try { kernel.emit(IPC_EVENTS.aiStateChanged, payload || {}) } catch (_) {}
  }

  /** 只暴露"能出门"的字段：`credentialRef` 永远不进渲染层。 */
  function safeProvider(id: string) {
    return store.listProviders().find((provider: AiProvider) => provider.id === id) || null
  }

  function state(req: UnknownRecord = {}) {
    let sessions = store.listSessions({ limit: SESSION_PAGE })
    const shared = uiState.get()
    const host = normalizeHost(req.host)
    // 「当前会话」按宿主分槽：侧栏 / 窗口 / 内部页各自记忆，互不拽走。
    const slotId = shared.sessionIdByHost ? shared.sessionIdByHost[host] : null
    const wanted = req.sessionId ? store.getSession(String(req.sessionId)) : null
    const remembered = !wanted && slotId ? store.getSession(slotId) : null
    const current = wanted || remembered || sessions[0] || null
    // 深链 / 搜索结果可能指向 50 条列表之外的旧会话。当前会话必须始终出现在
    // 列表投影里，否则顶栏能显示标题、列表却没有选中项，后续刷新还会把标题带回旧会话。
    if (current && !sessions.some((session: { id?: string }) => session.id === current.id)) {
      sessions = [current, ...sessions].slice(0, Math.max(1, SESSION_PAGE))
    }

    // 把解析结果写回**本宿主**的槽位：下次挂载落在同一条会话上。
    // 其它宿主的槽位不动 —— 那正是"三种宿主可以停在不同对话"的前提。
    const currentId = current ? current.id : null
    // 快速连续切换时，旧 state 请求可能晚返回。渲染层读取会话投影时用
    // `select:false`，只有最新一次选择才允许写共享槽位，避免旧请求把当前对话写回去。
    if (req.select !== false && currentId !== slotId) uiState.set({ host, sessionId: currentId })

    const projected = current
      ? projectMessages(store.listRecentEvents(current.id, STATE_EVENT_LIMIT))
      : { messages: [], lastSeq: 0 }

    // 只有**面板真正挂载**的那一次才消费待补发意图（见 intent.cjs 的说明）。
    const take = req.consumePending === true
    // 待补发意图按宿主族领取：内部页挂载时不能吃掉侧栏 / 独立窗口的菜单意图。
    const pendingIntents = take ? intent.takePending(host) : []
    return {
      ok: true,
      sessionId: currentId,
      session: current,
      sessions,
      providers: store.listProviders(),
      // 面板只消费**启用中**的技能（`/` 菜单）；插件页拿全量 + kinds。
      skills: skillService.list({ enabledOnly: true }).skills,
      skillKinds: skillService.kinds(),
      running: runner.snapshot(),
      approvals: approvals.list(),
      messages: projected.messages,
      lastSeq: projected.lastSeq,
      // 共享界面状态（模型 / 推理 / 审批）：三个宿主读同一份，不再各自记 settings。
      uiState: uiState.get(),
      pendingIntents,
      pendingCount: intent.pendingCount(),
      panelOpen: intent.isPanelOpen()
    }
  }

  function listSessions(req: UnknownRecord = {}) {
    return { ok: true, sessions: store.listSessions({ limit: req.limit || SESSION_PAGE }) }
  }

  function createSession(req: UnknownRecord = {}) {
    const first = store.listProviders().find((provider: AiProvider) => provider.enabled && provider.models.length)
    const session = store.createSession({
      title: req.title || '',
      providerId: first ? first.id : null,
      modelId: first ? first.models[0].id : null
    })
    // 新会话只成为**发起它的那个宿主**的当前会话：其它宿主各自的对话保持不变。
    const host = normalizeHost(req.host)
    uiState.set({ host, sessionId: session.id })
    notify({ sessionId: session.id, reason: 'created', host })
    return { ok: true, session }
  }

  function renameSession(req: UnknownRecord = {}) {
    const session = store.touchSession(String(req.sessionId), { title: String(req.title || '') })
    if (!session) throw fail('AI_NO_SESSION', '会话不存在')
    notify({ sessionId: session.id, reason: 'renamed', title: session.title })
    return { ok: true, session }
  }

  function deleteSession(req: UnknownRecord = {}) {
    const sessionId = String(req.sessionId || '')
    if (runner.isRunning(sessionId)) runner.stop({ sessionId })
    store.deleteSession(sessionId)
    runner.forgetSession(sessionId)
    attachments.removeSession(sessionId)
    // 删掉的正好是共享会话 → 共享状态跟着落到新的最近一条，三个宿主一起换。
    const next = store.listSessions({ limit: 1 })[0]
    uiState.forgetSession(sessionId, next ? next.id : null)
    notify({ sessionId, reason: 'deleted' })
    return { ok: true, sessionId }
  }

  function messages(req: UnknownRecord = {}) {
    const sessionId = String(req.sessionId || '')
    if (!store.getSession(sessionId)) throw fail('AI_NO_SESSION', '会话不存在')
    const events = req.after
      ? store.listEvents(sessionId, { after: req.after, limit: req.limit || 200 })
      : store.listRecentEvents(sessionId, req.limit || STATE_EVENT_LIMIT)
    const projected = projectMessages(events)
    return {
      ok: true,
      sessionId,
      messages: projected.messages,
      lastSeq: projected.lastSeq,
      running: runner.isRunning(sessionId),
      after: req.after || 0
    }
  }

  function send(req: UnknownRecord = {}) {
    const sessionId = String(req.sessionId || '')
    const session = store.getSession(sessionId)
    if (!session) throw fail('AI_NO_SESSION', '会话不存在')
    const shared = uiState.get()
    // 在这个会话里说话 = 它成为**本宿主**的当前会话（其它宿主各自停在原处）。
    const host = normalizeHost(req.host)
    const slotId = shared.sessionIdByHost ? shared.sessionIdByHost[host] : null
    if (slotId !== sessionId) uiState.set({ host, sessionId })

    // 第一次发送时把"实际会用的模型"写回会话：界面上的模型名才不会一直是空的。
    const resolved = resolveModel(session, req.model)
    if (resolved && (!session.providerId || !session.modelId)) {
      store.touchSession(sessionId, { providerId: resolved.provider.id, modelId: resolved.model.id })
    }

    const { turnId } = runner.start({
      sessionId,
      text: req.text,
      blocks: req.blocks,
      context: hydrate(req.context),
      model: req.model || null,
      // 渲染层没带时回落到共享状态：其它调用方（意图 / 工具）不必自己再记一份档位。
      reasoning: req.reasoning || shared.reasoning,
      approvalMode: req.approvalMode || shared.approvalMode
    })
    return { ok: true, sessionId, turnId }
  }

  /**
   * 回合进行中追加一句（Tabbit 的"边跑边补"）。
   * 不新开回合：事件落进当前 turn，下一步组装请求时自然带上。
   */
  async function steer(req: UnknownRecord = {}) {
    const sessionId = String(req.sessionId || '')
    if (!store.getSession(sessionId)) throw fail('AI_NO_SESSION', '会话不存在')
    const res = await runner.steer({
      sessionId,
      text: req.text,
      blocks: req.blocks,
      context: hydrate(req.context),
      approvalMode: req.approvalMode || uiState.get().approvalMode
    })
    if (!res.ok) {
      return res.reason === 'empty'
        ? { ok: false, code: 'AI_EMPTY', message: '没有可发送的内容' }
        : { ok: false, code: 'AI_NOT_RUNNING', message: '当前没有进行中的回合' }
    }
    return { ok: true, sessionId, turnId: res.turnId }
  }

  /** 重试 / 重生成：复用最后一条用户消息（runner 负责 `assistant/attempt`）。 */
  function retry(req: UnknownRecord = {}) {
    const sessionId = String(req.sessionId || '')
    const session = store.getSession(sessionId)
    if (!session) throw fail('AI_NO_SESSION', '会话不存在')
    const shared = uiState.get()
    const host = normalizeHost(req.host)
    const slotId = shared.sessionIdByHost ? shared.sessionIdByHost[host] : null
    if (slotId !== sessionId) uiState.set({ host, sessionId })
    const resolved = resolveModel(session, req.model)
    if (resolved && (!session.providerId || !session.modelId)) {
      store.touchSession(sessionId, { providerId: resolved.provider.id, modelId: resolved.model.id })
    }
    const { turnId } = runner.retry({
      sessionId,
      model: req.model || null,
      reasoning: req.reasoning || shared.reasoning,
      approvalMode: req.approvalMode || shared.approvalMode
    })
    return { ok: true, sessionId, turnId }
  }

  /** 会话搜索：命中片段 + 会话元数据（抽屉里直接画成条目）。 */
  function searchSessions(req: UnknownRecord = {}) {
    const query = String(req.query || '')
    const hits: Array<{ sessionId: string; snippet?: string; seq: number }> = store.searchSessions(query, req.limit)
    const sessions = hits
      .map((hit: { sessionId: string; snippet?: string; seq: number }) => {
        const meta = store.getSession(hit.sessionId)
        return meta ? { ...meta, snippet: hit.snippet, seq: hit.seq } : null
      })
      .filter(Boolean)
    return { ok: true, query, sessions }
  }

  /** 会话导出（md / json）—— 弹保存框，用户取消不算失败。 */
  function exportSession(req: UnknownRecord = {}) {
    return exporter.session(store, String(req.sessionId || ''), req.format === 'json' ? 'json' : 'md')
  }

  /** 审计导出（csv / json）。 */
  function auditExport(req: UnknownRecord = {}) {
    return exporter.audit(store, { format: req.format === 'json' ? 'json' : 'csv', limit: req.limit })
  }

  function stop(req: UnknownRecord = {}) {
    return { ok: true, ...runner.stop({ sessionId: String(req.sessionId || '') }) }
  }

  function approval(req: UnknownRecord = {}) {
    const res = approvals.resolve(String(req.approvalId || ''), req.decision, req.remember, {
      // 归属校验：只有发起该审批的会话能裁决它（契约里 sessionId 必填）。
      sessionId: String(req.sessionId || '')
    })
    if (!res.ok) {
      return {
        ok: false,
        code: res.reason === 'session-mismatch' ? 'AI_APPROVAL_FORBIDDEN' : 'AI_UNKNOWN_APPROVAL',
        message: res.reason === 'session-mismatch' ? '该审批不属于当前会话' : '该审批已失效'
      }
    }
    return { ok: true }
  }

  // ── 共享界面状态（侧栏面板 / 独立窗口 / 内部页同一份） ────────────────
  // 读与写都回整份状态：渲染层不必自己合并增量，直接以响应对齐界面。
  function getUiState() {
    return { ok: true, uiState: uiState.get() }
  }

  function setUiState(req: UnknownRecord = {}) {
    const before = uiState.get()
    const next = uiState.set(req)
    // 审批模式是**运行中的实时开关**，不是"下一条消息才生效"的偏好：
    // 拨到「允许」就立刻改在跑的回合，并放掉屏幕上卡着的非破坏性审批卡 ——
    // 否则用户会觉得"我明明开了允许，它还在问我"。
    if (next && next.approvalMode !== before.approvalMode) {
      try { runner.setApprovalMode(next.approvalMode) } catch (_) {}
      if (next.approvalMode === 'allow') {
        try { approvals.allowPending() } catch (_) {}
      }
    }
    return { ok: true, uiState: next }
  }

  function intentInvoke(req: UnknownRecord = {}) {
    return intent.invoke({ intent: req.intent, payload: req.payload || {}, sessionId: req.sessionId || null })
  }

  /**
   * 显式采集一项上下文（`@` 面板 / 截图按钮 / 拖入文件都走这一条）。
   * 返回**可直接追加到 composer 的上下文项**（截图带缩略 dataURL，便于画 chip）。
   */
  async function capture(req: UnknownRecord = {}) {
    const kind = String(req.kind || '')
    const payload = req.payload && typeof req.payload === 'object' ? req.payload as UnknownRecord : {}
    /** 统一出口：顺手带上 token 粗估（面板顶部摘要条与预算提示共用）。 */
    const done = (item: UnknownRecord) => ({ ok: true, item: { ...item, tokens: itemTokens(item) } })

    if (kind === 'page') {
      const wc = activeWebContents()
      if (!wc) throw fail('AI_NO_PAGE', '当前没有可读取的页面')
      const snap = await readPage(wc, { maxChars: 60000, maxLinks: 40 })
      return done({ kind: 'page', payload: snap, url: snap.url, title: snap.title, untrusted: true })
    }

    if (kind === 'selection') {
      if (payload.text) {
        return done({
          kind: 'selection',
          payload: { text: String(payload.text), url: payload.url || '', title: payload.title || '' },
          url: payload.url || undefined,
          title: payload.title || undefined,
          untrusted: true
        })
      }
      const wc = activeWebContents()
      if (!wc) throw fail('AI_NO_PAGE', '当前没有可读取的页面')
      const snap = await readPage(wc, { maxChars: 8000, maxLinks: 0 })
      if (!snap.selection) throw fail('AI_NO_SELECTION', '当前页面没有选中内容')
      return done({
        kind: 'selection',
        payload: { text: snap.selection, url: snap.url, title: snap.title },
        url: snap.url,
        title: snap.title,
        untrusted: true
      })
    }

    if (kind === 'screenshot') {
      const wc = activeWebContents()
      if (!wc) throw fail('AI_NO_PAGE', '当前没有可截图的页面')
      const shot = await capturePage(wc)
      const saved = attachments.saveDataUrl(payload.sessionId || 'draft', shot.dataUrl)
      if (!saved.ok) throw fail('AI_SHOT_FAILED', `截图保存失败：${saved.reason}`)
      return done({
        kind: 'screenshot',
        // 原图在盘上（发送前才读）；chip 用 thumb 预览。
        payload: { path: saved.path, mime: saved.mime, width: saved.width, height: saved.height, thumb: saved.thumb },
        title: payload.title || '',
        untrusted: false
      })
    }

    if (kind === 'workspace') {
      if (payload.clear === true) {
        const sessionId = String(payload.sessionId || '')
        if (sessionId && sessionId !== 'draft') store.bindSessionWorkspace(sessionId, null)
        return { ok: true, cleared: true }
      }
      const opened = await workspaces.open({
        sessionId: String(payload.sessionId || ''),
        title: '选择允许 AI 访问的本地工作区'
      })
      if (!opened || opened.ok === false) return opened
      const workspace = opened.workspace as UnknownRecord
      return done({
        kind: 'workspace',
        payload: {
          workspaceId: workspace.id,
          path: workspace.rootPath,
          name: workspace.name
        },
        title: String(workspace.name || workspace.rootPath),
        untrusted: false
      })
    }

    if (kind === 'file') {
      const filePath = String(payload.path || '')
      if (!filePath) throw fail('AI_BAD_REQUEST', '缺少文件路径')
      let text = attachments.readTextFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      if (!text && ['.docx', '.xlsx', '.pptx', '.pdf'].includes(ext)) {
        try {
          const buffer = await fs.readFile(filePath)
          const office = await readOffice(filePath, buffer)
          text = String(office.text || '').slice(0, 60_000)
        } catch (_) { text = null }
      }
      return done({
        kind: 'file',
        payload: { path: filePath, name: basename(filePath), text: text || '' },
        title: basename(filePath),
        untrusted: true
      })
    }

    if (kind === 'text') {
      const text = String(payload.text || '')
      if (!text) throw fail('AI_BAD_REQUEST', '缺少文本内容')
      return done({ kind: 'text', payload: { text }, title: payload.title || '', untrusted: true })
    }

    // 来源类（tab / closed-tab / bookmark / history）：**默认档只带标题 + 地址**。
    // 正文交给模型按需读（page 工具 / provider 延迟解析），否则一次 @ 一个书签
    // 就把整页正文搬进提示词，token 与延迟同时爆掉。
    if (kind === 'tab' || kind === 'closed-tab' || kind === 'bookmark' || kind === 'history') {
      const url = String(payload.url || '')
      if (!isWebUrl(url)) throw fail('AI_BAD_REQUEST', '缺少可引用的地址')
      const title = String(payload.title || url)
      return done({
        kind,
        payload: { url, title },
        url,
        title,
        favicon: payload.favicon ? String(payload.favicon) : undefined,
        untrusted: false
      })
    }

    throw fail('AI_BAD_REQUEST', `不支持的采集类型：${kind}`)
  }

  /**
   * `@` 面板的来源候选（打开的标签 / 已关闭 / 书签 / 历史）。
   *
   * 每次只取一屏的量：面板里打字是**本地过滤**（见 composer.js），
   * 所以这里 `query` 只在"服务端能更快砍量"时才用（书签/历史走检索），
   * 标签与已关闭标签是内存列表，直接过滤即可 —— 不为此多写一条检索路径。
   */
  function candidates(req: UnknownRecord = {}) {
    const kind = String(req.kind || '')
    const query = String(req.query || '').trim()
    const limit = Math.min(Math.max(Number(req.limit) || CANDIDATE_LIMIT, 1), CANDIDATE_LIMIT_MAX)
    const items = []

    if (kind === 'tab' || kind === 'closed-tab') {
      let tm = null
      try { tm = getTabManager() } catch (_) { tm = null }
      const rows: unknown[] = kind === 'tab'
        ? (tm && typeof tm.list === 'function' ? tm.list() || [] : [])
        : (tm && typeof tm.listRecentlyClosed === 'function' ? tm.listRecentlyClosed() || [] : [])
      for (const raw of rows) {
        const t = raw as UnknownRecord
        const url = String(t.url || '')
        if (!isWebUrl(url)) continue
        // `listRecentlyClosed()` 的 0 = 最近关闭，副标题带序号；打开标签标「当前」。
        const sub = kind === 'tab'
          ? (t.active ? '当前标签' : hostOf(url))
          : '已关闭'
        items.push(candidate(t.tabId || t.stackId, t.title, url, sub, t.favicon))
        if (items.length >= limit) break
      }
      return { ok: true, kind, items }
    }

    if (kind === 'bookmark') {
      const svc = services().bookmarkService
      if (!svc) throw fail('AI_NO_SERVICE', '书签服务不可用')
      const rows: unknown[] = query && typeof svc.search === 'function'
        ? svc.search(query) || []
        : (typeof svc.listAll === 'function' ? svc.listAll() || [] : [])
      for (const raw of rows) {
        const b = raw as UnknownRecord
        const url = String(b.url || '') // 文件夹（url 为空）天然被跳过
        if (!isWebUrl(url)) continue
        items.push(candidate(b.id, b.nickname || b.title, url, hostOf(url), b.favicon))
        if (items.length >= limit) break
      }
      return { ok: true, kind, items }
    }

    if (kind === 'history') {
      const svc = services().historyService
      if (!svc) throw fail('AI_NO_SERVICE', '历史服务不可用')
      const rows: unknown[] = query && typeof svc.search === 'function'
        ? svc.search(query, limit) || []
        : (typeof svc.listRecent === 'function' ? svc.listRecent(limit) || [] : [])
      for (const raw of rows) {
        const h = raw as UnknownRecord
        const url = String(h.url || '')
        if (!isWebUrl(url)) continue
        items.push(candidate(h.id, h.title, url, hostOf(url), h.favicon))
        if (items.length >= limit) break
      }
      return { ok: true, kind, items }
    }

    throw fail('AI_BAD_REQUEST', `不支持的来源类型：${kind}`)
  }

  /**
   * 引用回跳：已开就切过去，没开就新标签打开（Tabbit 的 chip 点击行为）。
   *
   * 同一 URL 的判据与 `findOpenWebContents()` 一致（忽略 hash），
   * 这样"页内锚点跳转后再点引用"不会莫名其妙再开一个新标签。
   */
  async function reveal(req: UnknownRecord = {}) {
    const url = String(req.url || '')
    if (!isWebUrl(url)) throw fail('AI_BAD_REQUEST', '缺少可打开的地址')

    let tm = null
    try { tm = getTabManager() } catch (_) { tm = null }
    if (!tm) throw fail('AI_NO_PAGE', '窗口不可用')

    const bare = url.split('#')[0]
    let tabs: unknown[] = []
    try { tabs = typeof tm.list === 'function' ? tm.list() || [] : [] } catch (_) { tabs = [] }
    for (const raw of tabs) {
      const t = raw as UnknownRecord
      const u = String(t.url || '')
      if (!u) continue
      if (u === url || u.split('#')[0] === bare) {
        try { tm.switchTo(String(t.tabId)); return { ok: true, tabId: String(t.tabId), reused: true } } catch (_) { /* 落到新开 */ }
      }
    }

    const created = await tm.newTab({ url })
    return { ok: true, tabId: String((created && created.tabId) || ''), reused: false }
  }

  // ── 模型服务 / 模型 ────────────────────────────────────────────────
  const providers = {
    list() {
      return { ok: true, providers: store.listProviders() }
    },

    save(req: UnknownRecord = {}) {
      const id = String(req.id || '')
      store.upsertProvider({
        id,
        label: req.label || '',
        protocol: req.protocol,
        baseUrl: req.baseUrl,
        enabled: req.enabled !== false
      })

      if (typeof req.apiKey === 'string' && req.apiKey.length) {
        const written = store.setCredential(id, req.apiKey)
        // 钥匙串不可用时要**说清楚**：静默失败会让用户以为已经保存，下次发消息才报"没有密钥"。
        if (!written.ok) {
          return { ok: false, code: 'AI_KEYCHAIN', message: '系统钥匙串不可用，密钥未保存', provider: safeProvider(id) }
        }
      } else if (req.apiKey === '') {
        store.setCredential(id, '')
      }

      for (const model of Array.isArray(req.models) ? req.models : []) {
        if (model && model.id) store.upsertModel(id, model)
      }

      notify({ reason: 'providers', providerId: id })
      return { ok: true, provider: safeProvider(id) }
    },

    remove(req: UnknownRecord = {}) {
      const id = String(req.id || '')
      store.removeProvider(id)
      notify({ reason: 'providers', providerId: id })
      return { ok: true, id }
    },

    async test(req: UnknownRecord = {}) {
      const id = String(req.id || '')
      const provider = store.getProvider(id)
      if (!provider) throw fail('AI_NO_PROVIDER', '模型服务不存在')
      const apiKey = store.getCredential(id)
      if (!apiKey) throw fail('AI_NO_KEY', '该服务尚未保存密钥')

      const result = await testConnection({ provider, apiKey })
      if (!result || !result.ok) {
        return { ok: false, code: 'AI_TEST_FAILED', message: (result && result.message) || '连接失败' }
      }

      // 没配模型的服务：把探测到的目录直接灌进去（省掉手抄模型 id 的一步）。
      const discovered = Array.isArray(result.models) ? result.models : []
      let imported = 0
      if (discovered.length && !provider.models.length) {
        for (const m of discovered.slice(0, 100)) {
          if (!m || !m.id) continue
          store.upsertModel(id, { id: m.id, label: m.label || m.id })
          imported += 1
        }
        if (imported) notify({ reason: 'providers', providerId: id })
      }
      return { ok: true, models: discovered, imported, provider: safeProvider(id) }
    },

    upsertModel(req: UnknownRecord = {}) {
      const providerId = String(req.providerId || '')
      if (!store.getProvider(providerId)) throw fail('AI_NO_PROVIDER', '模型服务不存在')
      const model = store.upsertModel(providerId, req.model || {})
      notify({ reason: 'providers', providerId })
      return { ok: true, model }
    },

    removeModel(req: UnknownRecord = {}) {
      const providerId = String(req.providerId || '')
      store.removeModel(providerId, String(req.modelId || ''))
      notify({ reason: 'providers', providerId })
      return { ok: true }
    }
  }

  // ── 技能 ───────────────────────────────────────────────────────────
  // 全部行为在 main/skills.cjs（含内置保护 / 导入导出 / 按 kind 执行），这里只转发。
  const skills = {
    list: (req: UnknownRecord) => skillService.list(req),
    save: (req: UnknownRecord) => skillService.save(req),
    remove: (req: UnknownRecord) => skillService.remove(req),
    setEnabled: (req: UnknownRecord) => skillService.setEnabled(req),
    exportFile: (req: UnknownRecord) => skillService.exportFile(req),
    importFile: (req: UnknownRecord) => skillService.importFile(req),
    run: (req: UnknownRecord) => skillService.run(req)
  }

  // ── 用量 / 彻底移除 ────────────────────────────────────────────────
  function usage(req: UnknownRecord = {}) {
    const from = Number(req.from) || 0
    const to = Number(req.to) || Date.now()
    const items = store.usageSummary({ from, to, sessionId: req.sessionId || null })
    const totals = items.reduce((acc: { promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number; turns: number }, it: UnknownRecord) => {
      acc.promptTokens += Number(it.promptTokens) || 0
      acc.completionTokens += Number(it.completionTokens) || 0
      acc.cachedTokens += Number(it.cachedTokens) || 0
      acc.costUsd += Number(it.costUsd) || 0
      acc.turns += Number(it.turns) || 0
      return acc
    }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0 })
    return { ok: true, from, to, items, totals }
  }

  /**
   * 彻底移除（§5.2「数据默认保留」的例外，用户显式确认才走到这里）。
   * DROP 之后**立刻重建空表**：否则本进程里后续任何一次 AI 调用都会撞上"表不存在"。
   */
  function purge() {
    runner.dispose()
    try { subAgents?.dispose?.() } catch (_) {}
    approvals.dispose()
    // 授权记忆落库，DROP 前先把内存缓存丢掉，避免重建后仍读到旧工具名。
    try { grants.reset() } catch (_) {}
    store.purgeAll()
    attachments.removeAll()
    try { runAiMigrations(kernel.sqlite) } catch (e) {
      logger.warn && logger.warn('[ai] 重建 AI 表失败：', e instanceof Error ? e.message : String(e))
    }
    // 表被 DROP 重建 → 缓存里的共享状态必须一起归零，否则三个宿主还停在旧会话上。
    uiState.reset()
    notify({ reason: 'purged' })
    return { ok: true }
  }

  /**
   * `ai.invoke`（SINGLE）—— 主进程内的**一次性推理**入口（PART18 开放世界）。
   * （本函数与 `extensions()` 一起给 `ai-engine.cjs` 的 `extensionPoints()`：
   *  只挂实现，不重复声明槽位。）
   *
   * 插件的 `browser.ai.invoke(input, options)` 经 plugin-capabilities 转到这里：
   *   `{ input, options, pluginId }`
   * 契约文档里的写法则是 `{ prompt, system?, model?, sessionId? }` —— 两种都认。
   *
   * 走 completer（不落会话、不推流、不占运行槽），与「记忆摘要 / 子智能体」同一出口。
   * 不在这里另建模型客户端：否则重试、usage、思考字段必然与主链路漂移。
   */
  async function invokeAi(payload: unknown) {
    const raw = payload && typeof payload === 'object' ? payload as UnknownRecord : {}
    const options = raw.options && typeof raw.options === 'object' ? raw.options as UnknownRecord : {}
    const input = raw.input && typeof raw.input === 'object' ? raw.input as UnknownRecord : null
    const prompt = typeof raw.input === 'string'
      ? raw.input
      : String((input && input.prompt) || raw.prompt || '')
    if (!prompt.trim()) {
      const err = Object.assign(new Error('ai.invoke 需要非空 prompt'), { code: 'AI_BAD_ARGS' })
      throw err
    }
    if (!completer) throw fail('AI_NOT_READY', 'AI 补全服务尚未就绪')

    const sessionId = String((input && input.sessionId) || options.sessionId || raw.sessionId || '') || undefined
    const res = await completer.complete({
      sessionId,
      model: typeof (input?.model ?? options.model ?? raw.model) === 'string'
        ? String(input?.model ?? options.model ?? raw.model)
        : null,
      system: String((input && input.system) || raw.system || ''),
      messages: [{ role: 'user', blocks: [{ type: 'text', text: prompt }] }],
      maxOutputTokens: Number(options.maxOutputTokens) > 0 ? Number(options.maxOutputTokens) : undefined,
      timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : undefined
    })

    return {
      text: res.text,
      meta: {
        model: res.model,
        usage: res.usage,
        stopReason: res.stopReason,
        calls: Array.isArray(res.calls) ? res.calls.length : 0,
        pluginId: String(raw.pluginId || '')
      }
    }
  }

  function extensions() {
    return [
      { to: 'ai.context.provider', impl: (payload: unknown) => resolveContextItem(payload as { item?: unknown }) },
      { to: 'ai.invoke', impl: (payload: unknown) => invokeAi(payload) },
      { to: 'ai.engine.runtime', key: 'ai-engine-runtime', impl: () => runtimeService }
    ]
  }

  /** 菜单 / 快捷键的实现清单（由 intent 贡献，避免插件层去翻 `_internals`）。 */
  function intentExtensions() {
    return intent.extensions()
  }

  function dispose() {
    try { runner.dispose() } catch (_) {}
    try { approvals.dispose() } catch (_) {}
    try { intent.dispose() } catch (_) {}
  }

  return {
    state, listSessions, createSession, renameSession, deleteSession, messages,
    send, steer, retry, stop, approval, intentInvoke, capture, candidates, reveal,
    searchSessions, exportSession, auditExport,
    getUiState, setUiState,
    providers, skills, usage, purge,
    extensions, intentExtensions, dispose,
    // 供插件层做装配校验 / 未来设置页读状态（不是 IPC 面）
    _internals: { store, attachments, workspaces, intent, runner, approvals, grants, builder, toolRegistry, completer, subAgents, uiState }
  }
}

module.exports = { createEngine }
