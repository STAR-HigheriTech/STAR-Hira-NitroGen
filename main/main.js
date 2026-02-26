const electron = require('electron')
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const chromiumVersionOverride = '140.0.0.0'

const {
  app,
  BaseWindow,
  BrowserWindow,
  session,
  ipcMain: ipc,
  Menu,
  MenuItem,
  crashReporter,
  dialog,
  nativeTheme,
  WebContentsView
} = electron

global.MenuItem = MenuItem
global.nativeTheme = nativeTheme

crashReporter.start({
  submitURL: '',
  uploadToServer: false,
  compress: true
})

if (process.argv.some(arg => arg === '-v' || arg === '--version')) {
  console.log('Min: ' + app.getVersion())
  console.log('Chromium: ' + chromiumVersionOverride)
  process.exit()
}

app.setName('Hira')

let isInstallerRunning = false
const isDevelopmentMode = process.argv.some(arg => arg === '--development-mode')
const isDebuggingEnabled = false
global.isDebuggingEnabled = isDebuggingEnabled

function clamp (n, min, max) {
  return Math.max(Math.min(n, max), min)
}

if (process.platform === 'win32') {
  (async function () {
    var squirrelCommand = process.argv[1]
    if (squirrelCommand === '--squirrel-install' || squirrelCommand === '--squirrel-updated') {
      isInstallerRunning = true
      await global.registryInstaller.install()
    }
    if (squirrelCommand === '--squirrel-uninstall') {
      isInstallerRunning = true
      await global.registryInstaller.uninstall()
    }
    if (require('electron-squirrel-startup')) {
      app.quit()
    }
  })()
}

if (isDevelopmentMode) {
  app.setPath('userData', app.getPath('userData') + '-development')
}

// workaround for flicker when focusing app (https://github.com/electron/electron/issues/17942)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true')

var userDataPath = app.getPath('userData')

settings.initialize(userDataPath)

if (settings.get('userSelectedLanguage')) {
  app.commandLine.appendSwitch('lang', settings.get('userSelectedLanguage'))
}

const browserPage = 'min://app/index.html'

var mainMenu = null
var secondaryMenu = null
global.isFocusMode = false
var appIsReady = false
var extensionsSession = null

const isFirstInstance = app.requestSingleInstanceLock()

if (!isFirstInstance) {
  app.quit()
  process.exit(0)
}

var saveWindowBounds = function () {
  if (windows.getCurrent()) {
    var bounds = Object.assign(windows.getCurrent().getBounds(), {
      maximized: windows.getCurrent().isMaximized()
    })
    fs.writeFileSync(path.join(userDataPath, 'windowBounds.json'), JSON.stringify(bounds))
  }
}

function sendIPCToWindow (window, action, data) {
  if (window && window.isDestroyed()) {
    console.warn('ignoring message ' + action + ' sent to destroyed window')
    return
  }

  if (window && getWindowWebContents(window).isLoadingMainFrame()) {
    // immediately after a did-finish-load event, isLoading can still be true,
    // so wait a bit to confirm that the page is really loading
    setTimeout(function () {
      if (getWindowWebContents(window).isLoadingMainFrame()) {
        getWindowWebContents(window).once('did-finish-load', function () {
          getWindowWebContents(window).send(action, data || {})
        })
      } else {
        getWindowWebContents(window).send(action, data || {})
      }
    }, 0)
  } else if (window) {
    getWindowWebContents(window).send(action, data || {})
  } else {
    var newWindow = createWindow()
    getWindowWebContents(newWindow).once('did-finish-load', function () {
      getWindowWebContents(newWindow).send(action, data || {})
    })
  }
}

global.openTabInWindow = function (url) {
  sendIPCToWindow(windows.getCurrent(), 'addTab', {
    url: url
  })
}

