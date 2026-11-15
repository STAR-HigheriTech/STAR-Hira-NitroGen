/**
 * theme-daily.js —— 「每日一图」的取图器：**Bing 每日壁纸**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件（而不是塞进 theme-service）
 * ══════════════════════════════════════════════════════════════════════
 * 它是这套主题体系里**唯一会联网**的地方：网络可以慢、可以失败、可以返回垃圾。
 * 把这些不确定性关在一个只有 `get()` / `ensure()` 两个方法的盒子里，
 * `theme-service` 就仍然是"同步、纯、可单测"的那一层（它只读缓存里的一个字符串）。
 *
 * ── 缓存为什么按"天" ────────────────────────────────────────────────
 * Bing 每天换一张。缓存键就是**本地日期**：同一天里反复渲染只读一次内存，
 * 跨天自动失效 → 下一次读缓存时重新拉。不需要定时器，也不需要落盘
 * （进程重启后第一眼没图、几百毫秒后补上，代价是一次 HTTP）。
 *
 * ── 为什么"失败也算拉过" ────────────────────────────────────────────
 * 若失败不记账，`backgroundFor` 每次调用都会再起一次请求 —— 离线时就是**请求风暴**。
 * 所以失败后记一个冷却时刻：冷却期内不再重试，冷却结束自然重试（离线恢复后自愈）。
 *
 * ── 与旧 Hira 的一处偏离 ────────────────────────────────────────────
 * 旧实现最后会回落到第三方图床（`api.dujin.org/bing/1920.php`）。这里**去掉**了：
 * 用户要的是"Bing 壁纸"，而那个地址给的东西不受 Bing 控制、也不保证还是它。
 * 拉不到就不落图（页面露出主题底色），比"悄悄换一张别家的图"诚实。
 */

import { assertSafeOutboundUrl } from '@hira-ng/infra-net-guard'

/** Bing 每日壁纸接口。cn 优先（国内可直连），回落 www。 */
const BING_ENDPOINTS = Object.freeze([
  'https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN',
  'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US'
])

/** 失败后的冷却时长（5 分钟）—— 见文件头"为什么失败也算拉过"。 */
const RETRY_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 单次请求超时（8 秒）。没有它，一个挂住的连接会让 `ensure()` 的 Promise 永远悬着，
 * 而调用方是拿它当"拿到就重发广播"用的信号。
 */
const REQUEST_TIMEOUT_MS = 8 * 1000
const MAX_JSON_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_REDIRECTS = 4

interface DailyFetchResponse {
  ok: boolean
  status?: number
  url?: string
  headers?: { get(name: string): string | null }
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } } | null
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
}

interface DailyBackgroundDeps {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<DailyFetchResponse>
  now?: () => number
  logger?: { warn?: (...args: unknown[]) => void }
}

/**
 * @param {{
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<DailyFetchResponse>,
 *   now?: () => number,
 *   logger?: { warn?: Function }
 * }} [deps]
 *   `fetchImpl` 由 APPS 注入（Electron 的 `net.fetch` 走系统代理，比全局 fetch 更合适）——
 *   本模块不 require electron，于是它可以被单测直接喂一个假的 fetch。
 */
