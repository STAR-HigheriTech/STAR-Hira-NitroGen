/**
 * 将“构造期绑定 profile”的域服务包装为按当前 profile 路由的代理。
 * 域层仍保持一个实例服务一个 profile，环境解析留在 APPS。
 */
function createPerProfileServiceProxy<T extends object>(
  factory: (profileId: string) => T,
  getCurrentProfileId: () => string
): T {
  const cache = new Map<string, T>()
  const resolve = (profileId: string): T => {
    const id = String(profileId || 'default')
    let service = cache.get(id)
    if (!service) {
      service = factory(id)
      cache.set(id, service)
    }
    return service
  }

  return new Proxy({} as T, {
    get(_target, property) {
      const service = resolve(getCurrentProfileId())
      const value = (service as Record<PropertyKey, unknown>)[property]
      return typeof value === 'function' ? value.bind(service) : value
    }
  })
}

module.exports = { createPerProfileServiceProxy }
