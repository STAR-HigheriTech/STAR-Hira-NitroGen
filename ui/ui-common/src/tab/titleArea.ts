/**
 * 标签行的**标题区** —— 一个容器 + 一行省略号文本。
 *
 * 为什么单独成模块（它看起来只有三行）：标题是**行内编辑器**的宿主。
 * 编辑器会把 `.title` span 换成 input、提交后再换回一个**新的** span，因此
 * 「取标题节点」永远是「此刻查一次」，不能缓存引用 —— 这条约束是这一块
 * 最容易踩的坑，把它连同 setTitle 一起收在这里，坑就只在一个文件里存在。
 */

export function createTabTitleArea(
  doc: Document,
  text?: string,
  opts: { classNames?: { container?: string } } = {}
): {
  element: HTMLDivElement
  setTitle: (text: string) => void
  getTitleEl: () => HTMLElement | null
} {
  const element = doc.createElement('div')
  element.className = (opts.classNames && opts.classNames.container) || 'title-container'

  const title = doc.createElement('span')
  title.className = 'title'
  // 标签视觉状态通过这个稳定锚点同步标题前景色与 favicon 底板，不再依赖各宿主类名。
  title.setAttribute('data-tab-title', '')
  title.textContent = text || ''
  element.appendChild(title)

  return {
    element,
    /**
     * 写入标题。
     * ⚠ 节点复用下必须取「当前」的 .title（见文件头）—— 写死创建期的引用，
     *   标题将永远更新不到。
     */
    setTitle(next: string): void {
      const el = element.querySelector('.title')
      if (el instanceof HTMLElement) el.textContent = next
    },
    getTitleEl: () => element.querySelector<HTMLElement>('.title')
  }
}
