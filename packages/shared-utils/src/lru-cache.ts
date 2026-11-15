/**
 * 有界 LRU 容器 —— 同时按「条数」和「总权重（字节）」封顶。
 *
 * 为什么要有它：主进程里 favicon 代理、译文缓存、缩略图缓存都在重复
 * 「Map + 命中重插 + 淘汰最旧」这三行；其中 favicon 还需要按字节封顶
 * （只按条数封顶时，400 条 × 最大 512KB = 最坏 200MB 常驻）。规则写两遍
 * 迟早分叉，这里收口成唯一实现，后续任何新缓存直接组合它即可。
 *
 * 语义与 Map 对齐：
 *   · get 命中会刷新插入序（Map 的迭代顺序即 LRU 顺序）；
 *   · set 覆盖同一 key 时先扣旧权重再按新权重计入；
 *   · 单条权重超过 maxWeight 时**不入池**（否则会为一条挤空整池），返回 false；
 *   · 任何写入后都从最旧开始淘汰，直到同时满足 maxEntries / maxWeight。
 *
 * @param {{
 *   maxEntries?: number,
 *   maxWeight?: number,
 *   weigh?: (value: T) => number
 * }} [options]
 */
export interface LruCacheOptions<T> {
  maxEntries?: number
  maxWeight?: number
  weigh?: (value: T) => number
}
export interface LruCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): boolean
  delete(key: string): boolean
  has(key: string): boolean
  clear(): void
  readonly size: number
  readonly weight: number
}

function createLruCache<T = unknown>(options: LruCacheOptions<T> = {}): LruCache<T> {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries as number) : Infinity
  const maxWeight = Number.isFinite(options.maxWeight) ? Math.max(0, options.maxWeight as number) : Infinity
  const weigh: (value: T) => number = typeof options.weigh === 'function' ? options.weigh : () => 1

  const store = new Map<string, { value: T; weight: number }>()
  let weight = 0

  function remove(key: string): boolean {
    if (!store.has(key)) return false
    const entry = store.get(key)
    if (!entry) return false
    store.delete(key)
    weight -= entry.weight
    return true
  }

  function trim() {
    while (store.size > maxEntries || weight > maxWeight) {
      const oldest = store.keys().next()
      if (oldest.done) break
      remove(oldest.value)
    }
  }

  return {
    get(key: string) {
      const entry = store.get(key)
      if (entry === undefined) return undefined
      store.delete(key)
      store.set(key, entry)
      return entry.value
    },
    set(key: string, value: T) {
      const raw = Number(weigh(value))
      const nextWeight = Number.isFinite(raw) && raw > 0 ? raw : 0
      remove(key)
      if (nextWeight > maxWeight) return false
      store.set(key, { value, weight: nextWeight })
      weight += nextWeight
      trim()
      return true
    },
    delete: remove,
    has(key: string) {
      return store.has(key)
    },
    clear() {
      store.clear()
      weight = 0
    },
    get size() {
      return store.size
    },
    get weight() {
      return weight
    }
  }
}

export { createLruCache }
export default { createLruCache }
