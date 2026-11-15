'use strict'

/**
 * 壁纸「平均亮度」测量 —— **「自动前景」的唯一数据来源**。
 *
 * 背景见 shared-types/src/theme.mjs 的 `AUTO_FG` / `autoFgFor`：
 * 前景三档可以写 `"auto"`，由"背景的明暗 + 现有遮罩设置"算出该用黑字还是白字。
 * 那条公式需要一个**事实**：这张壁纸整体有多亮 —— 本模块就是量它的地方。
 *
 * ── 为什么在**主进程**量，而不是渲染层画到 canvas 上取样 ────────────────────
 *   · 资产图在本地（`hira-theme://` / 插件目录）：主进程拿得到字节，渲染层要绕协议；
 *   · 「每日一图」是**远程**图：渲染层 `<img>` 跨域 + canvas `getImageData` 会被
 *     CORS 挡掉（tainted canvas），而主进程的 `net.fetch` 根本不受同源策略约束。
 *   于是"谁有事实谁算"（与侧栏浮出层的几何同一个口径）。
 *
 * ── 量法（成本可忽略）────────────────────────────────────────────────────
 *   `nativeImage.createFromBuffer` → `resize({ width: 64 })` → `toBitmap()`（BGRA）
 *   → 逐像素算 WCAG 相对亮度取平均。缩放之后再解码，一张 4K 照片也只遍历 ~3k 像素，
 *   一次几十微秒；结果按**图片身份**缓存，同一张图只量一次。
 *   跳过全透明像素（PNG 的空白区不该拉低平均值）。
 *
 * ⚠ 这里量的是**平均**亮度，不是"最亮/最暗"——前景压在整条带上，平均值才是它面对的
 *   那层底。与 `autoFgFor` 里的合成（在亮度空间做 alpha 混合）口径一致。
 */

/** 采样宽度：只求平均值，64px 足够（再大只是线性变慢）。 */
const SAMPLE_WIDTH = 64

interface NativeImageLike {
  toBitmap: () => Buffer
  isEmpty?: () => boolean
  resize?: (options: { width: number }) => NativeImageLike
}

interface NativeImageFactoryLike {
  createFromBuffer(buffer: Uint8Array): NativeImageLike
}

interface ThemeLuminanceDeps {
  logger?: { warn?: (...args: unknown[]) => void }
}

/**
 * sRGB 通道（0~255）→ 线性值。
 * 与 shared-types#relativeLuminance 里的那一小段**逐字同源** ——
 * 两边必须同一条公式，否则"量的"和"判的"会不一致。
 */
function channelToLinear(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/**
 * 一张（已缩放的）nativeImage → **平均相对亮度** 0~1（无有效像素时返回 null）。
 *
 * @param {Electron.NativeImage} image
 * @returns {number|null}
 */
function averageLuminance(image: NativeImageLike | null | undefined): number | null {
  if (!image || typeof image.toBitmap !== 'function') return null
  let bitmap: Buffer | null = null
  try {
    bitmap = image.toBitmap()
  } catch (_) {
    return null
  }
  if (!bitmap || !bitmap.length) return null
  let sum = 0
  let n = 0
  // BGRA，四字节一像素。
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (bitmap[i + 3] < 8) continue // 全透明像素不参与
    const b = channelToLinear(bitmap[i])
    const g = channelToLinear(bitmap[i + 1])
    const r = channelToLinear(bitmap[i + 2])
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
    n++
  }
  return n ? sum / n : null
}

/** 解码一段图片字节 → 平均亮度（0~1）；解不出来返回 null。 */
function luminanceOfBytes(buf: Uint8Array | null | undefined): number | null {
  if (!buf || !buf.length) return null
  let nativeImage: NativeImageFactoryLike | null = null
  try {
    nativeImage = (require('electron') as { nativeImage?: NativeImageFactoryLike }).nativeImage || null
  } catch (_) {
    return null
  }
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null
  let image: NativeImageLike | null = null
  try {
    image = nativeImage.createFromBuffer(buf)
  } catch (_) {
    return null
  }
  if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null
  try {
    if (typeof image.resize === 'function') image = image.resize({ width: SAMPLE_WIDTH })
  } catch (_) {
    // 缩不了就直接量原图（慢一点，但不至于没有值）
  }
  return averageLuminance(image)
}

