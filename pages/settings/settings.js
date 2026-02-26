document.title = l('settingsPreferencesHeading') + ' | Hira'

var contentTypeBlockingContainer = document.getElementById('content-type-blocking')
var banner = document.getElementById('restart-required-banner')
var showDividerCheckbox = document.getElementById('checkbox-show-divider')
var userscriptsCheckbox = document.getElementById('checkbox-userscripts')
var userscriptsShowDirectorySection = document.getElementById('userscripts-show-directory')
var separateTitlebarCheckbox = document.getElementById('checkbox-separate-titlebar')
var windowControlsStyleSelect = document.getElementById('window-controls-style')
var windowControlsPositionSelect = document.getElementById('window-controls-position')
var navbarActionsList = document.getElementById('navbar-actions-list')
var openTabsInForegroundCheckbox = document.getElementById('checkbox-open-tabs-in-foreground')
var autoPlayCheckbox = document.getElementById('checkbox-enable-autoplay')
var userAgentCheckbox = document.getElementById('checkbox-user-agent')
var userAgentInput = document.getElementById('input-user-agent')
var extensionsSection = document.getElementById('extensions-settings-section')
var extensionsList = document.getElementById('extensions-list')
var extensionsImportButton = document.getElementById('extensions-import-button')
var extensionsImportCrxButton = document.getElementById('extensions-import-crx-button')
var lightThemePresetButtonsContainer = document.getElementById('light-theme-preset-buttons')
var lightThemePresetButtons = lightThemePresetButtonsContainer ? Array.from(lightThemePresetButtonsContainer.querySelectorAll('.light-theme-preset-button')) : []
var lightThemeCustomSection = document.getElementById('light-theme-custom-section')
var lightThemeCustomColorInput = document.getElementById('light-theme-custom-color')
var lightThemeCustomSwatch = document.getElementById('light-theme-custom-swatch')
var settingsSidebar = document.getElementById('settings-sidebar')
var settingsMain = document.getElementById('settings-main')
var aboutCheckUpdatesButton = document.getElementById('about-check-updates-button')
var settingsContainers = Array.from(document.querySelectorAll('.settings-container'))

function showRestartRequiredBanner () {
  banner.hidden = false
  settings.set('restartNow', true)
}
settings.get('restartNow', (value) => {
  if (value === true) {
    showRestartRequiredBanner()
  }
})

/* content blocking settings */

var trackingLevelContainer = document.getElementById('tracking-level-container')
var trackingLevelOptions = Array.from(trackingLevelContainer.querySelectorAll('input[name=blockingLevel]'))
var blockingExceptionsContainer = document.getElementById('content-blocking-information')
var blockingExceptionsInput = document.getElementById('content-blocking-exceptions')
var blockedRequestCount = document.querySelector('#content-blocking-blocked-requests strong')

settings.listen('filteringBlockedCount', function (value) {
  var count = value || 0
  var valueStr
  if (count > 50000) {
    valueStr = new Intl.NumberFormat(navigator.locale, { notation: 'compact', maximumSignificantDigits: 4 }).format(count)
  } else {
    valueStr = new Intl.NumberFormat().format(count)
  }
  blockedRequestCount.textContent = valueStr
})

function updateBlockingLevelUI (level) {
  var radio = trackingLevelOptions[level]
  radio.checked = true

  if (level === 0) {
    blockingExceptionsContainer.hidden = true
  } else {
    blockingExceptionsContainer.hidden = false
    radio.parentNode.appendChild(blockingExceptionsContainer)
  }

  if (document.querySelector('#tracking-level-container .setting-option.selected')) {
    document.querySelector('#tracking-level-container .setting-option.selected').classList.remove('selected')
  }
  radio.parentNode.classList.add('selected')
}

function changeBlockingLevelSetting (level) {
  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.blockingLevel = level
    settings.set('filtering', value)
    updateBlockingLevelUI(level)
  })
}

function setExceptionInputSize () {
  blockingExceptionsInput.style.height = (blockingExceptionsInput.scrollHeight + 2) + 'px'
}

