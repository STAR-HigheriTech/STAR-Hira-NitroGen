/**
 * 通用动作按钮 —— 外壳里所有「一颗图标按钮」的最小件。
 *
 * 谁在用：导航按钮组（后退/前进/刷新/主页）、rail 开关、面板按钮、新建标签。
 * 为什么单独一个文件：它是**跨部件复用的原子**，不是任何一个部件的私有物 ——
 * 放在谁的家里都会让别家去 import 那个家（一条隐性反向依赖）。
 * 这里只依赖 ui-common 的图标，不认识导航栏、不认识布局。
 *
 * 尺寸/圆角/底色全部走 token，与地址栏、面板按钮、标签条同一套视觉基线。
 */

import type { ActionButtonOptions, IconRenderer } from '../types'

export const ACTION_BUTTON_CSS = `
    .navbar-action-button {
      width: var(--ng-navbar-action-btn-size);
      height: var(--ng-navbar-action-btn-size);
      border-radius: var(--ng-navbar-action-btn-radius);
      border: none;
      background: var(--new-tab-btn-bg-color);
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* 只留 background 一条过渡（原本就有）；按下回弹那一下自带独立的短过渡（见 :active）。
         刻意不把 color / transform 常挂在按钮上：鼠标划过每颗按钮都要维护一条无效过渡，
         而真正需要动画的只有"按下的那一瞬间"。 */
      transition: background 0.15s linear;
      /* 交互控件必须**显式**让出窗口拖拽：外壳里多处容器是 drag 区（标签行 / 导航栏背景），
         不写这一条就要靠「-webkit-app-region 会不会被继承」这条实现细节吃饭。 */
      -webkit-app-region: no-drag;
    }

    .navbar-action-button:hover {
      background: var(--main-btn-bg-color-hover);
    }

    #rail-toggle-button[aria-pressed="true"] {
      color: var(--hira-accent, #3b82f6);
    }

    /* 按下反馈：轻微内缩 + 松开时短促复位。
       缩放幅度只有 0.96（肉眼看得出"按到了"，但不抢视线），复位走 90ms ease ——
       不用回弹曲线：那类过冲缓动会让合成器多跑一段，收益全在观感、开销却实打实。 */
    .navbar-action-button:active:not(:disabled) {
      transform: scale(0.96);
      transition: transform 90ms ease;
    }

    /* 不可用态（如无可后退 / 无可前进）：置灰 + 禁用指针与悬停反馈。
       用真正的 disabled 属性而不是只改样式 —— 语义、键盘可达性、点击拦截全都对。 */
    .navbar-action-button:disabled {
      color: var(--tool-btn-dis-color, rgba(0, 0, 0, 0.32));
      cursor: default;
    }

    .navbar-action-button:disabled:hover {
      background: var(--new-tab-btn-bg-color);
    }

    /* 显隐由 hidden 属性驱动（class 里的 inline-flex 会盖过 UA 的 [hidden]） */
    .navbar-action-button[hidden] {
      display: none;
    }

    /* 图标换形（刷新 ↔ 停止）：只做一次极短的淡入。
       为什么只动 opacity：加 scale/rotate 会让这颗图标走「非整数变换」的合成路径，
       代价明显高于收益 —— 换形本来就发生在一瞬间，纯淡入已经足够说明"这里变了"。 */
    .navbar-action-button .navbar-action-icon-swap {
      animation: navbar-action-icon-in 100ms linear;
    }

    @keyframes navbar-action-icon-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* 系统级「减少动态效果」：全部让位，不做任何动画（含上面两处）。 */
    @media (prefers-reduced-motion: reduce) {
      .navbar-action-button { transition: none; }
      .navbar-action-button:active:not(:disabled) { transform: none; transition: none; }
      .navbar-action-button .navbar-action-icon-swap { animation: none; }
    }
`

/**
 * 造一颗动作按钮。
 * @param {Document} doc
 * @param {{ id?: string, icon?: Function|null, onClick?: Function, title?: string, size?: number }} [opts]
 * @returns {HTMLButtonElement}
 */
export function createActionButton(doc: Document, opts: ActionButtonOptions = {}): HTMLButtonElement {
  const { id, icon, onClick, title, size } = opts
  const b = doc.createElement('button')
  if (id) b.id = id
  b.className = 'navbar-action-button'
  if (title) b.title = title
  if (typeof icon === 'function') {
    b.appendChild(icon(doc, { size: typeof size === 'number' ? size : 18 }))
  }
  if (typeof onClick === 'function') b.addEventListener('click', onClick)
  return b
}

/**
 * 就地换掉按钮的图标（保持同一个按钮元素 —— 顺序 / 显隐 / 引用都不受影响）。
 *
 * 典型用途：刷新键在加载中变成停止键。换形时给新图标挂一次入场关键帧：
 * 动画加在**新**图标上而不是按钮上，所以初始挂载时不会有「一进界面所有按钮都在动」的群魔乱舞。
 *
 * @param {HTMLButtonElement} btn
 * @param {(doc: Document, opts: object) => SVGElement} icon
 * @param {number} [size=18]
 * @param {{ animate?: boolean }} [opts] animate=false 时不播换形动效
 */
export function setActionButtonIcon(
  btn: HTMLButtonElement,
  icon: IconRenderer,
  size: number = 18,
  opts: { animate?: boolean } = {}
): void {
  if (!btn || typeof icon !== 'function') return
  const next = icon(btn.ownerDocument, { size })
  if (opts.animate !== false) next.classList.add('navbar-action-icon-swap')
  // 先摘后挂（不共存）：省掉一次双图标并排的重排，视觉上也无需交叉淡入 —— 新图标自带入场。
  while (btn.firstChild) btn.removeChild(btn.firstChild)
  btn.appendChild(next)
}
