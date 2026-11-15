/**
 * 扫码器**引擎**插件 —— **主进程侧**：屏幕抓帧能力。**没有界面**（面板是另一个插件）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么引擎与面板是**两个插件**
 * ══════════════════════════════════════════════════════════════════════
 * 抓屏能力与"侧栏里那个扫码面板"是两件事：
 *   · 验证器面板的「扫码」也要用它 —— 它调的是**取景框 + 本能力**，不需要扫码器面板；
 *   · 合成一个插件就只有一个开关：关掉面板 = 抓屏也没了，验证器那边跟着失效。
 * 所以：`qr-scanner`（本文件）只提供能力，`qr-scanner-panel` 只提供界面（`render` 入口），
 * 后者 `dependsOn` 前者（打开面板会一并启用引擎）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么抓屏必须做成插件能力，而不是核心的一部分
 * ══════════════════════════════════════════════════════════════════════
 * 「扫码器引擎」是一个**可选、出厂默认关闭**的插件。抓屏是它唯一需要主进程配合的地方
 * （桌面画面只有主进程拿得到）。把它做成插件的能力，于是：
 *   · 插件被禁用 → `isCapabilityBlocked('qr.captureScreen')` 为真 →
 *     `screen:capture` 这条通道**直接抛**，而不是"入口没了但还能抓"（§9 那条病）；
 *   · 插件被卸载 → 通道回落到"未启用"的 ok:false，界面如实告知。
 * 核心（`main/ipc/screen.js`）只提供窄通道，**不认识** desktopCapturer。
 *
 * 窗口（可拖动的取景框）不由本模块创建 —— 它是核心的窗口设施
 * （WINDOW_TYPES.QR_SCAN_FRAME），本模块只拿到它的屏幕矩形并据此裁剪。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 四个必须写在代码里的取舍
 * ══════════════════════════════════════════════════════════════════════
 * 1. **`require('electron')` 一律懒加载**。本文件会被 `plugin:coverage` 之类的
 *    纯 Node 脚本 require（它们只想调一次 `registerProviders()` 数能力名）；
 *    顶层 require electron 在那种环境里拿到的是**路径字符串**而不是 API。
 * 2. **有取景框时按框裁剪，payload 从 8MB 掉到 200KB 量级** —— 这既是性能，
 *    也是"扫哪儿"的语义：框内就是唯一会被解码的区域。
 * 3. **有取景框时按显示器原生分辨率抓**（而不是整屏那档 1920 缩放）。
 *    整屏时缩放无所谓（要看的区域本来就大）；但框内只有 264 DIP 见方，
 *    再缩放一次就等于把二维码本身缩小 —— 那是"框里明明有码却扫不到"的根源。
 * 4. **不逐像素翻 R/B**（Windows 原生位图是 BGRA，ImageData 要 RGBA）。
 *    二维码是单色的（R=G=B），灰度化对它无差别；翻一遍 200 万像素是白烧主进程时间。
 *    这条假设写在契约上（infra-ipc/contracts/screen.js）。
 */

const { qrScanCropRect, intersectRect } = require('@hira-ng/shared-types/src/qr-scan-frame.mjs')

/** 整屏抓帧的长边上限（无取景框时的兜底路径）。4K 整屏 BGRA 是 33MB，一份一份地传不值。 */
const MAX_SIDE = 1920

/**
 * 有取景框时的长边上限（≈ 显示器原生分辨率）。
 *
 * 为什么与整屏不同：框内只有 264 DIP 见方，任何缩放都直接砍掉二维码的像素 ——
 * 宁可让主进程多拷一帧整屏（随即裁掉并释放），也不要让"框里明明有码却扫不到"。
 * 2560 是折中：1080p / 1440p 都是原生（ratio=1），只有 4K 会缩到 2/3。
 */
const MAX_SIDE_FRAMED = 2560

/** 等比缩放到长边 ≤ maxSide（已经是小屏时原样返回，不做放大）。 */
function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width || 0, height || 0)
  if (!longest) return { width: 0, height: 0 }
  const scale = longest > maxSide ? maxSide / longest : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** 把矩形夹进图片尺寸内，避免四舍五入把裁剪框推出边界（NativeImage#crop 会抛）。 */
function clampToImage(
  rect: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(Math.round(rect.x), Math.max(0, size.width - 1)))
  const y = Math.max(0, Math.min(Math.round(rect.y), Math.max(0, size.height - 1)))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width), size.width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height), size.height - y))
  }
}

