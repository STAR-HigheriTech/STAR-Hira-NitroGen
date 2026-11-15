/**
 * 验证器面板的**状态模型**（不含任何 DOM）。
 *
 * 分工（与 panel-notes 同一套）：
 *   · 本文件 —— 一处状态 + 一处数据来源（IPC 客户端），对外暴露语义化动作与选择器；
 *   · `panel-totp.view.js` —— 只读状态、只画、只把用户意图转成对本模型的调用；
 *   · `panel-totp.renderer.js` —— 把两者与宿主端口接起来。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么把"时间"与"数据"分成两条信号（onChange / onTick）
 * ══════════════════════════════════════════════════════════════════════
 * 倒计时**每秒**都要变。如果每秒都发一次"数据变了"让视图重建列表，
 * 一屏十几条就是每秒几十次 DOM 重建 —— 输入框会失焦、滚动位置会跳、点击会丢。
 * 所以：
 *   · `onChange` 只在**结构**变化时发（条目增删改、搜索词、切换视图）→ 视图重建；
 *   · `onTick`   每秒发一次，视图据此**只改码文本与进度条**（两个节点的属性）。
 * 这是这个面板流畅与否的关键，不是微优化。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 倒计时为什么用服务端时间
 * ══════════════════════════════════════════════════════════════════════
 * 验证码是**主进程按它的时钟**算的。渲染层若各自 `Date.now() % period`，
 * 时钟差几秒就会让进度环与"还剩几秒"对不上（甚至码已经换了而进度还剩 3 秒）。
 * 所以记一个 `clockSkew = serverNow - localNow`，之后本地推进时间都用它校正。
 */

import { decodeImport } from './totp-import/index.js'
// 剪贴板是**跨面板**共用能力（本面板与「扫码器」都要复制）—— 共用一处实现
import { copyText } from '../src/renderer/shared/clipboard'
// 二维码能力来自**共享内核**（`shared/qr-scan/`）—— 本仓库所有扫码路径（本面板、
// 独立「扫码器」插件）共用同一份引擎与取帧，不存在"两处实现各扫各的"。
import { decodeQrImages } from '../src/renderer/shared/qr-scan/image.js'
// 屏幕取景框 = 扫码器引擎的**可调用接口**（见 shared/qr-scan/scan-window.js）：
// 本面板直接调起取景框扫屏幕并导入，**不需要**用户先开「扫码器」面板，也不需要摄像头。
import { createScanWindow, isScanWindowSupported } from '../src/renderer/shared/qr-scan/scan-window.js'
// 「屏幕扫码」是否可用（扫码器插件被禁用 = 功能真的没了，那就不给入口）——
// 走功能面可用性的单例 store（§10.4），与书签栏/星标等二十个入口同一条口径。
import { isFeatureAvailable, onFeaturesChanged } from '../src/renderer/shared/features-client.js'
import type {
  ClockCalibration,
  TotpAddInput,
  TotpAddResult,
  TotpCalibrationResult,
  TotpCode,
  TotpCodeSnapshot,
  TotpEntry,
  TotpExportResult,
  TotpImportResult,
  TotpRemoveResult,
  TotpUpdateInput,
  TotpUpdateResult
} from '@hira-ng/domain-totp'

type ScanWindowOptions = NonNullable<Parameters<typeof createScanWindow>[0]>
type ScreenPort = NonNullable<ScanWindowOptions['client']>
type TimerHandle = ReturnType<typeof setTimeout>

interface TotpPanelClient {
  list(): Promise<TotpEntry[]>
  code(id?: string): Promise<TotpCodeSnapshot>
  add(input: TotpAddInput): Promise<TotpAddResult>
  update(id: string, patch?: TotpUpdateInput): Promise<TotpUpdateResult>
  remove(id: string): Promise<TotpRemoveResult>
  importUris(uris: readonly string[] | string): Promise<TotpImportResult>
  exportUri(id: string): Promise<TotpExportResult>
  calibrate(options?: { reset?: boolean }): Promise<TotpCalibrationResult>
  onChanged(listener: () => void): () => void
}

interface TotpConfirmOptions {
  title: string
  message: string
  danger?: boolean
  confirmLabel?: string
}

interface TotpModelOptions {
  onChange?: () => void
  onTick?: () => void
  confirm?: (options: TotpConfirmOptions) => boolean | Promise<boolean>
  doc?: Document | null
  screen?: ScreenPort | null
  subscribe?: ScanWindowOptions['subscribe']
  events?: ScanWindowOptions['events']
  scanWindow?: typeof createScanWindow
}

interface TotpNotice {
  text: string
  kind: 'info' | 'error'
}

export interface TotpPendingItem {
  id: string
  text: string
  chip: string
  title: string
  label: string
  error?: string | null
}

export interface TotpScanState {
  open: boolean
  capturing: boolean
  error: string | null
  seen: string[]
  pending: TotpPendingItem[]
  message: string | null
  lastWasUsable: boolean | null
  lastAddedId: string | null
}

