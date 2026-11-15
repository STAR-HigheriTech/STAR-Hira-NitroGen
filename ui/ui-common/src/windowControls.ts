/**
 * 窗口控制件（哑件）：**通用容器** + **最小化/最大化/关闭三颗按钮的簇**。
 *
 * ── 为什么住在 ui-common ──────────────────────────────────────────────
 * 「窗口控制按钮簇」不是导航栏的私有物：它的宿主是可配的（标签栏 / 导航栏 / 标题栏），
 * 纵排侧栏（垂直标签）里还会落到侧栏底槽 —— 也就是说 **ui-navbar 与 ui-vertical-tabs
 * 两个视图都要画同一簇**，否则同一条侧栏换到另一种预设就会在底行凭空少掉三颗按钮
 * （"看起来完全不是同一条侧栏"）。
 *
 * 两个视图是两个独立入口，所以各自**造一份**；那就必须只有一份"造法"：放在两边都依赖的
 * ui-common 里，而不是让 ui-vertical-tabs 去 import 整个 ui-navbar（那会把它自己的外壳拖进来）。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 * 本模块只管「造出三颗按钮、装进一个横排容器、并把容器**交给谁**」。
 * 至于这一簇该挂在标签栏、导航栏、标题栏还是侧栏槽位，是**布局**的事 ——
 * 由 ui-navbar 的 row/windowControlsPlacement 判定（它掌握宿主轴与侧栏槽位），
 * 本模块只提供一个 placeInto(target) 的落点动作，不认识任何布局概念。
 */

import { CaptionMinimize, CaptionMaximize, CaptionRestore, CaptionClose } from './icons'

export type WindowControlsVariant = 'windows' | 'mac'

export interface WindowControlHandlers {
  onMinimize?: () => void
  onMaximize?: () => void
  onClose?: () => void
}

export interface WindowControlsOptions {
  className?: string
  items?: Node[]
}

export interface WindowControls {
  element: HTMLDivElement
  setItems: (items?: Node[]) => void
}

export interface WindowControlCluster {
  element: HTMLDivElement
  readonly minBtn: HTMLButtonElement | null
  readonly maxBtn: HTMLButtonElement | null
  placeInto: (target: Node | null, at?: 'start' | 'end') => void
  setVariant: (next: WindowControlsVariant) => void
  setMaximized: (next: boolean) => void
}

interface WindowControlButtonSet {
  min: HTMLButtonElement | null
  max: HTMLButtonElement | null
  close: HTMLButtonElement | null
}

/** 通用容器（一簇横排按钮的外壳；`className` 由调用方给）。 */
export function createWindowControls(
  doc: Document,
  options: WindowControlsOptions = {}
): WindowControls {
  const el = doc.createElement('div')
  el.className = ['ui-common__window-controls', options.className].filter(Boolean).join(' ')

  function setItems(items: Node[] = []): void {
    el.textContent = ''
    for (const item of items) {
      if (!item) continue
      el.appendChild(item)
    }
  }

  setItems(options.items || [])

  return { element: el, setItems }
}

