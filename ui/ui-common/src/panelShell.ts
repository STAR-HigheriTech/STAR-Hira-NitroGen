/**
 * 面板壳的最小原子层 —— **面板宿主 renderer 的薄引导只许静态引入这一个文件**。
 *
 * 为什么独立成文件：面板 renderer 是**一次性的冷进程**（关闭即销毁），它能多快画出
 * 第一帧，直接等于用户点开面板后的"跟手感"。`ui-common/src/index.ts` 是四十多条
 * `export *` 的重桶（tabRowList / pinGrid / tabContextMenu …），静态引入它意味着
 * 首帧必须先把几十个与「画个标题栏」毫不相干的模块求值完。这里的依赖只有 DOM ——
 * 于是壳可以在主 chunk 求值的那一瞬就出现，重活（面板实现、插件插槽、IPC）再跟上。
 *
 * 本文件只负责三件事：reset 样式、原子按钮样式、壳结构。**不认识 IPC / 插件 / 面板实现**
 * （CONTRACT-11：ui 层对宿主零知识），所以任何宿主都能原样复用。
 */
import { iconByName, resolveIcon } from './icons'

export interface PanelHeaderDescriptor {
  panelId: string
  title: string
  titleElement: Element | null
  className: string
}

export interface PanelShellOptions {
  onClose?: () => void
  panelId?: string
  icon?: string
  pin?: { pinned?: boolean; onToggle?: () => void }
  decorateHeader?: (descriptor: PanelHeaderDescriptor) => PanelHeaderDescriptor | void
}

export interface PanelShellController {
  shell: HTMLDivElement
  content: HTMLDivElement
  header: HTMLDivElement
  actions: HTMLDivElement
  closeBtn: HTMLButtonElement
  pinBtn: HTMLButtonElement | null
  setPinned: (pinned: boolean) => void
  onPinnedChange: (fn: (pinned: boolean) => void) => () => void
  updateHeader: (final: Partial<PanelHeaderDescriptor>) => void
}

/**
 * 通用控件样式（跨视图共用件：`.ui-common__window-controls`）。
 * 独立于面板基底：导航栏 / 标签栏 / 侧栏槽位也用同一簇，不该为它拉进整份面板 reset。
 * @param {Document} doc
 */
export function injectCommonStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById('ui-common-styles')) return
  const style = doc.createElement('style')
  style.id = 'ui-common-styles'
  style.textContent = `
    .ui-common__window-controls {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
  `
  doc.head.appendChild(style)
}

/**
 * 面板基底（**不含** `panelKit` 原子层）：html/body/#root reset + `#root` 面板底色 +
 * 三档前景重算 + 滚动条。
 *
 * 与 `injectPanelStyles` 分开的理由：薄引导要的是"第一帧不白、不跳"，只需要这一份；
 * 而原子层（`.hp-*`）是面板**内容**的语言，由面板实现自己 `injectPanelStyles(doc)`
 * 或宿主在 boot 后补齐 —— 早注入纯粹是首帧的额外字节。
 *
 * 幂等：id 固定为 `ui-common-panel-styles`，与完整版共用同一个 id
 * （谁先注入都一样，后到的直接跳过，绝不会出现两份 reset 叠加）。
 *
 * @param {Document} doc
 */
