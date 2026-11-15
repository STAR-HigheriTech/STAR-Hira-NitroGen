import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface QrScanFramePort {
  setOnClosed?(listener: () => void): unknown
  bounds?(): unknown
  isBusy?(): boolean
  open?(): { ok?: boolean; error?: unknown } | null | undefined
  close?(): unknown
  drag?(request: unknown): unknown
  geometry?(): unknown
  setInteracting?(active: boolean): unknown
}
interface ScreenIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['screen']
  providerRegistry?: ProviderRegistryPort | null
  qrScanFrame?: QrScanFramePort | null
  events?: { qrScanFrameClosed?: string; qrScanSettled?: string }
  emit?: (route: string, payload: unknown) => unknown
}

interface ScreenCaptureResult {
  ok: boolean
  reason?: string
  width?: number
  height?: number
  framed?: boolean
  busy?: boolean
  data?: Uint8Array
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/**
 * ScreenCapture 域 IPC 注册器 —— 与 ipc/totp.js 同构（能力走 provider-bridge）。
 *
 * ⚠ 能力名 `qr.listScreens` / `qr.captureScreen` 与三处必须逐字一致：
 *   ① `plugins/qr-scanner.cjs` 的 `registerProviders()` 键
 *   ② `qr-scanner.hira-plugin.json` 的 `capabilities` 数组（plugin:coverage 会比对）
 *   ③ 本文件 `invoke('qr.xxx', …)` 的第一个参数
 *
 * ── 为什么没有"域服务兜底" ──────────────────────────────────────────
 * 抓屏是 **Electron 平台能力**，不是业务域 —— 没有哪个 domain 包该认识
 * `desktopCapturer`（domain 层是零 electron 的）。所以这里的 fallback 只回一条
 * "能力不可用"的结果，而不是直连某个服务：
 *   · 插件被**显式禁用** → `isCapabilityBlocked` 为真 → 直接抛（功能真的没了）；
 *   · 插件**没装**（降级场景）→ 回落到那条 ok:false，界面显示"扫码器插件未启用"。
 *
 * ── 三种东西的归属（这是本文件唯一需要想清楚的事）────────────────────
 *   · **取景框窗口**：核心的窗口设施（`qrScanFrame` 端口，见 main.js）——
 *     单例、置顶、透明、位置解析都是窗口层的事；
 *   · **抓屏像素**：插件的能力（`qr.captureScreen`）—— 只有它认识 desktopCapturer；
 *   · **"扫哪一块"**：本文件把两者接起来 —— 读浮框当前矩形，连同请求一起交给能力。
 *     放在这一层的好处：插件完全不需要知道"窗口"这个概念，它只收到一个矩形。
 */

/**
 * @param {object} typedMain
 * @param {{
 *   routes: object, schemas: object, providerRegistry: object,
 *   qrScanFrame?: { open: Function, close: Function, bounds: Function }|null
 * }} deps
 */
export function registerScreenIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, providerRegistry, qrScanFrame, events, emit }: ScreenIpcContext
): void {
  if (!routes || !schemas) return
  if (!routes.screenCapture) return
  type CaptureResponse = ReturnType<typeof schemas.capture.response.parse>
  const frameClosedEvent = events?.qrScanFrameClosed
  const frameSettledEvent = events?.qrScanSettled

  const invoke = createProviderInvoker(providerRegistry)
  /**
   * "框被关掉了" → 转发成事件给面板。
   *
   * 触发式扫描下面板平时不发请求，所以这是它唯一能发现"用户点了 ✕"的途径
   * （少了它，关掉框之后面板会一直显示"扫描中"）。见 main.js 里 qrScanFrame.open()。
   */
  if (qrScanFrame && typeof qrScanFrame.setOnClosed === 'function' && typeof emit === 'function'
    && frameClosedEvent) {
    qrScanFrame.setOnClosed(() => { try { emit(frameClosedEvent, {}) } catch (_) {} })
  }
  /**
   * "取景框已放下"的延迟通知。
   *
   * 为什么要等一拍再发：用户拖到位常常还会微调一下，每次都立刻抓一帧整屏、又马上作废，
   * 纯属白烧主进程。留一个尾巴（interact(false) 之后 INTERACT_TAIL_MS）让最后一次微调
   * 也算进去 —— 期间若又动起来，这个定时器会被取消。
   */
  const INTERACT_TAIL_MS = 260
  let settleTimer: NodeJS.Timeout | null = null
  const cancelSettle = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  }

  typedMain.handle(routes.screenCapture, {
    requestSchema: schemas.capture.request,
    responseSchema: schemas.capture.response,
    handler: async (_e, req) => {
      const request = req || {}
      // 浮框开着就以浮框为准（抓它所在的那块屏 + 裁到框内）。
      const frameBounds = qrScanFrame && typeof qrScanFrame.bounds === 'function' ? qrScanFrame.bounds() : null
      const framed = !!frameBounds
      /**
       * **交互期间一帧都不抓**（见 frame.busy 的契约说明）。
       *
       * 这是"拖动卡"的根治手段：抓一帧整屏要回读 8MB 再把大块像素塞过 IPC，
       * 和"用户正在拖框"叠在一起，主进程就会卡住不给窗口落位 —— 表现就是拖不动。
       * 所以这里**在进入重活之前**就返回，连 desktopCapturer 都不碰。
       */
      if (qrScanFrame && typeof qrScanFrame.isBusy === 'function' && qrScanFrame.isBusy()) {
        return { ok: false, busy: true, framed } as CaptureResponse
      }
      const res = await invoke<ScreenCaptureResult>(
        'qr.captureScreen',
        () => ({ ok: false, reason: '屏幕抓取不可用：扫码器插件未启用' }),
        { displayId: request.displayId, frameBounds }
      )
      /**
       * **抓的过程中用户又动起来了 → 把这一帧直接作废**，一个字节都不往渲染层送。
       *
       * 为什么必须在 `await` **之后**再查一次：入口那次检查只能挡住"还没开始抓"，
       * 挡不住"已经在抓了"。而抓帧的重活在 `getSources` 里（整屏缩略图）——
       * 用户正是在那几十毫秒里按下了拖动。若照旧把 8MB 塞过 IPC、再让渲染层解码，
       * 用户感知到的就是"**一按就卡一下**"；丢掉它，拖动立刻跟手。
       */
      if (res.ok === true && qrScanFrame && typeof qrScanFrame.isBusy === 'function' && qrScanFrame.isBusy()) {
        return { ok: false, busy: true, framed } as CaptureResponse
      }
      /**
       * `framed` 一律按"抓这一刻浮框在不在"回填 —— **即使这次抓帧失败**。
       *
       * 因为它是面板判断"用户是不是把浮框关掉了"的唯一依据：关掉 → 自动停止扫描。
       * 若只在成功时回填，那么"浮框被拖到屏幕外导致抓帧失败"会被误判成"浮框关了"，
       * 扫描会在用户还在调整的时候莫名其妙停下来。
       */
      return (res.ok === false && !res.reason
        ? { ok: false, reason: '抓帧返回异常', framed }
        : { ...res, framed }) as CaptureResponse
    }
  })

  typedMain.handle(routes.screenFrameOpen, {
    requestSchema: schemas.frameOpen.request,
    responseSchema: schemas.frameOpen.response,
    handler: async () => {
      if (!qrScanFrame || typeof qrScanFrame.open !== 'function') {
        return { ok: false, reason: '宿主未提供取景框端口', open: false }
      }
      const res = asRecord(qrScanFrame.open())
      if (res.ok === false) return { ok: false, reason: String(res.error || '无法打开取景框'), open: false }
      return { ok: true, open: true }
    }
  })

  typedMain.handle(routes.screenFrameClose, {
    requestSchema: schemas.frameClose.request,
    responseSchema: schemas.frameClose.response,
    handler: async () => {
      if (!qrScanFrame || typeof qrScanFrame.close !== 'function') {
        return { ok: false, reason: '宿主未提供取景框端口', open: false }
      }
      qrScanFrame.close()
      return { ok: true, open: false }
    }
  })

  /**
   * 拖框 / 缩放框：渲染层只报**意图**（`{ mode, edge, dx, dy }`），几何在主进程算。
   * 这一层只做转发 —— 端口方法存在与否就是"能不能拖"的唯一判据。
   */
  typedMain.handle(routes.screenFrameDrag, {
    requestSchema: schemas.frameDrag.request,
    responseSchema: schemas.frameDrag.response,
    handler: async (_e, req) => {
      if (!qrScanFrame || typeof qrScanFrame.drag !== 'function') return { ok: false }
      return qrScanFrame.drag(req)
    }
  })

  /**
   * 取景框几何（**只有矩形，没有像素**）—— 见 contracts/screen.js 的 frameGeometry。
   *
   * 与 `screen:capture` 的关系：抓屏有两条路，几何只有一处算法。渲染层拿屏幕流
   * （`getDisplayMedia`）自己裁时走这一条；走 IPC 抓帧时主进程内部直接调同一个端口方法。
   * 两条路扫的必须是同一块区域，否则"框里明明有码却扫不到"会变成随机现象。
   */
  typedMain.handle(routes.screenFrameGeometry, {
    requestSchema: schemas.frameGeometry.request,
    responseSchema: schemas.frameGeometry.response,
    handler: async () => {
      if (!qrScanFrame || typeof qrScanFrame.geometry !== 'function') {
        return { ok: false, open: false, crop: null, display: null, reason: '宿主未提供取景框端口' }
      }
      return qrScanFrame.geometry()
    }
  })

  typedMain.handle(routes.screenFrameInteract, {
    requestSchema: schemas.frameInteract.request,
    responseSchema: schemas.frameInteract.response,
    handler: async (_e, req) => {
      const active = !!(req && req.active === true)
      if (qrScanFrame && typeof qrScanFrame.setInteracting === 'function') qrScanFrame.setInteracting(active)
      cancelSettle()
      if (active) return { ok: true }
      /**
       * 放下了 → 静默一拍 → 告诉面板"该抓一帧了"。
       *
       * 面板**只在收到这条时抓帧**（触发式扫描）：静止时零抓屏、零解码，
       * 这样主进程才不会一直被整屏回读占着（那就是"卡死、鼠标都动不了"的根因）。
       */
      if (typeof emit === 'function' && frameSettledEvent) {
        settleTimer = setTimeout(() => {
          settleTimer = null
          try { emit(frameSettledEvent, {}) } catch (_) {}
        }, INTERACT_TAIL_MS)
      }
      return { ok: true }
    }
  })
}