interface TotpImportDisplay {
  ok: boolean
  added: TotpEntry[]
  skipped: Array<{ index: number; reason: string }>
  reason?: string
  format?: string
  label?: string
  warnings?: string[]
}

export interface TotpPanelState {
  loaded: boolean
  error: string | null
  entries: TotpEntry[]
  codes: Map<string, TotpCode>
  unavailable: Set<string>
  clockSkew: number
  clock: ClockCalibration
  calibrating: boolean
  query: string
  mode: 'list' | 'form' | 'scan' | 'import'
  editing: TotpEntry | null
  notice: TotpNotice | null
  importResult: TotpImportDisplay | null
  revealed: { id: string; uri: string } | null
  copiedId: string | null
  scan: TotpScanState
  scanSupported: boolean
}

/** 兼容别名：本文件的 `copyText` 曾在这里定义，移到共享模块后原样再导出。 */
export { copyText }

/** 搜索匹配：issuer / account 任一包含（忽略大小写）。 */
export function matchesEntry(entry: Pick<TotpEntry, 'issuer' | 'account'>, q: unknown): boolean {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return true
  return [entry.issuer, entry.account].some((v) => String(v || '').toLowerCase().includes(needle))
}

/**
 * 把验证码分成两半显示（"123 456"）—— 六位连读容易串行，分组后好念也好核对。
 * 八位则按 4+4 分。
 */
export function formatCode(code: unknown): string {
  const s = String(code || '')
  if (s.length === 6) return `${s.slice(0, 3)} ${s.slice(3)}`
  if (s.length === 8) return `${s.slice(0, 4)} ${s.slice(4)}`
  return s
}

/**
 * 把「本机时钟 vs 网络时间」的偏移说成人话（`offsetMs` 为正 = 本机慢）。
 *
 * 500ms 以内算准：TOTP 窗口是 30 秒，亚秒级漂移对码没有影响，
 * 这时说"本机时间准确"比报一个 137 毫秒的数字更有用（后者只会让人以为出了问题）。
 */
export function formatClockOffset(offsetMs: unknown): string {
  const ms = Number(offsetMs)
  if (!Number.isFinite(ms)) return '未校准'
  const abs = Math.abs(Math.round(ms))
  if (abs < 500) return '本机时间准确'
  const slow = ms > 0
  const secs = abs < 10000 ? (abs / 1000).toFixed(1) : String(Math.round(abs / 1000))
  return `本机${slow ? '慢' : '快'} ${secs} 秒`
}

/**
 * 把一条待导入的二维码**描述**成界面上要显示的三样东西。
 *
 * **刻意不做解析**：这一步在扫码的每一帧上跑，不该有失败面、也不该花成本 ——
 * 只看形状就够了：
 *   · `chip` —— 中文类型名（与「扫码器」面板的 chip 同一套语言）；
 *   · `title` —— 用户用来核对的那一行（`issuer:account`）；
 *   · `label` —— 一句话概括（清单为空时的兜底文案）。
 */
export function describePending(text: unknown): { chip: string; title: string; label: string } {
  const t = String(text || '')
  if (/^otpauth-migration:/i.test(t)) {
    return { chip: '迁移码', title: '验证器迁移码（一批多条）', label: '验证器迁移码（一批多条）' }
  }
  const m = /otpauth:\/\/[^/]*\/([^?]+)/i.exec(t)
  let label = 'otpauth 链接'
  if (m && m[1]) {
    try { label = decodeURIComponent(m[1]).slice(0, 48) } catch (_) { label = m[1].slice(0, 48) }
  }
  return { chip: '验证器密钥', title: label, label }
}

