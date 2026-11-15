import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/blocking.js — 内容过滤生效器（拦截广告 / 追踪器）
 *
 * 把「隐私与安全」分区里的两把开关，推到扩展系统的内置广告拦截能力上。
 *
 * 关键：两把开关**不各自**对应一个布尔，而是收敛成一个有序级别
 * （`off` / `ads` / `ads+tracking`）。原因：Ghostery 只提供两份预置列表
 * （仅广告 / 广告+追踪，后者是超集），没有「只拦追踪」的列表；如果这里各写一套
 * 组合规则，就会和 infra 的重建逻辑、UI 的展示规则三处发散。
 * 换算规则与枚举的唯一真源在 `packages/shared-types/src/adblocker.mjs`。
 *
 * @param {{ getExtensionService?: () => any }} deps
 */
const { adblockerLevelFromSettings } = require('@hira-ng/shared-types/src/adblocker.mjs')
const { PRIVACY_SETTING_KEYS } = require('@hira-ng/shared-types/src/privacy-settings.mjs')

function createContentBlockingApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'privacy-content-blocking',
    keys: [PRIVACY_SETTING_KEYS.blockAds, PRIVACY_SETTING_KEYS.blockTrackers],
    apply({ settings }) {
      const ext = typeof deps.getExtensionService === 'function' ? deps.getExtensionService() : null
      if (!ext || typeof ext.setAdblockerLevel !== 'function') return false
      const level = adblockerLevelFromSettings(
        settings.get(PRIVACY_SETTING_KEYS.blockAds),
        settings.get(PRIVACY_SETTING_KEYS.blockTrackers)
      )
      try { ext.setAdblockerLevel(level) } catch (_) {}
      return true
    }
  }
}

export { createContentBlockingApplier }
