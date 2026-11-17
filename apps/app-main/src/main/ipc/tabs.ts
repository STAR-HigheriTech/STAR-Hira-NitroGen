import { ipcMain as globalIpcMain, type IpcMain } from 'electron'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { createProviderInvoker } = require('./provider-bridge.js') as {
  createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown, context?: unknown) => T | Promise<T>
}
const { createTabCloseGuard } = require('../tab-close-guard') as {
  createTabCloseGuard(options: unknown): { shouldCancel(kind: string, tabId: unknown): unknown | Promise<unknown> }
}
const { resolveHomeUrl } = require('../home-url') as { resolveHomeUrl(settings: SettingsPort): string }
const { TABS_SETTING_KEYS } = require('@hira-ng/shared-types/src/tabs-settings.mjs') as {
  TABS_SETTING_KEYS: { openAfterCurrent: string; reuseExistingTab: string }
}
// 「算不算普通网页」的唯一判据（去重跳转只对 http(s) 生效）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs') as { isHttpUrl(url: string): boolean }

type MethodPort = Record<string, (...args: unknown[]) => unknown>
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
interface SettingsPort { get(key: string): unknown }
interface TabsIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['tabs']
  tabManager: MethodPort
  providerRegistry: unknown
  settingsService: SettingsPort
  tabDropZone?: MethodPort | null
  splitToolbar?: MethodPort | null
  ipcMain?: IpcMain
  getJsDialogManager?: () => unknown
}

/** 单向 IPC 通道名构造（与 preload 的 makeChannel 一致，见 ipc/layout.js 同一约定）。 */
const sendCh = (route: string): string => `ngipc:send:${route}`

