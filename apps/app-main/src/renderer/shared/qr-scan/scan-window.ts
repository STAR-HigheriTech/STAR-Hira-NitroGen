/**
 * 取景框扫码会话 —— **扫码器引擎的可调用接口**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这一层（而不是让每个面板各自去开框 / 抓帧 / 订事件）
 * ══════════════════════════════════════════════════════════════════════
 * 「扫屏幕上的二维码」这件事由三样东西拼成：
 *   · **取景框窗口**  —— 核心的窗口设施（`screen:*` 通道，主进程单例、置顶、透明）；
 *   · **抓帧能力**    —— `qr.captureScreen`（由「扫码器」插件提供，禁用即真的没有）；
 *   · **解码**        —— `detector.js`（原生 `BarcodeDetector` → `qr` 兜底）。
 * 任何想用它的界面都得把这三样按**同一条时序**接起来：开框 → 等用户放下
 * （`qrScanSettled`）→ 抓一帧 → 关框时收摊。把这条时序抄第二遍，就是第二个只会
 * 在它自己那儿出错的坑。
 *
 * 所以收成**一个会话对象**：
 *
 *     const session = createScanWindow({ client, subscribe, events, onText, onClosed })
 *     await session.open()      // 开框 + 准备解码器 + 落位后自动扫一帧
 *     await session.rescan()    // 用户点「重新扫描」
 *     session.close()           // 收框 + 收摊（幂等）
 *
 * 「验证器」面板与「扫码器」面板**都是它的调用方** —— 后者不是前置条件：扫码器面板
 * 只是这个接口的一个消费者，界面本身不提供任何能力（能力的归属见
 * `main/ipc/screen.js` 文件头那三行）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 触发式：静止时零抓屏、零解码、零 IPC
 * ══════════════════════════════════════════════════════════════════════
 * 只在三个时刻抓**一帧**：①开框落位后一拍 ②`qrScanSettled`（用户把框放下了）
 * ③`rescan()`。理由见 `screen.js` 文件头 —— 持续抓整屏会把主进程占死。
 *
 * ══════════════════════════════════════════════════════════════════════
 * `frameSeen`：区分"框还没显示"与"框被关掉了"
 * ══════════════════════════════════════════════════════════════════════
 * 浮框是先建窗口、就绪后才显示的，刚开的头几帧主进程量不到它的矩形（`framed:false`）。
 * 若不区分，扫描会在刚启动时把自己判成"框被关了"而收摊。
 */

import { createScreenScanner } from './screen.js'
import { createStreamScanner, isStreamScanSupported } from './stream.js'
import type { QrCaptureFrame, QrFrameClient, QrScanResult, QrScanner } from './types.js'

interface QrClientPort extends QrFrameClient {
  openFrame(): Promise<QrScanResult> | QrScanResult
  closeFrame?(): Promise<unknown> | unknown
}
interface QrScannerDeps {
  doc?: Document | null
  client: QrFrameClient
  onFrame?(frame: QrCaptureFrame): void
  onError?(reason: string): void
}
interface QrScanWindowPorts {
  client?: QrClientPort
  doc?: Document
  subscribe?: ((route: string, handler: (...args: unknown[]) => void) => () => void) | null
  events?: { qrScanSettled?: string; qrScanFrameClosed?: string } | null
  scannerFactory?: (deps: QrScannerDeps) => QrScanner
  streamFactory?: (deps: QrScannerDeps) => QrScanner
  disableStream?: boolean
  firstScanDelayMs?: number
  onText?: (text: string) => void
  onScan?: (result: { ok: boolean; texts: string[] }) => void
  onError?: (reason: string) => void
  onClosed?: () => void
  onFrame?: (frame: QrCaptureFrame) => void
  onCapture?: (capturing: boolean) => void
}
export interface QrScanWindowController {
  readonly isOpen: boolean
  readonly isCapturing: boolean
  readonly isStreaming: boolean
  open(): Promise<QrScanResult>
  close(): void
  rescan(): Promise<QrScanResult | null>
}

/**
 * 开框之后等多久抓第一帧。
 *
 * 框是"先建窗口、就绪后才显示"，初始位置由主进程按光标算 —— 太早抓会拿到一个还没
 * 落位的框。等它显示出来再扫一次既准又便宜（就一帧）。
 */
