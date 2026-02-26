window.globalArgs = {}

process.argv.forEach(function (arg) {
  if (arg.startsWith('--')) {
    var key = arg.split('=')[0].replace('--', '')
    var value = arg.split('=')[1]
    globalArgs[key] = value
  }
})

window.windowId = globalArgs['window-id']

window.electron = require('electron')
window.fs = require('fs')
window.EventEmitter = require('events')
window.ipc = electron.ipcRenderer

if (navigator.platform === 'MacIntel') {
  document.body.classList.add('mac')
  window.platformType = 'mac'
} else if (navigator.platform === 'Win32') {
  document.body.classList.add('windows')
  window.platformType = 'windows'
} else {
  document.body.classList.add('linux')
  window.platformType = 'linux'
}

if (navigator.maxTouchPoints > 0) {
  document.body.classList.add('touch')
}

/* add classes so that the window state can be used in CSS */
ipc.on('enter-full-screen', function () {
  document.body.classList.add('fullscreen')
})

ipc.on('leave-full-screen', function () {
  document.body.classList.remove('fullscreen')
})

ipc.on('maximize', function () {
  document.body.classList.add('maximized')
})

ipc.on('unmaximize', function () {
  document.body.classList.remove('maximized')
})

document.body.classList.add('focused')

ipc.on('focus', function () {
  document.body.classList.add('focused')
})

ipc.on('blur', function () {
  document.body.classList.remove('focused')
})

// https://remysharp.com/2010/07/21/throttling-function-calls

window.throttle = function (fn, threshhold, scope) {
  threshhold || (threshhold = 250)
  var last,
    deferTimer
  return function () {
    var context = scope || this

    var now = +new Date()
    var args = arguments
    if (last && now < last + threshhold) {
      // hold on to it
      clearTimeout(deferTimer)
      deferTimer = setTimeout(function () {
        last = now
        fn.apply(context, args)
      }, threshhold)
    } else {
      last = now
      fn.apply(context, args)
    }
  }
}

// https://remysharp.com/2010/07/21/throttling-function-calls

window.debounce = function (fn, delay) {
  var timer = null
  return function () {
    var context = this
    var args = arguments
    clearTimeout(timer)
    timer = setTimeout(function () {
      fn.apply(context, args)
    }, delay)
  }
}

window.empty = function (node) {
  while (node.firstElementChild) {
    node.removeChild(node.firstElementChild)
  }
}

/* prevent a click event from firing after dragging the window */

window.addEventListener('load', function () {
  var isMouseDown = false
  var isDragging = false
  var distance = 0

  document.body.addEventListener('mousedown', function () {
    isMouseDown = true
    isDragging = false
    distance = 0
  })

  document.body.addEventListener('mouseup', function () {
    isMouseDown = false
  })

  var dragHandles = document.getElementsByClassName('windowDragHandle')

  for (var i = 0; i < dragHandles.length; i++) {
    dragHandles[i].addEventListener('mousemove', function (e) {
      if (isMouseDown) {
        isDragging = true
        distance += Math.abs(e.movementX) + Math.abs(e.movementY)
      }
    })
  }

  document.body.addEventListener('click', function (e) {
    if (isDragging && distance >= 10.0) {
      e.stopImmediatePropagation()
      isDragging = false
    }
  }, true)
})

require('tabState.js').initialize()
require('tabState/windowSync.js').initialize()
require('windowControls.js').initialize()
require('navbar/menuButton.js').initialize()

require('navbar/addTabButton.js').initialize()
require('navbar/tabContextMenu.js').initialize()
require('navbar/tabActivity.js').initialize()
require('navbar/tabColor.js').initialize()
require('navbar/navigationButtons.js').initialize()
require('downloadManager.js').initialize()
require('webviewMenu.js').initialize()
require('contextMenu.js').initialize()
require('menuRenderer.js').initialize()
require('defaultKeybindings.js').initialize()
require('pdfViewer.js').initialize()
require('autofillSetup.js').initialize()
require('passwordManager/passwordManager.js').initialize()
require('passwordManager/passwordCapture.js').initialize()
require('passwordManager/passwordViewer.js').initialize()
require('util/theme.js').initialize()
require('userscripts.js').initialize()
require('statistics.js').initialize()
require('taskOverlay/taskOverlay.js').initialize()
require('sessionRestore.js').initialize()
require('bookmarkConverter.js').initialize()
require('newTabPage.js').initialize()
require('macHandoff.js').initialize()

// default searchbar plugins

