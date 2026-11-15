// @ts-check
/**
 * 单条标签（`.tab-item`）—— **装配器**：把四块独立的小件拼成一行，并维护一份
 * 供更新用的「当前态快照」。
 *
 * 每件事都有自己的家（本文件只负责拼与更新）：
 *   tab/iconArea.ts    favicon / 无痕标识 / 音频按钮（三态小状态机）
 *   tab/titleArea.ts   标题容器 + 省略号文本（行内编辑器的宿主）
 *   tab/closeButton.ts 关闭按钮（吃冒泡 + 16px 命中区）
 *   tab/gestures.ts    单击 / 双击 / 中键（含必须放模块级的双击计时）
 *   tab/faviconTint.ts 异步取色 + 「这一行此刻代表哪张图」的守卫
 *   decoration.js      插件装饰层（渲染侧插槽）的挂载语义
 *
 * 数据契约：tab = { tabId, url, title?, favicon?, active?, muted?, isPlaying?, isLoading?, pinned?, incognito? }
 *
 * ⚠ handlers 一律是**无参意图**（`() => void`）：tabId 由调用方（渲染记录）在闭包里
 *   补上。这一层不需要知道「自己是第几个标签」——那个知识属于渲染引擎。
 *
 * `options.decorate` = 宿主注入的**装饰层调用器**（渲染侧插槽 `tabbar.item-renderer`）。
 * 语义与约束见 `./decoration.js`：插件往行里追加一块自己的 DOM，
 * 行的结构 / 状态机 / keyed 复用仍然完全由本组件掌握。
 */

// "一张标签脸"的最小件住在 ui-common：与轴无关，横向标签条与纵向标签列 / 两个面板
// 引用**同一份**（见 docs/vertical-tabs-architecture.md §3.3）—— 本组件只负责把它们
// 按**横向**的排布装成一条标签。
import {
  classnames,
  createTabIconArea,
  createTabTitleArea,
  createTabCloseButton,
  createTabPermissionMark,
  attachTabGestures,
  createFaviconTint
} from '@hira-ng/ui-common'
import { appendDecoration, refreshDecoration } from './decoration.js'
import type {
  TabComponentController,
  TabDecorator,
  TabPatch,
  TabViewState,
  UnknownRecord
} from '../types.js'

interface TabHandlers extends UnknownRecord {
  onSelect?: () => unknown
  onAltSelect?: () => unknown
  onClose?: () => unknown
  onToggleAudio?: () => unknown
  onPermissionClick?: () => unknown
}

interface TabOptions {
  decorate?: TabDecorator | null
}

/** 参与「当前态快照」的布尔字段 —— 装饰器需要一份完整态，见下面的说明。 */
const LIVE_FLAGS = ['active', 'pinned', 'muted', 'isPlaying', 'isLoading', 'incognito'] as const

