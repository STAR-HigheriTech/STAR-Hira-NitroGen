import { errorMessage } from './types'
import type { ApplierDependencies, SettingsApplier } from './types'

// @ts-check
/**
 * settings/appliers/tabs.js — 「恢复上次会话」生效器 + 「跨窗口标签同步」生效器
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * `tabs.restore_session`（域默认 true）此前是一个**死键**：启动流程只认
 * `app.startup_mode`（域默认 'blank'），没有任何代码读它 —— 于是设置页出现两个
 * 互相矛盾的「真源」：用户打开「恢复上次会话」却什么也不会发生。
 *
 * 本 applier 把它变成 `app.startup_mode` 的**写入别名**（write-through）：
 * 用户切换 `tabs.restore_session` 时，同步把 `app.startup_mode` 写成
 * 'last_session' / 'blank'。从此只有 `app.startup_mode` 一个真源，两个入口都真实有效。
 *
 * ── 为什么必须忽略「首次全量应用」──────────────────────────────────
 * 启动时 settings/sync 会 applyAll 一次（把已持久化的值推给所有 applier）。
 * 域默认是 restore_session=true + startup_mode='blank'，两者本来就矛盾；
 * 若在首次应用时做写入，就会在用户没动过任何设置的情况下把启动行为从
 * 「空白页」改成「恢复上次会话」—— 那是**静默改变用户既有行为**。
 * 因此这里只在「值真的从上次看到的变了」时才写，且首次仅记录基线。
 *
 * 安全降级：settings 服务缺失 / 取不到值 / 写入失败时静默返回，绝不抛错。
 *
 * @param {{ settingsService?: any }} deps
 */
const { STARTUP_SETTING_KEYS } = require('@hira-ng/shared-types/src/startup.mjs')
const { TABS_SETTING_KEYS } = require('@hira-ng/shared-types/src/tabs-settings.mjs')

function createTabsRestoreSessionApplier(deps: ApplierDependencies = {}): SettingsApplier {
  /** 上一次看到的值；undefined 表示尚未建立基线（首次全量应用） */
  let lastSeen: unknown

  return {
    id: 'tabs-restore-session',
    keys: [TABS_SETTING_KEYS.restoreSession],
    apply({ settings }) {
      const svc = deps.settingsService || settings
      if (!svc || typeof svc.get !== 'function') return false

      const current = svc.get(TABS_SETTING_KEYS.restoreSession)
      // 首次全量应用：只建立基线，不写 —— 见文件头「为什么必须忽略首次全量应用」
      if (lastSeen === undefined) {
        lastSeen = current
        return true
      }
      if (current === lastSeen) return true
      lastSeen = current

      if (typeof svc.set !== 'function') return false
      try {
        if (current === true) {
          svc.set(STARTUP_SETTING_KEYS.mode, 'last_session')
        } else if (svc.get(STARTUP_SETTING_KEYS.mode) === 'last_session') {
          // 只在「当前确实是恢复会话」时才回退为空白页 —— 否则会把用户自己设的
          // 「主页 / 自定义网页」一起冲掉（那是另一个独立偏好）。
          svc.set(STARTUP_SETTING_KEYS.mode, 'blank')
        }
        return true
      } catch (e) {
        console.error('[settings] tabs.restore_session write-through failed:', errorMessage(e))
        return false
      }
    }
  }
}

/**
 * settings/appliers/tabs.js#createTabSyncApplier — 「跨窗口标签同步」的**关闭收尾**。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────
 * 开启是"下一次切窗即生效"（引擎每次获焦都现读设置），不需要任何动作；但**关闭**
 * 必须有人收尾 —— 否则各窗口里已经贴上的**截图占位会永远留在那里**（那是外壳 DOM，
 * 没有任何后续事件会去收它），用户看到的是"内容区卡着一张旧截图"。
 *
 * 因此这里只在 true → false 的那一次调用 `notifyDisabled()`：清掉所有窗口的占位并
 * 复位记账。首次全量应用（applyAll）只建立基线、不动作 —— 与上面那条 applier 同口径。
 *
 * 安全降级：引擎尚未创建（启动早期）/ 端口缺失 → 静默返回，绝不抛错。
 *
 * @param {{ getTabSync?: () => any }} deps
 */
function createTabSyncApplier(deps: ApplierDependencies = {}): SettingsApplier {
  /** 上一次看到的值；undefined = 尚未建立基线（首次全量应用）。 */
  let lastSeen: boolean | undefined

  return {
    id: 'tabs-sync-across-windows',
    keys: [TABS_SETTING_KEYS.syncAcrossWindows],
    apply({ settings }) {
      if (!settings || typeof settings.get !== 'function') return false
      const current = settings.get(TABS_SETTING_KEYS.syncAcrossWindows) === true
      if (lastSeen === undefined) {
        lastSeen = current
        return true
      }
      if (current === lastSeen) return true
      const was = lastSeen
      lastSeen = current
      // 只在"开着 → 关掉"时收尾；重新打开不需要动作（切窗自然生效）。
      if (was && !current) {
        const sync = typeof deps.getTabSync === 'function' ? deps.getTabSync() : null
        if (sync && typeof sync.notifyDisabled === 'function') {
          try { sync.notifyDisabled() } catch (_) {}
        }
      }
      return true
    }
  }
}

export { createTabsRestoreSessionApplier, createTabSyncApplier }
