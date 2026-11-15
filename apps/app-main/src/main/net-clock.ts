/**
 * net-clock —— **网络校时**（求本机时钟相对网络时间的偏移）。
 *
 * 为什么需要它：TOTP 的码是**按时间**算的。本机时钟比服务器慢 40 秒，用户看到的
 * 就是"这一步验证码永远是错的"，而界面上没有任何线索指向"你的表慢了"。
 * 于是面板给一个「校准」按钮：量一次网络时间，把偏移记下来，之后算码时叠加。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三个刻意的取舍
 * ══════════════════════════════════════════════════════════════════════
 * ① **只测量、不改系统时间**。
 *    改系统时间是全局副作用（其它程序、证书校验、日志全受影响），一个验证器面板
 *    没有资格做这件事。这里产出的只是一个偏移量，由 TOTP 域在自己的算码路径上叠加。
 *
 * ② **多源 + 精度分层**。
 *    单一时间源可能是错的、可能被劫持、可能刚好慢了半秒。所以并行问多个源，
 *    再取中位数。并且区分**精度**：
 *      · 响应体里带毫秒时间（如 `cloudflare/cdn-cgi/trace` 的 `ts=`）→ 精度 1ms；
 *      · 只能靠 HTTP `Date` 响应头 → 精度 1s（头部本身截断到秒）。
 *    有高精度样本时**只用高精度样本** —— 把秒级的混进去会把中位数拖偏半秒，
 *    那就等于"校准了个寂寞"。
 *
 * ③ **网络往返取中点**。
 *    响应到达时刻不是"服务器给时间的时刻"，而是"服务器给时间 + 回程"。
 *    用 `(发出 + 收到) / 2` 当作那一刻的本机时间，能把单程延迟抵消掉一半；
 *    剩下的误差量级就是 RTT 的一半，对 30 秒窗口的验证码足够了。
 *
 * 本文件**不 require electron**：网络能力由调用方注入（与 theme-daily 同一条纪律），
 * 于是它可以在任何环境里被直接测试，也不会把 Electron 拖进纯 Node 的路径。
 */

/** 单源的硬超时：校时是用户点了按钮在等的，不能无限等一个不响应的源。 */
export interface NetClockSource {
  name: string
  url: string
  precisionMs: number
  parse: ((text: string) => number | null) | null
}

export interface NetClockSample {
  name: string
  offsetMs: number
  rttMs: number
  measuredAt: number
  precisionMs: number
}

export interface NetClockResult {
  offsetMs: number
  source: string
  measuredAt: number
  rttMs: number
}

export interface NetClockOptions {
  fetchImpl?: typeof fetch | null
  timeoutMs?: number
  sources?: readonly NetClockSource[]
}

export interface NetClock {
  measure(): Promise<NetClockResult>
}

const DEFAULT_TIMEOUT_MS = 4000
const MAX_RESPONSE_BYTES = 256 * 1024

/** 偏移的合理上限：超过一天基本只能是"时间源给错了"或"本机时间彻底乱了"。 */
export const MAX_OFFSET_MS = 24 * 60 * 60 * 1000

/**
 * 默认时间源。
 *
 * `precisionMs` 是**这个源能给到的精度**（不是误差保证）：响应体里带秒以下
 * 小数的时间戳记 1，只能读 `Date` 头（截断到整秒）的记 1000。
 */
const DEFAULT_SOURCES: readonly NetClockSource[] = Object.freeze([
  {
    name: 'cloudflare',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    precisionMs: 1,
    parse: (text: string) => {
      // 响应体形如 "fl=...\nh=...\nts=1698000000.123\n..."
      const m = /(?:^|\n)ts=([\d.]+)/.exec(String(text || ''))
      const secs = m ? Number(m[1]) : NaN
      return Number.isFinite(secs) ? secs * 1000 : null
    }
  },
  {
    name: 'worldtimeapi',
    url: 'https://worldtimeapi.org/api/ip',
    precisionMs: 1,
    parse: (text: string) => {
      try {
        const json = JSON.parse(String(text || ''))
        const secs = Number(json && json.unixtime)
        return Number.isFinite(secs) ? secs * 1000 : null
      } catch (_) {
        return null
      }
    }
  },
  {
    // 兜底源：不解析正文，只读 `Date` 响应头（国内可达性最好的一档）。
    name: 'http-date',
    url: 'https://www.baidu.com/',
    precisionMs: 1000,
    parse: null
  }
])

/**
 * 解析 HTTP `Date` 头。
 *
 * 头的粒度是**秒**，所以返回值天然带 ±0.5s 的量化误差 —— 这也是它只配当兜底源的原因。
 * 解析失败返回 null（而不是 NaN），让调用方按"这个源没给出时间"处理。
 */
export function parseHttpDate(value: unknown): number | null {
  const text = String(value || '').trim()
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** 中位数（不修改入参）。 */
function median(list: readonly number[]): number {
  const sorted = list.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid] || 0
  return ((sorted[mid - 1] || 0) + (sorted[mid] || 0)) / 2
}

/**
 * @param {{ fetchImpl?: Function|null, timeoutMs?: number, sources?: object[] }} [options]
 *   `fetchImpl` 契约同全局 fetch：`(url, init) => Promise<Response>`。
 *   缺失时 `measure()` 会抛出可读原因（面板会把它显示出来，而不是静默失败）。
 */
