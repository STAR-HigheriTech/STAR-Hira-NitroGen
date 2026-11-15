/**
 * main/onboarding/index.ts — OOBE 首次启动引导的**唯一状态与窗口编排**
 *
 * 设计对齐 RT 的 `main/app/onboarding.ts` + `windows-controller/types/onboarding.ts`，
 * 但依赖全部换成 NG 既有机制（见 docs-ng/OOBE引导窗口设计.md）：
 *
 *   · 窗口：`openSubWindowByType(WINDOW_TYPES.ONBOARDING)` —— 不新造窗口工厂；
 *   · 持久化：设置键 `app.onboarding_version`（全局作用域）—— 不新造存储；
 *   · 页面：`hira://onboarding`（`pages/onboarding/` 磁盘扫描自动注册）。
 *
 * ── 为什么存「版本号」而不是布尔 ─────────────────────────────────
 * 布尔只能表达「引导过 / 没引导过」。将来引导流程改版（多一步权限说明之类），
 * 想让老用户再看一遍，就必须再加一个键做约定。存版本号则只需把
 * `ONBOARDING_VERSION` 提到 `'v2'` —— 老用户的值仍是 `'v1'`，判等自然不成立。
 *
 * ── 三条不可交换的顺序 ──────────────────────────────────────────
 *   1. **先 mount 主窗，再销毁引导窗**。反过来的话，非 macOS 下
 *      `window-all-closed` 会立刻 `app.quit()`，用户看到的是「点完成后应用直接退了」。
 *   2. **关窗 = 跳过 = 完成**。否则点 `×` 会留下「引导窗没了、主窗没 mount」的僵尸态。
 *   3. **退出时放行 close**。`before-quit` 期间若仍 preventDefault，应用退不掉。
 *      由 `markQuitting()` 置位，见 main.js 的退出状态机。
 *
 * ── 导入不是控制器的职责 ────────────────────────────────────────
 * 「导入旧浏览器的数据」是引导流程里的一屏（pages/onboarding/stages/migrate），
 * 和其它步骤一样在同一个引导窗里推进。控制器只认「一个窗口、一次完成」：
 * 开窗 → （页面自己走完所有步骤）→ complete() 收尾。
 * 想加/挪一步就去改 stages/index.js 的 ORDER 表，本文件不参与。
 *
 * 本模块不 require electron：窗口对象只通过注入的端口拿（可单测、可替换）。
 */

// 引导版本号与设置键名的真源（domain-settings 默认值 / settings-scope 共用同一份）。
import {
  ONBOARDING_VERSION,
  ONBOARDING_SETTING_KEY
} from '@hira-ng/shared-types/src/onboarding.mjs'

