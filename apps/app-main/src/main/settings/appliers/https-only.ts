import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { WebContents } from 'electron'

// @ts-check
/**
 * settings/appliers/https-only.js — 「仅 HTTPS」（I2）生效器
 *
 * ── 为什么走导航层而不是 webRequest ────────────────────────────────
 * 见 `shared-types/https-only.mjs` 文件头的两条硬理由（WebRequest 每事件只留一个监听器、
 * 且会让扩展的 `chrome.webRequest` 全部失效）。这里只挂
 * `will-navigate` / `will-redirect`，**完全不碰 webRequest**。
 *
 * ── 为什么监听器不随开关卸载 ──────────────────────────────────────
 * 开关状态在回调里**现读**（`readEnabled`），于是：
 *   · 用户打开开关 → 下一次导航立刻生效（不需要重挂）；
 *   · 用户关掉开关 → 回调直接放行（不需要卸载，也就没有"卸载漏了导致关不掉"）。
 * 少一处状态同步 = 少一类"开关和行为对不上"的缺陷。
 *
 * ── 防死循环 ──────────────────────────────────────────────────────
 * 升级到 https 后，服务器可能又 301 回 http（站点没配好 / 只在部分路径支持 https）。
 * 不做去重就会"http → https → 301 回 http → 再升级 → …"无限重载。
 * 故按 webContents 记账：**同一个目标地址只升级一次**，第二次放行让它照原样走。
 *
 * 安全：不 require electron（webContents 由端口注入），任何失败只告警不抛。
 *
 * @param {object} deps
 * @param {() => Electron.WebContents[]} [deps.getWebContents] 取全部已存在的 webContents
 * @param {(fn: (wc: Electron.WebContents) => void) => void} [deps.onWebContentsCreated]
 *   「新 webContents 创建」订阅（APPS 侧包 `app.on('web-contents-created')`）
 */

const { HTTPS_ONLY_SETTING_KEY, httpsUpgradeOf } = require('@hira-ng/shared-types/src/https-only.mjs')

function createHttpsOnlyApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const getWebContents = typeof deps.getWebContents === 'function' ? deps.getWebContents : () => []
  const onWebContentsCreated = typeof deps.onWebContentsCreated === 'function' ? deps.onWebContentsCreated : null

  /** 开关状态由 apply 写入、导航回调现读（见文件头「为什么监听器不随开关卸载」）。 */
  let readEnabled = () => false
  /** 已挂过监听的 webContents（幂等；WeakSet 随对象回收，不留幽灵标记）。 */
  const hookedWc = new WeakSet()
  /** wc → 已尝试升级过的目标地址集合（防死循环，见文件头）。 */
  const attempted = new WeakMap<WebContents, Set<string>>()
  let hookInstalled = false

  function hookWebContents(wc: WebContents | null | undefined): void {
    if (!wc || typeof wc.on !== 'function') return
    if (hookedWc.has(wc)) return
    hookedWc.add(wc)

    const onNavigate = (event: { preventDefault(): void }, url: string): void => {
      if (!readEnabled()) return
      const next = httpsUpgradeOf(url)
      if (!next) return
      let seen = attempted.get(wc)
      if (!seen) {
        seen = new Set()
        attempted.set(wc, seen)
      }
      // 同一目标只升一次：第二次（服务器把它跳回 http 了）放行，否则无限重载。
      if (seen.has(next)) return
      seen.add(next)
      try { event.preventDefault() } catch (_) {}
      try { void wc.loadURL(next).catch((e: unknown) => console.warn('[https-only] upgrade load failed:', errorMessage(e))) } catch (e) {
        console.warn('[https-only] upgrade navigation failed:', errorMessage(e))
      }
    }

    try {
      wc.on('will-navigate', onNavigate)
      // 服务器 301/302 到 http 也要拦（只挂 will-navigate 会漏掉这一半）。
      wc.on('will-redirect', onNavigate)
    } catch (e) {
      console.warn('[https-only] hook failed:', errorMessage(e))
    }
  }

  return {
    id: 'https-only',
    keys: [HTTPS_ONLY_SETTING_KEY],
    apply({ settings }) {
      if (settings && typeof settings.get === 'function') {
        readEnabled = () => {
          try { return settings.get(HTTPS_ONLY_SETTING_KEY) === true } catch (_) { return false }
        }
      }
      // 「将来创建的」webContents：钩子只挂一次（挂失败允许下次重试）。
      if (!hookInstalled && onWebContentsCreated) {
        try {
          onWebContentsCreated(hookWebContents)
          hookInstalled = true
        } catch (e) {
          console.warn('[https-only] web-contents-created hook failed:', errorMessage(e))
        }
      }
      // 「已经存在的」webContents：启动时已经开着开关的话，不补挂就会漏掉它们。
      for (const wc of getWebContents()) hookWebContents(wc)
      return true
    }
  }
}

export { createHttpsOnlyApplier }
