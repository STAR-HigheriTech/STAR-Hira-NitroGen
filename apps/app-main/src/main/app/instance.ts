/**
 * App: 单实例（对齐 RT `src/main/app/instance.ts`）
 *
 * 单实例锁是**性能与正确性的前提**，不只是「产品习惯」：
 * 两个实例共用同一个 userData 时会争抢 chromium-cache 与 hira-ng.db 的文件锁，
 * Chromium IO 线程不断重试（Unable to move the cache / Failed to delete the database），
 * 主进程被反复打断 → 整窗口卡顿、原生右键菜单像「卡死」。
 *
 * 第二个实例的唯一职责：把已有窗口拉到前台；若命令行带了 URL，则转交 urls 路由打开。
 * 桌面快捷方式重复启动（无 URL）则新建浏览器窗口，保持单进程共享用户数据。
 */
import type { App, BrowserWindow } from 'electron'

interface PwaLaunchArgs {
  appId: string
  profileId: string | null
  spaceId: string | null
  file: string | null
  url: string | null
}

interface InstanceControllerOptions {
  app: App
  getMainWindow?: () => BrowserWindow | null
  onNewWindow?: () => void
  onOpenUrl?: (useNewWindow: boolean, url: string) => void
  onAction?: (name: string) => void
  onPwaApp?: (pwa: PwaLaunchArgs) => void
}

export interface InstanceController {
  hasLock: boolean
  focusMainWindow(): void
  register(): void
}

const { pickOpenerUrlFromArgv, hasNewWindowFlag } = require('./urls') as {
  pickOpenerUrlFromArgv(argv: readonly string[]): string | null
  hasNewWindowFlag(argv: readonly string[]): boolean
}
const { pickJumpListAction } = require('./platform-integration') as {
  pickJumpListAction(argv: unknown): string | null
}
const { parsePwaArgs } = require('./pwa-args') as {
  parsePwaArgs(argv: readonly string[]): PwaLaunchArgs | null
}

/**
 * @param {{
 *   app: import('electron').App,
 *   getMainWindow?: () => (import('electron').BrowserWindow|null),
 *   onNewWindow?: () => void,
 *   onOpenUrl?: (useNewWindow: boolean, url: string) => void,
 *   onAction?: (name: string) => void,
 *   onPwaApp?: (pwa: { appId: string, profileId: string|null, spaceId: string|null }) => void
 * }} deps
 */
export function createInstanceController({
  app,
  getMainWindow,
  onNewWindow,
  onOpenUrl,
  onAction,
  onPwaApp
}: InstanceControllerOptions): InstanceController {
  const hasLock = !!app.requestSingleInstanceLock()
  const getWindow = typeof getMainWindow === 'function' ? getMainWindow : () => null

  /** 把已有主窗口拉到前台（show 兜底：窗口可能被最小化/隐藏，只 focus 拉不回来）。 */
  function focusMainWindow(): void {
    const target = getWindow()
    if (!target || target.isDestroyed()) return
    try {
      if (!target.isVisible()) target.show()
      if (target.isMinimized()) target.restore()
      target.focus()
    } catch (_) {}
  }

  function register(): void {
    if (!hasLock) return
    app.on('second-instance', (_event, commandLine) => {
      // ⓪ PWA 应用启动（快捷方式 / 任务栏固定项 / `setAppDetails.relaunchCommand`）：
      //    它的命令行里是 `--pwa-app=` 而不是 URL，**必须最先判**——
      //    误走 urlRouter 会得到一个「打不开的地址」，用户看到的就是「双击没反应」。
      const pwa = parsePwaArgs(commandLine)
      if (pwa) {
        if (typeof onPwaApp === 'function') onPwaApp(pwa)
        else focusMainWindow()
        return
      }
      // ① 任务栏 JumpList 的动作（新起进程带 `--jump-list-action=…`）：
      //    它不是 URL，必须走动作通道，绝不能当成地址去打开。
      const action = pickJumpListAction(commandLine)
      if (action) {
        if (typeof onAction === 'function') onAction(action)
        else focusMainWindow()
        return
      }
      // ② 普通 URL：带 `--new-window` 时不抢焦点（用户要的是新窗口，把旧窗口拉到
      //    前台反而会打断正在进行的操作，Chrome 同语义）。
      const url = pickOpenerUrlFromArgv(commandLine)
      const wantsNewWindow = hasNewWindowFlag(commandLine)
      // 快捷方式 / 开始菜单再次启动：没有要打开的目标，就是一次「新建窗口」意图。
      // 不能再只聚焦旧窗口，否则用户重复双击只会看到同一个窗口闪一下。
      if (!url) {
        if (typeof onNewWindow === 'function') onNewWindow()
        else focusMainWindow()
        return
      }
      if (!wantsNewWindow) focusMainWindow()
      if (typeof onOpenUrl === 'function') onOpenUrl(wantsNewWindow, url)
    })
  }

  return { hasLock, focusMainWindow, register }
}