settings.get('filtering', function (value) {
  // migrate from old settings (<v1.9.0)
  if (value && typeof value.trackers === 'boolean') {
    if (value.trackers === true) {
      value.blockingLevel = 2
    } else if (value.trackers === false) {
      value.blockingLevel = 0
    }
    delete value.trackers
    settings.set('filtering', value)
  }

  if (value && value.blockingLevel !== undefined) {
    updateBlockingLevelUI(value.blockingLevel)
  } else {
    updateBlockingLevelUI(1)
  }

  if (value && value.exceptionDomains && value.exceptionDomains.length > 0) {
    blockingExceptionsInput.value = value.exceptionDomains.join(', ') + ', '
    setExceptionInputSize()
  }
})

trackingLevelOptions.forEach(function (item, idx) {
  item.addEventListener('change', function () {
    changeBlockingLevelSetting(idx)
  })
})

blockingExceptionsInput.addEventListener('input', function () {
  setExceptionInputSize()

  // remove protocols because of https://github.com/minbrowser/min/issues/1428
  var newValue = this.value.split(',').map(i => i.trim().replace('http://', '').replace('https://', '')).filter(i => !!i)

  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.exceptionDomains = newValue
    settings.set('filtering', value)
  })
})

function scrollToSettingsSection (targetSelector) {
  if (!settingsMain) {
    return
  }
  var target = document.querySelector(targetSelector)
  if (!target) {
    return
  }
  var rect = target.getBoundingClientRect()
  var containerRect = settingsMain.getBoundingClientRect()
  var currentScroll = settingsMain.scrollTop
  var offset = rect.top - containerRect.top - 16
  settingsMain.scrollTo({
    top: currentScroll + offset,
    behavior: 'smooth'
  })
}

function showSettingsGroup (group) {
  if (!group || settingsContainers.length === 0) {
    return
  }
  var visibleIds = []
  if (group === 'basic') {
    visibleIds = ['appearance-settings-container', 'search-engine-settings-container', 'additional-settings-container']
  } else if (group === 'advanced') {
    visibleIds = ['privacy-settings-container', 'proxy-settings-container', 'password-autofill-container']
  } else if (group === 'ai') {
    visibleIds = ['ai-extensions-settings-container', 'extensions-settings-container']
  } else if (group === 'tools') {
    visibleIds = ['translation-settings-container', 'keymap-settings-container', 'custom-bangs-container']
  } else if (group === 'about') {
    visibleIds = ['about-updates-container']
  }
  settingsContainers.forEach(function (container) {
    if (visibleIds.indexOf(container.id) !== -1) {
      container.style.display = ''
    } else {
      container.style.display = 'none'
    }
  })
  settingsMain.scrollTop = 0
}

if (settingsSidebar && settingsMain) {
  var sidebarItems = Array.from(settingsSidebar.querySelectorAll('.settings-sidebar-item'))
  var hash = window.location.hash
  if (hash === '#about') {
    var aboutItem = sidebarItems.find(function (item) {
      return item.getAttribute('data-group') === 'about'
    })
    if (aboutItem) {
      sidebarItems.forEach(function (el) {
        el.classList.remove('is-active')
      })
      aboutItem.classList.add('is-active')
    }
  }
  var activeItem = sidebarItems.find(function (item) {
    return item.classList.contains('is-active')
  })
  if (activeItem) {
    var initialGroup = activeItem.getAttribute('data-group')
    if (initialGroup) {
      showSettingsGroup(initialGroup)
    }
  }
  sidebarItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var target = item.getAttribute('data-target')
      if (!target) {
        return
      }
      var group = item.getAttribute('data-group')
      sidebarItems.forEach(function (el) {
        el.classList.remove('is-active')
      })
      item.classList.add('is-active')
      if (group) {
        showSettingsGroup(group)
      }
      scrollToSettingsSection(target)
    })
  })
}

if (aboutCheckUpdatesButton) {
  aboutCheckUpdatesButton.addEventListener('click', function () {
    window.open('https://www.higheri.tech', '_blank')
  })
}

