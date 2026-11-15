/**
 * 屏幕扫码 —— **流式抓帧**（渲染进程自己抓，主进程一帧都不碰）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这一支（这是"卡"的根治，不是优化）
 * ══════════════════════════════════════════════════════════════════════
 * 另一条路（`screen.js`，IPC 抓帧）是这样的：主进程 `desktopCapturer.getSources()`
 * 生成**整屏缩略图**（1080p = 8MB）→ `crop()`（再来一次位图拷贝）→ `toBitmap()`
 * （第三次）→ 8MB 序列化过 IPC。整段都在**主进程**上，而主进程只有一个 JS 线程：
 * 这几十毫秒里窗口落位、IPC、网页输入全部排队 —— 用户看到的就是
 * 「**一按住取景框就卡一下**」「**开着扫码器网页也跟着卡**」。
 *
 * 而且这不是"调大间隔"能解决的：只在需要时抓（现有触发式）已经把次数压到最低，
 * 但每一次的**代价**仍然那么大。所以必须换抓帧方式：
 *
 *   `getDisplayMedia()` → Chromium 自己的屏幕捕获管线 → `video` 纹理
 *   → `canvas.drawImage` 只画**取景框那一小块** → `getImageData` → 解码
 *
 * 屏幕像素从此只活在**渲染进程**（面板/取景框自己的进程），主进程只回两个矩形
 * （`screen:frame-geometry`）。拖动、网页、IPC 都不再和抓屏抢同一个线程。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一条流、多次取帧：为什么不是每次抓都开一条流
 * ══════════════════════════════════════════════════════════════════════
 * `getDisplayMedia()` 会拉起整条捕获管线（枚举屏幕、建编码器、申请权限）。
 * 每次扫描都做一遍既慢又可能弹权限。所以流的生命周期 = **一次扫码会话**
 * （`start()` 开会话时开流，`stop()` 收会话时关流），期间每次扫描只是从
 * 已经在跑的流里取一帧。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 失败必须**可回退**（本文件的第一纪律）
 * ══════════════════════════════════════════════════════════════════════
 * `getDisplayMedia` 有若干可能失败的外部原因（平台不支持、权限被拒、用户手势过期…）。
 * 任何一条失败都**不抛给用户**：`start()` 如实返回 `{ok:false, reason}`，
 * 交给调用方（`scan-window.js`）回退到 IPC 抓帧那条老路 ——
 * 功能绝不能因为"新路走不通"而消失。这也是它必须与 `createScreenScanner`
 * **接口完全一致**（`start/stop/isReady/scanOnce`）的原因：调用方换实现即可。
 */

import { createQrDetector } from './detector.js'
import type { QrDetector, QrFrameClient, QrRect, QrScanResult, QrScanner } from './types.js'

/** 把 `{x,y,width,height}` 转成最小整数矩形（canvas 的源区域不接受浮点噪声）。 */
function roundRect(r: QrRect): QrRect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height))
  }
}

/** 长边上限：解码只需要"够清楚"，不必照搬屏幕物理分辨率（4K 屏上这是 4 倍的无用像素）。 */
const MAX_CROP_SIDE = 1024

/**
 * 屏幕流限帧上限（见 `start()` 里 applyConstraints 的说明）。
 * 取值依据：只要"落位后那一帧"够新；12fps 的间隔是 83ms，用户松手到看见结果本来就有一拍。
 */
const MAX_STREAM_FPS = 12

/**
 * 屏幕流抓帧可用吗？（同步判断，只用于"值不值得试"）
 *
 * 真正的可用性只有 `start()` 才知道（权限、平台后端都要试了才算）——
 * 所以这里只挡住"连 API 都没有"这种确定的情况，其余交给回退机制。
 */
export function isStreamScanSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function')
}

/**
 * 建一个流式扫码器（与 `createScreenScanner` 同一接口）。
 *
 * @param {{
 *   doc: Document,                    // 宿主注入，不摸全局
 *   client: { frameGeometry: Function }, // ctx.clients.screen
 *   onError?: (reason: string) => void
 * }} ports
 */