export const FIRST_SCAN_DELAY_MS = 420

/**
 * 环境能不能开取景框（端口在不在）。
 *
 * ⚠ 只看**端口**。抓帧能力是否可用是另一回事（插件可能被禁用）—— 那由
 * `features-client` 的 `qrScan` 功能面负责，界面据此决定给不给入口。
 */
export function isScanWindowSupported(client: QrClientPort | null | undefined): client is QrClientPort {
  return !!(client
    && typeof client.captureScreen === 'function'
    && typeof client.openFrame === 'function')
}

/**
 * @param {{
 *   client?: object,                                   // ctx.clients.screen
 *   doc?: Document,                                    // 流式抓帧要建 video/canvas（不摸全局）
 *   subscribe?: ((route: string, handler: Function) => Function)|null,  // ctx.on
 *   events?: object|null,                              // ctx.events（事件名表）
 *   scannerFactory?: Function,                         // IPC 抓帧实现（回退路径，可注入）
 *   streamFactory?: Function,                          // 流式抓帧实现（首选路径，可注入）
 *   disableStream?: boolean,                           // 关掉流式（诊断/测试用）
 *   firstScanDelayMs?: number,
 *   onText?: (text: string) => void,                   // 每认出一个码（可能一帧多个）
 *   onScan?: (result: { ok: boolean, texts: string[] }) => void,  // 每抓完一帧（含"一个都没认出"）
 *   onError?: (reason: string) => void,                // 抓帧/解码失败（"没认到"不算）
 *   onClosed?: () => void,                             // 用户点 ✕ 关了取景框
 *   onFrame?: (frame: object) => void,                 // 原始抓帧结果（供调用方清错）
 *   onCapture?: (capturing: boolean) => void           // 「正在识别这一刻」的忙闲
 * }} [ports]
 */