/* content type settings */

var contentTypes = {
  // humanReadableName: contentType
  scripts: 'script',
  images: 'image'
}

// used for showing localized strings
var contentTypeSettingNames = {
  scripts: 'settingsBlockScriptsToggle',
  images: 'settingsBlockImagesToggle'
}

for (var contentType in contentTypes) {
  (function (contentType) {
    settings.get('filtering', function (value) {
      // create the settings section for blocking each content type

      var section = document.createElement('div')
      section.classList.add('setting-section')

      var id = 'checkbox-block-' + contentTypes[contentType]

      var checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.id = id

      if (value && value.contentTypes) {
        checkbox.checked = value.contentTypes.indexOf(contentTypes[contentType]) != -1
      }

      var label = document.createElement('label')
      label.setAttribute('for', id)
      label.textContent = l(contentTypeSettingNames[contentType])

      section.appendChild(checkbox)
      section.appendChild(label)

      contentTypeBlockingContainer.appendChild(section)

      checkbox.addEventListener('change', function (e) {
        settings.get('filtering', function (value) {
          if (!value) {
            value = {}
          }
          if (!value.contentTypes) {
            value.contentTypes = []
          }

          if (e.target.checked) { // add the item to the array
            value.contentTypes.push(contentTypes[contentType])
          } else { // remove the item from the array
            var idx = value.contentTypes.indexOf(contentTypes[contentType])
            value.contentTypes.splice(idx, 1)
          }

          settings.set('filtering', value)
        })
      })
    })
  })(contentType)
}

/* dark mode setting */
var darkModeNever = document.getElementById('dark-mode-never')
var darkModeNight = document.getElementById('dark-mode-night')
var darkModeAlways = document.getElementById('dark-mode-always')
var darkModeSystem = document.getElementById('dark-mode-system')

// -1 - off ; 0 - auto ; 1 - on
settings.get('darkMode', function (value) {
  darkModeNever.checked = (value === -1)
  darkModeNight.checked = (value === 0)
  darkModeAlways.checked = (value === 1 || value === true)
  darkModeSystem.checked = (value === 2 || value === undefined || value === false)
})

darkModeNever.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', -1)
  }
})
darkModeNight.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 0)
  }
})
darkModeAlways.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 1)
  }
})
darkModeSystem.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 2)
  }
})

function updateLightThemeCustomSectionVisibility (preset) {
  if (!lightThemeCustomSection) {
    return
  }
  lightThemeCustomSection.hidden = preset !== 'custom'
}

function updateLightThemePresetButtonsUI (preset) {
  if (!lightThemePresetButtons || lightThemePresetButtons.length === 0) {
    return
  }
  lightThemePresetButtons.forEach(function (button) {
    var buttonPreset = button.getAttribute('data-preset') || 'default'
    if (buttonPreset === preset) {
      button.classList.add('active')
    } else {
      button.classList.remove('active')
    }
  })
}

if (lightThemeCustomColorInput) {
  settings.get('lightThemePreset', function (value) {
    var preset = value || 'default'
    updateLightThemeCustomSectionVisibility(preset)
    updateLightThemePresetButtonsUI(preset)
  })

  settings.get('lightThemeCustomColor', function (value) {
    if (typeof value === 'string' && value) {
      lightThemeCustomColorInput.value = value
    } else {
      lightThemeCustomColorInput.value = '#eef6ff'
    }
  })

  lightThemeCustomColorInput.addEventListener('change', function () {
    var color = this.value
    settings.set('lightThemeCustomColor', color)
  })
}

if (lightThemePresetButtons && lightThemePresetButtons.length) {
  lightThemePresetButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var preset = button.getAttribute('data-preset') || 'default'
      settings.set('lightThemePreset', preset)
      updateLightThemeCustomSectionVisibility(preset)
      updateLightThemePresetButtonsUI(preset)
      if (preset === 'custom' && lightThemeCustomColorInput) {
        lightThemeCustomColorInput.focus()
      }
    })
  })
}

/* startup settings */