export function injectPanelBaseStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById('ui-common-panel-styles')) return
  const style = doc.createElement('style')
  style.id = 'ui-common-panel-styles'
  style.textContent = `
    html, body, #root {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: var(--main-bg-color, #f9fafb);
      color: var(--hira-text-primary, #1a1a1a);
      /* 字体栈走唯一令牌（shared-types/theme.mjs#UI_FONT_STACK）；
         兜底串与它同值 —— 面板是独立视图，首帧可能还没拿到主题令牌。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 12px;
      -webkit-font-smoothing: antialiased;
    }
    /* ── 面板自己那一层遮罩（主题的「面板遮罩不透明度」落在**这里**）────────────
       面板是**独立 WebContentsView**，盖在外壳内容洞之上：它底下那一层是外壳铺的
       chrome 玻璃（--hira-chrome-bg，见 app-shell 的分片规则）。于是
       「面板遮罩不透明度」= 在**那一层之上再叠一层**（面板要读内容 → 默认更实）：
       0% = 与工具栏同厚，100% = 完全挡实 —— 拉到哪一格就是哪一格，与编辑器一致。

       ⚠ **本层刻意没有自己的 backdrop-filter**：「backdrop-filter」只作用于**同一份
       文档**内的背景，而面板背后是**另一条原生视图**（外壳），跨视图拿不到任何东西
       —— 写了也不会糊（主题里曾经有过一根「面板毛玻璃」，就是这个空转的旋钮，已删）。
       面板的毛玻璃观感来自**它下面那层外壳 UI 玻璃**：那层由「--hira-ui-blur」
       =「UI 模糊」旋钮控制，一处调、面板与工具栏一起变。
       更要紧的是：给一个透明视图挂「backdrop-filter」，它就会去求解一份**说不清来自
       哪儿**的 backdrop —— 拿不到外壳那层，却可能随别的图层变化被重新解析
       （用户实测到过："hover 预览卡的阴影一动，面板的背景就跟着变色"）。
       这类既没收益又不可预测的渲染路径，这里不写。

       只铺在 #root 上（**不是** html/body/#root 三处都铺）：半透明色铺三层会**逐层
       叠加**（0.55 三层 ≈ 0.91）—— 这正是"面板比工具栏实得多"那类深浅不一的老坑。
       html/body 保持 --main-bg-color（带壁纸时 = transparent），于是本层是唯一一层。 */
    #root {
      background: var(--hira-panel-bg, var(--main-bg-color, #f9fafb));
      /* ── 面板的**独立前景**（主题 colors.panelFg）落在**这里** ────────────────
         面板里的字与图标原本吃的是 UI 前景（--hira-text-primary = chromeFg）。
         在**子树根**上把三档文字色重算成"面板前景"那一组 —— 一处声明，
         整棵面板子树（含下载/历史/书签里那些**共享组件**）一起跟上，不必逐个组件去接。

         为什么三档一起重算：只改主文字的话，设了面板前景之后"次要/辅助文字"
         会半截留在旧色上（深色面板配浅色前景时那几行就看不见了）——
         面板前景这一次调的就是"面板里所有文字的底色"，要跟就三档一起跟。
         两档派生值由主题令牌给（--hira-panel-fg-soft / -muted）：作者**没设**面板前景时
         它们就是主题原本的 textSoft / textMuted ⇒ 默认逐字不变。 */
      --hira-text-primary: var(--hira-panel-fg);
      --hira-text-secondary: var(--hira-panel-fg-soft);
      --hira-text-tertiary: var(--hira-panel-fg-muted);
      --text-color: var(--hira-panel-fg);
      color: var(--hira-panel-fg);
    }
    * { box-sizing: border-box; }
    button { font-family: inherit; }
    button:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.05)); }
    button:active { background: var(--hira-hover-bg, rgba(0,0,0,0.08)); }
    /* 滚动条：2px 的呼吸缝 + 悬浮才显形的细拇指 —— 面板很窄，粗滚动条会占掉内容宽 */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--hira-text-tertiary, #9ca3af) 42%, transparent);
      border: 2px solid transparent; background-clip: content-box; border-radius: 999px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: color-mix(in srgb, var(--hira-text-secondary, #6b7280) 58%, transparent);
      border: 2px solid transparent; background-clip: content-box;
    }
    /* 焦点样式统一交给原子层（.hp-*）与各面板自己的字段规则 ——
       这里不再写 border-color !important：那会把面板自绘的聚焦环叠成两层。 */

    /* ── 等待骨架（薄引导给内容区打上 .panel-booting，宿主挂载完成时撤掉）─────────
       面板"关闭即销毁"，重开时实现模块要先求值再 mount。这段空档用户看到的是
       "点了没反应"。骨架**刻意延迟 200ms 才淡入**：快路径上 mount 先到，用户从
       头到尾只看见面板本身（不存在"闪一下骨架"的廉价感）；确实要等时才有反馈。

       只动 opacity（合成器线程，不触发布局/重绘）—— 骨架本身绝不能变成新的卡顿源。
       三行灰条对应面板最普遍的形态（标题 / 分组 / 行），高度与 panelKit 的行距对齐。 */
    .panel-booting { position: relative; }
    .panel-booting::after {
      content: '';
      position: absolute;
      left: 0; right: 0; top: 8px;
      height: 96px;
      pointer-events: none;
      opacity: 0;
      border-radius: var(--hira-radius-sm, 8px);
      --hira-skeleton-fill: color-mix(in srgb, var(--hira-text-tertiary, #9ca3af) 16%, transparent);
      background-repeat: no-repeat;
      background-image:
        linear-gradient(var(--hira-skeleton-fill), var(--hira-skeleton-fill)),
        linear-gradient(var(--hira-skeleton-fill), var(--hira-skeleton-fill)),
        linear-gradient(var(--hira-skeleton-fill), var(--hira-skeleton-fill)),
        linear-gradient(var(--hira-skeleton-fill), var(--hira-skeleton-fill));
      background-size: 38% 10px, 100% 14px, 74% 14px, 52% 14px;
      background-position: 0 0, 0 24px, 0 48px, 0 72px;
      animation: hira-panel-skeleton 1.5s ease-in-out 200ms infinite;
    }
    @keyframes hira-panel-skeleton {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 0.85; }
    }
    /* 尊重"减少动态效果"：骨架改为常显，不闪。 */
    @media (prefers-reduced-motion: reduce) {
      .panel-booting::after { animation: none; opacity: 0.5; }
    }
  `
  doc.head.appendChild(style)
}

