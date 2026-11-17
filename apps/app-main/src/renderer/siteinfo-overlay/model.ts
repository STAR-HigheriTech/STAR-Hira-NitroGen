/**
 * SiteInfo Overlay Model —— 聚合状态机（浮层里**唯一**允许 invoke IPC 的地方）。
 *
 * ── 为什么所有数据动作都收在这里 ─────────────────────────────────────────
 * 浮层有 6 个 section，如果每个 section 自己拉数据、自己改状态，就会出现
 * 「权限区显示允许、拦截区显示旧值」这类对不上的问题，且新增区块还要再写一份。
 * 这里把「站点信息 = 一份状态」定死：section 只读 `getState()`，动作只 `emit()`，
 * 状态变更与写回 IPC 全部经本文件 —— 与 `ui-panel-permissions` 的编排思路一致。
 *
 * ── 并发与迟到响应 ───────────────────────────────────────────────────────
 * 打开浮层会同时发 6 个请求（权限 / 待处理 / Cookie / 证书 / 拦截状态 / 拦截计数）。
 * 每个请求独立落地（流式呈现，不互相等待）；用 `generation` 代际号丢弃
 * 「切换标签 / 关闭后重开」才回来的旧结果 —— 否则用户会看到上一个站点的证书。
 *
 * ── 动作语义 ─────────────────────────────────────────────────────────────
 *   · 权限改成「询问」= `permission:remove`（与权限面板的“清除”同一语义）；
 *   · 打开面板 / 页面信息 / 收起 = `overlay:commit` 交 app-shell（浮层不认路由）。
 *   · Cookie 只统计数量；增删改查是完整页面的职责（浮层不承载破坏性动作）。
 */

import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { isSameSite, siteInfoOfUrl } from '@hira-ng/shared-types/src/site.mjs'
import type { SiteInfo } from '@hira-ng/shared-types/src/site.mjs'

const NOTICE_TIMEOUT_MS = 4000

export interface SiteInfoTab {
  id?: string
  tabId?: string
  url?: string
  title?: string
  favicon?: string
}

export interface SiteInfoViewport {
  width: number
  height: number
}

export interface SiteInfoAnchor {
  left: number
  top: number
  width: number
  height: number
  align?: 'left' | 'right'
}

export interface SiteInfoContextState {
  anchor: SiteInfoAnchor | DOMRect | null
  site: SiteInfo | null
  tab: SiteInfoTab | null
  viewport: SiteInfoViewport | null
}

export interface SiteInfoPermissionRule {
  type: string
  setting: string
}

export interface SiteInfoPendingPermission {
  id: string
  origin: string
  type: string
  sensitive?: boolean
  tabId?: string | null
}

export interface SiteInfoCertificate {
  subjectName?: string
  issuerName?: string
  validStart?: string | number | null
  validExpiry?: string | number | null
  serialNumber?: string
  fingerprint?: string
  san?: string[]
}

export interface SiteInfoState {
  open: boolean
  status: string
  context: SiteInfoContextState
  permissions: {
    available: boolean
    loading: boolean
    rules: SiteInfoPermissionRule[]
    pending: SiteInfoPendingPermission[]
    busyType: string | null
    busyRequestId: string | null
  }
  certificate: {
    loading: boolean
    secure: boolean
    protocol: string
    certificate: SiteInfoCertificate | null
    certificateChain: SiteInfoCertificate[]
    error: string | null
  }
  cookies: { loading: boolean; count: number }
  blocking: { loading: boolean; enabled: boolean; level: string; count: number; busy: boolean }
  notice: { kind: string; message: string } | null
}

interface SiteInfoOpenContext {
  anchor?: SiteInfoAnchor | DOMRect | null
  site?: SiteInfo | null
  tab?: SiteInfoTab | null
  viewport?: SiteInfoViewport | null
  focus?: boolean
  focusSection?: string
}

interface SiteInfoInvokeResponse {
  ok?: boolean
}

interface SiteInfoCookieResponse {
  cookies?: unknown[]
}

interface SiteInfoSecurityResponse {
  tabId?: string
  secure?: boolean
  protocol?: string
  certificate?: SiteInfoCertificate | null
  certificateChain?: SiteInfoCertificate[]
  error?: string | null
}

interface SiteInfoBlockingResponse {
  enabled?: boolean
  level?: string
}

