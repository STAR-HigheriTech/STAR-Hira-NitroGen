/**
 * 扫码器的**状态模型**（不含任何 DOM 代码）。
 *
 * 三块分工（与 panel-notes / panel-totp 同一套）：
 *   · 本文件        —— 一处状态 + 数据来源（共享内核 + 宿主端口），对外只暴露语义化动作；
 *   · `qr-scanner.view.js`     —— 只读状态、只画、把用户意图转成本模型的调用；
 *   · `qr-scanner.renderer.js` —— 把两者与宿主端口接起来。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 扫的是**取景框里的那一块屏幕**，而且是**触发式**的
 * ══════════════════════════════════════════════════════════════════════
 * 抓一帧整屏要主进程回读 8MB 再塞过 IPC —— 这件事**绝不能持续跑**（第一版每 600ms
 * 一次的结果是界面卡死、拖动没反应、鼠标都动不了）。所以这里只在两个时机抓**一帧**：
 *   ① 主进程发来 `qrScanSettled`（用户把取景框放下了 —— 主进程在交互结束后静默一拍再发）；
 *   ② 用户点「重新扫描」。
 * 静止时零抓屏、零解码、零 IPC。这也正是扫码这个动作的语义：对准了才看。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条渲染信号：`onChange`（结构）与 `onHit`（扫到一个）
 * ══════════════════════════════════════════════════════════════════════
 *   · `onChange` —— 开关扫描、记录增删、复制反馈、识别中… → 视图重建；
 *   · `onHit`    —— 命中时只更新"刚扫到"那一行 + 新记录**插到列表顶部**
 *                   （不重建整块，用户滚到哪就停在哪）。
 */

import { classifyQrText, isOpenable, QR_CONTENT } from '../src/renderer/shared/qr-scan/decoder.js'
// 取景框会话 = **扫码器引擎的可调用接口**（见 shared/qr-scan/scan-window.js）。
// 本面板**不再自己**开关窗口 / 订事件 / 管 `frameSeen` —— 那些是引擎的事；
// 抄第二遍的代价就是"两边迟早不一样"（验证器面板走的是同一个会话对象）。
import { createScanWindow, isScanWindowSupported } from '../src/renderer/shared/qr-scan/scan-window.js'
// 引擎可用性（功能面 `qrScan`）：抓屏能力在**另一个插件**（「扫码器引擎」）里，
// 用户能单独把它关掉 —— 那时这个面板必须如实说"扫不了"，而不是给一个点了报错的按钮。
import { isFeatureAvailable, onFeaturesChanged } from '../src/renderer/shared/features-client.js'
import { copyText } from '../src/renderer/shared/clipboard'
import type { TotpImportResult } from '@hira-ng/domain-totp'

type ScanWindowOptions = NonNullable<Parameters<typeof createScanWindow>[0]>
type ScreenPort = NonNullable<ScanWindowOptions['client']>
type ScanSession = ReturnType<typeof createScanWindow>
type TimerHandle = ReturnType<typeof setTimeout>

export interface QrResult extends ReturnType<typeof classifyQrText> {
  id: string
  count: number
}

export interface QrLastHit {
  seq: number
  id: string
  isNew: boolean
  title: string
  label: string
  count: number
}

export interface QrNotice {
  text: string
  kind: 'info' | 'error'
}

export interface QrScannerState {
  screenSupported: boolean
  scanning: boolean
  capturing: boolean
  error: string | null
  notice: QrNotice | null
  results: QrResult[]
  lastHit: QrLastHit | null
  hitSeq: number
  copiedId: string | null
  totpAvailable: boolean
  lastScanEmpty: boolean | null
}

interface QrTabsPort {
  newTab(input: { url: string }): Promise<unknown> | unknown
}

interface QrPluginsPort {
  list(): Promise<unknown> | unknown
  onChanged?(listener: () => void): () => void
}

interface QrTotpPort {
  importUris(uris: string[]): Promise<TotpImportResult | { ok: false; reason: string }>
}