/**
 * 模态浮层拖拽让位规则（幂等注入）。
 *
 * 为什么是「最深的元素决定命中」还不够：`-webkit-app-region` 是 Chromium 按**整个窗口**
 * 合并所有 WebContentsView 的 drag 命中区 —— 铺满整窗的模态浮层（空间菜单 / 按钮编辑）
 * 盖在下层标题栏的 drag 区之上时，窗口仍把那块当作拖动标题栏，点击根本到不了浮层。
 * 浮层无法「覆盖」drag，只能让下层整体放弃。
 *
 * `!important` 不可省：各图层的 drag 是**内联样式**（createPanelShell / ui-navbar /
 * ui-tabbar / ui-taskoverlay 都写在 style.cssText 上），作者样式表只有在 !important
 * 下才压得过内联声明。
 */
function injectOverlayDragStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById('ui-common-overlay-drag-styles')) return
  const style = doc.createElement('style')
  style.id = 'ui-common-overlay-drag-styles'
  style.textContent = `
    html.hira-overlay-modal,
    html.hira-overlay-modal * {
      -webkit-app-region: no-drag !important;
    }
  `
  doc.head.appendChild(style)
}

/**
 * 模态浮层（空间菜单 / 按钮编辑）开合时，让**本视图**的 chrome 拖拽区整体让位。
 *
 * 由主进程的 `overlay:modal` 广播驱动（见 window-chrome#broadcastModalState），
 * ui-shell / rail / panel 宿主三种 chrome 图层各接一行即可 —— 它们都是独立的
 * WebContentsView，必须各自放弃自己的 drag 区，少一个就会留下「点不动」的洞。
 *
 * @param {Document} doc
 * @param {boolean} suppressed
 */
export function setOverlayDragSuppressed(doc: Document, suppressed: boolean): void {
  if (!doc || !doc.documentElement) return
  injectOverlayDragStyles(doc)
  doc.documentElement.classList.toggle('hira-overlay-modal', !!suppressed)
}

