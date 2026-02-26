const clipboard = electron.clipboard

const webviews = require('webviews.js')
const browserUI = require('browserUI.js')
const searchEngine = require('util/searchEngine.js')
const userscripts = require('userscripts.js')
const settings = require('util/settings/settings.js')
const pageTranslations = require('pageTranslations.js')
const PasswordManagers = require('passwordManager/passwordManager.js')
const urlParser = require('util/urlParser.js')
const findinpage = require('findinpage.js')
const PDFViewer = require('pdfViewer.js')
const readerView = require('readerView.js')
const webviewGestures = require('webviewGestures.js')
const modalMode = require('modalMode.js')

const remoteMenu = require('remoteMenuRenderer.js')

const webviewMenu = {
  menuData: null,
  showMenu: function (data, extraData) { // data comes from a context-menu event
    var currentTab = tabs.get(tabs.getSelected())

    var menuSections = []

    const openInBackground = !settings.get('openTabsInForeground')

    /* Picture in Picture */

    if (extraData.hasVideo) {
      menuSections.push([
        {
          label: l('pictureInPicture'),
          click: function () {
            webviews.callAsync(tabs.getSelected(), 'send', ['enterPictureInPicture', { x: data.x, y: data.y }])
          }
        }
      ])
    }

    /* Spellcheck */

    if (data.misspelledWord) {
      var suggestionEntries = data.dictionarySuggestions.slice(0, 3).map(function (suggestion) {
        return {
          label: suggestion,
          click: function () {
            webviews.callAsync(tabs.getSelected(), 'replaceMisspelling', suggestion)
          }
        }
      })

      // https://www.electronjs.org/docs/api/session#sesaddwordtospellcheckerdictionaryword
      // "This API will not work on non-persistent (in-memory) sessions"
      if (!currentTab.private) {
        suggestionEntries.push({
          label: l('addToDictionary'),
          click: function () {
            ipc.invoke('addWordToSpellCheckerDictionary', data.misspelledWord)
          }
        })
      }

      if (suggestionEntries.length > 0) {
        menuSections.push(suggestionEntries)
      }
    }

    /* links */

    var link = data.linkURL

    // show link items for embedded frames, but not the top-level page (which will also be listed as a frameURL)
    if (!link && data.frameURL && data.frameURL !== currentTab.url) {
      link = data.frameURL
    }

    if (link === 'about:srcdoc') {
      /* srcdoc is used in reader view, but it can't actually be opened anywhere outside of the reader page */
      link = null
    }

    if (link) {
      var linkActions = [
        {
          label: (link.length > 60) ? link.substring(0, 60) + '...' : link,
          enabled: false
        }
      ]

      if (!currentTab.private) {
        linkActions.push({
          label: l('openInNewTab'),
          click: function () {
            browserUI.addTab(tabs.add({ url: link }), { enterEditMode: false, openInBackground: openInBackground })
          }
        })
      }

      linkActions.push({
        label: l('openInNewPrivateTab'),
        click: function () {
          browserUI.addTab(tabs.add({ url: link, private: true }), { enterEditMode: false, openInBackground: openInBackground })
        }
      })

      linkActions.push({
        label: l('saveLinkAs'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'downloadURL', [link])
        }
      })

      menuSections.push(linkActions)
    }

    /* images */

    var mediaURL = data.srcURL

    if (mediaURL && data.mediaType === 'image') {
      var imageActions = [
        {
          label: (mediaURL.length > 60) ? mediaURL.substring(0, 60) + '...' : mediaURL,
          enabled: false
        }
      ]

      imageActions.push({
        label: l('viewImage'),
        click: function () {
          webviews.update(tabs.getSelected(), mediaURL)
        }
      })

      if (!currentTab.private) {
        imageActions.push({
          label: l('openImageInNewTab'),
          click: function () {
            browserUI.addTab(tabs.add({ url: mediaURL }), { enterEditMode: false, openInBackground: openInBackground })
          }
        })
      }

      imageActions.push({
        label: l('openImageInNewPrivateTab'),
        click: function () {
          browserUI.addTab(tabs.add({ url: mediaURL, private: true }), { enterEditMode: false, openInBackground: openInBackground })
        }
      })

      imageActions.push({
        label: l('saveImageAs'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'downloadURL', [mediaURL])
        }
      })

      menuSections.push(imageActions)
    }

    /* selected text */

    var selection = data.selectionText

    if (selection) {
      var textActions = [
        {
          label: l('searchWith').replace('%s', searchEngine.getCurrent().name),
          click: function () {
            var newTab = tabs.add({
              url: searchEngine.getCurrent().searchURL.replace('%s', encodeURIComponent(selection)),
              private: currentTab.private
            })
            browserUI.addTab(newTab, {
              enterEditMode: false,
              openInBackground: false
            })
          }
        }
      ]
      menuSections.push(textActions)
    }

    var clipboardActions = []

    if (mediaURL && data.mediaType === 'image') {
      clipboardActions.push({
        label: l('copy'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'copyImageAt', [data.x, data.y])
        }
      })
    } else if (selection) {
      clipboardActions.push({
        label: l('copy'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'copy')
        }
      })
    }

    if (data.editFlags && data.editFlags.canPaste) {
      clipboardActions.push({
        label: l('paste'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'paste')
        }
      })
    }

    if (data.editFlags && data.editFlags.canPaste) {
      clipboardActions.push({
        label: l('pasteAndMatchStyle'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'pasteAndMatchStyle')
        }
      })
    }

    if (link || (mediaURL && !mediaURL.startsWith('blob:'))) {
      if (link && link.startsWith('mailto:')) {
        var ematch = link.match(/(?<=mailto:)[^?]+/)
        if (ematch) {
          clipboardActions.push({
            label: l('copyEmailAddress'),
            click: function () {
              clipboard.writeText(ematch[0])
            }
          })
        }
      } else {
        clipboardActions.push({
          label: l('copyLink'),
          click: function () {
            clipboard.writeText(link || mediaURL)
          }
        })
      }
    }

    if (clipboardActions.length !== 0) {
      menuSections.push(clipboardActions)
    }

    if (data.formControlType === 'input-password' && PasswordManagers.getActivePasswordManager()?.saveCredential) {
      menuSections.push([
        {
          label: l('generatePassword'),
          click: function () {
            webviews.callAsync(tabs.getSelected(), 'send', ['generate-password', { x: data.x, y: data.y }])
          }
        }
      ])
    }

    var navigationActions = [
      {
        label: l('goBack'),
        click: function () {
          try {
            webviews.goBackIgnoringRedirects(tabs.getSelected())
          } catch (e) { }
        }
      },
      {
        label: l('goForward'),
        click: function () {
          try {
            webviews.callAsync(tabs.getSelected(), 'goForward')
          } catch (e) { }
        }
      },
      {
        label: l('tabMenuReload'),
        click: function () {
          try {
            if (currentTab.url && currentTab.url.startsWith(webviews.internalPages.error)) {
              webviews.update(tabs.getSelected(), new URL(currentTab.url).searchParams.get('url'))
            } else {
              webviews.callAsync(tabs.getSelected(), 'reload')
            }
          } catch (e) { }
        }
      }
    ]

    menuSections.push(navigationActions)

    var pageActions = [
      {
        label: l('appMenuSavePageAs'),
        accelerator: 'CmdOrCtrl+s',
        click: async function () {
          var currentTabForSave = tabs.get(tabs.getSelected())
          if (!currentTabForSave.url) {
            return
          }
          if (PDFViewer.isPDFViewer(tabs.getSelected())) {
            PDFViewer.savePDF(tabs.getSelected())
            return
          }
          if (tabs.get(tabs.getSelected()).isFileView) {
            webviews.callAsync(tabs.getSelected(), 'downloadURL', [tabs.get(tabs.getSelected()).url])
          } else {
            var savePath = await ipc.invoke('showSaveDialog', {
              defaultPath: currentTabForSave.title.replace(/[/\\]/g, '_')
            })
            if (savePath) {
              if (!savePath.endsWith('.html')) {
                savePath = savePath + '.html'
              }
              webviews.callAsync(tabs.getSelected(), 'savePage', [savePath, 'HTMLComplete'])
            }
          }
        }
      },
      {
        label: l('appMenuPrint'),
        accelerator: 'CmdOrCtrl+p',
        click: function () {
          if (PDFViewer.isPDFViewer(tabs.getSelected())) {
            PDFViewer.printPDF(tabs.getSelected())
          } else if (readerView.isReader(tabs.getSelected())) {
            readerView.printArticle(tabs.getSelected())
          } else if (webviews.placeholderRequests.length === 0) {
            webviews.callAsync(tabs.getSelected(), 'executeJavaScript', 'window.print()')
          }
        }
      },
      {
        label: l('appMenuFind'),
        accelerator: 'CmdOrCtrl+F',
        click: function () {
          if (modalMode.enabled()) {
            return
          }
          findinpage.start()
        }
      }
    ]

    if (currentTab.url && (readerView.isReader(tabs.getSelected()) || !urlParser.isInternalURL(currentTab.url))) {
      if (!readerView.isReader(tabs.getSelected())) {
        pageActions.push({
          label: l('enterReaderView'),
          accelerator: 'Shift+CmdOrCtrl+R',
          click: function () {
            readerView.enter(tabs.getSelected(), currentTab.url)
          }
        })
      } else {
        pageActions.push({
          label: l('exitReaderView'),
          accelerator: 'Shift+CmdOrCtrl+R',
          click: function () {
            readerView.exit(tabs.getSelected())
          }
        })
      }
    }

    pageActions.push({
      label: l('zoom'),
      submenu: [
        {
          label: l('appMenuZoomIn'),
          accelerator: 'CmdOrCtrl+Plus',
          click: function () {
            webviewGestures.zoomWebviewIn(tabs.getSelected())
          }
        },
        {
          label: l('appMenuZoomOut'),
          accelerator: 'CmdOrCtrl+-',
          click: function () {
            webviewGestures.zoomWebviewOut(tabs.getSelected())
          }
        },
        {
          label: l('appMenuActualSize'),
          accelerator: 'CmdOrCtrl+0',
          click: function () {
            webviewGestures.resetWebviewZoom(tabs.getSelected())
          }
        }
      ]
    })

    var isNormalPageContext = !link && (!mediaURL || (data.mediaType !== 'image' && data.mediaType !== 'video' && data.mediaType !== 'audio')) && !data.isEditable

    if (isNormalPageContext) {
      menuSections.push(pageActions)
    }

    menuSections.push([
      {
        label: l('inspectElement'),
        click: function () {
          webviews.callAsync(tabs.getSelected(), 'inspectElement', [data.x || 0, data.y || 0])
        }
      },
      {
        label: l('viewSource'),
        click: function () {
          var tab = tabs.get(tabs.getSelected())
          if (!tab || !tab.url) {
            return
          }
          var sourceUrl = urlParser.getSourceURL(tab.url)
          if (!sourceUrl) {
            return
          }
          var viewSourceUrl = 'view-source:' + sourceUrl
          browserUI.addTab(tabs.add({
            url: viewSourceUrl,
            private: tab.private
          }), {
            enterEditMode: false,
            openInBackground: false
          })
        }
      }
    ])

    /* Userscripts */

    var contextMenuScripts = userscripts.getMatchingScripts(tabs.get(tabs.getSelected()).url).filter(function (script) {
      if (script.options['run-at'] && script.options['run-at'].includes('context-menu')) {
        return true
      }
    })

    if (contextMenuScripts.length > 0) {
      var scriptActions = [
        {
          label: l('runUserscript'),
          enabled: false
        }
      ]
      contextMenuScripts.forEach(function (script) {
        scriptActions.push({
          label: script.name,
          click: function () {
            userscripts.runScript(tabs.getSelected(), script)
          }
        })
      })
      menuSections.push(scriptActions)
    }

    var translateMenu = {
      label: l('translatePage'),
      submenu: []
    }

    const translateLangList = pageTranslations.getLanguageList()

    translateLangList[0].forEach(function (language) {
      translateMenu.submenu.push({
        label: language.name,
        click: function () {
          pageTranslations.translateInto(tabs.getSelected(), language.code)
        }
      })
    })

    if (translateLangList[1].length > 0) {
      translateMenu.submenu.push({
        type: 'separator'
      })
      translateLangList[1].forEach(function (language) {
        translateMenu.submenu.push({
          label: language.name,
          click: function () {
            pageTranslations.translateInto(tabs.getSelected(), language.code)
          }
        })
      })
    }

    translateMenu.submenu.push({
      type: 'separator'
    })

    translateMenu.submenu.push({
      label: 'Send Feedback',
      click: function () {
        // Feedback link removed
      }
    })

    menuSections.push([translateMenu])

    // Electron's default menu position is sometimes wrong on Windows with a touchscreen
    // https://github.com/minbrowser/min/issues/903
    var offset = webviews.getViewBounds()
    var currentTabId = tabs.getSelected()
    remoteMenu.open(menuSections, data.x + offset.x, data.y + offset.y, {
      tabId: currentTabId,
      params: data
    })
  },
  initialize: function () {
    webviews.bindEvent('context-menu', function (tabId, data) {
      webviewMenu.menuData = data
      webviews.callAsync(tabs.getSelected(), 'send', ['getContextMenuData', { x: data.x, y: data.y }])
    })
    webviews.bindIPC('contextMenuData', function (tabId, args) {
      webviewMenu.showMenu(webviewMenu.menuData, args[0])
      webviewMenu.menuData = null
    })
  }
}

module.exports = webviewMenu
