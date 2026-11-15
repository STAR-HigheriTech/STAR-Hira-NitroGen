/**
 * 屏幕扫码 —— **触发式**，不是轮询。这是本文件最重要的设计决定。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不能轮询（血的教训）
 * ══════════════════════════════════════════════════════════════════════
 * 抓一帧整屏要主进程回读 8MB（BGRA）再把它塞过 IPC。第一版每 600ms 来一次，
 * 结果是**主进程被这件事一直占着**：界面卡死、拖动没反应、鼠标都动不了。
 * 这不是"优化一下间隔"能解决的 —— 只要它还在持续跑，主进程就一直有重活。
 *
 * 所以改成**触发式**：只有"用户把取景框放下了"这一个时刻才抓**一帧**解码。
 *   · 静止时：零抓屏、零解码、零 IPC；
 *   · 代价只在真正需要的那一刻发生（一次整屏回读），而且那时候用户没有别的事在做。
 * 这也正好符合扫码这个动作的语义 —— 对准了才看，不是一直盯着。
 *
 * 触发源有两个（都在 model 里）：主进程发来的 `qrScanSettled`，以及用户点「重新扫描」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 像素格式：BGRA 当 RGBA 用（刻意的）
 * ══════════════════════════════════════════════════════════════════════
 * Windows 的原生位图是 BGRA，而 `ImageData` 要 RGBA。二维码是**单色**的（R=G=B），
 * 灰度化对通道顺序不敏感 —— 所以不做逐像素翻转（200 万像素翻一遍是白烧时间）。
 * 这条假设写在契约上（infra-ipc/contracts/screen.js）。
 */

import { createQrDetector } from './detector.js'
import type { QrCaptureFrame, QrDetector, QrFrameClient, QrScanResult, QrScanner } from './types.js'

/** 这一支依赖宿主注入的抓帧端口（`ctx.clients.screen`）。 */
export function isScreenScanSupported(client: Partial<QrFrameClient> | null | undefined): boolean {
  return !!(client && typeof client.captureScreen === 'function')
}

/**
 * 把主进程给的原始像素包成 `ImageData`（原生引擎与 `qr` 引擎都吃它）。
 *
 * 长度对不上就返回 null（而不是抛）：抓帧偶发给出异常长度是可能的，
 * 那只是"这一帧作废"，不是故障。
 */
function toImageData(bytes: Uint8Array | undefined, width: number | undefined, height: number | undefined): ImageData | null {
  const w = Math.floor(Number(width) || 0)
  const h = Math.floor(Number(height) || 0)
  if (!w || !h) return null
  const expected = w * h * 4
  if (!bytes || bytes.byteLength < expected) return null
  const view = bytes.byteLength === expected ? bytes : bytes.subarray(0, expected)
  const clamped = view instanceof Uint8ClampedArray
    ? view
    : new Uint8ClampedArray(view.buffer, view.byteOffset, expected)
  try {
    return new ImageData(new Uint8ClampedArray(clamped), w, h)
  } catch (_) {
    return null
  }
}

/**
 * 建一个触发式扫码器。
 *
 * @param {{
 *   client: { captureScreen: Function },   // ctx.clients.screen（端口注入，不摸全局）
 *   onFrame?: (frame: object) => void,     // 每次抓帧后回调（调用方据此判断取景框还在不在）
 *   onError?: (reason: string) => void
 * }} ports
 */
interface ScreenScannerOptions {
  client: QrFrameClient
  onFrame?: (frame: QrCaptureFrame) => void
  onError?: (reason: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

export function createScreenScanner({ client, onFrame, onError }: ScreenScannerOptions): QrScanner {
  let detector: QrDetector | null = null
  /** 正在跑的那一次（防重入：拖动结束 + 手动点按可能同时要求扫）。 */
  let inflight: Promise<QrScanResult> | null = null

  async function run(displayId?: string): Promise<QrScanResult> {
    const frame = await client.captureScreen(displayId ? { displayId } : {})
    if (typeof onFrame === 'function') onFrame(frame)
    // 主进程在用户交互期间会短路返回 busy：这一帧什么都没抓，安静作废
    if (frame && frame.busy === true) return { ok: false, busy: true }
    if (!frame || frame.ok !== true) {
      const reason = (frame && frame.reason) || '抓取屏幕失败'
      if (typeof onError === 'function') onError(reason)
      return { ok: false, reason }
    }
    const img = toImageData(frame.data, frame.width, frame.height)
    if (!img) return { ok: false, reason: '抓到的画面异常' }
    if (!detector) return { ok: false, reason: '扫描器未启动' }
    const found = await detector.detect(img)
    return { ok: true, texts: found.map((t) => String(t || '').trim()).filter(Boolean) }
  }

  return {
    /** 准备解码器（只做一次）。 */
    async start() {
      if (detector) return { ok: true }
      if (!isScreenScanSupported(client)) {
        const reason = '当前环境不支持屏幕抓取（扫码器插件未启用）'
        if (typeof onError === 'function') onError(reason)
        return { ok: false, reason }
      }
      try {
        detector = await createQrDetector()
      } catch (e) {
        const reason = errorMessage(e) || '解码器初始化失败'
        if (typeof onError === 'function') onError(reason)
        return { ok: false, reason }
      }
      return { ok: true }
    },

    /** 收工（幂等）。 */
    stop() {
      detector = null
      inflight = null
    },

    get isReady() { return !!detector },

    /**
     * 抓**一帧**并解码。
     * @returns {Promise<{ ok: boolean, texts?: string[], busy?: boolean, reason?: string }>}
     */
    scanOnce(displayId?: string) : Promise<QrScanResult> {
      if (!detector) return Promise.resolve({ ok: false, reason: '扫描器未启动' })
      if (inflight) return inflight            // 不重入：正在扫就把同一次结果给它
      inflight = run(displayId).catch((e: unknown) => {
        const reason = errorMessage(e) || '识别失败'
        if (typeof onError === 'function') onError(reason)
        return { ok: false, reason }
      })
      const current = inflight
      return current.finally(() => { if (inflight === current) inflight = null })
    }
  }
}