export function registerTabsIpc(
  typedMain: IpcTypedMain,
  {
    routes,
    schemas,
    tabManager,
    providerRegistry,
    settingsService,
    tabDropZone,
    splitToolbar,
    ipcMain: injectedIpcMain,
    getJsDialogManager
  }: TabsIpcContext
): void {
  const invoke = createProviderInvoker(providerRegistry)
  /**
   * 裸通道（`ipcMain.on`）的登记对象。
   *
   * 与 `registerLayoutIpc` 同一套注入约定（那边也是从 deps 里收 `ipcMain`）：**不要**直接用
   * require 进来的全局 ipcMain，原因是它**不进入**「按发送方解析窗口」的上下文
   *（见 window-runtime-registry 的边界说明），而下面两条拖动通道里用的 `tabDropZone` /
   * `tabManager` 都是 scoped 代理 —— 不包一层的话，多窗口下 B 窗口拖标签会把落点提交到
   * **A 窗口**的标签管理器上（表现：拖完没反应，A 窗口反而多出一次分屏）。
   * 宿主（ipc-routes）传进来的是「包了上下文的那一个」。
   * 缺省回落到全局 ipcMain 只是为了让**没有窗口上下文的调用方**（如单测）也能跑通。
   */
  const ipcMainScoped = injectedIpcMain && typeof injectedIpcMain.on === 'function' ? injectedIpcMain : globalIpcMain
  const options = (event: unknown) => ({
    sender: event && typeof event === 'object' && 'sender' in event ? (event as { sender: unknown }).sender : undefined
  })
  // 「新标签页 / 主页」默认地址：未显式指定 url 时走唯一解析函数（app.home_mode + app.home_url）。
  // 扩展的 chrome_url_overrides.newtab **不在这里解析**：无痕窗口同样走这条 IPC，
  // 而只有 TabManager 知道这张标签最终跑在哪个会话（见其 _resolveTabUrl /
  // browser-window-runtime 注入的 onResolveTabUrl 钩子）。这里只给设置口径的基准地址。
  const defaultNewTabUrl = () => resolveHomeUrl(settingsService)
  // 「关闭多个标签前确认」（tabs.confirm_close_multiple）：
  // 与主进程应用菜单（main.js）共用同一份闸门 —— 只在真会关掉一个以上标签时，
  // 用应用内 jsdialog 浮层询问（不是系统原生对话框）。判定逻辑见 tab-close-guard.js。
  const closeGuard = createTabCloseGuard({
    getTabManager: () => tabManager,
    getJsDialogManager,
    settingsService
  })

  typedMain.handle(routes.tabList, { requestSchema: schemas.list.request, responseSchema: schemas.list.response, handler: async (event, req) => invoke('tabs.list', () => tabManager.list(), req, options(event)) })
  typedMain.handle(routes.tabProjection, { requestSchema: schemas.projection.request, responseSchema: schemas.projection.response, handler: async (event, req) => invoke('tabs.projection', () => tabManager.listProjection(), req, options(event)) })
  typedMain.handle(routes.tabStackCreate, { requestSchema: schemas.createStack.request, responseSchema: schemas.createStack.response, handler: async (event, req) => invoke('tabs.stack-create', () => tabManager.createStack(req), req, options(event)) })
  typedMain.handle(routes.tabStackSet, { requestSchema: schemas.setStack.request, responseSchema: schemas.setStack.response, handler: async (event, req) => invoke('tabs.stack-set', () => tabManager.setTabStack(req), req, options(event)) })
  typedMain.handle(routes.tabStackToggle, { requestSchema: schemas.toggleStack.request, responseSchema: schemas.toggleStack.response, handler: async (event, req) => invoke('tabs.stack-toggle', () => tabManager.toggleStack(req.stackId), req, options(event)) })
  typedMain.handle(routes.tabStackRename, { requestSchema: schemas.renameStack.request, responseSchema: schemas.renameStack.response, handler: async (event, req) => invoke('tabs.stack-rename', () => tabManager.renameStack(req), req, options(event)) })
  typedMain.handle(routes.tabStackSetColor, { requestSchema: schemas.setStackColor.request, responseSchema: schemas.setStackColor.response, handler: async (event, req) => invoke('tabs.stack-set-color', () => tabManager.setStackColor(req), req, options(event)) })
  typedMain.handle(routes.tabStackMerge, { requestSchema: schemas.mergeStacks.request, responseSchema: schemas.mergeStacks.response, handler: async (event, req) => invoke('tabs.stack-merge', () => tabManager.mergeStacks(req), req, options(event)) })
  // 解散标签组（成员全部回到散标签、组元数据删掉）。
  // 这里**不再**提供 `tab:stack-split`（domain 的 splitStack＝把部分成员迁到新组）：
  // 它在菜单上被当成"拆分标签组"用，结果只是整组换了个内部 id、外观一字不变 ——
  // 那正是用户反馈的"点了没反应"。规则能力仍在 domain（有单测），但没有 UI 入口就不留 IPC。
  typedMain.handle(routes.tabStackDissolve, { requestSchema: schemas.dissolveStack.request, responseSchema: schemas.dissolveStack.response, handler: async (event, req) => invoke('tabs.stack-dissolve', () => tabManager.dissolveStack(req), req, options(event)) })
  // ── 栈查询与通用 patch ─────────────────────────────────────────────────
  //  · get / of-tab 不存在时返回 null（契约已声明 nullable），调用方据此给"这一组已经没了"；
  //  · list 返回 `{ stacks }` 包裹（与 split-list / glance-list 同款，契约不收裸数组）；
  //  · update 是白名单 patch：一次改多项只触发一次 tab:changed。
  typedMain.handle(routes.tabStackGet, { requestSchema: schemas.stackGet.request, responseSchema: schemas.stackGet.response, handler: async (event, req) => invoke('tabs.stack-get', () => tabManager.getStack(req.stackId), req, options(event)) })
  typedMain.handle(routes.tabStackOfTab, { requestSchema: schemas.stackOfTab.request, responseSchema: schemas.stackOfTab.response, handler: async (event, req) => invoke('tabs.stack-of-tab', () => tabManager.getStackOfTab(req.tabId), req, options(event)) })
  typedMain.handle(routes.tabStackList, { requestSchema: schemas.stackList.request, responseSchema: schemas.stackList.response, handler: async (event) => invoke('tabs.stack-list', () => ({ stacks: tabManager.getAllStacks() }), undefined, options(event)) })
  typedMain.handle(routes.tabStackIsTabInAny, { requestSchema: schemas.stackIsTabInAny.request, responseSchema: schemas.stackIsTabInAny.response, handler: async (event, req) => invoke('tabs.stack-is-tab-in-any', () => ({ tabId: String(req.tabId), inStack: tabManager.isTabInAnyStack(req.tabId) }), req, options(event)) })
  typedMain.handle(routes.tabStackUpdate, { requestSchema: schemas.stackUpdate.request, responseSchema: schemas.stackUpdate.response, handler: async (event, req) => invoke('tabs.stack-update', () => tabManager.updateStack(req), req, options(event)) })
  // ── 分屏（Split View）—— 与栈正交；所有"不合法"返回 null（契约已声明 nullable），
  //    由 UI 给出原因（"至少两个标签" / "最多 N 格"），不出现"点了没反应"。
  typedMain.handle(routes.tabSplitCreate, { requestSchema: schemas.splitCreate.request, responseSchema: schemas.splitCreate.response, handler: async (event, req) => invoke('tabs.split-create', () => tabManager.createSplitGroup(req), req, options(event)) })
  // 与当前活动标签分屏（Alt+点击标签）：另一个格子由主进程解析，渲染层只报被点的那个。
  typedMain.handle(routes.tabSplitWith, { requestSchema: schemas.splitWith.request, responseSchema: schemas.splitWith.response, handler: async (event, req) => invoke('tabs.split-with', () => tabManager.createSplitWithActive(req.tabId), req, options(event)) })
  typedMain.handle(routes.tabSplitDissolve, { requestSchema: schemas.splitDissolve.request, responseSchema: schemas.splitDissolve.response, handler: async (event, req) => invoke('tabs.split-dissolve', () => tabManager.dissolveSplit(req), req, options(event)) })
  typedMain.handle(routes.tabSplitSet, { requestSchema: schemas.splitSet.request, responseSchema: schemas.splitSet.response, handler: async (event, req) => invoke('tabs.split-set', () => tabManager.setTabSplit(req), req, options(event)) })
  typedMain.handle(routes.tabSplitLayout, { requestSchema: schemas.splitLayout.request, responseSchema: schemas.splitLayout.response, handler: async (event, req) => invoke('tabs.split-layout', () => tabManager.setSplitLayout(req), req, options(event)) })
  typedMain.handle(routes.tabSplitActive, { requestSchema: schemas.splitActive.request, responseSchema: schemas.splitActive.response, handler: async (event, req) => invoke('tabs.split-active', () => tabManager.setSplitActive(req), req, options(event)) })
  typedMain.handle(routes.tabSplitReverse, { requestSchema: schemas.splitReverse.request, responseSchema: schemas.splitReverse.response, handler: async (event, req) => invoke('tabs.split-reverse', () => tabManager.reverseSplit(req), req, options(event)) })
  typedMain.handle(routes.tabSplitRatioPreset, { requestSchema: schemas.splitRatioPreset.request, responseSchema: schemas.splitRatioPreset.response, handler: async (event, req) => invoke('tabs.split-ratio-preset', () => tabManager.setSplitRatioPreset(req), req, options(event)) })
  typedMain.handle(routes.tabSplitFocus, { requestSchema: schemas.splitFocus.request, responseSchema: schemas.splitFocus.response, handler: async (event, req) => invoke('tabs.split-focus', () => tabManager.focusSplitPane(req.direction), req, options(event)) })
  typedMain.handle(routes.tabSplitRestore, { requestSchema: schemas.splitRestore.request, responseSchema: schemas.splitRestore.response, handler: async (event, req) => invoke('tabs.split-restore', () => tabManager.restoreLastSplit(), req || {}, options(event)) })
  // ── 速览（Glance，A1）—— 第三条正交维度；同样"不合法返回 null"。
  typedMain.handle(routes.tabGlanceCreate, { requestSchema: schemas.glanceCreate.request, responseSchema: schemas.glanceCreate.response, handler: async (event, req) => invoke('tabs.glance-create', () => tabManager.createGlanceGroup(req), req, options(event)) })
  typedMain.handle(routes.tabGlanceWith, { requestSchema: schemas.glanceWith.request, responseSchema: schemas.glanceWith.response, handler: async (event, req) => invoke('tabs.glance-with', () => tabManager.createGlanceWithActive(req.tabId), req, options(event)) })
  typedMain.handle(routes.tabGlanceDissolve, { requestSchema: schemas.glanceDissolve.request, responseSchema: schemas.glanceDissolve.response, handler: async (event, req) => invoke('tabs.glance-dissolve', () => tabManager.dissolveGlance(req), req, options(event)) })
  typedMain.handle(routes.tabGlanceFront, { requestSchema: schemas.glanceFront.request, responseSchema: schemas.glanceFront.response, handler: async (event, req) => invoke('tabs.glance-front', () => tabManager.setGlanceFront(req), req, options(event)) })
  // 列出全部速览组（右键菜单弹出前问一次，与 splitList 同款）。
  typedMain.handle(routes.tabGlanceList, { requestSchema: schemas.glanceList.request, responseSchema: schemas.glanceList.response, handler: async (event) => invoke('tabs.glance-list', () => ({ glances: tabManager.listGlances() }), undefined, options(event)) })
  // ═══════════════════════════════════════════════════════════════════
  //  「拖到网页区域 = 分屏」——**单向** IPC（renderer → main）
  //
  //  为什么单向：dragend 是"一次性事件"，不需要任何回值；走 send 省掉一次往返与 Promise。
  //  为什么判定在主进程：四个纵向宿主跑在各自独立的渲染进程里（那边没有主窗口外壳 DOM），
  //  只有主进程同时握有"发送者视图的 bounds"与"内容区矩形"。见 TabManager#dropTabOnContent。
  // ═══════════════════════════════════════════════════════════════════
  //  ⚠ 落点**不由渲染层上报**：原生拖拽离开源视口后，dragend 的 clientX/clientY 就不再是
  //  "松手在哪"（是源视口内的最后位置）。主进程自己读 screen.getCursorScreenPoint()，
  //  见 TabManager#dropTabOnContent。渲染层只说"哪个标签 + 拖前在看哪个"。
  //
  //  ⚠ 落点**只认拖动期间采样算出的 zone**（= 当时真的画着落位框）。没有 zone 就**不分屏** ——
  //  这已经不是"兜底"而是**唯一判据**（用户口径："等落位框显示才能开始判定，他们是一起的"）。
  //  于是"松手那一刻再读一次光标"那条老路连同它的 trusted 开关一起删了：它既会用两套时刻的
  //  坐标做决定，也正是"只把标签拖过去松了个手却凭空分屏"的来源（见 TabManager#dropTabOnContent）。
  // ═══════════════════════════════════════════════════════════════════
  //  拖动**开始** → 起 30fps 采样，拖动期间把"这一格会落在哪"推给 dropzone-overlay。
  //  单向通道，无回值：它只是"我现在开始拖了"这一条事实。
  ipcMainScoped.on(sendCh(routes.tabDragDropBegin), (_event, req) => {
    try {
      if (!tabDropZone || typeof tabDropZone.begin !== 'function') return
      tabDropZone.begin({
        tabId: req && req.tabId,
        baseTabId: req && req.baseTabId,
        // 拖动**发起视图**的 webContents id：只有这里知道（`sender` 就是那个渲染进程）。
        // 宿主用它判「展开浮层是不是赶在拖拽前一瞬间才冒出来的」——那一次必须撤回，
        // 否则松手会落在浮层这个另一个视图上（被当成外部拖入 → 复制出一个新标签页）。
        sourceWcId: _event && _event.sender ? _event.sender.id : null
      })
    } catch (err) {
      console.warn('[tabs] drag-drop-begin failed:', errorMessage(err))
    }
  })

  //  拖动**结束但没有落点**（在标签列表里松手 / 判定不出网页区域）→ 归档整场拖动。
  //
  //  为什么收尾必须独立成一条：整场拖动的生命周期**不能挂在 commit 上** ——
  //  `dropTabOnContent` 只在"可能落在网页上"时才由渲染层发，而最常见的拖动（列表内排序 /
  //  成组）根本不发。只靠 commit 收尾的话，主进程的 30fps 采样表、落位框浮层与
  //  「拖动期侧栏唤出保持」会永远留着（用户报的"分屏黏住 / 侧栏悬停不再收起"）。
  //  与 commit 同一条单向约定：调用 `cancel()`（非 silent）→ 收起框并切回被拖的那一格。
  ipcMainScoped.on(sendCh(routes.tabDragDropCancel), () => {
    try {
      if (tabDropZone && typeof tabDropZone.cancel === 'function') tabDropZone.cancel()
    } catch (err) {
      console.warn('[tabs] drag-drop-cancel failed:', errorMessage(err))
    }
  })

  // 落位预览 renderer 已真正应用某一帧。按 previewId 确认当前在途帧；
  // 未确认的帧由控制器低频重推，解决"bounds 已显示但内容是透明空层"。
  ipcMainScoped.on(sendCh(routes.tabDragDropShown), (_event, req) => {
    try {
      if (!tabDropZone || typeof tabDropZone.acknowledge !== 'function') return
      tabDropZone.acknowledge(req && req.previewId)
    } catch (err) {
      console.warn('[tabs] drag-drop-shown failed:', errorMessage(err))
    }
  })

  ipcMainScoped.on(sendCh(routes.tabDragDropContent), (_event, req) => {
    try {
      // 先收尾（停表 + 收浮层），拿到**最后一次意图** —— 它就是用户刚才看到的那一块。
      let intent = null
      try {
        if (tabDropZone && typeof tabDropZone.end === 'function') intent = tabDropZone.end()
      } catch (_) { intent = null }
      const intentRecord = asRecord(intent)
      const requestRecord = asRecord(req)
      const zone = intentRecord.zone || null
      // ⚠ `mode` 必须一起透传：`join`（拖进已有分屏里多占一格）的意图**本来就没有 zone**
      //   （join / blocked 的意义不在"哪一半"，整片内容区给反馈就够 —— 见 tab-drop-zone 的说明）。
      //   只透传 zone 会让 join 在 TabManager 那道"没画框就不分"的闸前被当成"没画框"挡掉，
      //   表现就是**往分屏里拖第 3、第 4 个标签完全没反应**。
      const mode = intentRecord.mode || null
      const res = tabManager.dropTabOnContent({
        tabId: requestRecord.tabId,
        baseTabId: requestRecord.baseTabId,
        // ⚠ **没有意图 = 当时没画落位框 = 不分屏**（用户口径："等落位框显示才能开始判定，
        //   他们是一起的"）。这里**没有**任何"松手时再读一次光标"的降级路径 ——
        //   那正是"只拖过去松了个手却凭空分屏"的来源，见 TabManager#dropTabOnContent。
        zone,
        mode
      })
      const result = asRecord(res)
      // **每次都留一行**：本功能的触发条件（"松手点是否落在网页哪一边"）对用户完全不可见，
      // 而"消息压根没到"与"到了但没命中"必须能区分开 ——
      //   · 拖完什么都没打印  → 渲染层没发出（dragend 没触发 / 端口链断了）；
      //   · 打印了 outside-page → 坐标或矩形不一致，那一行里带着两个矩形可直接比对。
      const tag = requestRecord.tabId || '?'
      // join 没有 zone，但仍要在日志里看得见 —— 否则"join 到了没命中"和"压根没意图"分不开。
      const where = zone ? `@${zone}` : (mode ? `(${mode})` : '')
      if (result.ok) console.log(`[split] 拖到网页区域${where} → ${result.reason === 'joined' ? '已加入分屏' : '已建分屏'} (${tag})`)
      else console.log(`[split] 拖到网页区域${where}未命中 (${tag}): ${result.reason || 'null'}`
        + (result.at ? ` at=${result.at} page=${JSON.stringify(result.page)}` : ''))
    } catch (err) {
      console.warn('[tabs] drop-on-content failed:', errorMessage(err))
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  //  分屏工具条（hover 在分屏上浮出的那排小按钮）——**单向** IPC（renderer → main）
  //
  //  工具条浮层住在独立渲染进程里，它只发"用户干了什么"（点哪个按钮 / 开始拖 / 松手到第几格），
  //  **几何与判定全在主进程**（见 main/split-toolbar.js：它按屏幕光标算指针在哪一格，
  //  因为指针一进网页原生视图，浮层就收不到自己盖住那片区域的指针事件）。
  //  单向无回值：点击与拖动都是高频一次性消息，失败由下一次覆盖。
  //
  //  ⚠ 与拖动落点预览（上面两条）同一约定：命令来自「浮层所在的窗口」，
  //  必须落到同窗口的控制器上（scoped 代理），否则多窗口下会串台。
  // ═══════════════════════════════════════════════════════════════════
  ipcMainScoped.on(sendCh(routes.splitToolbarCommand), (_event, req) => {
    try {
      if (!splitToolbar || typeof splitToolbar.command !== 'function') return
      const res = splitToolbar.command(req || {})
      const result = asRecord(res)
      const request = asRecord(req)
      // **失败留一行**：本功能的触发条件（"指针在哪一格 / 拖到第几格"）对用户不可见，
      // 而"命令压根没到"与"到了但被拒"必须能区分开（对齐拖动落点那条日志的口径）。
      if (result.ok === false) {
        console.log(`[split] 工具条命令未生效 (${request.type || '?'}/${request.action || '-'}): ${result.reason || 'null'}`)
      }
    } catch (err) {
      console.warn('[tabs] split-toolbar command failed:', errorMessage(err))
    }
  })

  typedMain.handle(routes.tabSplitList, { requestSchema: schemas.splitList.request, responseSchema: schemas.splitList.response, handler: async (event, req) => invoke('tabs.split-list', () => ({
    splits: tabManager.listSplits(),
    // 菜单项可见性用：与 restoreLastSplit 同一判据（"栈非空"≠"真能复原"，
    // 里面的成员可能已被关闭）。判定收在 TabManager 一处，避免两处各判一遍。
    canRestoreSplit: tabManager.canRestoreSplit()
  }), req || {}, options(event)) })
  typedMain.handle(routes.tabNew, {
    requestSchema: schemas.new.request, responseSchema: schemas.new.response,
    handler: async (event, req) => {
      const opts: Record<string, unknown> = { ...(req || {}) }
      // 未指定 url 时用「新标签页」设置；空字符串视作未指定
      if (!opts.url || opts.url === 'about:blank') opts.url = defaultNewTabUrl()
      // 新标签位置：遵守「新标签紧跟当前标签」设置（默认紧跟）
      if (opts.openAfterCurrent === undefined) {
        try { opts.openAfterCurrent = settingsService ? settingsService.get(TABS_SETTING_KEYS.openAfterCurrent) !== false : true } catch (_) {}
      }
      // 「去重跳转」：目标网址已在**当前空间**打开 → 切过去，不再新建（设置可关，默认开）。
      // 只对 http(s) 生效 —— 新标签页 / about: / hira:// 本就该各开各的。
      // 判定与落库都在这一处：infra 的 findTabByUrl 只查询，策略（读设置）留在 APPS。
      // ⚠ 容器标签（N10）**不参与去重跳转**：要求的正是"用另一个身份再开一份"，
      // 复用当前身份那个标签等于把"两个账号同时在线"这件事直接抹掉。
      // ⚠ 后台新标签（Ctrl+中键/Ctrl+点击）同理不参与：那一次点击要的是"在后台多开一个"，
      // 复用会切走当前页，等于把"不打扰当前阅读"的语义反过来了。
      if (!opts.containerProfileId && !opts.openInBackground && typeof opts.url === 'string' && isHttpUrl(opts.url)) {
        let reuse = true
        try { reuse = !settingsService || settingsService.get(TABS_SETTING_KEYS.reuseExistingTab) !== false } catch (_) {}
        if (reuse) {
          const found = asRecord(tabManager.findTabByUrl(opts.url))
          if (found.tabId) {
            tabManager.switchTo(found.tabId)
            return { tabId: found.tabId, url: found.url }
          }
        }
      }
      return invoke('tabs.create', () => tabManager.newTab(opts), opts, options(event))
    }
  })

  if (tabManager.newIncognitoTab) typedMain.handle(routes.tabNewIncognito, { requestSchema: schemas.newIncognito.request, responseSchema: schemas.newIncognito.response, handler: async (event, req) => invoke('tabs.create-incognito', () => tabManager.newIncognitoTab(req || {}), req || {}, options(event)) })

  typedMain.handle(routes.tabSwitch, { requestSchema: schemas.switch.request, responseSchema: schemas.switch.response, handler: async (event, req) => invoke('tabs.activate', () => tabManager.switchTo(req.tabId), req, options(event)) })
  // 关闭最后一个标签时替换成什么地址，由 tabManager 构造期注入的 getNewTabUrl 端口
  // 统一解析（走「主页 / 新标签页」唯一解析）。这里**刻意不逐次传参** —— 关闭入口
  // 还有 Ctrl+W / 菜单 / 扩展，逐次传参漏一条就会退化成 about:blank。
  typedMain.handle(routes.tabClose, { requestSchema: schemas.close.request, responseSchema: schemas.close.response, handler: async (event, req) => invoke('tabs.close', () => tabManager.close(req.tabId), req, options(event)) })
  typedMain.handle(routes.tabCloseOthers, { requestSchema: schemas.closeOthers.request, responseSchema: schemas.closeOthers.response, handler: async (event, req) => {
    // 用户取消 → 一条都没关。必须回契约声明的 `{ closed: number }`
    //（`tabs.closeOthers.response`），不能造一个 `{ ok: false }` 让响应校验失败。
    if (await closeGuard.shouldCancel('others', req.tabId)) return { closed: 0 }
    return invoke('tabs.close-others', () => tabManager.closeOthers(req.tabId), req, options(event))
  } })
  typedMain.handle(routes.tabCloseRight, { requestSchema: schemas.closeRight.request, responseSchema: schemas.closeRight.response, handler: async (event, req) => {
    if (await closeGuard.shouldCancel('right', req.tabId)) return { closed: 0 }
    return invoke('tabs.close-right', () => tabManager.closeRight(req.tabId), req, options(event))
  } })
  typedMain.handle(routes.tabReorder, { requestSchema: schemas.reorder.request, responseSchema: schemas.reorder.response, handler: async (event, req) => invoke('tabs.reorder', () => tabManager.reorder(req), req, options(event)) })
  typedMain.handle(routes.tabTogglePin, { requestSchema: schemas.togglePin.request, responseSchema: schemas.togglePin.response, handler: async (event, req) => invoke('tabs.toggle-pin', () => tabManager.togglePin(req.tabId), req, options(event)) })
  // 放进固定文件夹 = **pin 动作**（普通标签 → 固定文件夹是跨种类，不能借 stack-set，
  // 那条只搬运同种类标签）。见 infra-window#tabLayout.addTabToPinnedGroup。
  typedMain.handle(routes.tabPinnedGroupAdd, { requestSchema: schemas.pinnedGroupAdd.request, responseSchema: schemas.pinnedGroupAdd.response, handler: async (event, req) => invoke('tabs.pinned-group-add', () => tabManager.addTabToPinnedGroup(req), req, options(event)) })
  typedMain.handle(routes.tabToggleMute, { requestSchema: schemas.toggleMute.request, responseSchema: schemas.toggleMute.response, handler: async (event, req) => invoke('tabs.toggle-mute', () => tabManager.toggleMute(req.tabId), req, options(event)) })
  // 周期性自动刷新（C7）：0 = 关闭。计时器住在 TabManager（随标签关闭一起停）。
  typedMain.handle(routes.tabAutoRefresh, { requestSchema: schemas.autoRefresh.request, responseSchema: schemas.autoRefresh.response, handler: async (event, req) => invoke('tabs.auto-refresh', () => tabManager.setAutoRefresh(req.tabId, req.intervalMs), req, options(event)) })
  typedMain.handle(routes.tabDuplicate, { requestSchema: schemas.duplicate.request, responseSchema: schemas.duplicate.response, handler: async (event, req) => invoke('tabs.duplicate', () => tabManager.duplicate(req.tabId), req, options(event)) })
  typedMain.handle(routes.tabUndoClose, { requestSchema: schemas.undoClose.request, responseSchema: schemas.undoClose.response, handler: async (event, req) => invoke('tabs.undo-close', () => tabManager.undoClose(), req, options(event)) })
  // 已关闭标签页列表：契约要求 handler 返回 `{ tabs }` 包裹结构（不是裸数组）。
  // 注意 provider 命中时 invoke 会直接返回插件能力的结果（数组），故这里对 invoke
  // 的返回值统一包裹 —— 无论走 provider 还是 fallback，出口都严格是 `{ tabs }`。
  typedMain.handle(routes.tabRecentlyClosed, { requestSchema: schemas.recentlyClosed.request, responseSchema: schemas.recentlyClosed.response, handler: async (event, req) => {
    const tabs = await invoke('tabs.recently-closed', () => tabManager.listRecentlyClosed(), req, options(event))
    return { tabs: Array.isArray(tabs) ? tabs : [] }
  } })
  typedMain.handle(routes.tabRecentlyClosedClear, { requestSchema: schemas.recentlyClosedClear.request, responseSchema: schemas.recentlyClosedClear.response, handler: async (event, req) => invoke('tabs.recently-closed:clear', () => tabManager.clearRecentlyClosed(), req, options(event)) })
  // 恢复「最近关闭」列表里的指定一项（历史页 / 应用菜单）。index 口径 = 列表顺序；
  // provider 与 fallback 的返回值可能不同（null / undefined / 对象），出口统一成
  // `{ ok, tabId?, url? }`，UI 只需认这一个契约。
  typedMain.handle(routes.tabRecentlyClosedRestore, { requestSchema: schemas.recentlyClosedRestore.request, responseSchema: schemas.recentlyClosedRestore.response, handler: async (event, req) => {
    const restored = asRecord(await invoke('tabs.recently-closed:restore', () => tabManager.undoCloseAt(req.index), req, options(event)))
    return restored.tabId
      ? { ok: true, tabId: String(restored.tabId), url: String(restored.url || '') }
      : { ok: false }
  } })

  if (tabManager.stats) typedMain.handle(routes.tabStats, { requestSchema: schemas.stats.request, responseSchema: schemas.stats.response, handler: async (event, req) => invoke('tabs.stats', () => tabManager.stats(), req, options(event)) })
  if (tabManager.visibleAfter) typedMain.handle(routes.tabVisibleAfter, { requestSchema: schemas.visibleAfter.request, responseSchema: schemas.visibleAfter.response, handler: async (event, req) => invoke('tabs.visible-after', () => tabManager.visibleAfter(req.tabId), req, options(event)) })

  if (tabManager.sleepTab) {
    typedMain.handle(routes.tabSleep, { requestSchema: schemas.sleep.request, responseSchema: schemas.sleep.response, handler: async (event, req) => invoke('tabs.sleep', () => tabManager.sleepTab(req.tabId), req, options(event)) })
  }
  // 归档单个标签（J9）：关闭 + 由 TabManager 的 onTabArchived 钩子记入「归档区」。
  typedMain.handle(routes.tabArchive, { requestSchema: schemas.archive.request, responseSchema: schemas.archive.response, handler: async (event, req) => invoke('tabs.archive', () => tabManager.archiveTab(req.tabId, { explicit: true }), req, options(event)) })

  typedMain.handle(routes.omniboxAction, { requestSchema: schemas.omniboxAction.request, responseSchema: schemas.omniboxAction.response, handler: async (event, req) => invoke('tabs.omnibox-action', () => tabManager.omniboxAction(req.action), req, options(event)) })
  typedMain.handle(routes.navGo, { requestSchema: schemas.navGo.request, responseSchema: schemas.navGo.response, handler: async (event, req) => invoke('tabs.navigate', () => tabManager.navigate(req), req, options(event)) })
  typedMain.handle(routes.navBack, { requestSchema: schemas.navBack.request, responseSchema: schemas.navBack.response, handler: async (event, req) => invoke('tabs.back', () => tabManager.goBack(req?.tabId), req || {}, options(event)) })
  typedMain.handle(routes.navForward, { requestSchema: schemas.navForward.request, responseSchema: schemas.navForward.response, handler: async (event, req) => invoke('tabs.forward', () => tabManager.goForward(req?.tabId), req || {}, options(event)) })
  typedMain.handle(routes.navEntries, { requestSchema: schemas.navEntries.request, responseSchema: schemas.navEntries.response, handler: async (event, req) => invoke('tabs.nav-entries', () => tabManager.getNavigationEntries(req?.tabId), req || {}, options(event)) })
  typedMain.handle(routes.navGoToEntry, { requestSchema: schemas.navGoToEntry.request, responseSchema: schemas.navGoToEntry.response, handler: async (event, req) => invoke('tabs.nav-go-to-entry', () => tabManager.goToIndex(req?.tabId, req.index), req || {}, options(event)) })
  typedMain.handle(routes.navReload, { requestSchema: schemas.navReload.request, responseSchema: schemas.navReload.response, handler: async (event, req) => invoke('tabs.reload', () => tabManager.reload(req?.tabId), req || {}, options(event)) })
  typedMain.handle(routes.navStop, { requestSchema: schemas.navStop.request, responseSchema: schemas.navStop.response, handler: async (event, req) => invoke('tabs.stop', () => tabManager.stop(req?.tabId), req || {}, options(event)) })
}