function handleCommandLineArguments (argv) {
  // the "ready" event must occur before this function can be used
  if (argv) {
    argv.forEach(function (arg, idx) {
      if (arg && arg.toLowerCase() !== __dirname.toLowerCase()) {
        // URL
        if (arg.indexOf('://') !== -1) {
          sendIPCToWindow(windows.getCurrent(), 'addTab', {
            url: arg
          })
        } else if (idx > 0 && argv[idx - 1] === '-s') {
          // search
          sendIPCToWindow(windows.getCurrent(), 'addTab', {
            url: arg
          })
        } else if (/\.(m?ht(ml)?|pdf)$/.test(arg) && fs.existsSync(arg)) {
          // local files (.html, .mht, mhtml, .pdf)
          sendIPCToWindow(windows.getCurrent(), 'addTab', {
            url: 'file://' + path.resolve(arg)
          })
        }
      }
    })
  }
}

function createWindow (customArgs = {}) {
  var bounds

  try {
    var data = fs.readFileSync(path.join(userDataPath, 'windowBounds.json'), 'utf-8')
    bounds = JSON.parse(data)
  } catch (e) {}

  if (!bounds) { // there was an error, probably because the file doesn't exist
    var size = electron.screen.getPrimaryDisplay().workAreaSize
    bounds = {
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      maximized: true
    }
  }

  // make the bounds fit inside a currently-active screen
  // (since the screen Min was previously open on could have been removed)
  // see: https://github.com/minbrowser/min/issues/904
  var containingRect = electron.screen.getDisplayMatching(bounds).workArea

  bounds = {
    x: clamp(bounds.x, containingRect.x, (containingRect.x + containingRect.width) - bounds.width),
    y: clamp(bounds.y, containingRect.y, (containingRect.y + containingRect.height) - bounds.height),
    width: clamp(bounds.width, 0, containingRect.width),
    height: clamp(bounds.height, 0, containingRect.height),
    maximized: bounds.maximized
  }

  return createWindowWithBounds(bounds, customArgs)
}

