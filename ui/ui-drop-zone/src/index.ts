// @ts-check
/**
 * @hira-ng/ui-drop-zone —— 「拖标签到网页」的**落位预览块**（半透明块 + 方向箭头 + 文案）
 *
 * ── 它画在哪 ────────────────────────────────────────────────────────
 * 它住在一个**独立 WebContentsView** 里（`dropzone-overlay`，见 apps 的
 * renderer/dropzone-overlay/）。为什么不画在外壳 DOM：网页是原生 `WebContentsView`，
 * 外壳（chrome）天然位于它**之下** —— DOM 里画不出任何压得住网页的东西。
 * 所以"浮在网页上"的预览只能是一层独立浮层（与查找栏 / 悬停 URL / 缩放条同族）。
 *
 * ── 分工（与其它 ui 包同一条口径）───────────────────────────────────
 *   · 本模块**只画**：给它一个「落点形态」描述，它把块摆成那个样子；
 *   · **决定落在哪**是纯函数（`shared-types#resolveDropZone`）的事；
 *   · **何时显示 / 显示多大**是主进程的事（视图 bounds 就是预览块矩形本身）。
 *
 * 因此本模块不认识标签、不认识分屏、不认识 IPC —— 吃一个纯数据对象，吐 DOM。
 *
 * ── 为什么"块"就是答案本身 ──────────────────────────────────────────
 * 对照 Zen / Vivaldi（见 docs/tab-drop-zone-design.md）：预览块画的是**新标签将要
 * 占用的那一块**，而不是整片内容区或一个方向箭头。于是"在哪边"由几何直接回答，
 * 用户不需要读文字；松手 = 这块地方被填上，所见即所得。
 * 这里的 view 尺寸就已经是那一块了（主进程按求解器同源算出来），所以本模块只需填满自己。
 *
 * ── 三种形态 ────────────────────────────────────────────────────────
 *   split   —— 落在左/右/上/下，`layout` 给出"左右并排 / 上下并排"
 *   join    —— 落点已在分屏里 → 新标签**加入**那一组（第 N 格），没有方向可言
 *   blocked —— 那一组已满（用户口径 maxPanes）→ 中性灰，明说"放不进去"
 */

import { ArrowLeft } from '@hira-ng/ui-common'

const STYLE_ID = 'hira-drop-zone-styles'

/** 方向 → 箭头旋转角（一个图标转出四个方向，省掉四份 24×24 的 path）。 */
const ARROW_ROTATION = Object.freeze({
  left: '0deg',
  top: '90deg',
  right: '180deg',
  bottom: '-90deg'
})

/** 落点区 → 主文案。文案只此一份（主进程只报 zone，不拼中文）。 */
const ZONE_LABEL = Object.freeze({
  left: '在左侧分屏',
  right: '在右侧分屏',
  top: '在上方分屏',
  bottom: '在下方分屏'
})

const LAYOUT_LABEL = Object.freeze({
  row: '左右并排',
  column: '上下并排'
})

export type DropZoneMode = 'split' | 'join' | 'blocked' | 'cover'
export type SplitDirection = 'left' | 'right' | 'top' | 'bottom'
export type SplitLayout = 'row' | 'column'

export interface DropZoneState {
  mode?: DropZoneMode
  zone?: SplitDirection
  layout?: SplitLayout
  count?: number
  maxPanes?: number
}

export interface DropZonePreview {
  readonly element: HTMLElement
  set(state: DropZoneState): void
  setShown(shown: boolean): void
  isShown(): boolean
  destroy(): void
}

