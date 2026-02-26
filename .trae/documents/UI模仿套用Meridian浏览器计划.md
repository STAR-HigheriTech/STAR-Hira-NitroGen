# Meridian UI 适配完成计划

## 目标

完成 `meridianAdapter.js` 文件的编写，确保所有现有 JavaScript 功能能够与新的
Meridian HTML 结构正常工作。

## 实现步骤

### 1. 完成 `meridianAdapter.js` 核心功能

#### 标签管理功能

- 实现 `setActiveTab` 函数：设置当前活动标签页的样式和状态

- 实现 `setupEventListeners` 函数：为新的 HTML 元素添加事件监听器

  - 新标签按钮点击事件

  - 标签页点击事件（切换标签）

  - 标签页关闭事件

  - 浏览器控制按钮事件（回退、前进等）

- 实现 `initializeTheme` 函数：初始化主题设置

#### 浏览器控制功能

- 更新 `browserUI.js` 中的函数调用，使其使用新的 HTML 元素

- 确保搜索栏功能正常工作

- 实现浏览器控制按钮（回退、前进、刷新）的功能

#### 事件处理

- 绑定标签更新事件，确保标签标题和状态实时更新

- 绑定窗口大小变化事件，确保 UI 响应式调整

- 实现标签页拖拽功能（如果需要）

### 2. 集成现有功能

#### 搜索栏集成

- 更新 `searchbar.js` 中的 `el` 引用，确保它指向新的搜索栏元素

- 确保搜索栏的显示/隐藏功能正常工作

- 实现搜索栏的键盘快捷键支持

#### 标签栏集成

- 替换 `tabBar.js` 中的标签栏引用，使用新的 `#web-label-bar`

- 确保标签页的创建、更新、删除功能正常工作

- 实现标签页的活动状态管理

### 3. 测试和调试

#### 功能测试

- 测试标签页的创建、切换、关闭功能

- 测试浏览器控制按钮功能

- 测试搜索栏功能

- 测试主题切换功能

#### 兼容性测试

- 确保所有现有功能都能正常工作

- 检查是否有任何 JavaScript 错误

- 确保 UI 显示正确，没有样式问题

## 关键函数实现

### `setActiveTab(tabId)`

```javascript
function setActiveTab(tabId) {
  // 移除所有标签的活动状态
  document.querySelectorAll('.web-label').forEach((tab) => {
    tab.classList.remove('active');
  });

  // 设置当前标签为活动状态
  const activeTab = document.querySelector(`[data-tab="${tabId}"]`);
  if (activeTab) {
    activeTab.classList.add('active');
  }
}
```

### `setupEventListeners()`

```javascript
function setupEventListeners() {
  // 新标签按钮事件
  document.getElementById('add-tab-button').addEventListener('click', () => {
    require('browserUI.js').addTab();
  });

  // 浏览器控制按钮事件
  document.getElementById('back-button').addEventListener('click', () => {
    webviews.goBack(tabs.getSelected());
  });

  document.getElementById('forward-button').addEventListener('click', () => {
    webviews.goForward(tabs.getSelected());
  });

  // 标签栏点击事件
  document.getElementById('web-label-bar').addEventListener('click', (e) => {
    const tabElement = e.target.closest('.web-label');
    if (tabElement) {
      const tabId = tabElement.getAttribute('data-tab');
      require('browserUI.js').switchToTab(tabId);
    }
  });
}
```

### `initializeTheme()`

```javascript
function initializeTheme() {
  // 根据设置初始化主题
  const theme = settings.get('theme') || 'light';
  document.body.setAttribute('data-theme', theme);

  // 监听主题变化
  settings.listen('theme', (newTheme) => {
    document.body.setAttribute('data-theme', newTheme);
  });
}
```

## 预期结果

- 所有现有功能正常工作

- 新的 Meridian UI 正确显示

- 标签页管理功能完整

- 浏览器控制功能完整

- 搜索栏功能正常

- 主题切换功能正常

## 文件修改

- `js/meridianAdapter.js`：完成适配层实现

- `index.html`：已完成（无需修改）

- `dist/bundle.css`：已完成（无需修改）

## 风险评估

- **风险**：现有功能与新 UI 结构不兼容 **缓解**：仔细测试所有功能，确保适配层正
  确映射所有接口

- **风险**：事件监听器冲突 **缓解**：确保在设置新事件监听器之前移除旧的监听器

- **风险**：样式问题 **缓解**：确保 CSS 样式正确应用到新的 HTML 元素上

## 完成标准

- 所有标签页功能正常工作

- 浏览器控制功能正常

- 搜索栏功能正常

- 主题切换功能正常

- 没有 JavaScript 错误

- UI 显示符合 Meridian 浏览器设计