function createWindowWithBounds (bounds, customArgs) {
  const newWin = new BaseWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: (process.platform === 'win32' ? 400 : 320), // controls take up more horizontal space on Windows
    minHeight: 350,
    titleBarStyle: settings.get('useSeparateTitlebar') ? 'default' : 'hidden',
    trafficLightPosition: { x: 12, y: 10 },
    icon: path.join(__dirname, 'icons', 'icon256.png'),
    frame: settings.get('useSeparateTitlebar'),
    alwaysOnTop: settings.get('windowAlwaysOnTop'),
    backgroundColor: '#fff' // the value of this is ignored, but setting it seems to work around https://github.com/electron/electron/issues/10559
  })

  // windows and linux always use a menu button in the upper-left corner instead
  // if frame: false is set, this won't have any effect, but it does apply on Linux if "use separate titlebar" is enabled
  if (process.platform !== 'darwin') {
    newWin.setMenuBarVisibility(false)
  }

  const mainView = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInWorker: true, // used by ProcessSpawner
      webviewTag: true,
      additionalArguments: [
        '--user-data-path=' + userDataPath,
        '--app-version=' + app.getVersion(),
        '--app-name=' + app.getName(),
        ...((isDevelopmentMode ? ['--development-mode'] : [])),
        '--window-id=' + windows.nextId,
        ...((windows.getAll().length === 0 ? ['--initial-window'] : [])),
        ...(windows.hasEverCreatedWindow ? [] : ['--launch-window']),
        ...(customArgs.initialTask ? ['--initial-task=' + customArgs.initialTask] : [])
      ]
    }
  })
  mainView.webContents.loadURL(browserPage)

  if (bounds.maximized) {
    newWin.maximize()

    mainView.webContents.once('did-finish-load', function () {
      sendIPCToWindow(newWin, 'maximize')
    })
  }

  const winBounds = newWin.getContentBounds()

  mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
  newWin.contentView.addChildView(mainView)

  // sometimes getContentBounds doesn't provide correct bounds until after the window has finished loading
  mainView.webContents.once('did-finish-load', function () {
    const winBounds = newWin.getContentBounds()
    mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
  })

  mainView.webContents.ipc.on('set-window-title', function (e, title) {
    newWin.title = title
  })

  newWin.on('resize', function () {
    // The result of getContentBounds doesn't update until the next tick
    setTimeout(function () {
      const winBounds = newWin.getContentBounds()
      mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
    }, 0)
  })

  newWin.on('close', function () {
    // save the window size for the next launch of the app
    saveWindowBounds()
  })

  newWin.on('focus', function () {
    if (!windows.getState(newWin).isMinimized) {
      sendIPCToWindow(newWin, 'windowFocus')
    }
  })

  newWin.on('minimize', function () {
    sendIPCToWindow(newWin, 'minimize')
    windows.getState(newWin).isMinimized = true
  })

  newWin.on('restore', function () {
    windows.getState(newWin).isMinimized = false
  })

  newWin.on('maximize', function () {
    sendIPCToWindow(newWin, 'maximize')
  })

  newWin.on('unmaximize', function () {
    sendIPCToWindow(newWin, 'unmaximize')
  })

  newWin.on('focus', function () {
    sendIPCToWindow(newWin, 'focus')
  })

  newWin.on('blur', function () {
    // if the devtools for this window are focused, this check will be false, and we keep the focused class on the window
    if (BaseWindow.getFocusedWindow() !== newWin) {
      sendIPCToWindow(newWin, 'blur')
    }
  })

  newWin.on('enter-full-screen', function () {
    sendIPCToWindow(newWin, 'enter-full-screen')
  })

  newWin.on('leave-full-screen', function () {
    sendIPCToWindow(newWin, 'leave-full-screen')
    // https://github.com/minbrowser/min/issues/1093
    newWin.setMenuBarVisibility(false)
  })

  newWin.on('enter-html-full-screen', function () {
    sendIPCToWindow(newWin, 'enter-html-full-screen')
  })

  newWin.on('leave-html-full-screen', function () {
    sendIPCToWindow(newWin, 'leave-html-full-screen')
    // https://github.com/minbrowser/min/issues/952
    newWin.setMenuBarVisibility(false)
  })

  /*
  Handles events from mouse buttons
  Unsupported on macOS, and on Linux, there is a default handler already,
  so registering a handler causes events to happen twice.
  See: https://github.com/electron/electron/issues/18322
  */
  if (process.platform === 'win32') {
    newWin.on('app-command', function (e, command) {
      if (command === 'browser-backward') {
        sendIPCToWindow(newWin, 'goBack')
      } else if (command === 'browser-forward') {
        sendIPCToWindow(newWin, 'goForward')
      }
    })
  }

  // prevent remote pages from being loaded using drag-and-drop, since they would have node access
  mainView.webContents.on('will-navigate', function (e, url) {
    if (url !== browserPage) {
      e.preventDefault()
    }
  })

  mainView.webContents.on('before-input-event', function (e, input) {
    sendIPCToWindow(newWin, 'before-input-event', input)
  })

  newWin.setTouchBar(global.buildTouchBar())

  windows.addWindow(newWin)

  return newWin
}