var startupSettingInput = document.getElementById('startup-options')

settings.get('startupTabOption', function(value = 2) {
  startupSettingInput.value = value
})

startupSettingInput.addEventListener('change', function() {
  settings.set('startupTabOption', parseInt(this.value))
})

/* new window settings */

var newWindowSettingInput = document.getElementById('new-window-options')

settings.get('newWindowOption', function(value = 1) {
  newWindowSettingInput.value = value
})

newWindowSettingInput.addEventListener('change', function() {
  settings.set('newWindowOption', parseInt(this.value))
})

/* AI sidebar settings */

var aiSidebarProviderInput = document.getElementById('ai-sidebar-provider')

if (aiSidebarProviderInput) {
  settings.get('aiSidebarProvider', function (value) {
    aiSidebarProviderInput.value = value || 'doubao'
  })

  aiSidebarProviderInput.addEventListener('change', function () {
    settings.set('aiSidebarProvider', this.value)
  })
}

/* userscripts setting */

settings.get('userscriptsEnabled', function (value) {
  if (value === true) {
    userscriptsCheckbox.checked = true
    userscriptsShowDirectorySection.hidden = false
  }
})

userscriptsCheckbox.addEventListener('change', function (e) {
  settings.set('userscriptsEnabled', this.checked)
  userscriptsShowDirectorySection.hidden = !this.checked
})

userscriptsShowDirectorySection.getElementsByTagName('a')[0].addEventListener('click', function() {
  postMessage({ message: 'showUserscriptDirectory' })
})

function updateExtensionsUI (items) {
  while (extensionsList.firstChild) {
    extensionsList.removeChild(extensionsList.firstChild)
  }

  var list = Array.isArray(items) ? items : []

  if (list.length === 0) {
    var empty = document.createElement('div')
    empty.textContent = '尚未导入扩展'
    extensionsList.appendChild(empty)
    return
  }

  list.forEach(function (item) {
    if (!item) {
      return
    }

    var row = document.createElement('div')
    row.classList.add('setting-option')
    row.classList.add('extension-card')

    var name = document.createElement('span')
    name.textContent = item.name || item.id || item.path || ''

    var status = document.createElement('span')
    status.style.marginLeft = '1em'
    status.textContent = item.enabled === false ? '已禁用' : '已启用'

    var toggleButton = document.createElement('button')
    toggleButton.classList.add('settings-primary-button')
    toggleButton.style.marginLeft = '1em'
    toggleButton.textContent = item.enabled === false ? '启用' : '禁用'
    toggleButton.addEventListener('click', function () {
      postMessage({
        message: 'toggleExtension',
        id: item.id,
        enabled: item.enabled === false
      })
    })

    var removeButton = document.createElement('button')
    removeButton.classList.add('settings-primary-button')
    removeButton.style.marginLeft = '0.5em'
    removeButton.textContent = '删除'
    removeButton.addEventListener('click', function () {
      var confirmed = confirm('确定要删除该扩展吗？')
      if (!confirmed) {
        return
      }
      postMessage({
        message: 'removeExtension',
        id: item.id
      })
    })

    var popupButton = document.createElement('button')
    popupButton.classList.add('settings-primary-button')
    popupButton.style.marginLeft = '0.5em'
    popupButton.textContent = '弹窗'
    popupButton.disabled = item.enabled === false
    popupButton.addEventListener('click', function () {
      postMessage({
        message: 'openExtensionPopup',
        id: item.id
      })
    })

    var optionsButton = document.createElement('button')
    optionsButton.classList.add('settings-primary-button')
    optionsButton.style.marginLeft = '0.5em'
    optionsButton.textContent = '设置'
    optionsButton.addEventListener('click', function () {
      postMessage({
        message: 'openExtensionOptions',
        id: item.id
      })
    })

    row.appendChild(name)
    row.appendChild(status)
    row.appendChild(toggleButton)
    row.appendChild(removeButton)
    row.appendChild(popupButton)
    row.appendChild(optionsButton)
    extensionsList.appendChild(row)
  })
}