function createTab(
  doc: Document,
  tab: TabViewState,
  handlers: TabHandlers = {},
  options: TabOptions = {}
): TabComponentController {
  const decorate = typeof options.decorate === 'function' ? options.decorate : null
  const el = doc.createElement('div')
  el.className = classnames(
    'tab-item',
    tab.active && 'active',
    tab.pinned && 'pinned',
    tab.incognito && 'incognito',
    // 音频 / 静音按钮在场 → 这一行的压缩下限要加一截（见 styles.js 的 .has-audio）。
    // 为什么用类而不是 `:has()`：`:has()` 会在标签内任何 DOM/属性变化时触发祖先样式
    // 重算（页面加载期每次标题 / 图标更新都命中），而且它的特异度会**压过关闭态**，
    // 让媒体标签关不干净（详见 styles.js 那段注释）。
    (tab.muted || tab.isPlaying) && 'has-audio',
    // 容器标签（N10）：这一行用的是**别的 profile 的身份**（cookie / 存储隔离）。
    // 标识只用 class（CSS 画顶边色带），**不新增 DOM 子节点** —— 标签内部的间距由
    // tabSizing 按固定那几个孩子压缩计算，中间多塞一个元素会在窄标签下把标题挤没。
    tab.containerProfileId && 'container'
  )
  el.dataset.tabId = tab.tabId

  const iconArea = createTabIconArea(doc, tab, handlers)
  const titleArea = createTabTitleArea(doc, tab.title || tab.url || '')
  // 权限请求标记：落在标题与关闭按钮之间（标签内部唯一「点了不切标签」的目标）。
  // 画什么/怎么响应归共用件，这里只负责摆放与转发点击意图。
  const permissionMark = createTabPermissionMark(doc, { onPermissionClick: handlers.onPermissionClick })
  permissionMark.update(tab.permissionIcons)
  const closeButton = createTabCloseButton(doc, handlers)

  el.appendChild(iconArea.element)
  el.appendChild(titleArea.element)
  el.appendChild(permissionMark.element)
  // 分屏「回形针」**不在这里** —— 它画在"两条标签之间"，而不是某个标签的末尾：
  //   · 要跨在两条标签的边界上（左右各半），而本元素带 `overflow: hidden`（关闭时要
  //     塌宽裁住内容），标签内部画不出越过自身边界的东西；
  //   · 于是它由标签条上的**绘制层**画（view/splitClipLayer.js），外观与显隐语义
  //     归 ui-common 的共用件（纵向标签列用的是同一份）。
  el.appendChild(closeButton.element)

  // 跟随 favicon 取色（异步；见 tab/faviconTint.ts 的守卫说明）
  const tint = createFaviconTint(el)
  tint.update({ favicon: tab.favicon || '', active: !!tab.active })

  /**
   * 装饰层（渲染侧插槽 `tabbar.item-renderer`）。
   *
   * `update(next)` 只给**变化的字段**，而装饰器需要一份**完整**的当前态 ——
   * 所以这里自己维护一份 live 快照，避免让插件去拼（那等于把宿主的 diff 细节
   * 暴露给每个插件，必然会有人拼错）。
   */
  const live: UnknownRecord = {
    tabId: tab.tabId,
    title: tab.title || tab.url || '',
    url: tab.url || '',
    active: !!tab.active,
    pinned: !!tab.pinned,
    muted: !!tab.muted,
    isPlaying: !!tab.isPlaying,
    isLoading: !!tab.isLoading,
    incognito: !!tab.incognito,
    // 容器身份（N10）：给插件装饰器看的**事实**（id，不是布尔）。
    containerProfileId: tab.containerProfileId || null
  }
  // 挂到行**末尾**：装饰在关闭按钮右侧，不插进 favicon/title 之间 ——
  // 那两块的排版是按标签宽度压缩计算的，中间插东西会让标题在窄标签下被挤没。
  let decoration = appendDecoration(el, decorate, { ...live })

  attachTabGestures(el, handlers)

  return {
    element: el,
    update(next: TabPatch) {
      /**
       * 先同步 live 快照（装饰器要一份**完整**的当前态，见上面的说明）。
       *
       * 为什么不做「只有相关字段变了才重建装饰」的细粒度判断：`update` 本来就是在
       * 宿主 diff 出变化之后才被调用的，而「哪些字段与我有关」只有插件自己知道 ——
       * 宿主替它判定必然漏（将来插件想显示 URL 长度、加载耗时……）。
       * 重建一个角标量级的 DOM 不值得为它省。
       */
      let liveChanged = false
      for (const key of LIVE_FLAGS) {
        if (next[key] === undefined) continue
        const value = !!next[key]
        if (live[key] !== value) { live[key] = value; liveChanged = true }
      }
      if (next.title !== undefined && live.title !== (next.title || '')) { live.title = next.title || ''; liveChanged = true }
      if (next.url !== undefined && live.url !== (next.url || '')) { live.url = next.url || ''; liveChanged = true }

      // 结构类字段（class）先落到行上
      if (next.active !== undefined) el.classList.toggle('active', !!next.active)
      if (next.incognito !== undefined) el.classList.toggle('incognito', !!next.incognito)
      if (next.pinned !== undefined) el.classList.toggle('pinned', !!next.pinned)
      // 音频按钮的显隐会改这一行的**压缩下限**（多出 20px，见 styles.js 的 .has-audio）。
      // 判据读 live（上面刚按本轮补丁保鲜过），与按钮三态用的是同一份事实。
      const hasAudio = !!(live.muted || live.isPlaying)
      if (el.classList.contains('has-audio') !== hasAudio) el.classList.toggle('has-audio', hasAudio)
      // 容器身份（N10）：身份在创建时就定死了，理论上不会变；这里仍然跟着走 ——
      // 将来若加"换身份"，不会出现"色带还留在原地"的假状态。
      if (next.containerProfileId !== undefined) el.classList.toggle('container', !!next.containerProfileId)
      if (next.title !== undefined) titleArea.setTitle(next.title)

      // 小件各自更新（图标区管 favicon 与音频按钮）
      iconArea.update(next)
      // 权限标记只在宿主送来时更新（空数组 = 无请求）
      if (next.permissionIcons !== undefined) permissionMark.update(next.permissionIcons)

      // active / favicon 任一变化都要重画取色（选中态是整块底色，未选中是一条指示线）。
      // 只把**变化的字段**交出去，另一维沿用 tint 自己记着的值（见 faviconTint.ts）。
      if (next.active !== undefined || next.favicon !== undefined) {
        tint.update({
          favicon: next.favicon !== undefined ? next.favicon || '' : undefined,
          active: next.active !== undefined ? !!next.active : undefined
        })
      }

      // 装饰层**最后**重建：它可能读上面所有字段的最终值（放前面会读到半更新的状态）
      if (decorate && liveChanged) {
        decoration = refreshDecoration(el, decoration, decorate, { ...live })
      }
    }
  }
}

export { createTab }
