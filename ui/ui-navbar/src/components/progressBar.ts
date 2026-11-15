/**
 * 加载进度条 —— 贴在导航栏底边的一条不确定进度动画。
 *
 * 只是一个哑显示件：`setLoading(bool)` 进 / 出，自身不知道任何加载事件（由编排层驱动）。
 * 贴工具栏底边而不是窗口底边：工具栏在底部布局时它自然落在窗口底缘（块自己不需要知道
 * 自己在哪个区域 —— 这正是块级契约的用意）。
 */

export const PROGRESS_BAR_CSS = `
    #progress-bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: transparent;
      z-index: var(--hira-z-max);
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    #progress-bar.visible {
      opacity: 1;
    }

    #progress-bar .progress-fill {
      height: 100%;
      width: 30%;
      background: var(--hira-accent, #3b82f6);
      /* 动画**只在加载中**存在 —— 见下面的 .visible 规则：这是全库唯一一条 infinite 动画，
         绝不能让它在空闲时也挂着跑。 */
    }

    /* 只有加载中才挂无限动画。
       为什么不能把 infinite 直接写在 .progress-fill 上：那样即使整条 #progress-bar 处于
       opacity:0（当前没在加载），Chromium 也照跑不误 —— opacity 不会暂停 CSS 动画，
       于是这条动画变成"只要窗口开着就每帧都在动"的常驻合成器开销，与是否加载毫无关系。
       挪到这里之后：空闲 = 没有动画（零开销），加载 = 从最左侧从头扫一遍。 */
    #progress-bar.visible .progress-fill {
      animation: progress-indeterminate 1.2s linear infinite;
    }

    @keyframes progress-indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }
`

/**
 * @param {Document} doc
 * @returns {{ element: HTMLElement, setLoading: (loading: boolean) => void }}
 */
export function createProgressBar(doc: Document): {
  element: HTMLElement
  setLoading: (loading: boolean) => void
} {
  const element = doc.createElement('div')
  element.id = 'progress-bar'
  const fill = doc.createElement('div')
  fill.className = 'progress-fill'
  element.appendChild(fill)

  return {
    element,
    setLoading(loading) {
      element.classList.toggle('visible', !!loading)
    }
  }
}
