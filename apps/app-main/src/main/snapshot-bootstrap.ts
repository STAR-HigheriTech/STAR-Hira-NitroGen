const fs = require('fs')
const { screen } = require('electron')
const { createMainWindow, TabManager } = require('@hira-ng/infra-window')
const { createThemeManager } = require('@hira-ng/infra-theme')
// 快照跑的是「无插件」的最小窗口，因此用面板目录的**保底集**当预期集合 ——
// 生产路径的面板来自插件 manifest（见 main/panel-catalog.js），这里不复制那份清单。
const { createPanelCatalog } = require('./panel-catalog')
const { registerCoreIpc } = require('./ipc-routes')
const { tabRules, tabAdjust, tabStacks } = require('@hira-ng/domain-tabs')
import type { App, IpcMain } from 'electron'

async function runSnapshotIfNeeded({ app, ipcMain }: { app: App; ipcMain: IpcMain }) {
  if (process.env.HIRA_SNAPSHOT !== '1') return false

  const outPath = process.env.HIRA_SNAPSHOT_OUT
  if (!outPath) {
    app.exit(2)
    return true
  }

  let width = Number(process.env.HIRA_WINDOW_W || 1100)
  let height = Number(process.env.HIRA_WINDOW_H || 720)

  const targetPxW = Number(process.env.HIRA_TARGET_PX_W || 0)
  const targetPxH = Number(process.env.HIRA_TARGET_PX_H || 0)
  if (targetPxW > 0 && targetPxH > 0) {
    const scaleFactor = screen.getPrimaryDisplay()?.scaleFactor || 1
    width = Math.floor(targetPxW / scaleFactor)
    height = Math.floor(targetPxH / scaleFactor)
  }

  const { win, webContentsManager, layoutCoordinator } = createMainWindow({
    show: true,
    width,
    height,
    autoLoadUiShell: false
  })

  // chrome = 窗口本体（对齐 RT FakeWebContentsViewLayer）：ui-shell 的 webContents 即 win.webContents
  const uiShellWebContents = win.webContents
  const themeManager = createThemeManager({ initialTheme: 'light' })
  const tabManager = new TabManager({
    webContentsManager,
    layoutCoordinator,
    emit: () => {},
    tabRules,
    tabAdjust,
    tabStacks
  })

  const panelCatalog = createPanelCatalog()

  await registerCoreIpc({
    ipcMain,
    // 快照不启插件 → 目录停在保底集（未 markReady），与真实首屏的渲染集合一致
    getPanelCatalog: () => panelCatalog,
    layoutCoordinator,
    tabManager
  })

  await webContentsManager.loadUiShell()
  try { await webContentsManager.loadRail() } catch (e) {
    console.error('[snapshot] loadRail failed (non-fatal):', e instanceof Error ? e.message : e)
  }
  await themeManager.applyToWebContents(uiShellWebContents).catch(() => {})
  layoutCoordinator.applyInitialLayout()
  await tabManager.newTab({ url: 'about:blank' })

  const delayMs = Number(process.env.HIRA_SNAPSHOT_DELAY_MS || 500)
  await new Promise((r) => setTimeout(r, delayMs))

  const scaleFactor = screen.getPrimaryDisplay()?.scaleFactor || 1
  let image = await win.capturePage()
  if (targetPxW > 0 && targetPxH > 0) {
    for (let i = 0; i < 6; i += 1) {
      const s = image.getSize()
      if (s.width === targetPxW && s.height === targetPxH) break

      const [cw, ch] = win.getContentSize()
      let dw = Math.round((targetPxW - s.width) / scaleFactor)
      let dh = Math.round((targetPxH - s.height) / scaleFactor)

      if (dw === 0 && targetPxW !== s.width) dw = targetPxW > s.width ? 1 : -1
      if (dh === 0 && targetPxH !== s.height) dh = targetPxH > s.height ? 1 : -1

      if (dw === 0 && dh === 0) break
      win.setContentSize(cw + dw, ch + dh)
      await new Promise((r) => setTimeout(r, 100))
      image = await win.capturePage()
    }
  }

  fs.mkdirSync(require('path').dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, image.toPNG())
  app.exit(0)
  return true
}

module.exports = {
  runSnapshotIfNeeded
}
