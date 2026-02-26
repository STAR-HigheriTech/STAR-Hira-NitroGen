;(function () {
  function applyShim (target) {
    if (!target || !target.storage) {
      return
    }
    if (!target.storage.local) {
      return
    }

    var local = target.storage.local
    var sync = {}

    ;['get', 'set', 'remove', 'clear'].forEach(function (key) {
      if (typeof local[key] === 'function') {
        sync[key] = function () {
          return local[key].apply(local, arguments)
        }
      }
    })

    target.storage.sync = sync
  }

  try {
    if (typeof window !== 'undefined') {
      if (window.chrome) {
        applyShim(window.chrome)
      }
      if (window.browser) {
        applyShim(window.browser)
      }
    } else if (typeof global !== 'undefined') {
      if (global.chrome) {
        applyShim(global.chrome)
      }
      if (global.browser) {
        applyShim(global.browser)
      }
    }
  } catch (e) {}
})()
