// @ts-check
/**
 * site-guard.js —— 「页面行为」型权限的**统一策略**（弹窗 / 自动下载）
 *
 * ── 为什么必须只有这一处 ────────────────────────────────────────────────
 * 「一次弹多个窗口」「连续触发多次下载」在过去完全无人管：Electron 的
 * `setWindowOpenHandler` 一律 `allow`（见 infra-window#tabEvents），
 * `will-download` 一律落库开下（见 download-manager）。两条链路各写一份
 * "数一数、超了就拦"的规则，必然漂移（一边算窗口、一边算时间，阈值还不一样）。
 * 所以把**两类行为的判定**收进这一个模块：新增一类（例如"重复推送通知"）
 * 只需要往 `GUARD_KINDS` 里加一行，两个接入点（弹窗 / 下载）不再各改一次。
 *
 * ── 判定口径（对齐 Chrome / Edge 的"站点行为"设置）─────────────────────
 * 规则本身**复用权限表**（domain-permission）：站点「允许 / 阻止 / 询问」三态，
 * 与摄像头、通知等是同一张表、同一个设置页、同一个询问浮层 —— 不另造一套存储。
 *   · allow  → 直接放行（用户已明确允许该站点弹窗 / 自动下载）
 *   · block  → 直接拒绝
 *   · ask    → **先看用户激活**：用户刚亲手点过 / 按过回车（`noteUserGesture`），
 *              这次动作就是他点的，直接放行且**不计数**；
 *              没有用户激活才按限流判：突发（2 秒 1 个）+ 持续（1 分钟 N 个），
 *              超额就拦下这次动作并登记一条询问（`popup` / `automatic-downloads`）。
 *
 * 为什么必须有"用户激活"这一层：只按次数限流会把**用户自己点链接开新标签**
 * 也当成刷屏（实测：手点几次就开始询问，甚至点一次也问，因为同一站点的点击
 * 在一个 60 秒窗口里累积）。主流浏览器的口径是"只有页面脚本在没有用户激活时
 * 连续开窗才拦"，这里用同一条口径：一次点击 = 一次放行额度，用完即止。
 *
 * 两级限流缺一不可：只有突发窗口时，一个每 2 秒弹一个的站点每秒都算"窗口内第一个"
 * —— 表现就是用户实测到的"时不时慢慢一个个弹出来，永远不触发询问"。
 *
 * ── 为什么计数按**站点**、不按发起页面（踩过的坑）─────────────────────────
 * 曾按 webContents 计数，结果被"弹窗链"钻了空子：页面弹 A，A 再弹 B，B 再弹 C ——
 * 每个新窗口都是一个新 scope，各自都有"第一次免询问"额度，于是**允许**了只放出
 * 两三个就没了、**阻止**了还照样漏一两个。计数键改成站点维度后，整条链共用同一份
 * 额度：拦就是整条链一起拦，放就是整条链一起放。
 * 代价是同站点的另一个标签也共享额度 —— 这与真实浏览器"自动弹窗是站点行为"的口径一致。
 *
 * ── 「允许一次 / 阻止一次」的寿命（必须与页面实例同步）──────────────────
 * 用户点下决定时，这个站点的这两类行为就已经定性了，再去数一次、再问一次只会
 * 让人觉得"允许了也没用 / 阻止了还漏"。因此：
 *   · 允许一次 → `allowances`：本页会话内这个站点直接放行；
 *   · 阻止一次 → `silences`：静默一段时间（默认 5 分钟）内直接拒绝 ——
 *     不设静默的话，被拦的动作会一个接一个重新触发询问。
 *     **静默只拦"没有用户激活"的动作**：用户自己点出来的窗口照开（那是他点的那一下；
 *     真正要整站禁掉的是「始终阻止」，它落权限表、在用户激活之前就被判掉）。
 * **两者都必须随页面实例作废**，否则会变成实测到的那条"除非重启浏览器"：
 *   · 主框架整页导航 / webContents 销毁 → `resetForScope()`（main.js 挂原生事件）；
 *   · 权限表规则被改写（含「清除」）→ `onRulesChanged()`（domain-permission 广播）。
 * 两者都是**瞬时状态**，不落库；跨重启要留下来的决定由权限表（「始终允许 / 始终阻止」）负责。
 *
 * ── 边界（刻意不做的事）────────────────────────────────────────────────
 *   · 只认 http(s) 页面发起的动作：`hira://` 内部页、`file://` 界面、扩展页、侧栏 /
 *     PWA 子窗口都不参与（它们不是"站点"，也没有可询问的归属）。
 *   · 权限引擎被关掉（`isFeatureOn('permissions') === false`）时只放行**用户亲手触发**
 *     的动作；后台自动弹窗 / 下载默认拒绝。没有界面询问不等于允许脚本无限放行。
 *   · 所有判定同步返回（Electron 的 `setWindowOpenHandler` 只在这一拍有效）。
 *     权限表是 SQLite 同步读，因此整条链路天然同步，不需要 await。
 */

