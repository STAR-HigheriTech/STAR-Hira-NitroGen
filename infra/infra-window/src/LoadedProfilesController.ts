/**
 * LoadedProfilesController —— 按 key 的「单飞（single-flight）」异步加载器。
 *
 * 对齐 HiraRT `LoadedProfilesController.loadingProfilePromises`：
 * 同一个 key 在首次加载未完成前的所有并发请求共享同一个 Promise，
 * 从而杜绝「ECE（扩展系统）/ 会话」被重复实例化 —— 重复实例化会抛
 * "Session already in use" / 扩展后台页重复注册等致命错误。
 *
 * 本类刻意与 profile 领域无关：只认 key → 工厂。APPS 层用它包住
 * `getOrCreateExtensionService(profileId)` 这类"昂贵且必须唯一"的构造。
 */
export interface LoadedProfilesController {
  load<T>(key: string, factory: () => T | Promise<T>): Promise<T>
  get<T>(key: string): T | null
  has(key: string): boolean
  clear(key: string): void
  list(): string[]
}

export function createLoadedProfilesController(): LoadedProfilesController {
  const _promises = new Map<string, Promise<unknown>>()
  const _values = new Map<string, unknown>()
  const _revisions = new Map<string, number>()

  /**
   * 加载 key：已加载则直接复用；进行中则复用同一 Promise；否则调用 factory。
   * factory 失败时清理缓存，允许下次重试（避免永久毒化）。
   * @param {string} key
   * @param {() => Promise<any>} factory
   * @returns {Promise<any>}
   */
  function load<T>(key: string, factory: () => T | Promise<T>): Promise<T> {
    const k = String(key)
    const existing = _promises.get(k)
    if (existing) return existing as Promise<T>
    if (typeof factory !== 'function') {
      return Promise.reject(new Error(`LoadedProfilesController.load: factory 必填 (${k})`))
    }
    const revision = _revisions.get(k) || 0
    const p = Promise.resolve()
      .then(factory)
      .then((value) => {
        if ((_revisions.get(k) || 0) === revision) _values.set(k, value)
        return value
      })
      .catch((err) => {
        // 失败不缓存：下次调用可重试
        if ((_revisions.get(k) || 0) === revision) {
          _promises.delete(k)
          _values.delete(k)
        }
        throw err
      })
    _promises.set(k, p)
    return p
  }

  /** 同步取已解析结果（未完成/失败 → null） */
  function get<T>(key: string): T | null {
    return (_values.get(String(key)) as T | undefined) ?? null
  }

  /** 是否已有进行中或已完成的加载 */
  function has(key: string): boolean {
    return _promises.has(String(key))
  }

  /** 清除某 key 的缓存（失败恢复 / 显式重建） */
  function clear(key: string): void {
    const k = String(key)
    const pending = _promises.get(k)
    _promises.delete(k)
    _values.delete(k)
    if (!pending) {
      _revisions.delete(k)
      return
    }
    _revisions.set(k, (_revisions.get(k) || 0) + 1)
    pending.finally(() => {
      if (!_promises.has(k) && !_values.has(k)) _revisions.delete(k)
    }).catch(() => {})
  }

  /** 已加载完成的 key 列表 */
  function list(): string[] {
    return Array.from(_values.keys())
  }

  return { load, get, has, clear, list }
}