export const WINDOW_CONTROLS_CSS = `
    /* 窗口控制按钮组（最小化 / 最大化 / 关闭）的容器 */
    .navbar-top-right-actions {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    /**
     * Windows 标题栏按钮 —— 尺寸/颜色/过渡都对齐 Windows 11 原生（也即 Hira 的
     * css/windowControls.css）：
     *   · 46px 宽（Windows 的标题栏按钮就是 46×32 那一档），**直角**（border-radius: 0）。
     *     圆角是这里最容易"一眼不像"的地方 —— 原生标题栏按钮从不画圆角胶囊。
     *   · 高度吃宿主行高：悬停底色必须**铺满整行高度**（原生就是这样），
     *     写死某个数会在不同行高的宿主里露出一截没盖住的底边。
     *   · 只过渡 background-color（0.2s linear）：原生标题栏没有位移/缩放反馈。
     */
    .window-control-btn {
      width: 46px;
      height: var(--ng-navbar-top-row-height, 34px);
      border: none;
      border-radius: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      -webkit-app-region: no-drag;
      flex-shrink: 0;
      transition: background-color 0.2s linear;
    }
    .window-control-btn:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.1));
    }
    /* 关闭键的悬停红是 Windows 规定色，不跟随主题（它必须永远是那个 #e81123）。 */
    .window-control-btn.close-btn:hover {
      background: #e81123;
      color: #fff;
    }
    /* 字形按 1:1 画出（12 单位 = 12px，无 viewBox）—— 见 icons.js#createCaptionSvg。
       这里不再给 svg 定尺寸，任何缩放都会把整数坐标变成分数坐标、重新引入模糊。 */
    .window-control-btn svg {
      display: block;
    }
    /**
     * hidden 必须**真的藏得住**。
     *
     * ⚠ 这是个静默失效的坑：上面 .window-control-btn 写了 display: inline-flex
     * （**作者**样式），而 UA 样式表里的 [hidden] { display: none } 与它**同特异度** ——
     * 按层叠顺序，作者样式一律胜过 UA 样式，于是 btn.hidden = true 对这类按钮
     * **完全无效**：该只亮"关闭"的窗口（书签编辑器 minimizable:false、小窗预览
     * maximizable:false）照样三颗全亮。
     *
     * 这条用 (0,2,0) 的选择器把 display 拉回来 —— 不靠 !important，
     * 也不需要每个宿主各写一遍：可见性是本簇自己的契约。
     *
     * ⚠ 本文件的样式是**模板字符串**，注释里不能出现反引号，否则会提前闭合字符串。
     */
    .window-control-btn[hidden],
    .window-controls--mac .traffic-light[hidden] {
      display: none;
    }

    /* ══════════════════════════════════════════════════════════════════
       macOS 红绿灯 —— 窗口控制按钮落在**侧栏顶行**（窗口左上角、空间切换器
       左边）时启用的另一套外观。与 Hira css/windowControls.css 同源：
       13px 圆点、间距 9px、悬停放大 1.08 + 一圈柔和光晕、按下缩到 0.9。
       顺序固定 **关闭 / 最小化 / 最大化**（macOS 排列，与 Windows 正好相反）。
       ══════════════════════════════════════════════════════════════════ */
    /* ══════════════════════════════════════════════════════════════════
       变体差异：**贴边与间距**。

       · Windows 标题栏按钮：**贴住窗口角**，三颗之间**没有缝** —— 原生就是这样
         （46px 连着排，悬停底色是连成一片的）。任何间距/内边距都会让它看起来像
         "浮在角落的一块方块"，而不是标题栏本身。
       · macOS 红绿灯：间距 9px（原生/ Hira 都是分开的圆点），不贴边。

       贴边怎么抵消：宿主行左右各有内边距（标签行用 --control-space-*、
       导航栏行用 --ng-navbar-bottom-row-padding-x），按钮因此离窗口边 8px。
       本模块**不认识**任何具体宿主 —— 由宿主自己声明"我这一侧留了多少"
       （--ng-window-controls-bleed，缺省 0 = 不抵消），这里只按它反向抵消。
       于是新宿主只需给一个数，不必回来改选择器；宿主改了内边距也不会漏改这里。

       选择器写成 .ui-common__window-controls.window-controls--*（两个类）是**刻意**的：
       基类的 gap: 6px 在 injectCommonStyles 里，与本文件是两张表、注入顺序不保证，
       (0,1,0) 打不过它 —— 两个类提到 (0,2,0)，与顺序无关。
       ══════════════════════════════════════════════════════════════════ */
    .ui-common__window-controls.window-controls--windows {
      gap: 0;
      margin-right: calc(var(--ng-window-controls-bleed, 0px) * -1);
    }
    .ui-common__window-controls.window-controls--mac {
      gap: 9px;
    }

    .window-controls--mac .traffic-light {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: none;
      padding: 0;
      cursor: pointer;
      flex-shrink: 0;
      transition: transform 0.1s linear, box-shadow 0.15s linear;
    }
    .window-controls--mac .traffic-light.close { background-color: #ff5f57; box-shadow: 0 0 0 1px rgba(255, 95, 87, 0.2); }
    .window-controls--mac .traffic-light.minimize { background-color: #ffbd2e; box-shadow: 0 0 0 1px rgba(255, 189, 46, 0.2); }
    .window-controls--mac .traffic-light.maximize { background-color: #28ca42; box-shadow: 0 0 0 1px rgba(40, 202, 66, 0.2); }
    /* 悬停/按下写在**配色之后**：Hira 里 :hover 排在 .close 这些之前，同特异度下
       被后面的基础 ring 覆盖掉，那圈光晕其实从没显示过。这里保留它的颜色与几何、
       只把顺序摆正 —— 悬停时该看到的是光晕，而不是被 ring 顶掉。 */
    .window-controls--mac .traffic-light:hover {
      transform: scale(1.08);
      box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.18);
    }
    .window-controls--mac .traffic-light:active {
      transform: scale(0.9);
    }
`