export function createTotpModel(client: TotpPanelClient, options: TotpModelOptions = {}) {
  const onChange = options.onChange ?? (() => {})
  const onTick = options.onTick ?? (() => {})
  const confirmPort = options.confirm ?? null
  /** 剪贴板兜底路径要建临时节点 —— 用宿主注入的 doc，不摸全局（与其它 ui 包同一纪律）。 */
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document)
  /** 抓帧端口（`ctx.clients.screen`）—— 取景框扫码的唯一数据来源。 */
  const screen = options.screen ?? null
  /** 取景框会话工厂可注入（端口注入的既有风格）—— 于是"在哪些路径上被收掉"可单测。 */
  const scanWindowFactory = options.scanWindow ?? null

  const state: TotpPanelState = {
    loaded: false,
    error: null,
    /** 条目列表（无密钥字段） */
    entries: [],
    /** id → { code, type, remaining, period }；HOTP 的 remaining/period 是 null */
    codes: new Map<string, TotpCode>(),
    /** 本机解不开密钥的条目 id（换机器 / 数据损坏）—— 要显示出来，不能静默少几条 */
    unavailable: new Set<string>(),
    /** 服务端毫秒时间 与 本地时钟偏移（serverNow - localNow） */
    clockSkew: 0,
    /**
     * 已保存的「联网校准」结果 `{ offsetMs, measuredAt, source }`。
     *
     * 与 `clockSkew` 是两件事：`clockSkew` 只用来对齐**这一帧**的倒计时；
     * 这一份是主进程持久化的、真正参与算码的偏移 —— 校准后 `code()` 返回的
     * `now` 里已经叠加了它，所以上面那个 skew 会自动跟着变。
     * `offsetMs = 0` 且 `measuredAt = 0` = 未校准（纯本机时间）。
     */
    clock: { offsetMs: 0, measuredAt: 0, source: null },
    /** 正在联网校准（按钮据此禁用 + 换文案，防连点） */
    calibrating: false,
    query: '',
    /** 'list' | 'form' | 'scan' | 'import'（扫码与导入是**两个界面**，见 view） */
    mode: 'list',
    /** 正在编辑的条目（null = 新增） */
    editing: null,
    /** { text, kind } —— 就地提示，不弹窗 */
    notice: null,
    /** 导入结果 { added, skipped } */
    importResult: null,
    /** 已导出的链接 { id, uri }（唯一会拿到密钥的地方） */
    revealed: null,
    /** 刚复制过的条目 id（"已复制"反馈，1.2 秒后自动清） */
    copiedId: null,
    /**
     * 屏幕取景框扫码 —— **不是**一个独立的界面模式。
     *
     * 取景框是**独立的置顶窗口**（主进程的窗口设施），不占面板的地方，所以面板停在
     * 导入屏上就够了；这一块状态只描述"框开着没有 / 认到几张 / 最近一句结果"。
     */
    scan: {
      /** 取景框是否开着（= 会话活着） */
      open: false,
      /** 正在抓这一帧 + 解码 */
      capturing: false,
      /** 抓帧/解码的硬错误（"这一帧没认到"不算错误，走 message） */
      error: null,
      /** 去重用的原文（**不是**给用户看的） */
      seen: [],
      /**
       * **待用户确认**的二维码（只收验证器的内容）：`[{ text, label }]`。
       *
       * ⚠ 扫到就写库是错的：用户可能只是想把框挪到另一个码上，或者扫到的是别人的
       * 迁移码。所以这里先攒着、**由用户逐条确认后**才落库（见 importPendingAt）。
       * "扫码"是取件，"导入"才是签收，两件事不能合成一件。
       *
       * 存成对象数组而不是"两个平行数组"：`label` 与 `text` 必须一一对应，
       * 分开存就得在**每一处增删**都记得同步两遍 —— 迟早漏一处。
       */
      pending: [],
      /** 最近一句结果说明（"已扫到 2 张，点导入" / "这个码不是验证器内容"） */
      message: null,
      /** 最近一次命中是不是"能导入的内容"（视图据此决定卡片的颜色与语气） */
      lastWasUsable: null,
      /**
       * **最新扫到的那一条**的 id —— 界面据此给它常驻高亮、并让状态行绿一下
       * （与「扫码器」面板同一条规矩：命中必须"跳出来"，见 view 的 renderScanStatus）。
       */
      lastAddedId: null
    },
    /**
     * 「屏幕扫码」这个入口给不给。
     *
     * 两个条件缺一不可：①宿主给了抓帧/开框端口；②提供抓屏能力的「扫码器」插件
     * 没被显式禁用（§10.4 的功能面判定）。**不给一个点了就报错的按钮** ——
     * 这是本仓库反复避免的形态。
     */
    scanSupported: false
  }

  let unsubscribe: (() => void) | null = null
  let tickTimer: TimerHandle | null = null
  let copiedTimer: TimerHandle | null = null
  /** 取景框会话（一次扫码会话一个，收掉后置空 —— 见 scan-window.js）。 */
  let scanSession: ReturnType<typeof createScanWindow> | null = null
  let unsubscribeFeatures: (() => void) | null = null
  /** 待导入项的 id 序号（自增，永不复用）—— 界面靠它认"最新扫到的那一条"。 */
  let pendingSeq = 0

  const emitChange = () => { try { onChange() } catch (e) { console.error('[totp-panel] onChange error:', e) } }
  const emitTick = () => { try { onTick() } catch (e) { console.error('[totp-panel] onTick error:', e) } }

  /** 用服务端校正过的"现在"（秒）。 */
  function nowSec() {
    return Math.floor((Date.now() + state.clockSkew) / 1000)
  }

  /** 某个周期下还剩几秒（1..period；0 不会出现 —— 那一刻已经跨窗）。 */
  function remainOf(period: number): number {
    return period - (nowSec() % period)
  }

  function setNotice(text: unknown, kind: 'info' | 'error' = 'info'): void {
    const value = String(text ?? '')
    state.notice = value ? { text: value, kind: kind === 'error' ? 'error' : 'info' } : null
    emitChange()
  }

  /** 拉码（不重拉列表）。 */
  function fetchCodes() {
    return client.code().then((res) => {
      const codes = new Map()
      for (const c of (res && res.codes) || []) codes.set(c.id, c)
      state.codes = codes
      state.unavailable = new Set((res && res.unavailable) || [])
      // 主进程已把校准偏移叠进 `now`，这里照抄即得"服务端时间"
      if (res && Number.isFinite(res.now)) state.clockSkew = res.now - Date.now()
      if (res && res.clock) state.clock = res.clock
      emitChange()
    }).catch((e) => {
      state.error = (e && e.message) || '读取验证码失败'
      emitChange()
    })
  }

  /** 拉列表 + 码（打开面板 / 增删改之后走这条）。 */
  function refresh() {
    return client.list().then((entries) => {
      state.entries = Array.isArray(entries) ? entries : []
      state.loaded = true
      state.error = null
      return fetchCodes()
    }).catch((e) => {
      state.error = (e && e.message) || '加载验证器条目失败'
      state.loaded = true
      emitChange()
    })
  }

  /**
   * 每秒一跳。
   *
   * 跨窗的判据是"剩余**变大**了"（period→1 是正常递减，1→period 说明进了新窗口）——
   * 用 `=== period` 会在丢帧时漏掉，用"变大"则只要跨过去了就必然命中。
   * 跨窗才去问主进程要新码；其余时刻纯本地推进，零 IPC。
   */
  function tick() {
    let crossed = false
    for (const c of state.codes.values()) {
      if (c.period == null) continue          // HOTP 没有时间窗
      const next = remainOf(c.period)
      if (next > (c.remaining ?? c.period)) crossed = true
      c.remaining = next
    }
    emitTick()
    if (crossed) fetchCodes()
  }

  function startTicking() {
    if (tickTimer) return
    tickTimer = setInterval(tick, 1000)
  }
  function stopTicking() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  }

  /** 写入类动作的统一收尾：提示 + 重拉。 */
  function afterWrite(
    res: TotpAddResult | TotpUpdateResult | TotpRemoveResult | null,
    okText: string,
    fallbackErr: string
  ): boolean {
    if (!res || res.ok !== true) {
      setNotice((res && res.reason) || fallbackErr, 'error')
      return false
    }
    setNotice(okText, 'info')
    refresh()
    return true
  }

  /** 重算「屏幕扫码」入口给不给（端口 + 功能面，两条都要）。 */
  function refreshScanSupported() {
    const next = isScanWindowSupported(screen) && isFeatureAvailable('qrScan')
    const turnedOff = !next && state.scan.open
    if (next === state.scanSupported && !turnedOff) return
    state.scanSupported = next
    // 能力刚被禁用时把开着的框收掉 —— 留一个扫不出东西的取景框等于骗用户
    if (turnedOff) {
      const s = scanSession
      scanSession = null
      state.scan.open = false
      state.scan.capturing = false
      if (s) { try { s.close() } catch (_) {} }
    }
    emitChange()
  }

  /** 用户点了取景框的 ✕（主进程发 `qrScanFrameClosed`）—— 会话已自行收摊，这里同步状态。 */
  function onScanClosed() {
    scanSession = null
    state.scan.open = false
    state.scan.capturing = false
    state.scan.message = '取景框已关闭'
    emitChange()
  }

  /**
   * 面板/窗口不可见时立刻收框。
   *
   * 侧栏可以同时开着多个面板 —— 用户在扫码时切去别处，一个置顶取景框还挂在那儿
   * 继续扫屏幕，既说不通也不安全。
   */
  function onVisibility() {
    if (!doc || doc.hidden !== true) return
    if (!state.scan.open) return
    model.stopScanScreen()
    state.scan.message = '已停止扫码'
    emitChange()
  }

  const model = {
    state,

    /** 已按搜索词过滤的条目（视图只画这个）。 */
    visibleEntries() {
      return state.entries.filter((e) => matchesEntry(e, state.query))
    },

    start() {
      // 任何来源的变更（面板自身的写、插件管理窗口的写）都重拉一次：
      // 不区分来源 —— "谁改谁刷新"在跨窗口时必然漏。
      unsubscribe = client.onChanged(() => { refresh() })
      startTicking()
      // 「屏幕扫码」入口的可用性：端口给没给 + 「扫码器」插件被没被禁用。
      // 走单例 store（一次订阅、一次去重请求），插件启停会自动回流到这里。
      refreshScanSupported()
      unsubscribeFeatures = onFeaturesChanged(() => { refreshScanSupported() })
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibility)
      }
      return refresh()
    },

    stop() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      stopTicking()
      if (typeof unsubscribeFeatures === 'function') { try { unsubscribeFeatures() } catch (_) {} }
      unsubscribeFeatures = null
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibility)
      }
      // 组件销毁要把取景框一起带走 —— 一个没有面板的置顶框会一直挂在那儿扫屏幕
      model.stopScanScreen()
      if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null }
    },

    // ── 视图切换 ──────────────────────────────────────────────

    setQuery(q: unknown) {
      state.query = String(q || '')
      emitChange()
    },

    openForm(entry: TotpEntry | null) {
      model.stopScanScreen()   // 离开任何界面都收框（见 stopScanScreen 的说明）
      state.mode = 'form'
      state.editing = entry || null
      state.revealed = null
      setNotice('')
    },

    /**
     * 打开**扫码界面**（与「导入」界面分开的两个任务界面 —— 见 view 的 renderScanScreen）。
     *
     * 进去就**直接调起取景框**：用户点「扫码」就是要扫，不该再让他点一次"开始扫描"。
     * 启动失败时界面会显示原因，并给一个「打开取景框」的重试按钮。
     */
    openScan() {
      model.stopScanScreen()   // 上一次会话若还开着，先收干净
      state.mode = 'scan'
      state.importResult = null
      state.revealed = null
      setNotice('')
      return model.scanScreen()
    },

    /**
     * 打开导入屏（粘贴 / 截图 / 选图）。
     *
     * 自己也先 `stopScanScreen()`，**不依赖调用方记得关**：这个动作既可能从列表进来、
     * 也可能从扫码过程中进来，若把"收框"交给调用方，就总有一天会有人漏掉
     * —— 而漏掉的后果是一个置顶取景框一直挂在那儿。
     */
    openImport() {
      model.stopScanScreen()
      state.mode = 'import'
      state.importResult = null
      state.revealed = null
      setNotice('')
    },

    // ── 屏幕扫码（取景框 = 扫码器引擎的可调用接口）──────────────────
    //
    // 这里**没有摄像头**：扫的是屏幕，取景框是主进程的**独立置顶窗口**（见
    // `main/ipc/screen.js` 与 `shared/qr-scan/scan-window.js`）。所以本面板既不认识
    // 「窗口」，也不需要用户先开「扫码器」面板 —— 那个面板只是同一个引擎的另一位调用方。
    // 相机那一条路（`shared/qr-scan/camera.js`）已随本次改造删除：两条并存的扫码路径
    // 只会让"用哪条、什么时候关"变成两处必须同步的规则。

    /**
     * 调起取景框开始扫屏幕（幂等：已开着直接复用，用户可能连点两下）。
     *
     * 开框 → 准备解码器 → 落位后自动扫一帧，顺序在 `scan-window.js` 里。
     * 之后只在"用户把框放下"（`qrScanSettled`）与手动「重新扫描」时各抓一帧。
     */
    scanScreen() {
      if (state.scan.open) return Promise.resolve({ ok: true })
      if (!state.scanSupported) {
        setNotice('屏幕扫码不可用（需要启用「扫码器」插件）', 'error')
        return Promise.resolve({ ok: false, reason: 'unavailable' })
      }
      const factory = scanWindowFactory || createScanWindow
      scanSession = factory({
        client: screen ?? undefined,
        // 流式抓帧要在**渲染层**建 video / canvas（首选路径，见 shared/qr-scan/stream.js）；
        // 它不可用时 scan-window 自动回退到 IPC 抓帧，功能不会因此消失。
        doc: doc ?? undefined,
        subscribe: options.subscribe,
        events: options.events,
        // 认出一个码 → 直接走同一条 importText（见 handleScanText）
        onText: (text) => model.handleScanText(text),
        onError: (reason) => { state.scan.error = reason; emitChange() },
        onClosed: () => { onScanClosed() },
        onCapture: (busy) => { state.scan.capturing = busy === true; emitChange() }
      })
      state.scan.open = true
      state.scan.error = null
      state.scan.message = null
      state.scan.lastWasUsable = null
      state.scan.seen = []
      emitChange()
      return Promise.resolve(scanSession.open()).then((res) => {
        if (!res || res.ok !== true) {
          state.scan.open = false
          state.scan.capturing = false
          state.scan.error = (res && res.reason) || '无法打开取景框'
          scanSession = null
          emitChange()
        }
        return res
      })
    },

    /** 收起取景框（幂等）。上面每条离开扫码的路径都调它。 */
    stopScanScreen() {
      const s = scanSession
      scanSession = null
      state.scan.open = false
      state.scan.capturing = false
      if (s) { try { s.close() } catch (_) {} }
      emitChange()
    },

    /**
     * 认出一个码 → **只攒着，不写库**。
     *
     * 为什么不直接 `importText`（第一版就是这么做的，用户当场否掉）：
     *   · 取景框是"一直对准屏幕"的东西，用户把框从 A 码挪到 B 码的路上会连续命中，
     *     直接导入等于**替用户做了决定**，而且他连"刚加进去了什么"都来不及看；
     *   · 迁移码尤其敏感（一进去就是几十条账号）。"扫码"是取件，"导入"才是签收。
     *
     * 所以这里的产出只有两样：待导入清单（`pending`）和一句**醒目**的提示。
     * 落库由用户点卡片上的「导入」（`importScanned`）触发。
     *
     * 去重是必须的：同一次会话里把框挪回来很可能又扫到同一张。
     */
    handleScanText(raw: unknown) {
      const text = String(raw == null ? '' : raw).trim()
      if (!text || !state.scan.open) return null
      if (state.scan.seen.includes(text)) return null
      state.scan.seen.push(text)
      /**
       * 只收"验证器能认的内容"。用前缀判断而不是跑一遍适配器链：
       * 扫码是**逐帧**发生的，不该在每一帧上花解析成本；而验证器的二维码只有两种形状
       * （`otpauth://` 单条 / `otpauth-migration://` 批量），前缀就够精确。
       * 认不出的（网址、Wi-Fi、别人的码）如实说一句，但**不进清单** ——
       * 免得用户点了「导入」才发现里面混着没用的东西。
       */
      if (!/^otpauth/i.test(text)) {
        state.scan.lastWasUsable = false
        state.scan.message = '这不是验证器的二维码'
        emitChange()
        return null
      }
      const entry = { id: `p${++pendingSeq}`, text, ...describePending(text) }
      state.scan.pending.push(entry)
      state.scan.lastAddedId = entry.id
      state.scan.lastWasUsable = true
      state.scan.message = `已扫到 ${state.scan.pending.length} 张`
      emitChange()
      return null
    },

    /**
     * 导入**其中一条**（每项自己的「导入」按钮）。
     *
     * 逐条导入是默认路径：用户扫到一个就是一个，导完即从清单里摘掉；
     * 清单空了就自动收框回列表（这一次扫码的目的达成了）。
     */
    importPendingAt(index: number) {
      const item = state.scan.pending[index]
      if (!item) return Promise.resolve(null)
      item.error = null   // 重试前先清掉上一次的失败原因
      return model.importText(item.text).then((res) => {
        const added = (res && res.added) || []
        if (!added.length) {
          /**
           * 失败**保留在清单里**（用户还能重试或手动移除），并把**原因贴在这一条上**。
           *
           * ⚠ 这里曾经写死一句"未能添加（见下方）"，把 `importText` 已经给出的真实原因
           * **覆盖掉了**，而"下方"那个结果框只存在于**导入界面** —— 扫码界面根本没有它。
           * 于是用户看到的就是"导入失败，但不知道为什么"。两条失败路径要分开接住：
           *   · `importText` 自己就失败（认不出格式）→ 返回 null，原因已写在 `state.notice`；
           *   · 主进程逐条挡下来 → 返回 `{ added: [], skipped: [{ index, reason }] }`。
           * 优先用逐条那句（更具体），否则用 notice 里那句。
           */
          const skipped = (res && res.skipped) || []
          item.error = (skipped[0] && skipped[0].reason)
            || (state.notice && state.notice.text)
            || '未能添加'
          emitChange()
          return res
        }
        state.scan.pending.splice(index, 1)
        setNotice(`已添加 ${added.length} 条`)
        if (!state.scan.pending.length) {
          model.stopScanScreen()
          state.mode = 'list'
        }
        emitChange()
        return res
      })
    },

    /** 从待导入清单里移除一条（误扫进来的）。 */
    removePendingAt(index: number) {
      const item = state.scan.pending[index]
      if (!item) return
      state.scan.pending.splice(index, 1)
      /**
       * 同时**放开去重**（`seen`）：它是"同一次连续扫描里别重复计数"用的，不是黑名单 ——
       * 移掉之后再扫到同一张，用户显然是想把它加回来，不该被当成重复命中而静默吞掉。
       */
      state.scan.seen = state.scan.seen.filter((t) => t !== item.text)
      emitChange()
    },

    /**
     * **一次性全部导入**（清单多于一条时的批量入口）。
     *
     * 为什么除了逐条之外还需要它：Google 迁移码按每批 ~10 条拆成多张二维码，
     * 适配器必须**一起解析**才能把分批的账号合并起来（见 totp-import/google-migration.js）——
     * 逐条导入会得到"已包含 1/2 批"的提醒，而不是完整的账号列表。
     */
    importScanned() {
      const list = state.scan.pending.map((p) => p.text)
      if (!list.length) return Promise.resolve(null)
      return model.importText(list.join('\n')).then((res) => {
        const added = (res && res.added) || []
        if (added.length) {
          // 导入成功 = 这一次扫码的目的已达成 → 收框，并把面板回到列表看结果
          state.scan.pending = []
          state.scan.message = `已添加 ${added.length} 条`
          model.stopScanScreen()
          state.mode = 'list'
          emitChange()
        } else {
          /**
           * 批量失败：把**原因**说出来（同样的坑：写死一句"见下方"等于什么都没说 ——
           * 扫码界面没有那个结果框）。
           *
           * ⚠ 这里**刻意不按 `skipped[].index` 往项上贴原因**：那个 index 是
           * `decodeImport` 展开后的 **URI** 序号（一张迁移码会展开成几十条），
           * 与"第几张二维码"没有对应关系 —— 按它贴会把原因标到错误的那一条上，
           * 比不贴更糟。逐条导入时才能精确对应（见 importPendingAt）。
           */
          const skipped = (res && res.skipped) || []
          state.scan.message = (skipped[0] && skipped[0].reason)
            || (state.notice && state.notice.text)
            || '未能添加'
          emitChange()
        }
        return res
      })
    },

    backToList() {
      model.stopScanScreen()   // 同上：这是最常走的一条离开路径
      state.mode = 'list'
      state.editing = null
      state.importResult = null
      state.revealed = null
      setNotice('')
    },

    // ── 时钟校准 ──────────────────────────────────────────────
    //
    // 验证码是**主进程按本机时钟**算的。本机时间一旦漂移（虚拟机休眠、主板电池、
    // 长期不校时），算出来的码就会和服务器对不上，表现是"怎么输都错"。
    // 这里联网测一次「本机 vs 网络」的偏移，**只叠加到算码上**——
    // 不改系统时间：那需要管理员权限，而且会影响所有别的程序。

    /** 联网校准（按钮主操作）。 */
    async calibrate(): Promise<TotpCalibrationResult | null> {
      if (state.calibrating) return Promise.resolve(null)
      state.calibrating = true
      setNotice('正在联网校准…')
      try {
        const res = await client.calibrate()
        state.calibrating = false
        if (!res || res.ok !== true) {
          setNotice((res && res.reason) || '校准失败（检查网络后重试）', 'error')
          return res
        }
        state.clock = {
          offsetMs: Number(res.offsetMs) || 0,
          measuredAt: Number(res.measuredAt) || 0,
          source: res.source || null
        }
        setNotice(`已校准：${formatClockOffset(state.clock.offsetMs)}`)
        // 偏移改了 → 码必须重算（refresh 同时会带回新的 now，clockSkew 跟着对齐）
        await refresh()
        return res
      } catch (e) {
        state.calibrating = false
        setNotice(e instanceof Error ? e.message : '校准失败', 'error')
        return null
      }
    },

    /** 清掉已保存的偏移，回到纯本机时间。 */
    async resetClock(): Promise<TotpCalibrationResult | null> {
      if (state.calibrating) return Promise.resolve(null)
      state.calibrating = true
      setNotice('正在恢复本机时间…')
      try {
        const res = await client.calibrate({ reset: true })
        state.calibrating = false
        if (!res || res.ok !== true) {
          setNotice((res && res.reason) || '恢复本机时间失败', 'error')
          return res
        }
        state.clock = { offsetMs: 0, measuredAt: 0, source: null }
        setNotice('已恢复本机时间')
        await refresh()
        return res
      } catch (e) {
        state.calibrating = false
        setNotice(e instanceof Error ? e.message : '恢复本机时间失败', 'error')
        return null
      }
    },

    // ── 写 ────────────────────────────────────────────────────

    /** 保存表单（新增或编辑）。`input.secret` 为空时表示"不改密钥"。 */
    saveEntry(input: TotpAddInput) {
      const payload = {
        issuer: String(input.issuer || '').trim(),
        account: String(input.account || '').trim(),
        ...(input.secret ? { secret: input.secret } : {}),
        ...(input.algorithm ? { algorithm: input.algorithm } : {}),
        ...(input.digits != null ? { digits: input.digits } : {}),
        ...(input.period != null ? { period: input.period } : {}),
        ...(input.type ? { type: input.type } : {})
      }
      const req = state.editing
        ? client.update(state.editing.id, payload)
        : client.add(payload)
      return req.then((res) => {
        if (afterWrite(res, state.editing ? '已保存' : '已添加', '保存失败')) {
          state.mode = 'list'
          state.editing = null
          emitChange()
        }
        return res
      }).catch((e) => { setNotice((e && e.message) || '保存失败', 'error'); return null })
    },

    /** 删除（**必须二次确认** —— 删掉一条就等于弄丢一个账号的 2FA）。 */
    async removeEntry(id: string): Promise<boolean | TotpRemoveResult> {
      const entry = state.entries.find((e) => e.id === id)
      const name = entry ? [entry.issuer, entry.account].filter(Boolean).join(' ') || '这条' : '这条'
      /**
       * 没有确认端口就**不能删**（危险动作不能因为缺端口就默认放行），但也**不能什么都不做** ——
       * 早先这里直接 `return false`，于是"点了删除没反应"，用户完全不知道发生了什么。
       * 说清原因，比静默失败好得多。
       */
      if (!confirmPort) {
        setNotice('无法删除：宿主未提供确认框端口', 'error')
        return Promise.resolve(false)
      }
      const ok = await confirmPort({
        title: '删除验证器条目',
        message: `将删除「${name}」。删除后本机不再保存它的密钥，此后登录该账号需要重新绑定。确定继续吗？`,
        danger: true,
        confirmLabel: '删除'
      })
      if (!ok) return false
      try {
        const res = await client.remove(id)
        afterWrite(res, '已删除', '删除失败')
        return res
      } catch (e) {
        // 兜住整条链（确认框、IPC、写库都可能抛）—— 不兜的话失败会静默消失
        setNotice(e instanceof Error ? e.message : '删除失败', 'error')
        return false
      }
    },

    /**
     * 导入：把用户给的一坨东西交给**适配器链**（识别各家格式 → 标准 `otpauth://` 链接），
     * 再交给主进程解析、校验、加密、落库。
     *
     * 两层分工是刻意的：这一层只管"把别家的形状翻译成标准链接"（纯数据搬运），
     * 主进程只管"这链接对不对、密钥能不能存"。所以**认错格式也不会写坏数据** ——
     * 主进程会逐条挡住并报因。
     */
    importText(text: unknown) {
      const decoded = decodeImport(String(text ?? ''))
      if (!decoded.ok) {
        state.importResult = null
        setNotice(decoded.reason, 'error')
        return Promise.resolve(null)
      }
      setNotice(`已识别「${decoded.label}」，正在导入 ${decoded.uris.length} 条…`)
      return client.importUris(decoded.uris).then((res) => {
        state.importResult = res ? { ...res, format: decoded.format, label: decoded.label, warnings: decoded.warnings } : null
        if (res && res.added && res.added.length) {
          setNotice(`已导入 ${res.added.length} 条${res.skipped.length ? `，跳过 ${res.skipped.length} 条` : ''}`)
        } else {
          setNotice('没有导入任何条目（原因见下方）', 'error')
        }
        return refresh().then(() => res)
      }).catch((e) => { setNotice((e && e.message) || '导入失败', 'error'); return null })
    },

    /**
     * 从**图片**导入（截图 / 拍照的二维码）。
     *
     * 与文本导入的分工：这一步只多一件"图 → 文本"，得到的文本立刻走同一条
     * `importText` —— 于是两条入口的后续（识别格式、落库、去重、报因）**完全一致**，
     * 不存在"图片导入少了一道校验"。
     *
     * 多张图一起处理很重要：Google 的导出按每批 ~10 条拆成多张二维码，
     * 用户一次选完才是完整的账号列表。
     *
     * @param {FileList|File[]} files
     */
    importImages(files: FileList|File[]) {
      const list = Array.from(files || [])
      if (!list.length) return Promise.resolve(null)
      if (!doc) {
        setNotice('当前宿主无法读取本地图片', 'error')
        return Promise.resolve(null)
      }
      setNotice(`正在识别 ${list.length} 张图片…`)
      return decodeQrImages(doc, list).then((res) => {
        if (!res.texts.length) {
          // 解不出来时说清是**图的问题**（模糊/裁切），一句就够 —— 窄面板里长段落读不下去
          setNotice(
            res.total === 1
              ? '这张图里没有认到二维码（模糊或裁切过会解不出）'
              : `${res.total} 张图里没有认到二维码`,
            'error'
          )
          return null
        }
        if (res.failed) {
          // 部分失败要单独说 —— 不说的话用户会以为"我选了 3 张，怎么只进来 2 批的账号"
          setNotice(`已从 ${res.total - res.failed}/${res.total} 张图里认出二维码，正在导入…`)
        }
        return model.importText(res.texts.join('\n')).then((out) => {
          if (out && res.failed) {
            // 把"哪几张没认出来"补进结果框里，与导入结果一起看
            if (state.importResult) {
              state.importResult.warnings = [
                ...(state.importResult.warnings || []),
                `另有 ${res.failed} 张图没有认到二维码（可能不清晰或被裁切），请单独重试`
              ]
              emitChange()
            }
          }
          return out
        })
      }).catch((e) => {
        setNotice((e && e.message) || '图片识别失败', 'error')
        return null
      })
    },

    /** 导出某条的 `otpauth://` 链接（**唯一会拿到密钥的操作**）。
     * 只把它显示在一个只读框里供复制 —— 不弹窗、不落任何地方。
     */
    revealEntry(id: string) {
      return client.exportUri(id).then((res) => {
        if (!res || res.ok !== true) {
          setNotice((res && res.reason) || '导出失败', 'error')
          return res
        }
        state.revealed = { id, uri: res.uri }
        state.notice = null
        emitChange()
        return res
      }).catch((e) => { setNotice((e && e.message) || '导出失败', 'error'); return null })
    },

    closeReveal() {
      state.revealed = null
      emitChange()
    },

    /** 复制验证码（主操作）。反馈只标在那一行上，不弹全局提示。 */
    copyCode(id: string) {
      const c = state.codes.get(id)
      if (!c) return Promise.resolve(false)
      return copyText(c.code, doc).then((ok) => {
        if (!ok) { setNotice('复制失败（剪贴板不可用）', 'error'); return false }
        state.copiedId = id
        emitChange()
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          state.copiedId = null
          copiedTimer = null
          emitChange()
        }, 1200)
        return true
      })
    },

    copyText: (text: unknown) => copyText(text, doc),

    setNotice
  }

  return model
}

export type TotpModel = ReturnType<typeof createTotpModel>
