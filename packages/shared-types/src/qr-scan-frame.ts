/**
 * 扫码浮框的**几何** —— 主进程与渲染层共用的唯一真源。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这几个数字必须放在一处
 * ══════════════════════════════════════════════════════════════════════
 * 浮框是一个**透明置顶窗口**：用户拖动它、把二维码套进框里；主进程按它的屏幕矩形
 * **裁剪**屏幕画面后再解码。于是同一组数字被两个进程用到：
 *   · 渲染层（框页）—— 边框 / 角标 / 提示条画在哪儿；
 *   · 主进程 —— 从窗口矩形里**扣掉**边框与提示条，得到真正要解码的像素区。
 * 两边各写一份必然漂移，而漂移的表现是"框里明明有码却扫不到"——
 * 既看不见也说不清。所以放在 shared-types 里，两边 import 同一份。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要留这么宽的边框（PAD = 18）
 * ══════════════════════════════════════════════════════════════════════
 * 浮框自己在屏幕上，抓屏会**连它一起抓**。落在裁剪区里的每一笔（角标、边框、
 * 扫描线）都会变成解码输入的一部分 —— 一条穿过二维码的亮线足以让它解不出来。
 * 所以：所有装饰只画在 PAD 这一圈里，裁剪区（框内）**一个像素都不画**，
 * 保证解码看到的永远是二维码本身。
 */

/** 取景框边长（正方形，DIP）。 */
export const QR_SCAN_BOX = 300

/** 框内四周的装饰带宽度：角标 / 边框都画在这里，**裁剪区从它里面开始**。 */
export const QR_SCAN_PAD = 18

/** 框下方的提示条高度（"拖动我 / 扫描中" + 关闭），同样在裁剪区之外。 */
export const QR_SCAN_BAR = 46

/** 浮框窗口尺寸（宽 × 高）：正方形取景框 + 底部提示条。 */
export const QR_SCAN_FRAME_SIZE = Object.freeze({
  width: QR_SCAN_BOX,
  height: QR_SCAN_BOX + QR_SCAN_BAR
})

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 由**窗口的屏幕矩形**算出真正要解码的区域。
 *
 * @param {{ x: number, y: number, width: number, height: number }|null|undefined} bounds
 *   窗口矩形（Electron `win.getBounds()` 的口径：屏幕坐标 DIP）
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 *   尺寸退化（窗口被压得比装饰带还小）时返回 null —— 调用方该当作"这次没得扫"，
 *   而不是拿一个负宽度去裁剪。
 */
export function qrScanCropRect(bounds: Rect | null | undefined): Rect | null {
  if (!bounds) return null
  const width = Math.floor(Number(bounds.width) || 0) - QR_SCAN_PAD * 2
  const height = Math.floor(Number(bounds.height) || 0) - QR_SCAN_BAR - QR_SCAN_PAD * 2
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.round(Number(bounds.x) || 0) + QR_SCAN_PAD,
    y: Math.round(Number(bounds.y) || 0) + QR_SCAN_PAD,
    width,
    height
  }
}

/**
 * 两个矩形的交集（裁剪区可能被拖到屏幕外，必须夹回显示器范围内）。
 * 无交集返回 null。
 */
export function intersectRect(a: Rect | null | undefined, b: Rect | null | undefined): Rect | null {
  if (!a || !b) return null
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}
