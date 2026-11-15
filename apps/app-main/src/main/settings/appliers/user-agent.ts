import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { Session } from 'electron'

// @ts-check
/**
 * settings/appliers/user-agent.js — 浏览器标识（UA）生效器
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * `network.user_agent_preset` / `network.user_agent_custom` → 算出最终 UA →
 * 对该 profile 的会话 `session.setUserAgent(ua, acceptLanguages)`（语言列表与 UA 同批下发）。
 *
 * ⚠ L2（PART16 §5 步骤 5）：UA 是**按 profile**的（键在各自快照里），因此
 *   **不再**写全局兜底 `app.userAgentFallback` —— 那是"所有 profile 共用一份 UA"，
 *   正好是物理独立要消除的。全局兜底由启动期 `applySpoofedUserAgent` 设成**中性默认值**
 *   （新会话在被本 applier 覆盖之前不会自称某个用户选的浏览器）。
 *   会话清单由 APPS 注入（只给"当前 profile 的会话 + 无痕会话"）。
 *
 * 「默认」预设（空串）时回落到**内置默认 UA**：那是 `user-agent.ts#buildSpoofedUserAgent`
 * 清洗过的标准 Chrome UA。为什么不让 applier 自己再拼一遍：清洗逻辑（去 Electron token、
 * 保留平台段）只有一处真源，重复实现必然漂移。故由 APPS 侧把它算好、经端口注入。
 *
 * 安全：不 require electron（会话由端口注入），失败只告警不抛。
 *
 * @param {object} deps
 * @param {() => string} deps.getDefaultUserAgent 内置默认 UA（清洗后的标准 Chrome UA）
 * @param {() => string} [deps.getAcceptLanguages] Accept-Language（语言列表，不含 q 值）
 * @param {() => Electron.Session[]} [deps.getSessions] 要下发 UA 的会话（当前 profile + 无痕）
 * @param {() => string} [deps.getChromeVersion] Chromium 完整版本（预设模板的 {{chrome}} 用）
 */

const { USER_AGENT_SETTING_KEYS, userAgentFromSettings } = require('@hira-ng/shared-types/src/user-agent.mjs') as {
  USER_AGENT_SETTING_KEYS: { preset: string; custom: string }
  userAgentFromSettings(get: (key: string) => unknown, chromeVersion: string): string
}

function createUserAgentApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const getDefaultUserAgent = typeof deps.getDefaultUserAgent === 'function' ? deps.getDefaultUserAgent : () => ''
  const getSessions = typeof deps.getSessions === 'function' ? deps.getSessions : () => []
  const getAcceptLanguages = typeof deps.getAcceptLanguages === 'function' ? deps.getAcceptLanguages : () => ''
  const getChromeVersion = typeof deps.getChromeVersion === 'function' ? deps.getChromeVersion : null

  /** 上一次下发过的 UA + 语言签名（相同就不重复设置 —— setUserAgent 会影响进行中的请求头）。 */
  let lastApplied: string | null = null

  function chromeVersion() {
    if (getChromeVersion) {
      try {
        const v = String(getChromeVersion() || '')
        if (v) return v
      } catch (_) { /* 落到下面的运行时默认 */ }
    }
    // 端口缺省时的默认值：Node 的 `process.versions.chrome`。
    // 本模块不 require electron，但 `process` 是运行时全局 —— 拿它当默认值不引入任何依赖。
    try {
      return String((typeof process !== 'undefined' && process.versions && process.versions.chrome) || '')
    } catch (_) {
      return ''
    }
  }

  /** 对单个会话设置 UA + Accept-Language（绝不抛）。 */
  function applyTo(session: Session | null | undefined, ua: string, acceptLanguages: string): void {
    if (!session || typeof session.setUserAgent !== 'function') return
    try {
      // 第二个参数交给 Chromium 原生处理（零逐请求开销），它会把列表补成标准 q 值头。
      if (acceptLanguages) session.setUserAgent(ua, acceptLanguages)
      else session.setUserAgent(ua)
    } catch (e) {
      console.warn('[user-agent] setUserAgent failed:', errorMessage(e))
    }
  }

  return {
    id: 'network-user-agent',
    keys: [USER_AGENT_SETTING_KEYS.preset, USER_AGENT_SETTING_KEYS.custom],
    apply({ settings, force }) {
      if (!settings || typeof settings.get !== 'function') return false
      const picked = userAgentFromSettings((key) => settings.get(key), chromeVersion())
      // 空串 = 「默认」预设（或自定义被清空）→ 用内置默认 UA。
      const ua = picked || getDefaultUserAgent()
      if (!ua) return true
      const acceptLanguages = getAcceptLanguages()
      // `force` = 切 profile 后的强制重下：新 profile 的会话一次都没设过，
      // 即便 UA 与上一个 profile 相同也不能被去重跳过。
      const signature = `${ua}|${acceptLanguages}`
      if (!force && signature === lastApplied) return true
      lastApplied = signature
      for (const session of getSessions()) applyTo(session, ua, acceptLanguages)
      return true
    }
  }
}

export { createUserAgentApplier }