import { normalizeDomain } from '@hira-ng/shared-utils'

interface GuardSpec {
  windowMs: number
  allowPerWindow: number
  slowWindowMs: number
  slowAllow: number
  denySilenceMs: number
}

interface WebContentsPort {
  id?: number
  isDestroyed?(): boolean
  getURL?(): string
}

interface GuardPayload {
  webContents?: WebContentsPort | null
  url?: unknown
  filename?: unknown
}

interface PermissionServicePort {
  resolveRequest(origin: string, kind: string): string
  createRequest(origin: string, kind: string, callback: (allow: boolean) => void, scopeId?: number | string): unknown
}

interface SiteGuardDependencies {
  permissionService: PermissionServicePort
  runAsProfile?<T>(profileId: string, task: () => T): T
  getProfileIdOfContents?(webContents: WebContentsPort): string
  isFeatureOn?(featureId: string): boolean
}

/**
 * 受管的动作类型 → 阈值。类型名必须同时是 `PERMISSION_TYPES` 里的规范类型
 * （shared-types#permission-labels.mjs）—— 权限页 / 站点信息浮层才能把它画出来。
 *
 * 阈值是这套策略**唯一的可调面**：新增一类行为只需在这里加一行，两个接入点都不动。
 *
 * @type {Readonly<Record<string, Readonly<{
 *   windowMs: number,        // 突发窗口
 *   allowPerWindow: number,  // 突发窗口内免询问的放行次数
 *   slowWindowMs: number,    // 持续窗口（防"慢慢一个个弹"）
 *   slowAllow: number,       // 持续窗口内免询问的放行次数
 *   denySilenceMs: number    // 用户「阻止一次」后的静默时长
 * }>>>
 */
export const GUARD_KINDS: Readonly<Record<string, GuardSpec>> = Object.freeze({
  // 弹窗：2 秒内只放第一个 + 1 分钟内最多 3 个。
  // 真实站点"点一下开一个窗口"仍然免打扰；一次弹一串、或每 2 秒滴一个的，
  // 都会在第 4 个被拦下并询问（se.360.cn/labs8_test.html 属于这一类）。
  popup: Object.freeze({
    windowMs: 2000,
    allowPerWindow: 1,
    slowWindowMs: 60000,
    slowAllow: 3,
    denySilenceMs: 5 * 60 * 1000
  }),
  // 自动下载：10 秒内只放第一个 + 1 分钟内最多 3 个。
  // 用户手点一次下载不受影响；站点脚本批量拉文件时，第二个起询问。
  'automatic-downloads': Object.freeze({
    windowMs: 10000,
    allowPerWindow: 1,
    slowWindowMs: 60000,
    slowAllow: 3,
    denySilenceMs: 5 * 60 * 1000
  })
})

/** 过期条目清理的触发水位（超过才扫，避免每次判定都全表遍历）。 */
const PRUNE_AT = 256

