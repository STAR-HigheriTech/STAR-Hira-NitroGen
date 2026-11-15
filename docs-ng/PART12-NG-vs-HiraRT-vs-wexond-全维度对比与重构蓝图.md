# PART12 · NG vs HiraRT vs wexond(Hira) 全维度对比与重构蓝图

> 目的：把「NG 网页视图/多标签/生命周期/多 profile」从一开始就错的设计，与两个参考项目（HiraRT = 现代化参考；wexond = 老 Hira 屎山反面教材）做**逐维度、逐文件**对比，得出「不是性能小 bug，而是架构性错误」的结论，并给出**照抄 RT、改造 NG** 的落地蓝图。
>
> 铁律：功能完善优先、流畅至上、插件化/模块化/彻底解耦、优先现代化语言（TS > JS）。

---

## 0. 结论先行（TL;DR）

NG 的卡顿/冻结**不是**「某个函数慢」，而是四个**架构级错误**：

| #   | 错误                                                   | 后果                                                                                                           | RT 正确做法                                                                                               |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| E1  | **用 `removeChildView/addChildView` 来隐藏标签页**     | NativeViewHost 被拆掉→`WasHidden`→合成器销毁→再挂载全量重绘（数百 ms），表现为切标签/点击网页/开浮层时窗口冻结 | `addChildView` **只做一次**，切换只用 `setVisible(true/false)` + `setBounds`                              |
| E2  | **Session 用 `fromPartition('persist:profile-<id>')`** | 分区名是逻辑字符串，Chromium 无法按「真实 profile 目录」隔离磁盘缓存/Cookies/Storage，缓存互相污染、锁竞争     | `session.fromPath(profilesController.getProfilePath(profileId))`，每个 profile 一个**真实目录**           |
| E3  | **图层重排（z-order）每次全量 re-add**                 | 每次显隐浮层/面板都 `cv.addChildView()` 整条栈重挂，触发多次 NativeViewHost 重建                               | `LayerManager._layersChanged()` 用**公共前缀优化**，只从第一个分歧点开始 re-add                           |
| E4  | **TabManager 是 1400 行上帝对象**                      | 身份/状态/布局/休眠/持久化/上下文菜单全耦合，任何一处改动都可能引发全链路副作用                                | Tab 拆成 `Tab`(身份+状态) / `TabLayoutManager` / `TabLifecycleManager` / `TabPersistenceManager` 四权分立 |

NG 里其实**已经抄了 RT 的正确实现，但抄完没接线，成了死代码**：

- `infra/infra-window/src/LayerStack.js`（前缀优化重排 + focus 优先级 + modal 阻挡）—— **完全没被 require**。
- 真正在跑的 `LayoutCoordinator._restack()` 反而是**全量 re-add** 的落后版本。

> ✅ **已修复（阶段 A 已完成）**：`LayerStack.js` 已接线为 `LayerManager` 的内部纯规则，`LayoutCoordinator` 改为向 `LayerManager` 注册 `Layer`（声明式 z 序 + 前缀跳过增量重排 + `reallocateFocus`）；全量 `_restack` 已退役。另见阶段 E/F 与 `D1`/`D2` 的批注。

---

## 1. 三方总览

| 维度         | **HiraRT（目标）**                               | **NG（现状）**                                                                                               | **wexond（反面教材）**                     |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 语言/技术    | TypeScript + 控制器单例                          | 混合 JS（apps/domain/infra/ui/packages 五层）                                                                | TypeScript（老）                           |
| 视图挂载     | `WebContentsView` + `LayerManager` 单挂          | `WebContentsView` + `LayoutCoordinator` 半挂                                                                 | `BrowserView` + `ViewManager` **反复拆挂** |
| 图层系统     | `Layer`/`LayerManager`（前缀优化）               | `LayerStack`(纯规则) + `LayerManager`(已接线)                                                                | 无（`addBrowserView` 顺序即 z-order）      |
| Tab 身份     | 稳定自增 `id:number`                             | `randomUUID()` 字符串                                                                                        | `webContents.id`（休眠即失效）             |
| 休眠/唤醒    | 销毁整个 `WebContentsView` + `PreSleepState`     | 销毁 `webContents`，留 `_tabOptions`                                                                         | 无（靠 `setBackgroundThrottling`）         |
| 持久化       | SQLite(drizzle) + 脏标记 2s 批量 flush           | `session.json` 同步写                                                                                        | `datastore` JSON                           |
| Session      | `fromPath(profileDir)` 真目录                    | ✅ 现为 `fromPath(profiles/<id>)`（`SessionsController.js`；初始为 `fromPartition('persist:profile-<id>')`） | **全局单一** `persist:view`                |
| 窗口         | `WindowsController` + 按类型 `WindowTypeManager` | `WindowRegistry` + `WindowFactory` 28 种子窗                                                                 | `WindowsService`                           |
| Profile 加载 | `LoadedProfilesController`(promise 去重)         | ✅ `LoadedProfilesController`(promise 去重，`main.js` 包住 `getOrCreateExtensionService`)                    | 无多 profile                               |

---

## 2. 维度一：WebContentsView 挂载模型（**最核心**）

### 2.1 wexond 的错误（NG 的祖师爷）

`wexond/src/main/view-manager.ts`：

```ts
public select(id: number, focus = true) {
  const { selected } = this;
  const view = this.views.get(id);
  this.selectedId = id;
  if (selected) this.window.win.removeBrowserView(selected.browserView); // ← 拆
  this.window.win.addBrowserView(view.browserView);                       // ← 挂
  ...
}
public clear() {
  this.window.win.setBrowserView(null);   // ← 再拆
  Object.values(this.views).forEach((x) => x.destroy());
}
```

