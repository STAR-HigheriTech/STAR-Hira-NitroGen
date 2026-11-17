/**
 * 标签 hover 预览浮层（横向标签条这一侧）。
 *
 * 「什么时候该显、什么时候收起」**不在这里**：那套状态机（700ms 延迟 / 320ms 重挂窗口 /
 * 项间缝隙的延迟收起 / 按下别处即收 / 锚点消失即收并锁到指针动过）是横竖两种模式**共用**的，住在
 * `@hira-ng/ui-common#hoverPreview`（七条规则写在那个文件头）。本文件只回答两件事：
 *   1. 锚点是谁 —— 标签节点（`show(anchorEl, tab)`）；
 *   2. 显示什么 —— 把锚点矩形 + 标签数据交给浮层通道（摆放由落位真源算，见
 *      `@hira-ng/shared-types/src/preview-placement.mjs`）。
 * 连"按下别处就收起"（规则 ⑤）与"锚点消失即收"（规则 ⑥）那两条 `document` 监听
 * 也在状态机里 —— 本文件一行事件都不挂。
 *
 * 边界：组件层不碰 IPC（`overlay` 是注入的端口），也不认识"预览卡片长什么样"。
 */

import { createHoverPreview, tabPreviewFacts } from '@hira-ng/ui-common'
import type {
  TabPreviewController,
  TabPreviewOverlayPort,
  TabViewState
} from '../types.js'

/**
 * @param {Document} doc
 * @param {TabPreviewOverlayPort} [overlay]
 */
function createTabPreview(doc: Document, overlay?: TabPreviewOverlayPort): TabPreviewController {
  const hover = createHoverPreview({
    // document 交给状态机 → 「按下别处即收起」这条兜底由 hoverPreview 的规则 ⑤ 统一负责，
    // 不再在这里手写一遍（此前只有横向标签条有、纵向列表与固定网格三处全缺，
    // 于是"点别处不收起"这个 bug 只修了五分之一）。理由见 hoverPreview.ts 文件头 ⑤。
    document: doc,
    // 意图预热：预览是独立 WebContentsView（闲置会被主进程回收），冷启动的几百毫秒
    // 正好被 700ms 停留延迟盖住 —— 指针一开始等，后台就把 renderer 载起来。
    onIntent() {
      if (overlay && typeof overlay.warmTabPreview === 'function') {
        try { overlay.warmTabPreview() } catch (_) {}
      }
    },
    onShow(anchor: HTMLElement, tab: TabViewState) { doShow(anchor, tab) },
    onHide() {
      if (overlay && typeof overlay.hideTabPreview === 'function') overlay.hideTabPreview()
    }
  })

  /** 把「锚点矩形 + 标签数据」交出去（浮层按落位真源摆，本层不做坐标算术）。 */
  function doShow(anchor: HTMLElement, tab: TabViewState) {
    if (!overlay || typeof overlay.showTabPreview !== 'function') return
    // 载荷形状与纵向列表**共用一份**（ui-common#tabPreviewFacts，含 title 的兜底规则）。
    // 返回 null = 锚点已脱离文档 / 还没挂到窗口上（矩形 0×0）——
    // 那时预览会"凭空出现在窗口左上角"，故放弃本次显示。
    const facts = tabPreviewFacts({
      anchorEl: anchor,
      tab,
      // 标签条容器（#tabs）：它**刻意比标签高**（`align-self: stretch`，给标签组下划线
      // 留出一条凹槽），而那条槽仍属标签条、仍参与 hover 判定。浮层必须让到它的下缘，
      // 否则指针一进槽就落到浮层上、标签的 mouseout 拿不到 relatedTarget →
      // 判成"离开标签条"→ 收起 → 再显示 —— 即「靠标签条下缘 hover 一直跳」。
      stripEl: anchor.closest('#tabs') as HTMLElement | null
    })
    if (!facts) { hover.hide(); return }
    overlay.showTabPreview(facts)
  }

  return {
    /** 鼠标进入某条标签（锚点元素 + 标签数据）。行为见 hoverPreview 的七条规则。 */
    show: (anchor: HTMLElement, tab: TabViewState) => hover.enter(anchor, tab),
    hide: () => hover.hide(),
    suspend: () => hover.suspend(),
    resume: () => hover.resume(),
    /**
     * 该标签**已从列表里消失**（关闭 / 移动到别的窗口）→ 走状态机的规则 ⑥。
     *
     * 为什么不是 `hide()`：关标签会让相邻标签在**指针没动**的情况下滑到指针底下，
     * Chromium 为它补发的 mouseover 会被规则 ②③ 当成一次新的 hover，预览当场
     * 又弹出来 —— 用户看到的就是"关掉这个标签，预览还卡着"。`invalidate()` 既收起、
     * 又锁到指针真的动过为止（见 hoverPreview.ts 文件头 ⑥）。
     */
    hideIfTab(tabId: string) {
      const tab = hover.currentPayload()
      if (tabId == null || !tab) return
      if (String(tab.tabId) === String(tabId)) hover.invalidate()
    },
    destroy() {
      hover.dispose()
    }
  }
}

export { createTabPreview }