interface QrScannerOptions {
  doc?: Document | null
  clients?: {
    tabs?: QrTabsPort | null
    totp?: QrTotpPort | null
    plugins?: QrPluginsPort | null
    screen?: ScreenPort | null
  }
  subscribe?: ScanWindowOptions['subscribe']
  events?: ScanWindowOptions['events']
  onChange?: () => void
  onHit?: () => void
  scanWindow?: typeof createScanWindow
}

/** 「已复制」反馈持续时长（与验证器面板同一档，保持跨面板一致）。 */
const COPIED_FEEDBACK_MS = 1200

/**
 * @param {{
 *   doc?: Document,
 *   clients?: { tabs?: object, totp?: object, plugins?: object, screen?: object },
 *   subscribe?: (route: string, handler: Function) => Function,
 *   events?: object,
 *   onChange?: Function,
 *   onHit?: Function,
 *   scanWindow?: Function   // 取景框会话工厂可注入（端口注入的既有风格）—— 于是"在哪些路径上被收掉"可单测
 * }} [options]
 */
export function createQrScannerModel(options: QrScannerOptions = {}) {
  const onChange = options.onChange ?? (() => {})
  const onHit = options.onHit ?? (() => {})
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document)
  const clients = options.clients ?? {}
  const scanWindowFactory = options.scanWindow ?? null
  const subscribe = options.subscribe ?? null
  const events = options.events ?? null

  const state: QrScannerState = {
    /**
     * 「扫描屏幕」能不能用 —— 两个条件缺一不可（见 refreshScanSupported）：
     *   ① 宿主给了取景框端口；② 提供抓屏能力的**扫码器引擎**插件没被禁用。
     *
     * ⚠ 这个面板与引擎是**两个插件**：面板只管界面，抓屏能力在「扫码器引擎」里
     * （`qr.captureScreen`）。用户完全可以在插件管理里单独关掉引擎 ——
     * 那时这个面板还在，但它扫不出任何东西，必须**如实说**而不是给一个点了报错的按钮。
     */
    screenSupported: false,
    scanning: false,
    /** 正在抓这一帧 + 解码（触发式扫描的"此刻在干活"）。 */
    capturing: false,
    /** 就地提示（错误 / 结果说明），不弹窗 */
    error: null,
    notice: null,
    /** 本次会话的识别记录（最新在前）：{ id, count, ...classifyQrText(text) } */
    results: [],
    /** 刚扫到的一条（状态条的即时反馈）：{ seq, id, isNew, title, label, count } */
    lastHit: null,
    /** 命中序号：视图据此重放一次闪光（值相同则不重放） */
    hitSeq: 0,
    /** 刚复制过的记录 id */
    copiedId: null,
    /** 「验证器」引擎是否可用（决定给不给「存入验证器」） */
    totpAvailable: false,
    /** 最近一次抓帧有没有认出来（null = 这轮还没扫过）—— 只用于状态条文案 */
    lastScanEmpty: null
  }

  /**
   * 取景框会话（引擎的可调用接口）。开扫描时创建，收扫描时置空 —— 见 scan-window.js。
   * 开关窗口、等"放下"、防重入、`frameSeen` 那套时序**都在会话里**，这里不重复实现。
   */
  let session: ScanSession | null = null
  let seq = 0
  let copiedTimer: TimerHandle | null = null
  let unsubscribePlugins: (() => void) | null = null
  let unsubscribeFeatures: (() => void) | null = null

  const emitChange = () => { try { onChange() } catch (e) { console.error('[qr-scanner] onChange:', e) } }
  const emitHit = () => { try { onHit() } catch (e) { console.error('[qr-scanner] onHit:', e) } }

  function setNotice(text: unknown, kind: 'info' | 'error' = 'info'): void {
    const value = String(text ?? '')
    state.notice = value ? { text: value, kind } : null
    emitChange()
  }

  // ── 验证器联动（**软依赖**）────────────────────────────────────────────
  //
  // 为什么不"直接调、失败再说"：给用户一个点了就报错的按钮，是这个代码库反复
  // 避免的形态。声明 `optionalDependsOn` 之后，这里只需问一句"它在不在"，
  // 不在就**不给**那个按钮。
  function refreshTotpAvailability(): Promise<void> {
    const plugins = clients.plugins
    if (!plugins || typeof plugins.list !== 'function') {
      state.totpAvailable = false
      return Promise.resolve()
    }
    return Promise.resolve(plugins.list()).then((raw) => {
      const list = Array.isArray(raw) ? raw : []
      const entry = list.find((p): p is { id: string; enabled?: boolean } =>
        !!p && typeof p === 'object' && (p as { id?: unknown }).id === 'totp-service')
      const next = !!(entry && entry.enabled)
      if (next !== state.totpAvailable) { state.totpAvailable = next; emitChange() }
    }).catch(() => {
      if (state.totpAvailable) { state.totpAvailable = false; emitChange() }
    })
  }

  /**
   * 重算「扫描屏幕」这个功能能不能用。
   *
   * 两条判据缺一不可（与验证器面板同一套写法）：
   *   · `isScanWindowSupported(client)` —— 宿主给没给取景框/抓帧端口（环境问题）；
   *   · `isFeatureAvailable('qrScan')`   —— 提供抓屏能力的**扫码器引擎**插件在不在、
   *     有没有被用户显式禁用（`provider-bridge` 的语义：被禁用 = 功能真没了）。
   *
   * 引擎刚被关掉时必须**把开着的会话收掉**：留一个还挂着、却永远扫不出东西的置顶取景框，
   * 比直接说"不可用"更糟 —— 用户会以为是自己没对准。
   */
  function refreshScanSupported(): void {
    const next = isScanWindowSupported(clients.screen ?? undefined) && isFeatureAvailable('qrScan')
    const turnedOff = !next && state.scanning
    if (next === state.screenSupported && !turnedOff) return
    state.screenSupported = next
    if (turnedOff) {
      closeSession()
      state.notice = { text: '扫码器引擎已被关闭，扫描已停止', kind: 'error' }
    }
    emitChange()
  }

  // ── 取景框 / 扫描器 ───────────────────────────────────────────────────
  //
  // 本面板对"取景框怎么开、什么时候抓、什么时候收"**没有知识** —— 全部交给
  // `createScanWindow()`（引擎的可调用接口）。这里只做三件事：把用户意图转过去
  // （startScan / stopScan / runScan）、把结果收下来（handleResult）、把状态映到界面。

  /** 用户在浮框上点了 ✕（会话回调）—— 不看这条的话面板会一直显示"扫描中"。 */
  function onFrameClosed(): void {
    session = null
    if (!state.scanning) return
    state.scanning = false
    state.capturing = false
    state.notice = { text: '取景框已关闭，扫描已停止', kind: 'info' }
    emitChange()
  }

  /**
   * 面板不可见时立刻停下。
   *
   * 侧栏可以同时开着多个面板 —— 用户在扫码时切去别处，这里必须收干净：
   * 留着一个置顶取景框、还想着继续扫，都说不通。
   */
  function onVisibility(): void {
    if (!doc || doc.hidden !== true) return
    if (!state.scanning) return
    closeSession()
    setNotice('面板已隐藏，已停止扫描')
  }

  /** 收扫描：会话收掉 + 状态归位（幂等）。收框由会话负责（见 scan-window.js）。 */
  function closeSession(): void {
    const s = session
    session = null
    state.scanning = false
    state.capturing = false
    if (s) { try { s.close() } catch (_) {} }
  }

  /** 建会话：把引擎需要的端口与回调一次交齐（之后它自己管事件订阅）。 */
  function createSession(): ScanSession {
    const factory = scanWindowFactory || createScanWindow
    return factory({
      client: clients.screen ?? undefined,
      // 流式抓帧在渲染层建 video / canvas（首选路径）；不可用时自动回退到 IPC 抓帧
      doc: doc ?? undefined,
      subscribe,
      events,
      // 认出一个码（一帧可能有多个）→ 去重后入库
      onText: (text) => handleResult(text),
      // 抓完一帧的总结：只用来决定状态条文案（"没认到"是常态，不是错误）
      onScan: (res) => { state.lastScanEmpty = !res || !res.texts || res.texts.length === 0; emitChange() },
      onError: (reason) => { state.error = reason; emitChange() },
      onClosed: () => onFrameClosed(),
      onFrame: (frame) => {
        // 抓到好帧就把上一次的抓帧错误清掉（拖出屏幕那类错误会在拖回来后自愈）
        if (frame && frame.ok === true && state.error) { state.error = null; emitChange() }
      },
      onCapture: (busy) => { state.capturing = busy === true; emitChange() }
    })
  }

  /**
   * 收到一个扫到的文本。
   *
   * **必须去重**：同一帧里同一个码可能被两条路径命中，用户也可能反复扫同一个码。
   * 重复命中不新增条目，而是把次数 +1 —— 既压住噪音，用户也能看出"又扫到它了"。
   */
  function handleResult(raw: unknown): void {
    const text = String(raw == null ? '' : raw).trim()
    if (!text) return
    if (!state.scanning) return
    const existing = state.results.find((r) => r.text === text)
    if (existing) {
      existing.count = (existing.count || 1) + 1
      state.lastHit = {
        seq: ++state.hitSeq, id: existing.id, isNew: false,
        title: existing.title, label: existing.label, count: existing.count
      }
      emitHit()
      return
    }
    const classified = classifyQrText(text)
    const entry = { id: `qr-${++seq}`, count: 1, ...classified }
    state.results.unshift(entry)
    state.lastHit = {
      seq: ++state.hitSeq, id: entry.id, isNew: true,
      title: entry.title, label: entry.label, count: entry.count
    }
    emitHit()
  }

  return {
    state,

    start() {
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibility)
      }
      // 软依赖对账：验证器引擎启停后（插件管理窗口里就能改），这里跟着变
      const plugins = clients.plugins
      if (plugins && typeof plugins.onChanged === 'function') {
        unsubscribePlugins = plugins.onChanged(() => { refreshTotpAvailability() })
      }
      // 「放下取景框」与「取景框被关掉」两条事件**都由会话订阅**（只在扫描期间挂着，
      // 见 scan-window.js 的 arm/disarm）—— 这里不再自己订。
      refreshTotpAvailability()
      // 引擎（抓屏能力所在的那个插件）启停后立刻跟着变：插件管理窗口里关掉引擎，
      // 这个面板同一刻就得说"扫不了"，而不是等用户点了才发现。
      if (typeof onFeaturesChanged === 'function') {
        unsubscribeFeatures = onFeaturesChanged(() => { refreshScanSupported() })
      }
      refreshScanSupported()
      return Promise.resolve()
    },

    stop() {
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibility)
      }
      if (typeof unsubscribePlugins === 'function') { try { unsubscribePlugins() } catch (_) {} }
      unsubscribePlugins = null
      if (typeof unsubscribeFeatures === 'function') { try { unsubscribeFeatures() } catch (_) {} }
      unsubscribeFeatures = null
      // 面板被销毁时把浮框一起带走 —— 一个没有面板的置顶框会一直挂在那儿
      closeSession()
      if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null }
    },

    // ── 扫描 ──────────────────────────────────────────────────

    /**
     * 开始扫描：开会话（开框 → 准备解码器 → 落位后自动扫一帧）。
     *
     * 时序全在 `scan-window.js` 里 —— 本面板只负责状态与提示。
     */
    startScan() {
      if (state.scanning) return Promise.resolve(state)
      /**
       * 不可用时（引擎被关 / 没装）**直接说清是哪一种**，不发那趟必然失败的 IPC。
       * 视图在不可用时不会渲染「扫描屏幕」（见 view），这条是给"命令面板 / 快捷键"
       * 那类非界面入口兜的底 —— 同一个动作只有一个入口口径。
       */
      if (!state.screenSupported) {
        state.notice = { text: '扫不了：需要启用「扫码器引擎」插件', kind: 'error' }
        emitChange()
        return Promise.resolve({ ok: false, reason: 'engine-unavailable' })
      }
      state.scanning = true
      state.error = null
      state.notice = null
      state.lastHit = null
      state.lastScanEmpty = null
      session = createSession()
      emitChange()
      return Promise.resolve(session.open()).then((res) => {
        if (!state.scanning) return state
        if (!res || res.ok !== true) {
          state.error = (res && res.reason) || '无法开始扫描'
          closeSession()
          emitChange()
        }
        return state
      }).catch((e) => {
        state.error = (e && e.message) || '无法开始扫描'
        closeSession()
        emitChange()
        return state
      })
    },

    /** 停止扫描（幂等）：收会话 + 收起取景框。 */
    stopScan() {
      closeSession()
      emitChange()
    },

    /**
     * 抓**一帧**并解码。
     *
     * 「重新扫描」按钮与"放下取景框"共用这一条 —— 两者是同一件事：现在就看一下。
     * 防重入与结果分发都在会话里（`onText` / `onScan` / `onCapture` 回调）。
     */
    runScan() {
      if (!state.scanning || !session) return Promise.resolve(null)
      state.error = null
      return Promise.resolve(session.rescan())
    },

    // ── 识别记录（只在本次会话）───────────────────────────────

    clearResults() {
      state.results = []
      state.lastHit = null
      state.notice = null
      state.lastScanEmpty = null
      emitChange()
    },

    removeResult(id: string) {
      state.results = state.results.filter((r) => r.id !== id)
      emitChange()
    },

    /** 复制原始文本（**永远复制扫码那一刻的真值**，不是我们补全过的 href）。 */
    copyResult(id: string) {
      const r = state.results.find((x) => x.id === id)
      if (!r) return Promise.resolve(false)
      return copyText(r.text, doc).then((ok) => {
        if (!ok) { setNotice('复制失败（剪贴板不可用）', 'error'); return false }
        state.copiedId = id
        emitChange()
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          state.copiedId = null
          copiedTimer = null
          emitChange()
        }, COPIED_FEEDBACK_MS)
        return true
      })
    },

    /** 打开扫到的链接（网址 / mailto / tel…）。 */
    openResult(id: string) {
      const r = state.results.find((x) => x.id === id)
      if (!r || !isOpenable(r)) return Promise.resolve(false)
      const href = r.href
      if (!href) return Promise.resolve(false)
      const tabs = clients.tabs
      // 面板里打开链接一律**新开标签**（查阅入口不顶掉当前页面）。
      if (!tabs || typeof tabs.newTab !== 'function') {
        setNotice('无法打开链接（导航端口不可用）', 'error')
        return Promise.resolve(false)
      }
      return Promise.resolve(tabs.newTab({ url: href })).then((raw) => {
        const res = raw && typeof raw === 'object' ? raw as { ok?: boolean; reason?: string } : null
        if (res && res.ok === false) setNotice(res.reason || '打开失败', 'error')
        else if (r.schemeMissing) setNotice('已按 https:// 打开（原内容未带协议）')
        return res
      }).catch((e) => {
        setNotice((e && e.message) || '打开失败', 'error')
        return false
      })
    },

    /** 把 `otpauth://` 交给验证器引擎（**软依赖**：引擎不在就不给这个按钮）。 */
    addToTotp(id: string) {
      const r = state.results.find((x) => x.id === id)
      if (!r || r.kind !== QR_CONTENT.OTPAUTH) return Promise.resolve(false)
      const totp = clients.totp
      if (!state.totpAvailable || !totp || typeof totp.importUris !== 'function') return Promise.resolve(false)
      return Promise.resolve(totp.importUris([r.text])).then((res) => {
        if (!res.ok) {
          setNotice(res.reason, 'error')
          return res
        }
        const added = res.added
        if (added.length) setNotice('已添加到验证器')
        else setNotice('未能添加（可能已存在）', 'error')
        return res
      }).catch((e) => {
        setNotice((e && e.message) || '添加到验证器失败', 'error')
        return false
      })
    },

    copyText: (text: unknown) => copyText(text, doc),
    setNotice
  }
}

export type QrScannerModel = ReturnType<typeof createQrScannerModel>