**问题**：每次切标签都要 `removeBrowserView` + `addBrowserView`。在 Electron 里，`BrowserView/WebContentsView` 一旦从父 View 移除，其底层 `NativeViewHost` 会被销毁，webContents 收到 `WasHidden`，合成器（compositor）随之销毁。再次挂载时要重建合成器 + 全量重绘 → **数百毫秒白屏/冻结**。这正是老 Hira「点哪卡哪」的根因。

### 2.2 NG 的半吊子修复

NG 在 `infra/infra-window/src/LayoutCoordinator.js` 里引入了 `_tabLayer`（一个 `View` 容器）+ `_attachTabView/_detachTabView`：

```js
_attachTabView(view) {
  const layer = this._ensureTabLayer();
  if (this._tabLayerChildren.has(view)) return;
  try { layer.addChildView(view); } catch (_) {}
  this._tabLayerChildren.add(view);
}
showTab(tabId) {
  const view = this._wcm.getTab(id) || this._wcm.createTab(id);
  this._attachTabView(view);
  if (this._visibleTabView && this._visibleTabView !== view) this._visibleTabView.setVisible(false);
  if (this._visibleTabView !== view) view.setVisible(true);
  this._visibleTabView = view;
  ...
}
```

**已经对了 80%**：标签 view 挂进 `_tabLayer` 后只切换 `setVisible`。

**但仍然错的地方**：

1. `_detachTabView` 在标签销毁时 `layer.removeChildView(view)` —— 若在「切换/休眠」路径被误用，就退回到 E1。
2. **`_restack()` 每次都把整条栈（含 `_tabLayer`）`cv.addChildView()` 重挂一遍**，见 §3.2。
3. 浮层（searchbar/tabpreview/permission/findbar/password）走 `_floatOrder` 数组 + `setFloatBounds`，**显隐切换时靠 re-stack 重排**，没有独立的 `Layer` 抽象，focus/modal 语义靠零散判断。

### 2.3 HiraRT 的正确模型

`RT/src/main/controllers/windows-controller/layer-manager/index.ts`：

```ts
export class Layer<ViewType extends Electron.View = Electron.View> {
  public readonly view: ViewType;
  public readonly zIndex: number;
  public readonly focusPriority: number;
  public readonly modalTo: (zIndex: number) => boolean;
  ...
  setVisible(visible: boolean) {
    const oldVisible = this.isVisible();
    if (oldVisible === visible) return;      // ← 幂等，避免重复 setVisible 触发原生重绘
    this._visibilityChanging(oldVisible, visible);
    this.view.setVisible(visible);           // ← 只 setVisible，绝不 remove/add
  }
}
```

`Tab.setWindow()` 只在**窗口变更或图层类型变更**时才 `pop` 旧 Layer、`push` 新 Layer；普通显隐走 `layer.setVisible()`：

```ts
// RT/src/main/controllers/tabs-controller/tab.ts
public setWindow(window: BrowserWindow, layerType: LayerType = "tab") {
  const windowChanged = this.window !== window;
  if (windowChanged) this.removeViewFromWindow();
  if (window) {
    this.window = window;
    if (this.view && this.layer) {
      if (windowChanged || this.layer.zIndex !== zIndexes[layerType] || ...) {
        window.layerManager.pop(this.layer);
        this.layer = new Layer(window.layerManager, this.view, zIndexes[layerType], focusPriorities[layerType], createModalTo(layerType));
      }
      window.layerManager.push(this.layer);
    }
  }
}
```

### 2.4 修复方向

> ✅ **已落地（阶段 A）**：`_tabLayer` 单挂模型保留；浮层/面板/rail 均升级为 `Layer` 交给 `LayerManager`；`LayerStack.js` 已接线为 `LayerManager` 的内部纯规则，全量 `_restack()` 已退役。

---

## 3. 维度二：图层系统 / z-order / focus / modal

### 3.1 RT 的图层语义（源真相）

`RT/src/shared/layers.ts`：

```ts
export const zIndexes = {
  omnibox: 100, popover: 99, floatingSidebar: 30, webPrompt: 22,
  passkeyConditionalUI: 21, findInPage: 20, tabTargetUrlIndicator: 11,
  tab: 10, tabBack: 9, browserUI: 0
} as const;
export const focusPriorities = { omnibox: 100, popover: 99, floatingSidebar: 0, webPrompt: 22, ... tab: 10, tabBack: 9, browserUI: 0 };
export function createModalTo(layerType) { /* popover → 除 omnibox 外全部 modal；webPrompt → 只对 tab 层 modal */ }
```

### 3.2 RT 的前缀优化重排（**性能关键**）

```ts
private _layersChanged() {
  this.layers.sort((a, b) => a.zIndex - b.zIndex);
  const adjustedOldLayers = [];
  for (const o of this.oldLayers) {
    if (!this.layers.includes(o)) o.removeThisFromParentView(this.parentView); // 只清理死层
    else adjustedOldLayers.push(o);
  }
  // ★ 公共前缀优化：跳过顺序未变的头部，只从第一个分歧点开始 re-add
  let prefix = 0;
  const prefixLimit = Math.min(adjustedOldLayers.length, this.layers.length);
  while (prefix < prefixLimit && adjustedOldLayers[prefix] === this.layers[prefix]) prefix++;
  for (let i = prefix; i < this.layers.length; i++) this.layers[i].addThisAsChildView(this.parentView);
  this.oldLayers = [...this.layers];
}
```

**意义**：如果只是把一个浮层从隐藏变可见，且它的位置没变，`prefix` 会直接跳到它后面 → **零 re-add**。而 NG 的 `_restack()` 无条件把整条栈重挂。

### 3.3 NG 的死代码 vs 活代码（✅ 已修复：LayerStack 已接线，全量 `_restack` 已退役）