/** 测量失败后的冷却：避免"离线 / 图挂了"时每次发布都再拉一次（对齐 theme-daily 的口径）。 */
const RETRY_MS = 5 * 60 * 1000

/**
 * 缓存的条目上限（**防"技术性无界"，不是性能调优**）。
 *
 * 为什么需要：缓存键是「图片身份」，其中 `daily:<当天 URL>` **每天都不一样** ——
 * 于是 `cache` 与 `failedAt` 会以约 365 条/年 的速度只增不减（值只是一个数字，
 * 单条极小，但常年不关机的进程不该有这种单调增长）。
 *
 * 为什么 32 足够：真正会被**再次读到**的键只有「当前这张」——用户壁纸 / 插件主题壁纸
 * （数量远小于 32）+ 今天的每日图。历史那些 daily 键永远不会再被命中，淘汰它们零代价。
 * 万一某个键被淘汰后又被用到，代价只是"重新解码量一次"（后台 Promise，不阻塞任何人）。
 */
const MAX_ENTRIES = 32

/** 有界写入：命中即提级，超上限就淘汰最早插入的那个（Map 迭代序 = 插入序）。 */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/**
 * @param {{ logger?: { warn?: Function } }} [options]
 *   本模块**不认识**"资产库 / 远程"是什么 —— 字节由调用方每次传入（见 `ensure` 的 loader），
 *   它只负责"解码 + 平均 + 按身份缓存"。
 */
function createThemeLuminance({ logger }: ThemeLuminanceDeps = {}) {
  /** 图片身份 → 平均亮度（量成功才有值）。有界，见 MAX_ENTRIES。 */
  const cache = new Map<string, number>()
  /** 图片身份 → 正在量。 */
  const inflight = new Set<string>()
  /** 图片身份 → 上次失败时刻（失败冷却用）。有界，见 MAX_ENTRIES。 */
  const failedAt = new Map<string, number>()

  /** 同步读缓存：没量过 / 量失败 → null（调用方此时退回"按主题底色判"）。 */
  function peek(id: string): number | null {
    if (!id) return null
    const hit = cache.get(id)
    return typeof hit === 'number' ? hit : null
  }

  /**
   * 后台量一次（幂等 + 并发去重 + 失败冷却）。
   *
   * @param {string} id 图片身份（缓存键）
   * @param {() => Promise<Buffer|null>} loader 拿字节（只在首次真的被调用）
   * @param {(lum: number) => void} [onReady] 量**成功**时回调一次（用于再广播一次主题）
   */
  function ensure(id: string, loader: () => Promise<Buffer | null>, onReady?: (lum: number) => void): void {
    if (!id) return
    /* ⚠ 缓存命中时**不能**再调 onReady：调用方的 onReady 是"再广播一次主题"，
       而广播又会回来读缓存 —— 会形成 emit ↔ 读缓存的死循环。onReady 只在
       "这一次刚刚量出来"时响一次（下面 inflight 去重保证唯一）。 */
    if (cache.has(id)) return
    if (inflight.has(id)) return
    const lastFail = failedAt.get(id)
    if (lastFail && Date.now() - lastFail < RETRY_MS) return
    inflight.add(id)
    Promise.resolve()
      .then(() => (typeof loader === 'function' ? loader() : null))
      .then((buf) => luminanceOfBytes(buf))
      .then((lum) => {
        inflight.delete(id)
        if (typeof lum !== 'number') {
          setBounded(failedAt, id, Date.now())
          return
        }
        setBounded(cache, id, lum)
        failedAt.delete(id)
        if (typeof onReady === 'function') {
          try { onReady(lum) } catch (_) {}
        }
      })
      .catch((error) => {
        inflight.delete(id)
        setBounded(failedAt, id, Date.now())
        logger?.warn?.('[theme] 壁纸亮度测量失败（自动前景退回按底色判）：', error instanceof Error ? error.message : error)
      })
  }

  return { peek, ensure }
}

module.exports = { createThemeLuminance, luminanceOfBytes, averageLuminance }