if (extensionsSection && extensionsList && extensionsImportButton && extensionsImportCrxButton) {
  document.getElementById('extensions-settings-label').textContent = '扩展管理'
  extensionsImportButton.textContent = '添加解压缩后的扩展文件夹'

  extensionsImportButton.addEventListener('click', function () {
    postMessage({ message: 'importExtension' })
  })

  extensionsImportCrxButton.textContent = '从 CRX 文件导入'

  extensionsImportCrxButton.addEventListener('click', function () {
    postMessage({ message: 'importExtensionCrx' })
  })

  settings.listen('browserExtensions', function (value) {
    updateExtensionsUI(value)
  })
}

/* show divider between tabs setting */

settings.get('showDividerBetweenTabs', function (value) {
  if (value === true) {
    showDividerCheckbox.checked = true
  }
})

showDividerCheckbox.addEventListener('change', function (e) {
  settings.set('showDividerBetweenTabs', this.checked)
})

if (navbarActionsList) {
  var navbarActionRows = Array.from(navbarActionsList.querySelectorAll('.navbar-action-setting'))
  var defaultNavbarActionsOrder = navbarActionRows.map(function (row) {
    return row.getAttribute('data-action-id')
  }).filter(function (id) {
    return !!id
  })

  function saveNavbarActionsSetting () {
    var rows = Array.from(navbarActionsList.querySelectorAll('.navbar-action-setting'))
    var enabled = []
    rows.forEach(function (row) {
      var id = row.getAttribute('data-action-id')
      var checkbox = row.querySelector('input[type="checkbox"]')
      if (id && checkbox && checkbox.checked) {
        enabled.push(id)
      }
    })
    settings.set('navbarRightActions', enabled)
  }

  function applyNavbarActionsUI (value) {
    var enabled = Array.isArray(value) && value.length ? value.filter(function (id) {
      return defaultNavbarActionsOrder.indexOf(id) !== -1
    }) : defaultNavbarActionsOrder.slice()

    defaultNavbarActionsOrder.forEach(function (id) {
      if (enabled.indexOf(id) === -1 && (!value || !Array.isArray(value))) {
        enabled.push(id)
      }
    })

    enabled.forEach(function (id) {
      var row = navbarActionsList.querySelector('[data-action-id="' + id + '"]')
      if (row) {
        navbarActionsList.appendChild(row)
      }
    })

    var enabledSet = {}
    enabled.forEach(function (id) {
      enabledSet[id] = true
    })

    navbarActionRows.forEach(function (row) {
      var id = row.getAttribute('data-action-id')
      var checkbox = row.querySelector('input[type="checkbox"]')
      if (!checkbox) {
        return
      }
      if (enabledSet[id]) {
        checkbox.checked = true
      } else {
        checkbox.checked = false
      }
    })
  }

  settings.get('navbarRightActions', function (value) {
    applyNavbarActionsUI(value)
  })

  navbarActionRows.forEach(function (row) {
    var checkbox = row.querySelector('input[type="checkbox"]')
    var moveUpButton = row.querySelector('.navbar-action-move-up')
    var moveDownButton = row.querySelector('.navbar-action-move-down')

    if (checkbox) {
      checkbox.addEventListener('change', function () {
        saveNavbarActionsSetting()
      })
    }

    if (moveUpButton) {
      moveUpButton.addEventListener('click', function () {
        var previous = row.previousElementSibling
        if (previous && previous.classList.contains('navbar-action-setting')) {
          navbarActionsList.insertBefore(row, previous)
          saveNavbarActionsSetting()
        }
      })
    }

    if (moveDownButton) {
      moveDownButton.addEventListener('click', function () {
        var next = row.nextElementSibling
        if (next && next.classList.contains('navbar-action-setting')) {
          navbarActionsList.insertBefore(next, row)
          saveNavbarActionsSetting()
        }
      })
    }
  })
}

/* language setting*/

var languagePicker = document.getElementById('setting-language-picker')

for (var language in languages) { //from localization.build.js
  var item = document.createElement('option')
  item.textContent = languages[language].name
  item.value = languages[language].identifier
  languagePicker.appendChild(item)
}

