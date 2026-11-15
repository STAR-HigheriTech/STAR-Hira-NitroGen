/**
 * 设置动作的内部执行面。
 *
 * 设置页的 `type: "action"` 字段只声明 `runRoute`；IPC 与 AI 都必须能执行同一条
 * 路由，但不能各自复制业务实现。这里只保存路由到实现的映射，不感知具体动作。
 */

export type SettingsActionHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** 设置页 action 字段与内部执行面的稳定路由。 */
export const SETTINGS_ACTION_ROUTES = Object.freeze({
  clearSearchHistory: 'search:clear-history',
  resetOnboarding: 'onboarding:reset',
  setDefaultBrowser: 'app:set-default-browser',
  exportProfile: 'app:export-profile',
  importProfile: 'app:import-profile'
})

export interface SettingsActionPort {
  has(route: string): boolean
  list(): string[]
  register(route: string, handler: SettingsActionHandler): void
  run(route: string, args?: Record<string, unknown>): Promise<unknown>
}

export function createSettingsActionPort(handlers: Record<string, SettingsActionHandler>): SettingsActionPort {
  const routes = new Map(Object.entries(handlers))

  return {
    has(route) {
      return routes.has(String(route || ''))
    },
    list() {
      return [...routes.keys()]
    },
    register(route, handler) {
      const key = String(route || '').trim()
      if (!key) throw new Error('设置动作路由不能为空')
      if (typeof handler !== 'function') throw new Error(`设置动作 ${key} 缺少执行函数`)
      routes.set(key, handler)
    },
    async run(route, args = {}) {
      const key = String(route || '').trim()
      const handler = routes.get(key)
      if (!handler) throw new Error(`设置动作尚未注册执行器：${key || '(空路由)'}`)
      return handler(args && typeof args === 'object' ? args : {})
    }
  }
}