require('searchbar/placesPlugin.js').initialize()
require('searchbar/instantAnswerPlugin.js').initialize()
require('searchbar/bangsPlugin.js').initialize()
require('searchbar/customBangs.js').initialize()
require('searchbar/searchSuggestionsPlugin.js').initialize()
require('searchbar/placeSuggestionsPlugin.js').initialize()
require('searchbar/updateNotifications.js').initialize()
require('searchbar/restoreTaskPlugin.js').initialize()
require('searchbar/bookmarkManager.js').initialize()
require('searchbar/historyViewer.js').initialize()
require('searchbar/developmentModeNotification.js').initialize()
require('searchbar/shortcutButtons.js').initialize()
require('searchbar/calculatorPlugin.js').initialize()

;(function () {
  var refreshButton = document.getElementById('refresh-button')
  var bookmarksButton = document.getElementById('bookmarks-button')
  var historyButton = document.getElementById('history-button')
  var extensionsButton = document.getElementById('extensions-button')
  var downloadsButton = document.getElementById('downloads-button')
  var searchButton = document.getElementById('search-button')
  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tab = tabs.get(currentTabId)
      if (!tab || !tab.url) {
        return
      }
      var webviews = require('webviews.js')
      if (tab.url.startsWith(webviews.internalPages.error)) {
        var originalURL = new URL(tab.url).searchParams.get('url')
        if (originalURL) {
          webviews.update(currentTabId, originalURL)
        }
      } else {
        webviews.callAsync(currentTabId, 'reload')
      }
    })
  }
  if (bookmarksButton) {
    bookmarksButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tabEditor = require('navbar/tabEditor.js')
      tabEditor.show(currentTabId, '!bookmarks ')
    })
  }
  if (searchButton) {
    searchButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tabEditor = require('navbar/tabEditor.js')
      tabEditor.show(currentTabId)
    })
  }
  if (historyButton) {
    historyButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tabEditor = require('navbar/tabEditor.js')
      tabEditor.show(currentTabId, '!history ')
    })
  }
  if (extensionsButton) {
    extensionsButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tabEditor = require('navbar/tabEditor.js')
      tabEditor.show(currentTabId, '!extensions ')
    })
  }
  if (downloadsButton) {
    downloadsButton.addEventListener('click', function () {
      if (!tabs || !tabs.getSelected) {
        return
      }
      var currentTabId = tabs.getSelected()
      if (!currentTabId) {
        return
      }
      var tabEditor = require('navbar/tabEditor.js')
      tabEditor.show(currentTabId, '!download ')
    })
  }
})()

;(function () {
  var container = document.querySelector('.navbar-right-actions')
  if (!container) {
    return
  }

  var buttons = Array.from(container.querySelectorAll('.navbar-action-button'))
  var buttonIds = buttons.map(function (button) {
    return button.id
  }).filter(function (id) {
    return !!id
  })

  if (!buttonIds.length) {
    return
  }

  var settings
  try {
    settings = require('util/settings/settings.js')
  } catch (e) {
    settings = null
  }

  function applyNavbarActions (value) {
    var enabled = Array.isArray(value) && value.length ? value.filter(function (id) {
      return buttonIds.indexOf(id) !== -1
    }) : buttonIds.slice()

    buttonIds.forEach(function (id) {
      if (enabled.indexOf(id) === -1 && (!value || !Array.isArray(value))) {
        enabled.push(id)
      }
    })

    var enabledSet = {}
    enabled.forEach(function (id) {
      enabledSet[id] = true
    })

    enabled.forEach(function (id) {
      var el = document.getElementById(id)
      if (el && el.parentElement === container) {
        container.appendChild(el)
        el.hidden = false
      }
    })

    buttonIds.forEach(function (id) {
      if (!enabledSet[id]) {
        var el = document.getElementById(id)
        if (el && el.parentElement === container) {
          el.hidden = true
        }
      }
    })
  }

  if (settings && settings.get) {
    applyNavbarActions(settings.get('navbarRightActions'))
  } else {
    applyNavbarActions(null)
  }

  if (settings && settings.listen) {
    settings.listen('navbarRightActions', function (value) {
      applyNavbarActions(value)
    })
  }
})()