/** 空上下文：关闭 / 无活动页面时 section 仍会收到一次 update，不能给 undefined。 */
function emptyContext(): SiteInfoContextState {
  return { anchor: null, site: null, tab: null, viewport: null }
}

function emptyState(): SiteInfoState {
  return {
    open: false,
    status: 'idle',
    context: emptyContext(),
    permissions: {
      available: true,
      loading: false,
      rules: [],
      pending: [],
      busyType: null,
      busyRequestId: null
    },
    certificate: {
      loading: false,
      secure: false,
      protocol: '',
      certificate: null,
      certificateChain: [],
      error: null
    },
    cookies: { loading: false, count: 0 },
    blocking: { loading: false, enabled: true, level: '', count: 0, busy: false },
    notice: null
  }
}


/** 权限规则对象 → 有序数组（`permission:get-site` 的响应是 `{ [type]: setting }`）。 */
function rulesOf(map: unknown): SiteInfoPermissionRule[] {
  if (!map || typeof map !== 'object') return []
  const record = map as Record<string, unknown>
  return Object.keys(map)
    .filter((type) => typeof record[type] === 'string')
    .map((type) => ({ type, setting: String(record[type]) }))
}

/**
 * @param {{
 *   invoke: (channel: string, payload?: object) => Promise<unknown>,
 *   subscribe?: (channel: string, handler: (payload: unknown) => void) => (() => void) | void,
 *   commit: (payload: object) => void
 * }} deps
 */