languagePicker.value = getCurrentLanguage()

languagePicker.addEventListener('change', function () {
  settings.set('userSelectedLanguage', this.value)
  showRestartRequiredBanner()
})

/* separate titlebar setting */

settings.get('useSeparateTitlebar', function (value) {
  if (value === true) {
    separateTitlebarCheckbox.checked = true
  }
})

separateTitlebarCheckbox.addEventListener('change', function (e) {
  settings.set('useSeparateTitlebar', this.checked)
  showRestartRequiredBanner()
})

function getDefaultWindowControlsPosition (style) {
  return style === 'windows' ? 'right' : 'left'
}

if (windowControlsStyleSelect && windowControlsPositionSelect) {
  settings.get('windowControlsStyle', function (value) {
    var styleValue = value
    if (!styleValue) {
      styleValue = window.platformType === 'windows' ? 'windows' : 'traffic-lights'
    }
    windowControlsStyleSelect.value = styleValue
    if (!windowControlsPositionSelect.value) {
      windowControlsPositionSelect.value = getDefaultWindowControlsPosition(styleValue)
    }
  })

  settings.get('windowControlsPosition', function (value) {
    if (value) {
      windowControlsPositionSelect.value = value
    } else if (!windowControlsPositionSelect.value) {
      var currentStyle = windowControlsStyleSelect.value || (window.platformType === 'windows' ? 'windows' : 'traffic-lights')
      windowControlsPositionSelect.value = getDefaultWindowControlsPosition(currentStyle)
    }
  })

  windowControlsStyleSelect.addEventListener('change', function () {
    settings.set('windowControlsStyle', this.value)
    if (!windowControlsPositionSelect.value) {
      windowControlsPositionSelect.value = getDefaultWindowControlsPosition(this.value)
    }
  })

  windowControlsPositionSelect.addEventListener('change', function () {
    settings.set('windowControlsPosition', this.value)
  })
}

/* tabs in foreground setting */

settings.get('openTabsInForeground', function (value) {
  if (value === true) {
    openTabsInForegroundCheckbox.checked = true
  }
})

openTabsInForegroundCheckbox.addEventListener('change', function (e) {
  settings.set('openTabsInForeground', this.checked)
})

/* media autoplay setting */

settings.get('enableAutoplay', function (value) {
  if (value === false) {
    autoPlayCheckbox.checked = false
  } else {
    autoPlayCheckbox.checked = true
  }
})

autoPlayCheckbox.addEventListener('change', function (e) {
  settings.set('enableAutoplay', this.checked)
})

/* user agent settting */

settings.get('customUserAgent', function (value) {
  if (value) {
    userAgentCheckbox.checked = true
    userAgentInput.style.visibility = 'visible'
    userAgentInput.value = value
  }
})

userAgentCheckbox.addEventListener('change', function (e) {
  if (this.checked) {
    userAgentInput.style.visibility = 'visible'
  } else {
    settings.set('customUserAgent', null)
    userAgentInput.style.visibility = 'hidden'
    showRestartRequiredBanner()
  }
})

userAgentInput.addEventListener('input', function (e) {
  const value = this.value.slice(0, 200)
  if (value !== this.value) {
    this.value = value
  }
  if (value) {
    settings.set('customUserAgent', value)
  } else {
    settings.set('customUserAgent', null)
  }
  showRestartRequiredBanner()
})

/* translation API settings (local model, no configuration required) */

/* default search engine setting */

var searchEngineDropdown = document.getElementById('default-search-engine')
var searchEngineInput = document.getElementById('custom-search-engine')

searchEngineInput.setAttribute('placeholder', l('customSearchEngineDescription'))

