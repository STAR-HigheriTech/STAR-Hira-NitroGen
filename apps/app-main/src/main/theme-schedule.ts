/**
 * theme-schedule.js —— 主题调度（**只有这一处**决定"现在该用哪个主题"）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 四档，全部收敛到 targetId() 一个出口
 * ══════════════════════════════════════════════════════════════════════
 *   none    不调度 —— 用户手选的主题说了算（默认）。
 *   system  跟随系统外观：系统转深色就用 `schedule.dark`，否则 `schedule.light`。
 *   night   白天/夜间两档，夜间窗口 **21:00–06:00**（沿用旧 Hira `isNightTime` 的取值：
 *           那条经验是实测出来的，用户对"什么时候算晚上"的心理预期就落在那两小时上）。
 *   manual  任意条 `{ theme, from, to }` 时段表（Vivaldi 的"手动定时"）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条必须写死的规则
 * ══════════════════════════════════════════════════════════════════════
 *  1. **用户手选即退出调度**：一旦用户在界面上点了某个主题，调度会自动切回 `none`。
 *     否则"我明明选了浅色，过十分钟它自己变回去了"—— 这是所有自动换肤功能最常见的投诉。
 *     实现上由 `themeService.setActive(id, { reason })` 区分：`reason==='schedule'`
 *     才不改调度（本模块只发这个 reason）。
 *  2. **不动就什么都不做**：tick 只比较"目标 id 与当前 id"，两者相同直接返回 ——
 *     10 秒一次的空转绝不能引起任何 IPC 或样式重算。
 *
 * 为什么是轮询而不是精确定时到点：夜间/手动档的边界是"小时"，分钟级轮询的漂移
 * 对观感毫无影响，而等到点再算要多维护一套定时器生命周期（休眠唤醒、系统时钟跳变
 * 都会让"精确定时"变成"永不触发"）。旧 Hira 同样是 10 秒轮询 —— 照搬这条。
 */

const {
  THEME_SETTING_KEYS,
  normalizeThemeSchedule,
  isNightNow
} = require('@hira-ng/shared-types/src/theme.mjs')

interface ThemeSchedulerDeps {
  settings?: { get: (key: string) => unknown } | null
  themeService?: { getActiveId: () => string; setActive: (id: string, options: object) => Promise<unknown> } | null
  nativeTheme?: { shouldUseDarkColors?: boolean } | null
  getProfileId?: () => string
  runWithProfile?: <T>(profileId: string, task: () => T) => T
  intervalMs?: number
  logger?: { warn?: (...args: unknown[]) => void }
}

/**
 * @param {{
 *   settings?: { get: Function },
 *   themeService?: { getActiveId: Function, setActive: Function },
 *   nativeTheme?: { shouldUseDarkColors?: boolean },
 *   intervalMs?: number,
 *   logger?: { warn?: Function }
 * }} [deps]
 */
function createThemeScheduler(deps: ThemeSchedulerDeps = {}) {
  const settings = deps.settings || null
  const themeService = deps.themeService || null
  const nativeTheme = deps.nativeTheme || null
  const getProfileId = deps.getProfileId
  const runWithProfile = deps.runWithProfile
  const logger = deps.logger || console
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : 10000

  let timer: ReturnType<typeof setInterval> | null = null

  function runForActiveProfile<T>(task: () => T): T {
    let profileId = ''
    try { profileId = typeof getProfileId === 'function' ? String(getProfileId() || '') : '' } catch (_) {}
    return profileId && typeof runWithProfile === 'function'
      ? runWithProfile(profileId, task)
      : task()
  }

  function schedule() {
    return runForActiveProfile(() => {
      if (!settings) return normalizeThemeSchedule(null)
      return normalizeThemeSchedule(settings.get(THEME_SETTING_KEYS.schedule))
    })
  }

  /**
   * 此刻应当使用的主题 id；`''` 表示"不调度，维持用户选择"。
   * @param {{ date?: Date }} [opts] 注入时间只服务于可测性（默认取当前时刻）
   */
  function targetId(opts: { date?: Date } = {}): string {
    const s = schedule()
    if (s.mode === 'none') return ''
    if (s.mode === 'system') {
      return nativeTheme && nativeTheme.shouldUseDarkColors ? s.dark : s.light
    }
    return isNightNow(s, opts.date || new Date()) ? s.dark : s.light
  }

  /** 判定一次并（必要时）落主题。幂等：目标与当前相同即静默返回。 */
  async function tick(opts: { date?: Date } = {}): Promise<{ applied: boolean; reason?: string; id?: string }> {
    try {
      return await runForActiveProfile(async () => {
        const next = targetId(opts)
        if (!next) return { applied: false, reason: 'none' }
        if (!themeService || typeof themeService.getActiveId !== 'function') return { applied: false, reason: 'no-service' }
        if (themeService.getActiveId() === next) return { applied: false, reason: 'unchanged' }
        await themeService.setActive(next, { reason: 'schedule' })
        return { applied: true, id: next }
      })
    } catch (error) {
      logger.warn?.('[theme-schedule] 应用调度主题失败：', error instanceof Error ? error.message : error)
      return { applied: false, reason: 'error' }
    }
  }

  return {
    start() {
      if (timer) return
      // 先立即判一次：启动时如果配置是"跟随系统/夜间"，不该等第一个 tick 才生效。
      void tick()
      timer = setInterval(() => { void tick() }, intervalMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    /** 系统外观变化（`nativeTheme.updated`）时立即重判，不等下一个 tick。 */
    refresh() {
      return tick()
    },
    targetId,
    schedule
  }
}

module.exports = { createThemeScheduler }
