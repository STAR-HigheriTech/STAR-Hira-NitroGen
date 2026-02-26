// taskOverlay.js
// Lightweight script to make task sidebar behave like Meridian:
// - sidebar visible on start
// - body gets 'sidebar-open' so main content is pushed (CSS handles transform)
// - removes common screenshot/overlay placeholders
// - ensures webview/main content remains interactive
// - exposes API: TaskOverlay.open(), .close(), .toggle()

(function () {
  'use strict'
  const overlay = document.getElementById('task-overlay') || document.querySelector('.taskOverlay')
  const body = document.body
  const mainSelectors = ['.app', '#app', '.main', '#main', '#content', '#content-area', '#webview', '.webview', 'webview', '#webview-container', '.browser-window', '.web-contents']
  const removeOverlays = ['.screenshot', '.screenshot-overlay', '.webview-snapshot', '.webview-screenshot']

  function ensureOpen () {
    if (!overlay) return
    overlay.classList.add('visible')
    overlay.classList.remove('hidden')
    overlay.removeAttribute('hidden')
    body.classList.add('sidebar-open')
    body.classList.add('has-task-overlay-visible')

    // remove snapshot/placeholder overlays if present
    removeOverlays.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        try { el.remove() } catch (e) {}
      })
    })

    // ensure main webviews remain interactive and not visually blocked
    mainSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        try {
          el.style.pointerEvents = 'auto'
          // leave transform to CSS rules; ensure no temporary overlay opacity
          if (el.classList.contains('webview-snapshot') || el.classList.contains('screenshot-overlay')) {
            el.remove()
          }
        } catch (e) {}
      })
    })
  }

  function close () {
    if (!overlay) return
    overlay.classList.remove('visible')
    body.classList.remove('sidebar-open', 'has-task-overlay-visible')
  }

  function toggle () {
    if (!overlay) return
    if (overlay.classList.contains('visible')) close(); else ensureOpen()
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Make sidebar visible at startup (Meridian behavior)
    ensureOpen()
    // restore collapsed state for the narrow mode if previously set
    try {
      if (localStorage.getItem('taskCollapsed') === '1') overlay.classList.add('is-collapsed')
    } catch (e) {}
  })

  // Ctrl+B to toggle collapse (keeps parity with earlier suggestions)
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key && ev.key.toLowerCase() === 'b') {
      ev.preventDefault()
      // toggle collapsed, not full open/close
      if (!overlay) return
      overlay.classList.toggle('is-collapsed')
      try { localStorage.setItem('taskCollapsed', overlay.classList.contains('is-collapsed') ? '1' : '0') } catch (e) {}
    }
  })

  // expose small API for other scripts
  window.TaskOverlay = { open: ensureOpen, close, toggle }
})()
