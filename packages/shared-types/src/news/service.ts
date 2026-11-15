/**
 * 新闻取数服务（缓存 / 超时 / 降级）
 *
 * 一句话：**绝不空窗**。
 *
 * 降级链（按顺序尝试，先命中先返回）：
 *   1. 目标源的本地缓存（未过期）—— 命中即 0 请求，切回时立刻有内容
 *   2. 目标源真实请求
 *   3. 其余已注册源依次尝试
 *   4. 任意源的过期缓存（stale）
 *   5. 静态兜底源（curated）—— 离线也一定有条目
 *
 * 缓存落在 localStorage（按源分开存），TTL 15 分钟；面板与 NTP 都常驻，
 * 没有缓存的话每次打开都要打一次第三方接口，既慢又容易被限流。
 *
 * ⚠ 依赖 `localStorage`（浏览器全局）。因此本模块只在渲染进程使用：
 *   · NTP 页面（apps 层，浏览器上下文）
 *   · 面板渲染进程（ui 层）
 * 主进程不 import 本模块。
 */
import { getProvider, listProviders, type NewsProviderItem } from './registry.js'
// 「算不算普通网页」的唯一判据（新闻条目必须是可打开的网页地址）。
import { isHttpUrl } from '../url-protocols.js'

const CACHE_PREFIX = 'hira.news.v1.'
const TTL = 15 * 60 * 1000
const TIMEOUT = 7000
/** 每个源最多缓存多少条（缓存是"仓库"，展示条数由调用方决定） */
const CACHE_MAX = 40

export interface NewsItem {
  id: string
  title: string
  url: string
  hot?: string | number
  time?: number
  source?: string
}

export interface NewsLoadResult {
  items: NewsItem[]
  providerId: string
  providerName: string
  stale: boolean
  failed: boolean
}

interface NewsCache {
  ts: number
  items: NewsProviderItem[]
}

function cacheKey(id: string): string {
  return CACHE_PREFIX + id
}

function readCache(id: string): NewsCache | null {
  try {
    const raw = localStorage.getItem(cacheKey(id))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (!Number.isFinite(record.ts) || !Array.isArray(record.items) || !record.items.length) return null
    return { ts: Number(record.ts), items: record.items as NewsProviderItem[] }
  } catch (_) {
    return null
  }
}

function writeCache(id: string, items: NewsProviderItem[]): void {
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify({ ts: Date.now(), items: items.slice(0, CACHE_MAX) }))
  } catch (_) {
    /* 配额满：不缓存也能用，只是下次要重新请求 */
  }
}

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const onAbort = (): void => {
    try { controller.abort() } catch (_) {}
    finish(() => reject(new Error('aborted')))
  }
  let resolveTask: (value: T) => void = () => {}
  let rejectTask: (error: unknown) => void = () => {}
  const finish = (settle: () => void): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    settle()
  }
  const reject = (error: unknown): void => rejectTask(error)
  return new Promise<T>((resolve, reject) => {
    resolveTask = resolve
    rejectTask = reject
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      try { controller.abort() } catch (_) {}
      finish(() => reject(new Error('timeout')))
    }, ms)
    Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
  })
}

/** 归一化：丢掉没有标题/链接的脏项，补上 source，去重（按 url）。 */
function normalize(items: unknown, providerName: string): NewsItem[] {
  const out: NewsItem[] = []
  const seen = new Set<string>()
  if (!Array.isArray(items)) return out
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const title = String(item.title || '').trim()
    const url = String(item.url || '').trim()
    if (!title || !url) continue
    if (!isHttpUrl(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const time = Number(item.time)
    out.push({
      id: String(item.id || url),
      title,
      url,
      hot: item.hot === undefined || item.hot === null || item.hot === '' || (typeof item.hot !== 'string' && typeof item.hot !== 'number') ? undefined : item.hot,
      time: Number.isFinite(time) ? time : undefined,
      source: typeof item.source === 'string' && item.source ? item.source : providerName
    })
  }
  return out
}

/** 尝试顺序：目标源 → 其余源（curated 永远排在最后兜底）。 */
function buildChain(primaryId: string): string[] {
  const all = listProviders().map((p) => p.id)
  const chain: string[] = []
  if (primaryId && all.includes(primaryId)) chain.push(primaryId)
  for (const id of all) if (id !== primaryId) chain.push(id)
  return chain
}

/**
 * 取新闻。
 * @param {{ providerId?:string, limit?:number, force?:boolean, signal?:AbortSignal }} opts
 * @returns {Promise<{ items:NewsItem[], providerId:string, providerName:string, stale:boolean, failed:boolean }>}
 */
export async function loadNews(opts: { providerId?:string, limit?:number, force?:boolean, signal?:AbortSignal } = {}): Promise<NewsLoadResult> {
  const primaryId = opts.providerId || ''
  const limit = Math.max(1, opts.limit || 10)
  const force = !!opts.force
  const signal = opts.signal
  const chain = buildChain(primaryId)

  // ① 目标源的新鲜缓存
  if (!force && primaryId) {
    const cached = readCache(primaryId)
    if (cached && Date.now() - cached.ts < TTL) {
      const p = getProvider(primaryId)
      return {
        items: normalize(cached.items, p ? p.name : primaryId).slice(0, limit),
        providerId: primaryId,
        providerName: p ? p.name : primaryId,
        stale: false,
        failed: false
      }
    }
  }

  // ②③ 依次真实请求
  for (const id of chain) {
    if (signal && signal.aborted) break
    const provider = getProvider(id)
    if (!provider) continue
    try {
      const items = await withTimeout(
        (requestSignal) => Promise.resolve(provider.fetch({ limit: CACHE_MAX, signal: requestSignal })),
        TIMEOUT,
        signal
      )
      const clean = normalize(items, provider.name)
      if (!clean.length) continue
      writeCache(id, clean)
      return { items: clean.slice(0, limit), providerId: id, providerName: provider.name, stale: false, failed: false }
    } catch (_) {
      /* 单个源失败不影响整条链 */
    }
  }

  // ④ 任意源的过期缓存
  for (const id of chain) {
    const cached = readCache(id)
    if (!cached) continue
    const p = getProvider(id)
    const items = normalize(cached.items, p ? p.name : id)
    if (!items.length) continue
    return { items: items.slice(0, limit), providerId: id, providerName: p ? p.name : id, stale: true, failed: false }
  }

  // ⑤ 兜底：即使 signal 已中断，这里也不必再跑 —— 交由调用方丢弃结果
  return { items: [], providerId: '', providerName: '', stale: false, failed: true }
}
