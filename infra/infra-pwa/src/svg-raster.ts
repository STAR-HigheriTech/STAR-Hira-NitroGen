/**
 * SVG 栅格化 —— 只为一件事：让 SVG favicon 也能产出 `icon-*.png` / `icon.ico`。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────
 * Electron 的 `nativeImage` **不解码 SVG**（createFromBuffer 直接得到 isEmpty）。
 * 现代站点大量使用 `<link rel="icon" href="/icon.svg">`，若只把 SVG 字节原样落盘，
 * chrome 标题栏能显示，但 Windows 任务栏 / 桌面快捷方式需要位图（ico），
 * 结果就是「窗口里一个图标、快捷方式另一个图标」。
 *
 * ── 为什么放在 infra ───────────────────────────────────────────────
 * 这是纯渲染能力（输入 SVG 字节 → 输出 PNG 字节），与 PWA 业务无关；
 * 放在 infra-pwa 只是当前唯一消费方在这里，接口本身可被任何模块复用。
 */

import type * as Electron from 'electron'

/** 渲染一次就够：后续 icon-512/192/32 与 ico 全部由这一张缩出来。 */
export const RASTER_SIZE = 512
/** 页面加载 + 首帧绘制的最长等待；超时宁可回落 SVG，也不让安装卡住。 */
const RENDER_TIMEOUT_MS = 3000

interface HiraWebPreferences extends Electron.WebPreferences {
  paintWhenInitiallyHidden: boolean
}

function getElectron(): typeof Electron {
  return require('electron') as typeof Electron
}

function buildHtml(svgDataUrl: string, size: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
    img{display:block;width:${size}px;height:${size}px;object-fit:contain}
  </style></head><body><img src="${svgDataUrl}"></body></html>`
}

/** 等图片解码完成（`complete` 不代表解码成功，所以再校验 naturalWidth）。 */
const WAIT_SCRIPT = `(async () => {
  const img = document.images && document.images[0]
  if (!img) return false
  if (!img.complete) {
    await new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
      setTimeout(resolve, 1500)
    })
  }
  return img.naturalWidth > 0 && img.naturalHeight > 0
})()`

/**
 * @param {Buffer} svgBuffer
 * @param {number} [size]
 * @returns {Promise<Buffer|null>} PNG 字节；失败返回 null（调用方回落 SVG 原样）
 */
export async function rasterizeSvg(svgBuffer: Buffer, size: number = RASTER_SIZE): Promise<Buffer | null> {
  const { BrowserWindow } = getElectron()
  if (typeof BrowserWindow !== 'function' || !BrowserWindow) return null
  if (!Buffer.isBuffer(svgBuffer) || svgBuffer.length === 0) return null
  const side = Math.max(16, Math.min(1024, Math.round(size) || RASTER_SIZE))

  let win: Electron.BrowserWindow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const webPreferences: HiraWebPreferences = {
      offscreen: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true
    }
    win = new BrowserWindow({
      show: false,
      width: side,
      height: side,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      focusable: false,
      webPreferences
    })
    win.setMenuBarVisibility(false)

    const dataUrl = `data:image/svg+xml;base64,${svgBuffer.toString('base64')}`
    const html = buildHtml(dataUrl, side)

    const loaded = new Promise((resolve) => {
      win?.webContents.once('did-finish-load', () => resolve(true))
      win?.webContents.once('did-fail-load', () => resolve(false))
    })
    // data: URL 可能因体积被拒 → 用 loadURL 的 reject 兜住。
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await loaded.catch(() => false)

    let decoded = false
    try { decoded = Boolean(await win.webContents.executeJavaScript(WAIT_SCRIPT, true)) } catch (_) {}
    if (!decoded) return null

    // 首帧绘制需要一点时间。隐藏窗口的第一次 capturePage 可能还是空帧，
    // 所以给它几次机会（每次等一小会儿让合成器出帧），而不是一次失败就退回 SVG。
    let captured: Electron.NativeImage | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      captured = await Promise.race([
        win.webContents.capturePage({ x: 0, y: 0, width: side, height: side }),
        new Promise<Electron.NativeImage | null>((resolve) => {
          timer = setTimeout(() => resolve(null), RENDER_TIMEOUT_MS)
          if (timer && typeof timer.unref === 'function') timer.unref()
        })
      ])
      if (timer) { clearTimeout(timer); timer = null }
      if (captured && (typeof captured.isEmpty !== 'function' || !captured.isEmpty())) break
      captured = null
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    if (!captured) return null
    const png = captured.toPNG()
    return png && png.length ? png : null
  } catch (_) {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    if (win && !win.isDestroyed()) win.destroy()
  }
}

