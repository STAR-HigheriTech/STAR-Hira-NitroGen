/** 浮层卡片共享视觉词汇与「点外部收起」判据。 */

export const OverlayCardStyle = Object.freeze({
  cardPadding: '6px',
  cardRadius: 'var(--hira-theme-radius, 10px)',
  cardBorder: '1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1))',
  cardBackground: 'var(--hira-bg-elevated, #fff)',
  cardShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  cardColor: 'var(--hira-text-primary, #1a1a1a)',
  rowGap: '8px',
  rowPadding: '6px 8px',
  rowRadius: 'var(--hira-radius-sm, 8px)',
  rowBorder: '1px solid transparent',
  rowColor: 'var(--text-color, inherit)',
  rowFontSize: '12px',
  rowTransition: 'background 0.12s ease, border-color 0.12s ease',
  rowHoverBackground: 'var(--hira-hover-bg, rgba(128, 128, 128, 0.12))',
  rowHoverBorderColor: 'var(--hira-border-subtle, rgba(128, 128, 128, 0.18))',
  rowLabel: 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
  groupPadding: '6px 8px 4px',
  groupFontSize: '11px',
  groupFontWeight: '600',
  groupLetterSpacing: '0.02em',
  groupColor: 'var(--hira-text-secondary, #6b7280)',
  separatorHeight: '1px',
  separatorMargin: '6px 4px',
  separatorColor: 'var(--hira-border-subtle, rgba(0, 0, 0, 0.08))'
} as const)

/** 注入共享卡片样式；每个浮层文档调用，重复调用无副作用。 */
export function injectOverlayCardStyles(doc: Document): void {
  if (doc.getElementById('hira-overlay-card-styles')) return

  const style = doc.createElement('style')
  style.id = 'hira-overlay-card-styles'
  style.textContent = `
    .hira-overlay-card {
      position: fixed;
      left: 0;
      top: 0;
      box-sizing: border-box;
      border-radius: ${OverlayCardStyle.cardRadius};
      border: ${OverlayCardStyle.cardBorder};
      background: ${OverlayCardStyle.cardBackground};
      box-shadow: ${OverlayCardStyle.cardShadow};
      color: ${OverlayCardStyle.cardColor};
      contain: layout style;
      pointer-events: auto;
    }
    .hira-overlay-scroll {
      overflow-y: auto;
      padding: ${OverlayCardStyle.cardPadding};
    }
    .hira-overlay-group {
      padding: ${OverlayCardStyle.groupPadding};
      font-size: ${OverlayCardStyle.groupFontSize};
      font-weight: ${OverlayCardStyle.groupFontWeight};
      letter-spacing: ${OverlayCardStyle.groupLetterSpacing};
      color: ${OverlayCardStyle.groupColor};
    }
    .hira-overlay-sep {
      flex: 0 0 auto;
      height: ${OverlayCardStyle.separatorHeight};
      margin: ${OverlayCardStyle.separatorMargin};
      background: ${OverlayCardStyle.separatorColor};
    }
    .hira-overlay-row {
      display: flex;
      align-items: center;
      gap: ${OverlayCardStyle.rowGap};
      width: 100%;
      box-sizing: border-box;
      padding: ${OverlayCardStyle.rowPadding};
      border: ${OverlayCardStyle.rowBorder};
      border-radius: ${OverlayCardStyle.rowRadius};
      background: transparent;
      color: ${OverlayCardStyle.rowColor};
      font: inherit;
      font-size: ${OverlayCardStyle.rowFontSize};
      text-align: left;
      cursor: default;
      transition: ${OverlayCardStyle.rowTransition};
    }
    .hira-overlay-row:hover {
      background: ${OverlayCardStyle.rowHoverBackground};
      border-color: ${OverlayCardStyle.rowHoverBorderColor};
    }
    .hira-overlay-label {
      ${OverlayCardStyle.rowLabel}
    }
  `
  doc.head.appendChild(style)
}

export interface OutsideDismissOptions {
  isOpen?: () => boolean
  element?: Element | null
  onDismiss: () => void
  /** 是否把卡片外的滚轮也视为收起信号。 */
  wheel?: boolean
}

/** 捕获铺满整窗的浮层里发生在卡片之外的按下或滚轮。 */
export function dismissOnOutsidePointerDown(
  doc: Document,
  options: OutsideDismissOptions
): () => void {
  const insideCard = (target: EventTarget | null): boolean => {
    const NodeConstructor = doc.defaultView?.Node
    return Boolean(
      options.element &&
      target &&
      NodeConstructor &&
      target instanceof NodeConstructor &&
      options.element.contains(target)
    )
  }
  const isOpen = (): boolean => (typeof options.isOpen === 'function' ? options.isOpen() : true)

  const onPointerDown = (event: MouseEvent): void => {
    if (!isOpen() || insideCard(event.target)) return
    options.onDismiss()
  }
  doc.addEventListener('mousedown', onPointerDown, true)

  let onWheel: ((event: WheelEvent) => void) | null = null
  if (options.wheel) {
    onWheel = (event: WheelEvent): void => {
      if (!isOpen() || insideCard(event.target)) return
      options.onDismiss()
    }
    doc.addEventListener('wheel', onWheel, true)
  }

  return () => {
    doc.removeEventListener('mousedown', onPointerDown, true)
    if (onWheel) doc.removeEventListener('wheel', onWheel, true)
  }
}