- **死代码** ~~`infra/infra-window/src/LayerStack.js`（正确）~~ **→ 现已接线**：

  ```js
  const FOCUS_PRIORITY = Object.freeze({ 'float:searchbar-overlay': 100, 'password-overlay': 40, ... tab: 10, 'glance-back': 9, rail: 0, panel: 0, 'ui-shell': 0 });
  const Z_INDEX = Object.freeze({ panel: 1, 'glance-back': 8, tab: 10, 'glance-front': 10, rail: 20, 'ui-shell': 30, 'float:searchbar-overlay': 40, ... });
  function computeRestackPlan(prevOrder, nextOrder) { /* returns { skip: commonPrefixLength } */ }
  ```

  ~~它**从没被 require**（`infra-window/src/index.js` 未导出），Grep 全库只有它自己引用 `computeRestackPlan`。~~
  ✅ **现状**：`LayerStack.js` 已作为 `LayerManager` 的内部纯规则被 require；其重复实现（`pickFocusTarget`/`modalBlockers`/`computeRestackPlan`）与死导出已在阶段 E 删除。

- **活代码** ~~`LayoutCoordinator._restack()`（落后）~~ **→ 已退役**：
  ```js
  // 历史实现（全量 re-add）：已由 LayerManager 的前缀跳过增量重排取代
  ```
  ✅ **现状**：`LayoutCoordinator` 不再手工重排，改由 `LayerManager` 按声明式 z 序自动收敛。

### 3.4 focus / modal 的缺失

- RT：`Layer.focus()` 会先查 `getModalLayersFor(zIndex)`，被模态层阻挡则**拒绝抢焦点**；`reallocateFocus()` 按 `focusPriority` 重新分配焦点。
- NG：`LayerStack.pickFocusTarget/modalBlockers` 写了但没用；实际 focus 靠各处零散 `webContents.focus()` 调用，**模态浮层无法阻止下层标签抢焦点** → 搜地址栏时焦点跳到网页、密码浮层失效等。

### 3.5 修复方向

1. ✅ `LayerStack.js` 已接线为 `LayerManager` 的内部纯规则。
2. ✅ `_restack()` 全量版本已退役（改由 `LayerManager` 前缀跳过增量重排）。
3. ✅ 每个浮层/面板/rail/tab 都作为 `Layer` 注册，带 `zIndex/focusPriority/modalTo`。
4. ✅ 焦点统一走 `LayerManager.reallocateFocus()`。

---

## 4. 维度三：多标签模型

### 4.1 Tab 身份

| 项目   | 身份                                                       | 休眠后是否稳定                      |
| ------ | ---------------------------------------------------------- | ----------------------------------- |
| RT     | `let nextTabId = 1; this.id = nextTabId++`（**稳定自增**） | ✅ 稳定                             |
| NG     | `tabId: randomUUID()`                                      | ✅ 稳定但不可读、不可排序、调试困难 |
| wexond | `webContents.id`                                           | ❌ 休眠/重载即变                    |

RT 注释点破关键：

```ts
// Stable counter-based tab IDs (independent of webContents.id).
// This allows tab.id to remain constant across sleep/wake cycles
// where the webContents is destroyed and recreated.
```

NG 虽然 UUID 稳定，但**没有区分 `id`（稳定）与 `webContents.id`（易变）**，导致 `_tabViewGen` 生成计数器被迫承担「识别旧事件」的职责（§4.3）。

### 4.2 职责拆分（**上帝对象 vs 四权分立**）

**RT**：`Tab` 只管身份+状态+事件，明确声明「不拥有」什么：

```ts
/**
 * Does NOT own:
 * - Layout/bounds (TabLayoutManager)
 * - Sleep/wake/fullscreen/PiP lifecycle (TabLifecycleManager)
 * - Persistence (TabPersistenceManager listens to events)
 * - New tab creation (emits "new-tab-requested", TabsController handles it)
 */
```

配套：`tab-layout.ts`(213行)、`tab-lifecycle.ts`(307行)、`tab.ts`、`tabs-controller/index.ts`。

**NG（初始）**：`infra/infra-window/src/TabManager.js` **1427 行**，把以上全部塞进一个类。结果：

- 任何布局改动都要动 TabManager；
- 休眠逻辑与持久化逻辑互相纠缠；
- 事件风暴靠 `_scheduleEmitChanged()`(queueMicrotask) 打补丁。

> ✅ **现状（阶段 C）**：已拆为 `tabRecord` / `tabEvents` / `tabLayout` / `tabLifecycle` / `tabPreSleep`，`TabManager.js` 降至 1043 行。

### 4.3 事件风暴与代际问题

**RT**：`Tab.updateTabState()` 里用「长度+索引先比、再比 active entry」的**智能 navHistory diff**，避免 `JSON.stringify` 每 tick：

```ts
const lengthChanged = newNavHistory.length !== this.lastNavHistoryLength;
const indexChanged = newNavHistoryIndex !== this.lastNavHistoryIndex;
let activeEntryChanged = false;
if (!lengthChanged && !indexChanged) {
  const oldActiveEntry = this.navHistory[this.navHistoryIndex];
  const newActiveEntry = newNavHistory[newNavHistoryIndex];
  activeEntryChanged = (oldActiveEntry?.url ?? "") !== (newActiveEntry?.url ?? "") || ...;
}
```

并用 `scheduleUpdateTabState()`(queueMicrotask) 把 `did-start-loading + did-start-navigation + page-title-updated + …` 合并成**每 tick 一次**。

**NG（初始）**：有 `_scheduleEmitChanged()`(queueMicrotask)（对），但 navHistory 比较靠 `_tabViewGen` 生成计数器 + `_isCurrentWc()` 丢弃旧事件——这是**因为 Tab 身份与 webContents 身份没分离而被迫打的补丁**。