function createDailyBackgroundProvider(deps: DailyBackgroundDeps = {}) {
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : null
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const logger = deps.logger || console

  /**
   * 缓存与状态。
   *   · `day`       —— 这份结果属于哪一天（本地日期）
   *   · `url`       —— 取到的地址（失败为空串）
   *   · `retryAt`   —— 失败后的冷却截止时刻（0 = 不冷却）
   */
  let day = ''
  let url = ''
  let retryAt = 0
  /** 并发去重：同一时刻只有一个请求在飞。 */
  let inflight: Promise<string> | null = null

  async function fetchGuarded(target: string, init: RequestInit): Promise<DailyFetchResponse> {
    let current = target
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const verdict = await assertSafeOutboundUrl(current)
      if (!verdict.ok) throw new Error(`壁纸地址不允许访问：${verdict.reason}`)
      const response = await fetchImpl!(verdict.url, { ...init, redirect: 'manual' })
      const status = Number(response.status || 0)
      if (![301, 302, 303, 307, 308].includes(status)) return response
      const location = response.headers?.get('location') || ''
      try {
        const reader = response.body?.getReader()
        await reader?.cancel()
      } catch (_) {}
      if (!location) throw new Error(`重定向缺少 Location（HTTP ${status}）`)
      current = new URL(location, verdict.url).href
    }
    throw new Error('壁纸重定向次数过多')
  }

  async function readCapped(response: DailyFetchResponse, maxBytes: number): Promise<Buffer> {
    const declared = Number(response.headers?.get('content-length') || 0)
    if (declared > maxBytes) throw new Error(`响应过大（${declared} 字节）`)
    const reader = response.body?.getReader()
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) throw new Error(`响应过大（${buffer.length} 字节）`)
      return buffer
    }
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          try { await reader.cancel() } catch (_) {}
          throw new Error(`响应过大（超过 ${maxBytes} 字节）`)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      try { await reader.cancel() } catch (_) {}
      throw error
    }
    return Buffer.concat(chunks, total)
  }

  /** 本地日期 `YYYY-MM-DD` —— 按**用户所在时区**的"今天"，而不是 UTC 日。 */
  function today(): string {
    const d = new Date(now())
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /**
   * 同步读缓存 —— **唯一的读取口**（`theme-service` 用一个同步纯函数算背景，只能这样读）。
   * @returns {string} 今日壁纸地址；还没取到（或今天取失败）时为空串
   */
  function get(): string {
    return day === today() ? url : ''
  }

  /** 带超时的一次请求（`fetch` 本身没有超时，挂住的连接必须自己掐）。 */
  async function fetchJsonWithTimeout(target: string): Promise<unknown> {
    const fetch = fetchImpl
    if (!fetch) return null
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => { try { controller && controller.abort() } catch (_) {} }, REQUEST_TIMEOUT_MS)
    try {
      const res = await fetchGuarded(target, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      if (!res) return null
      if (!res.ok) {
        try {
          const reader = res.body?.getReader()
          await reader?.cancel()
        } catch (_) {}
        return null
      }
      const text = (await readCapped(res, MAX_JSON_BYTES)).toString('utf8')
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 确保今天有一张图（幂等 + 并发去重 + 失败冷却）。
   *
   * **尽力而为**：任何失败都不抛，只返回空串 —— 调用方（`backgroundFor`）拿到空串
   * 就当"今天没有图"，界面照旧。
   *
   * @returns {Promise<string>} 解析到的绝对地址；拿不到为空串
   */
  function ensure(): Promise<string> {
    const key = today()
    if (day === key && url) return Promise.resolve(url)
    if (day === key && !url && now() < retryAt) return Promise.resolve('')
    if (inflight) return inflight
    if (!fetchImpl) return Promise.resolve('')

    inflight = (async () => {
      for (const endpoint of BING_ENDPOINTS) {
        try {
          const data = await fetchJsonWithTimeout(endpoint)
          const images = data !== null && typeof data === 'object' && Array.isArray((data as { images?: unknown }).images)
            ? (data as { images: unknown[] }).images
            : []
          const first = images[0]
          const rel = first !== null && typeof first === 'object'
            ? (first as { url?: unknown }).url
            : null
          if (typeof rel !== 'string' || !rel) continue
          // Bing 给的是**站内相对路径**（`/th?id=OHR…`）→ 用同一个 endpoint 的 origin 拼绝对地址。
          const resolved = new URL(String(rel), new URL(endpoint).origin).toString()
          const verdict = await assertSafeOutboundUrl(resolved)
          if (!verdict.ok) continue
          day = key
          url = verdict.url
          retryAt = 0
          return resolved
        } catch (error) {
          logger.warn?.(`[theme-daily] 拉取失败（${endpoint}）：`, error instanceof Error ? error.message : error)
        }
      }
      // 全部失败：记成"今天失败了"，冷却期内不再重试
      day = key
      url = ''
      retryAt = now() + RETRY_COOLDOWN_MS
      return ''
    })().finally(() => { inflight = null })

    return inflight
  }

  /**
   * 拉一张图的**字节** —— 只给「壁纸亮度测量」用（见 theme-luminance.js）。
   *
   * 为什么放在这里、而不是在 theme-service 里再开一处联网：本模块是这套体系里
   * **唯一会联网的地方**（见文件头）—— 亮度测量要读那张远程照片，就也走这条路，
   * 于是超时 / 代理（注入的 fetchImpl）/ 失败静默这些口径全都不用再写第二份。
   * 失败一律返回 null（量不到就退回"按主题底色判"），不抛。
   */
  async function bytes(target: string): Promise<Buffer | null> {
    if (!fetchImpl || !target) return null
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => { try { controller && controller.abort() } catch (_) {} }, REQUEST_TIMEOUT_MS)
    try {
      const verdict = await assertSafeOutboundUrl(target)
      if (!verdict.ok) return null
      const res = await fetchGuarded(verdict.url, controller ? { signal: controller.signal } : {})
      if (!res || !res.ok) return null
      return await readCapped(res, MAX_IMAGE_BYTES)
    } catch (error) {
      logger.warn?.('[theme-daily] 取图字节失败（仅影响自动前景）：', error instanceof Error ? error.message : error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { get, ensure, bytes, today }
}

module.exports = { createDailyBackgroundProvider, BING_ENDPOINTS }