;(function () {
  var sidebar = document.getElementById('deepseek-sidebar')
  var toggleButton = document.getElementById('extra-titlebar-button')
  var sidebarWebview = document.getElementById('deepseek-sidebar-webview')
  if (!sidebar || !toggleButton || !sidebarWebview) {
    return
  }

  var isShown = false
  var sidebarMargin = 0
  var sidebarMarginAnimationFrame = null
  var webviews = null
  var settings = null
  var sidebarTransitionDuration = 100

  try {
    webviews = require('webviews.js')
  } catch (e) {
    webviews = null
  }

  function animateSidebarMargin (from, to, duration, onDone) {
    if (sidebarMarginAnimationFrame) {
      cancelAnimationFrame(sidebarMarginAnimationFrame)
      sidebarMarginAnimationFrame = null
    }
    if (!webviews || !webviews.adjustMargin || from === to || duration <= 0) {
      var instantDelta = to - from
      if (instantDelta && webviews && webviews.adjustMargin) {
        webviews.adjustMargin([0, instantDelta, 0, 0])
      }
      sidebarMargin = to
      if (onDone) {
        onDone()
      }
      return
    }

    var start = performance.now()
    var last = from

    function step (now) {
      var t = Math.min(1, (now - start) / duration)
      var eased = 1 - Math.pow(1 - t, 3)
      var current = from + (to - from) * eased
      var delta = current - last
      if (delta) {
        webviews.adjustMargin([0, delta, 0, 0])
      }
      last = current
      sidebarMargin = current
      if (t < 1) {
        sidebarMarginAnimationFrame = requestAnimationFrame(step)
      } else {
        sidebarMarginAnimationFrame = null
        sidebarMargin = to
        if (onDone) {
          onDone()
        }
      }
    }

    sidebarMarginAnimationFrame = requestAnimationFrame(step)
  }

  try {
    settings = require('util/settings/settings.js')
  } catch (e) {
    settings = null
  }

  function getAISidebarURL () {
    var provider = 'doubao'
    if (settings && settings.get) {
      try {
        provider = settings.get('aiSidebarProvider') || 'doubao'
      } catch (e) {}
    }

    if (provider === 'deepseek' || provider === 'yuanbao') {
      return 'https://yuanbao.tencent.com/'
    }
    if (provider === 'chatgpt') {
      return 'https://chatgpt.com/'
    }
    if (provider === 'claude') {
      return 'https://claude.ai/new'
    }
    if (provider === 'gemini') {
      return 'https://gemini.google.com/app'
    }
    if (provider === 'qwen') {
      return 'https://chat.qwen.ai/'
    }
    return 'https://www.doubao.com/'
  }

  if (sidebarWebview && sidebarWebview.addEventListener) {
    try {
      sidebarWebview.setAttribute('src', getAISidebarURL())
    } catch (e) {}

    sidebarWebview.addEventListener('new-window', function (e) {
      if (e.preventDefault) {
        e.preventDefault()
      }
      if (e.url && sidebarWebview.loadURL) {
        sidebarWebview.loadURL(e.url)
      }
    })

    sidebarWebview.addEventListener('dom-ready', function () {
      try {
        if (sidebarWebview.executeJavaScript) {
          sidebarWebview.executeJavaScript(
            'try { window.open = function (url, target, features) { if (url) { window.location.href = url } return null } } catch (e) {}',
            false
          )
        }
      } catch (e) {}
    })
  }

  if (settings && settings.listen) {
    settings.listen('aiSidebarProvider', function () {
      if (!sidebarWebview) {
        return
      }
      var url = getAISidebarURL()
      try {
        if (sidebarWebview.loadURL) {
          sidebarWebview.loadURL(url)
          return
        }
      } catch (e) {}
      try {
        if (sidebarWebview.setAttribute) {
          sidebarWebview.setAttribute('src', url)
        }
      } catch (e) {}
    })
  }

  function showSidebar () {
    if (isShown) {
      return
    }

    sidebar.hidden = false

    var width = sidebar.offsetWidth || 420
    var safeMargin = 1
    var targetMargin = width + safeMargin
    var currentMargin = (webviews && webviews.viewMargins) ? webviews.viewMargins[1] : sidebarMargin
    animateSidebarMargin(currentMargin, targetMargin, sidebarTransitionDuration)

    document.body.classList.add('deepseek-sidebar-is-shown')

    requestAnimationFrame(function () {
      sidebar.classList.add('visible')
    })

    isShown = true
  }

  function hideSidebar () {
    if (!isShown) {
      return
    }

    sidebar.classList.remove('visible')

    var currentMargin = (webviews && webviews.viewMargins) ? webviews.viewMargins[1] : sidebarMargin
    animateSidebarMargin(currentMargin, 0, sidebarTransitionDuration)

    document.body.classList.remove('deepseek-sidebar-is-shown')

    isShown = false
  }

  toggleButton.addEventListener('click', function () {
    if (isShown) {
      hideSidebar()
    } else {
      showSidebar()
    }
  })
})()

// once everything's loaded, start the session
require('sessionRestore.js').restore()
