// @ts-check
/**
 * @hira-ng/ui-space-switcher —— 空间胶囊（哑组件）
 *
 * ── 只负责「触发器」一件事（图层决定的）─────────────────────────────────
 * 触发器住在 ui-shell（navbar 的 #workspace-switcher），而 ui-shell 就是**窗口本体**
 * （ChromeView 假视图）—— 按 NG 图层约定它天然位于 rail / 面板 / 各浮层**之下**。
 * 因此任何挂在它 DOM 里的下拉都会被 #navbar 的 overflow 裁掉，并始终被 rail 盖住。
 * 下拉本体（现在叫「总览」浮层）住在**自己的浮层图层**（overview-overlay，z 高于 rail），
 * 本组件只报「点了」这一个意图、附上触发器的窗口坐标矩形。
 *
 * 不持状态、不发 IPC、不读 localStorage：数据与意图全部由编排层给。
 * 空间项形状（对齐 RT spaces-controller）：
 *   { id, profileId, name, icon, bgStartColor, bgEndColor }
 */

import { injectCommonStyles } from '@hira-ng/ui-common'

interface SpaceSwitcherItem {
  id: string
  profileId?: string
  name?: string
  bgStartColor?: string
  bgEndColor?: string
}
interface AnchorRect { x: number; y: number; width: number; height: number }
interface SpaceSwitcherHandlers { onToggle?: (anchor: AnchorRect) => void; onIntent?: () => void }
interface SpaceSwitcherController {
  element: HTMLElement
  setSpaces(spaces: readonly SpaceSwitcherItem[] | null | undefined, activeSpaceId?: string | null, profileId?: string | null): void
  getAnchor(): AnchorRect
  dispose(): void
}

const STYLE_ID = 'hira-space-switcher-styles'

export function injectSpaceSwitcherStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectCommonStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #workspace-switcher:empty { display: none; }
    .workspace-switcher-slot { display: contents; }

    .space-switcher {
      position: relative;
      display: flex;
      align-items: center;
      -webkit-app-region: no-drag;
    }

    .space-switcher__trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 168px;
      height: 26px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: var(--hira-radius-sm, 8px);
      background: transparent;
      color: var(--text-color, inherit);
      font: inherit;
      font-size: 12px;
      cursor: default;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .space-switcher__trigger:hover {
      background: var(--hira-hover-bg, rgba(128, 128, 128, 0.12));
      border-color: var(--hira-border-subtle, rgba(128, 128, 128, 0.18));
    }

    .space-switcher__glyph {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      flex-shrink: 0;
      background: linear-gradient(135deg, var(--space-accent-start, #6b7280), var(--space-accent-end, #9ca3af));
    }
    .space-switcher__name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
  `
  doc.head.appendChild(style)
}

/** 取空间强调色（无自定义色时回退到中性灰渐变）。 */
function accentOf(space: SpaceSwitcherItem | null | undefined): { start: string; end: string } {
  const start = space && typeof space.bgStartColor === 'string' && space.bgStartColor ? space.bgStartColor : ''
  const end = space && typeof space.bgEndColor === 'string' && space.bgEndColor ? space.bgEndColor : start
  return { start: start || '#6b7280', end: end || start || '#9ca3af' }
}

/**
 * 触发器（住在 ui-shell / navbar 的 #workspace-switcher）。
 *
 * @param {Document} doc
 * @param {{
 *   onToggle?: (anchor: { x: number, y: number, width: number, height: number }) => void,
 *   onIntent?: () => void
 * }} handlers
 *        onToggle 收到的是触发器在**窗口坐标系**里的矩形（外壳 = 窗口本体，故 client 坐标即窗口坐标）
 *        onIntent 只报「指针已进入触发器」这一件事 —— 组件不认识浮层与 IPC
 * @returns {{ element: HTMLElement, setSpaces: Function, getAnchor: Function, dispose: Function }}
 */
export function createSpaceSwitcher(doc: Document, handlers: SpaceSwitcherHandlers = {}): SpaceSwitcherController {
  const wrap = doc.createElement('div')
  wrap.className = 'space-switcher'

  const trigger = doc.createElement('button')
  trigger.className = 'space-switcher__trigger'
  trigger.type = 'button'
  trigger.title = 'Space'
  const glyph = doc.createElement('span')
  glyph.className = 'space-switcher__glyph'
  const nameEl = doc.createElement('span')
  nameEl.className = 'space-switcher__name'
  trigger.appendChild(glyph)
  trigger.appendChild(nameEl)
  wrap.appendChild(trigger)

  function setSpaces(
    list: readonly SpaceSwitcherItem[] | null | undefined,
    activeSpaceId?: string | null,
    profileId?: string | null
  ): void {
    const spaces = Array.isArray(list) ? list : []
    const activeId = activeSpaceId || ''
    const activeProfileId = profileId || ''
    const current =
      spaces.find((s) => s.id === activeId && (!activeProfileId || s.profileId === activeProfileId)) || spaces[0]
    if (current) {
      const accent = accentOf(current)
      glyph.style.setProperty('--space-accent-start', accent.start)
      glyph.style.setProperty('--space-accent-end', accent.end)
      nameEl.textContent = current.name || current.id
      trigger.title = current.name || current.id
    } else {
      nameEl.textContent = ''
    }
  }

  /** 触发器在**窗口坐标系**里的矩形（外壳 = 窗口本体，故 client 坐标即窗口坐标）。 */
  function getAnchor(): AnchorRect {
    const rect = trigger.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    if (typeof handlers.onToggle === 'function') handlers.onToggle(getAnchor())
  })

  // 意图信号：把「即将打开总览浮层」提前交给编排层去预热浮层 renderer。
  // 指针一进入触发器就算意图（pointerdown 必然晚于 pointerenter，再报一次是多余路径）。
  const onIntent = handlers.onIntent
  if (typeof onIntent === 'function') {
    trigger.addEventListener('pointerenter', () => onIntent())
  }

  return { element: wrap, setSpaces, getAnchor, dispose() {} }
}
