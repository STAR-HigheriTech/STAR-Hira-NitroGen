/**
 * 地址栏（omnibox）—— **装配器**：输入框 + 搜索建议 + 站点控制件 + 书签星 + PWA。
 *
 * 为什么这些住在一起：它们**共享同一个输入框上下文**（建议下拉锚在输入框上、
 * 站点控制件画在输入框内）。拆开会立刻需要把 addressInput / searchBar 当成参数
 * 在几个文件之间传来传去 —— 那是假解耦。
 *
 * 真该独立的已经独立：
 *   ./siteIdentity.ts             站点身份按钮（锁 / 地球 + 角标 + 规则圆点：哑件）
 *   ./bookmarkStar.ts             书签星（哑件：只渲染状态 + 上抛意图）
 *   ./pwa-install-button.ts       PWA 安装 / 打开应用（哑件：只渲染三态 + 上抛意图）
 *
 * 本模块对外的边界：
 *   · 不认识 IPC：搜索地址由 ctx.searchBar.getSearchUrl 注入，建议数据由 getOpenTabs 注入；
 *   · 不认识书签库：书签星是**哑组件**，真实状态由编排层灌入；
 *   · 不认识权限 / 证书 / Cookie 宿主：站点身份按钮只换形，聚合浮层由编排层调度。
 */

import { createSearchBar } from '@hira-ng/ui-searchbar'
import type { FocusSearchbarOptions, SearchBarController, SetQueryOptions } from '@hira-ng/ui-searchbar'
import { createSiteIdentity } from './siteIdentity'
import { createBookmarkStar } from './bookmarkStar'
import { createPwaInstallButton } from './pwa-install-button'
import type { NavbarHandlers, OmniboxController } from '../types'