function createScreenCapture() {
  /**
   * 抓一帧。
   *
   * @param {{ displayId?: string, frameBounds?: object|null }} [input]
   *   `frameBounds` 是取景框（浮框窗口）的屏幕矩形 —— 由核心的 `screen:capture`
   *   转交进来（渲染层不填这个字段）。给了它 = **按框裁剪**：抓它所在的那块屏、
   *   裁到框内、`displayId` 被忽略（用户在框里看到哪儿就扫哪儿）。
   */
  async function captureScreen(input: { displayId?: string; frameBounds?: unknown } = {}) {
    const { desktopCapturer, screen } = require('electron')
    const cropRect = qrScanCropRect(input.frameBounds)
    const displays = screen.getAllDisplays()

    let display = null
    if (cropRect) {
      // 浮框在哪儿就以哪块屏为准 —— 比让用户再去选一次屏幕直观得多
      try { display = screen.getDisplayMatching(cropRect) } catch (_) {}
    } else {
      const wanted = input.displayId ? String(input.displayId) : ''
      if (wanted) display = displays.find((d: { id: number }) => String(d.id) === wanted) || null
      if (!display) {
        // 默认：光标所在的那块屏（"我正在看的这块"最符合直觉）
        try { display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) } catch (_) {}
      }
    }
    if (!display) display = screen.getPrimaryDisplay()

    const scale = Number(display.scaleFactor) || 1
    const thumbSize = fitSize(
      display.size.width * scale,
      display.size.height * scale,
      cropRect ? MAX_SIDE_FRAMED : MAX_SIDE
    )

    let sources
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize })
    } catch (e: unknown) {
      return { ok: false, reason: `无法读取屏幕画面：${e instanceof Error ? e.message : String(e)}` }
    }
    if (!sources || !sources.length) return { ok: false, reason: '没有找到可抓取的屏幕' }

    // 按 displayId 认领那一块；认不出就退回第一个（单屏时二者等价）
    const source = sources.find((s: { displayId?: string }) => String(s.displayId) === String(display.id)) || sources[0]
    const thumb = source && source.thumbnail
    if (!thumb || (typeof thumb.isEmpty === 'function' && thumb.isEmpty())) {
      return { ok: false, reason: '屏幕画面为空（可能被系统保护或正在锁屏）' }
    }
    const imageSize = typeof thumb.getSize === 'function' ? thumb.getSize() : { width: 0, height: 0 }
    if (!imageSize.width || !imageSize.height) return { ok: false, reason: '屏幕画面尺寸异常' }

    // ── 无取景框：整屏 ──
    if (!cropRect) {
      return { ok: true, width: imageSize.width, height: imageSize.height, data: thumb.toBitmap() }
    }

    // ── 有取景框：裁到框内 ──
    // 夹回显示器范围：框可以被拖到屏幕外一半，但裁剪区必须落在画面里。
    const inside = intersectRect(cropRect, { x: display.bounds.x, y: display.bounds.y, width: display.size.width, height: display.size.height })
    if (!inside || inside.width < 24 || inside.height < 24) {
      return { ok: false, reason: '取景框不在屏幕内，请把它拖回来' }
    }
    // 缩略图可能被缩过（4K 屏）—— 用"实际缩略图宽 / 显示器 DIP 宽"现算比例，
    // 而不是直接用 scaleFactor：两者在缩过之后并不相等。
    const ratio = imageSize.width / display.size.width
    const crop = clampToImage({
      x: (inside.x - display.bounds.x) * ratio,
      y: (inside.y - display.bounds.y) * ratio,
      width: inside.width * ratio,
      height: inside.height * ratio
    }, imageSize)

    let cropped
    try {
      // 原生位图（BGRA）。见文件头第 4 点：不翻转通道。
      cropped = thumb.crop(crop)
    } catch (e: unknown) {
      return { ok: false, reason: `裁剪取景框失败：${e instanceof Error ? e.message : String(e)}` }
    }
    const cropSize = typeof cropped.getSize === 'function' ? cropped.getSize() : { width: 0, height: 0 }
    if (!cropSize.width || !cropSize.height) return { ok: false, reason: '取景框区域为空' }
    return { ok: true, width: cropSize.width, height: cropSize.height, data: cropped.toBitmap() }
  }

  return { captureScreen }
}

module.exports = {
  install() {},
  enable() {},
  disable() {},
  uninstall() {},

  /**
   * 能力表：`能力名 → 实现`。
   *
   * ⚠ 能力名与 `qr-scanner.hira-plugin.json` 的 `capabilities`、
   * 以及 `main/ipc/screen.js` 里 `invoke('qr.captureScreen')` 必须逐字一致。
   */
  registerProviders() {
    const api = createScreenCapture()
    return [
      {
        id: 'qr-scanner.screen-capture',
        capability: 'qr.captureScreen',
        // `around(input, execution)` —— 第一个参数就是调用方传来的入参（见 provider-registry）
        around: (input: unknown) => api.captureScreen(input && typeof input === 'object'
          ? input as { displayId?: string; frameBounds?: unknown }
          : {})
      }
    ]
  }
}