settings.onLoad(function () {
  if (currentSearchEngine.custom) {
    searchEngineInput.hidden = false
    searchEngineInput.value = currentSearchEngine.searchURL
  }

  for (var searchEngine in searchEngines) {
    var item = document.createElement('option')
    item.textContent = searchEngines[searchEngine].name

    if (searchEngines[searchEngine].name == currentSearchEngine.name) {
      item.setAttribute('selected', 'true')
    }

    searchEngineDropdown.appendChild(item)
  }

  // add custom option
  item = document.createElement('option')
  item.textContent = 'custom'
  if (currentSearchEngine.custom) {
    item.setAttribute('selected', 'true')
  }
  searchEngineDropdown.appendChild(item)
})

searchEngineDropdown.addEventListener('change', function (e) {
  if (this.value === 'custom') {
    searchEngineInput.hidden = false
  } else {
    searchEngineInput.hidden = true
    settings.set('searchEngine', { name: this.value })
  }
})

searchEngineInput.addEventListener('input', function (e) {
  settings.set('searchEngine', { url: this.value })
})

/* key map settings */

settings.get('keyMap', function (keyMapSettings) {
  var keyMap = userKeyMap(keyMapSettings)

  var keyMapList = document.getElementById('key-map-list')

  Object.keys(keyMap).forEach(function (action) {
    var li = createKeyMapListItem(action, keyMap)
    keyMapList.appendChild(li)
  })
})

function formatCamelCase (text) {
  var result = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  return result.charAt(0).toUpperCase() + result.slice(1)
}

function createKeyMapListItem (action, keyMap) {
  var li = document.createElement('li')
  var label = document.createElement('label')
  var input = document.createElement('input')
  label.innerText = formatCamelCase(action)
  label.htmlFor = action

  input.type = 'text'
  input.id = input.name = action
  input.value = formatKeyValue(keyMap[action])
  input.addEventListener('input', onKeyMapChange)

  li.appendChild(label)
  li.appendChild(input)

  return li
}

function formatKeyValue (value) {
  // multiple shortcuts should be separated by commas
  if (value instanceof Array) {
    value = value.join(', ')
  }
  // use either command or ctrl depending on the platform
  if (navigator.platform === 'MacIntel') {
    value = value.replace(/\bmod\b/g, 'command')
  } else {
    value = value.replace(/\bmod\b/g, 'ctrl')
    value = value.replace(/\boption\b/g, 'alt')
  }
  if (navigator.platform === 'Win32') {
    value = value.replace(/\bsuper\b/g, 'win')
  }
  return value
}

function parseKeyInput (input) {
  // input may be a single mapping or multiple mappings comma separated.
  var parsed = input.toLowerCase().split(',')
  parsed = parsed.map(function (e) { return e.trim() })
  // Remove empty
  parsed = parsed.filter(Boolean)
  // convert key names back to generic equivalents
  parsed = parsed.map(function (e) {
    if (navigator.platform === 'MacIntel') {
      e = e.replace(/\b(command)|(cmd)\b/g, 'mod')
    } else {
      e = e.replace(/\b(control)|(ctrl)\b/g, 'mod')
      e = e.replace(/\balt\b/g, 'option')
      e = e.replace(/\bwin\b/g, 'super')
    }
    return e
  })
  return parsed.length > 1 ? parsed : parsed[0]
}

function onKeyMapChange (e) {
  var action = this.name
  var newValue = this.value

  settings.get('keyMap', function (keyMapSettings) {
    if (!keyMapSettings) {
      keyMapSettings = {}
    }

    keyMapSettings[action] = parseKeyInput(newValue)
    settings.set('keyMap', keyMapSettings)
    showRestartRequiredBanner()
  })
}

/* Password auto-fill settings  */

var passwordManagersDropdown = document.getElementById('selected-password-manager')
for (var manager in passwordManagers) {
  var item = document.createElement('option')
  item.textContent = passwordManagers[manager].name
  passwordManagersDropdown.appendChild(item)
}

settings.listen('passwordManager', function (value) {
  passwordManagersDropdown.value = currentPasswordManager.name
})

passwordManagersDropdown.addEventListener('change', function (e) {
  if (this.value === 'none') {
    settings.set('passwordManager', { name: 'none' })
  } else {
    settings.set('passwordManager', { name: this.value })
  }
})

var keychainViewLink = document.getElementById('keychain-view-link')