export const OMNIBOX_CSS = `
    .omnibox {
      display: flex;
      align-items: center;
      gap: var(--ng-omnibox-gap);
      /* 可伸可缩，但**有上限**：两侧按钮删光后不再跟着窗口无限变宽。
         上限的唯一真源是 tokens 的 --ng-omnibox-max-width（窄窗口照常收缩）。 */
      flex: 1;
      max-width: var(--ng-omnibox-max-width);
      min-width: 0;
      position: relative;
    }

    #address-input {
      flex: 1;
      min-width: 0;
      height: 100%;
      /* border-box：高度的百分比按字段的**外框**算，内边距因此不会把输入框
         撑出字段（下面那条 1px 校正就靠这个前提）。
         左 10px：站点身份按钮与提示字（placeholder）/ 网址之间要有呼吸，
         否则文字像直接粘在锁图标上。右 4px：收藏星那侧仍贴着，保持一整条观感。
         这是 input 自身的内边距 —— 按钮是它的兄弟节点（间距由按钮 margin 决定），
         所以加左内边距只把文字起点右推，不动字段外壳与聚合浮层按钮的距离。 */
      box-sizing: border-box;
      /* 上 1px / 下 0：单行输入框的文字由 Chromium 在内容盒里**垂直居中**，
         而 Arial 的 ascent / descent 不对称（12 / 3），视觉上字会比 28px 按钮
         图标的中心高出 0.5px（用户口径：「文字相对于按钮偏上一小点」）。
         不对称内边距把居中点整体下移 0.5px（内容盒同时少 1px，总高不变）；
         1px 是实测值：内容盒 45→44、行盒居中点 57.5→58.0，正好落在图标中心。 */
      padding: 1px 4px 0 10px;
      border: none;
      background: transparent;
      color: inherit;
      outline: none;
    }

    /* 输入框 + 站点信息（锁）共用一个"字段"外壳：
       边框 / 圆角 / 底色都挂在外壳上，输入框自己是透明无边框的 —— 这样锁图标
       是**字段内部**的装饰，而不是浮在地址栏外面的另一颗按钮。
       hover / focus-within 都以外壳为准：鼠标划到锁或输入框，整条字段一起变。 */
    .omnibox__field {
      display: flex;
      align-items: center;
      flex: 1;
      min-width: 0;
      height: var(--ng-omnibox-height);
      border: var(--ng-omnibox-field-border-width) solid var(--addr-bar-border-color);
      border-radius: var(--ng-omnibox-radius);
      background: var(--addr-bar-bg-color);
      transition: background 0.15s ease, border-color 0.15s ease;
      /* 外壳是 drag 区的一部分，输入框与锁必须显式声明可交互 */
      -webkit-app-region: no-drag;
    }
    .omnibox__field:hover {
      background: var(--addr-bar-bg-color-hover);
    }
    .omnibox__field:focus-within {
      background: var(--addr-bar-bg-color-focus);
    }
    /* 浮层打开时字段保持「活跃」观感：键盘焦点可能在浮层或网页上，
       不能只靠 :focus-within 表达「这条字段正在被使用」。 */
    .omnibox__field:has(.omnibox__site-identity.is-open) {
      background: var(--addr-bar-bg-color-focus);
    }
    /* 站点身份：地址栏字段左端的主按钮。
       视觉基线向工具栏动作按钮看齐：占满字段内高（扣除两侧 1px 边框 = 28px）、
       图标 18px、悬停底色用同一套 --main-btn-bg-color-hover。
       它虽是字段内部件，但不是"小装饰"——用户要能一眼看见并点得准。 */
    .omnibox__site-identity {
      position: relative;
      width: var(--ng-omnibox-action-size);
      height: var(--ng-omnibox-action-size);
      flex-shrink: 0;
      /* 与字段共用主题圆角；水平偏移扣掉边框后，四边到字段外缘均为 2px。 */
      border-radius: var(--ng-omnibox-action-radius);
      background: transparent;
      color: inherit;
      margin-left: var(--ng-omnibox-action-offset);
      margin-right: 0;
    }
    .omnibox__site-identity:hover {
      background: var(--main-btn-bg-color-hover, rgba(0, 0, 0, 0.08));
    }
    /* 浮层展开时按钮保持「按下」底色 —— 用户一眼能看出当前挂在谁身上。 */
    .omnibox__site-identity.is-open,
    .omnibox__site-identity.is-open:hover {
      background: var(--hira-accent-bg, rgba(59, 130, 246, 0.12));
    }
    .omnibox__site-identity.is-insecure {
      color: var(--hira-warn, #d97706);
    }

    /* 收藏星：与站点身份按钮同一套视觉规格（28×28、主题圆角、18px 图标、
       hover 用 --main-btn-bg-color-hover），只是挂在字段右端。
       它同样是字段内的**固定装饰件**，不参与工具栏排序 / 显隐 / 编辑模式。 */
    .omnibox .omnibox__bookmark-star {
      width: var(--ng-omnibox-action-size);
      height: var(--ng-omnibox-action-size);
      flex-shrink: 0;
      border-radius: var(--ng-omnibox-action-radius);
      background: transparent;
      color: inherit;
      margin-right: var(--ng-omnibox-action-offset);
    }
    .omnibox .omnibox__bookmark-star:hover {
      background: var(--main-btn-bg-color-hover, rgba(0, 0, 0, 0.08));
    }
    .omnibox .omnibox__bookmark-star:active {
      transform: scale(0.96);
    }

    /* 待处理权限请求角标：只做覆盖层，不参与按钮布局（换图标时由组件补挂）。 */
    .omnibox__site-identity-badge {
      position: absolute;
      top: 1px;
      right: 1px;
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      box-sizing: border-box;
      border-radius: var(--hira-radius-control, 7px);
      background: var(--hira-danger, #dc2626);
      color: #fff;
      font-size: 9px;
      line-height: 14px;
      font-weight: 600;
      text-align: center;
      letter-spacing: 0;
      pointer-events: none;
    }
    .omnibox__site-identity-badge[hidden],
    .omnibox__site-identity-dot[hidden] {
      display: none;
    }

    /* 规则圆点：本站存在已保存的权限规则时亮起（与「有请求」的红色角标区分开）。 */
    .omnibox__site-identity-dot {
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--hira-accent, #3b82f6);
      pointer-events: none;
    }
`

/**
 * @param {Document} doc
 * @param {{
 *   handlers?: object,
 *   useItem: (id: string, el: HTMLElement) => HTMLElement
 * }} ctx
 * @returns {{
 *   element: HTMLElement,
 *   addressInput: HTMLInputElement,
 *   searchBar: SearchBarController,
 *   setAddress: (url: string) => void,
 *   focusAddress: (options?: object) => void,
 *   releaseAddressFocus: () => void,
 *   hideSuggestions: () => void,
 *   setBookmarkStar: (state?: object) => void,
 *   setPwaInstallState: (state?: object) => void,
 *   setSiteInfo: (state?: object) => void,
 *   getSiteInfoAnchorRect: () => ({ left: number, top: number, width: number, height: number } | null)
 * }}
 */