interface OnboardingSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface OnboardingWindow {
  __hiraOnboardingWired?: boolean
  isDestroyed(): boolean
  show(): void
  focus(): void
  center(): void
  destroy(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
}

interface OnboardingOpenResult { ok?: boolean; error?: unknown }

export interface OnboardingPorts {
  settings?: OnboardingSettingsPort | null
  openWindow(type: string, payload: null, parentRuntime: null): OnboardingOpenResult
  getWindow(type: string): OnboardingWindow | null | undefined
  windowTypes: { ONBOARDING: string }
  mountMainShell(): Promise<void> | void
}

/**
 * @param {object} ports
 * @param {{ get:Function, set:Function }} ports.settings 设置服务（get/set 端口）
 * @param {Function} ports.openWindow `openSubWindowByType(type, payload, parentRuntime)`
 * @param {Function} ports.getWindow `(type) => BrowserWindow|null`（已 GC 销毁项）
 * @param {object} ports.windowTypes `WINDOW_TYPES`
 * @param {Function} ports.mountMainShell `() => Promise<void>`（幂等）
 */
export function createOnboardingController(ports: OnboardingPorts): OnboardingController {
  const { settings, openWindow, getWindow, windowTypes, mountMainShell } = ports

  /** 完成流程进行中：close 事件必须放行（否则 destroy 会被自己拦下）。 */
  let finishing = false
  /** 开窗进行中：防重入（快速双击「重新运行引导」）。 */
  let opening = false
  /** 应用正在退出：close 一律放行，不再「关窗即完成」。 */
  let quitting = false

  function readVersion(): string {
    if (!settings || typeof settings.get !== 'function') return ''
    try {
      const v = settings.get(ONBOARDING_SETTING_KEY)
      return typeof v === 'string' ? v : ''
    } catch (_) {
      // 设置层异常时按「未完成」处理：宁可多引导一次，也不要把用户挡在门外。
      return ''
    }
  }

  function writeVersion(version: string): void {
    if (!settings || typeof settings.set !== 'function') return
    try {
      settings.set(ONBOARDING_SETTING_KEY, version)
    } catch (e) {
      console.error('[onboarding] 写入引导版本失败:', errorMessage(e))
    }
  }

  function windowOf(): OnboardingWindow | null {
    if (typeof getWindow !== 'function') return null
    try {
      const w = getWindow(windowTypes.ONBOARDING)
      if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return null
      return w
    } catch (_) {
      return null
    }
  }

  function needsOnboarding(): boolean {
    return readVersion() !== ONBOARDING_VERSION
  }

  function getState(): Record<string, unknown> {
    return {
      needsOnboarding: needsOnboarding(),
      version: readVersion(),
      requiredVersion: ONBOARDING_VERSION,
      open: Boolean(windowOf())
    }
  }

  /**
   * 给引导窗挂上「关窗即跳过」。
   * 幂等标记防重复挂载（open() 可能被调用多次，注册表返回的是同一实例）。
   */
  function wire(win: OnboardingWindow | null | undefined): void {
    if (!win || win.__hiraOnboardingWired) return
    win.__hiraOnboardingWired = true
    win.on('close', (event) => {
      if (finishing || quitting) return
      event.preventDefault()
      // 跳过与完成走同一条路：都一样要记版本 + 放出主窗。
      Promise.resolve(complete()).catch((e) => {
        console.error('[onboarding] 跳过引导失败:', errorMessage(e))
      })
    })
  }

  function open(): Record<string, unknown> {
    if (opening) return { ok: false, reason: 'opening' }
    const existed = windowOf()
    if (existed) {
      try { existed.show(); existed.focus() } catch (_) {}
      return { ok: true, existing: true }
    }
    opening = true
    try {
      const res = openWindow(windowTypes.ONBOARDING, null, null)
      const win = windowOf()
      if (win) {
        wire(win)
        // createSubWindow 不支持 center —— 居中只能拿到 BrowserWindow 之后自己做。
        try { win.center() } catch (_) {}
        try { win.show(); win.focus() } catch (_) {}
      }
      return { ok: true, created: Boolean(win), ...(res && res.ok === false ? { error: res.error } : {}) }
    } catch (e) {
      console.error('[onboarding] 打开引导窗口失败:', errorMessage(e))
      return { ok: false, error: errorMessage(e) }
    } finally {
      opening = false
    }
  }

  /**
   * 完成引导：mount 主窗 → 记版本 → 销毁引导窗。
   *
   * mount 放在最前：它可能抛错（页面加载失败等），此时**不能**先记版本、也不能
   * 关掉引导窗 —— 否则用户既没有主窗、下次启动还跳过引导，彻底卡死。
   * 版本在 mount 成功之后、销毁之前落盘：那是唯一的写入时机（窗口一销毁就没有
   * 第二次机会）。
   */
  async function complete(): Promise<{ ok: boolean }> {
    if (finishing) return { ok: false }
    finishing = true
    try {
      await mountMainShell()
    } catch (e) {
      finishing = false
      console.error('[onboarding] 主窗挂载失败，保留引导窗口:', errorMessage(e))
      return { ok: false }
    }

    writeVersion(ONBOARDING_VERSION)

    const win = windowOf()
    if (win) {
      try { win.destroy() } catch (e) { console.error('[onboarding] 关闭引导窗口失败:', errorMessage(e)) }
    }
    finishing = false
    return { ok: true }
  }

  /** 重新运行（设置页入口）：清掉完成态后立刻开窗；主窗保持原样。 */
  function reset(): { ok: boolean } {
    writeVersion('')
    const res = open()
    return { ok: res.ok !== false }
  }

  /** 退出流程调用：此后 close 不再被拦。 */
  function markQuitting(): void {
    quitting = true
  }

  return {
    version: ONBOARDING_VERSION,
    settingKey: ONBOARDING_SETTING_KEY,
    needsOnboarding,
    getState,
    open,
    complete,
    reset,
    markQuitting
  }
}

export interface OnboardingController {
  version: string
  settingKey: string
  needsOnboarding(): boolean
  getState(): Record<string, unknown>
  open(): Record<string, unknown>
  complete(): Promise<{ ok: boolean }>
  reset(): { ok: boolean }
  markQuitting(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