/**
 * 算"用户激活"的输入事件类型（webContents 的 `input-event`）。
 *
 * 只收**按下**那一刻：`mouseUp` 必须排除 —— 一次点击会先 `mouseDown`（页面在这里
 * 可能已经开了窗、把额度用掉）再来 `mouseUp`，若它在刷新额度，等于一次点击白送
 * 两次放行。`mouseMove` / `mouseWheel` 同理不算激活（Chrome 的 transient activation
 * 也是 click / keydown / touchstart 这类）。
 */
const ACTIVATION_INPUTS: ReadonlySet<string> = Object.freeze(new Set<string>(['mouseDown', 'keyDown', 'touchStart']))

/** @param {unknown} type @returns {boolean} 这次输入事件是否构成用户激活 */
export function isActivationInput(type: unknown): boolean {
  return typeof type === 'string' && ACTIVATION_INPUTS.has(type)
}

/** 用户激活的有效期（对齐 Chrome 的 transient activation ≈ 5 秒）。 */
const GESTURE_WIN_MS = 5000

/**
 * 从 URL 取站点 origin；非 http(s)（含 blob / file / hira / chrome-extension）返回 ''。
 * @param {unknown} value
 * @returns {string}
 */
function originOfUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.origin && u.origin !== 'null' ? u.origin : ''
  } catch (_) {
    return ''
  }
}

/** @param {any} wc @returns {string} */
function pageUrlOf(wc: WebContentsPort): string {
  try { return typeof wc.getURL === 'function' ? String(wc.getURL() || '') : '' } catch (_) { return '' }
}

/**
 * @param {Object} deps
 * @param {object} deps.permissionService  domain-permission 实例（**按 profile 的 Proxy**）
 * @param {(profileId:string, fn:Function)=>any} [deps.runAsProfile]  进入 profile 作用域
 * @param {(wc:any)=>string} [deps.getProfileIdOfContents]  webContents → profile id
 * @param {(featureId:string)=>boolean} [deps.isFeatureOn]  功能面开关（缺省视为开）
 * @returns {{ evaluatePopup: (payload:object)=>boolean, evaluateDownload: (payload:object)=>boolean, kinds: typeof GUARD_KINDS }}
 */
