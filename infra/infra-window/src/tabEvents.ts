import { showWebContentMenu, closeWebContentMenu, type ContextMenuSnapshot } from './context-menu'
import { onWebContentsDestroyed } from './webContentsLifecycle'
import { isNonWebUrl } from './url-schemes'
import { resolvePdfTarget } from './tabUrl'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  ContextMenuParams,
  Event as ElectronEvent,
  WebContents,
  WebContentsView,
  WindowOpenHandlerResponse
} from 'electron'
// 「站点键」的唯一判据在 shared-types（注入规则 host 归一、按域名分组标签同一份），
// TabManager 的「关闭最后一个标签补位」也用同一条判据（见该处注释）。
const { siteKeyOf } = require('@hira-ng/shared-types/src/url-protocols')
// 错误页地址的唯一构造点（标签页与独立侧栏共用同一份，见该文件说明）。
const { webErrorUrl, isWebErrorUrl } = require('@hira-ng/shared-types/src/web-error')
// 搜索兜底：模板 / 文案的唯一真源（宿主没注入 onGetSearchUrl 时用它，不写 bing 字面量）。
import { defaultSearchUrl, defaultSearchLabel } from '@hira-ng/shared-types/src/search-engines'

interface TabEventRecord {
  tabId: string
  url: string
  title?: string
  favicon?: string
  incognito?: boolean
  loading?: boolean
  audioPlaying?: boolean
  navHistory?: unknown[]
  navHistoryIndex?: number
  error?: { code?: number; description?: string; url?: string } | null
  _errorPageSwitched?: boolean
  [key: string]: unknown
}
interface TabEventHooks {
  onWindowOpenRequest?(payload: { tabId: string; webContents: WebContents; url: string; disposition: string }): boolean
  shouldSuppressContextMenu?(webContents: WebContents): boolean
  onContextMenu?(payload: { tabId: string; webContents: WebContents; params: ContextMenuParams }): void
  onOpenInNewWindow?(url: string): void
  onCapturePage?(payload: { tabId: string; webContents: WebContents; mode: string }): void
  onTranslatePage?(payload: { tabId: string; webContents: WebContents; url: string }): void
  onPeekPreview?(payload: { tabId: string; webContents: WebContents; url: string }): void
  onViewSource?(url: string): unknown
  onGetSearchUrl?(text: string): string
  onGetSearchLabel?(text: string): string
  getMenuAccelerator?(command: string): string
  getExtensionMenuItems?(webContents: WebContents, params: ContextMenuSnapshot): unknown
  getHostMenuItems?(webContents: WebContents, params: ContextMenuSnapshot): unknown
  onDidNavigate?(payload: { tabId: string; url: string }): void
  onNavigationCommitted?(payload: Record<string, unknown>): void
  onTargetUrl?(payload: { tabId: string; url: string }): void
  onWillNavigate?(payload: { tabId: string; url: string; redirect: boolean }): { cancel?: boolean; url?: string } | null | undefined
  onPageReady?(payload: Record<string, unknown>): void
  onDidFinishLoad?(payload: { tabId: string; url: string }): void
  onFaviconFallback?(payload: { tabId: string; url: string; profileId?: string }): string
}
export interface TabEventsHost {
  _tabs: Map<string, TabEventRecord>
  _wcm: { createTab(id: string): WebContentsView }
  _layout: {
    getWindow?(): BrowserWindow | undefined
    getActiveSplit?(): { id?: string; members?: string[] } | null
    getActiveGlance?(): { id?: string; members?: string[] } | null
    setTabFullscreen?(fullscreen: boolean): boolean
  }
  _hooks: TabEventHooks
  _wcToTabId: Map<WebContents, string>
  _boundTabIds: Set<string>
  _boundWebContents?: WeakSet<WebContents>
  _isCurrentWc(tabId: string, webContents: WebContents): boolean
  _scheduleEmitChanged(options?: { layout?: boolean }): void
  _createTabSync(options: { url?: string; openInBackground?: boolean; webContents?: WebContents | null; openerTabId?: string }): { view: WebContentsView }
  _emit(event: string, payload: unknown): void
  _onFaviconUpdated?(url: string, favicon: string): void
  _onTitleUpdated?(payload: { tabId: string; url: string; title: string }): void
  _shouldUsePdfViewer?(url: string): boolean
  getActiveTabId(): string | null
  switchTo(tabId: string): void
  emit(event: string, payload: unknown): void
  newTab(options: { url?: string; openInBackground?: boolean }): Promise<unknown>
  reload(tabId: string): void
  routeSplitLink?(options: { openerTabId: string; url: string }): boolean
  syncTabCanvas?(tabId: string, url?: string): void
}

/**
 * webContents → 关注它的 TabManager 集合。
 *
 * 为什么需要：同一个 webContents 会被**多个**宿主绑定 —— 新建时是它的窗口，
 * 跨窗口迁移（detach/adopt）后是目标窗口，休眠唤醒会再绑一次，而旧宿主的监听
 * 仍在（它们靠 `_isCurrentWc` 守卫自动失效，不做逐个解绑）。
 * 如果每次都 `wc.on('destroyed', ...)`，一个被搬过几次的标签就会在同一个
 * WebContents 上堆出十个以上的 destroyed 监听 → Node 打出 MaxListenersExceededWarning，
 * 长会话下监听器无界增长。
 *
 * 因此改为**每个 webContents 只挂一个** destroyed 清理器，它负责把映射从所有
 * 关心过它的宿主里摘掉 —— 监听器数量与「迁移/唤醒次数」彻底解耦。
 */
const ownersByWc = new WeakMap()
const htmlFullscreenExits = new WeakMap<WebContents, () => void>()

export function exitWebContentsHtmlFullscreen(webContents: WebContents | null | undefined): boolean {
  if (!webContents || webContents.isDestroyed()) return false
  const exit = htmlFullscreenExits.get(webContents)
  if (!exit) return false
  exit()
  try {
    void webContents.executeJavaScript(
      'document.fullscreenElement && document.exitFullscreen().catch(() => {})'
    ).catch(() => {})
  } catch {}
  return true
}