interface StreamScannerOptions {
  doc: Document
  client: QrFrameClient
  onError?: (reason: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

export function createStreamScanner({ doc, client, onError }: StreamScannerOptions): QrScanner {
  let detector: QrDetector | null = null
  let stream: MediaStream | null = null
  let video: HTMLVideoElement | null = null
  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  /** 正在跑的那一次（防重入）。 */
  let inflight: Promise<QrScanResult> | null = null

  const fail = (reason: string): QrScanResult => {
    if (typeof onError === 'function') onError(reason)
    return { ok: false, reason }
  }

  /** 收掉流（**逐 track stop**：只清 `srcObject` 不放设备，捕获指示不会灭）。 */
  function closeStream(): void {
    if (stream) {
      try { for (const t of stream.getTracks()) t.stop() } catch (_) {}
      stream = null
    }
    if (video) {
      try { video.srcObject = null } catch (_) {}
      try { video.pause() } catch (_) {}
    }
  }

  /**
   * 取一帧并解码。
   *
   * 顺序：先问主进程"框在流里的哪一块"（几何权威只在一处），再 `drawImage` 那一小块。
   * `willReadFrequently: true` 是必须的 —— 帧捕获后马上要 `getImageData`，
   * 没有它浏览器走 GPU 后端，回读会成为新的卡顿源（`frame.js` 里同一个理由）。
   */
  async function run(): Promise<QrScanResult> {
    const activeVideo = video
    if (!activeVideo) return fail('扫描器未启动')
    const geo = await client.frameGeometry()
    if (!geo || geo.ok !== true || !geo.crop || !geo.display) {
      return fail((geo && geo.reason) || '取景框不在屏幕内，请把它拖回来')
    }
    const vw = activeVideo.videoWidth
    const vh = activeVideo.videoHeight
    if (!vw || !vh) return fail('屏幕画面还没就绪')

    // 流的分辨率 = 显示器**物理**像素；crop/display 都是 DIP 屏幕坐标 → 用宽度比换算。
    const ratio = vw / geo.display.width
    const crop = roundRect(geo.crop)
    const sx = Math.max(0, Math.round((crop.x - geo.display.x) * ratio))
    const sy = Math.max(0, Math.round((crop.y - geo.display.y) * ratio))
    const sw = Math.max(1, Math.min(Math.round(crop.width * ratio), vw - sx))
    const sh = Math.max(1, Math.min(Math.round(crop.height * ratio), vh - sy))
    // 超大屏上再降一档：二维码不需要 4K 的像素量，少画 = 少一次内存拷贝
    const side = Math.max(sw, sh)
    const scale = side > MAX_CROP_SIDE ? MAX_CROP_SIDE / side : 1
    const dw = Math.max(1, Math.round(sw * scale))
    const dh = Math.max(1, Math.round(sh * scale))

    if (!canvas) {
      canvas = doc.createElement('canvas')
      ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return fail('无法创建取景画布')
    }
    const activeCanvas = canvas
    const activeCtx = ctx
    if (!activeCanvas || !activeCtx) return fail('无法创建取景画布')
    if (activeCanvas.width !== dw || activeCanvas.height !== dh) { activeCanvas.width = dw; activeCanvas.height = dh }

    try {
      activeCtx.drawImage(activeVideo, sx, sy, sw, sh, 0, 0, dw, dh)
    } catch (e) {
      return fail('从屏幕流取帧失败')
    }
    let img: ImageData
    try { img = activeCtx.getImageData(0, 0, dw, dh) } catch (_) { return fail('无法读取取景画面') }
    if (!detector) return fail('扫描器未启动')
    const texts = await detector.detect(img)
    return { ok: true, texts: texts.map((t) => String(t || '').trim()).filter(Boolean) }
  }

  return {
    /**
     * 开流 + 准备解码器。
     *
     * ⚠ 调用方必须**在用户手势的同一个宏任务里**调它（用户点「扫描屏幕二维码」那一下）：
     * `getDisplayMedia` 要求瞬时用户激活。晚一个 `await` 再调就可能被拒 ——
     * 而拒了就会回退到 IPC 抓帧（能用但卡），所以这不是"崩"，只是白跑一趟。
     */
    async start() {
      if (detector && stream) return { ok: true }
      if (!isStreamScanSupported()) return fail('当前环境不支持屏幕流抓帧')
      /**
       * ⚠ 顺序是刻意的：**先同步发起 `getDisplayMedia`**，再去准备解码器。
       *
       * 它要求瞬时用户激活（用户点「扫描屏幕二维码」那一下），而 `await createQrDetector()`
       * 会把执行权交出去 —— 那时再调就可能被拒。所以这里先把请求发出去（同步进入
       * Chromium 的媒体管线），解码器的准备与流的建立并行进行。
       */
      let streamRequest: Promise<MediaStream>
      try {
        streamRequest = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      } catch (e) {
        return fail('无法获取屏幕画面（将改用兼容方式）')
      }
      try {
        detector = detector || await createQrDetector()
      } catch (e) {
        // 解码器挂了就把刚发起的那条流收掉 —— 否则会留下一条没人管的屏幕捕获
        try {
          const s = await streamRequest
          if (s) for (const t of s.getTracks()) t.stop()
        } catch (_) {}
        return fail(errorMessage(e) || '解码器初始化失败')
      }
      try {
        stream = await streamRequest
      } catch (e) {
        // 权限被拒 / 用户手势过期 / 平台不支持 —— 都走同一句话（调用方据此回退）
        return fail('无法获取屏幕画面（将改用兼容方式）')
      }
      const track = stream.getVideoTracks && stream.getVideoTracks()[0]
      if (!track) { closeStream(); return fail('屏幕流里没有视频轨') }
      /**
       * 给捕获**限帧**（尽力而为）。
       *
       * 屏幕捕获管线默认按显示刷新率出帧（60fps ≈ 每秒 60 张整屏纹理 + 解码）。
       * 而我们**只在"框放下"那一刻要一帧** —— 其余时间这些帧全是白烧的 CPU/GPU，
       * 开着扫码器就一直在耗（用户说的"各种卡顿"里有一部分就是它）。
       * 限到 12fps：落位后最多多等 80ms，肉眼无感；常态开销掉到 1/5。
       * 分辨率**不能降** —— 框内只有 264 DIP，降采样等于把二维码本身缩小，
       * 那是"框里明明有码却扫不到"的根源（见 MAX_CROP_SIDE 的注释）。
       */
      try {
        if (typeof track.applyConstraints === 'function') {
          await track.applyConstraints({ frameRate: { max: MAX_STREAM_FPS } })
        }
      } catch (_) { /* 有的后端不支持限帧：那就照旧，功能不受影响 */ }
      /**
       * 用户从系统层撤掉共享（托盘/系统提示条上的"停止共享"）时，轨道会 `ended` ——
       * 必须当作"这一支不可用了"，否则后面每次取帧都是黑帧（表现为"扫不到了"）。
       */
      try {
        track.addEventListener('ended', () => {
          closeStream()
          if (typeof onError === 'function') onError('屏幕共享已结束')
        })
      } catch (_) {}

      const nextVideo = doc.createElement('video')
      video = nextVideo
      nextVideo.muted = true
      nextVideo.setAttribute('playsinline', '')
      nextVideo.srcObject = stream
      try {
        await nextVideo.play()
      } catch (e) {
        closeStream()
        return fail('无法开始播放屏幕画面')
      }
      // 首帧就绪（`videoWidth` 有值）才能 drawImage
      if (!nextVideo.videoWidth) {
        await new Promise<void>((resolve) => {
          const done = () => resolve()
          nextVideo.addEventListener('loadeddata', done, { once: true })
          setTimeout(done, 1200)   // 兜底：不给"永远等下去"的可能
        })
      }
      if (!nextVideo.videoWidth) { closeStream(); return fail('屏幕画面为空') }
      return { ok: true }
    },

    /** 收工（幂等）。 */
    stop() {
      closeStream()
      canvas = null
      ctx = null
      detector = null
      inflight = null
    },

    get isReady() { return !!detector && !!stream },
    /** 这一支是流式（调用方据此在界面上说"轻量模式"）。 */
    get isStreaming() { return true },

    /** 取一帧并解码（防重入：同一次飞行中的请求共用结果）。 */
    scanOnce() {
      if (!detector || !stream) return Promise.resolve({ ok: false, reason: '扫描器未启动' })
      if (inflight) return inflight
      inflight = run().catch((e: unknown) => fail(errorMessage(e) || '识别失败'))
      const current = inflight
      return current.finally(() => { if (inflight === current) inflight = null })
    }
  }
}

