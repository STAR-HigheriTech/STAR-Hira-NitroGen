/**
 * 双引擎二维码检测器 —— **一个接口，两条实现**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么必须有第二个引擎（这不是"优化"，是"能不能用"）
 * ══════════════════════════════════════════════════════════════════════
 * 原生 `BarcodeDetector` 在 MDN 上的状态是 **"Limited availability / Partial support"** ——
 * 桌面平台（Windows / macOS / Linux）**不保证有条码识别后端**。
 * 只靠它的话，扫码在相当一部分机器上就是个点不动的按钮 —— 而"点了没反应"是最差的失败形态。
 * 所以：
 *   ① 原生 `BarcodeDetector` —— 平台有就用（零体积成本）
 *   ② `qr/decode.js`（paulmillr/qr）—— 兜底，7.3KB，任何环境都能扫
 *
 * \> 选型对比（实测，1280x720 含码帧）：`qr` **3.2ms** / jsQR **~351ms**。
 * \> 我们的轮询间隔是 300ms —— jsQR 一帧都算不完，预览会卡成幻灯片。
 * \> 另外 jsQR 已停更 5 年，而 `qr` 与仓库里已有的 `@noble/hashes` 同一作者。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条引擎的**真实差异**（不要假装它们一样）
 * ══════════════════════════════════════════════════════════════════════
 *   · 原生引擎一帧可返回**多个**码；`qr` 一帧只返回一个（它不做多码检测）。
 *   · 因此 `decodeQrImage`（单张图片）在库引擎下**只会给出图里的第一个码**。
 *     相机场景无影响（一帧一个码）；图片场景要如实告知用户。
 * 这条差异由 `kind` 暴露给上层，界面据此决定要不要提示"图里可能还有别的码"。
 */

/** `qr` 在"没找到码"时抛的错误 message 是 `finder` —— 简短得像内部代号，不能给人看。 */
const NO_CODE_MESSAGES = new Set(['finder', 'no finder', 'not found'])

interface BarcodeDetectorInstance {
  detect(source: ImageData | CanvasImageSource): Promise<Array<{ rawValue?: string }>>
}

interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorInstance
  getSupportedFormats?: () => Promise<string[]>
}

declare const BarcodeDetector: BarcodeDetectorConstructor

/** 把"这一帧没扫到"与"真的出错了"分开 —— 前者是常态，后者要报。 */
function isNoCodeError(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : '').toLowerCase()
  return NO_CODE_MESSAGES.has(msg) || msg === ''
}

/**
 * 原生后端可用吗？
 *
 * 分两步：构造函数存在（便宜）→ 问支持哪些格式（贵，且能发现"有 API 无后端"）。
 * 第二步是必要的：`BarcodeDetector` 存在但 `qr_code` 不在支持列表里的情况是真实的
 * （部分 Windows 只给一维码后端）。
 */
async function nativeBackend(): Promise<BarcodeDetectorInstance | null> {
  if (typeof BarcodeDetector !== 'function') return null
  try {
    if (typeof BarcodeDetector.getSupportedFormats === 'function') {
      const formats = await BarcodeDetector.getSupportedFormats()
      if (Array.isArray(formats) && !formats.includes('qr_code')) return null
    }
    return new BarcodeDetector({ formats: ['qr_code'] })
  } catch (_) {
    return null
  }
}

/** 懒加载兜底引擎：原生可用时**一个字节都不加载**。 */
let libraryModule: typeof import('qr/decode.js') | null = null
let libraryLoadFailed = false
async function libraryBackend(): Promise<typeof import('qr/decode.js') | null> {
  if (libraryLoadFailed) return null
  if (!libraryModule) {
    try {
      libraryModule = await import('qr/decode.js')
    } catch (e) {
      libraryLoadFailed = true
      console.error('[qr-scan] 兜底解码器加载失败:', e)
      return null
    }
  }
  return libraryModule
}

/**
 * 建一个检测器。**异步**（要问原生后端），但只建一次、长期复用。
 *
 * @returns {Promise<{ kind: 'native'|'library', detect(img: ImageData): Promise<string[]> }>}
 */
export async function createQrDetector() : Promise<{ kind: 'native'|'library', detect(img: ImageData): Promise<string[]> }> {
  const native = await nativeBackend()
  if (native) {
    return {
      kind: 'native',
      async detect(img) {
        const found = await native.detect(img)
        return found.map((c: { rawValue?: string }) => String(c.rawValue || '')).filter(Boolean)
      }
    }
  }

  const lib = await libraryBackend()
  if (!lib) {
    return { kind: 'library', async detect() { return [] } }
  }
  const { decodeQR } = lib
  return {
    kind: 'library',
    async detect(img) {
      try {
        const text = decodeQR(new ImageData(img.data, img.width, img.height))
        return text ? [String(text)] : []
      } catch (e) {
        // **"没找到"是每帧都会发生的事**，不能打日志（300ms 一次会刷屏），
        // 也不能当错误抛出去 —— 它只是"这一帧没有码"。
        if (isNoCodeError(e)) return []
        throw e
      }
    }
  }
}

/**
 * 一次性便捷路径：`BarcodeDetector` 形态的可用性判断（同步，供界面决定给不给按钮）。
 *
 * ⚠ 同步判断只看"**有没有原生 API 或能不能加载兜底库**"。
 * 兜底库要动态 import，所以同步时只能假设它能加载成功；
 * 真加载失败时 `createQrDetector` 返回的是一律返回空数组的检测器 —— 界面上表现为"扫不到"，
 * 而不是崩溃。这与"从不抛错给用户"的取舍一致。
 */
export function isQrScanSupported() {
  const hasCanvas = typeof CanvasRenderingContext2D === 'function' || typeof (globalThis.document && document.createElement) === 'function'
  if (typeof BarcodeDetector === 'function') return true
  return hasCanvas && !libraryLoadFailed
}

export { isNoCodeError }