/**
 * 面板骨架 = 标题栏（含拖拽区 + 关闭按钮）+ 内容区。
 * 与 ui-navbar / ui-tabbar 同构：哑结构 + 单一意图下行（onClose）。
 *
 * @param {Document} doc
 * @param {string} title
 * @param {{
 *   onClose?: () => void,
 *   panelId?: string,
 *   icon?: string,
 *   pin?: { pinned?: boolean, onToggle?: () => void },
 *   decorateHeader?: (descriptor: { panelId: string, title: string, titleElement: Element|null, className: string }) => unknown
 * }} [opts]
 *   `decorateHeader` 是**头部渲染插槽**（官方插槽 `side-panel.panel-header-renderer`，
 *   MODE=REDUCE）的落点。本函数不认识插件系统：宿主把「怎么调插件」做成一个纯函数
 *   注入进来，这里只负责把描述符交出去、再按返回结果渲染 —— ui 包对插件零知识。
 * @returns {{ shell: HTMLDivElement, content: HTMLDivElement, header: HTMLDivElement, actions: HTMLDivElement, closeBtn: HTMLButtonElement, pinBtn: HTMLButtonElement|null, setPinned: (pinned: boolean) => void, onPinnedChange: (fn: (pinned: boolean) => void) => () => void, updateHeader: (final: object) => void }}
 *   `updateHeader` 把一份**已经归约过的**头部描述符重新落到标题格上。
 *   存在的理由：插槽的实现是**异步装配**的（插件渲染模块要先加载），而壳必须第一帧就出来 ——
 *   于是宿主先用已知标题画壳，等插槽就绪再调一次 `updateHeader`，而不是让首帧押在一次 IPC 上。
 */