export function injectDropZoneStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /*
     * 块填满自己的视图 —— 视图尺寸**就是**预览块矩形（主进程按分屏求解器同源算出），
     * 所以这里不许有任何留白/外边距：多一个像素，"预览"与"松手结果"就对不上了。
     */
    .hira-dropzone {
      position: fixed;
      inset: 0;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      /* 预览块 = 新网页格将占用的那一块 → 圆角与原生网页视图同一个值（主题圆角）。 */
      border-radius: var(--hira-theme-radius, 9px);
      /* 强调色真源 = 主题下发的 --hira-accent（--accent-color 是同一取值的旧别名）——
         不新造颜色变量，与活动格淡蓝框、分屏徽标同一套。 */
      --hira-dropzone-accent: var(--hira-accent, var(--accent-color, #3b82f6));
      background: color-mix(in srgb, var(--hira-dropzone-accent) 16%, transparent);
      border: 2px solid var(--hira-dropzone-accent);
      color: var(--hira-dropzone-accent);
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      -webkit-font-smoothing: antialiased;
      /* 纯指示层：**永不吃鼠标**（Electron 侧还有一层 setIgnoreMouseEvents 兜底）。
         拖动中的落点判定在发起拖动的那个视图里完成，这里只管被看见。 */
      pointer-events: none;
      opacity: 0;
      /* 只动 opacity/transform —— 合成器上跑，底下网页照常绘制 */
      transition: opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
      contain: strict;
    }
    .hira-dropzone.is-shown { opacity: 1; }

    /* 内容随"块什么时候变大变小"轻微缩放一下 —— 换方向时给一点生命感，
       但幅度很小（0.94 → 1），免得拖动期间晃眼。 */
    .hira-dropzone__inner {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 10px 14px;
      border-radius: var(--hira-theme-radius, 10px);
      background: var(--hira-bg-elevated, rgba(255, 255, 255, 0.86));
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
      transform: scale(0.94);
      transition: transform var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
    }
    .hira-dropzone.is-shown .hira-dropzone__inner { transform: scale(1); }

    .hira-dropzone__arrow {
      display: flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      color: var(--hira-dropzone-accent);
      /* 旋转挂在**这个 div** 上，不挂在 svg 上 —— SVG 元素的 transform-origin 在
         不同内核下的默认基准不一致（view-box / fill-box），转起来可能绕左上角。
         HTML 元素没有这个歧义。 */
      transition: transform var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
    }
    .hira-dropzone__arrow svg { display: block; }

    .hira-dropzone__label {
      font-size: 13px; font-weight: 600; line-height: 18px;
      color: var(--hira-text-primary, #1a1a1a);
      white-space: nowrap;
    }
    .hira-dropzone__hint {
      font-size: 11px; line-height: 15px;
      color: var(--hira-text-secondary, #6b7280);
      white-space: nowrap;
    }

    /* 加入已有分屏：没有方向可言 → 藏箭头，文案说了算。 */
    .hira-dropzone--join .hira-dropzone__arrow { display: none; }
    /* 「整块」形态（侧栏换边的落位预览）：只留半透明块与边框 ——
       那一块就是整个侧栏，没有"分成几格"，箭头与文案都是分屏语汇。 */
    .hira-dropzone--cover .hira-dropzone__inner { display: none; }

    /* 放不进去：整个块转中性灰，并给斜线纹理 —— "这里不行"必须一眼可辨，
       否则用户会以为松手就能生效。 */
    .hira-dropzone--blocked {
      --hira-dropzone-accent: var(--hira-text-secondary, #9ca3af);
      background: repeating-linear-gradient(
        45deg,
        color-mix(in srgb, var(--hira-dropzone-accent) 12%, transparent) 0 6px,
        transparent 6px 12px
      );
      border-style: dashed;
      color: var(--hira-dropzone-accent);
    }

    @media (prefers-reduced-motion: reduce) {
      .hira-dropzone, .hira-dropzone__inner, .hira-dropzone__arrow { transition: none; }
    }
  `
  doc.head.appendChild(style)
}

/** 创建落位预览块。 */
export function createDropZonePreview(doc: Document): DropZonePreview {
  const root = doc.createElement('div')
  root.className = 'hira-dropzone'

  const inner = doc.createElement('div')
  inner.className = 'hira-dropzone__inner'

  const arrow = doc.createElement('div')
  arrow.className = 'hira-dropzone__arrow'
  arrow.appendChild(ArrowLeft(doc, { size: 20, strokeWidth: 2 }))

  const label = doc.createElement('div')
  label.className = 'hira-dropzone__label'

  const hint = doc.createElement('div')
  hint.className = 'hira-dropzone__hint'

  inner.appendChild(arrow)
  inner.appendChild(label)
  inner.appendChild(hint)
  root.appendChild(inner)

  let shown = false

  function set(state: DropZoneState) {
    const s = state || {}
    // 'cover' = **整块形态**（只要半透明块 + 边框，不要箭头与文案）：
    // 侧栏换边的落位预览用它 —— 那一块就是整个侧栏，没有"分成几格"可言，
    // 箭头与 zone 文案都是分屏语汇，套上去就成了误导。
    const mode = s.mode === 'join' || s.mode === 'blocked' || s.mode === 'cover' ? s.mode : 'split'
    const zone: SplitDirection = s.zone && Object.prototype.hasOwnProperty.call(ZONE_LABEL, s.zone) ? s.zone : 'right'
    const layout = s.layout ? LAYOUT_LABEL[s.layout] : ''

    root.classList.toggle('hira-dropzone--join', mode === 'join')
    root.classList.toggle('hira-dropzone--blocked', mode === 'blocked')
    root.classList.toggle('hira-dropzone--cover', mode === 'cover')

    if (mode === 'blocked') {
      const max = Number(s.maxPanes)
      label.textContent = '分屏已满'
      hint.textContent = Number.isFinite(max) && max > 0 ? `最多 ${max} 格` : '放不进去'
    } else if (mode === 'join') {
      const count = Number(s.count)
      label.textContent = '加入当前分屏'
      hint.textContent = Number.isFinite(count) && count > 0 ? `将成为第 ${count + 1} 格` : ''
    } else {
      label.textContent = ZONE_LABEL[zone]
      hint.textContent = layout
    }
    // 箭头只在有方向时有意义：左=不转、上=顺时针 90°、右=180°、下=逆时针 90°
    // （一个 ArrowLeft 转出四个方向，省掉四份 24×24 的 path）。
    arrow.style.transform = `rotate(${ARROW_ROTATION[zone]})`
  }

  function setShown(next: boolean) {
    const on = next === true
    if (on === shown) return
    shown = on
    root.classList.toggle('is-shown', on)
  }

  set({ mode: 'split', zone: 'right', layout: 'row' })

  return {
    element: root,
    set,
    setShown,
    isShown: () => shown,
    destroy() {
      root.remove()
    }
  }
}

/** 浮层宿主用的插件式定义（与其它 ui 包同形，见 ui-zoom-indicator）。 */
export const dropZoneDefinition = {
  id: 'drop-zone',
  injectStyles: injectDropZoneStyles,
  mount(doc: Document) {
    return createDropZonePreview(doc)
  }
}
