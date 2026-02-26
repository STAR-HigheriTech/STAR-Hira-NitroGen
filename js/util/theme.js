if (typeof require !== 'undefined') {
  var settings = require('util/settings/settings.js')
}

var lightThemePresetKeys = ['softWhite', 'mint', 'warmGray', 'sakura']
var currentLightThemePreset = 'default'
var currentLightThemeCustomColor = null

function applyLightTheme () {
  if (window.isDarkMode) {
    return
  }

  var root = document.documentElement
  var body = document.body

  lightThemePresetKeys.forEach(function (key) {
    body.classList.remove('light-theme-' + key)
  })

  root.style.removeProperty('--main-bg-color')

  if (currentLightThemePreset === 'custom') {
    if (currentLightThemeCustomColor) {
      root.style.setProperty('--main-bg-color', currentLightThemeCustomColor)
    }
    return
  }

  if (currentLightThemePreset && currentLightThemePreset !== 'default') {
    body.classList.add('light-theme-' + currentLightThemePreset)
  }
}

function enableDarkMode () {
  document.body.classList.add('dark-mode')
  window.isDarkMode = true
  requestAnimationFrame(function () {
    window.dispatchEvent(new CustomEvent('themechange'))
  })
}

function disableDarkMode () {
  document.body.classList.remove('dark-mode')
  window.isDarkMode = false
  applyLightTheme()
  requestAnimationFrame(function () {
    window.dispatchEvent(new CustomEvent('themechange'))
  })
}

function initialize () {
  function themeChanged (value) {
    if (value === true) {
      enableDarkMode()
    } else {
      disableDarkMode()
    }
  }

  settings.listen('darkThemeIsActive', themeChanged)

  settings.listen('lightThemePreset', function (value) {
    currentLightThemePreset = value || 'default'
    applyLightTheme()
    requestAnimationFrame(function () {
      window.dispatchEvent(new CustomEvent('themechange'))
    })
  })

  settings.listen('lightThemeCustomColor', function (value) {
    currentLightThemeCustomColor = value
    applyLightTheme()
    requestAnimationFrame(function () {
      window.dispatchEvent(new CustomEvent('themechange'))
    })
  })
}

if (typeof module !== 'undefined') {
  module.exports = { initialize }
} else {
  initialize()
}
