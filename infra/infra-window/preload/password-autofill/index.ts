/**
 * index.js — 自动填充核心引擎（编排器）
 *
 * 完全复刻 Hira passwordFill.js 的完整行为，并以模块化、插件化的方式组装：
 *   fields.js  字段识别评分 + 缓存 + MutationObserver      （谁是候选）
 *   resolve.js 字段解析策略链，可注册/替换 Mod 策略        （本次填哪两个）
 *   fill.js    纯写入器 + 高亮                          （怎么填）
 *   unlock-button.js  钥匙图标触发按钮
 *   menus.js   多凭据选择下拉（可插拔）
 *   capture.js 登录凭据捕获
 *   prompt-save.js  保存密码提示卡
 *   generate.js 密码生成
 *   bridge.js  transport 抽象（provider.invoke / on.subscribe）
 *
 * 分层原则：下层不反向依赖上层。
 *   fields ← resolve ← (index 编排) → fill
 * fill.js 不知道 scanner 的存在；scanner 不知道 fill 的存在；
 * 二者由本文件组装，因此任何一层都可被 Mod/插件单独替换。
 *
 * 本文件在 preload 中只惰性注册一个廉价探针，仅在页面确实存在登录表单时激活引擎；
 * 也可在其它宿主中 import 后手动 start。
 */

import { makeBridge, type PasswordCredential } from './bridge.js'
import { createCredentialFieldScanner } from './fields.js'
import { createFieldResolver } from './resolve.js'
import { createAutofillFiller } from './fill.js'
import { createUnlockButtonController } from './unlock-button.js'
import { createCredentialMenu } from './menus.js'
import { createCredentialCapture } from './capture.js'
import { createPasswordGenerator } from './generate.js'
import { ipcRenderer } from 'electron'
import { PRELOAD_EVENTS } from '@hira-ng/shared-types/src/ipc-channels-preload'
// 协议白名单走 shared-types 的唯一判据（与地址填充、PWA 线索同一条）。
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols'

/**
 * 取证日志总闸门（对齐 Hira `AUTOFILL_DEBUG`）。
 *
 * 默认**关闭**：填充发生在用户输入路径上，每条 `[ng-af]` / `[ng-fill]` 都要
 * `JSON.stringify`，而 `describeField` 还会读 `getBoundingClientRect()` 触发样式计算 ——
 * 页面主线程的同步布局开销，在每次填充/每次探测分支上都要付一遍。
 * 排查「用户名能填、密码填不进」时把这里改成 true 再构建即可，无需改业务代码。
 */
const AUTOFILL_DEBUG = false

function isTopFrame() {
  try {
    return window.top === window.self
  } catch (_) {
    return true
  }
}

/**
 * 组装并启动自动填充引擎。
 * @param {Object} options
 * @param {Object} options.provider  { invoke(route,payload) }
 * @param {Function} [options.subscribe]  (route, listener)->unsubscribe
 * @returns {{ dispose: Function }}
 */
type AutofillReason = 'load' | 'focus' | 'manual'
interface AutofillProvider { invoke(route: string, payload?: unknown): Promise<unknown> | unknown }
type AutofillSubscribe = (route: string, listener: (payload: unknown) => void) => () => void
interface AutofillOptions { provider?: AutofillProvider; subscribe?: AutofillSubscribe }
interface AutofillEngine { activate(anchor: HTMLInputElement | null | undefined): void; dispose(): void }
interface SuggestionCache { hostname: string; credentials: PasswordCredential[] | null; time: number }

