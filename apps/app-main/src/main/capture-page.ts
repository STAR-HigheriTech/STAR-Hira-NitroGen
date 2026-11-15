/**
 * capture-page —— 页面截图（J7）。
 *
 * 两种取图方式，各有其位：
 *   · **可见区域** = Electron 既有的 `webContents.capturePage()` —— 抓的是**已合成的那一帧**，
 *     最稳，永远可用；
 *   · **整页** = CDP `Page.captureScreenshot` + `captureBeyondViewport` ——
 *     `capturePage(rect)` 拿不到视口外的内容（会得到空白），要整页只能走 DevTools 协议。
 *     协议可能不可用（已被外部附加 / 页面受限）→ **自动退回可见区域**：
 *     宁可给一张能用的小图，也不要"点了报错、什么都没有"。
 *
 * 交付一律进**标注编辑器窗口**（三种截图方式共用）：本模块只负责"取到一张 PNG"，
 * 交给谁、复制还是另存，由 `browser-window-runtime` 的 `openCaptureEditor` 与编辑器承担。
 * 取图与交付分开，是为了让"框选"（另一条取图路径，见 capture-region）也能走同一个落点。
 */
import type { WebContents } from "electron"

/**
 * 取页面图像。
 * @param {any} webContents
 * @param {'viewport'|'fullpage'} [mode]
 * @returns {Promise<Buffer|null>} PNG 字节；取不到返回 null
 */
async function grabPageImage(webContents: WebContents | null | undefined, mode: 'viewport' | 'fullpage' = 'viewport'): Promise<Buffer | null> {
  if (!webContents) return null
  try {
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return null
  } catch (_) {
    return null
  }

  if (mode === 'fullpage') {
    const full = await grabFullPageViaCdp(webContents)
    if (full) return full
    // 落到可见区域兜底（见文件头：不报错，给能给的那张）
  }

  try {
    const image = await webContents.capturePage()
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null
    return image.toPNG()
  } catch (_) {
    return null
  }
}

/**
 * 走 CDP 抓整页。**只在自己附加的情况下才 detach** ——
 * 外部（DevTools / 检查元素）已经附加时擅自 detach 会把人家的会话掐断。
 * @param {any} webContents
 * @returns {Promise<Buffer|null>}
 */
async function grabFullPageViaCdp(webContents: WebContents): Promise<Buffer | null> {
  const dbg = webContents && webContents.debugger
  if (!dbg) return null
  let attachedByUs = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedByUs = true
    }
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics')
    const size = (metrics && (metrics.cssContentSize || metrics.contentSize)) || null
    if (!size || !size.width || !size.height) return null
    const result = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1
      }
    })
    const data = result && result.data ? String(result.data) : ''
    return data ? Buffer.from(data, 'base64') : null
  } catch (_) {
    return null
  } finally {
    if (attachedByUs) {
      try { dbg.detach() } catch (_) {}
    }
  }
}

module.exports = { grabPageImage }
