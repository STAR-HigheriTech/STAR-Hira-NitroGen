/**
 * ui-shell 诊断钩子 —— **默认零开销**。
 *
 * 六个监听全是纯取证（每条 console 都跨进程打到主进程日志、每次加载都取 URL），
 * 生产会话里没有任何消费方。因此用环境变量做总闸门：不显式开启时，
 * `attachUiShellDiagnostics` 直接返回，连 `on()` 都不调用 —— 不注册监听器
 * 就没有事件分发开销，比"注册后再判断"更彻底。
 *
 * 排查渲染层白屏 / 脚本报错：`HIRA_UI_SHELL_DEBUG=1` 启动即可（对齐 Hira 的 ENABLED 闸门）。
 */
const ENABLED = process.env.HIRA_UI_SHELL_DEBUG === '1'
import type { WebContents } from 'electron'

function attachUiShellDiagnostics(webContents: WebContents | null | undefined): void {
  if (!ENABLED || !webContents) return

  webContents.on('console-message', (event) => {
    console.log(`[ui-shell][console:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  webContents.on('did-start-loading', () => {
    console.log(`[ui-shell][did-start-loading] url=${webContents.getURL()}`)
  })
  webContents.on('dom-ready', () => {
    console.log(`[ui-shell][dom-ready] url=${webContents.getURL()}`)
  })
  webContents.on('did-finish-load', () => {
    console.log(`[ui-shell][did-finish-load] url=${webContents.getURL()}`)
  })
  webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`[ui-shell][did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  webContents.on('render-process-gone', (_e, details) => {
    console.log(`[ui-shell][render-gone] ${JSON.stringify(details)}`)
  })
}

module.exports = {
  attachUiShellDiagnostics
}
