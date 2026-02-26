const { ipcRenderer } = require('electron')

var webviews = require('webviews.js')
var keybindings = require('keybindings.js')
var browserUI = require('browserUI.js')
var tabBar = require('navbar/tabBar.js')
var tabEditor = require('navbar/tabEditor.js')
var focusMode = require('focusMode.js')
var modalMode = require('modalMode.js')
var keyboardNavigationHelper = require('util/keyboardNavigationHelper.js')
var Sortable = require('sortablejs')
var places = require('places/places.js')
var urlParser = require('util/urlParser.js')
var searchbarUtils = require('searchbar/searchbarUtils.js')

const createTaskContainer = require('taskOverlay/taskOverlayBuilder.js')

var taskContainer = document.getElementById('task-area')
var taskSwitcherButton = document.getElementById('switch-task-button')
var addTaskNavbarButton = document.getElementById('add-task-navbar')
var taskOverlayNavbar = document.getElementById('task-overlay-navbar')
var sidebarMarginAnimationFrame = null
var sidebarTransitionDuration = 100

function animateSidebarMargin (from, to, duration, onDone) {
  if (sidebarMarginAnimationFrame) {
    cancelAnimationFrame(sidebarMarginAnimationFrame)
    sidebarMarginAnimationFrame = null
  }
  if (!webviews || !webviews.adjustMargin || from === to || duration <= 0) {
    var instantDelta = to - from
    if (instantDelta) {
      webviews.adjustMargin([0, 0, 0, instantDelta])
    }
    taskOverlay.sidebarMargin = to
    document.body.style.setProperty('--task-sidebar-offset', to + 'px')
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
      webviews.adjustMargin([0, 0, 0, delta])
    }
    last = current
    taskOverlay.sidebarMargin = current
    document.body.style.setProperty('--task-sidebar-offset', Math.max(0, current) + 'px')
    if (t < 1) {
      sidebarMarginAnimationFrame = requestAnimationFrame(step)
    } else {
      sidebarMarginAnimationFrame = null
      taskOverlay.sidebarMargin = to
      if (onDone) {
        onDone()
      }
    }
  }

  sidebarMarginAnimationFrame = requestAnimationFrame(step)
}

