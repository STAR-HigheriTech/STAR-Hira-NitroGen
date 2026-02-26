/* 分屏视图功能实现 */

var path = require('path')

var splitView = {
  isActive: false,
  currentLayout: 'horizontal', // 'horizontal' 或 'vertical'
  splitRatio: 0.5, // 分割比例

  // 初始化分屏视图
  initialize: function () {
    this.createSplitViewUI()
    this.bindEvents()
    this.loadSplitViewState()
  },

  // 创建分屏视图UI
  createSplitViewUI: function () {
    // 创建分屏容器
    var splitContainer = document.createElement('div')
    splitContainer.id = 'split-view-container'
    splitContainer.className = 'split-view-container'
    splitContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: none;
      z-index: 1000;
      background: var(--bg-color);
    `

    // 创建左侧面板
    var leftPanel = document.createElement('div')
    leftPanel.id = 'split-view-left'
    leftPanel.className = 'split-view-panel'
    leftPanel.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 50%;
      height: 100%;
      border-right: 1px solid var(--border-color);
      overflow: hidden;
    `

    // 创建右侧面板
    var rightPanel = document.createElement('div')
    rightPanel.id = 'split-view-right'
    rightPanel.className = 'split-view-panel'
    rightPanel.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      width: 50%;
      height: 100%;
      overflow: hidden;
    `

    // 创建分割线
    var splitter = document.createElement('div')
    splitter.id = 'split-view-splitter'
    splitter.className = 'split-view-splitter'
    splitter.style.cssText = `
      position: absolute;
      top: 0;
      left: 50%;
      width: 4px;
      height: 100%;
      background: var(--border-color);
      cursor: col-resize;
      z-index: 1001;
    `

    // 创建控制按钮
    var controls = document.createElement('div')
    controls.id = 'split-view-controls'
    controls.className = 'split-view-controls'
    controls.style.cssText = `
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 1002;
      display: flex;
      gap: 8px;
    `

    // 添加控制按钮
    var closeBtn = this.createControlButton('关闭分屏', 'carbon:close', this.closeSplitView.bind(this))
    var swapBtn = this.createControlButton('交换位置', 'carbon:swap', this.swapPanels.bind(this))
    var layoutBtn = this.createControlButton('切换布局', 'carbon:split-screen', this.toggleLayout.bind(this))

    controls.appendChild(swapBtn)
    controls.appendChild(layoutBtn)
    controls.appendChild(closeBtn)

    splitContainer.appendChild(leftPanel)
    splitContainer.appendChild(rightPanel)
    splitContainer.appendChild(splitter)
    splitContainer.appendChild(controls)

    document.getElementById('webviews').appendChild(splitContainer)
  },

  // 创建控制按钮
  createControlButton: function (tooltip, icon, clickHandler) {
    var btn = document.createElement('button')
    btn.className = 'split-view-control-btn'
    btn.title = tooltip
    btn.innerHTML = `<i class="i ${icon}"></i>`
    btn.style.cssText = `
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.1);
      color: var(--text-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    `

    btn.addEventListener('click', clickHandler)
    btn.addEventListener('mouseenter', function () {
      this.style.background = 'rgba(0, 0, 0, 0.2)'
    })
    btn.addEventListener('mouseleave', function () {
      this.style.background = 'rgba(0, 0, 0, 0.1)'
    })

    return btn
  },

  // 绑定事件
  bindEvents: function () {
    var splitter = document.getElementById('split-view-splitter')
    var isResizing = false

    splitter.addEventListener('mousedown', function (e) {
      isResizing = true
      document.body.style.cursor = 'col-resize'
      e.preventDefault()
    })

    document.addEventListener('mousemove', function (e) {
      if (!isResizing) return

      var container = document.getElementById('split-view-container')
      var containerRect = container.getBoundingClientRect()
      var ratio = (e.clientX - containerRect.left) / containerRect.width

      splitView.updateSplitRatio(Math.max(0.2, Math.min(0.8, ratio)))
    })

    document.addEventListener('mouseup', function () {
      if (isResizing) {
        isResizing = false
        document.body.style.cursor = ''
      }
    })

    // 键盘快捷键
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault()
        if (splitView.isActive) {
          splitView.closeSplitView()
        } else {
          splitView.activateSplitView()
        }
      }
    })
  },

  // 激活分屏视图
  activateSplitView: function () {
    if (this.isActive) return

    this.isActive = true
    var container = document.getElementById('split-view-container')
    container.style.display = 'block'

    // 隐藏原有的webview
    var webviews = document.querySelectorAll('.webview')
    webviews.forEach(function (webview) {
      webview.style.visibility = 'hidden'
    })

    // 复制当前标签到左侧面板
    this.copyCurrentTabToPanel('left')

    // 在右侧面板创建新标签
    this.createNewTabInPanel('right')

    this.updateLayout()
    this.saveSplitViewState()
  },

  // 关闭分屏视图
  closeSplitView: function () {
    if (!this.isActive) return

    this.isActive = false
    var container = document.getElementById('split-view-container')
    container.style.display = 'none'

    // 显示原有的webview
    var webviews = document.querySelectorAll('.webview')
    webviews.forEach(function (webview) {
      webview.style.visibility = 'visible'
    })

    // 清理面板内容
    this.clearPanels()

    this.saveSplitViewState()
  },

  // 复制当前标签到面板
  copyCurrentTabToPanel: function (panel) {
    if (!window.tabs || !window.webviews) return

    var currentTab = tabs.get(tabs.getSelected())
    if (!currentTab) return

    var panelElement = document.getElementById('split-view-' + panel)

    // 创建webview容器
    var webviewContainer = document.createElement('div')
    webviewContainer.className = 'split-webview-container'
    webviewContainer.style.cssText = `
      width: 100%;
      height: 100%;
      position: relative;
    `

    // 创建webview
    var webview = document.createElement('webview')
    webview.className = 'split-webview'
    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
    `

    if (currentTab.url) {
      webview.src = currentTab.url
    }

    webviewContainer.appendChild(webview)
    panelElement.appendChild(webviewContainer)

    // 保存面板标签信息
    panelElement.dataset.tabId = currentTab.id
    panelElement.dataset.url = currentTab.url || ''

    // 监听webview事件
    this.attachWebviewEvents(webview, panel)
  },

  // 在面板中创建新标签
  createNewTabInPanel: function (panel) {
    var panelElement = document.getElementById('split-view-' + panel)

    // 创建webview容器
    var webviewContainer = document.createElement('div')
    webviewContainer.className = 'split-webview-container'
    webviewContainer.style.cssText = `
      width: 100%;
      height: 100%;
      position: relative;
    `

    // 创建webview
    var webview = document.createElement('webview')
    webview.className = 'split-webview'
    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
    `

    // 加载新标签页
    webview.src = 'file://' + path.join(__dirname, 'pages', 'newtab', 'index.html')

    webviewContainer.appendChild(webview)
    panelElement.appendChild(webviewContainer)

    // 保存面板标签信息
    panelElement.dataset.tabId = 'new'
    panelElement.dataset.url = ''

    // 监听webview事件
    this.attachWebviewEvents(webview, panel)
  },

  // 附加webview事件
  attachWebviewEvents: function (webview, panel) {
    webview.addEventListener('dom-ready', function () {
      // 注入一些样式
      webview.insertCSS(`
        body {
          margin: 0;
          padding: 0;
        }
      `)
    })

    webview.addEventListener('page-title-updated', function (e) {
      splitView.updatePanelTitle(panel, e.title)
    })

    webview.addEventListener('did-navigate', function (e) {
      splitView.updatePanelUrl(panel, e.url)
    })
  },

  // 更新面板标题
  updatePanelTitle: function (panel, title) {
    var panelElement = document.getElementById('split-view-' + panel)
    panelElement.dataset.title = title
  },

  // 更新面板URL
  updatePanelUrl: function (panel, url) {
    var panelElement = document.getElementById('split-view-' + panel)
    panelElement.dataset.url = url
  },

  // 交换面板位置
  swapPanels: function () {
    var leftPanel = document.getElementById('split-view-left')
    var rightPanel = document.getElementById('split-view-right')

    // 交换内容
    var leftContent = leftPanel.innerHTML
    var rightContent = rightPanel.innerHTML

    leftPanel.innerHTML = rightContent
    rightPanel.innerHTML = leftContent

    // 交换数据属性
    var leftData = {
      tabId: leftPanel.dataset.tabId,
      url: leftPanel.dataset.url,
      title: leftPanel.dataset.title
    }

    var rightData = {
      tabId: rightPanel.dataset.tabId,
      url: rightPanel.dataset.url,
      title: rightPanel.dataset.title
    }

    leftPanel.dataset.tabId = rightData.tabId
    leftPanel.dataset.url = rightData.url
    leftPanel.dataset.title = rightData.title

    rightPanel.dataset.tabId = leftData.tabId
    rightPanel.dataset.url = leftData.url
    rightPanel.dataset.title = leftData.title
  },

  // 切换布局（水平/垂直）
  toggleLayout: function () {
    this.currentLayout = this.currentLayout === 'horizontal' ? 'vertical' : 'horizontal'
    this.updateLayout()
    this.saveSplitViewState()
  },

  // 更新布局
  updateLayout: function () {
    var leftPanel = document.getElementById('split-view-left')
    var rightPanel = document.getElementById('split-view-right')
    var splitter = document.getElementById('split-view-splitter')

    if (this.currentLayout === 'horizontal') {
      leftPanel.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: ${this.splitRatio * 100}%;
        height: 100%;
        border-right: 1px solid var(--border-color);
        overflow: hidden;
      `

      rightPanel.style.cssText = `
        position: absolute;
        top: 0;
        right: 0;
        width: ${(1 - this.splitRatio) * 100}%;
        height: 100%;
        overflow: hidden;
      `

      splitter.style.cssText = `
        position: absolute;
        top: 0;
        left: ${this.splitRatio * 100}%;
        width: 4px;
        height: 100%;
        background: var(--border-color);
        cursor: col-resize;
        z-index: 1001;
      `
    } else {
      leftPanel.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: ${this.splitRatio * 100}%;
        border-bottom: 1px solid var(--border-color);
        overflow: hidden;
      `

      rightPanel.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: ${(1 - this.splitRatio) * 100}%;
        overflow: hidden;
      `

      splitter.style.cssText = `
        position: absolute;
        left: 0;
        top: ${this.splitRatio * 100}%;
        height: 4px;
        width: 100%;
        background: var(--border-color);
        cursor: row-resize;
        z-index: 1001;
      `
    }
  },

  // 更新分割比例
  updateSplitRatio: function (ratio) {
    this.splitRatio = ratio
    this.updateLayout()
    this.saveSplitViewState()
  },

  // 清理面板内容
  clearPanels: function () {
    var leftPanel = document.getElementById('split-view-left')
    var rightPanel = document.getElementById('split-view-right')

    leftPanel.innerHTML = ''
    rightPanel.innerHTML = ''

    delete leftPanel.dataset.tabId
    delete leftPanel.dataset.url
    delete leftPanel.dataset.title

    delete rightPanel.dataset.tabId
    delete rightPanel.dataset.url
    delete rightPanel.dataset.title
  },

  // 保存分屏视图状态
  saveSplitViewState: function () {
    if (window.settings) {
      settings.set('splitViewActive', this.isActive)
      settings.set('splitViewLayout', this.currentLayout)
      settings.set('splitViewRatio', this.splitRatio)
    }
  },

  // 加载分屏视图状态
  loadSplitViewState: function () {
    if (window.settings) {
      var active = settings.get('splitViewActive')
      var layout = settings.get('splitViewLayout')
      var ratio = settings.get('splitViewRatio')

      if (active !== undefined) this.isActive = active
      if (layout) this.currentLayout = layout
      if (ratio !== undefined) this.splitRatio = ratio

      if (this.isActive) {
        this.activateSplitView()
      }
    }
  }
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      splitView.initialize()
    }, 100)
  })
} else {
  setTimeout(function () {
    splitView.initialize()
  }, 100)
}
