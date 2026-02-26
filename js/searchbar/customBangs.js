/* list of the available custom commands */

const { ipcRenderer } = require('electron')
const fs = require('fs')
const quickScore = require('quick-score').quickScore

const bangsPlugin = require('searchbar/bangsPlugin.js')

const webviews = require('webviews.js')
const browserUI = require('browserUI.js')
const focusMode = require('focusMode.js')
const places = require('places/places.js')
const contentBlockingToggle = require('navbar/contentBlockingToggle.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')
const bookmarkConverter = require('bookmarkConverter.js')
const searchbarPlugins = require('searchbar/searchbarPlugins.js')
const tabEditor = require('navbar/tabEditor.js')
const formatRelativeDate = require('util/relativeDate.js')
const settings = require('util/settings/settings.js')
const downloadManager = require('downloadManager.js')

function moveToTaskCommand (taskId) {
  // remove the tab from the current task

  const currentTab = tabs.get(tabs.getSelected())
  tabs.destroy(currentTab.id)

  // make sure the task has at least one tab in it
  if (tabs.count() === 0) {
    tabs.add()
  }

  const newTask = tasks.get(taskId)

  newTask.tabs.add(currentTab, { atEnd: true })

  browserUI.switchToTask(newTask.id)
  browserUI.switchToTab(currentTab.id)

  taskOverlay.show()

  setTimeout(function () {
    taskOverlay.hide()
  }, 600)
}