function startAutofillEngine(options: AutofillOptions): AutofillEngine {
  const provider = options && options.provider ? options.provider : null
  const subscribe = options && typeof options.subscribe === 'function'
    ? options.subscribe
    : () => () => {}
  if (!provider) return { activate: () => {}, dispose: () => {} }

  const bridge = makeBridge(provider, subscribe)

  // ── 三层组装（fields → resolve → fill）──────────────
  const scanner = createCredentialFieldScanner()
  const resolver = createFieldResolver(scanner)
  const filler = createAutofillFiller()

  // 字段漂移时清理残留填充：由编排器单向注入，避免 fill ↔ fields 循环依赖
  scanner.setStaleFieldCleaner(filler.clearAutofilledField)

  const unlockBtn = createUnlockButtonController(scanner, { onActivate })
  const generator = createPasswordGenerator(scanner, {
    onGenerated(username, password) {
      bridge.reportCaptured(window.location.hostname, username || '', password)
    }
  })

  // 注册多凭据菜单提供者（DOM 兜底；主进程 overlay 原生浮层优先）
  bridge.setMenuProvider(createCredentialMenu({
    onPick(cred) {
      fillWith(cred, null)
    }
  }).show)

  const capture = createCredentialCapture(scanner, {
    onCaptured(username, password) {
      bridge.reportCaptured(window.location.hostname, username, password)
    }
  })

  // ── 自动填充状态 ──
  const suggestionCache: SuggestionCache = { hostname: '', credentials: null, time: 0 }
  let lastAutofillRequest = { hostname: '', time: 0 }
  let didAutofillOnLoad = false
  let didAutofillLoadRequest = false
  /** 最近一次用户交互的锚点输入框（多凭据菜单/主进程回填时复用） */
  let lastAnchor: HTMLInputElement | null = null

  // ── 浮层会话状态（Edge 行为：点击输入框弹出、点击任意处收起）──
  // 浮层是独立 WebContentsView，页面侧必须自己记住"它开着"。
  let menuOpen = false
  let menuAnchor: HTMLInputElement | null = null
  let menuShownAt = 0
  /**
   * 收起后的**重开抑制窗口**（毫秒）。
   * 点击未聚焦的输入框时事件序是 mousedown → focusin：
   * 若 mousedown 已把浮层收起，紧随而来的 focusin 会立刻又把它弹开，
   * 表现为"点了输入框浮层闪一下又出现 / 根本关不掉"。
   * 因此收起后短时间内不再响应开启动作。
   */
  const MENU_REOPEN_SUPPRESS_MS = 150
  let menuSuppressUntil = 0

  /**
   * 统一填充入口 —— 编排器的唯一写入路径。
   *
   * 流程固定为两步：解析目标字段（策略链）→ 交给纯写入器。
   * anchor 只作为**解析上下文**传入（内置 anchor-first 策略会优先采用），
   * 不直接送进 fill，也没有任何重试 / 补填 / forceRescan —— 与 Hira 一致。
   *
   * @param {Object} cred   { username, password }
   * @param {HTMLInputElement|null} anchor 用户实际交互的输入框
   */
  /**
   * 决策点取证日志 —— 控制台 `[ng-af]`。
   * 只输出分支与数量，绝不输出凭据内容。
   */
  function trace(tag: string, data: unknown): void {
    if (!AUTOFILL_DEBUG) return
    try {
      console.log('[ng-af] ' + tag, JSON.stringify(data))
    } catch (_) {}
  }

  function activeInput(): HTMLInputElement | null {
    return document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  }

  /**
   * 字段取证描述 —— 控制台 `[ng-fill]` 日志用。
   * 只输出类型/id/值长度/是否可见/是否在文档里，绝不输出凭据内容。
   */
  function describeField(field: HTMLInputElement | null | undefined): Record<string, unknown> | null {
    if (!field) return null
    let visible = false
    try {
      const r = field.getBoundingClientRect()
      visible = !!(r && r.width > 0 && r.height > 0)
    } catch (_) {}
    return {
      type: field.type || '?',
      id: field.id || '',
      name: field.getAttribute ? String(field.getAttribute('name') || '') : '',
      inDoc: !!field.isConnected,
      visible,
      valueLen: (field.value || '').length
    }
  }

  function fillWith(cred: PasswordCredential, anchor: HTMLInputElement | null): ReturnType<typeof filler.fillCredentials> {
    if (anchor && anchor.isConnected) lastAnchor = anchor
    const anchorEl = lastAnchor && lastAnchor.isConnected ? lastAnchor : null
    const ctx = { anchor: anchorEl }

    // passwordField 用**惰性 getter**：fillCredentials 在写完用户名之后才读取它，
    // 那一刻才真正解析 —— 若站点因用户名变更重建了表单，拿到的是新节点而非旧节点。
    //
    // 但「用户点的就是密码框」时必须锁死这个节点：Hira 基线评分法会重新挑
    // “分数最高”的密码框，页面里若存在隐藏诱饵框 / 确认密码框，凭据就会被写进
    // 另一个框 —— 表现为“点了填充却什么都没发生”。锚点仍 connected 时它就是唯一答案。
    const targets = {
      usernameField: resolver.resolve(ctx).usernameField,
      get passwordField() {
        if (anchorEl && anchorEl.isConnected && scanner.isPasswordLikeField(anchorEl)) {
          return anchorEl
        }
        const resolved = resolver.resolve(ctx).passwordField
        return resolved && resolved.isConnected !== false ? resolved : null
      }
    }

    const written = filler.fillCredentials(cred, targets)

    // 取证日志：定位“用户名能填、密码填不进”的最终依据（不打印凭据内容）
    if (AUTOFILL_DEBUG) {
      try {
        console.log('[ng-fill]', JSON.stringify({
          host: window.location.hostname,
          credUserLen: (cred && cred.username ? String(cred.username) : '').length,
          credPwLen: (cred && cred.password ? String(cred.password) : '').length,
          username: describeField(written && written.usernameField),
          password: describeField(written && written.passwordField)
        }))
      } catch (_) {}
    }

    return written
  }

  /**
   * 打开多凭据浮层（Edge 行为）。
   *
   * 只在确实有凭据时打开；收起由 dismissMenu 统一负责。
   * @param {HTMLInputElement|null} anchor
   * @param {boolean} [force=false] 跳过重开抑制窗口（仅内部复用场景使用）
   */
  function openMenuFor(anchor: HTMLInputElement | null, force: boolean = false): boolean {
    const creds = suggestionCache.credentials
    if (!Array.isArray(creds) || creds.length === 0) {
      unlockBtn.setState('no-match')
      return false
    }
    // 刚被用户收起（点任意处 / 有输入）→ 抑制窗口内不再自动弹开
    if (!force && Date.now() < menuSuppressUntil) return false
    // 同一锚点短时间内重复触发（mousedown → focusin 会连来两次）直接忽略
    if (menuOpen && menuAnchor === anchor && Date.now() - menuShownAt < 400) return false

    const a = (anchor && anchor.isConnected) ? anchor : activeInput()
    if (a) lastAnchor = a

    menuAnchor = a
    menuOpen = true
    menuShownAt = Date.now()

    trace('menu-open', { n: creds.length, anchor: a && a.id })
    bridge.showMenu(window.location.hostname, creds, a || anchor || null)
    return true
  }

  /**
   * 收起浮层 —— 所有关闭路径的唯一出口。
   * 触发源：点击任意处、页面内产生输入、Esc、路由切换、浮层内选中凭据。
   */
  function dismissMenu() {
    if (!menuOpen) return
    menuOpen = false
    menuAnchor = null
    menuSuppressUntil = Date.now() + MENU_REOPEN_SUPPRESS_MS
    // 一并清掉 focus 节流标记：否则"点开→关掉→再点开"会被 1200ms 节流吃掉，
    // 表现为第二次点击没反应。
    lastAutofillRequest = { hostname: '', time: 0 }
    trace('menu-dismiss', {})
    bridge.dismissMenu()
  }

  function onActivate(anchorInput: HTMLInputElement): void {
    const cache = suggestionCache
    if (anchorInput && anchorInput.isConnected) lastAnchor = anchorInput
    const hit = !!(
      cache &&
      cache.hostname === window.location.hostname &&
      Array.isArray(cache.credentials) &&
      cache.credentials.length > 0
    )
    const credentials = Array.isArray(cache.credentials) ? cache.credentials : []
    if (!hit) {
      requestAutofill('manual', anchorInput)
      return
    }
    // 对齐 Hira createUnlockButton 的 mousedown：
    // 有缓存就**先写第一条凭据**（无论有几条），多凭据再弹选择浮层。
    // 此前"多凭据只弹菜单、不填充"会让用户点填充后看不到任何变化。
    fillWith(credentials[0], anchorInput)
    if (credentials.length > 1) openMenuFor(anchorInput)
  }

  function applySuggestions(
    hostname: string,
    creds: PasswordCredential[] | null | undefined,
    reason: AutofillReason,
    anchor: HTMLInputElement | null
  ): void {
    suggestionCache.hostname = hostname
    suggestionCache.credentials = Array.isArray(creds) ? creds : null
    suggestionCache.time = Date.now()

    if (!creds || creds.length === 0) {
      trace('branch', { to: 'no-match' })
      unlockBtn.setState('no-match')
      return
    }
    unlockBtn.setState('default')

    if (reason === 'manual') {
      // 对齐 Hira password-autofill-match：先填第一条，多凭据再弹选择浮层。
      // 只弹菜单不填充是错误行为 —— 用户点完填充看不到任何变化。
      const a = (anchor && anchor.isConnected) ? anchor : activeInput()
      trace('branch', { to: 'fill', reason, n: creds.length, anchor: a && a.id })
      fillWith(creds[0], anchor)
      if (creds.length > 1) openMenuFor(a)
    } else if (reason === 'focus') {
      // 对齐 Hira：聚焦只预热缓存 + 显示钥匙按钮，**不自动弹浮层**。
      // 多凭据的选择浮层只由钥匙按钮（manual）触发，避免浮层打扰输入。
      trace('branch', { to: 'cache-only', reason, n: creds.length })
    } else if (reason === 'load') {
      // 加载即填充首个凭据（Hira 行为），但**不弹选择浮层**：
      // 页面刚打开就浮着一个浮层很打扰（且 load 时锚点是 body，浮层会被钳到左下角）。
      // 多凭据站点由用户点击输入框时再弹（focus/mousedown 路径），交互可预期。
      const anchorField = (anchor && anchor.isConnected)
        ? anchor
        : (activeInput() || scanner.getBestUsernameField() || scanner.getBestPasswordField())
      if (!didAutofillOnLoad) {
        didAutofillOnLoad = true
        trace('branch', { to: 'fill', reason, n: creds.length })
        fillWith(creds[0], anchorField)
      }
    }
  }

  function requestAutofill(reason: AutofillReason, anchor?: HTMLInputElement | null): void {
    if (!isTopFrame()) return
    if (!scanner.getBestPasswordField()) return

    const hostname = window.location.hostname
    // "每次页面加载只请求一次" 的约束放在入口，而不是调用点：
    // 调用点分散在 onRefresh 回调与直连分支两处，且 clearAutofillUIForRouteChange
    // 会重置标记，守卫写在调用点很容易被绕过（实测出现过加载时请求两次 → 浮层弹两遍）。
    if (reason === 'load') {
      if (didAutofillLoadRequest) return
      didAutofillLoadRequest = true
    }
    if (reason === 'focus') {
      const now = Date.now()
      if (
        lastAutofillRequest.hostname === hostname &&
        now - lastAutofillRequest.time < 1200
      ) {
        return
      }
      lastAutofillRequest = { hostname, time: now }
    }

    trace('request', { reason, hostname })

    // ⚠ 必须有 onRejected：getSuggestions 走 IPC invoke，一旦后端抛错/DB 不可用就会
    // reject。此前只有 .then()，reject 会被静默吞掉 → 表现为“点了完全没反应”。
    bridge.getSuggestions(hostname, reason).then(
      (creds) => {
        trace('suggestions', {
          n: Array.isArray(creds) ? creds.length : ('not-array:' + typeof creds)
        })
        applySuggestions(hostname, creds, reason, anchor || null)
      },
      (err) => {
        trace('suggestions-FAILED', { err: String((err && err.message) || err) })
      }
    )
  }

  // ── 路由切换清理（复刻 Hira pushState/replaceState/popstate/hashchange）──
  function clearAutofillUIForRouteChange(): void {
    // 路由切换：浮层若开着要一并收起，否则会留在新页面上
    if (menuOpen) {
      menuOpen = false
      menuAnchor = null
      menuSuppressUntil = 0
      try { bridge.dismissMenu() } catch (_) {}
    }
    unlockBtn.removeButton()
    filler.resetFillers()
    suggestionCache.hostname = ''
    suggestionCache.credentials = null
    suggestionCache.time = 0
    lastAutofillRequest = { hostname: '', time: 0 }
    didAutofillOnLoad = false
    didAutofillLoadRequest = false
    lastAnchor = null
    capture.onRouteChange()
    scanner.clearCache()
    scanner.startObserver(9000)
    scanner.scheduleRefresh()
  }

  function patchHistory() {
    try {
      const origPushState = window.history.pushState
      window.history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
        const r = origPushState.call(this, data, unused, url)
        clearAutofillUIForRouteChange()
        return r
      }
      const origReplaceState = window.history.replaceState
      window.history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
        const r = origReplaceState.call(this, data, unused, url)
        clearAutofillUIForRouteChange()
        return r
      }
    } catch (_) {}
    window.addEventListener('popstate', clearAutofillUIForRouteChange, true)
    window.addEventListener('hashchange', clearAutofillUIForRouteChange, true)
  }

  function isCredentialField(t: EventTarget | null): t is HTMLInputElement {
    if (!(t instanceof HTMLInputElement)) return false
    try {
      return !!(scanner.isUsernameLikeField(t) || scanner.isPasswordLikeField(t))
    } catch (_) {
      return false
    }
  }

  /**
   * 用户聚焦/点击凭据输入框 —— 对齐 Hira：
   * 只保证钥匙按钮在位，并在无新鲜缓存时请求一次凭据；**不自动弹浮层**。
   * 浮层由钥匙按钮（manual）显式触发。
   */
  function activateField(t: EventTarget | null): void {
    if (!isCredentialField(t)) return
    unlockBtn.maybeAddButton(t)
    const fresh =
      suggestionCache.hostname === window.location.hostname &&
      Array.isArray(suggestionCache.credentials) &&
      Date.now() - (suggestionCache.time || 0) < 120000
    if (!fresh) requestAutofill('focus', t)
  }

  // ── 事件绑定 ──
  function bindFocus(): void {
    window.addEventListener(
      'blur',
      () => unlockBtn.removeButton(),
      true
    )
    window.addEventListener(
      'focusin',
      (e: FocusEvent) => {
        if (e.isTrusted === false) return
        try {
          if (navigator.userActivation && !navigator.userActivation.isActive) return
        } catch (_) {}
        unlockBtn.maybeAddButton(e.target)
        activateField(e.target)
      },
      true
    )
    // 点击"已经聚焦"的输入框不会再触发 focusin，必须单独监听 mousedown。
    //
    // 关闭规则（统一）：浮层开着时，**点击任意一处都收起**，包括弹出它的那个
    // 输入框本身 —— 不再为"浮层锁定字段"设例外，行为可预测且易实现。
    // 收起后的下一次点击若落在凭据输入框上，则重新打开（形成 toggle）。
    window.addEventListener(
      'mousedown',
      (e: MouseEvent) => {
        if (menuOpen) {
          dismissMenu()
          return
        }
        if (isCredentialField(e.target)) activateField(e.target)
      },
      true
    )
    // 有输入即收起 —— 与"点击空白处"等价。
    // 用户一旦开始打字就说明不想再从浮层里选，浮层继续挂着只会挡视线。
    //
    // ⚠ isTrusted 过滤必不可少：填充时 setInputValueWithEvents 会派发合成
    // input 事件，那些是程序写入而非用户输入，不能拿来关浮层
    // （否则"选中凭据 → 刚填上 → 浮层被自己的事件关掉"，甚至可能打断填充）。
    window.addEventListener(
      'input',
      (e: Event) => {
        if (e && e.isTrusted === false) return
        dismissMenu()
      },
      true
    )
    // 页面按 Esc：浮层跑在独立 view 里，收不到页面的键盘事件，由本页代为关闭
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape' && menuOpen) dismissMenu()
      },
      true
    )
    window.addEventListener(
      'focusout',
      () => {
        setTimeout(() => {
          const active = document.activeElement
          if (!active || active.tagName !== 'INPUT') unlockBtn.removeButton()
          // 焦点移出凭据输入框（点了页面其它地方）→ 收起浮层。
          // 与"有输入即收起"同构：用户注意力已离开凭据选择场景，浮层继续挂着只会挡视线。
          // dismissMenu 会同步主进程（menu-cancel），页内状态与浮层保持一致。
          if (menuOpen && (!active || !isCredentialField(active))) dismissMenu()
        }, 0)
      },
      true
    )
  }

  function bindScrollResize(): void {
    window.addEventListener('scroll', unlockBtn.schedulePositionUpdate, true)
    window.addEventListener('resize', unlockBtn.schedulePositionUpdate, true)
  }

  function scheduleLoadAutofill(): void {
    setTimeout(function () {
      scanner.startObserver(9000)
      scanner.scheduleRefresh()
      scanner.onRefresh(function () {
        // 标记由 requestAutofill 统一维护，此处不再重复置位
        if (scanner.getBestPasswordField()) requestAutofill('load')
      })
      if (scanner.getBestPasswordField()) requestAutofill('load')
    }, 450)
  }

  // 主进程推送事件（缺失时静默；原生菜单/快捷键/生成扩展点）
  function bindBridgeEvents(): void {
    bridge.on(PRELOAD_EVENTS.generatePassword, (payload: unknown) => {
      const record = payload && typeof payload === 'object' ? payload as { location?: { x: number; y: number } } : null
      const loc = record?.location || (payload as { x: number; y: number } | null) || undefined
      generator.generateAt(loc)
    })
    // 主进程权威收起（切标签 / 导航 / 窗口失焦）→ 同步页内会话状态。
    // 若不同步，menuOpen 残留 true，用户点输入框会走 dismiss 分支而非重新弹出，
    // 表现为"浮层已被主进程关掉，但页面上要点两次才弹出来"。
    bridge.on(PRELOAD_EVENTS.passwordOverlayHidden, () => {
      menuOpen = false
      menuAnchor = null
    })
    // 原生 overlay 多凭据菜单选中 → 回填到本页
    bridge.on(PRELOAD_EVENTS.passwordAutofillMenuSelect, (payload: unknown) => {
      // 浮层由主进程自行隐藏，这里只需同步本地会话状态
      menuOpen = false
      menuAnchor = null
      const cred = payload && typeof payload === 'object' ? (payload as { credential?: unknown }).credential : null
      if (cred && typeof cred === 'object') fillWith(cred as PasswordCredential, null)
    })
  }

  // ── 启动 ──
  function start(): void {
    capture.bind()
    bindFocus()
    bindScrollResize()
    bindBridgeEvents()
    patchHistory()

    scheduleLoadAutofill()

    // 对齐 Hira checkInitialFocus：页面加载即聚焦在输入框（如 autofocus）时也显示钥匙按钮
    setTimeout(function () {
      try {
        const active = document.activeElement
        if (active && active.tagName === 'INPUT') unlockBtn.maybeAddButton(active)
      } catch (_) {}
    }, 300)
  }

  start()

  return {
    /** 惰性激活：由 preload 探针在确认存在登录表单后调用（见文件末尾 IIFE） */
    activate(anchor: HTMLInputElement | null | undefined) {
      try { activateField(anchor || null) } catch (_) {}
    },
    dispose() {
      try {
        capture.onRouteChange()
      } catch (_) {}
    }
  }
}