> ✅ **现状**：标签身份已由稳定自增 `tab.id`（`tabRecord.js`）承担，navHistory 走 `diffNavHistory` 智能比较；`WebContentsManager` 的 `_tabViewGen` 代际机制已在阶段 E 删除。

### 4.4 修复方向

> ✅ **已落地（阶段 C）**：
>
> - ✅ 稳定自增 `tab.id`（`t1`/`t2`），`webContents.id` 降级为内部字段；`_tabViewGen` 已删除。
> - ✅ `TabManager.js` 已按模块拆分（`tabRecord`/`tabEvents`/`tabLayout`/`tabLifecycle`/`tabPreSleep`）。
> - ✅ navHistory 走 `tabRecord.js` 的 `diffNavHistory`（长度+索引+活动项比较，不做 `JSON.stringify`）。

---

## 5. 维度四：标签生命周期（sleep/wake/fullscreen/PiP）

### 5.1 RT 模型

`RT/src/main/controllers/tabs-controller/tab-lifecycle.ts`：

```ts
export interface PreSleepState { url: string; navHistory: Electron.NavigationEntry[]; navHistoryIndex: number }

putToSleep(knownPreSleepState?) {
  if (this.tab.asleep) return;
  if (knownPreSleepState) this.preSleepState = knownPreSleepState;
  else {
    this.tab.updateTabState();
    this.preSleepState = { url: this.tab.url, navHistory: [...this.tab.navHistory], navHistoryIndex: this.tab.navHistoryIndex };
  }
  this.tab.updateStateProperty("asleep", true);
  this.tab.teardownView();   // ★ 销毁整个 WebContentsView + webContents
}

wakeUp() {
  if (!this.tab.asleep) return;
  const window = this.tab.getWindow();
  this.tab.initializeView();          // ★ 重建 WebContentsView
  this.tab.setWindow(window);
  this.setupFullScreenListeners(window);
  this.tab.updateStateProperty("asleep", false);
  if (this.preSleepState) {
    this.tab.restoreNavigationHistory(this.preSleepState.navHistory, this.preSleepState.navHistoryIndex);
    this.preSleepState = null;
  }
  this.tab.applyUrlBackground();
}
```

RT 注释：

> Sleep/wake now destroys and recreates the WebContentsView entirely, saving **~20-50MB RAM per sleeping tab** compared to the old approach of navigating to `about:blank?sleep=true`.

**关键点**：休眠 = **销毁 view + webContents**；唤醒 = **重建 view + 恢复导航历史**；`PreSleepState` 保证 URL/历史不丢。

### 5.2 NG 模型

`infra/infra-window/src/WebContentsManager.js`：

```js
sleepTab(tabId) {
  this._removeViewFromHost(view);
  view.webContents.destroy();          // 只销毁 webContents
  this._tabViews.delete(id);
  // 保留 _tabOptions
}
wakeInternal(tabId) { /* 用 _tabOptions 重新 createTab + reload URL */ }
isTabSleeping(tabId) { return !this._tabViews.has(String(tabId)); }
```

**差异（初始）**：

- ~~NG 保留 `_tabOptions`（含 url）→ 唤醒时 reload URL，但**导航历史丢失**（只能回退到首页）。~~
- ~~NG 的 sleep 与 wake 分散在 `WebContentsManager` 和 `TabManager._wakeInternal`，没有 `PreSleepState` 抽象。~~

> ✅ **现状（阶段 C 已完成）**：新增 `infra/infra-window/src/tabPreSleep.js`（`capturePreSleepState` / `restoreNavigationHistory`，对齐 RT `PreSleepState`）与 `infra/infra-window/src/tabLifecycle.js`（`sleepTab` / `wakeTab` / `wakeInternal`）。休眠前抓 URL + `navHistory` + `navHistoryIndex`，唤醒时重建并按快照还原导航历史。

### 5.3 自动唤醒

RT `tab-layout.ts`：

```ts
updateLayout() {
  ...
  if (!visible) return;
  if (justShown && tab.webContents) tab.loadedProfile.extensions.selectTab(tab.webContents);
  this.lifecycleManager.wakeUp();   // ★ 显示即自动唤醒休眠标签
  ...
}
```

~~NG 的 `showTab` 只 `setVisible`，**不自动唤醒**（靠 TabManager 单独判断），容易出现「切到休眠标签显示空白」。~~ ✅ **已修**：`TabManager._showTab` 对齐 RT「显示即 wakeUp」——`if (this._wcm.isTabSleeping(id)) this._wakeInternal(id)` 后再 `layout.showTab(id)`（见 `infra/infra-window/src/TabManager.js`）。

### 5.4 修复方向

> ✅ **已落地（阶段 C）**：`tabPreSleep.js`（`PreSleepState`）、`showTab` 显示即 `wakeUp()`、sleep/wake 已从 `WebContentsManager`/`TabManager` 抽到 `tabLifecycle.js`。

---

## 6. 维度五：多 Profile / Space / Session（**第二个大缺陷**）

### 6.1 三方对比

| 项目                 | Session 获取方式                                                                       | 隔离粒度                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **RT**               | `session.fromPath(profilesController.getProfilePath(profileId))`                       | **真实目录**，每个 profile 独立磁盘缓存/Cookies/Storage/Extensions |
| **NG（初始）**       | `session.fromPartition('persist:profile-<id>')`                                        | 逻辑分区名，磁盘目录由 Chromium 内部映射，**不透明、易污染**       |
| **NG（现状，已修）** | ✅ `session.fromPath(profiles/<id>)`（`infra/infra-window/src/SessionsController.js`） | 真实目录，按 profile 隔离                                          |
| **wexond**           | `session.fromPartition('persist:view')`（**全局唯一**）                                | 无隔离，所有窗口/配置共用一个 session                              |

### 6.2 RT 的实现

`RT/src/main/controllers/sessions-controller/index.ts`：

