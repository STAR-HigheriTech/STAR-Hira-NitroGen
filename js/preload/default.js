/* imports common modules */

var electron = require('electron')
var ipc = electron.ipcRenderer

var propertiesToClone = ['deltaX', 'deltaY', 'metaKey', 'ctrlKey', 'defaultPrevented', 'clientX', 'clientY']

function cloneEvent (e) {
  var obj = {}

  for (var i = 0; i < propertiesToClone.length; i++) {
    obj[propertiesToClone[i]] = e[propertiesToClone[i]]
  }
  return JSON.stringify(obj)
}

// workaround for Electron bug
setTimeout(function () {
  /* Used for swipe gestures */
  window.addEventListener('wheel', function (e) {
    ipc.send('wheel-event', cloneEvent(e))
  })

  var scrollTimeout = null

  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimeout)
    scrollTimeout = setTimeout(function () {
      ipc.send('scroll-position-change', Math.round(window.scrollY))
    }, 200)
  })
}, 0)

/* Used for picture in picture item in context menu */
ipc.on('getContextMenuData', function (event, data) {
  // check for video element to show picture-in-picture menu
  var hasVideo = Array.from(document.elementsFromPoint(data.x, data.y)).some(el => el.tagName === 'VIDEO')
  ipc.send('contextMenuData', { hasVideo })
})

ipc.on('enterPictureInPicture', function (event, data) {
  var videos = Array.from(document.elementsFromPoint(data.x, data.y)).filter(el => el.tagName === 'VIDEO')
  if (videos[0]) {
    videos[0].requestPictureInPicture()
  }
})

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data?.message === 'showCredentialList') {
    ipc.send('showCredentialList')
  }

  if (e.data?.message === 'showUserscriptDirectory') {
    ipc.send('showUserscriptDirectory')
  }

  if (e.data?.message === 'downloadFile') {
    ipc.send('downloadFile', e.data.url)
  }

  if (e.data?.message === 'importExtension') {
    ipc.send('importExtension')
  }

  if (e.data?.message === 'importExtensionCrx') {
    ipc.send('importExtensionCrx')
  }

  if (e.data?.message === 'removeExtension') {
    ipc.send('removeExtension', e.data.id)
  }

  if (e.data?.message === 'toggleExtension') {
    ipc.send('toggleExtension', {
      id: e.data.id,
      enabled: e.data.enabled
    })
  }

  if (e.data?.message === 'openExtensionOptions') {
    ipc.send('openExtensionOptions', e.data.id)
  }

  if (e.data?.message === 'openExtensionPopup') {
    ipc.send('openExtensionPopup', e.data.id)
  }

  if (e.data?.message === 'getDownloadHistory') {
    ipc.send('getDownloadHistory')
  }

  if (e.data?.message === 'clearDownloadHistory') {
    ipc.send('clearDownloadHistory')
  }

  if (e.data?.message === 'removeDownloadHistoryItem') {
    ipc.send('removeDownloadHistoryItem', e.data.path)
  }

  if (e.data?.message === 'showItemInFolder') {
    ipc.send('showItemInFolder', e.data.path)
  }
})

ipc.on('receiveDownloadHistory', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'receiveDownloadHistory', items: data }, window.location.toString())
  }
})

ipc.on('downloadHistoryCleared', function () {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'downloadHistoryCleared' }, window.location.toString())
  }
})

ipc.on('downloadHistoryItemRemoved', function (e, data) {
  if (window.location.toString().startsWith('min://')) {
    window.postMessage({ message: 'downloadHistoryItemRemoved', path: data && data.path }, window.location.toString())
  }
})
