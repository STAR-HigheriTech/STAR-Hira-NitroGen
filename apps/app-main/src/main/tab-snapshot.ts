/**
 * tab-snapshot 服务 —— 标签截图「采集 → 编码 → 读取」的服务层（APPS 层组合根）。
 *
 * 与 infra 的纯存储 SnapshotStore 解耦：
 *   - 本模块只负责 electron 侧能力（WebContentsView#capturePage + NativeImage#toJPEG）
 *     与 Web 标准响应（Response）的拼装；
 *   - 「存哪里、怎么淘汰」全部交给注入的 store（不含 electron，可单测）。
 *
 * 与 TabManager 解耦：TabManager 完全不认识本模块，只通过 hook
 * `onTabWillHide(tabId, webContents)` 单向广播「该采帧了」的信号 ——
 * 采集时机（必须在 view 仍挂载、页面仍渲染时）由 TabManager 掌握，
 * 采集/编码/淘汰策略由本模块掌握，二者互不依赖。
 *
 * 对齐 RT tab-sync 的关键约束：**detach 后 capturePage 返回空图**，
 * 因此调用方必须在 view 仍挂载时触发（见 TabManager 的 switchTo / sleepTab）。
 */

/** 对齐 RT：JPEG 质量 70。 */
import type { NativeImage, WebContents } from 'electron'

interface SnapshotRecord { buffer: Buffer; contentType?: string }
interface SnapshotStorePort { put: (key: string, data: Buffer, contentType: string) => string; get: (id: string) => SnapshotRecord | null | undefined; getId: (key: string) => string | null | undefined; removeByKey: (key: string) => void; [key: string]: unknown }
interface TabSnapshotDeps { store: SnapshotStorePort; hiraScheme?: string; jpegQuality?: number; maxWidth?: number; throttleMs?: number; now?: () => number }

const DEFAULT_JPEG_QUALITY = 70
/**
 * 超宽按比例缩放的目标宽度。
 *
 * 消费方（标签 hover 预览）的卡片缩略图上限是 **336 CSS px**（见
 * `renderer/tabpreview-overlay` 的 THUMB_MAX_WIDTH）——即便按 3x DPR 算也只有 1008。
 * 取 1280 已留足余量，而编码成本与像素数成正比：1920² → 1280² 少 **55%** 的像素。
 * `NativeImage.toJPEG` 是**同步**的，跑在主进程上；这一档直接决定切标签后那一下的跟手度。
 */
const DEFAULT_MAX_WIDTH = 1280
/** 同一标签两次采集的最小间隔，避免用户快速切标签时连打 capturePage。 */
const DEFAULT_THROTTLE_MS = 1000

/**
 * @param {object} deps
 * @param {object} deps.store 注入的 SnapshotStore（put / get / getId / removeByKey）
 * @param {string} [deps.hiraScheme='hira'] 生成读取 URL 用的协议名（与协议层同源）
 * @param {number} [deps.jpegQuality=70]
 * @param {number} [deps.maxWidth=1920]
 * @param {number} [deps.throttleMs=1000]
 * @param {() => number} [deps.now] 注入时钟（默认 Date.now）
 */