```ts
private _create(profileId: string): Session {
  const profileSessionPath = profilesController.getProfilePath(profileId);
  const profileSession = session.fromPath(profileSessionPath);   // ★ fromPath
  registerProtocolsWithSession(profileSession, ["hx", "hirax-external"]);
  registerHandlersWithSession(profileSession);
  registerPreloadScripts(profileSession);
  setupInterceptRules(profileSession);
  this.sessions.set(profileId, profileSession);
  return profileSession;
}
```

`LoadedProfilesController`（`loaded-profiles-controller/index.ts`）负责「一个 profile 加载一次」：

- `loadedProfiles: Map<profileId, LoadedProfile>`；
- `loadingProfilePromises: Map<profileId, Promise<boolean>>`（**并发去重**：重复 load 等待同一 promise）；
- 加载时：`transformUserAgentHeader` 伪装 UA、`new ElectronChromeExtensions({session})`、`new ExtensionManager(...)`、`installChromeWebStore(...)`；
- `unload()` → `_handleProfileUnload()` → 销毁该 profile 所有 tab。

### 6.3 NG 的实现与问题

`domain/domain-profile/src/profileUtil.js`：

```js
function buildStoragePartition(profileId) {
  return `persist:profile-${id}`;
}
const PROFILE_DIR_ROOT = 'profiles';
function profileRelPath(id) {
  return `profiles/${id}`;
}
```

- ~~NG 有 `profiles/<id>` **目录**，但 session 却用 `fromPartition`，**目录和 session 没绑定** → 磁盘缓存实际落在 Chromium 默认 `Partitions/` 下，且 `disk-cache-dir` 被全库共用。~~ ✅ **已修**：新增 `infra/infra-window/src/SessionsController.js`，每 profile 一个 `session.fromPath(profiles/<id>)` 持久会话，会话对象与真实磁盘目录强绑定（`domain-profile` 的 `buildStoragePartition` 已退居历史遗留）。
- ~~NG 的 profile 加载缓存叫 `getOrCreateExtensionService`（`apps/app-main/src/main/main.js`），**职责混入 extensions**，没有独立的 `LoadedProfilesController`。~~ ✅ **已修**：新增 `infra/infra-window/src/LoadedProfilesController.js`（按 key 单飞），`main.js` 用它包住 `getOrCreateExtensionService(profileId)`。
- NG 多了 **Space 二级模型**：`sessionDirFor(profileId, spaceId)` → `userData/profiles/<profileId>/spaces/<spaceId>/session.json`。RT 的 Space 是 `spaces-controller` + `ipc/session/spaces.ts`，但 session 仍是 profile 级。
- ~~标签 session 绑定：NG 在 `WebContentsManager.createTab` 用 `this._tabSession`（由 `main.js` 调 `setTabSession(extensionService.session)` 注入），**全局一个** → 多 profile 无法真正隔离。~~ ✅ **已修**：`createTab` 的会话解析优先级为「显式 session > `sessionResolver`（按 profileId/incognito）> incognito memory 兜底 > `setTabSession` 遗留兜底」；`main.js` 把 `sessionsController` 作为 `sessionResolver` 注入 `WebContentsManager`。

### 6.4 修复方向

> ✅ **已落地（阶段 B）**：1）`session.fromPath(profileDir)`；2）`LoadedProfilesController` 单飞加载；3）`createTab` 的 session 按 `profileId`（`sessionResolver`）解析。4）Space 的 `sessionDirFor(profileId, spaceId)` 二级目录模型保留（待评估是否收敛到 profile 级）。

1. **session 改用 `fromPath(profileDir)`**，让 `profiles/<id>` 目录真正成为 Chromium profile 根。
2. 新增 `LoadedProfilesController`（promise 去重 + UA + extensions + web store），把 extensions 加载从 `main.js` 抽出。
3. `WebContentsManager.createTab` 的 session 由「按 tab 的 profileId」决定，而非全局 `_tabSession`。
4. Space 保持 NG 的二级目录模型（这是 NG 的合理扩展），但 session 归属 profile。

---

## 7. 维度六：持久化

| 项目       | 方案                                                       | 频率                                       | 退出时                 |
| ---------- | ---------------------------------------------------------- | ------------------------------------------ | ---------------------- |
| **RT**     | SQLite (drizzle + better-sqlite3)，`TabPersistenceManager` | 脏标记 + `FLUSH_INTERVAL_MS=2000` 批量事务 | `flush()` 同步         |
| **NG**     | `session.json` via `sessionUtil`                           | 事件驱动，`writeJsonAtomicSync` **同步写** | `before-quit` 同步保存 |
| **wexond** | `datastore` JSON                                           | 即时                                       | —                      |

### 7.1 RT 的实现（`saving/tabs/index.ts`）

```ts
const FLUSH_INTERVAL_MS = 2000;
export class TabPersistenceManager {
  private dirtyTabs = new Map<string, PersistedTabData>();
  private removedTabs = new Set<string>();
  private dirtyWindowStates = new Map<string, PersistedWindowState>();
  start() { this.flushInterval = setInterval(() => this.flush().catch(...), FLUSH_INTERVAL_MS); }
  markDirty(uniqueId, data); markRemoved(uniqueId); markWindowStateDirty(...); removeTab(uniqueId);
  async flush() { /* snapshot + clear；db.transaction upsert dirty / delete removed；出错 requeue */ }
  async loadAllTabs(); async loadAllTabGroups(); async loadAllWindowStates();
  wipeAll();
}
export const tabPersistenceManager = new TabPersistenceManager();
export function shouldArchiveTab(lastActiveAt);
export function shouldSleepTab(lastActiveAt);
```

**优点**：批量事务、失败重入队、脏标记避免全量写、2s 节流避免频繁 IO。

### 7.2 NG 的问题

