/**
 * main/file-open/navigation-guard.js —— 文件拖放的**主进程兜底**。
 *
 * ── 为什么 preload 接管了还需要这一层 ──────────────────────────────
 * `file-drop` 挂在 window 的冒泡阶段，几乎覆盖所有情况；但网页可以：
 *   · 在 document / 元素上 `stopPropagation()`，让事件到不了 window；
 *   · 在捕获阶段自己处理，却没阻止默认动作。
 * 此时 Chromium 的 `navigateOnDragDrop` 会把**当前标签**导航到 file://
 *（注意 tabEvents 的 will-navigate 对非 web URL 直接放行，不会帮忙）。
 *
 * 本模块监听 `will-navigate`：只要「非 file 页面 → file: 目标」就取消导航，
 * 改走与拖放完全相同的 fileOpenService —— 于是体验统一成「新标签打开」，
 * 当前页永远不会被文件顶掉。
 *
 * ── 边界 ──────────────────────────────────────────────────────────
 * · 已经在 file:// 页面内点链接 / 目录跳转：不拦（那是正常的文件浏览）。
 * · 只处理主框架：`will-navigate` 本身只为主框架触发。
 * · 子窗口 / 内部页也挂：解析不到窗口运行单元时由 fileOpenService 的调用方
 *   跳过（无 tabManager → 回退系统默认），不会串到别的窗口。
 */

const { fileURLToPath } = require('node:url')

interface WebContentsPort {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void
  getURL(): string
}

interface AppPort {
  on(event: 'web-contents-created', listener: (event: unknown, webContents: WebContentsPort) => void): void
  removeListener(event: 'web-contents-created', listener: (event: unknown, webContents: WebContentsPort) => void): void
}

interface RuntimePort {
  tabManager?: unknown
}

interface RuntimeRegistryPort {
  resolve(webContents: WebContentsPort): RuntimePort | null
}

interface FileOpenServicePort {
  openPaths(paths: string[], options: { tabManager?: unknown }): unknown
}

interface NavigationGuardDependencies {
  app?: AppPort | null
  runtimeRegistry?: RuntimeRegistryPort | null
  fileOpenService?: FileOpenServicePort | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFileUrl(url: unknown): boolean {
  return typeof url === 'string' && url.slice(0, 5).toLowerCase() === 'file:'
}

/**
 * @param {{ app:any, runtimeRegistry?:any, fileOpenService:any }} deps
 * @returns {() => void} 卸载函数（测试 / 热重载用）
 */
function attachFileDropNavigationGuard({ app, runtimeRegistry, fileOpenService }: NavigationGuardDependencies = {}): () => void {
  if (!app || !fileOpenService || typeof app.on !== 'function') return () => {}
  const service = fileOpenService

  function onWebContentsCreated(_event: unknown, wc: WebContentsPort): void {
    if (!wc || typeof wc.on !== 'function') return

    wc.on('will-navigate', (event, url: string) => {
      if (!isFileUrl(url)) return

      // 已在 file:// 里的站内跳转保持原样
      let currentUrl = ''
      try { currentUrl = wc.getURL() || '' } catch (_) {}
      if (isFileUrl(currentUrl)) return

      let target = ''
      try { target = fileURLToPath(url) } catch (_) { /* 畸形 file URL：交给默认处理 */ }
      if (!target) return

      // 取消当前导航 —— 当前页保持不动
      try { event.preventDefault() } catch (_) {}

      const runtime = runtimeRegistry ? runtimeRegistry.resolve(wc) : null
      const tabManager = runtime ? runtime.tabManager : null
      Promise.resolve(service.openPaths([target], { tabManager }))
        .catch((e: unknown) => console.warn('[file-open] 兜底打开失败:', errorMessage(e)))
    })
  }

  app.on('web-contents-created', onWebContentsCreated)
  return () => {
    try { app.removeListener('web-contents-created', onWebContentsCreated) } catch (_) {}
  }
}

module.exports = { attachFileDropNavigationGuard }