// ── preload 惰性启动（对齐 HiraRT 的「薄 preload」基线）──
// 注意：preload 运行在隔离世界（contextIsolation+sandbox），
// 主世界通过 contextBridge.exposeInMainWorld 暴露的 window.hira 在隔离世界不可见，
// 因此必须直接用 require('electron').ipcRenderer 构造 provider，绝不能依赖 window.hira。
//
// 性能铁律：**绝不在页面加载时无条件启动引擎**。引擎自带全局捕获监听 + MutationObserver
// + 主世界 HTMLFormElement.prototype.submit 补丁，若每个页面都常驻，DOM 频繁变动的站点会
// 持续触发全量重扫 —— 这正是"跟 IE 一样卡"的根因。改为惰性激活：只有页面确实存在登录
// 表单、或用户与输入框交互时才启动；其余页面 preload 只保留一个廉价的探针监听。
;(function () {
  if (typeof window === 'undefined') return

  // 只在真实网页（http / https）上启动填充引擎。
  // 内部页（hira://settings …）、about:、file:、devtools:、blob:、data: 等上下文都没有
  // 凭据可填，按协议白名单放行，彻底隔离。
  const __proto = window.location && window.location.protocol
  if (!isHttpProtocol(__proto)) return

  let provider: AutofillProvider | null = null
  let subscribe: AutofillSubscribe | null = null

  try {
    if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
      const makeChannel = (scope: string, kind: string, route: string): string => {
        const base = scope + ':' + kind
        if (!route) return base
        return base + ':' + route
      }
      provider = {
        invoke(route: string, payload?: unknown): Promise<unknown> {
          return ipcRenderer.invoke(makeChannel('ngipc', 'invoke', route), payload)
        }
      }
      subscribe = (route: string, listener: (payload: unknown) => void): (() => void) => {
        const ch = makeChannel('ngipc', 'event', route)
        const fn = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
        ipcRenderer.on(ch, fn)
        return () => ipcRenderer.removeListener(ch, fn)
      }
    }
  } catch (_) {}

  // 兜底：宿主环境已通过主世界暴露（非隔离 / 手动注入场景）
  const hiraWindow = window as Window & {
    hira?: {
      provider?: AutofillProvider
      on?: { subscribe?: (route: string, listener: (payload: unknown) => void) => () => void }
    }
  }
  if (!provider && hiraWindow.hira?.provider) {
    provider = hiraWindow.hira.provider
    subscribe = (route: string, fn: (payload: unknown) => void): (() => void) =>
      hiraWindow.hira?.on && typeof hiraWindow.hira.on.subscribe === 'function'
        ? hiraWindow.hira.on.subscribe(route, fn)
        : () => {}
  }

  if (!provider) return
  const activeProvider = provider
  const activeSubscribe: AutofillSubscribe = subscribe || (() => () => {})

  let started = false

  // 廉价探针：一次原生选择器查询即可判断页面是否存在凭据输入框。
  // 成本恒定，绝不做全量 input 遍历 / 评分。
  function hasCredentialField() {
    try {
      return !!document.querySelector(
        'input[type="password"]' +
        ',input[autocomplete="current-password"]' +
        ',input[autocomplete="new-password"]' +
        ',input[autocomplete="username"]' +
        ',input[autocomplete="email"]'
      )
    } catch (_) {
      return false
    }
  }

  function eventInput(event: Event): HTMLInputElement | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null
    if (path) {
      for (const node of path) {
        if (node instanceof HTMLInputElement) return node
      }
    }
    return event.target instanceof HTMLInputElement ? event.target : null
  }

  function looksLikeCredentialInput(input: HTMLInputElement | null): boolean {
    if (!input) return false
    const type = String(input.type || '').toLowerCase()
    const autocomplete = String(input.getAttribute('autocomplete') || '').toLowerCase()
    return type === 'password' ||
      autocomplete === 'current-password' ||
      autocomplete === 'new-password' ||
      autocomplete === 'username' ||
      autocomplete === 'email'
  }

  function activate(anchor: EventTarget | null): void {
    if (started) return
    started = true
    // 引擎启动后由它自己接管这些事件，先撤掉探针避免重复处理。
    window.removeEventListener('focusin', probe, true)
    window.removeEventListener('submit', probe, true)
    try {
      const engine = startAutofillEngine({ provider: activeProvider, subscribe: activeSubscribe })
      const field = (anchor instanceof HTMLInputElement)
        ? anchor
        : (document.activeElement instanceof HTMLInputElement ? document.activeElement : null)
      if (field && engine && typeof engine.activate === 'function') engine.activate(field)
    } catch (e) {
      console.error('[password-autofill] init failed:', e instanceof Error ? e.message : e)
    }
  }

  // 迟激活探针：仅在用户与输入框交互 / 提交表单时才付出检测成本。
  function probe(e: Event): void {
    try {
      if (e && e.type === 'submit') {
        if (hasCredentialField()) activate(null)
        return
      }
      const input = eventInput(e)
      if (input && (hasCredentialField() || looksLikeCredentialInput(input))) activate(input)
    } catch (_) {}
  }

  // 一次性探测：静态登录表单在首屏渲染完成后即可激活（无需用户交互）。
  function initialProbe() {
    if (hasCredentialField()) activate(null)
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(initialProbe, 500), { once: true })
  } else {
    setTimeout(initialProbe, 500)
  }

  window.addEventListener('focusin', probe, true)
  window.addEventListener('submit', probe, true)
})()

export { startAutofillEngine }