app.on('ready', function () {
  settings.set('restartNow', false)
  appIsReady = true

  /* the installer launches the app to install registry items and shortcuts,
  but if that's happening, we shouldn't display anything */
  if (isInstallerRunning) {
    return
  }

  if (process.platform === 'win32' && !isDevelopmentMode) {
    try {
      global.registryInstaller.ensureInstalled().then(function (ok) {
        if (ok) {
          settings.set('hasRegisteredHiraAsBrowser', true)
        }
      }).catch(function (e) {
        console.warn('Failed to register Hira as default browser candidate:', e)
      })
    } catch (e) {
      console.warn('Error while scheduling Hira browser registration:', e)
    }
  }

  global.plugins.loadAll()
  global.plugins.runAppReadyHooks()

  extensionsSession = session.fromPartition('persist:webcontent')

  try {
    var existingPreloads = extensionsSession.getPreloads ? extensionsSession.getPreloads() : []
    var extPreloadPath = require.resolve('electron-chrome-extensions/preload')
    var syncShimPreloadPath = path.join(__dirname, 'extensions-sync-shim-preload.js')
    var newPreloads = existingPreloads.slice()
    if (!newPreloads.includes(extPreloadPath)) {
      newPreloads.push(extPreloadPath)
    }
    if (!newPreloads.includes(syncShimPreloadPath)) {
      newPreloads.push(syncShimPreloadPath)
    }
    extensionsSession.setPreloads(newPreloads)
  } catch (e) {}

  global.extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: extensionsSession,
    createTab: async function (details) {
      const win = windows.getCurrent()
      if (!win || win.isDestroyed()) {
        throw new Error('No active window for chrome.tabs.create')
      }

      const url = details && details.url ? details.url : ''
      const active = typeof details.active === 'boolean' ? details.active : true
      const inBackground = !active

      sendIPCToWindow(win, 'addTab', {
        url: url,
        enterEditMode: false,
        openInBackground: inBackground
      })

      return new Promise((resolve, reject) => {
        let resolved = false

        const onTabCreated = function (event, data) {
          if (resolved || !data || !data.tabId) {
            return
          }
          resolved = true
          ipc.removeListener('tab-created', onTabCreated)

          try {
            const viewId = global.getTabIDFromWebContents && global.getTabIDFromWebContents(data.webContents)
            const view = viewId && global.getView ? global.getView(viewId) : null
            if (view && view.webContents) {
              resolve([view.webContents, win])
            } else if (data.webContents) {
              resolve([data.webContents, win])
            } else {
              reject(new Error('Failed to resolve tab WebContents'))
            }
          } catch (e) {
            reject(e)
          }
        }

        ipc.on('tab-created', onTabCreated)

        setTimeout(function () {
          if (!resolved) {
            ipc.removeListener('tab-created', onTabCreated)
            reject(new Error('Timed out waiting for tab creation'))
          }
        }, 5000)
      })
    },
    selectTab: function (webContents, browserWindow) {
      try {
        const win = browserWindow || windows.getCurrent()
        if (!win || win.isDestroyed()) {
          return
        }
        const tabId = global.getTabIDFromWebContents && global.getTabIDFromWebContents(webContents)
        if (!tabId) {
          return
        }
        sendIPCToWindow(win, 'selectTab', { id: tabId })
      } catch (e) {}
    },
    removeTab: function (webContents, browserWindow) {
      try {
        const win = browserWindow || windows.getCurrent()
        if (!win || win.isDestroyed()) {
          return
        }
        const tabId = global.getTabIDFromWebContents && global.getTabIDFromWebContents(webContents)
        if (!tabId) {
          return
        }
        sendIPCToWindow(win, 'closeTab', { id: tabId })
      } catch (e) {}
    },
    createWindow: async function (details) {
      const win = createWindow()
      if (details && details.url) {
        sendIPCToWindow(win, 'addTab', {
          url: details.url,
          enterEditMode: false,
          openInBackground: false
        })
      }
      return win
    },
    removeWindow: async function (browserWindow) {
      try {
        if (browserWindow && !browserWindow.isDestroyed()) {
          browserWindow.close()
        }
      } catch (e) {}
    }
  })

  var savedExtensions = settings.get('browserExtensions')
  if (Array.isArray(savedExtensions)) {
    savedExtensions.forEach(function (ext) {
      if (!ext || ext.enabled === false || !ext.path) {
        return
      }
      extensionsSession.extensions.loadExtension(ext.path).catch(function () {})
    })
  }

  global.registerBundleProtocol(session.defaultSession)

  const newWin = createWindow()

  getWindowWebContents(newWin).on('did-finish-load', function () {
    // if a URL was passed as a command line argument (probably because Min is set as the default browser on Linux), open it.
    handleCommandLineArguments(process.argv)

    // there is a URL from an "open-url" event (on Mac)
    if (global.URLToOpen) {
      // if there is a previously set URL to open (probably from opening a link on macOS), open it
      sendIPCToWindow(newWin, 'addTab', {
        url: global.URLToOpen
      })
      global.URLToOpen = null
    }
  })

  mainMenu = global.buildAppMenu()
  Menu.setApplicationMenu(mainMenu)
  global.createDockMenu()
})

app.on('open-url', function (e, url) {
  if (appIsReady) {
    sendIPCToWindow(windows.getCurrent(), 'addTab', {
      url: url
    })
  } else {
    global.URLToOpen = url // this will be handled later in the createWindow callback
  }
})

app.on('web-contents-created', function (e, contents) {
  global.plugins.runWebContentsCreatedHooks(contents)
})

