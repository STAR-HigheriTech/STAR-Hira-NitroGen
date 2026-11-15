/**
 * 新标签页 · 轻量浮层原语（picker 与组件设置面板共用）
 *
 * 只解决三件事：挂载位置、贴着锚点定位、点外部/Esc 关闭。
 * 内容由调用方塞进 `panel` —— 本模块不认识任何业务。
 */

let layer: HTMLDivElement | null = null

/** 浮层挂载层（单一容器，所有浮层都在这层里，避免各自 append 到 body 造成层级打架）。 */
function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer
  layer = document.createElement('div')
  layer.className = 'ntp-pop-layer'
  document.body.appendChild(layer)
  return layer
}

const GAP = 8
const MARGIN = 12

/**
 * @param {{ className?:string, onClose?:()=>void }} [opts]
 * @returns {{ panel:HTMLElement, open:(anchor:HTMLElement)=>void, close:()=>void, isOpen:()=>boolean, toggle:(anchor:HTMLElement)=>void, reposition:()=>void }}
 */
export function createPopover(opts: { className?: string; onClose?: () => void } = {}) : { panel:HTMLElement, open:(anchor:HTMLElement)=>void, close:()=>void, isOpen:()=>boolean, toggle:(anchor:HTMLElement)=>void, reposition:()=>void } {
  const panel = document.createElement('div')
  panel.className = 'ntp-pop' + (opts.className ? ' ' + opts.className : '')
  panel.hidden = true
  ensureLayer().appendChild(panel)

  let openFlag = false
  let anchorEl: HTMLElement | null = null

  function place() {
    if (!anchorEl) return
    const a = anchorEl.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    // 默认贴在锚点上方（工具栏在底部）；空间不够就翻到下方
    let top = a.top - p.height - GAP
    if (top < MARGIN) top = Math.min(a.bottom + GAP, window.innerHeight - p.height - MARGIN)
    let left = a.left + a.width / 2 - p.width / 2
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - p.width - MARGIN))
    panel.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.max(MARGIN, top))}px, 0)`
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!openFlag) return
    const target = e.target instanceof Node ? e.target : null
    if (target && panel.contains(target)) return
    if (target && anchorEl?.contains(target)) return
    close()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }

  function onViewportChange() {
    if (openFlag) place()
  }

  function open(anchor: HTMLElement): void {
    anchorEl = anchor
    panel.hidden = false
    if (openFlag) {
      // 已打开时只换锚点/重排，不重复挂监听（否则 close 只能摘掉一份）
      place()
      return
    }
    openFlag = true
    place()
    // 首次定位后再量一次：内容尺寸可能刚被撑开
    requestAnimationFrame(place)
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  }

  /** 内容被替换（例如菜单换成表单）后，尺寸变了要重新贴锚点。 */
  function reposition() {
    if (!openFlag) return
    place()
    requestAnimationFrame(place)
  }

  function close() {
    if (!openFlag) return
    openFlag = false
    panel.hidden = true
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
    if (typeof opts.onClose === 'function') opts.onClose()
  }

  return {
    panel,
    open,
    close,
    isOpen: () => openFlag,
    toggle: (anchor: HTMLElement) => (openFlag ? close() : open(anchor)),
    reposition
  }
}