function switchToTaskCommand (taskId) {
  /* disabled in focus mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  // no task was specified, show all of the tasks
  if (!taskId) {
    taskOverlay.show()
    return
  }

  browserUI.switchToTask(taskId)
}

// returns a task with the same name or index ("1" returns the first task, etc.)
function getTaskByNameOrNumber (text) {
  const textAsNumber = parseInt(text)

  return tasks.find((task, index) => (task.name && task.name.toLowerCase() === text) || index + 1 === textAsNumber
  )
}

// return an array of tasks sorted by last activity
// if a search string is present, filter the results with a basic fuzzy search
function searchAndSortTasks (text) {
  let taskResults = tasks
    .filter(t => t.id !== tasks.getSelected().id)
    .map(t => Object.assign({}, { task: t }, { lastActivity: tasks.getLastActivity(t.id) }))

  taskResults = taskResults.sort(function (a, b) {
    return b.lastActivity - a.lastActivity
  })

  if (text !== '') {
    // fuzzy search
    const searchText = text.toLowerCase()

    taskResults = taskResults.filter(function (t) {
      const task = t.task
      const taskName = (task.name ? task.name : l('defaultTaskName').replace('%n', tasks.getIndex(task.id) + 1)).toLowerCase()
      const exactMatch = taskName.indexOf(searchText) !== -1
      const fuzzyTitleScore = quickScore(taskName, searchText)

      return (exactMatch || fuzzyTitleScore > 0.4)
    })
  }

  return taskResults
}

function initialize () {
  bangsPlugin.registerCustomBang({
    phrase: '!settings',
    snippet: l('viewSettings'),
    icon: 'carbon:settings',
    isAction: true,
    fn: function (text) {
      webviews.update(tabs.getSelected(), 'min://settings')
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!back',
    snippet: l('goBack'),
    isAction: true,
    fn: function (text) {
      webviews.callAsync(tabs.getSelected(), 'goBack')
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!forward',
    snippet: l('goForward'),
    isAction: true,
    fn: function (text) {
      webviews.callAsync(tabs.getSelected(), 'goForward')
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!screenshot',
    snippet: l('takeScreenshot'),
    icon: 'carbon:image',
    isAction: true,
    fn: function (text) {
      setTimeout(function () { // wait so that the view placeholder is hidden
        ipcRenderer.send('saveViewCapture', { id: tabs.getSelected() })
      }, 400)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!clearhistory',
    snippet: l('clearHistory'),
    icon: 'carbon:trash-can',
    isAction: true,
    fn: function (text) {
      if (confirm(l('clearHistoryConfirmation'))) {
        places.deleteAllHistory()
        ipc.invoke('clearStorageData')
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!enableblocking',
    snippet: l('enableBlocking'),
    isAction: true,
    fn: function (text) {
      contentBlockingToggle.enableBlocking(tabs.get(tabs.getSelected()).url)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!disableblocking',
    snippet: l('disableBlocking'),
    isAction: true,
    fn: function (text) {
      contentBlockingToggle.disableBlocking(tabs.get(tabs.getSelected()).url)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!extensions',
    snippet: '管理扩展与插件',
    icon: 'carbon:3rd-party-connected',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      var list = settings.get('browserExtensions') || []
      if (!Array.isArray(list)) {
        list = []
      }

      searchbarPlugins.addResult('bangs', {
        title: '扩展管理',
        secondaryText: '导入新的扩展或 CRX 包',
        icon: 'carbon:3rd-party-connected',
        textActionButtons: [
          {
            text: '导入文件夹',
            default: true,
            fn: function () {
              ipcRenderer.send('importExtension')
            }
          },
          {
            text: '导入 CRX 文件',
            fn: function () {
              ipcRenderer.send('importExtensionCrx')
            }
          }
        ]
      }, { allowDuplicates: true })

      if (!list.length) {
        searchbarPlugins.addResult('bangs', {
          title: '尚未导入扩展',
          secondaryText: '点击导入一个扩展',
          icon: 'carbon:3rd-party-connected',
          click: function () {
            ipcRenderer.send('importExtension')
          }
        })
        return
      }

      var searchText = (text || '').trim().toLowerCase()

      searchbarPlugins.addHeading('bangs', { text: '扩展与插件' })

      list
        .filter(function (item) {
          if (!item) {
            return false
          }
          if (!searchText) {
            return true
          }
          var name = (item.name || item.id || item.path || '').toLowerCase()
          return name.indexOf(searchText) !== -1
        })
        .forEach(function (item, index) {
          var statusText = item.enabled === false ? '已禁用' : '已启用'

          var buttons = [
            {
              text: item.enabled === false ? '启用' : '禁用',
              default: true,
              fn: function () {
                ipcRenderer.send('toggleExtension', {
                  id: item.id,
                  enabled: item.enabled === false
                })
              }
            },
            {
              text: '删除',
              fn: function () {
                if (!confirm('确定要删除该扩展吗？')) {
                  return
                }
                ipcRenderer.send('removeExtension', item.id)
              }
            },
            {
              text: '弹窗',
              fn: function () {
                ipcRenderer.send('openExtensionPopup', item.id)
              }
            },
            {
              text: '设置',
              fn: function () {
                ipcRenderer.send('openExtensionOptions', item.id)
              }
            }
          ]

          searchbarPlugins.addResult('bangs', {
            title: item.name || item.id || item.path || '',
            secondaryText: statusText,
            textActionButtons: buttons
          }, { allowDuplicates: true })
        })
    },
    fn: function (text) {

    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!download',
    snippet: '查看下载记录',
    icon: 'carbon:download',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      var items = downloadManager.getHistoryItems ? downloadManager.getHistoryItems() : []
      var searchText = (text || '').trim().toLowerCase()
      var filtered = items.filter(function (item) {
        var name = item.name || item.path || ''
        if (!name) {
          return false
        }
        if (!searchText) {
          return true
        }
        return name.toLowerCase().indexOf(searchText) !== -1
      })

      var container = searchbarPlugins.getContainer('bangs')

      if (!filtered.length) {
        searchbarPlugins.addResult('bangs', {
          title: '当前没有下载记录',
          icon: 'carbon:download'
        })
        return
      }

      if (!searchText) {
        var clearButton = document.createElement('button')
        clearButton.className = 'searchbar-floating-button'
        clearButton.textContent = '清除所有下载记录'
        clearButton.addEventListener('click', function () {
          downloadManager.clearHistory()
          searchbarPlugins.reset('bangs')
        })
        container.appendChild(clearButton)
      }

      searchbarPlugins.addHeading('bangs', { text: '下载记录' })

      filtered.forEach(function (item, index) {
        var path = item.path
        var statusText
        if (item.status === 'completed') {
          statusText = '已完成'
        } else if (item.status === 'interrupted') {
          statusText = '已失败'
        } else {
          statusText = '进行中'
        }

        searchbarPlugins.addResult('bangs', {
          title: item.name || item.path || '',
          secondaryText: statusText,
          icon: 'carbon:download',
          fakeFocus: index === 0 && text,
          click: function () {
            if (!path) {
              return
            }
            downloadManager.openFolder(path)
          },
          delete: function () {
            if (!path) {
              return
            }
            downloadManager.removeHistoryItem(path)
          },
          showDeleteButton: true
        }, { allowDuplicates: true })
      })
    },
    fn: function (text) {
      var items = downloadManager.getHistoryItems ? downloadManager.getHistoryItems() : []
      if (!items.length) {
        return
      }
      var searchText = (text || '').trim().toLowerCase()
      var target
      if (searchText) {
        target = items.find(function (item) {
          var name = item.name || item.path || ''
          if (!name) {
            return false
          }
          return name.toLowerCase().indexOf(searchText) !== -1
        })
      } else {
        target = items[0]
      }
      if (target && target.path) {
        downloadManager.openFolder(target.path)
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!movetotask',
    snippet: l('moveToTask'),
    icon: 'carbon:folder-move-to',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      const taskResults = searchAndSortTasks(text)

      taskResults.forEach(function (t, idx) {
        const task = t.task
        const lastActivity = t.lastActivity

        const taskName = (task.name ? task.name : l('defaultTaskName').replace('%n', tasks.getIndex(task.id) + 1))

        const data = {
          title: taskName,
          secondaryText: formatRelativeDate(lastActivity),
          fakeFocus: text && idx === 0,
          click: function () {
            tabEditor.hide()

            /* disabled in focus mode */
            if (focusMode.enabled()) {
              focusMode.warn()
              return
            }

            moveToTaskCommand(task.id)
          }
        }

        searchbarPlugins.addResult('bangs', data)
      })
    },

    fn: function (text) {
      /* disabled in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      // use the first search result
      // if there is no search text or no result, need to create a new task
      let task = searchAndSortTasks(text)[0]?.task
      if (!text || !task) {
        task = tasks.get(tasks.add({
          name: text
        }, tasks.getIndex(tasks.getSelected().id) + 1))
      }

      return moveToTaskCommand(task.id)
    }

  })

  bangsPlugin.registerCustomBang({
    phrase: '!task',
    snippet: l('switchToTask'),
    icon: 'carbon:folder',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      const taskResults = searchAndSortTasks(text)

      taskResults.forEach(function (t, idx) {
        const task = t.task
        const lastActivity = t.lastActivity

        const taskName = (task.name ? task.name : l('defaultTaskName').replace('%n', tasks.getIndex(task.id) + 1))

        const data = {
          title: taskName,
          secondaryText: formatRelativeDate(lastActivity),
          fakeFocus: text && idx === 0,
          click: function () {
            tabEditor.hide()
            switchToTaskCommand(task.id)
          }
        }

        searchbarPlugins.addResult('bangs', data)
      })
    },
    fn: function (text) {
      if (text) {
      // switch to the first search result
        switchToTaskCommand(searchAndSortTasks(text)[0].task.id)
      } else {
        taskOverlay.show()
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!newtask',
    snippet: l('createTask'),
    icon: 'carbon:folder-add',
    isAction: true,
    fn: function (text) {
      /* disabled in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      taskOverlay.show()

      setTimeout(function () {
        browserUI.addTask()
        if (text) {
          tasks.update(tasks.getSelected().id, { name: text })
        }
      }, 600)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!closetask',
    snippet: l('closeTask'),
    icon: 'carbon:folder-off',
    isAction: false,
    fn: function (text) {
      const currentTask = tasks.getSelected()
      let taskToClose

      if (text) {
        taskToClose = getTaskByNameOrNumber(text)
      } else {
        taskToClose = tasks.getSelected()
      }

      if (taskToClose) {
        browserUI.closeTask(taskToClose.id)
        if (currentTask.id === taskToClose.id) {
          taskOverlay.show()
          setTimeout(function () {
            taskOverlay.hide()
          }, 600)
        }
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!nametask',
    snippet: l('nameTask'),
    isAction: false,
    fn: function (text) {
      tasks.update(tasks.getSelected().id, { name: text })
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!importbookmarks',
    snippet: l('importBookmarks'),
    icon: 'carbon:upload',
    isAction: true,
    fn: async function () {
      const filePath = await ipc.invoke('showOpenDialog', {
        filters: [
          { name: 'HTML files', extensions: ['htm', 'html'] }
        ]
      })

      if (!filePath) {
        return
      }
      fs.readFile(filePath[0], 'utf-8', function (err, data) {
        if (err || !data) {
          console.warn(err)
          return
        }
        bookmarkConverter.import(data)
      })
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!exportbookmarks',
    snippet: l('exportBookmarks'),
    icon: 'carbon:download',
    isAction: true,
    fn: async function () {
      const data = await bookmarkConverter.exportAll()
      // save the result
      const savePath = await ipc.invoke('showSaveDialog', { defaultPath: 'bookmarks.html' })
      require('fs').writeFileSync(savePath, data)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!addbookmark',
    snippet: l('addBookmark'),
    icon: 'carbon:star',
    fn: function (text) {
      const url = tabs.get(tabs.getSelected()).url
      if (url) {
        places.updateItem(url, {
          isBookmarked: true,
          tags: (text ? text.split(/\s/g).map(t => t.replace('#', '').trim()) : [])
        })
      }
    }
  })

  function refreshExtensionsIfActive () {
    var input = document.getElementById('tab-editor-input')
    var searchbarElement = document.getElementById('searchbar')

    if (!input || !searchbarElement || searchbarElement.hidden) {
      return
    }

    var value = input.value || ''
    if (value.indexOf('!extensions') !== 0) {
      return
    }

    searchbarPlugins.run(value, input, {})
  }

  ipcRenderer.on('settingChanged', function (e, key) {
    if (key !== 'browserExtensions') {
      return
    }

    refreshExtensionsIfActive()
  })

  ipcRenderer.on('refreshExtensionsView', function () {
    refreshExtensionsIfActive()
  })
}

module.exports = { initialize }