/**
 * 把「webContents 事件 → 标签状态 / 领域回调」的全部接线从 TabManager 抽离。
 *
 * 这是标签生命周期里最庞大、最独立的一块：它只依赖宿主暴露的一组窄接口
 * （见下方 host 契约），不认识标签集合的增删/排序/持久化。
 * 抽离后 TabManager 不再因"新增一个 webContents 事件"而膨胀。
 *
 * host 契约：
 *   _wcm, _tabs, _layout, _hooks, _wcToTabId, _boundTabIds
 *   _emit(event, payload)
 *   _scheduleEmitChanged(opts?)   // `{ layout: false }` = 纯展示位变更
 *   _isCurrentWc(tabId, wc)
 *   _createTabSync({ url, openInBackground })
 *   _onFaviconUpdated(url, favicon)   (可空)
 *   _onTitleUpdated({ tabId, url, title })  (可空)
 *   _hooks.onNavigationCommitted({ tabId, url, title, favicon, inPage, incognito })  (可空)
 *     主框架导航已提交（跨文档 did-navigate / 同文档 did-navigate-in-page）。
 *     **只是事实**：infra 不知道历史，写不写库、何时写由 apps 决定。
 *   _hooks.onPageReady({ tabId, url, title, favicon, incognito })  (可空)
 *     页面加载完成（did-finish-load）：此刻标题已就绪，是记录历史的时机。
 *   _hooks.onFaviconFallback({ tabId, url }) → string  (可空)
 *     页面**没有**声明 favicon 时的展示兜底（扩展页 → 扩展自己的图标）。
 *     返回 `<img src>` 可直接使用的地址；空串 = 没有兜底（保持标题首字）。
 *
 * @param {object} host
 * @param {string} tabId
 */
