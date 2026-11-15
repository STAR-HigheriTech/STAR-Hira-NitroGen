// @ts-check
/**
 * @hira-ng/ui-titlebar —— 「标题栏」块（哑组件）
 *
 * 只做三件事：
 *   1. 显示当前网页的**站点图标 + 标题**（两者都由编排层灌入，本组件不认识
 *      标签 / 网页 / 窗口状态）；
 *   2. 提供一个宿主槽，供编排层把窗口控制按钮搬进来（宿主选择由摆放计划决定）。
 *
 * 为什么单独一块而不是塞进 navbar：用户要的是「标题栏」可以与标签栏 / 导航栏
 * **并列参与上下与顺序**的独立一块。它与 navbar 零代码关系，才能被独立摆放、
 * 独立开关 —— 这正是「彻底解耦」在布局上最直接的体现。
 */

export interface TitlebarPageInfo {
  title?: unknown
  favicon?: unknown
}

export interface TitlebarController {
  readonly element: HTMLElement
  setPageInfo(info?: TitlebarPageInfo): void
  setControls(element: HTMLElement | null): void
  dispose(): void
}

/** 注入标题栏样式（幂等）。 */
export function injectTitlebarStyles(doc: Document): void {
  if (doc.getElementById('hira-titlebar-styles')) return
  const style = doc.createElement('style')
  style.id = 'hira-titlebar-styles'
  style.textContent = `
    #ui-titlebar {
      display: flex;
      align-items: center;
      width: 100%;
      flex-shrink: 0;
      /* 高度口径与 #navbar-tabbar 完全一致（内容行高 + 顶部系统安全区），
         否则不同布局切换时顶栏总高会跳变、网页 bounds 跟着抖。 */
      height: calc(var(--ng-navbar-top-row-height, 34px) + var(--control-space-top, 0px));
      padding-top: var(--control-space-top, 0px);
      gap: 8px;
      padding-left: var(--control-space-left, 0);
      padding-right: var(--control-space-right, 0);
      /* 与标签栏 / 导航栏同一条窗控贴边契约：按钮簇反向抵消宿主右内边距。 */
      --ng-window-controls-bleed: var(--control-space-right, 0px);
      box-sizing: border-box;
      background: var(--main-bg-color);
      color: inherit;
      -webkit-user-select: none;
      position: relative;
      z-index: var(--hira-z-controls);
      overflow: hidden;
      /* 标题栏自身就是窗口拖拽区：子级交互控件用 no-drag 覆盖回去。 */
      -webkit-app-region: drag;
    }

    /* 图标 + 标题是**一整组居中**的：只有标题居中时，多出来的图标会把文本推偏；
      结成一组后，有图标没图标都看着是「正中」，切换标签不会横向抖一下。 */
    #ui-titlebar .ui-titlebar-main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    /* 站点图标：没有 / 加载失败时 hidden（不占位，文本自然回到正中）。 */
    #ui-titlebar .ui-titlebar-favicon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      border-radius: 3px;
      object-fit: contain;
    }

    #ui-titlebar .ui-titlebar-title {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      opacity: 0.9;
    }

    /* 窗口控制按钮宿主槽：空的时候不占位、也不吃指针。 */
    #ui-titlebar .ui-titlebar-controls {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      -webkit-app-region: no-drag;
    }
    #ui-titlebar .ui-titlebar-controls:empty {
      display: none;
    }
  `
  doc.head.appendChild(style)
}

/** 创建标题栏块。 */
export function createTitlebar(doc: Document): TitlebarController {
  const el = doc.createElement('div')
  el.id = 'ui-titlebar'

  const main = doc.createElement('div')
  main.className = 'ui-titlebar-main'

  const favicon = doc.createElement('img')
  favicon.className = 'ui-titlebar-favicon'
  favicon.alt = ''
  favicon.hidden = true
  // 站点没给图标 / 图标被拦 / URL 失效 → 收起图标槽，不留一个空方块。
  favicon.addEventListener('error', () => { favicon.hidden = true })

  const title = doc.createElement('div')
  title.className = 'ui-titlebar-title'

  main.appendChild(favicon)
  main.appendChild(title)
  const controls = doc.createElement('div')
  controls.className = 'ui-titlebar-controls'

  el.appendChild(main)
  el.appendChild(controls)

  return {
    element: el,

    /** 灌入当前网页的标题与站点图标；空值会同步收起对应槽位。 */
    setPageInfo(info = {}) {
      const src = info || {}
      const text = src.title == null ? '' : String(src.title)
      title.textContent = text
      title.title = text

      const url = src.favicon == null ? '' : String(src.favicon)
      if (!url) {
        favicon.hidden = true
        favicon.removeAttribute('src')
        return
      }
      // 只在真的换了 URL 时改 src：同一个 URL 反复赋值会让 img 重新发起请求（闪一下）。
      if (favicon.getAttribute('src') !== url) favicon.setAttribute('src', url)
      favicon.hidden = false
    },

    /** 挂载 / 摘除窗口控制按钮（搬移而非复制，按钮状态不丢）。 */
    setControls(node) {
      controls.textContent = ''
      if (node) controls.appendChild(node)
    },

    dispose() {
      el.remove()
    }
  }
}