keychainViewLink.addEventListener('click', function () {
  postMessage({ message: 'showCredentialList' })
})

settings.listen('passwordManager', function (value) {
  keychainViewLink.hidden = !(currentPasswordManager.name === 'Built-in password manager')
})

/* proxy settings */

const proxyTypeInput = document.getElementById('selected-proxy-type')
const proxyInputs = Array.from(document.querySelectorAll('#proxy-settings-container input'))

const toggleProxyOptions = proxyType => {
  document.getElementById('manual-proxy-section').hidden = proxyType != 1
  document.getElementById('pac-option').hidden = proxyType != 2
}

const setProxy = (key, value) => {
  settings.get('proxy', (proxy = {}) => {
    proxy[key] = value
    settings.set('proxy', proxy)
  })
}

settings.get('proxy', (proxy = {}) => {
  toggleProxyOptions(proxy.type)

  proxyTypeInput.options.selectedIndex = proxy.type || 0
  proxyInputs.forEach(item => item.value = proxy[item.name] || '')
})

proxyTypeInput.addEventListener('change', e => {
  const proxyType = e.target.options.selectedIndex
  setProxy('type', proxyType)
  toggleProxyOptions(proxyType)
})

proxyInputs.forEach(item => item.addEventListener('change', e => setProxy(e.target.name, e.target.value)))

settings.get('customBangs', (value) => {
  const bangslist = document.getElementById('custom-bangs')

  if (value) {
    value.forEach(function (bang) {
      bangslist.appendChild(createBang(bang.phrase, bang.snippet, bang.redirect))
    })
  }
})

document.getElementById('add-custom-bang').addEventListener('click', function () {
  const bangslist = document.getElementById('custom-bangs')
  const newListItem = createBang()
  bangslist.appendChild(newListItem)
  document.body.scrollBy(0, Math.round(newListItem.getBoundingClientRect().height))
})

function createBang (bang, snippet, redirect) {
  var li = document.createElement('li')
  var bangInput = document.createElement('input')
  var snippetInput = document.createElement('input')
  var redirectInput = document.createElement('input')
  var xButton = document.createElement('button')
  var current = { phrase: bang ?? '', snippet: snippet ?? '', redirect: redirect ?? '' }
  function update (key, input) {
    settings.get('customBangs', function (d) {
      const filtered = d ? d.filter((bang) => bang.phrase !== current.phrase && (key !== 'phrase' || bang.phrase !== input.value)) : []
      filtered.push({ phrase: bangInput.value, snippet: snippetInput.value, redirect: redirectInput.value })
      settings.set('customBangs', filtered)
      current[key] = input.value
    })
  }

  bangInput.type = 'text'
  snippetInput.type = 'text'
  redirectInput.type = 'text'
  bangInput.value = bang ?? ''
  snippetInput.value = snippet ?? ''
  redirectInput.value = redirect ?? ''
  xButton.className = 'i carbon:close custom-bang-delete-button'

  bangInput.placeholder = l('settingsCustomBangsPhrase')
  snippetInput.placeholder = l('settingsCustomBangsSnippet')
  redirectInput.placeholder = l('settingsCustomBangsRedirect')
  xButton.addEventListener('click', function () {
    li.remove()
    settings.get('customBangs', (d) => {
      settings.set('customBangs', d.filter((bang) => bang.phrase !== bangInput.value))
    })
    showRestartRequiredBanner()
  })

  bangInput.addEventListener('change', function () {
    if (this.value.startsWith('!')) {
      this.value = this.value.slice(1)
    }
    update('phrase', bangInput)
    showRestartRequiredBanner()
  })
  snippetInput.addEventListener('change', function () {
    update('snippet', snippetInput)
    showRestartRequiredBanner()
  })
  redirectInput.addEventListener('change', function () {
    update('redirect', redirectInput)
    showRestartRequiredBanner()
  })

  li.appendChild(bangInput)
  li.appendChild(snippetInput)
  li.appendChild(redirectInput)
  li.appendChild(xButton)

  return li
}