export function createSiteGuard(deps: SiteGuardDependencies) {
  const { permissionService, runAsProfile, getProfileIdOfContents, isFeatureOn } = deps

  // ── 纯内存的瞬时状态 ────────────────────────────────────────────────────
  // key = `profile|domain|kind`（**站点维度**：弹窗链上的每个新窗口都算同一个站点）
  //   · buckets    —— 两级限流计数（突发 + 持续）
  //   · allowances —— 用户点过「允许一次」→ 该站点这一类动作直接放行（owner = 发起页面）
  //   · silences   —— 用户点过「阻止一次」→ 静默窗口内直接拒绝（owner = 发起页面）
  //   · asking     —— 正在询问中的键（同一次突发只登记一条，浮层里不会刷出一排）
  //   · gestures   —— 用户激活（按下的时间 + 是否已用掉），见 takeGesture
  /** @type {Map<string, {start:number, count:number, slowStart:number, slowCount:number, owner:string}>} */
  const buckets: Map<string, {start:number, count:number, slowStart:number, slowCount:number, owner:string}> = new Map<string, { start: number; count: number; slowStart: number; slowCount: number; owner: string }>()
  /** @type {Map<string, {owner:string}>} */
  const allowances: Map<string, {owner:string}> = new Map<string, { owner: string }>()
  /** @type {Map<string, {until:number, owner:string}>} */
  const silences: Map<string, {until:number, owner:string}> = new Map<string, { until: number; owner: string }>()
  /** @type {Map<string, true>} */
  const asking: Map<string, true> = new Map<string, true>()
  /** @type {Map<string, {at:number, used:boolean}>} */
  const gestures: Map<string, {at:number, used:boolean}> = new Map<string, { at: number; used: boolean }>()

  function prune(): void {
    if (buckets.size + silences.size < PRUNE_AT) return
    const ts = Date.now()
    for (const [k, v] of buckets) if (ts - v.slowStart > 5 * 60 * 1000) buckets.delete(k)
    for (const [k, v] of silences) if (v.until <= ts) silences.delete(k)
    for (const [k, v] of gestures) if (ts - v.at > GESTURE_WIN_MS) gestures.delete(k)
  }

  /**
   * 记一次用户激活（main.js 把 webContents 的 `input-event` 里"按下"那几类送进来）。
   * **每次按下只买一次放行额度**：点一次开一个窗口是本分，脚本紧跟其后连开的一串
   * 不该白蹭这次点击。
   * @param {number|string|undefined} scopeId 发起动作的 webContents id
   */
  function noteUserGesture(scopeId: number | string | null | undefined): void {
    const id = scopeId == null ? '' : String(scopeId)
    if (!id) return
    gestures.set(id, { at: Date.now(), used: false })
  }

  /**
   * 取用一次用户激活额度（同步消费：同一次点击的第二次调用就拿不到了）。
   * @param {string} owner 发起动作的 webContents id（字符串）
   * @returns {boolean} true = 这次动作是用户亲手触发的
   */
  function takeGesture(owner: string): boolean {
    if (!owner) return false
    const g = gestures.get(owner)
    if (!g) return false
    if (Date.now() - g.at > GESTURE_WIN_MS) { gestures.delete(owner); return false }
    if (g.used) return false
    g.used = true
    return true
  }

  /**
   * 进入发起方 webContents 所属 profile 的作用域后执行。
   * 与 main.js#attachPermissionHandlers 同一原因：这些事件来自 webContents 原生回调，
   * AsyncLocalStorage 里没有 IPC sender，不显式进入就会落到错误的权限库。
   * @template T @param {any} wc @param {() => T} fn @returns {T}
   */
  function runScoped<T>(wc: WebContentsPort, fn: () => T): T {
    try {
      const pid = typeof getProfileIdOfContents === 'function' ? getProfileIdOfContents(wc) : ''
      if (pid && typeof runAsProfile === 'function') return runAsProfile(pid, fn)
    } catch (_) {}
    return fn()
  }

  /**
   * 一次动作的判定（同步）。
   * @param {string} kind 权限类型（`popup` / `automatic-downloads`）
   * @param {any} payload `{ webContents, url, filename? }`
   * @returns {boolean} true = 放行本次动作
   */
  function evaluate(kind: string, payload: GuardPayload): boolean {
    const spec = GUARD_KINDS[kind]
    if (!spec) {
      console.warn(`[site-guard] 未登记的行为类型，已拒绝: ${kind}`)
      return false
    }
    const wc = payload && payload.webContents
    if (!wc) return true
    try { if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return true } catch (_) { return true }
    // 归属站点 = **发起动作的那个页面**（不是目标地址）：弹窗打开的是别域名、
    // 下载的是 CDN 文件，要的是"哪个站点在弹 / 在下"，与 Chrome 口径一致。
    const owner = wc.id == null ? '' : String(wc.id)
    const senderPageUrl = pageUrlOf(wc)
    let senderProtocol = ''
    let senderHost = ''
    try {
      const parsed = new URL(senderPageUrl)
      senderProtocol = parsed.protocol
      senderHost = parsed.hostname.toLowerCase()
    } catch (_) {}
    const thirdPartyDocument = senderProtocol === 'hira-game:' ||
      senderProtocol === 'hira-plugin:' ||
      senderProtocol === 'chrome-extension:' ||
      senderProtocol === 'data:' ||
      senderProtocol === 'blob:' ||
      senderProtocol === 'about:' ||
      (senderProtocol === 'hira:' && senderHost.startsWith('p-'))
    // Local application chrome is trusted; third-party bundles and extension pages
    // may only open popups/downloads in response to a real user gesture.
    if (thirdPartyDocument) return takeGesture(owner)

    const origin = originOfUrl(senderPageUrl) || originOfUrl(payload.url)
    if (!origin) return true

    // profile 也进 key：A 用户「允许一次」过某站点，不能在 B 用户下同样静默放行 ——
    // 权限表本身就是按 profile 的，瞬时状态必须同理。
    let profileId = ''
    try {
      profileId = typeof getProfileIdOfContents === 'function'
        ? String(getProfileIdOfContents(wc) || '') : ''
    } catch (_) { profileId = '' }

    return runScoped(wc, () => {
      if (typeof isFeatureOn === 'function' && !isFeatureOn('permissions')) return takeGesture(owner)
      return decide(kind, spec, origin, wc.id, profileId)
    })
  }

  /**
   * @param {string} kind
   * @param {typeof GUARD_KINDS[string]} spec
   * @param {string} origin
   * @param {number|string|undefined} scopeId 只用于把询问浮层归属到发起标签（不参与计数）
   * @param {string} profileId 决定属于哪个用户（瞬时状态按 profile 隔离）
   * @returns {boolean}
   */
  function decide(kind: string, spec: GuardSpec, origin: string, scopeId: number | string | undefined, profileId: string): boolean {
    let rule = 'ask'
    try {
      rule = permissionService.resolveRequest(origin, kind)
    } catch (e) {
      console.warn('[site-guard] 读取权限规则失败，仅保留用户手势放行:', e instanceof Error ? e.message : String(e))
      return takeGesture(scopeId == null ? '' : String(scopeId))
    }
    if (rule === 'allow') return true
    if (rule === 'block') return false
    // `unsupported` = 类型没进 PERMISSION_TYPES（配置错误）。放行并留一条警告，
    // 未注册类型属于宿主配置错误，不能因此默认放行自动行为。
    if (rule === 'unsupported') {
      console.warn(`[site-guard] 权限类型未注册，已拒绝: ${kind}`)
      return false
    }

    // 用户亲手触发（点链接 / 回车 / 触摸）→ 放行且**不计数**，一次激活只买一次额度。
    // 必须排在限流之前：主流浏览器只拦"没有用户激活却连开多个窗口"的脚本行为，
    // 用户点一次开一个窗口不该被打扰，更不该把这次点击累积进后面几次的额度里。
    const owner = scopeId == null ? '' : String(scopeId)
    if (takeGesture(owner)) return true

    const key = `${profileId}|${normalizeDomain(origin) || origin}|${kind}`
    const ts = Date.now()

    // 本页会话内用户已经点过「允许一次」→ 这个站点的这类动作不再计数、不再问。
    // 整页导航 / 标签销毁时由 resetForScope 作废（见文件头"寿命"一段）。
    if (allowances.has(key)) return true
    const silence = silences.get(key)
    if (silence) {
      if (silence.until > ts) return false
      silences.delete(key)
    }
    prune()

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { start: ts, count: 0, slowStart: ts, slowCount: 0, owner }
      buckets.set(key, bucket)
    }
    if (ts - bucket.start > spec.windowMs) { bucket.start = ts; bucket.count = 0 }
    if (ts - bucket.slowStart > spec.slowWindowMs) { bucket.slowStart = ts; bucket.slowCount = 0 }
    bucket.count += 1
    bucket.slowCount += 1

    // 两个额度都还有 → 照常放行（正常的"点一下开一个 / 下一次文件"不该被打扰）。
    if (bucket.count <= spec.allowPerWindow && bucket.slowCount <= spec.slowAllow) return true

    // 超额：本次一律先拒绝（Electron 要求同步答案），再登记询问。
    // 已在询问中就继续拒绝、不重复登记 —— 浮层里始终只有一条。
    if (asking.has(key)) return false
    asking.set(key, true)
    try {
      permissionService.createRequest(origin, kind, (allow) => {
        asking.delete(key)
        buckets.delete(key)
        // 决定是**本页会话**的（owner 用于导航 / 销毁时作废）：
        // 允许 → 这个站点不再计数/再问；阻止 → 静默一段，免得被拦的动作
        // 一个接一个又把询问顶回来。
        if (allow) allowances.set(key, { owner })
        else silences.set(key, { until: Date.now() + spec.denySilenceMs, owner })
      }, scopeId)
    } catch (e) {
      asking.delete(key)
      console.warn('[site-guard] 登记询问失败，已拒绝:', e instanceof Error ? e.message : String(e))
      return false
    }
    return false
  }

  /** 拆 `profile|domain|kind`（`|` 不会出现在 profile id / 域名 / 类型名里）。 */
  function splitKey(key: string): { domain: string; kind: string } {
    const parts = key.split('|')
    return { domain: parts[1] || '', kind: parts[2] || '' }
  }

  /**
   * 权限表规则被改写（domain-permission 的 `onChange` 广播，含「清除」）→
   * 作废受影响的瞬时决定。没有这一步，用户在权限页点了清除，本模块还按上一轮
   * 「始终允许 / 始终阻止」继续放行或继续拦，只能重启浏览器才恢复（实测到的原状）。
   *
   * @param {{origin?: string, permissionType?: string}} [payload]
   *   `origin` 空 = 不限站点（改的是类型默认 / 全清）；
   *   `permissionType` 空 = 不限类型（清的是整个站点）。
   */
  function onRulesChanged(payload?: { origin?: string; permissionType?: string }): void {
    const p = payload || {}
    const kind = typeof p.permissionType === 'string' ? p.permissionType : ''
    const domain = p.origin ? (normalizeDomain(p.origin) || '') : ''
    if (!kind && !domain) {
      allowances.clear(); silences.clear(); buckets.clear()
      return
    }
    for (const map of [allowances, silences, buckets]) {
      for (const key of Array.from(map.keys())) {
        const parts = splitKey(key)
        if (kind && parts.kind !== kind) continue
        if (domain && parts.domain !== domain) continue
        map.delete(key)
      }
    }
  }

  /**
   * 页面实例换了（主框架整页导航 / webContents 销毁）→ 作废**这个页面**给出的
   * 「允许一次 / 阻止一次」与计数额度。不这样做，「允许一次」就是变相的
   * 「始终允许」：实测重载后照样一直弹。
   * 只按 owner 清 —— 同站点其它标签的决定与计数不受影响。
   * @param {number|string|undefined} scopeId
   */
  function resetForScope(scopeId: number | string | undefined): void {
    const id = scopeId == null ? '' : String(scopeId)
    if (!id) return
    for (const [key, entry] of allowances) if (entry.owner === id) allowances.delete(key)
    for (const [key, entry] of silences) if (entry.owner === id) silences.delete(key)
    for (const [key, entry] of buckets) if (entry.owner === id) buckets.delete(key)
    // 页面都换了，旧页面的那次点击不算数（对齐 Chrome：导航会重置 transient activation）。
    gestures.delete(id)
  }

  return {
    /** 弹窗（`window.open` / `target=_blank`）判定 —— false 时调用方必须同步 deny。 */
    evaluatePopup: (payload: GuardPayload) => evaluate('popup', payload),
    /** 下载（`will-download`）判定 —— false 时调用方必须取消这次下载。 */
    evaluateDownload: (payload: GuardPayload) => evaluate('automatic-downloads', payload),
    /** 权限表规则变更 → 作废对应瞬时决定（main.js 通过 domain-permission 的广播调用）。 */
    onRulesChanged,
    /** 页面导航 / 销毁 → 作废该页面的瞬时决定（main.js 挂原生事件调用）。 */
    resetForScope,
    /** 记一次用户激活（main.js 把 `input-event` 里的"按下"送进来）。 */
    noteUserGesture,
    // 阈值表对外只读暴露：设置页 / 未来的插件若要展示"为什么被拦"，不必再抄一份。
    kinds: GUARD_KINDS
  }
}

