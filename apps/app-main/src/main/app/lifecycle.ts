/**
 * App: 应用生命周期（对齐 RT `src/main/app/lifecycle.ts`）
 *
 * 关闭最后一个窗口 = 退出应用（Windows / Linux）。这条规则是**必须**的：
 * 以前关窗后主进程既不退出、又没有托盘可把它唤回（当时的托盘模块从未被调用，
 * 现已删除 —— 见 CONTRACT-18），于是变成「无窗口僵尸」，却仍占着 userData 下的
 * chromium-cache 与 hira-ng.db；此时再启动一个实例（旧版还没有单实例锁）就会与
 * 僵尸争抢这两个文件锁，Chromium IO 线程不断重试：
 *   Unable to move the cache: 拒绝访问。 (0x5)
 *   Failed to delete the database: Database IO error
 * 主进程 / IO 线程被反复打断 → 整个窗口卡顿，原生右键菜单表现得像「卡死不像人」。
 * 这与「抄哪个浏览器」无关，是生命周期设计缺陷。
 *
 * macOS 例外：关窗不退出（由 Dock activate 重新拉起窗口）。
 */

import type { App } from 'electron'

export interface AppLifecycleOptions {
  app: App
  onActivate?: () => void
}

/**
 * @param {{
 *   app: import('electron').App,
 *   onActivate?: () => void
 * }} deps
 */
export function registerAppLifecycle({ app, onActivate }: AppLifecycleOptions): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  if (typeof onActivate === 'function') {
    app.whenReady().then(() => {
      app.on('activate', () => onActivate())
    })
  }
}