export function bindTabEvents(host: TabEventsHost, tabId: string): void {
  const id = String(tabId)
  if (host._boundTabIds.has(id)) return
  const view = host._wcm.createTab(id)
  // 视图可能是新建的、休眠唤醒的、或刚从别的窗口迁入的 —— 画布色一律按
  // 「本标签当前地址」在这里统一补一次（判据见 TabManager#syncTabCanvas）。
  if (typeof host.syncTabCanvas === 'function') host.syncTabCanvas(id)
  const wc = view.webContents
  exitWebContentsHtmlFullscreen(wc)

  // 同一个 (宿主, webContents) 只绑一次。
  // 为什么需要：标签可能被搬到别的窗口**又搬回来**，此时本宿主的 `_boundTabIds`
  // 已被 detachTab 清掉、流程会重新走到这里；若不加这道闸，旧监听仍挂在这个 wc 上
  // 且 `_isCurrentWc` 又变回 true —— 两套监听同时生效（did-navigate 记两遍历史）。
  if (!host._boundWebContents) host._boundWebContents = new WeakSet()
  if (host._boundWebContents.has(wc)) {
    host._wcToTabId.set(wc, id)
    host._boundTabIds.add(id)
    return
  }
  host._boundWebContents.add(wc)

  // 注册 webContents → tabId 映射（O(1) 查找），并把本宿主登记进「关心这个 wc 的人」
  // 集合 —— 销毁清理只挂一次，见 ownersByWc 说明。
  host._wcToTabId.set(wc, id)
  let owners = ownersByWc.get(wc)
  if (!owners) {
    owners = new Set()
    ownersByWc.set(wc, owners)
    onWebContentsDestroyed(wc, () => {
      const set = ownersByWc.get(wc)
      if (!set) return
      for (const owner of set) {
        try {
          // 映射先读后删：_boundTabIds 按 tabId 记账，wc 销毁时一并清掉
          // （主路径都会清，这里是防御性兜底 —— 漏清会让重绑闸误以为还在绑定期）。
          const tabId = owner._wcToTabId.get(wc)
          owner._wcToTabId.delete(wc)
          if (tabId != null) owner._boundTabIds.delete(tabId)
          // _boundWebContents 是 WeakSet：wc 被回收后条目自动消失，无需手动清。
        } catch (_) {}
      }
      ownersByWc.delete(wc)
    })
  }
  owners.add(host)

  // ── 点进某一格的网页 → 那一格成为活动格（Edge 同款）────────────────────────
  // 用户在分屏里点哪一边的网页，那一边就该"亮起来"：淡蓝框移过去、标签条也切到那一条。
  // 三条判据全中才动：**当前确实在分屏** + **它是这个可见组的成员** +
  // **它当前不是活动标签**。少了这道闸，任何一次 webContents 拿到焦点
  //（窗口重新激活、页面自己调 focus()）都会切标签。
  // 速览（A1）同款：点背景卡 → 它被提到最上面成为新的前台大卡（见 TabManager#_syncActiveSplit）。
  wc.on('focus', () => {
    try {
      const activeId = host.getActiveTabId()
      if (!activeId || String(activeId) === String(id)) return
      const layout = host._layout
      const split = layout && typeof layout.getActiveSplit === 'function' ? layout.getActiveSplit() : null
      const glance = layout && typeof layout.getActiveGlance === 'function' ? layout.getActiveGlance() : null
      const inSplit = !!split && Array.isArray(split.members) && split.members.map(String).includes(String(id))
      const inGlance = !!glance && Array.isArray(glance.members) && glance.members.map(String).includes(String(id))
      if (!inSplit && !inGlance) return
      // 走 switchTo（而不是 showTab）：它是"用户切标签"的完整语义 ——
      // 收起旧标签、唤醒休眠、通知 PiP、focus 路由、merge 活动态、发变更通知，一样不少。
      if (typeof host.switchTo === 'function') host.switchTo(String(id))
    } catch (_) {}
  })

  // ── setWindowOpenHandler ─────────────────────────────
  // target="_blank" / window.open() → 内部新标签，不打开新 Electron 窗口。
  // 严格对齐 RT tabs-controller/tab.ts#setupWindowOpenHandler：
  //   - 建标签**推迟到 createWindow(constructorOptions)**，而不是在点击回调里同步建；
  //   - foreground-tab / new-window 时 Electron 会**预建好** webContents 并放进
  //     constructorOptions.webContents，直接复用它——绝不再同步 `new WebContentsView`
  //     （那会同步拉起渲染进程、阻塞主进程 →「点新标签链接卡一会儿」）。
  wc.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const url = String(details.url || 'about:blank')
    const disposition = details.disposition || 'foreground-tab'

    // ── 站点守卫（弹窗策略）──────────────────────────────────────────
    // 「一次弹多个窗口」是**站点行为**，判定与询问在 APPS 层统一实现
    // （main/site-guard.js：权限表三态 + 突发计数），infra 只问一句"这次放不放"。
    // 必须**同步**：setWindowOpenHandler 的返回值只在当前这一拍有效，任何 await
    // 都等于放行（用户会看到"点了仍然弹出来"）。
    if (typeof host._hooks.onWindowOpenRequest === 'function') {
      let allowed = true
      try {
        allowed = host._hooks.onWindowOpenRequest({ tabId: id, webContents: wc, url, disposition })
      } catch (error: unknown) {
        // 守卫自身出错绝不能变成"弹窗全被拦"—— 放行并留一条日志。
        console.warn('[tab] onWindowOpenRequest hook failed (window opens):', error instanceof Error ? error.message : error)
      }
      if (allowed === false) return { action: 'deny' }
    }

    switch (disposition) {
      case 'foreground-tab':
      case 'background-tab':
      case 'new-window': {
        const openInBackground = disposition === 'background-tab'

        // ── 分屏格间链接路由（I5）────────────────────────────────────────
        // 开关打开、且发起标签在分屏里时：把**前台**新窗口请求送进同一组的下一格，
        // 而不是新开标签（对齐 Edge / Zen 的 "Open links in the other pane"）。
        //
        // 必须在这里 `deny`：一旦落进下面的 allow 分支，Electron 会真的建出新标签 ——
        // 结果是"下一格导航了，同时还多出一个标签"。
        // 后台标签请求（background-tab）不参与：它本就不该抢占任何一格。
        if (
          !openInBackground &&
          typeof host.routeSplitLink === 'function' &&
          host.routeSplitLink({ openerTabId: id, url })
        ) {
          return { action: 'deny' }
        }

        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: (constructorOptions: BrowserWindowConstructorOptions) => {
            const viewOptions = constructorOptions || {}
            const injectedWc = (viewOptions as BrowserWindowConstructorOptions & { webContents?: WebContents | null }).webContents || null
            // 有预建 webContents → Electron 会自己接管导航；无预建 → 需手动 loadURL。
            const needsManualLoad = !injectedWc

            const { view: newView } = host._createTabSync({
              url,
              openInBackground,
              webContents: injectedWc,
              // 真实 opener = 点出这个新页面的那个标签。新标签据此继承它的标签组
              //（用户主动新建标签永远不会走到这里，因此不会「新建进组里」）。
              openerTabId: id
            })

            if (needsManualLoad) {
              newView.webContents.loadURL(url).catch((e) => {
                if (e && e.code !== 'ERR_ABORTED' && !String(e.message).includes('ERR_ABORTED')) {
                  console.error('[tab] window.open loadURL failed:', e.message)
                }
              })
            }

            return newView.webContents
          }
        }
      }
      default:
        return { action: 'allow' }
    }
  })

  let htmlFullscreen = false
  const setHtmlFullscreen = (active: boolean): void => {
    const next = Boolean(active)
    if (next === htmlFullscreen) return
    htmlFullscreen = next
    if (!next) htmlFullscreenExits.delete(wc)
    const win = typeof host._layout.getWindow === 'function' ? host._layout.getWindow() : null
    if (win && !win.isDestroyed()) {
      try { win.setFullScreen(next) } catch {}
    }
    try { host._layout.setTabFullscreen?.(next) } catch {}
    host._scheduleEmitChanged({ layout: true })
  }

  wc.on('enter-html-full-screen', () => {
    if (!host._isCurrentWc(id, wc)) return
    htmlFullscreenExits.set(wc, () => setHtmlFullscreen(false))
    setHtmlFullscreen(true)
  })
  wc.on('leave-html-full-screen', () => {
    if (!host._isCurrentWc(id, wc)) return
    setHtmlFullscreen(false)
  })
  onWebContentsDestroyed(wc, () => {
    htmlFullscreenExits.delete(wc)
    if (host._isCurrentWc(id, wc) && htmlFullscreen) setHtmlFullscreen(false)
  })

  // ── 网页右键菜单 — 直接弹出原生 Electron Menu ──
  wc.on('context-menu', (_e, params) => {
    if (!host._isCurrentWc(id, wc)) return
    // 鼠标手势（D3）：**刚画完手势**的那一次松手不该再弹右键菜单。
    // infra 不认识"手势"，只问宿主"这一次要不要吞"（判定与时间窗在 main/automation.js）。
    if (typeof host._hooks.shouldSuppressContextMenu === 'function') {
      try { if (host._hooks.shouldSuppressContextMenu(wc)) return } catch (_) {}
    }
    if (typeof host._hooks.onContextMenu === 'function') {
      host._hooks.onContextMenu({ tabId: id, webContents: wc, params })
      return
    }
    showWebContentMenu(wc, params, {
      ownerWindow: host._layout.getWindow && host._layout.getWindow(),
      onOpenLink: (url, disposition) => {
        if (disposition === 'new-window' && host._hooks.onOpenInNewWindow) {
          host._hooks.onOpenInNewWindow(url)
          return
        }
        host.newTab({ url, openInBackground: disposition === 'background-tab' }).catch(() => {})
      },
      // 刷新走标签自己的 reload：它认识休眠、`t.error` 与导航链（错误页 → 重试原网址）。
      onReload: () => { try { host.reload(id) } catch (_) {} },
      onSaveLinkAs: (url) => url && wc.downloadURL(url),
      onSaveImageAs: (url) => url && wc.downloadURL(url),
      onInspectElement: (x, y) => wc.inspectElement(x, y),
      // 截图（J7）：infra 只报"哪种模式"，由这里补齐 tabId 与 wc 再交给宿主
      //（取图与写剪贴板都在宿主 —— infra 不该认识它们）。
      // ⚠ 与 context-menu 的约定是**位置参数 mode 字符串**；改动一侧必须同时改另一侧。
      onCapturePage: (mode) => {
        if (typeof host._hooks.onCapturePage === 'function') {
          host._hooks.onCapturePage({ tabId: id, webContents: wc, mode })
        }
      },
      // 翻译此页（C3）：与截图同一条薄转发 —— infra 只报"翻译这一页"，语言/引擎都在宿主。
      // ⚠ 与 context-menu 的约定同样是**位置参数**（这里收的是 pageURL，可空）。
      onTranslatePage: (pageUrl) => {
        if (typeof host._hooks.onTranslatePage === 'function') {
          host._hooks.onTranslatePage({ tabId: id, webContents: wc, url: pageUrl })
        }
      },
      // 小窗预览（N1）：小窗是宿主侧的应用级单例（见 main/peek.js）。
      onPeekPreview: (url) => {
        if (typeof host._hooks.onPeekPreview === 'function') {
          host._hooks.onPeekPreview({ tabId: id, webContents: wc, url })
        }
      },
      onViewSource: (url) => host._hooks.onViewSource
        ? host._hooks.onViewSource(url)
        : host.newTab({ url: `view-source:${url}` }).catch(() => {}),
      onSearchSelection: (text) => {
        const keyword = String(text || '')
        const url = host._hooks.onGetSearchUrl
          ? host._hooks.onGetSearchUrl(keyword)
          : defaultSearchUrl(keyword)
        if (url) host.newTab({ url }).catch(() => {})
      },
      searchLabel: (text) => host._hooks.onGetSearchLabel
        ? host._hooks.onGetSearchLabel(text)
        : defaultSearchLabel(text),
      // 快捷键提示：宿主按**当前键位**解析（见 shared-types#keybindings.mjs#menuAccelerator）。
      // infra 不写组合键字面量 —— 用户改键后菜单必须立刻跟随。
      accelerator: (command) => (typeof host._hooks.getMenuAccelerator === 'function'
        ? host._hooks.getMenuAccelerator(command)
        : ''),
      getExtensionMenuItems: (contents, contextParams) => host._hooks.getExtensionMenuItems
        ? host._hooks.getExtensionMenuItems(contents, contextParams)
        : [],
      /**
       * **宿主自带的菜单项**（数据，不是逻辑）：apps 侧返回若干 `{ label, click }`。
       *
       * 为什么要这个口子：页面右键菜单里有些项属于**宿主能力**（例如"把这个网页放到侧栏"），
       * 而它们不是扩展贡献的、也不该让 infra 认识它们的业务含义 —— 于是 infra 只负责
       * "把它们塞进原生菜单"，文案与点击行为全部由宿主给（与扩展项同一条口径）。
       */
      getHostMenuItems: (contents, contextParams) => host._hooks.getHostMenuItems
        ? host._hooks.getHostMenuItems(contents, contextParams)
        : []
    })
  })
  onWebContentsDestroyed(wc, () => closeWebContentMenu(wc))

  // ── AudioManager — 媒体播放指示器 ──
  //
  // ⚠ 语义边界（这一位同时是**休眠豁免**的判据，见 TabRules#sleepCandidates）：
  //   `audioPlaying` 表示「这个标签是**媒体型标签**」—— 页面里有音视频在播，
  //   **包括静音播放**。因此后台音乐 / 视频不会被休眠回收掐断
  //   （对齐 legacy Hira 的 `tab.hasAudio`）。判据只来自媒体事件本身，
  //   不额外读 `isCurrentlyAudible()`：静音播放的媒体依然是媒体，
  //   用户切回来时不该看到整页重载。
  // 热路径顺序有意如此：媒体事件是**全事件里最吵的一类**（信息流 / 广告站点一次
  // 滚动就能刷出几十个 media-paused），所以先做最便宜的两步 —— Map 取记录 + 位比较，
  // 绝大多数事件在**没有状态变化**时直接在这里返回，不碰 `_isCurrentWc`（要过
  // `_wcm.getTab` 再比 webContents）。代际校验仍然保留：它会拦住休眠/销毁后旧 view
  // 的迟到事件，只是排到"确实要写这一位"之后。
  const setAudioPlaying = (playing: boolean): void => {
    const t = host._tabs.get(id)
    if (!t || t.audioPlaying === playing) return
    if (!host._isCurrentWc(id, wc)) return
    t.audioPlaying = playing
    // 纯展示位变更：标签集合与顺序都没动，用 `layout: false` 让这次出口跳过
    // 两次布局不变式全表扫描（见 TabManager#_scheduleEmitChanged）。
    host._scheduleEmitChanged({ layout: false })
  }

  wc.on('media-started-playing', () => setAudioPlaying(true))
  wc.on('media-paused', () => setAudioPlaying(false))

  // ── URL 同步 ──
  wc.on('did-navigate', (_e, url) => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    // 跨文档导航已提交 = 旧文档连同它的媒体一起销毁，这一位必须清零。
    // 它是**休眠豁免**的判据（TabRules#sleepCandidates）：残留 true 会让标签
    // 永久免疫休眠 —— 一个静音自动播放过的页面完全可以从此再不播报媒体事件，
    // 于是回收腿永远跳过它，内存只增不减。放在错误页早退之前：错误页同样是
    // 「换了一份文档」，旧媒体一样没了。
    if (t.audioPlaying) {
      t.audioPlaying = false
      host._scheduleEmitChanged({ layout: false })
    }
    // 插件插槽 webview.lifecycle.did-navigate（MODE=EVENT，忽略返回值）。
    // 放在错误页判定**之前**：Mod 想观察"跳转失败"同样是合理需求，
    // 而错误页恰好是最需要被观察的场景之一。
    if (typeof host._hooks.onDidNavigate === 'function') {
      try { host._hooks.onDidNavigate({ tabId: id, url: String(url || '') }) } catch (_) {}
    }
    // 画布色跟着地址翻面（新标签页透明 / 普通网页白纸）。放在错误页早退**之前**：
    // 错误页是一份白底文档，必须把新标签页留下的透明画布翻回白纸，
    // 否则错误内容会直接叠在窗口壁纸上。
    if (typeof host.syncTabCanvas === 'function') host.syncTabCanvas(id, String(url || ''))
    // 错误页不覆盖原 URL（保持地址栏显示失败的网址）
    if (url && isWebErrorUrl(url)) return
    t.url = String(url)
    if (t.error) t.error = null
    // 地址栏回填的**权威时刻**：导航已提交，`t.url` 此刻才是真实地址。
    // 刷新（同 URL 重新提交）也走这里 —— 渲染层据此**强制**覆盖用户手改了一半的文本。
    // 不能改用 `tab:loading` 的起点：那一刻 Chromium 尚未提交新文档，`t.url` 还是上一页，
    // 拿它回填会「用户输新网址回车 → 先闪回旧地址」（见 did-start-loading 处注释）。
    host._emit('tab:navigated', {
      tabId: id,
      url: t.url,
      inPage: false,
      active: String(host.getActiveTabId() || '') === id
    })
    // ⚠ 这里**不再**维护 `t.navHistory`（曾经每次导航调一次
    //   `navigationHistory.getAllEntries()`）。那条 API 的每一项都带 base64 的
    //   `pageState`（滚动位置 / 表单值快照），一次导航就是把整条历史连字节一起拷一遍 ——
    //   而它发生在**导航提交这一拍**，正是"跳转要等一下才动"的来源之一。
    //   现在改成**懒读取**：休眠前由 tabPreSleep 从活的 wc 抓、落盘时由
    //   TabManager#listForPersist 从活的 wc 抓（两者都是低频路径）。
    // 跨文档导航**已提交**（但页面还没加载完）：标题此刻仍是上一页的，必须清空，
    // 由 did-finish-load 带着真实标题落库。这里只报告事实，不写历史。
    if (typeof host._hooks.onNavigationCommitted === 'function') {
      try {
        host._hooks.onNavigationCommitted({
          tabId: id,
          url: t.url,
          title: '',
          favicon: t.favicon || '',
          inPage: false,
          incognito: !!t.incognito
        })
      } catch (_) {}
    }
    host._scheduleEmitChanged()
  })

  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    // 子框架（iframe）的页内导航不是"用户去了新页面"：写回 t.url 会直接污染地址栏，
    // 写历史则会凭空多出一堆 iframe 广告页。
    if (isMainFrame === false) return
    // 错误页不覆盖原 URL：错误页自己 `history.replaceState` 会触发本事件，
    // 若在此写回 `hira://error?...`，地址栏就会丢掉失败的原网址（与 did-navigate 同一条守卫）。
    if (url && isWebErrorUrl(url)) return
    t.url = String(url)
    // 同文档导航（SPA 路由 / 锚点）是**主框架**的地址变化，地址栏同样必须跟上
    //（刷新等跨文档导航走上面的 did-navigate）。
    host._emit('tab:navigated', {
      tabId: id,
      url: t.url,
      inPage: true,
      active: String(host.getActiveTabId() || '') === id
    })
    // 同文档导航（SPA 路由 / 锚点）同样**不维护** navHistory —— 理由与 did-navigate
    // 那一条完全相同：`getAllEntries()` 要把整条历史（含每条 base64 pageState）拷一遍，
    // 而 SPA 的页内导航可能非常频繁（每次路由切换都会来）。休眠 / 落盘时再懒读取。
    // 同文档导航在标题/加载时机上拿不到 did-finish-load（页面没有重新加载），
    // 因此在这里就把「已提交」这一事实交给记录器：它会挂起这一跳、等导航链安静下来，
    // 链上被后续跳转取代的中间跳整条丢弃（去重与重定向去抖都在记录器里，见 history-recorder）。
    if (typeof host._hooks.onNavigationCommitted === 'function') {
      // 标题取 **webContents 当前标题**，与 did-finish-load 同口径：
      // SPA 路由切换时页面往往在 pushState 之前就把 title 改好了，而 `t.title`
      // 只在 page-title-updated 时更新 —— 某些站点（路由后不再触发标题事件）
      // 会让这里退化成「只有 URL」。wc.getTitle() 永远反映当前文档，取不到才回落。
      let title = ''
      try { title = String(wc.getTitle() || '') } catch (_) {}
      if (!title) title = String(t.title || '')
      try {
        host._hooks.onNavigationCommitted({
          tabId: id,
          url: t.url,
          title,
          favicon: t.favicon || '',
          inPage: true,
          incognito: !!t.incognito
        })
      } catch (_) {}
    }
    host._scheduleEmitChanged()
  })

  /**
   * ── 链接悬停 URL（状态栏提示）─────────────────────────────────────
   *
   * Chromium 在指针进入 / 离开一个链接时发这个事件：进入给 URL，离开给空串。
   * 它是**逐帧高频**事件（鼠标划过一串链接就连续触发），因此这里只做一件事 ——
   * 把事实交给宿主钩子，由宿主（apps 层）决定"给哪条浮层、要不要收起"。
   * infra 不认识浮层，也不认识 IPC（对齐 onDidNavigate / onFaviconUpdated 的边界）。
   *
   * ⚠ 不做「同 URL 去重」：Chromium 自己已经只在变化时发（离开 → 空串也只发一次），
   * 再加一层去重会让"离开链接 → 又回到同一个链接"漏掉一次显示。
   */
  wc.on('update-target-url', (_e, url) => {
    if (!host._isCurrentWc(id, wc)) return
    if (typeof host._hooks.onTargetUrl !== 'function') return
    try { host._hooks.onTargetUrl({ tabId: id, url: String(url || '') }) } catch (_) {}
  })

  // ── PDF 链接拦截 + 插件跳转钩子 ──
  //
  // 顺序是有意的：
  //   ① PDF 分流是**内核行为**（改 URL 去内置查看器），先做完；插件不该被迫感知它，
  //      否则每个想拦截导航的 Mod 都得自己判一遍 .pdf。
  //   ② 再走官方插槽 webview.lifecycle.will-navigate（MODE=REDUCE，可改写 / 可取消）。
  //      插槽必须**同步**执行 —— `preventDefault()` 只在这个回调内有效，
  //      任何 await 都会让取消失效（用户看到"点了链接还是跳了"）。
  //
  // ★ 下面这段是 **`will-navigate` 与 `will-redirect` 共用的唯一实现**。
  //   为什么必须共用：两条事件回答的是同一件事（"这次导航要去哪、要不要拦"），各写一份
  //   必然漂移。而 301 / 302 **只会**触发 `will-redirect` —— 于是"重定向到 .pdf"这种
  //   最常见的真实场景（登录后跳 PDF / 分享短链）既不进内置查看器、插件也拦不到。
  /**
   * @param {Electron.Event} e
   * @param {string} url
   * @param {boolean} isRedirect 本次是否由重定向触发（透传给插件，便于它避免重复计数）
   */
  const handleNavigationIntent = (e: ElectronEvent, url: string, isRedirect: boolean): void => {
    if (!url) return
    if (isNonWebUrl(url)) return
    // PDF 分流：判据唯一（「是不是 PDF → 设置允许吗 → 包成 hira://pdf」全在 tabUrl#resolvePdfTarget）。
    // 返回原地址 = 不需要改道（不是 PDF，或内置查看器已关）→ 继续往下走插件插槽，
    // 与"关闭查看器时让 Chromium 走它自己的下载链路"这条既有口径一致。
    const pdfTarget = resolvePdfTarget(url, (target) => (
      typeof host._shouldUsePdfViewer === 'function' ? host._shouldUsePdfViewer(target) : true
    ))
    if (pdfTarget !== String(url)) {
      e.preventDefault()
      wc.loadURL(pdfTarget).catch((err) => {
        if (err && err.code !== 'ERR_ABORTED' && !String(err.message).includes('ERR_ABORTED')) {
          console.error('[tab] PDF redirect loadURL failed:', err.message)
        }
      })
      return
    }

    if (typeof host._hooks.onWillNavigate !== 'function') return
    let next = null
    try {
      next = host._hooks.onWillNavigate({ tabId: id, url: String(url), redirect: !!isRedirect })
    } catch (error: unknown) {
      console.warn('[tab] onWillNavigate hook failed (navigation proceeds):', error instanceof Error ? error.message : error)
      return
    }
    if (!next || typeof next !== 'object') return
    if (next.cancel) {
      e.preventDefault()
      return
    }
    if (next.url && String(next.url) !== String(url)) {
      e.preventDefault()
      wc.loadURL(String(next.url)).catch((err) => {
        if (err && err.code !== 'ERR_ABORTED' && !String(err.message).includes('ERR_ABORTED')) {
          console.error('[tab] will-navigate rewrite loadURL failed:', err.message)
        }
      })
    }
  }

  wc.on('will-navigate', (e, url) => handleNavigationIntent(e, url, false))
  wc.on('will-redirect', (e, url) => {
    // 已被先注册的监听者处理过就不再插手：最典型的是「仅 HTTPS」的 http→https 升级
    // —— 它在 `web-contents-created` 时注册（早于本处），并且也是 preventDefault + loadURL，
    // 两边都动手会变成"互相改写对方的 URL"。
    if (e.defaultPrevented) return
    handleNavigationIntent(e, url, true)
  })

  // ── TitleSync ──
  wc.on('page-title-updated', (_e, title) => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    const next = String(title)
    // 同值直接丢：SPA 会把同一个标题反复重报（框架初始化、路由二次提交、
    // 组件重挂载），而这里每报一次都要**重算一整份投影**推给渲染层、
    // 并让下游把标题再回写一次库。值没变就是什么都没变。
    if (t.title === next) return
    t.title = next
    if (typeof host._onTitleUpdated === 'function' && t.url) {
      // 带上 tabId：标题回写的策略在 apps 层（按标签状态 / 去重 / 合并），
      // infra 只负责把「哪个标签的标题变了」这一事实报上去。
      try { host._onTitleUpdated({ tabId: id, url: t.url, title: t.title }) } catch {}
    }
    host._scheduleEmitChanged()
  })

  // ── 加载状态 ──
  //
  // payload 里带一个 `active`：**"这条边沿是不是活动标签的"由主进程裁定**。
  // 为什么不能在渲染层用 tabId 比对：启动首个标签的 did-start-loading 早于第一份
  // tab:changed，那一刻渲染层还不知道谁是活动标签（activeId 为 null），比对必然失配
  // —— 事件被整个丢弃，进度条与"停止"键就一条都不显示。主进程此刻**知道**谁是活动
  // 标签，让它把这个判断随事件一起发下来，时序问题从根上就没有了。
  //
  // 只发边沿事件（不额外推投影）：`tab:loading` 负责"立刻"，"最终收敛"由投影里的
  // loading 兜底 —— 活动标签那一路取的是原生 `wc.isLoading()`（见 TabManager#_liveStateOf）。
  // 刻意**不**在这里补 `_scheduleEmitChanged()`：did-start-loading 发生在导航提交**之前**，
  // 此刻标签记录里的 url 还是上一个页面，凭空多推一份"旧地址"的投影只会给地址栏制造
  // 一次无谓的写入竞争。
  wc.on('did-start-loading', () => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    t.loading = true
    host._emit('tab:loading', { tabId: id, loading: true, active: host.getActiveTabId() === id })
  })

  wc.on('did-stop-loading', () => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    t.loading = false
    host._emit('tab:loading', { tabId: id, loading: false, active: host.getActiveTabId() === id })
  })

  // ── 插件插槽：webview.lifecycle.did-finish-load（MODE=EVENT，忽略返回值）──
  // 刻意与 did-stop-loading **分开**绑：后者承载的是「标签忙不忙」（t.loading + tab:loading
  // 广播），而插槽说的是「这一页画完了」——重定向、子资源失败、被取消的导航都会让两者错开，
  // 合成一条会让 Mod 收到错误的时机。
  wc.on('did-finish-load', () => {
    if (!host._isCurrentWc(id, wc)) return
    // favicon 兜底（与本回调的插件插槽互不影响，各做各的）
    recoverFaviconFromPage()
    let url = ''
    try { url = String(wc.getURL() || '') } catch (_) {}
    // 页面加载完成 = 这一跳**已经画完**，是记录器判定「它是不是导航链落地页」的关键信号
    //（重定向链上被后续跳转取代的中间跳会被整条丢弃，见 apps/main/history-recorder.js）。
    // 标题以 **webContents 当前标题**为准（对齐 RT `recordBrowsingHistoryFromWebContents`）：
    // `t.title` 只在 page-title-updated 时更新，跨文档导航后可能还残留**上一页**的标题，
    // 先读它会把新 URL 记成旧页标题。wc 的标题在文档提交后就属于新页面（无 title 时回 URL），
    // 仅当它确实为空才回落到 t.title —— 绝不能退化成「只有 URL」的记录。
    const t = host._tabs.get(id)
    if (t && typeof host._hooks.onPageReady === 'function') {
      let title = ''
      try { title = String(wc.getTitle() || '') } catch (_) {}
      if (!title) title = String(t.title || '')
      try {
        host._hooks.onPageReady({
          tabId: id,
          url: url || t.url || '',
          title,
          favicon: t.favicon || '',
          incognito: !!t.incognito
        })
      } catch (_) {}
    }
    if (typeof host._hooks.onDidFinishLoad !== 'function') return
    try { host._hooks.onDidFinishLoad({ tabId: id, url }) } catch (_) {}
  })

  /**
   * 扩展页的图标兜底：`chrome-extension://<id>/…`（设置页 / popup / 扩展自己的
   * 新标签页）**通常不声明 favicon** —— `page-favicon-updated` 不播报、
   * `recoverFaviconFromPage()` 也读不到，标签行就只剩标题首字。这类页面应当显示
   * **该扩展自己的图标**（对齐 Chrome）。
   *
   * 为什么走 hook：infra-window 不认识扩展领域（id → 清单 / 图标文件都在
   * domain-extension + 扩展服务侧）。hook 返回空串 = 不是扩展页 / 该扩展没有图标，
   * 此时保持首字兜底不变。
   *
   * 与真实 favicon 的关系：只在 `t.favicon` 为空时写入，且**不走**
   * `_onFaviconUpdated` —— 这是展示兜底，不是页面声明的图标，绝不能落进
   * favicons 表 / 历史（与上面「清空只改内存态」同一口径）。
   * @param {string} [pageUrl] 导航目标（did-start-navigation 时 t.url 还是旧值）
   */
  function applyHostFaviconFallback(pageUrl: string = ''): void {
    if (typeof host._hooks.onFaviconFallback !== 'function') return
    const t = host._tabs.get(id)
    if (!t || t.favicon) return
    const url = String(pageUrl || t.url || '')
    if (!url) return
    let fallback = ''
    try {
      fallback = String(host._hooks.onFaviconFallback({
        tabId: id,
        url,
        profileId: String(t.containerProfileId || t.profileId || 'default')
      }) || '')
    } catch (_) { return }
    if (!fallback) return
    // hook 是同步的，但期间仍可能被别的路径填上 → 回写前再确认一次
    const cur = host._tabs.get(id)
    if (!cur || cur.favicon) return
    cur.favicon = fallback
    host._scheduleEmitChanged()
  }

  /**
   * favicon 兜底：**事件没送来图标时，直接问页面自己**。
   *
   * 为什么需要它（用户报的"概率性地拿不到 favicon，只剩兜底首字图标"）：
   * Chromium 只在图标**首次到达**时播报 `page-favicon-updated`，之后同 URL 重载、
   * 无变化的重新解析都不再播报（本文件那段实测注释记的就是这条）。于是任何一次
   * "清空了记录、但页面没有再播报"的组合，图标就**永久**回不来 —— 例如：
   *   · 关闭最后一个标签的原地补位（同一个 webContents 重载同一地址，见 TabManager）；
   *   · 导航切换时先清了旧站图标，而新页面的图标因为某种原因没有播报。
   * 这些情形下页面**自己声明的** `link[rel~=icon]` 一直都在，读一次就能补回来。
   *
   * 只在 `t.favicon` 为空时做（正常路径一次 JS 都不执行），且只认页面显式声明的图标 ——
   * 绝不臆造 `<origin>/favicon.ico`：内部页（hira://…）没有图标，凭空造一个只会让
   * 渲染层 `<img>` 裂图，反而不如保留首字兜底。
   */
  function recoverFaviconFromPage() {
    const t = host._tabs.get(id)
    if (!t || t.favicon) return
    if (!wc || wc.isDestroyed()) return
    let pending
    try {
      // 页面内图标候选。只读显式声明，不猜 `/favicon.ico`；顺序是"普通图标 →
      // Apple 触屏图标 → mask 图标"。Electron 的 page-favicon-updated 已经
      // 覆盖普通图标的常规路径，这里只是它迟到/漏报时的最后兜底。
      pending = wc.executeJavaScript(
        `(() => {
           const href = (node) => node && node.href ? String(node.href) : '';
           const rel = (value) => [...document.querySelectorAll('link[rel]')]
             .find((node) => String(node.rel || '').toLowerCase().split(/\\s+/).includes(value));
           const first = rel('icon') || rel('shortcut icon') || rel('apple-touch-icon') || rel('mask-icon');
           return href(first);
         })()`,
        false
      )
    } catch (_) {
      applyHostFaviconFallback()
      return
    }
    Promise.resolve(pending).then((href) => {
      const url = String(href || '')
      if (!url) {
        // 页面没声明图标（扩展的 popup / 设置页就是这种）→ 交给展示兜底
        applyHostFaviconFallback()
        return
      }
      // 等待期间可能已切走 / 被销毁 / 已被真实事件填上 → 一律不回写
      if (!host._isCurrentWc(id, wc) || wc.isDestroyed()) return
      const cur = host._tabs.get(id)
      if (!cur || cur.favicon) return
      cur.favicon = url
      if (typeof host._onFaviconUpdated === 'function' && cur.url) {
        try { host._onFaviconUpdated(cur.url, url) } catch {}
      }
      host._scheduleEmitChanged()
    }).catch(() => applyHostFaviconFallback())
  }

  // ── favicon 同步 ──
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    const next = (favicons && favicons[0]) ? String(favicons[0]) : ''
    if (next) {
      t.favicon = next
      if (typeof host._onFaviconUpdated === 'function' && t.url) {
        try { host._onFaviconUpdated(t.url, next) } catch {}
      }
      host._scheduleEmitChanged()
      return
    }
    // 空数组 / 首个元素为空：Chromium 以此表示「该页没有或移除了图标」。
    // 必须清空并广播，否则会一直沿用上一个站点的图标。
    // 注意**不走** _onFaviconUpdated —— 那条路会把 favicon 写进 favicons 表 /
    // 历史 / 书签，清空绝不能污染这些记录（只清内存态 + 通知渲染层）。
    if (t.favicon) {
      t.favicon = ''
      host._scheduleEmitChanged()
    }
    // 扩展页没有声明图标 → 退回扩展自己的图标（见 applyHostFaviconFallback）。
    // 放在清空之后：真实图标事件可能晚到，但那时会直接覆盖兜底值。
    applyHostFaviconFallback()
  })

  // 新一轮主框架导航开始（去错误页不算）→ 允许再切一次错误页
  wc.on('did-start-navigation', (_e, navUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    if (isWebErrorUrl(navUrl)) return
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    t._errorPageSwitched = false
    // 跨文档主框架导航开始 → 判断要不要清空 favicon。规则照搬 Hira
    // `js/navbar/tabColor.js`：**同站点保留，换站点才清**。
    //
    // 为什么不能「刷新也清」：Chromium 只在图标的**首次到达**时发一次
    // page-favicon-updated，**同 URL 刷新不会再发第二次**。实测（Electron 探针）：
    //     +   8ms did-start-navigation(isInPlace=false)   ← 首屏
    //     + 902ms did-finish-load
    //     + 905ms page-favicon-updated [favicon.ico]
    //     + 915ms did-start-navigation(isInPlace=false)   ← reload
    //     +1508ms did-finish-load                         ← 此后 4s 内再无该事件
    // 于是「刷新即清空」会把图标**永久清掉**（用户报的「刷新之后 favicon 清除了也不加载」）。
    //
    // 三条分支：
    //   · isInPlace（同文档：哈希 / SPA 路由）→ 不动，站内跳转不该闪图标；
    //   · 同 host（刷新 / 站内跳转）→ **保留** —— 图标属于这个站点，刷新后依然有效；
    //   · 换 host（或跳到 hira:// 这类非 http(s)、URL 解析不出站点）→ 清空，
    //     否则会把上一站的图标一路带到「本身没有图标」的页面上。
    // 注意：清空**只改内存态并广播**，绝不调用 _onFaviconUpdated（那是落库/落历史的路径）。
    if (!isInPlace && t.favicon) {
      const prevSite = siteKeyOf(t.url)
      const nextSite = siteKeyOf(navUrl)
      const sameSite = !!prevSite && prevSite === nextSite
      if (!sameSite) {
        t.favicon = ''
        host._scheduleEmitChanged()
      }
    }
    // 扩展页（chrome-extension://…）没有站点图标可等 → 立刻退回扩展自己的图标。
    // 同站点保留的分支里 t.favicon 非空，本函数会直接跳过。
    if (!isInPlace) applyHostFaviconFallback(navUrl)
  })

  // ── 导航失败处理（did-fail-load + did-fail-provisional-load）──
  // DNS 解析失败、连接被拒等发生在 provisional 阶段，仅监听 did-fail-load 会漏报。
  const handleLoadFailure = (errorCode: number, errorDescription: string, validatedURL: string): void => {
    if (errorCode === -3 || errorCode === 0) return // ERR_ABORTED / 正常，忽略
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    if (validatedURL && isWebErrorUrl(validatedURL)) return
    // 同一次导航失败会被两个事件各上报一次；第二次若照样切错误页，
    // 其 loadURL 会打断第一次 → 抛 ERR_ABORTED（噪音 + 抖动）。
    // 用「本轮导航是否已切过错误页」去重；标志在新一轮主框架导航开始时清空。
    if (t._errorPageSwitched) return
    t._errorPageSwitched = true
    const failedUrl = validatedURL || t.url || ''
    t.error = { code: errorCode, description: errorDescription, url: failedUrl }
    const errorUrl = webErrorUrl(errorCode, failedUrl)
    wc.loadURL(errorUrl).catch((err) => {
      const msg = String((err && err.message) || err || '')
      if (msg.includes('ERR_ABORTED')) return
      if (!msg.includes('hira://error')) return
      console.error('[tab] load error page failed:', msg)
    })
    host._scheduleEmitChanged()
  }

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    handleLoadFailure(errorCode, errorDescription, validatedURL)
  })

  wc.on('did-fail-provisional-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    handleLoadFailure(errorCode, errorDescription, validatedURL)
  })

  // 渲染进程崩溃/被杀 → 展示错误页
  wc.on('render-process-gone', (_e, details) => {
    if (!host._isCurrentWc(id, wc)) return
    const t = host._tabs.get(id)
    if (!t) return
    const reason = details?.reason || 'crashed'
    const reasonMap: Record<string, { code: number; desc: string }> = {
      crashed: { code: -500, desc: '渲染进程崩溃' },
      killed: { code: -501, desc: '渲染进程被终止' },
      oom: { code: -502, desc: '内存不足，页面已关闭' },
      'launch-failed': { code: -503, desc: '渲染进程启动失败' },
      'integrity-failure': { code: -504, desc: '安全检查失败' }
    }
    const info = reasonMap[reason] || { code: -505, desc: '页面意外关闭' }
    t.error = { code: info.code, description: info.desc, url: t.url || '' }
    const errorUrl = webErrorUrl(info.code, t.url || '')
    wc.loadURL(errorUrl).catch(() => {})
    host._scheduleEmitChanged()
  })

  host._boundTabIds.add(id)
  // 通知主进程该标签的 webContents 已就绪（用于注册对话框等处理器）。
  // 用 emit 而非 _emit：webContents 不可序列化，不能发给 renderer。
  host.emit('tab:webcontents-ready', { tabId: id, webContents: wc })
}