// handoff support for macOS
app.on('continue-activity', function (e, type, userInfo, details) {
  if (type === 'NSUserActivityTypeBrowsingWeb' && details.webpageURL) {
    e.preventDefault()
    sendIPCToWindow(windows.getCurrent(), 'addTab', {
      url: details.webpageURL
    })
  }
})

app.on('second-instance', function (e, argv, workingDir) {
  if (windows.getCurrent()) {
    if (windows.getCurrent().isMinimized()) {
      windows.getCurrent().restore()
    }
    windows.getCurrent().focus()
    // add a tab with the new URL
    handleCommandLineArguments(argv)
  }
})

/**
 * Emitted when the application is activated, which usually happens when clicks on the applications's dock icon
 * https://github.com/electron/electron/blob/master/docs/api/app.md#event-activate-os-x
 *
 * Opens a new tab when all tabs are closed, and min is still open by clicking on the application dock icon
 */
app.on('activate', function (/* e, hasVisibleWindows */) {
  if (!windows.getCurrent() && appIsReady) { // sometimes, the event will be triggered before the app is ready, and creating new windows will fail
    createWindow()
  }
})

ipc.on('focusMainWebContents', function () {
  getWindowWebContents(windows.getCurrent()).focus()
})

ipc.on('showSecondaryMenu', function (event, data) {
  if (!secondaryMenu) {
    secondaryMenu = global.buildAppMenu({ secondary: true })
  }
  secondaryMenu.popup({
    x: data.x,
    y: data.y
  })
})

ipc.on('handoffUpdate', function (e, data) {
  if (app.setUserActivity && data.url && data.url.startsWith('http')) {
    app.setUserActivity('NSUserActivityTypeBrowsingWeb', {}, data.url)
  } else if (app.invalidateCurrentActivity) {
    app.invalidateCurrentActivity()
  }
})

ipc.on('quit', function () {
  app.quit()
})

ipc.on('tab-state-change', function (e, events) {
  const sourceWindowId = windows.windowFromContents(e.sender)?.id
  if (!sourceWindowId) {
    console.warn('warning: received tab state update from window after destruction, ignoring')
    return
  }
  windows.getAll().forEach(function (targetWindow) {
    if (getWindowWebContents(targetWindow).id !== e.sender.id) {
      getWindowWebContents(targetWindow).send('tab-state-change-receive', {
        sourceWindowId,
        events
      })
    }
  })
})

ipc.on('request-tab-state', function (e) {
  const otherWindow = windows.getAll().find(w => getWindowWebContents(w).id !== e.sender.id)
  if (!otherWindow) {
    throw new Error('secondary window doesn\'t exist as source for tab state')
  }
  ipc.once('return-tab-state', function (e2, data) {
    e.returnValue = data
  })
  getWindowWebContents(otherWindow).send('read-tab-state')
})

/* places service */

const placesPage = 'file://' + path.join(__dirname, 'js', 'places', 'placesService.html')

let placesWindow = null

