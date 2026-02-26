var settings = require('util/settings/settings.js')

function initialize () {
  if (settings.get('useSeparateTitlebar') === true) {
    document.body.classList.add('separate-titlebar')
  }

  function applyWindowControlsClasses () {
    var style = settings.get('windowControlsStyle')
    if (!style) {
      style = window.platformType === 'windows' ? 'windows' : 'traffic-lights'
    }
    var position = settings.get('windowControlsPosition')
    if (!position) {
      position = style === 'windows' ? 'right' : 'left'
    }
    document.body.classList.remove('window-controls-traffic-lights', 'window-controls-windows', 'window-controls-left', 'window-controls-right')
    document.body.classList.add(style === 'windows' ? 'window-controls-windows' : 'window-controls-traffic-lights')
    document.body.classList.add(position === 'right' ? 'window-controls-right' : 'window-controls-left')
  }

  applyWindowControlsClasses()
  settings.listen('windowControlsStyle', applyWindowControlsClasses)
  settings.listen('windowControlsPosition', applyWindowControlsClasses)

  var windowIsMaximized = false
  var windowIsFullscreen = false

  var captionMinimize =
  document.querySelector('.windows-caption-buttons .caption-minimise, body.linux .titlebar-linux .caption-minimise')

  var captionMaximize =
  document.querySelector('.windows-caption-buttons .caption-maximize, body.linux .titlebar-linux .caption-maximize')

  var captionRestore =
  document.querySelector('.windows-caption-buttons .caption-restore, body.linux .titlebar-linux .caption-restore')

  var captionClose =
  document.querySelector('.windows-caption-buttons .caption-close, body.linux .titlebar-linux .caption-close')

  var linuxClose = document.querySelector('#linux-control-buttons #close-button')
  var linuxMinimize = document.querySelector('#linux-control-buttons #minimize-button')
  var linuxMaximize = document.querySelector('#linux-control-buttons #maximize-button')

  // macOS traffic light buttons
  var trafficLightClose = document.querySelector('#traffic-light-close')
  var trafficLightMinimize = document.querySelector('#traffic-light-minimize')
  var trafficLightMaximize = document.querySelector('#traffic-light-maximize')

  function updateCaptionButtons () {
    if (window.platformType === 'windows') {
      if (windowIsMaximized || windowIsFullscreen) {
        captionMaximize.hidden = true
        captionRestore.hidden = false
      } else {
        captionMaximize.hidden = false
        captionRestore.hidden = true
      }
    }
  }

  if (window.platformType === 'windows') {
    updateCaptionButtons()

    captionMinimize.addEventListener('click', function (e) {
      ipc.invoke('minimize')
    })

    captionMaximize.addEventListener('click', function (e) {
      ipc.invoke('maximize')
    })

    captionRestore.addEventListener('click', function (e) {
      if (windowIsFullscreen) {
        ipc.invoke('setFullScreen', false)
      } else {
        ipc.invoke('unmaximize')
      }
    })

    captionClose.addEventListener('click', function (e) {
      ipc.invoke('close')
    })
  }

  ipc.on('maximize', function (e) {
    windowIsMaximized = true
    updateCaptionButtons()
  })
  ipc.on('unmaximize', function (e) {
    windowIsMaximized = false
    updateCaptionButtons()
  })
  ipc.on('enter-full-screen', function (e) {
    windowIsFullscreen = true
    updateCaptionButtons()
  })
  ipc.on('leave-full-screen', function (e) {
    windowIsFullscreen = false
    updateCaptionButtons()
  })

  if (window.platformType === 'linux') {
    linuxClose.addEventListener('click', function (e) {
      ipc.invoke('close')
    })
    linuxMaximize.addEventListener('click', function (e) {
      if (windowIsFullscreen) {
        ipc.invoke('setFullScreen', false)
      } else if (windowIsMaximized) {
        ipc.invoke('unmaximize')
      } else {
        ipc.invoke('maximize')
      }
    })
    linuxMinimize.addEventListener('click', function (e) {
      ipc.invoke('minimize')
    })
  }

  // Add event listeners for traffic light buttons (all platforms)
  if (trafficLightClose) {
    trafficLightClose.addEventListener('click', function (e) {
      ipc.invoke('close')
    })
  }

  if (trafficLightMinimize) {
    trafficLightMinimize.addEventListener('click', function (e) {
      ipc.invoke('minimize')
    })
  }

  if (trafficLightMaximize) {
    trafficLightMaximize.addEventListener('click', function (e) {
      if (windowIsFullscreen) {
        ipc.invoke('setFullScreen', false)
      } else if (windowIsMaximized) {
        ipc.invoke('unmaximize')
      } else {
        ipc.invoke('maximize')
      }
    })
  }
}

module.exports = { initialize }