- `domain/domain-session/src/index.ts` 的 `session.save(dir, tabManager)` 是**同步 JSON 写**（`writeJsonAtomicSync`）→ 每次标签变动都可能阻塞主进程 → 卡顿来源之一。
- 无脏标记/批量，无 `shouldArchiveTab/shouldSleepTab` 策略。
- `switchProfile/switchSpace` 时保存（用户已让改成 `setImmediate` 异步，见 main.js）。

### 7.3 修复方向

- 保留 NG 的 `session.json`（文件式更易调试、符合「双轨」），但改为**脏标记 + 2s 批量 + 异步写**，退出时同步 flush。
- 引入 `shouldArchiveTab/shouldSleepTab` 策略。
- 中期可选迁移到 SQLite（PART4 已有设计），但非本次大重构必须。

---

## 8. 维度七：窗口模型

| 项目       | 结构                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RT**     | `WindowsController`（统一注册/查找）+ 按类型 `WindowTypeManager<C>`：`settings/onboarding` 为 `singleton:true`，`browser/extensionPopup` 为多实例 |
| **NG**     | `WindowFactory`（28 种 `createSubWindow`）+ `WindowRegistry`（`Map<id, win>`）+ `window-config.js`（类型→url/尺寸表）                             |
| **wexond** | `WindowsService`                                                                                                                                  |

RT `WindowTypeManager` 亮点：

```ts
public getSingletonWindow(...args) {
  this._checkIsSingleton();
  const openWindows = this.getAll();
  if (openWindows.length > 0) return openWindows[0];
  return this._new(...args);
}
```

`singleton` 语义内建，避免重复开设置窗。

NG 的 `WindowRegistry` 只有 `register/unregisterById/getById/listIds/list`，**没有类型概念**，`WindowFactory` 靠 `options` 传参，类型语义散在 `window-config.js` + 各 `createSubWindow` 调用点。

### 修复方向

- `WindowRegistry` 增加 `type` 维度（或在 app 层包一个 `WindowTypeManager`），把 `window-config.js` 的类型表升级为「类型管理器」。

---

## 9. 维度八：启动引导 / 退出流程

### 9.1 RT 的 bootstrap seam（`browser.ts`）

```ts
export async function bootstrapBrowser() {
  await cleanupStaleEphemeralProfiles();
  tabPersistenceManager.start();
  pinnedTabsController.loadAll();
  initCursorEdgeMonitor();
  initTabSync();
  processInitialUrl();
  setupSecondInstanceHandling(); // app/instance.ts
  setupPlatformIntegration(); // app/platform.ts
  runOnboardingOrInitialWindow();
  setupAppLifecycle(); // app/lifecycle.ts
  setupBasicAuthHandler();
}
```

退出：`quit-controller` + `handlers/before-quit.ts` + `can-quit.ts`，配合 `tabPersistenceManager.flush()`。

### 9.2 NG 的 bootstrap

`apps/app-main/src/main/main.js` 单文件承担：单实例锁、`disk-cache-dir`/`media-cache-dir` switches、`webContentsManager.setTabSession`、`emit → listChromeWebContents()`、`sessionDirFor`、`switchProfile/switchSpace`、`before-quit` 同步保存、extensions service 缓存……

**问题**：启动/退出逻辑与业务（extensions、session、profile）混在一处，没有 `app/` 分层。

### 修复方向

- 抽出 `apps/app-main/src/main/app/{lifecycle,instance,urls}.js`，与 `bootstrap` 分离。

---

## 10. 维度九：IPC 与渲染进程隔离

- **NG（更新）**：`emit()` 已从「只发给 chrome 层」升级为**订阅登记制广播** —— 渲染层 `hira.on.subscribe()` 时发 `listeners:add` 登记，主进程 `ListenerRegistry` 记账，`createBroadcaster().send(route, payload, { skipWebContentsId })` 只发给登记过该 route 的 webContents。既避免了 `getAllWebContents()` 的 N× 广播风暴，也修掉了旧「只发给 chrome 层」过滤的副作用：跑在**标签页**里的内部页（`hira://bookmarks` / `hira://history`）过去订阅了却永远收不到事件，现在只要订阅就收得到。实现见 `infra/infra-ipc/src/ListenerRegistry.js`、`infra/infra-ipc/src/index.js`、`apps/app-main/src/main/ipc/listeners.js`、`infra/infra-window/preload/{shell,panel,tab}-preload.js`。
- NG 的 `LayoutCoordinator` IPC（`ipc/layout.js`）用**单向 IPC**（`ipcMain.on` + `ipcRenderer.send`）做浮层 show/hide/display，**零往返**——这是 NG 的亮点，保留。
- **RT** 用 `ipc/index.ts` + `listeners-manager.ts` 统一注册，按域拆分（`ipc/browser/*`, `ipc/app/*`, `ipc/session/*`）。
- **缺陷（初始）**：NG 的 `LayoutCoordinator` 既是「布局计算器」又是「图层管理器」又是「IPC 目标」，职责过载。
- ✅ **现状（阶段 A）**：图层管理已抽离为 `LayerManager` + `LayerStack`（纯规则 + 纯宿主），`LayoutCoordinator` 只负责布局计算与视图装配。

---

## 11. 维度十：Extensions

- **RT**：`modules/extensions/{main,management,locales,assets,permission-warnings}.ts` + `LoadedProfilesController` 内 `new ElectronChromeExtensions({session, ...})`，与 session 强绑定。
- **NG**：`infra/infra-extensions/src/index.js` + `main.js` 里 `getOrCreateExtensionService` 缓存；`WebContentsManager.setTabSession(extensionService.session)`。
- ~~**问题**：NG 把 extensions 的 session 当作**全局 tab session**，与多 profile 冲突。~~ ✅ **已修**：`main.js` 现用 `sessionsController.get(profileId)`（`session.fromPath`）作为扩展与标签共用会话，`setTabSession` 仅遗留兜底。