export function createOmnibox(
  doc: Document,
  ctx: {
    handlers: NavbarHandlers
  }
): OmniboxController {
  const { handlers = {} } = ctx

  const element = doc.createElement('div')
  element.className = 'omnibox'
  // 焦点哨兵声明（见 app-shell/focus-sentinel.ts）：地址栏整块区域属于「点了就该留在外壳」。
  // 字段左右的锁 / 星 / 按钮本身已豁免，但字段外的内边距、留白同样是地址栏语义 ——
  // 若按外壳空白处理，点一下内边距就会把键盘焦点扔回网页，用户等于白点。
  element.setAttribute('data-content-focus', 'keep')

  const addressInput = doc.createElement('input')
  addressInput.id = 'address-input'
  addressInput.placeholder = 'Enter URL or search'
  // 初始留空：真实地址由编排层在活动标签变化时经 setAddress() 注入，
  // 不在组件内硬编码占位网址（否则首帧会闪出一个与当前标签无关的地址）。

  // 输入框 + 站点身份共用一个字段外壳（边框 / 底色在壳上，见 OMNIBOX_CSS）。
  // 身份按钮必须**先于**输入框进入 field：它是字段左端的固定装饰，不参与段内重排
  // （ledger 只重排直接挂在 host 上的成员，包进 field 后位置天然稳定）。
  const field = doc.createElement('div')
  field.className = 'omnibox__field'

  // 身份按钮是字段内的**固定装饰件**，与输入框同级平铺：绝不交给工具栏账本
  // （`useItem` 会把它标记为可编辑按钮，从而被排序 / 显隐 / 编辑模式误伤）。
  // 它没有可配置性，也不该出现在按钮编辑浮层里。
  const siteInfo = createSiteIdentity(doc, {
    onToggle: handlers.onSiteInfo,
    onIntent: handlers.onSiteIntent
  })
  field.appendChild(siteInfo.element)
  field.appendChild(addressInput)

  // 收藏星与站点身份按钮同级：字段右端的固定装饰件。
  // 与左侧的锁一样**绝不交给工具栏账本**（`useItem` 会让它被排序 / 显隐 /
  // 编辑模式误伤，并在按钮编辑浮层里留下无法生效的幽灵格子）。
  const bookmarkStar = createBookmarkStar(doc, {
    onToggle: handlers.onToggleBookmark,
    onContextMenu: handlers.onStarContextMenu
  })
  bookmarkStar.element.classList.add('omnibox__bookmark-star')
  field.appendChild(bookmarkStar.element)
  element.appendChild(field)

  // 搜索建议（插件式数据源全由编排层注入，本组件零知识）
  const sbHandlers = handlers.searchBar || {}
  const searchBar: SearchBarController = createSearchBar(addressInput, {
    getOpenTabs: sbHandlers.getOpenTabs || (() => []),
    onCommit: (url) => {
      if (typeof sbHandlers.onCommit === 'function') sbHandlers.onCommit(url)
    },
    onAction: (action) => {
      if (typeof sbHandlers.onAction === 'function') sbHandlers.onAction(action)
    },
    overlay: handlers.overlay || undefined,
    // 由编排层注入：按设置里的默认搜索引擎构造 URL（可热更新）
    getSearchUrl: sbHandlers.getSearchUrl,
    // 搜索相关开关（建议 / Bangs），同样由编排层从设置同步
    searchSettings: sbHandlers.searchSettings,
    // 引擎表（活引用）—— 让地址栏把"用户已配置的搜索引擎"也当作 `!名字` 的 bang。
    // ⚠ 此前**漏传**了下面两项：编排层（app-shell）已经备好 `getEngines` /
    //   `getRemoteSuggestions`，但本组件没往 createSearchBar 里递 —— 于是
    //   bangs 只认内置表、远端（历史/书签/已开标签）建议**一条都出不来**。
    //   这是"搜索下拉栏什么都没接入"的根因，务必与 app-shell 的字段名保持一字不差。
    getEngines: sbHandlers.getEngines,
    // 面板目录（活引用）—— `!面板名` 打开侧栏面板；与 getEngines 同一套注入方式。
    getPanels: sbHandlers.getPanels,
    getRemoteSuggestions: sbHandlers.getRemoteSuggestions,
    // 即时答案（F-0771~F-0773）：取数已由编排层封装成"纯数据函数"，
    // 本组件与 ui-searchbar 都不摸 IPC；默认引擎决定它是否参与。
    getInstantAnswers: sbHandlers.getInstantAnswers,
    getDefaultEngine: sbHandlers.getDefaultEngine,
    // 开发态判定（惰性）—— 唯一真源是主进程 `app:info#isPackaged`，
    // 由编排层启动时缓存并注入；本组件只做透传。
    isDevelopmentMode: sbHandlers.isDevelopmentMode,
    // 已打开标签候选被键盘选中 + 回车时 → 切到那个标签（语义是"**回到**那一页"，
    // 不是再开一个）。与浮层点击路径（app-shell 的 overlay:commit open-tab 分支）语义一致。
    onActivateTab: sbHandlers.onActivateTab,
    // 「粘贴并前往」（Ctrl+Shift+V / 右键菜单）：剪贴板取数与提交都在编排层，
    // 本组件只负责把地址栏上的按键意图原样转达。
    onPasteAndGo: sbHandlers.onPasteAndGo
  })

  // 站点控制件已全部并入站点身份按钮（聚合浮层），此处不再摆放铃铛 / 盾牌。

  // PWA 安装 / 打开应用：三态哑件，真实状态由编排层经 setPwaInstallState() 灌入。
  // 与锁 / 星一样是地址栏内的**固定装饰件**，不参与工具栏账本（不可排序 / 不可移除 /
  // 不进按钮编辑浮层）—— 否则目录一旦不含它，applyOrder 会把整颗按钮 display:none 掉。
  const pwaInstallButton = createPwaInstallButton(doc, {
    onInstall: handlers.onInstallPwa,
    onOpen: handlers.onOpenPwa
  })
  element.appendChild(pwaInstallButton.element)

  // 点地址栏的**留白**（字段外壳自身 / 根元素的间隙）→ 光标直接进输入框。
  // 这两处元素不可聚焦，而焦点哨兵已把 `.omnibox` 声明为 keep（不把焦点还回网页）：
  // 不补这一下就成了「点了地址栏，键盘却没反应」的死角。
  // 只认这两个精确落点（不按 closest 泛化），绝不吃掉锁 / 星 / 按钮自己的点击。
  const focusAddressOnBlank = (event: PointerEvent): void => {
    if (!event || event.button !== 0) return
    if (event.target !== element && event.target !== field) return
    // 已聚焦：留白的点击不再有任何语义（原来那次 focus() 也只是空操作），直接放行。
    if (doc.activeElement === addressInput) return
    // 走**同一个入口**（searchBar.focus）：聚焦 + 全选。
    // 点字段留白与点输入框本身对用户是同一件事 —— 都叫"点了地址栏"，
    // 不该出现"点输入框会全选、点旁边一点却没选中"的割裂。
    if (searchBar) searchBar.focus()
    else { try { addressInput.focus(); addressInput.select() } catch (_) {} }
  }
  element.addEventListener('pointerdown', focusAddressOnBlank)

  return {
    element,
    addressInput,
    searchBar,

    setAddress(url: string, options?: SetQueryOptions) {
      if (searchBar) searchBar.setQuery(url, options)
      else addressInput.value = url
    },
    /**
     * 聚焦地址栏输入框。
     * @param {{ openSuggestions?: boolean }} [options] openSuggestions:false → 只聚焦、不弹建议下拉
     */
    focusAddress(options?: FocusSearchbarOptions) {
      if (searchBar) searchBar.focus(options)
      else { try { addressInput.focus() } catch (_) {} }
    },
    /**
     * 让出地址栏光标（**窗口真正失活**时由编排层调用）。
     *
     * 与 focusAddress 相对：Chromium 在窗口失活时不清 DOM 焦点，窗口一激活就把光标原样
     * 还回来 —— 表现就是「一切换窗口回来就自动聚焦地址栏」。失活当场交还，回来时就没有
     * 可恢复的"上次聚焦元素"了。主动聚焦只应发生在**启动**与**新建标签页**。
     */
    releaseAddressFocus() {
      if (searchBar && typeof searchBar.releaseFocus === 'function') searchBar.releaseFocus()
      else { try { addressInput.blur() } catch (_) {} }
    },
    /**
     * 收起建议下拉。
     * 切标签等「下拉的上下文已经变了」的场合必须调用：下拉浮层是独立 WebContentsView，
     * 只收它的主进程 bounds 是不够的 —— 地址栏这侧还留着「当前建议」，下次聚焦地址栏
     * 会把上一个标签的建议原样弹回来。
     */
    hideSuggestions() {
      if (searchBar && typeof searchBar.hide === 'function') searchBar.hide()
    },
    /**
     * 重新查一次建议（下拉里删掉一条历史后由编排层调用）。
     * 只转发、不缓存 —— 真源始终是 ui-searchbar 的 `currentSuggestions`（见该方法说明）。
     * @returns {Promise<void>}
     */
    refreshSuggestions() : Promise<void> {
      if (searchBar && typeof searchBar.refreshSuggestions === 'function') return searchBar.refreshSuggestions()
      return Promise.resolve()
    },
    setBookmarkStar: bookmarkStar.set,
    setPwaInstallState: pwaInstallButton.set,
    setSiteInfo: siteInfo.set,
    getSiteInfoAnchorRect: siteInfo.getAnchorRect,
    /**
     * 聚合按钮根元素。
     * 编排层用它做「点击浮层外部即收起」的命中排除：按钮自己的 pointerdown
     * 必须先于收起判定被放行，否则会出现「点了开关 → 先收起 → 再打开」的闪现。
     */
    getSiteInfoElement: () => siteInfo.element
  }
}
