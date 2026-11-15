import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/downloads.js — 下载相关生效器
 *
 * 下载限速：download-manager 自带 setRateLimit，这里只负责把设置推给它。
 * 其余下载相关设置（询问位置 / 默认目录 / 完成通知 / 自动打开）由 download-manager
 * 在每次下载时实时读取，改了下一次下载即生效，无需 applier。
 *
 * @param {{ getDownloadController?: () => any }} deps
 */
// 限速键名的真源（域层默认值 / 设置页 / 下载运行时共用一份）。
const { DOWNLOAD_SETTING_KEYS } = require('@hira-ng/shared-types/src/downloads.mjs')

function createDownloadRateApplier(deps: ApplierDependencies = {}): SettingsApplier {
  return {
    id: 'downloads-rate-limit',
    keys: [DOWNLOAD_SETTING_KEYS.rateLimit],
    apply({ value, settings }) {
      const ctrl = typeof deps.getDownloadController === 'function' ? deps.getDownloadController() : null
      if (!ctrl || typeof ctrl.setRateLimit !== 'function') return
      const v = value === undefined ? settings.get(DOWNLOAD_SETTING_KEYS.rateLimit) : value
      try { ctrl.setRateLimit(Number(v) || 0) } catch (_) {}
    }
  }
}

export { createDownloadRateApplier }