export function createScanWindow(ports: QrScanWindowPorts = {}): QrScanWindowController {
  const client = ports.client || null
  const doc = ports.doc || (typeof document === 'undefined' ? null : document)
  const subscribe = typeof ports.subscribe === 'function' ? ports.subscribe : null
  const events = ports.events || null
  const scannerFactory = typeof ports.scannerFactory === 'function' ? ports.scannerFactory : null
  const streamFactory = typeof ports.streamFactory === 'function' ? ports.streamFactory : null
  const disableStream = ports.disableStream === true
  const firstScanDelayMs = Number.isFinite(ports.firstScanDelayMs)
    ? Number(ports.firstScanDelayMs)
    : FIRST_SCAN_DELAY_MS

  const onText = typeof ports.onText === 'function' ? ports.onText : () => {}
  const onScan = typeof ports.onScan === 'function' ? ports.onScan : null
  const onError = typeof ports.onError === 'function' ? ports.onError : () => {}
  const onClosed = typeof ports.onClosed === 'function' ? ports.onClosed : () => {}
  const onFrame = typeof ports.onFrame === 'function' ? ports.onFrame : null
  const onCapture = typeof ports.onCapture === 'function' ? ports.onCapture : null

  let scanner: QrScanner | null = null
  /** 流式抓帧的启动在途（`open()` 里先发起、再与开框的结果汇合）。 */
  let streamPromise: Promise<QrScanResult> | null = null
  /** 会话是否开着（开框到收框之间为 true）。 */
  let active = false
  /** 正在抓这一帧 + 解码（防重入：落下 + 手动点按可能同时要求扫）。 */
  let capturing = false
  /** 是否**见到过**取景框（见文件头）。 */
  let frameSeen = false
  let firstScanTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribeSettled: (() => void) | null = null
  let unsubscribeClosed: (() => void) | null = null

  const report = (reason: string): void => { try { onError(reason) } catch (e) { console.error('[scan-window] onError:', e) } }
  const notifyCapture = (value: boolean): void => {
    if (!onCapture) return
    try { onCapture(value) } catch (e) { console.error('[scan-window] onCapture:', e) }
  }

  const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || '')

  // ── 事件订阅：只在会话开着时挂着（不扫描就没有监听器）──────────────

  function arm(): void {
    if (subscribe && events && events.qrScanSettled && !unsubscribeSettled) {
      unsubscribeSettled = subscribe(events.qrScanSettled, () => { rescan() })
    }
    if (subscribe && events && events.qrScanFrameClosed && !unsubscribeClosed) {
      unsubscribeClosed = subscribe(events.qrScanFrameClosed, () => { handleClosed() })
    }
  }

  function disarm(): void {
    for (const un of [unsubscribeSettled, unsubscribeClosed]) {
      if (typeof un === 'function') { try { un() } catch (_) {} }
    }
    unsubscribeSettled = null
    unsubscribeClosed = null
  }

  // ── 会话状态 ────────────────────────────────────────────────

  /** 收摊：清定时器 + 停扫描器（幂等）。**不**关框（关框是调用方/`close()` 的事）。 */
  function teardown(): void {
    if (firstScanTimer) { clearTimeout(firstScanTimer); firstScanTimer = null }
    if (scanner) { try { scanner.stop() } catch (_) {} scanner = null }
    streamPromise = null
    capturing = false
  }

  /** 用户真的把框关掉了（主进程的 `qrScanFrameClosed`）。 */
  function handleClosed(): void {
    if (!active) return        // `close()` 自己关的框也会回声上来 —— 这里挡掉
    active = false
    teardown()
    disarm()
    try { onClosed() } catch (e) { console.error('[scan-window] onClosed:', e) }
  }

  /** 每帧都能看到浮框的实时状态（见文件头 `frameSeen`）。 */
  function handleFrame(frame: QrCaptureFrame): void {
    if (onFrame) { try { onFrame(frame) } catch (_) {} }
    if (!frame) return
    if (frame.framed === true) { frameSeen = true; return }
    if (frameSeen) handleClosed()
  }

  function scheduleFirstScan(): void {
    if (firstScanTimer) clearTimeout(firstScanTimer)
    firstScanTimer = setTimeout(() => { firstScanTimer = null; rescan() }, firstScanDelayMs)
  }

  function fail(reason: string): string {
    active = false
    teardown()
    disarm()
    closeFrame()
    return reason
  }

  /** 关掉取景框（best-effort：这条通道不可用时不该再抛一次）。 */
  function closeFrame(): void {
    frameSeen = false
    if (!client || typeof client.closeFrame !== 'function') return
    try { Promise.resolve(client.closeFrame()).catch(() => {}) } catch (_) {}
  }

  /**
   * 抓**一帧**并解码。三个触发源共用这一条（落位 / 放下 / 手动重扫）。
   * @returns {Promise<{ ok: boolean, texts?: string[], busy?: boolean, reason?: string }|null>}
   */
  function rescan(): Promise<QrScanResult | null> {
    if (!active || capturing || !scanner || !scanner.isReady) return Promise.resolve(null)
    capturing = true
    notifyCapture(true)
    return Promise.resolve(scanner.scanOnce()).then((res) => {
      capturing = false
      notifyCapture(false)
      if (!active) return res
      // 交互中（用户又动起来了）→ 主进程这一帧什么都没抓：安静作废，不算失败
      if (res && res.busy === true) return res
      const texts = (res && res.ok === true && res.texts) || []
      for (const t of texts) {
        try { onText(String(t || '').trim()) } catch (e) { console.error('[scan-window] onText:', e) }
      }
      // 抓完一帧的总结（含"一个都没认出"）—— 调用方据此给"没认到"的提示
      if (onScan) {
        try { onScan({ ok: !!(res && res.ok === true), texts }) } catch (e) { console.error('[scan-window] onScan:', e) }
      }
      return res
    }).catch((e) => {
      capturing = false
      notifyCapture(false)
      report(errorMessage(e) || '识别失败')
      return null
    })
  }

  /**
   * 回退路径：IPC 抓帧（主进程回读整屏再裁）。
   *
   * 只在流式抓帧不可用时走（见 open）。它能用，但每次抓帧都要主进程做整屏回读 ——
   * 那正是"拖框卡一下、网页跟着卡"的来源，所以是回退而不是默认。
   */
  function startIpcScanner(): Promise<QrScanResult> {
    if (!client) return Promise.resolve({ ok: false, reason: '扫码器未就绪' })
    const factory = (scannerFactory || createScreenScanner) as unknown as (deps: QrScannerDeps) => QrScanner
    scanner = factory({
      client,
      onFrame: (frame) => handleFrame(frame),
      onError: (reason) => report(reason)
    })
    return Promise.resolve(scanner.start()).then((res) => {
      if (!active) return { ok: false, reason: '已取消' }
      if (!res || res.ok !== true) return { ok: false, reason: fail((res && res.reason) || '无法开始扫描') }
      scheduleFirstScan()
      return { ok: true }
    })
  }

  return {
    get isOpen() { return active },
    get isCapturing() { return capturing },
    /** 当前用的是不是流式抓帧（诊断用：面板状态条可以据此说"轻量模式"）。 */
    get isStreaming() { return !!(scanner && scanner.isStreaming) },

    /**
     * 开框 + 准备扫描器 + 落位后自动扫一帧。
     *
     * 顺序不能反 —— 抓帧的裁剪区就是框的矩形，框还没出现的话第一帧只会是整屏。
     *
     * ⚠ 两件事必须在**同一个同步片段**里发起（不能先 `await` 再发）：
     *   ① `openFrame()` —— 显示层的 `getDisplayMedia` 处理器要求"框开着"；
     *   ② 流式抓帧的 `start()` —— `getDisplayMedia` 要求**瞬时用户激活**
     *      （用户点「扫描屏幕二维码」那一下）。晚一个 await 再发就可能被拒，
     *      而拒了就只能走回退路径（能用但卡）—— 白跑一趟的代价不值得付。
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    open() : Promise<{ ok: boolean, reason?: string }> {
      if (active) return Promise.resolve({ ok: true })
      if (!client || !isScanWindowSupported(client)) {
        const reason = '当前环境不支持屏幕扫码（宿主未提供取景框端口）'
        report(reason)
        return Promise.resolve({ ok: false, reason })
      }
      const activeClient = client
      active = true
      frameSeen = false
      arm()
      const opened = activeClient.openFrame()
      /**
       * 流式优先：屏幕像素不进主进程。失败（权限/平台/手势）**不报错给用户** ——
       * 立刻回退到 IPC 抓帧，功能照旧，只是没拿到那个性能红利。
       */
      let streamScanner: QrScanner | null = null
      if (!disableStream && isStreamScanSupported()) {
        const factory = (streamFactory || createStreamScanner) as unknown as (deps: QrScannerDeps) => QrScanner
        try {
          const candidate = factory({ doc, client: activeClient, onError: (reason) => report(reason) })
          streamScanner = candidate
          const started = candidate.start()   // ← 同步进入 getDisplayMedia，保住用户手势
          streamPromise = Promise.resolve(started).then((res) => {
            if (!active) { try { candidate.stop() } catch (_) {} return { ok: false, reason: '已取消' } }
            if (!res || res.ok !== true) {
              // 流不可用 → 回退。**先把话说出去**（诊断用），用户侧无感。
              console.info('[scan-window] 屏幕流不可用，回退到 IPC 抓帧：', (res && res.reason) || '未知原因')
              return startIpcScanner()
            }
            scanner = candidate
            scheduleFirstScan()
            return { ok: true }
          })
        } catch (e) {
          console.info('[scan-window] 屏幕流启动异常，回退到 IPC 抓帧：', errorMessage(e))
          streamScanner = null
        }
      }
      return Promise.resolve(opened).then((result) => {
        const res = result as QrScanResult
        if (!active) return { ok: false, reason: '已取消' }
        if (!res || res.ok !== true) {
          if (streamScanner) { try { streamScanner.stop() } catch (_) {} }
          return { ok: false, reason: fail((res && res.reason) || '无法打开取景框') }
        }
        if (streamPromise) return streamPromise
        return startIpcScanner()
      }).catch((e: unknown) => ({ ok: false, reason: fail(errorMessage(e) || '无法开始扫描') }))
    },

    /**
     * 收框 + 收摊（幂等）。
     *
     * 先置 `active = false` 再关框：主进程的 `qrScanFrameClosed` 回声因此被
     * `handleClosed()` 挡掉 —— 否则"自己关的框"会被当成"用户关的框"再报一次。
     */
    close() {
      active = false
      teardown()
      disarm()
      closeFrame()
    },

    /** 现在就抓一帧（「重新扫描」/ 手动重试）。 */
    rescan
  }
}