/**
 * 窗口控制按钮簇 —— 最小化 / 最大化 / 关闭（三颗按钮 + 一个横排容器）。
 *
 * @param {Document} doc
 * @param {{ onMinimize?: Function, onMaximize?: Function, onClose?: Function }} [handlers]
 * @returns {{
 *   element: HTMLElement,
 *   maxBtn: HTMLElement,
 *   placeInto: (target: Node|null, at?: 'start'|'end') => void,
 *   setMaximized: (isMax: boolean) => void
 * }}
 */
export function createWindowControlCluster(
  doc: Document,
  handlers: WindowControlHandlers = {}
): WindowControlCluster {
  /** 容器节点恒为同一个 —— 换变体只换里面的按钮，`placeInto` 的落点与外部引用都不受影响。 */
  const element = createWindowControls(doc, { className: 'navbar-top-right-actions' }).element

  /**
   * 当前变体。两个变体的**按钮节点形态不同**（一个是有图标的方块按钮、一个是纯色圆点），
   * 无法原地改样式复用 —— 只能按变体重建。重建代价可忽略：换变体只在布局切换时发生。
   */
  let variant: WindowControlsVariant = 'windows'
  let isMaximized = false
  /** 当前变体的三颗按钮（重建时整体替换）。 */
  let btn: WindowControlButtonSet = { min: null, max: null, close: null }

  const fire = (name: keyof WindowControlHandlers) => (): void => {
    handlers[name]?.()
  }

  /** Windows 标题栏字形三颗（最小化 / 最大化 / 关闭）。 */
  function makeWindowsButtons(): WindowControlButtonSet {
    const min = doc.createElement('button')
    min.className = 'window-control-btn'
    min.title = '最小化'
    min.setAttribute('aria-label', '最小化')
    min.appendChild(CaptionMinimize(doc))
    min.addEventListener('click', fire('onMinimize'))

    const max = doc.createElement('button')
    max.className = 'window-control-btn'
    max.title = '最大化'
    max.setAttribute('aria-label', '最大化')
    max.appendChild(CaptionMaximize(doc))
    max.addEventListener('click', fire('onMaximize'))

    const close = doc.createElement('button')
    close.className = 'window-control-btn close-btn'
    close.title = '关闭'
    close.setAttribute('aria-label', '关闭')
    close.appendChild(CaptionClose(doc))
    close.addEventListener('click', fire('onClose'))

    return { min, max, close }
  }

  /** macOS 红绿灯三颗（纯色圆点，无字形 —— 与原生一致：字形只在悬停时才出现，Hira 也没画）。 */
  function makeMacButtons(): WindowControlButtonSet {
    const make = (
      kind: 'close' | 'minimize' | 'maximize',
      label: string,
      handler: keyof WindowControlHandlers
    ): HTMLButtonElement => {
      const el = doc.createElement('button')
      el.className = `traffic-light ${kind}`
      el.title = label
      el.setAttribute('aria-label', label)
      el.addEventListener('click', fire(handler))
      return el
    }
    return {
      close: make('close', '关闭', 'onClose'),
      min: make('minimize', '最小化', 'onMinimize'),
      max: make('maximize', '最大化', 'onMaximize')
    }
  }

  /** 把「最大化与否」落到当前变体的那颗按钮上（换变体后也要重新落一次）。 */
  function applyMaximized(): void {
    if (!btn.max) return
    btn.max.title = isMaximized ? '还原' : '最大化'
    btn.max.setAttribute('aria-label', btn.max.title)
    // 只有 Windows 变体会换字形；红绿灯**不换**（原生也不换，圆点恒在），
    // 但提示语仍要跟着变，否则最大化之后悬停还写着"最大化"。
    if (variant === 'windows') {
      btn.max.innerHTML = ''
      btn.max.appendChild(isMaximized ? CaptionRestore(doc) : CaptionMaximize(doc))
    }
  }

  function render(): void {
    const mac = variant === 'mac'
    const nextButtons = mac ? makeMacButtons() : makeWindowsButtons()
    btn = nextButtons
    element.className = [
      'ui-common__window-controls',
      'navbar-top-right-actions',
      mac ? 'window-controls--mac' : 'window-controls--windows'
    ].join(' ')
    // 顺序在**装配处**写死，不靠 CSS 的 order 调换：macOS 是 关闭/最小化/最大化，
    // 与 Windows 正好相反；DOM 顺序本身就是语义（键盘 Tab 与读屏也照它走）。
    element.textContent = ''
    const ordered = mac
      ? [nextButtons.close, nextButtons.min, nextButtons.max]
      : [nextButtons.min, nextButtons.max, nextButtons.close]
    for (const el of ordered) if (el) element.appendChild(el)
    applyMaximized()
  }

  render()

  return {
    element,

    /**
     * 最小化 / 最大化两颗按钮（外部要按**窗口真实能力**显隐它们）。
     * 写成 getter：换变体后拿到的仍是当前那一颗（变体会整体重建按钮节点）。
     * 关闭键不给 —— 任何形态下它都存在，没有需要显隐的场景。
     */
    get minBtn() {
      return btn.min
    },
    get maxBtn() {
      return btn.max
    },

    /**
     * 把这一簇搬到指定宿主（同一个节点搬移，监听与状态不丢）。
     *
     * `at` 是**宿主内**的落点：'end'（缺省）= 宿主末尾；'start' = 宿主最前 ——
     * 侧栏顶行里要插在空间切换器**左边**（空间切换器是后 append 进去的，
     * 故「插在最前」= 它左边），见 ui-navbar#row/windowControlsPlacement。
     * @param {Node|null} target
     * @param {'start'|'end'} [at]
     */
    placeInto(target: Node | null, at?: 'start' | 'end'): void {
      if (!target) return
      if (at === 'start') {
        if (target.firstChild !== element) {
          target.insertBefore(element, target.firstChild)
        }
        return
      }
      if (element.parentNode !== target) target.appendChild(element)
    },

    /**
     * 切换外观变体。
     *
     * `'windows'`（缺省）= Windows 标题栏字形；`'mac'` = macOS 红绿灯。
     * 由**知道自己在哪**的排版方调用（见 ui-navbar#row/windowControlsPlacement：
     * 纵排 = 按钮落在侧栏顶行 = 窗口左上角 → 红绿灯），本模块不认识布局概念。
     * @param {'windows'|'mac'} next
     */
    setVariant(next: WindowControlsVariant): void {
      const v = next === 'mac' ? 'mac' : 'windows'
      if (v === variant) return
      variant = v
      render()
    },

    /**
     * 最大化 / 还原时换字形与提示。
     *
     * 还原用的是 **CaptionRestore（层叠双框）**，不是 X —— 以前拿关闭图标顶替，
     * 最大化后那颗按钮看着像"要关掉窗口"，是这里最明显的一处不对。
     * 两个字形都是 12×12 的 1:1 作画（见 icons.js#createCaptionSvg），
     * 所以这里直接换节点，不需要给尺寸参数。
     */
    setMaximized(next: boolean): void {
      const v = !!next
      if (v === isMaximized) return
      isMaximized = v
      applyMaximized()
    }
  }
}