export function createNetClock(options: NetClockOptions = {}): NetClock {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES

  /**
   * 问一个源。
   * 成功返回 `{ name, offsetMs, rttMs, measuredAt, precisionMs }`；失败直接抛。
   */
  async function probe(source: NetClockSource): Promise<NetClockSample> {
    if (!fetchImpl) throw new Error('当前环境不支持联网校时')
    const fetchFn = fetchImpl
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const sentAt = Date.now()
    try {
      const res = await fetchFn(source.url, {
        signal: controller ? controller.signal : undefined,
        // 校时必须拿到**当下**的时间：任何缓存层返回的旧响应都会把偏移算错
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache' }
      })
      if (!res.ok) {
        try { await res.body?.cancel() } catch (_) {}
        throw new Error(`HTTP ${res.status}`)
      }
      const declared = Number(res.headers?.get('content-length') || 0)
      if (declared > MAX_RESPONSE_BYTES) throw new Error('校时响应过大')
      const reader = res.body?.getReader()
      let text = ''
      if (!reader) {
        text = await res.text()
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('校时响应过大')
      } else {
        const chunks: Buffer[] = []
        let total = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            total += value.byteLength
            if (total > MAX_RESPONSE_BYTES) {
              try { await reader.cancel() } catch (_) {}
              throw new Error('校时响应过大')
            }
            chunks.push(Buffer.from(value))
          }
        } catch (error) {
          try { await reader.cancel() } catch (_) {}
          throw error
        }
        text = Buffer.concat(chunks, total).toString('utf8')
      }
      const receivedAt = Date.now()
      const rttMs = receivedAt - sentAt

      const precise = typeof source.parse === 'function' ? source.parse(text) : null
      const fromHeader = parseHttpDate(res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null)
      const serverMs = Number.isFinite(precise) ? precise : fromHeader
      if (serverMs == null || !Number.isFinite(serverMs)) throw new Error('响应里没有可用时间')

      // 单程延迟的一阶近似：RTT 的一半。此时"网络上的此刻"≈ sentAt + rtt/2
      const offsetMs = serverMs - (sentAt + rttMs / 2)
      return {
        name: source.name,
        offsetMs,
        rttMs,
        measuredAt: receivedAt,
        precisionMs: Number.isFinite(precise) ? Number(source.precisionMs) || 1 : 1000
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 量一次偏移。
   *
   * @returns {Promise<{ offsetMs: number, source: string, measuredAt: number, rttMs: number }>}
   * @throws 所有源都不可用时抛错（带可读中文原因）
   */
  async function measure(): Promise<NetClockResult> {
    if (!fetchImpl) throw new Error('当前环境不支持联网校时')

    const settled = await Promise.allSettled(sources.map((source) => probe(source)))
    const samples: NetClockSample[] = []
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue
      const sample = item.value
      if (!Number.isFinite(sample.offsetMs)) continue
      // 离谱的偏移量丢掉：宁可少一个样本，也不让一个坏源把校准结果带沟里
      if (Math.abs(sample.offsetMs) > MAX_OFFSET_MS) continue
      samples.push(sample)
    }
    if (!samples.length) throw new Error('联网校时失败（时间源都不可用，请检查网络）')

    /**
     * 精度分层：有毫秒级样本就只用它们。秒级样本（Date 头）的量化误差可达 500ms，
     * 混进中位数只会让结果更差 —— 而它存在的意义是"高精度源都不可达时别完全没得用"。
     */
    const precise = samples.filter((s) => s.precisionMs <= 1)
    const pool = precise.length ? precise : samples

    // 取中位数后再挑"最接近中位数"的那个真实样本 —— 这样 source/rtt 与 offset 是同一份测量，
    // 而不是一个虚构出来的平均值的来路不明。
    const center = median(pool.map((s) => s.offsetMs))
    let best = pool[0]
    if (!best) throw new Error('联网校时失败（没有有效时间样本）')
    for (const s of pool) {
      if (Math.abs(s.offsetMs - center) < Math.abs(best.offsetMs - center)) best = s
    }

    return {
      offsetMs: Math.round(best.offsetMs),
      source: best.name,
      measuredAt: best.measuredAt,
      rttMs: Math.round(best.rttMs)
    }
  }

  return { measure }
}

/**
 * 解析"发网络请求"的实现：**Electron 的 `net.fetch` 优先**（走系统代理与系统证书，
 * 全局 fetch 在部分代理环境下拿不到外网），拿不到 `net` 时回落全局 fetch，都没有则 null。
 *
 * 单独导出是因为主进程里不止一处需要它（每日一图、即时答案、本文件）——
 * 各自抄一份 if/else 迟早会漂移。
 */
export function resolveNetFetch(): typeof fetch | null {
  try {
    const { net } = require('electron') as typeof import('electron')
    if (net && typeof net.fetch === 'function') {
      return ((url: string | Request, init?: RequestInit) => net.fetch(url, init)) as typeof fetch
    }
  } catch (_) {}
  return typeof fetch === 'function' ? (url, init) => fetch(url, init) : null
}