function createTabSnapshotService(deps: TabSnapshotDeps) {
  const store = deps.store
  if (!store) throw new Error('createTabSnapshotService: store 必填')
  const hiraScheme = deps.hiraScheme || 'hira'
  const jpegQuality = typeof deps.jpegQuality === 'number' && Number.isFinite(deps.jpegQuality)
    ? deps.jpegQuality
    : DEFAULT_JPEG_QUALITY
  const maxWidth = typeof deps.maxWidth === 'number' && Number.isFinite(deps.maxWidth) && deps.maxWidth > 0 ? deps.maxWidth : DEFAULT_MAX_WIDTH
  const throttleMs = typeof deps.throttleMs === 'number' && Number.isFinite(deps.throttleMs) && deps.throttleMs >= 0 ? deps.throttleMs : DEFAULT_THROTTLE_MS
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  /** tabId → 上次采集时间（节流） */
  const lastCaptureAt = new Map<string, number>()
  /**
   * tabId → 采集代际。
   *
   * 为什么需要：编码被有意挪到**让出一拍之后**（见 capture 的说明），于是"抓帧"与
   * "写进 store"之间多了一个窗口。期间标签若被关闭（`forget`），这次迟到的 put
   * 会把一张已经没人要的截图重新塞回 store（要等 TTL/LRU 才淘汰）。代际不一致即丢弃。
   */
  const captureSeq = new Map<string, number>()

  function encode(image: NativeImage | null | undefined): Buffer | null {
    if (!image) return null
    let toEncode = image
    try {
      const size = typeof image.getSize === 'function' ? image.getSize() : null
      if (size && size.width > maxWidth) {
        const scale = maxWidth / size.width
        toEncode = image.resize({ width: maxWidth, height: Math.round(size.height * scale) })
      }
    } catch (_) {}
    try {
      return toEncode.toJPEG(jpegQuality)
    } catch (_) {
      return null
    }
  }

  /**
   * 采集并暂存某标签的一帧。**必须在 view 仍挂载时调用**。
   * @param {string} tabId
   * @param {Electron.WebContents} webContents
   * @returns {Promise<string|null>} 不透明 id（失败/节流/空图 → null）
   */
  async function capture(tabId: string, webContents: WebContents): Promise<string | null> {
    const key = String(tabId)
    if (!webContents || typeof webContents.capturePage !== 'function') return null
    try {
      if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return null
    } catch (_) {
      return null
    }
    const t = now()
    const prev = lastCaptureAt.get(key)
    if (prev != null && t - prev < throttleMs) return null
    lastCaptureAt.set(key, t)
    /**
     * **正在播放媒体的标签：有旧帧就不再采新帧。**
     *
     * `capturePage` 要把当前合成帧回读到 CPU —— 视频帧在 GPU 纹理上，这次回读比静态页
     * 贵得多（合成器往返 + 整帧拷贝），而它发生在**切标签的关键路径上**（视图隐藏前）。
     * hover 预览要的是"该标签上次可见时的画面"，沿用上一帧完全够用；只有**从没有过**
     * 旧帧时才值得为它付这一次回读（否则预览永远空白）。
     */
    if (typeof webContents.isCurrentlyAudible === 'function' && webContents.isCurrentlyAudible() &&
        typeof store.getId === 'function' && store.getId(key)) {
      return null
    }
    const seq = (captureSeq.get(key) || 0) + 1
    captureSeq.set(key, seq)

    let image
    try {
      image = await webContents.capturePage()
    } catch (_) {
      return null
    }
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null
    /**
     * **让出一拍再编码** —— 这是切标签跟手度的关键。
     *
     * `capturePage` 本身是异步的（调用方发起后立刻继续 `showTab`），但解码 + 缩放 +
     * `toJPEG` 全是**同步**的：它们会在主进程里连续占住几毫秒到十几毫秒，正好压在
     * 用户刚切过去那一拍上（表现为"切标签钝一下"）。这里先 setImmediate 把控制权
     * 交回事件循环：显示新标签、布局、IPC 都先落地，编码随后作为独立一拍执行。
     *
     * 语义不变：抓帧仍然发生在"视图还没隐藏"的那一刻（这是 RT 的硬约束），
     * 挪后的只是**编码**。
     */
    await new Promise((resolve) => setImmediate(resolve))
    // 期间标签被关闭（forget）或视图已换 → 这张帧没人要了，绝不写回 store
    if (captureSeq.get(key) !== seq) return null
    const buffer = encode(image)
    if (!buffer || !buffer.length) return null
    return store.put(key, buffer, 'image/jpeg')
  }

  /**
   * 某标签当前截图的读取 URL（无可用帧 → null）。
   * @param {string} tabId
   * @returns {string|null}
   */
  function urlFor(tabId: string): string | null {
    const id = store.getId(String(tabId))
    return id ? `${hiraScheme}://tab-snapshot?id=${encodeURIComponent(id)}` : null
  }

  /**
   * hira://tab-snapshot?id=<id> 的动态页处理：返回内存 JPEG。
   * @param {URL} url
   * @returns {Response}
   */
  function resolveRequest(url: URL): Response {
    const id = url && url.searchParams ? url.searchParams.get('id') : null
    if (!id) return new Response('No snapshot ID provided', { status: 400 })
    const rec = store.get(id)
    if (!rec) return new Response('Snapshot not found', { status: 404 })
    return new Response(rec.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': rec.contentType || 'image/jpeg',
        // 每次采集 id 都新，天然防缓存；再显式声明 no-store
        'Cache-Control': 'no-store'
      }
    })
  }

  /** 标签关闭/销毁时清理其截图与节流状态，立即释放内存。 */
  function forget(tabId: string): void {
    const key = String(tabId)
    lastCaptureAt.delete(key)
    // 让代际失效：在途的那次采集（已抓帧、还没编码完）醒来后会主动丢弃
    captureSeq.delete(key)
    store.removeByKey(key)
  }

  return { capture, urlFor, resolveRequest, forget }
}

module.exports = {
  createTabSnapshotService,
  SNAPSHOT_JPEG_QUALITY: DEFAULT_JPEG_QUALITY,
  SNAPSHOT_MAX_WIDTH: DEFAULT_MAX_WIDTH,
  SNAPSHOT_THROTTLE_MS: DEFAULT_THROTTLE_MS
}
