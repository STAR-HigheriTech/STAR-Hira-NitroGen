/**
 * share —— 「分享 / 二维码」（N15）的主进程侧。
 *
 * 只做一件事：把一段文本编成 **QR 的 SVG 字符串**。为什么在**主进程**生成：
 *   · `qr` 依赖在 dependencies 里（Node 侧），而内部页是**无打包器**的静态页
 *     （不能 import `@hira-ng/*`，也不该为一个二维码把它搬进渲染层）；
 *   · 于是"生成"留在主进程、"展示"交给页面 —— 页面只拿一段 SVG  markup 直接插进 DOM。
 *
 * 为什么会 SVG 而不是位图：SVG 在任意 DPI 下都清晰、体积小、还能被页面直接内联
 * （不需要 base64 往返）；`qr` 本身就提供 `'svg'` 输出格式。
 *
 * ⚠ `qr` 是 **ESM-only** 包（`"type": "module"`）。Node 24 可以直接 `require()`
 *   ESM，拿到的是模块命名空间（默认导出在 `.default` 上）—— 两种形态都兜住，
 *   免得依赖包日后调整导出风格时这里静默变成 undefined。
 */

/** 惰性取 encodeQR（首次用到才加载；失败只告警，不让任何调用方炸）。 */
type QrEncoder = (text: string, type: 'svg') => string

let cachedEncode: QrEncoder | null = null
function encodeQr(): QrEncoder | null {
  if (cachedEncode !== null) return cachedEncode
  try {
    const mod = require('qr')
    const fn: unknown = mod && typeof mod === 'function' ? mod : (mod && mod.default)
    cachedEncode = typeof fn === 'function' ? fn as QrEncoder : null
  } catch (error) {
    console.warn('[share] qr 加载失败:', error instanceof Error ? error.message : error)
    cachedEncode = null
  }
  return cachedEncode
}

function createShareService() {
  /**
   * 文本 → QR 的 SVG markup；无内容 / 生成失败返回空串（调用方据此显示"无法生成"）。
   */
  function qrSvg(text: unknown): string {
    const value = String(text == null ? '' : text).trim()
    if (!value) return ''
    const encode = encodeQr()
    if (!encode) return ''
    try {
      return String(encode(value, 'svg') || '')
    } catch (error) {
      // 超长文本会被编码器拒绝（容量上限）—— 这不是 bug，如实返回空。
      console.warn('[share] 生成二维码失败:', error instanceof Error ? error.message : error)
      return ''
    }
  }

  return { qrSvg }
}

module.exports = { createShareService }