function createPlacesWindow () {
  placesWindow = new BrowserWindow({
    width: 300,
    height: 300,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  placesWindow.loadURL(placesPage)
}

app.once('ready', function () {
  createPlacesWindow()
})

ipc.on('places-connect', function (e) {
  if (!placesWindow || placesWindow.isDestroyed() || placesWindow.webContents.isDestroyed()) {
    createPlacesWindow()
    placesWindow.webContents.once('did-finish-load', function () {
      placesWindow.webContents.postMessage('places-connect', null, e.ports)
    })
  } else {
    placesWindow.webContents.postMessage('places-connect', null, e.ports)
  }
})

function getWindowWebContents (win) {
  return win.getContentView().children[0].webContents
}

ipc.on('importExtension', function (e) {
  if (!extensionsSession) {
    return
  }

  dialog.showOpenDialog({
    properties: ['openDirectory']
  }).then(function (result) {
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return
    }

    var dir = result.filePaths[0]

    extensionsSession.extensions.loadExtension(dir).then(function (extension) {
      if (!extension) {
        return
      }

      var list = settings.get('browserExtensions') || []
      if (!Array.isArray(list)) {
        list = []
      }

      var name = extension.name
      if (!name && extension.manifest) {
        name = extension.manifest.short_name || extension.manifest.name
      }

      var item = {
        id: extension.id,
        name: name || extension.id,
        path: dir,
        enabled: true
      }

      var existingIndex = list.findIndex(function (i) {
        return i && i.id === extension.id
      })

      if (existingIndex !== -1) {
        list[existingIndex] = item
      } else {
        list.push(item)
      }

      settings.set('browserExtensions', list)
    }).catch(function (err) {
      if (err && err.message) {
        dialog.showErrorBox('扩展导入失败', err.message)
      }
    })
  })
})

ipc.on('importExtensionCrx', function (e) {
  if (!extensionsSession) {
    return
  }

  if (process.platform !== 'win32') {
    dialog.showErrorBox('暂不支持', '当前平台暂不支持直接从 CRX 文件导入扩展，请先手动解压到文件夹后使用“添加解压缩后的扩展文件夹”。')
    return
  }

  dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      {
        name: 'Chrome 扩展文件',
        extensions: ['crx']
      }
    ]
  }).then(function (result) {
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return
    }

    var crxPath = result.filePaths[0]
    var data

    try {
      data = fs.readFileSync(crxPath)
    } catch (err) {
      dialog.showErrorBox('扩展导入失败', '无法读取 CRX 文件：' + err.message)
      return
    }

    var pkHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    var headerIndex = data.indexOf(pkHeader)

    if (headerIndex === -1) {
      dialog.showErrorBox('扩展导入失败', '不支持的 CRX 文件格式。')
      return
    }

    var zipData = data.slice(headerIndex)
    var tmpZipPath = path.join(app.getPath('temp'), 'higheri-extension-' + Date.now() + '.zip')

    try {
      fs.writeFileSync(tmpZipPath, zipData)
    } catch (err) {
      dialog.showErrorBox('扩展导入失败', '无法写入临时 ZIP 文件：' + err.message)
      return
    }

    var targetBaseDir = path.join(userDataPath, 'ImportedExtensions')
    if (!fs.existsSync(targetBaseDir)) {
      fs.mkdirSync(targetBaseDir, { recursive: true })
    }

    var extFolderName = path.basename(crxPath, path.extname(crxPath)) + '-' + Date.now()
    var targetDir = path.join(targetBaseDir, extFolderName)

    var escapedZipPath = tmpZipPath.replace(/"/g, '""')
    var escapedTargetDir = targetDir.replace(/"/g, '""')

    var psCommand = [
      'Expand-Archive',
      '-LiteralPath',
      '"' + escapedZipPath + '"',
      '-DestinationPath',
      '"' + escapedTargetDir + '"',
      '-Force'
    ].join(' ')

    childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], function (error) {
      try {
        fs.unlinkSync(tmpZipPath)
      } catch (err) {}

      if (error) {
        dialog.showErrorBox('扩展导入失败', '解压 CRX 文件失败：' + error.message)
        return
      }

      extensionsSession.extensions.loadExtension(targetDir).then(function (extension) {
        if (!extension) {
          return
        }

        var list = settings.get('browserExtensions') || []
        if (!Array.isArray(list)) {
          list = []
        }

        var name = extension.name
        if (!name && extension.manifest) {
          name = extension.manifest.short_name || extension.manifest.name
        }

        var item = {
          id: extension.id,
          name: name || extension.id,
          path: targetDir,
          enabled: true
        }

        var existingIndex = list.findIndex(function (i) {
          return i && i.id === extension.id
        })

        if (existingIndex !== -1) {
          list[existingIndex] = item
        } else {
          list.push(item)
        }

        settings.set('browserExtensions', list)

        windows.getAll().forEach(function (win) {
          getWindowWebContents(win).send('refreshExtensionsView')
        })
      }).catch(function (err) {
        if (err && err.message) {
          dialog.showErrorBox('扩展导入失败', err.message)
        }
      })
    })
  })
})