function addTaskFromMenu () {
  /* new tasks can't be created in modal mode */
  if (modalMode.enabled()) {
    return
  }

  /* new tasks can't be created in focus mode or modal mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  browserUI.addTask()
  taskOverlay.show()
  setTimeout(function () {
    taskOverlay.hide()
    tabEditor.show(tabs.getSelected())
  }, 600)
}

function deleteTabFromOverlay (item) {
  var itemIsFocused = item.classList.contains('fakefocus') || (document.activeElement === item)
  var successorTab = item.previousElementSibling || item.nextElementSibling
  if (!successorTab) {
    var allTabs = Array.from(document.querySelectorAll('.task-tab-item'))
    successorTab = allTabs[allTabs.indexOf(item) - 1] || allTabs[allTabs.indexOf(item) + 1]
  }

  var tabId = item.getAttribute('data-tab')

  var task = tasks.getTaskContainingTab(tabId)

  tasks.get(task.id).tabs.destroy(tabId)
  webviews.destroy(tabId)

  tabBar.updateAll()

  // if there are no tabs left, remove the task
  if (task.tabs.count() === 0) {
    // remove the task element from the overlay
    getTaskContainer(task.id).remove()
    // close the task
    browserUI.closeTask(task.id)
  }

  if (itemIsFocused && successorTab) {
    successorTab.focus()
  }
}

function getTaskContainer (id) {
  return document.querySelector('.task-container[data-task="{id}"]'.replace('{id}', id))
}

var taskOverlay = {
  overlayElement: document.getElementById('task-overlay'),
  isShown: false,
  sortableInstances: [],
  addTaskDragging: function () {
    const sortable = new Sortable(taskContainer, {
      group: 'overlay-tasks',
      draggable: '.task-container',
      ghostClass: 'task-drop-placeholder',
      scroll: true,
      scrollSensitivity: 100,
      forceAutoScrollFallback: true,
      scrollSpeed: 15,
      onEnd: function (e) {
        var droppedTaskId = e.item.getAttribute('data-task')
        const insertionPoint = Array.from(taskContainer.children).indexOf(e.item)

        // remove the task from the tasks list
        var droppedTask = tasks.splice(tasks.getIndex(droppedTaskId), 1)[0]

        // reinsert the task
        tasks.splice(insertionPoint, 0, droppedTask)
      }
    })
    taskOverlay.sortableInstances.push(sortable)
  },

  addTabDragging: function (el) {
    const sortable = new Sortable(el, {
      group: 'overlay-tabs',
      draggable: '.task-tab-item',
      ghostClass: 'tab-drop-placeholder',
      multiDrag: true,
      multiDragKey: (window.platformType === 'mac' ? 'Meta' : 'Ctrl'),
      selectedClass: 'dragging-selected',
      animation: 200,
      scroll: true,
      scrollSensitivity: 100,
      forceAutoScrollFallback: true,
      scrollSpeed: 15,
      onStart: function () {
        taskOverlay.overlayElement.classList.add('is-dragging-tab')
      },
      onEnd: function (e) {
        taskOverlay.overlayElement.classList.remove('is-dragging-tab')

        const items = (e.items.length === 0) ? [e.item] : e.items

        const sortedItems = Array.from(e.to.children).filter(item => items.some(item2 => item2 === item))

        var newTask
        // find a source task to add this tab to
        newTask = tasks.get(e.to.getAttribute('data-task'))

        sortedItems.forEach(function (item) {
          var tabId = item.getAttribute('data-tab')
          var previousTask = tasks.getTaskContainingTab(tabId)

          var oldTab = previousTask.tabs.splice(previousTask.tabs.getIndex(tabId), 1)[0]

          if (oldTab.selected) {
            var mostRecentTab = previousTask.tabs.get().sort(function (a, b) {
              return b.lastActivity - a.lastActivity
            })[0]
            if (mostRecentTab) {
              previousTask.tabs.setSelected(mostRecentTab.id)
            }

            oldTab.selected = false
          }

          if (previousTask.tabs.count() === 0) {
            browserUI.closeTask(previousTask.id)
            getTaskContainer(previousTask.id).remove()
          }

          var newIdx = Array.from(e.to.children).findIndex(t => t === item)

          newTask.tabs.splice(newIdx, 0, oldTab)
        })
        tabBar.updateAll()
        taskOverlay.render()
      }
    })
    taskOverlay.sortableInstances.push(sortable)
  },

  sidebarMargin: 0,

  loadFavorites: function () {
    var container = document.getElementById('task-sidebar-favorites-list')
    if (!container) {
      return
    }
    container.innerHTML = ''
    places.getAllItems().then(function (items) {
      if (!items || !items.length) {
        return
      }
      var bookmarks = items.filter(function (item) {
        return item.isBookmarked
      }).sort(function (a, b) {
        return (b.lastVisit || 0) - (a.lastVisit || 0)
      }).slice(0, 30)
      bookmarks.forEach(function (item) {
        var source = urlParser.getSourceURL(item.url)
        var normalizedSource = urlParser.toMinProtocol(source)
        var isNewTabSource = !normalizedSource || normalizedSource === 'min://newtab' || normalizedSource.startsWith('min://app/tab/')
        var data = {
          title: item.title || item.url,
          secondaryText: isNewTabSource ? undefined : urlParser.basicURL(source),
          classList: ['sidebar-favorite-item', 'task-tab-item'],
          click: function () {
            var currentTab = tabs.get(tabs.getSelected())
            var newTab = tabs.add({
              url: item.url,
              private: currentTab && currentTab.private
            })
            browserUI.addTab(newTab, {
              enterEditMode: false,
              openInBackground: false
            })
            taskOverlay.hide()
          }
        }

        if (item.favicon) {
          data.iconImage = item.favicon
          data.classList.push('has-icon')
        } else {
          data.classList.push('no-icon')
        }

        var el = searchbarUtils.createItem(data)
        container.appendChild(el)
      })
    }).catch(function () {})
  },

  show: function () {
    /* disabled in focus mode */
    if (focusMode.enabled()) {
      focusMode.warn()
      return
    }
    if (this.isShown) {
      return
    }

    var currentMargin = (webviews && webviews.viewMargins) ? webviews.viewMargins[3] : this.sidebarMargin
    this.sidebarMargin = currentMargin
    document.body.style.setProperty('--task-sidebar-offset', Math.max(0, currentMargin) + 'px')
    document.body.classList.add('task-overlay-is-shown')
    document.body.setAttribute('data-context', 'taskOverlay')
    var sidebarWidth = this.overlayElement && this.overlayElement.offsetWidth ? this.overlayElement.offsetWidth : 360
    var safeMargin = 1
    var targetMargin = sidebarWidth + safeMargin
    animateSidebarMargin(this.sidebarMargin, targetMargin, sidebarTransitionDuration)

    tabEditor.hide()

    document.getElementById('task-search-input').value = ''

    this.isShown = true
    taskSwitcherButton.classList.add('active')

    taskOverlay.render()
    taskOverlay.loadFavorites()

    // un-hide the overlay
    this.overlayElement.hidden = false

    // add visible class for slide-in animation
    requestAnimationFrame(() => {
      this.overlayElement.classList.add('visible')
    })

    // scroll to the selected element and focus it
    var currentTabElement = document.querySelector('.task-tab-item[data-tab="{id}"]'.replace('{id}', tasks.getSelected().tabs.getSelected()))

    if (currentTabElement) {
      currentTabElement.classList.add('fakefocus')
      currentTabElement.focus()
    }
  },
  render: function () {
    empty(taskContainer)
    this.sortableInstances.forEach(inst => inst.destroy())
    this.sortableInstances = []

    taskOverlay.addTaskDragging()

    // show the task elements
    tasks.forEach(function (task, index) {
      const el = createTaskContainer(task, index, {
        tabSelect: function () {
          browserUI.switchToTask(task.id)
          browserUI.switchToTab(this.getAttribute('data-tab'))

          taskOverlay.hide()
        },
        tabDelete: function (item) {
          deleteTabFromOverlay(item)
        }
      })

      taskContainer.appendChild(el)
      taskOverlay.addTabDragging(el.querySelector('.task-tabs-container'))
    })
  },

  hide: function () {
    if (this.isShown) {
      this.isShown = false

      this.overlayElement.classList.remove('visible')
      empty(taskContainer)

      var currentMargin = (webviews && webviews.viewMargins) ? webviews.viewMargins[3] : this.sidebarMargin
      this.sidebarMargin = currentMargin
      var finalizeHide = () => {
        this.overlayElement.hidden = true
        document.body.classList.remove('task-overlay-is-shown')
        document.body.removeAttribute('data-context')
        taskSwitcherButton.classList.remove('active')
        if (webviews && webviews.focus) {
          webviews.focus()
        }
      }
      animateSidebarMargin(this.sidebarMargin, 0, sidebarTransitionDuration, finalizeHide)

      // close any tasks that are pending deletion

      var pendingDeleteTasks = document.body.querySelectorAll('.task-container.deleting')
      for (var i = 0; i < pendingDeleteTasks.length; i++) {
        browserUI.closeTask(pendingDeleteTasks[i].getAttribute('data-task'))
      }

      // if the current tab has been deleted, switch to the most recent one

      if (!tabs.getSelected()) {
        var mostRecentTab = tabs.get().sort(function (a, b) {
          return b.lastActivity - a.lastActivity
        })[0]

        if (mostRecentTab) {
          browserUI.switchToTab(mostRecentTab.id)
        }
      }
    }
  },

  toggle: function () {
    if (this.isShown) {
      this.hide()
    } else {
      this.show()
    }
  },

  initializeSearch: function () {
    var container = document.querySelector('.task-search-input-container')
    var input = document.getElementById('task-search-input')

    input.placeholder = l('tasksSearchTabs') + ' (T)'

    container.addEventListener('click', e => { e.stopPropagation(); input.focus() })

    taskOverlay.overlayElement.addEventListener('keyup', function (e) {
      if (e.key.toLowerCase() === 't' && document.activeElement.tagName !== 'INPUT') {
        input.focus()
      }
    })

    input.addEventListener('input', function (e) {
      var search = input.value.toLowerCase().trim()

      if (!search) {
        // reset the overlay
        taskOverlay.render()
        input.focus()
        return
      }

      var totalTabMatches = 0

      tasks.forEach(function (task) {
        var taskContainer = document.querySelector(`.task-container[data-task="${task.id}"]`)

        var taskTabMatches = 0
        task.tabs.forEach(function (tab) {
          var tabContainer = document.querySelector(`.task-tab-item[data-tab="${tab.id}"]`)

          var searchText = (task.name + ' ' + tab.title + ' ' + tab.url).toLowerCase()

          const searchMatches = search.split(' ').every(word => searchText.includes(word))
          if (searchMatches) {
            tabContainer.hidden = false
            taskTabMatches++
            totalTabMatches++

            if (totalTabMatches === 1) {
              // first match
              tabContainer.classList.add('fakefocus')
            } else {
              tabContainer.classList.remove('fakefocus')
            }
          } else {
            tabContainer.hidden = true
          }
        })

        if (taskTabMatches === 0) {
          taskContainer.hidden = true
        } else {
          taskContainer.hidden = false
          taskContainer.classList.remove('collapsed')
        }
      })
    })

    input.addEventListener('keypress', function (e) {
      if (e.keyCode === 13) {
        var firstTab = taskOverlay.overlayElement.querySelector('.task-tab-item:not([hidden])')
        if (firstTab) {
          firstTab.click()
        }
      }
    })
  },
  initialize: function () {
    this.initializeSearch()

    keyboardNavigationHelper.addToGroup('taskOverlay', taskOverlay.overlayElement)

    // bind add task button in navbar
    if (addTaskNavbarButton) {
      addTaskNavbarButton.addEventListener('click', function (e) {
        e.stopPropagation()
        addTaskFromMenu()
      })
    }

    keybindings.defineShortcut('toggleTasks', function () {
      if (taskOverlay.isShown) {
        taskOverlay.hide()
      } else {
        taskOverlay.show()
      }
    })

    keybindings.defineShortcut({ keys: 'esc' }, function (e) {
      taskOverlay.hide()
    })

    keybindings.defineShortcut('enterEditMode', function (e) {
      taskOverlay.hide()
    })

    keybindings.defineShortcut('closeTab', function (e) {
      var focusedTab = (document.querySelector('.task-tab-item.fakefocus') || document.activeElement)
      if (focusedTab && focusedTab.getAttribute('data-tab')) {
        deleteTabFromOverlay(focusedTab)
        focusedTab.remove()
      }
    }, { contexts: ['taskOverlay'] })

    keybindings.defineShortcut('addTask', addTaskFromMenu)
    ipcRenderer.on('addTask', addTaskFromMenu) // for menu item

    taskSwitcherButton.title = l('viewTasks')

    taskSwitcherButton.addEventListener('click', function () {
      taskOverlay.toggle()
    })

    taskOverlayNavbar.addEventListener('click', function () {
      taskOverlay.hide()
    })

    var favoritesToggle = document.getElementById('task-sidebar-favorites-toggle')
    var favoritesContainer = document.getElementById('task-sidebar-favorites')
    if (favoritesToggle && favoritesContainer) {
      favoritesToggle.addEventListener('click', function (e) {
        e.stopPropagation()
        favoritesContainer.classList.toggle('collapsed')
      })
    }

    var favoritesMoreButton = document.getElementById('task-sidebar-favorites-more')
    if (favoritesMoreButton) {
      favoritesMoreButton.addEventListener('click', function (e) {
        e.stopPropagation()
        taskOverlay.hide()
        tabEditor.show(tabs.getSelected(), '!bookmarks ')
      })
    }

    tasks.on('state-sync-change', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('tab-added', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('tab-destroyed', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('tab-updated', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('tab-selected', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('task-added', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    tasks.on('task-destroyed', function () {
      if (taskOverlay.isShown) {
        taskOverlay.render()
      }
    })

    places.on('bookmarks-changed', function () {
      if (taskOverlay.isShown) {
        taskOverlay.loadFavorites()
      }
    })
  }

}

module.exports = taskOverlay