export function createSiteInfoModel(deps: {
  invoke: <T = Record<string, unknown>>(channel: string, payload?: object) => Promise<T>,
  subscribe?: (channel: string, handler: (payload: unknown) => void) => (() => void) | void,
  commit: (payload: object) => void
}) {
  const invoke = deps.invoke
  const commit = deps.commit
  const listeners = new Set<(state: ReturnType<typeof emptyState>) => void>()

  /**
   * 规则落库成功后的广播：地址栏按钮的「规则圆点」由外壳维护，
   * 浮层不直接摸按钮，只报「这本规则变了」。
   */
  function notifyRulesChanged() {
    commit({ kind: 'siteinfo-action', action: 'rules-changed' })
  }

  let state = emptyState()
  /** 代际号：每次换站 / 重新打开 +1，迟到响应一律丢弃。 */
  let generation = 0
  /** @type {ReturnType<typeof setTimeout>|null} */
  let noticeTimer: ReturnType<typeof setTimeout>|null = null

  function notify() {
    const snapshot = state
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('[siteinfo] listener failed', error)
      }
    }
  }

  function clearNoticeTimer() {
    if (!noticeTimer) return
    clearTimeout(noticeTimer)
    noticeTimer = null
  }

  function setNotice(kind: string, message: string) {
    clearNoticeTimer()
    state.notice = { kind, message }
    notify()
    noticeTimer = setTimeout(() => {
      noticeTimer = null
      if (!state.notice) return
      state.notice = null
      notify()
    }, NOTICE_TIMEOUT_MS)
  }

  /** 优先用外壳摊平好的站点信息；兜底从 tab.url 解析（浮层永远不自己拼 URL）。 */
  function resolveSite(context: SiteInfoOpenContext | null | undefined) {
    const direct = context?.site
    if (direct && direct.url) return direct
    return siteInfoOfUrl(context?.tab?.url)
  }

  // ── 数据拉取：各自落地、各自 notify ─────────────────────────────────────
  async function loadPermissions(gen: number) {
    const site = state.context.site
    if (!site) return
    try {
      const map = await invoke<Record<string, unknown>>(IPC_ROUTES.permissionGetSite, { origin: site.origin })
      if (gen !== generation) return
      state.permissions = {
        ...state.permissions,
        available: true,
        rules: rulesOf(map),
        loading: false
      }
    } catch (_) {
      if (gen !== generation) return
      // 权限域不可用（插件禁用 / IPC 失败）→ 整区隐藏，而不是展示空状态。
      state.permissions = { ...state.permissions, available: false, rules: [], loading: false }
    }
    notify()
  }

  async function loadPending(gen: number) {
    const site = state.context.site
    if (!site) return
    try {
      const list = await invoke<unknown[]>(IPC_ROUTES.permissionPendingList, {})
      if (gen !== generation) return
      const pending = (Array.isArray(list) ? list : []).filter((request): request is SiteInfoPendingPermission => {
        if (!request || typeof request !== 'object') return false
        const candidate = request as Record<string, unknown>
        return typeof candidate.id === 'string' &&
          typeof candidate.origin === 'string' &&
          typeof candidate.type === 'string'
      }).filter((request) => {
        const originSite = siteInfoOfUrl(request?.origin)
        return originSite ? isSameSite(originSite.domain, site.domain) : false
      })
      state.permissions = { ...state.permissions, pending }
    } catch (_) {
      if (gen !== generation) return
      state.permissions = { ...state.permissions, pending: [] }
    }
    notify()
  }

  async function loadCookies(gen: number) {
    const site = state.context.site
    if (!site) return
    try {
      // ⚠ domain 键是 hostname（不带端口）：cookie 存储按 host 匹配，带端口会查空。
      const result = await invoke<SiteInfoCookieResponse>(IPC_ROUTES.cookieList, { domain: site.hostname })
      if (gen !== generation) return
      const cookies = Array.isArray(result?.cookies) ? result.cookies : []
      state.cookies = { ...state.cookies, loading: false, count: cookies.length }
    } catch (_) {
      if (gen !== generation) return
      state.cookies = { ...state.cookies, loading: false }
    }
    notify()
  }

  async function loadCertificate(gen: number) {
    const site = state.context.site
    const tab = state.context.tab
    if (!site) {
      state.certificate = {
        ...state.certificate,
        loading: false,
        certificate: null,
        certificateChain: [],
        error: null
      }
      notify()
      return
    }
    try {
      const info = await invoke<SiteInfoSecurityResponse>(IPC_ROUTES.securitySite, {})
      if (gen !== generation) return
      // 主进程回的 tabId 与当前标签不一致 = 切标签后迟到的旧结果。
      if (info?.tabId && tab?.id && String(info.tabId) !== String(tab.id)) return
      state.certificate = {
        loading: false,
        secure: !!info?.secure,
        protocol: info?.protocol || '',
        certificate: info?.certificate || null,
        certificateChain: Array.isArray(info?.certificateChain) ? info.certificateChain : [],
        error: info?.error || null
      }
    } catch (error) {
      if (gen !== generation) return
      state.certificate = {
        ...state.certificate,
        loading: false,
        certificate: null,
        certificateChain: [],
        error: error instanceof Error ? error.message : 'unknown'
      }
    }
    notify()
  }

  async function loadBlocking(gen: number) {
    const [statusResult, countResult] = await Promise.allSettled([
      invoke<SiteInfoBlockingResponse>(IPC_ROUTES.adblockerStatus, {}),
      invoke<number>(IPC_ROUTES.adblockerBlockedCount, {})
    ])
    if (gen !== generation) return

    const status = statusResult.status === 'fulfilled' ? statusResult.value : null
    const count = countResult.status === 'fulfilled' ? Number(countResult.value) : NaN
    state.blocking = {
      ...state.blocking,
      loading: false,
      enabled: status ? status.enabled !== false : state.blocking.enabled,
      level: status?.level || state.blocking.level,
      count: Number.isFinite(count) ? count : state.blocking.count
    }
    notify()
  }

  function loadAll(gen: number) {
    const site = state.context.site
    if (!site) {
      state.status = 'ready'
      state.permissions.loading = false
      state.cookies.loading = false
      state.blocking.loading = false
      notify()
      return
    }
    const tasks = [
      loadPermissions(gen),
      loadPending(gen),
      loadCookies(gen),
      loadCertificate(gen),
      loadBlocking(gen)
    ]
    Promise.allSettled(tasks).then(() => {
      if (gen !== generation) return
      state.status = 'ready'
      notify()
    })
  }

  // ── 动作（section → emit → 这里）──────────────────────────────────────
  async function setPermission(payload: Record<string, unknown> | undefined) {
    const type = typeof payload?.type === 'string' ? payload.type : ''
    const setting = typeof payload?.setting === 'string' ? payload.setting : ''
    const site = state.context.site
    if (!site || !type || !setting) return
    if (state.permissions.busyType) return

    const gen = generation
    const before = state.permissions.rules
    const next = setting === 'ask'
      ? before.filter((rule) => rule.type !== type)
      : (before.some((rule) => rule.type === type)
          ? before.map((rule) => (rule.type === type ? { ...rule, setting } : rule))
          : [...before, { type, setting }])

    // 乐观更新：下拉立即停在用户选的那一档；失败再回滚成真值。
    state.permissions = { ...state.permissions, rules: next, busyType: type }
    notify()

    try {
      const result = setting === 'ask'
        ? await invoke<SiteInfoInvokeResponse>(IPC_ROUTES.permissionRemove, { origin: site.origin, permissionType: type })
        : await invoke<SiteInfoInvokeResponse>(IPC_ROUTES.permissionSet, { origin: site.origin, permissionType: type, setting })
      // { ok:false } 是**正常 resolve 的失败**（类型非法 / 域名为空 / 插件被禁用）：
      // 不检查它就会把没落库的规则画成已生效，用户下次打开站点又变回原样。
      if (result && result.ok === false) throw new Error('permission-set-rejected')
      if (gen !== generation) return
      await loadPermissions(gen)
      notifyRulesChanged()
    } catch (_) {
      if (gen !== generation) return
      state.permissions = { ...state.permissions, rules: before }
      setNotice('error', '权限设置失败，请稍后重试')
    } finally {
      if (gen === generation) {
        state.permissions = { ...state.permissions, busyType: null }
        notify()
      }
    }
  }

  async function respondPermission(payload: Record<string, unknown> | undefined) {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return
    const gen = generation

    state.permissions = { ...state.permissions, busyRequestId: id }
    notify()

    try {
      const result = await invoke<SiteInfoInvokeResponse>(IPC_ROUTES.permissionRespond, {
        id,
        allow: !!payload?.allow,
        persist: !!payload?.persist
      })
      if (gen !== generation) return
      // ok:false = 主进程没有这条 pending（已被别处响应 / 页面已导航销毁）。
      // 不能当成成功：那只是把本地列表擦掉，网页侧的 Electron callback 仍在等回答。
      // 以主进程的列表为准重新对齐，用户能看到真实状态。
      if (result && result.ok === false) {
        state.permissions = { ...state.permissions, busyRequestId: null }
        notify()
        setNotice('error', '该权限请求已失效，可能已被处理')
        await loadPending(gen)
        return
      }
      state.permissions = {
        ...state.permissions,
        pending: state.permissions.pending.filter((request) => request.id !== id),
        busyRequestId: null
      }
      notify()
      await loadPermissions(gen)
      notifyRulesChanged()
    } catch (_) {
      if (gen !== generation) return
      state.permissions = { ...state.permissions, busyRequestId: null }
      setNotice('error', '权限响应失败，请重试')
    }
  }

  async function toggleAdblocker(payload: Record<string, unknown> | undefined) {
    if (state.blocking.busy) return
    const gen = generation
    const before = state.blocking.enabled
    const enabled = !!payload?.enabled

    state.blocking = { ...state.blocking, enabled, busy: true }
    notify()

    try {
      await invoke<SiteInfoInvokeResponse>(IPC_ROUTES.adblockerToggle, { enabled })
      if (gen !== generation) return
      const status = await invoke<SiteInfoBlockingResponse>(IPC_ROUTES.adblockerStatus, {})
      if (gen !== generation) return
      state.blocking = {
        ...state.blocking,
        enabled: status ? status.enabled !== false : enabled,
        level: status?.level || state.blocking.level,
        busy: false
      }
      notify()
    } catch (_) {
      if (gen !== generation) return
      state.blocking = { ...state.blocking, enabled: before, busy: false }
      setNotice('error', '内容拦截开关切换失败')
    }
  }

  /** 浮层内的「走出去」动作：不认目标面板，原样交 app-shell 路由。 */
  function requestAction(action: string) {
    commit({ kind: 'siteinfo-action', action })
  }

  function dispatch(action: string, payload?: object) {
    const data = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : undefined
    switch (action) {
      case 'permission-set':
        setPermission(data)
        return
      case 'permission-respond':
        respondPermission(data)
        return
      case 'adblocker-toggle':
        toggleAdblocker(data)
        return
      case 'open-permissions':
      case 'open-cookies':
      case 'open-certificates':
      case 'open-page-info':
        requestAction(action)
        return
      case 'dismiss':
        commit({ kind: 'siteinfo-dismiss' })
        return
      default:
        break
    }
  }

  // ── 打开 / 关闭 ────────────────────────────────────────────────────────
  function open(context: SiteInfoOpenContext) {
    const site = resolveSite(context)
    const sameSite = state.open && isSameSite(state.context.site?.domain, site?.domain)

    state.open = true
    state.context = {
      anchor: context?.anchor || null,
      site,
      tab: context?.tab || null,
      viewport: context?.viewport || null
    }

    // 同一个站点的再次 show（窗口 resize / 锚点移动）只更新几何，不重拉数据、不闪。
    if (sameSite) {
      notify()
      return
    }

    const gen = ++generation
    clearNoticeTimer()
    state.status = 'loading'
    state.notice = null
    state.permissions = {
      available: true,
      loading: !!site,
      rules: [],
      pending: [],
      busyType: null,
      busyRequestId: null
    }
    state.certificate = {
      loading: !!site,
      secure: !!(site && site.secure),
      protocol: '',
      certificate: null,
      certificateChain: [],
      error: null
    }
    state.cookies = { loading: !!site, count: 0 }
    state.blocking = {
      loading: true,
      enabled: state.blocking.enabled,
      level: state.blocking.level,
      count: 0,
      busy: false
    }
    notify()
    loadAll(gen)
  }

  function close() {
    if (!state.open) return
    generation += 1
    clearNoticeTimer()
    state = emptyState()
    notify()
  }

  /** 主动重拉当前站点（窗口重新获得焦点等场景的扩展入口）。 */
  function refresh() {
    if (!state.open) return
    const gen = ++generation
    state.status = 'loading'
    state.certificate = { ...state.certificate, loading: !!state.context.site }
    state.cookies = { ...state.cookies, loading: !!state.context.site }
    state.permissions = { ...state.permissions, loading: !!state.context.site }
    state.blocking = { ...state.blocking, loading: true }
    notify()
    loadAll(gen)
  }

  // ── 外部数据事件：只刷新对应区块 ───────────────────────────────────────
  const unsubscribers: Array<() => void> = []
  const subscribe = deps.subscribe
  if (typeof subscribe === 'function') {
    const on = (channel: string, handler: (payload: unknown) => void) => {
      const off = subscribe.call(deps, channel, handler)
      if (typeof off === 'function') unsubscribers.push(off)
    }

    on(IPC_EVENTS.permissionRequest, (payload) => {
      if (!state.open || !state.context.site) return
      const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const origin = typeof event.origin === 'string' ? event.origin : ''
      const eventTabId = typeof event.tabId === 'string' ? event.tabId : ''
      const originSite = siteInfoOfUrl(origin)
      const belongs = originSite
        ? isSameSite(originSite.domain, state.context.site.domain)
        : (!eventTabId || eventTabId === String(state.context.tab?.id || ''))
      if (!belongs) return
      loadPending(generation)
    })

    on(IPC_EVENTS.permissionCleared, () => {
      if (!state.open) return
      loadPermissions(generation)
      loadPending(generation)
    })

    on(IPC_EVENTS.adblockerChanged, (payload) => {
      if (!state.open) return
      const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      // 事件现在是全 profile 广播；浮层不认识自己的 profileId，不能把别的 profile
      // 的拦截状态乐观写进当前卡片。统一回到发送方作用域重新取一次真实值。
      if (typeof event.profileId === 'string' && event.profileId) {
        loadBlocking(generation)
        return
      }
      if (typeof event.enabled === 'boolean') {
        state.blocking = {
          ...state.blocking,
          loading: false,
          enabled: event.enabled,
          level: typeof event.level === 'string' ? event.level : state.blocking.level
        }
        notify()
      }
      loadBlocking(generation)
    })

    on(IPC_EVENTS.extensionChanged, (payload) => {
      if (!state.open) return
      const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (event.type === 'action-updated') return
      loadBlocking(generation)
    })
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (state: SiteInfoState) => void) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open,
    close,
    refresh,
    dispatch,
    destroy() {
      generation += 1
      clearNoticeTimer()
      listeners.clear()
      for (const off of unsubscribers) {
        try {
          off()
        } catch (_) {
          // 单个订阅清理失败不应阻断其它订阅释放。
        }
      }
      unsubscribers.length = 0
    }
  }
}


