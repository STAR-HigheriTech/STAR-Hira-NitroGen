;(function () {
  const fs = require('fs')
  const path = require('path')
  const { app, session, ipcMain, BrowserWindow, webContents } = require('electron')

  const hooks = {
    webContentsCreated: [],
    appReady: []
  }

  function loadAll () {
    const appRoot = path.join(__dirname, '..')
    const pluginsDir = path.join(appRoot, 'plugins')

    if (!fs.existsSync(pluginsDir)) {
      return
    }

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })

    entries.forEach(entry => {
      if (!entry.isDirectory()) return

      const baseDir = path.join(pluginsDir, entry.name)
      const manifestPath = path.join(baseDir, 'plugin.json')

      if (!fs.existsSync(manifestPath)) return

      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch {
        return
      }

      if (!manifest.main) return

      const mainPath = path.join(baseDir, manifest.main)

      let mod
      try {
        mod = require(mainPath)
      } catch {
        return
      }

      if (typeof mod.activate !== 'function') return

      const api = {
        app,
        session: session.defaultSession,
        ipcMain,
        BrowserWindow,
        webContents,
        onWebContentsCreated (fn) {
          if (typeof fn === 'function') {
            hooks.webContentsCreated.push(fn)
          }
        },
        onAppReady (fn) {
          if (typeof fn === 'function') {
            hooks.appReady.push(fn)
          }
        }
      }

      try {
        mod.activate(api)
      } catch {
      }
    })
  }

  function runAppReadyHooks () {
    hooks.appReady.forEach(fn => {
      try {
        fn()
      } catch {
      }
    })
  }

  function runWebContentsCreatedHooks (contents) {
    hooks.webContentsCreated.forEach(fn => {
      try {
        fn(contents)
      } catch {
      }
    })
  }

  global.plugins = {
    loadAll,
    runAppReadyHooks,
    runWebContentsCreatedHooks
  }
})()