---

## 12. NG 具体缺陷清单（可定位）

| 编号 | 文件                                                  | 行/符号                                                   | 问题                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `infra/infra-window/src/LayoutCoordinator.js`         | `_restack()`                                              | ~~全量 re-add，无前缀优化~~ → ✅ 已退役，改由 `LayerManager` + `LayerStack` 前缀跳过增量重排                                                                                                                                |
| D2   | `infra/infra-window/src/LayerStack.js`                | 全文件                                                    | ~~**死代码**，未被 require~~ → ✅ 阶段A 已接线为 LayerManager 的内部纯规则；阶段E 已删除其重复实现（`pickFocusTarget`/`modalBlockers`/`computeRestackPlan`）与死导出                                                        |
| D3   | `infra/infra-window/src/LayoutCoordinator.js`         | `_detachTabView()`                                        | ~~潜在退回拆挂~~ → ✅ 现状仅由 `forgetView()`（关闭/休眠销毁路径）调用，注释明确「销毁前必须摘除」                                                                                                                          |
| D4   | `infra/infra-window/src/TabManager.js`                | 全文件(1427→**1043** 行)                                  | ~~上帝对象，职责未拆~~ → ✅ 已按模块拆分：`tabRecord`/`tabEvents`/`tabLayout`/`tabLifecycle`/`tabPreSleep`                                                                                                                  |
| D5   | `domain/domain-profile/src/profileUtil.js`            | `buildStoragePartition()`                                 | ~~`fromPartition` 而非 `fromPath`~~ → ✅ 已改：`infra/infra-window/src/SessionsController.js` 用 `session.fromPath(profiles/<id>)`；`buildStoragePartition` 退居历史遗留                                                    |
| D6   | `infra/infra-window/src/WebContentsManager.js`        | `_tabSession` 全局                                        | ~~多 profile 无法隔离~~ → ✅ 已改：会话按 `sessionResolver`（profileId/incognito）解析，`_tabSession` 仅遗留兜底                                                                                                            |
| D7   | `infra/infra-window/src/WebContentsManager.js`        | `sleepTab()`                                              | ~~只销毁 webContents，丢导航历史~~ → ✅ 已加 `tabPreSleep.js`（`PreSleepState`），休眠抓取并唤醒还原导航历史                                                                                                                |
| D8   | `domain/domain-session/src/index.ts`                  | `save()`                                                  | ~~同步 JSON 写，阻塞主进程~~ → ✅ 已改：`SessionPersistence.js` 脏标记 + 2s 批量异步 `saveAsync` + 退出 `flushSync()`；`main.js` 已接线（`markDirty` / `flushSync`）                                                          |
| D9   | `apps/app-main/src/main/main.js`                      | 全文件                                                    | ~~bootstrap/业务/extensions 混合~~ → ✅ 已分层：`app/{preboot,lifecycle,instance,urls}.js` + `module-bootstrap.js` 拓扑启动；ready 前置动作（Chromium 开关/UA/订阅登记/认证/崩溃收集/证书留档/异常兜底/AppUserModelID）全部收口 `app/preboot.js` |
| D10  | `infra/infra-window/src/WindowRegistry.js`            | 全文件                                                    | ~~无类型维度~~ → ✅ 已加：`register(win, type)` / `listByType(type)` / `getSingleton(type)`，主/子窗口按类型分治                                                                                                            |
| D11  | `infra/infra-window/src/LayoutCoordinator.js`         | `showTab()`                                               | ~~不自动唤醒休眠标签~~ → ✅ 已改：`TabManager._showTab` 显示即 `wakeInternal`                                                                                                                                               |
| D12  | NG 全库                                               | ~~`randomUUID()`~~ tab id                                 | ~~无稳定自增 id 与 webContents.id 分离~~ → ✅ 已改：`tabRecord.js` 用稳定自增 id（`t1`/`t2`）+ `diffNavHistory`                                                                                                             |
| D13  | `apps/app-main/src/main/settings/appliers/privacy.js` | `createDoNotTrackApplier` + `privacy.do_not_track` 默认值 | **★页面加载"跟IE一样慢"的根因★**：`webRequest.onBeforeSendHeaders` 逐请求阻塞钩子被**启动时无条件安装**（`settings/sync` 的 `applyAll`），且默认值为 `true` → 每个资源请求都要同步往返主进程。RT 全库**零** webRequest 钩子 |

---

## 13. 重构蓝图（照抄 RT，改造 NG）

> 原则：**不推翻 NG 已有的合理部分**（`_tabLayer` 单挂、单向 IPC、五层目录），而是把 RT 的**正确抽象**接线进来，替换掉落后/死掉的实现。

### 阶段 A：图层系统接线（收益最大，风险最低）✅ 已完成

1. 把 `LayerStack.js` 升级为 `LayerManager`（`Layer` 类 + 前缀优化 `_layersChanged` + `getModalLayersFor/reallocateFocus/getFocusedLayer`）。
2. `LayoutCoordinator` 内所有 view（tab/panel/rail/shell/float/password）包装为 `Layer`，显隐走 `setVisible`。
3. `_restack()` 改用 `computeRestackPlan` 前缀跳过。
4. 焦点统一走 `LayerManager.reallocateFocus()`。

### 阶段 B：Session / Profile 架构 ✅ 已完成

1. ✅ `buildStoragePartition` → `session.fromPath(profileDir)`（`infra/infra-window/src/SessionsController.js`）。
2. ✅ 新增 `LoadedProfilesController`（promise 去重），`main.js` 用它包住 extensions 加载。
3. ✅ `WebContentsManager.createTab` 的 session 按 tab 的 `profileId` / incognito 经 `sessionResolver` 解析（`setTabSession` 仅遗留兜底）。