export function createPanelShell(
  doc: Document,
  title: string,
  opts: PanelShellOptions = {}
): PanelShellController {
  const shell = doc.createElement('div')
  shell.style.cssText = `
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--main-bg-color, #f9fafb);
    color: var(--hira-text-primary, #1a1a1a);
    contain: strict;
  `

  const header = doc.createElement('div')
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--hira-panel-header-height, 46px);
    padding: 0 8px 0 var(--hira-panel-pad-x, 14px);
    /* 不再画分隔线：面板靠**留白**分层，一条横线就是用户说的"多余条条框框"。
       滚动时内容会从标题下缘穿过，标题栏的留白本身已经把它隔开了。 */
    -webkit-app-region: drag;
    flex-shrink: 0;
  `

  /**
   * 头部描述符（REDUCE 累加器）。
   *
   * 为什么是"描述符累加"而不是"让插件直接往 header 里塞节点"：
   *   · 标题那一格是**布局**的一部分（`margin-left:auto` 的按钮区要靠它撑出剩余空间），
   *     插件随手 append 会把自己排在关闭按钮**之后**，看起来像多了一个按钮；
   *   · 描述符把可改的东西收成三个字段（文案 / 自己的节点 / 类名），
   *     改哪一处、会落在哪一格是确定的，插件作者不需要读宿主的 DOM 结构。
   */
  const descriptor: PanelHeaderDescriptor = {
    panelId: String(opts.panelId || ''),
    title: String(title ?? ''),
    titleElement: null,
    className: ''
  }
  let final: PanelHeaderDescriptor = descriptor
  if (typeof opts.decorateHeader === 'function') {
    const out = opts.decorateHeader(descriptor)
    if (out && typeof out === 'object') final = out
  }

  const titleEl = doc.createElement('div')
  titleEl.style.cssText = `
    flex: 1; min-width: 0;
    font-size: 13px; font-weight: 400; line-height: 18px; letter-spacing: -0.005em;
    color: var(--hira-text-primary, #1a1a1a);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  `

  /**
   * 把一份（已归约的）头部描述符落到标题格。
   *
   * 独立成函数是为了**可重复应用**：插槽实现由插件渲染模块注册，而那些模块是异步加载的 ——
   * 壳可以先画，等 `activateRendererSlots` 完成后宿主再调 `updateHeader()` 套一次。
   * 这样「面板打开即见壳」与「插件能改写标题」不再互相等待。
   */
  function applyHeader(value: Partial<PanelHeaderDescriptor>): void {
    const src = value && typeof value === 'object' ? value : {}
    titleEl.className = typeof src.className === 'string' ? src.className : ''
    // 元素优先于文案：插件要么给节点（完全自定义），要么只改文字，二选一。
    // 给了节点却渲染成空是最坏的结果（标题栏整块消失），所以这里显式判 nodeType。
    if (src.titleElement && src.titleElement.nodeType === 1) {
      titleEl.textContent = ''
      titleEl.appendChild(src.titleElement)
    } else {
      titleEl.textContent = String(src.title ?? descriptor.title ?? '')
    }
  }
  applyHeader(final)
  /**
   * 标题图标（可选）：目录里给的面板图标。**只有名字、没有节点** ——
   * 壳不认识任何面板，字形来自与 navbar / rail 同一份 ICON_REGISTRY。
   *
   * 走 `resolveIcon` 而不是查表：插件 manifest 的 `icon` 是自由字符串，
   * 名字大小写 / 连字符 / data URL / 原始 SVG 都可能出现；认不出来时回落 Puzzle，
   * 不会出现"标题左边空一格"。`fallback:false` 保留"完全没写图标就不占位"的语义。
   */
  const titleIcon = opts.icon ? resolveIcon(opts.icon, doc, { size: 16, fallback: false }) : null
  if (titleIcon) {
    const box = doc.createElement('span')
    box.style.cssText = 'display:flex; align-items:center; justify-content:center; flex-shrink:0; width:18px; height:18px; color: var(--hira-text-secondary, #6b7280);'
    box.appendChild(titleIcon)
    header.appendChild(box)
  }
  header.appendChild(titleEl)

  /**
   * 工具栏插槽容器（`side-panel.toolbar-action-slot` 的落点）。
   *
   * `margin-left: auto` 承担了「把右侧按钮区推到最右」的职责 —— 原先靠父级的
   * `justify-content: space-between` 实现，但那是**两个**孩子时的取巧；一旦中间插入
   * 这个容器，space-between 会把三块摊开（标题、按钮、关闭）散到四处。
   * 改用 auto margin 后：容器为空时视觉与改动前**逐像素一致**，
   * 容器有内容时按钮紧贴关闭按钮左侧 —— 正是工具栏该在的位置。
   */
  const actions = doc.createElement('div')
  actions.style.cssText = 'margin-left: auto; display: flex; align-items: center; gap: 4px; flex-shrink: 0; -webkit-app-region: no-drag;'
  header.appendChild(actions)

  /**
   * 图钉（固定面板）—— 关闭键**左侧**的那一颗。
   *
   * 语义由宿主定义（ui 包对"面板位 / 钉住位"零知识）：这里只画一个可切换的图标键，
   * 状态由 `setPinned(bool)` 从外部（主进程的真值）灌进来 —— 不做乐观切换，
   * 免得主进程拒绝时按钮自己先亮起来。
   *
   * `opts.pin` 不给就整颗不渲染（独立窗口 / 非面板宿主的壳保持原样，一字不变）。
   */
  let pinBtn: HTMLButtonElement | null = null
  /**
   * 钉住状态的监听者（宿主用）。
   *
   * 为什么壳要往外发：图钉的**点击回执**直接回到本文件（`onToggle` 的 Promise），
   * 而"宽度按哪个槽读写"是宿主的事 —— 宿主不必为这一个字段再走一次 IPC / 事件往返，
   * 壳把最终状态原样转告即可（`setPinned` 是唯一入口，点击与外部推送都汇到这里）。
   */
  const pinListeners = new Set<(pinned: boolean) => void>()
  /** 已落地的钉住状态（null = 还没落过；用于去重，避免同一状态重复通知）。 */
  let pinnedState: boolean | null = null
  const applyPinned = (pinned: boolean): void => {
    const on = !!pinned
    if (on === pinnedState) return
    pinnedState = on
    if (pinBtn) {
      pinBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
      pinBtn.title = on ? '已固定：切换面板时保持不变' : '固定面板（切换时不被替换）'
      pinBtn.style.background = on ? 'var(--hira-accent-soft, rgba(59,130,246,0.14))' : 'transparent'
      pinBtn.style.color = on ? 'var(--hira-accent, #3b82f6)' : 'var(--hira-text-secondary, #6b7280)'
    }
    for (const fn of pinListeners) {
      try { fn(on) } catch (_) {}
    }
  }
  const pin = opts.pin
  if (pin && typeof pin.onToggle === 'function') {
    pinBtn = doc.createElement('button')
    pinBtn.type = 'button'
    pinBtn.setAttribute('aria-label', '固定面板')
    pinBtn.style.cssText = `
      width: 28px; height: 28px; border: none; background: transparent;
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      border-radius: var(--hira-radius-sm, 8px);
      -webkit-app-region: no-drag;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    `
    const pinIcon = iconByName('Pin', doc, { size: 14 })
    if (pinIcon) pinBtn.appendChild(pinIcon)
    const button = pinBtn
    button.addEventListener('mouseenter', () => {
      if (button.getAttribute('aria-pressed') === 'true') return
      button.style.background = 'var(--hira-surface-soft, rgba(0,0,0,0.04))'
      button.style.color = 'var(--hira-text-primary, #1a1a1a)'
    })
    button.addEventListener('mouseleave', () => {
      if (button.getAttribute('aria-pressed') === 'true') return
      button.style.background = 'transparent'
      button.style.color = 'var(--hira-text-secondary, #6b7280)'
    })
    button.addEventListener('click', () => { pin.onToggle?.() })
    header.appendChild(button)
    applyPinned(pin.pinned === true)
  }

  const closeBtn = doc.createElement('button')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', '关闭面板')
  closeBtn.textContent = '✕'
  closeBtn.style.cssText = `
    width: 28px; height: 28px; border: none; background: transparent;
    color: var(--hira-text-secondary, #6b7280); cursor: pointer;
    border-radius: var(--hira-radius-sm, 8px); font-size: 12px;
    -webkit-app-region: no-drag;
    display: flex; align-items: center; justify-content: center;
    transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  `
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = 'var(--hira-surface-soft, rgba(0,0,0,0.04))'
    closeBtn.style.color = 'var(--hira-text-primary, #1a1a1a)'
  })
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = 'transparent'
    closeBtn.style.color = 'var(--hira-text-secondary, #6b7280)'
  })
  if (typeof opts.onClose === 'function') {
    closeBtn.addEventListener('click', opts.onClose)
  }
  header.appendChild(closeBtn)

  const content = doc.createElement('div')
  content.style.cssText = `
    flex: 1; min-height: 0;
    overflow-y: auto; overscroll-behavior: contain;
    /* 四周留白统一走面板节奏令牌：内容不贴边、末尾留一口气（最后一行
       不该压在视图下缘上）。 */
    padding: var(--hira-panel-pad-top, 6px) var(--hira-panel-pad-x, 14px)
             var(--hira-panel-pad-bottom, 20px);
    contain: content;
  `

  shell.appendChild(header)
  shell.appendChild(content)
  /** 订阅钉住状态（只在**状态确实变化**时回调）。返回退订函数。 */
  function onPinnedChange(fn: (pinned: boolean) => void): () => void {
    if (typeof fn !== 'function') return () => {}
    pinListeners.add(fn)
    return () => { pinListeners.delete(fn) }
  }

  return {
    shell, content, header, actions, closeBtn, pinBtn,
    setPinned: applyPinned,
    onPinnedChange,
    updateHeader: applyHeader
  }
}
