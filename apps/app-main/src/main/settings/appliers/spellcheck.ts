import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'
import type { Session } from 'electron'

interface SpellcheckConfig { enabled: boolean; languages: string[] }

// @ts-check
/**
 * settings/appliers/spellcheck.js — 拼写检查生效器
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 * 把 `spellcheck.enabled` / `spellcheck.languages` 落到**会话**上：
 *   · `session.setSpellCheckerEnabled(bool)`      总开关
 *   · `session.setSpellCheckerLanguages(codes)`   词典语言
 *
 * 为什么是会话级而不是 webContents 级：
 *   `webPreferences.spellcheck` 只在**创建时**生效（标签页为 true，其余内部视图为
 *   false，见 infra-window/src/webPreferences.js）。用户运行中开关拼写检查时，
 *   不可能把所有标签页重建一遍 —— 会话级 API 正好是运行时可变的那个旋钮。
 *
 * ── 为什么语言码要按会话过滤 ──────────────────────────────────────
 *   `setSpellCheckerLanguages` 收到本构建不认识的码会**直接抛异常**。设置可能来自
 *   另一台机器/另一个 Electron 版本，故每次下发前都用该会话的
 *   `availableSpellCheckerLanguages` 过滤（见 shared-types/spellcheck.mjs）。
 *
 * ── 为什么空列表不下发 ────────────────────────────────────────────
 *   空数组 = 用户没选（跟随系统）。此时调用 `setSpellCheckerLanguages([])` 会把
 *   词典清空 —— 表现是"没开拼写检查了"。故空列表保持 Electron 默认，只动总开关。
 *
 * ── 新会话 ────────────────────────────────────────────────────────
 *   会话按 profile 懒创建（切 profile / 开无痕窗口）。钩子只挂一次，新会话创建时
 *   按**当前**配置补齐 —— 否则新 profile 的会话对这两个设置一无所知。
 *
 * 安全：不 require electron（会话由端口注入），任何失败只告警不抛。
 *
 * @param {object} deps
 * @param {() => Electron.Session[]} [deps.getSessions] 要下发的会话（当前 profile + 无痕）
 * @param {(fn: (session: Electron.Session) => void) => void} [deps.onSessionCreated]
 *   「新会话创建」订阅（APPS 侧包 `app.on('session-created')`）
 */

const {
  SPELLCHECK_SETTING_KEYS,
  spellcheckFromSettings,
  normalizeSpellcheckLanguages
} = require('@hira-ng/shared-types/src/spellcheck.mjs') as {
  SPELLCHECK_SETTING_KEYS: { enabled: string; languages: string }
  spellcheckFromSettings(get: (key: string) => unknown): SpellcheckConfig
  normalizeSpellcheckLanguages(selected: readonly string[], available: readonly string[]): string[]
}

function createSpellcheckApplier(deps: ApplierDependencies = {}): SettingsApplier {
  const getSessions = typeof deps.getSessions === 'function' ? deps.getSessions : () => []
  const onSessionCreated = typeof deps.onSessionCreated === 'function' ? deps.onSessionCreated : null

  /** 当前配置（新会话按它补齐；每次 apply 更新）。 */
  let current: SpellcheckConfig = { enabled: true, languages: [] }
  /** 上一次下发过的配置指纹（去重：没变就不重复设置）。 */
  let lastFingerprint: string | null = null
  let hookInstalled = false

  /** 对单个会话下发配置（绝不抛）。 */
  function applyTo(session: Session | null | undefined, config: SpellcheckConfig): void {
    if (!session) return
    if (typeof session.setSpellCheckerEnabled === 'function') {
      try {
        session.setSpellCheckerEnabled(config.enabled)
      } catch (e) {
        console.warn('[spellcheck] setSpellCheckerEnabled failed:', errorMessage(e))
      }
    }
    if (!config.languages.length) return
    if (typeof session.setSpellCheckerLanguages !== 'function') return
    let available: readonly string[] = []
    try {
      available = Array.isArray(session.availableSpellCheckerLanguages)
        ? session.availableSpellCheckerLanguages
        : []
    } catch (_) {
      available = []
    }
    const codes = normalizeSpellcheckLanguages(config.languages, available)
    if (!codes.length) return
    try {
      session.setSpellCheckerLanguages(codes)
    } catch (e) {
      console.warn('[spellcheck] setSpellCheckerLanguages failed:', errorMessage(e))
    }
  }

  return {
    id: 'spellcheck',
    keys: [SPELLCHECK_SETTING_KEYS.enabled, SPELLCHECK_SETTING_KEYS.languages],
    apply({ settings, force }) {
      if (!settings || typeof settings.get !== 'function') return false
      const config = spellcheckFromSettings((key) => settings.get(key))
      current = config

      // 「将来创建的会话」：钩子只挂一次（挂失败允许下次重试）。
      if (!hookInstalled && onSessionCreated) {
        try {
          onSessionCreated((session) => applyTo(session, current))
          hookInstalled = true
        } catch (e) {
          console.warn('[spellcheck] session-created hook failed:', errorMessage(e))
        }
      }

      const fingerprint = JSON.stringify(config)
      // `force` = 切 profile 后的强制重下：新 profile 的会话一次都没配过。
      if (!force && fingerprint === lastFingerprint) return true
      lastFingerprint = fingerprint
      for (const session of getSessions()) applyTo(session, config)
      return true
    }
  }
}

export { createSpellcheckApplier }
