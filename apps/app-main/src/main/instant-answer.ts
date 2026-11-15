/**
 * instant-answer —— 即时答案的**网络侧**（主进程）。
 *
 * 职责边界：
 *   · 只做「查询 → 上游 JSON → 中立事实数组」这一条链，不碰 IPC、不认识窗口；
 *   · 解析规则全部在 `@hira-ng/shared-types/src/instant-answer.mjs`（纯函数，唯一真源）；
 *   · 失败一律**静默返回空数组** —— 即时答案是增强，不是导航前置条件，
 *     上游超时/限流/断网都不该让地址栏报错或卡住。
 *
 * 性能约束（地址栏每次停顿都要跑一条）：
 *   · `timeoutMs` 默认 2500ms，AbortController 直接掐断连接，不留下悬挂的 socket；
 *   · 同一个 query 5 分钟内只打一次上游（LRU 容量 100）—— 用户删字/补字时
 *     "北京天" → "北京天气" → "北京天气 " 这类前缀会反复命中同一条；
 *   · **并发合并**：同一 query 正在飞的时候再来一次，直接复用那个 Promise，
 *     避免输入抖动把上游打成连发。
 */

const { parseInstantAnswer } = require('@hira-ng/shared-types/src/instant-answer.mjs')

/** DDG Instant Answer API：`no_redirect` 保证拿到 JSON 而不是 302 跳搜索页。 */
const ENDPOINT = 'https://api.duckduckgo.com/?t=min&skip_disambig=1&no_redirect=1&format=json&q='

/** 缓存有效期（ms）：5 分钟。 */
const CACHE_TTL_MS = 5 * 60 * 1000
/** 缓存容量（条）：超出按插入顺序淘汰最旧的。 */
const CACHE_MAX = 100

const USER_AGENT = 'Mozilla/5.0 (compatible; Hira/1.0)'
const MAX_RESPONSE_BYTES = 256 * 1024

interface InstantAnswerItem {
  kind: string
  title: string
  text?: string
  url?: string
  icon?: string
  provider?: string
}

interface FetchResponseLike {
  ok?: boolean
  headers?: { get(name: string): string | null }
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } } | null
  json: () => Promise<unknown>
}

interface InstantAnswerDeps {
  fetchImpl?: ((url: string, init?: RequestInit) => Promise<FetchResponseLike>) | null
  timeoutMs?: number
  now?: () => number
}

function createInstantAnswerService(deps: InstantAnswerDeps = {}) {
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : null
  const timeoutMs = Math.max(500, Number(deps.timeoutMs) || 2500)
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  const cache = new Map<string, { at: number; items: InstantAnswerItem[] }>()
  const inflight = new Map<string, Promise<InstantAnswerItem[]>>()

  async function readJson(res: FetchResponseLike): Promise<unknown> {
    const declared = Number(res.headers?.get('content-length') || 0)
    if (declared > MAX_RESPONSE_BYTES) throw new Error('即时答案响应过大')
    const reader = res.body?.getReader()
    if (!reader) return await res.json()
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
          throw new Error('即时答案响应过大')
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      try { await reader.cancel() } catch (_) {}
      throw error
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
  }

  function readCache(key: string): InstantAnswerItem[] | null {
    const hit = cache.get(key)
    if (!hit) return null
    if (now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key)
      return null
    }
    // 命中即刷新插入顺序（Map 的迭代顺序 = 淘汰顺序）。
    cache.delete(key)
    cache.set(key, hit)
    return hit.items
  }

  function writeCache(key: string, items: InstantAnswerItem[]): void {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: now(), items })
  }

  /**
   * 打一次上游。任何异常（网络 / 超时 / 非 2xx / JSON 坏了）都返回 `[]`。
   * @param {string} query
   * @param {number} limit
   */
  async function fetchAnswer(query: string, limit: number): Promise<InstantAnswerItem[]> {
    if (!fetchImpl) return []
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    try {
      if (controller) timer = setTimeout(() => { try { controller.abort() } catch (_) {} }, timeoutMs)
      const res = await fetchImpl(`${ENDPOINT}${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      })
      if (!res) return []
      if (res.ok === false) {
        try { await res.body?.getReader().cancel() } catch (_) {}
        return []
      }
      const payload = await readJson(res)
      return parseInstantAnswer(payload, { limit }) as InstantAnswerItem[]
    } catch {
      // 超时 / 断网 / 上游 5xx 都在这里 —— 静默，地址栏不该因此报错。
      return []
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 查询即时答案。
   * @param {string} text
   * @param {{ limit?: number }} [options]
   */
  async function query(
    text: string,
    options?: { limit?: number }
  ): Promise<InstantAnswerItem[]> {
    const q = String(text == null ? '' : text).trim()
    const limit = Math.max(1, Math.min(10, Number(options && options.limit) || 3))
    // 太短的查询没有语义（"a" / "12"），不值得打上游。
    if (q.length < 2) return []

    const key = `${limit}:${q.toLowerCase()}`
    const cached = readCache(key)
    if (cached) return cached
    const running = inflight.get(key)
    if (running) return running

    const task = fetchAnswer(q, limit)
      .then((items) => {
        // 空结果也缓存：上游对生僻词就是没有答案，不必每次都重打。
        writeCache(key, items)
        return items
      })
      .finally(() => { inflight.delete(key) })
    inflight.set(key, task)
    return task
  }

  return { query }
}

module.exports = { createInstantAnswerService, INSTANT_ANSWER_ENDPOINT: ENDPOINT }
