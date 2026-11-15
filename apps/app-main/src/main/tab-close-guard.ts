/**
 * 「关闭多个标签前确认」的唯一闸门（设置键 `tabs.confirm_close_multiple`）。
 *
 * 为什么单独成模块：同一条策略有**三条入口** ——
 *   1. 渲染层右键菜单 → `ipc/tabs.js` 的 `tabCloseOthers` / `tabCloseRight`；
 *   2. 主进程应用菜单 → `main.js` 的 `tabCloseOthers`；
 *   3. 关闭窗口（点 X / Ctrl+W 到最后一个窗口 / 系统关闭）→ 窗口装配的 `close` 事件。
 * 若各自实现，必然出现"一处问了、一处没问"的分叉（改设置后两个入口行为不一致）。
 * 因此「读设置 + 数将要关闭的条数 + 询问」全部收在这里，入口只负责调用。
 *
 * 询问用的是**应用内浮层**（hira://jsdialog，与网页 `window.confirm` 同一个视觉），
 * 不是系统原生对话框（`dialog.showMessageBox`）——后者与浏览器内的观感割裂。
 */

const { TABS_SETTING_KEYS } = require('@hira-ng/shared-types/src/tabs-settings.mjs')

interface TabManagerPort {
  countCloseTargets?: (mode: 'others' | 'right', tabId: string) => number
}

interface DialogManager {
  confirm: (options: {
    title: string
    message: string
    okText: string
    cancelText: string
  }) => Promise<boolean>
}

interface TabCloseGuardDeps {
  getTabManager: () => TabManagerPort | null
  getJsDialogManager: () => DialogManager | null
  settingsService: { get: (key: string) => unknown } | null
}

function createTabCloseGuard ({
  getTabManager,
  getJsDialogManager,
  settingsService
}: TabCloseGuardDeps) {
  /** 设置是否开启（读失败一律视为关闭，与改造前一致）。 */
  function isEnabled (): boolean {
    if (!settingsService) return false
    try {
      return settingsService.get(TABS_SETTING_KEYS.confirmCloseMultiple) === true
    } catch (_) {
      return false
    }
  }

  /**
   * 取**当前窗口**的浮层宿主。
   * 没有浮层宿主（窗口正在销毁等极端时序）时返回 null —— 调用方一律按「取消」处理，
   * 宁可不动手，也不静默批量关闭。
   */
  function resolveDialogManager (): DialogManager | null {
    const manager = typeof getJsDialogManager === 'function' ? getJsDialogManager() : null
    return manager && typeof manager.confirm === 'function' ? manager : null
  }

  /**
   * 关闭多个标签前的确认闸门。
   * @param {'others'|'right'} mode 关闭模式（与 TabManager#countCloseTargets 同一口径）
   * @param {string} tabId 作为基准的那个标签
   * @returns {Promise<boolean>} true = 用户取消（调用方必须中止关闭）
   */
  async function shouldCancel (mode: 'others' | 'right', tabId: string): Promise<boolean> {
    if (!isEnabled()) return false

    // 「多个」= 一个以上：只关一个（或一个都关不掉）时不该打扰用户。
    // 条数由 TabManager 按领域规则数（含固定标签豁免 / 空间作用域），不在这里另推一遍。
    let count = 0
    try {
      const tabs = getTabManager()
      count = tabs && typeof tabs.countCloseTargets === 'function'
        ? tabs.countCloseTargets(mode, tabId)
        : 0
    } catch (_) {
      count = 0
    }
    if (count <= 1) return false

    const manager = resolveDialogManager()
    if (!manager) return true

    const ok = await manager.confirm({
      title: '关闭多个标签页',
      message: `确定要关闭这 ${count} 个标签页吗？`,
      okText: '关闭',
      cancelText: '取消'
    })
    return !ok
  }

  /**
   * 关闭窗口前是否需要询问（**同步**判断）。
   *
   * 窗口的 `close` 事件必须在监听器返回前决定要不要 `preventDefault()`，
   * 因此这一层不能是异步的；真正的询问由 `shouldCancelWindowClose` 承担。
   *
   * @param {number} count 本窗口的标签总数（`TabManager#countTabs()`）
   * @returns {boolean}
   */
  function needsWindowCloseConfirm (count: number): boolean {
    return isEnabled() && Number(count) > 1
  }

  /**
   * 关闭窗口前的确认闸门（`count > 1` 才询问）。
   * @param {number} count 本窗口的标签总数
   * @param {{ getJsDialogManager?: () => object|null }} [scope]
   *   覆盖「用哪个窗口的浮层宿主」—— 关闭窗口时调用方掌握**被关的那个窗口**，
   *   不能走 `targetWindow()`（用户可能点的是非焦点窗口的 X）。
   * @returns {Promise<boolean>} true = 用户取消（调用方必须中止关闭）
   */
  async function shouldCancelWindowClose (
    count: number,
    scope?: { getJsDialogManager?: () => DialogManager | null }
  ): Promise<boolean> {
    if (!needsWindowCloseConfirm(count)) return false

    const candidate = scope && typeof scope.getJsDialogManager === 'function'
      ? scope.getJsDialogManager()
      : (typeof getJsDialogManager === 'function' ? getJsDialogManager() : null)
    const manager = candidate && typeof candidate.confirm === 'function' ? candidate : null
    if (!manager) return true

    const ok = await manager.confirm({
      title: '关闭多个标签页',
      message: `此窗口还有 ${count} 个标签页，确定要关闭吗？`,
      okText: '关闭窗口',
      cancelText: '取消'
    })
    return !ok
  }

  return { shouldCancel, needsWindowCloseConfirm, shouldCancelWindowClose }
}

module.exports = { createTabCloseGuard }