### 阶段 C：Tab 职责拆分 ✅ 已完成

1. ✅ 稳定自增 `tab.id`（`t1`/`t2`，`infra/infra-window/src/tabRecord.js`）。
2. ✅ `TabManager` 已按模块拆分（`tabRecord` / `tabEvents` / `tabLayout` / `tabLifecycle` / `tabPreSleep`），主文件 1427 → 1043 行。
3. ✅ 引入 `PreSleepState`（`tabPreSleep.js`），`_showTab` 自动 `wakeInternal`。
4. ✅ navHistory 智能 diff：`tabRecord.js` 的 `diffNavHistory`。

### 阶段 D：持久化与启动分层 ✅ 已完成

1. ✅ `session.json` 改脏标记 + 2s 批量异步写 + 退出同步 flush（`domain/domain-session/src/sessionPersistence.ts`）。
2. ✅ 已抽出 `apps/app-main/src/main/app/{preboot,lifecycle,instance,urls}.js`（并新增 `module-bootstrap.js` 拓扑启动）。
   `preboot.js` 统一承担 app ready 之前的强时序动作：早期设置读取、Chromium 开关、UA 伪装、
   事件订阅登记（listenerRegistry/broadcaster）、HTTP 认证、crashReporter、证书错误留档、进程级异常兜底、AppUserModelID。
3. ✅ `WindowRegistry` 增加类型维度（`register(win, type)` / `listByType` / `getSingleton`）。

### 阶段 E：清理 ✅ 已完成

- **统一 `webPreferences` 定义点**：新增叶子模块 `infra/infra-window/src/webPreferences.js`
  （`buildWebPreferences({ preload, ...extra })` + `defaultPreloadPath(name)`），
  安全基线（`contextIsolation:true / nodeIntegration:false / sandbox:true`）**全库仅此一处**。
  `WindowFactory`（主/子窗口）与 `WebContentsManager`（tab/panel/rail/浮层/密码浮层）
  全部改为调用它，消除了 5 处散落的 `webPreferences` 字面量。`WindowFactory` 继续 re-export
  `buildWebPreferences`，公开契约不变。
- **删除死代码**：
  - `LayerStack` 的死导出（`index.js` 的 `...require('./LayerStack')`）—— 该模块现仅为
    LayerManager 的内部纯规则，不再对外暴露第二套 z 序来源。
  - `LayerStack` 中零消费者的重复实现 `pickFocusTarget` / `modalBlockers` / `computeRestackPlan`
    （运行时等价逻辑在 `LayerManager.reallocateFocus` / `_layersChanged`，删掉避免两处实现）。
  - `WebContentsManager` 的 `_tabViewGen` 代际机制与 `getTabViewGen()` —— 无任何调用方；
    标签身份已由 TabManager 的稳定自增 id 承担。

### 阶段 F：逐请求阻塞根因（webRequest）✅ 已完成

- **现象**：点链接 / 点按钮 / 开新标签 / 整页加载都"卡一会儿"，比 IE 还慢。
- **根因**：`createDoNotTrackApplier` 在所有标签共享的 session（`extensionService.session`）上安装
  `session.webRequest.onBeforeSendHeaders`，且**启动即装** —— `settings/sync` 的 `applyAll()`
  无条件跑全部 applier，**与设置值无关**（旧实现首帧就把 `installed = true`）。
  Electron 的 `webRequest` 是**逐请求阻塞**的：HTML/CSS/JS/图片/字体/XHR 的每一个请求，
  都必须先同步往返主进程 listener（拷贝 headers、遍历 key、回调）才允许发出 → 串行化延迟叠加；
  导航期间主进程被这些回调占满，连 UI 自身的 IPC（加载态、omnibox 更新）也被推迟 → 点击"冻结"。
  **RT 全库零 webRequest 钩子**（已 grep 全量确认）。
- **修复（对齐 RT 的"零钩子"模型）**：
  1. `settings/appliers/privacy.js`：钩子改为**惰性 + 条件**安装 —— 仅当
     `privacy.do_not_track === true` 才装，关掉立即 `onBeforeSendHeaders(null)` 拆除；
     并跟踪钩子挂在哪个 session（切 profile 时先拆旧再装新）。
  2. 默认值 `privacy.do_not_track` 由 `true` 改为 `false`（`domain/domain-settings` +
     `settings/registry`）—— 对齐主流浏览器（Chrome/Edge/Safari 及 2024 起的 Firefox
     均已不再默认发送 DNT）。
     → 默认路径**零逐请求开销**，与 RT 完全一致；功能保留（用户可自行开启）。
- **已排除（非根因）**：adblocker（该结论写于当时 —— `main.js` 显式 `enableAdblocker:false`，未启用；**现状已改为 `enableAdblocker: true`** 并在 `infra/infra-extensions` 初始化 adblocker）、GPU 禁用、
  主窗口透明、jsDialog 自旋、`tab:changed` 同步写盘（已防抖异步）、`loadURL` await
  （已 fire-and-forget）、`_tabs` Map 重建（阶段 F-2 已修）。

---

## 14. 验收标准（功能优先，不跑测试脚本）

- 切标签、点击网页、跳转、开/关浮层/面板：**无窗口冻结**，跟手流畅。
- 多 profile 切换：缓存/Cookies 真正隔离，无锁竞争。
- 休眠标签：内存下降（每标签 ~20-50MB），唤醒后**保留导航历史**。
- 多标签 30+：主进程无同步阻塞写，事件无风暴。
- 代码：`TabManager` 拆分完成（1427→**1043** 行，另拆出 tabRecord/tabEvents/tabLayout/tabLifecycle/tabPreSleep），`LayerStack` 不再是死代码，
  `webPreferences` 全库单一定义点。