ipc.on('removeExtension', function (e, id) {
  if (!extensionsSession || !id) {
    return
  }

  try {
    extensionsSession.extensions.removeExtension(id)
  } catch (err) {}

  var list = settings.get('browserExtensions') || []
  if (!Array.isArray(list)) {
    list = []
  }

  var newList = list.filter(function (item) {
    return item && item.id !== id
  })

  settings.set('browserExtensions', newList)
})

ipc.on('toggleExtension', function (e, data) {
  if (!extensionsSession || !data || !data.id) {
    return
  }

  var list = settings.get('browserExtensions') || []
  if (!Array.isArray(list)) {
    list = []
  }

  var index = list.findIndex(function (item) {
    return item && item.id === data.id
  })

  if (index === -1) {
    return
  }

  var enabled = !!data.enabled
  list[index].enabled = enabled
  settings.set('browserExtensions', list)

  if (enabled) {
    var pathToLoad = list[index].path
    if (pathToLoad) {
      extensionsSession.extensions.loadExtension(pathToLoad).catch(function () {})
    }
  } else {
    try {
      extensionsSession.extensions.removeExtension(list[index].id)
    } catch (err) {}
  }
})

ipc.on('openExtensionOptions', function (e, id) {
  if (!extensionsSession || !id) {
    return
  }

  var list = settings.get('browserExtensions') || []
  if (!Array.isArray(list)) {
    list = []
  }

  var item = list.find(function (ext) {
    return ext && ext.id === id
  })

  if (!item || !item.path) {
    return
  }

  var manifestPath = path.join(item.path, 'manifest.json')
  var manifest

  try {
    var manifestContent = fs.readFileSync(manifestPath, 'utf-8')
    manifest = JSON.parse(manifestContent)
  } catch (err) {
    return
  }

  var optionsPage = null

  if (manifest && manifest.options_ui && manifest.options_ui.page) {
    optionsPage = manifest.options_ui.page
  } else if (manifest && manifest.options_page) {
    optionsPage = manifest.options_page
  }

  if (!optionsPage) {
    return
  }

  var url = 'chrome-extension://' + id + '/' + optionsPage

  sendIPCToWindow(windows.getCurrent(), 'addTab', {
    url: url
  })
})

ipc.on('openExtensionPopup', function (e, id) {
  if (!extensionsSession || !id) {
    return
  }

  var list = settings.get('browserExtensions') || []
  if (!Array.isArray(list)) {
    list = []
  }

  var item = list.find(function (ext) {
    return ext && ext.id === id
  })

  if (!item || !item.path || item.enabled === false) {
    return
  }

  var manifestPath = path.join(item.path, 'manifest.json')
  var manifest

  try {
    var manifestContent = fs.readFileSync(manifestPath, 'utf-8')
    manifest = JSON.parse(manifestContent)
  } catch (err) {
    return
  }

  var popupPage = null

  if (manifest && manifest.action && manifest.action.default_popup) {
    popupPage = manifest.action.default_popup
  } else if (manifest && manifest.browser_action && manifest.browser_action.default_popup) {
    popupPage = manifest.browser_action.default_popup
  } else if (manifest && manifest.page_action && manifest.page_action.default_popup) {
    popupPage = manifest.page_action.default_popup
  }

  if (!popupPage) {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['知道了'],
      message: '该扩展未提供弹窗'
    })
    return
  }

  var url = 'chrome-extension://' + id + '/' + popupPage

  var popupWindow = new BrowserWindow({
    width: 360,
    height: 600,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icons', 'icon256.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: extensionsSession
    }
  })

  popupWindow.webContents.once('did-finish-load', function () {
    if (!popupWindow.isDestroyed()) {
      popupWindow.show()
    }
  })

  popupWindow.loadURL(url)
})

/* translate service */

const translatePage = 'min://app/pages/translateService/index.html'
const translatePreload = path.join(__dirname, 'pages', 'translateService', 'translateServicePreload.js')

app.on('ready', function () {
  ipc.on('page-translation-session-create', function (e) {
    const translateWindow = new BrowserWindow({
      width: 300,
      height: 300,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: translatePreload
      }
    })

    translateWindow.loadURL(translatePage)

    translateWindow.webContents.once('did-finish-load', function () {
      translateWindow.webContents.postMessage('page-translation-session-create', null, e.ports)
    })
  })
})
