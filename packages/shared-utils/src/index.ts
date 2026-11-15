import path from 'node:path'
import * as crashInjection from './crash-injection'
import * as fts from './fts'
import * as historyUrl from './history-url'
import * as lruCache from './lru-cache'

interface ElectronAppLike { getAppPath(): string }

/**
 * 获取应用根目录。
 *
 * 统一处理开发环境与打包环境：
 *   - 开发: app.getAppPath() 指向项目根
 *   - 打包: app.getAppPath() 指向 out/main，需回退两级
 *
 * @param {import('electron').App} [app] - Electron app 实例。不传则从 electron 懒加载。
 * @returns {string} 应用根目录的绝对路径
 */
export function getAppRoot(app?: ElectronAppLike): string {
  const env = process.env.HIRA_APP_ROOT
  if (env) return env

  // Outside Electron, requiring the electron package may download a binary.
  if (!app && typeof process.versions.electron !== 'string') return process.cwd()

  let appInstance = app
  if (!appInstance) {
    try {
      appInstance = (require('electron') as { app?: ElectronAppLike }).app
    } catch (_) {
      return process.cwd()
    }
  }

  if (appInstance && typeof appInstance.getAppPath === 'function') {
    const p = appInstance.getAppPath()
    const norm = p.replace(/\\/g, '/')
    if (norm.endsWith('/out/main')) return path.resolve(p, '..', '..')
    return p
  }

  return process.cwd()
}

/**
 * 生成带前缀的唯一 ID。
 * 格式: {prefix}_{timestamp}_{random}
 * @param {string} [prefix='id']
 * @returns {string}
 */
export function generateId(prefix: string = 'id'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 规范化域名：去除 scheme、路径，保留 host[:port]
 * @param {string} url
 * @returns {string}
 */
export function normalizeDomain(url: unknown): string {
  if (!url) return ''
  try {
    const value = String(url)
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
    const parsed = new URL(withScheme)
    return parsed.hostname + (parsed.port ? `:${parsed.port}` : '')
  } catch (_) {
    return String(url).toLowerCase()
  }
}

export * from './fts'
export * from './crash-injection'
export * from './history-url'
export * from './lru-cache'

export default {
  getAppRoot,
  generateId,
  normalizeDomain,
  ...fts,
  ...crashInjection,
  ...historyUrl,
  ...lruCache
}
