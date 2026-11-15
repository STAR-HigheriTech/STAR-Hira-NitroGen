// @ts-check
/**
 * 标签条的**增量渲染引擎** —— keyed 复用 + 字段级 diff + 两阶段删除 + FLIP 让位。
 *
 * 为什么独立成模块：这是标签条最热的一条路径（每次切标签 / 每个 page-title /
 * favicon / loading / media 事件都会走一遍）。它只做一件事：**把投影调和成 DOM**。
 * 至于「标签行长什么样」（tabRecord / stackRecord）、「动效怎么播」（animations）、
 * 「下划线怎么画」（stackLineLayer），全部经端口注入 —— 本模块不认识它们内部。
 *
 * ── 对齐 HiraRT 的三条口径 ─────────────────────────────────────────────────
 *   1. key 复用（`tab:<id>` / `stack:<id>`）：节点与监听器只创建一次；
 *   2. 字段级 diff：仅真正变化的字段调一次 `update()`；
 *   3. 最小 DOM 操作：仅增删真正变化的项、仅顺序变化才 insertBefore。
 *
 * 旧实现每次 tab:changed 都 `textContent=''` 全量重建 + 逐项重挂监听器，
 * 于是一个页面事件就重建整条标签栏（含每标签重建 SVG 图标）—— 那正是
 * 「跟 IE 一样卡」的来源。
 */

import { stackMarks, splitMarks } from '@hira-ng/ui-common'
import type { PopMenu } from '@hira-ng/ui-common'
import { diffFields, affectsGeometry } from './projection.js'
import { createTabRecord } from './tabRecord.js'
import { createStackRecord } from './stackRecord.js'
import type {
  IntentHandler,
  IntentHandlers,
  RenderRecord,
  TabbarProjection,
  TabbarProjectionItem,
  TabDecorator,
  TabPreviewController,
  TabRendererController,
  TabStackState,
  TabViewState,
  UnknownRecord
} from '../types.js'

interface LayoutLayer {
  layout: (items: TabbarProjection) => void
  track: (getItems: () => TabbarProjectionItem[]) => void
}

interface TabRendererPorts extends UnknownRecord {
  onSelect?: (tabId: string) => unknown
  onSplitWithActive?: (tabId: string) => unknown
  onDropOnContent?: (tabId: string, baseTabId: string) => unknown
  onDropOnContentBegin?: (tabId: string, baseTabId: string) => unknown
  onClose?: (tabId: string) => unknown
  onToggleAudio?: (tabId: string) => unknown
  onPermissionClick?: (tabId: string) => unknown
  decorateTab?: TabDecorator | null
  decorateStack?: TabDecorator | null
  onToggleStack?: (stackId: string) => unknown
  onRenameStack?: (stackId: string, label: string) => unknown
  stackMenu?: IntentHandlers
  showMenu?: PopMenu | null
  drag?: { begin: (tabId: string) => void; end: () => void }
  openMenu?: (x: number, y: number, tab: TabViewState) => Promise<string | null>
}

interface TabRendererContext {
  innerEl: HTMLElement
  animator: ReturnType<typeof import('./animations.js').createTabAnimator>
  stackLines: LayoutLayer
  splitClips: LayoutLayer
  preview: TabPreviewController
  ports?: TabRendererPorts
}

/**
 * 只在**真的发生变化**时写类名 —— 返回「是否改过」。
 *
 * `classList.toggle` 即便传入相同值也会走一遍属性解析；更关键的是本函数的返回值
 * 让调用方能知道「这一笔改动是否可能改了几何」（进而决定要不要续期装饰层的逐帧跟踪）。
 * 每轮渲染对每个标签都要写四个类名，这条比对因此是热路径上最划算的一次短路。
 * @param {HTMLElement} node
 * @param {string} name
 * @param {boolean} on
 * @returns {boolean} 是否发生了变化
 */
function toggleClass(node: HTMLElement, name: string, on: boolean): boolean {
  const had = node.classList.contains(name)
  if (had === !!on) return false
  node.classList.toggle(name, on)
  return true
}

/**
 * @param {Document} doc
 * @param {{
 *   innerEl: HTMLElement,
 *   animator: ReturnType<typeof import('./animations.js').createTabAnimator>,
 *   stackLines: { layout: Function, track: Function },
 *   splitClips: { layout: Function, track: Function },
 *   preview: { hideIfTab: Function },
 *   ports: object
 * }} ctx
 */
export function createTabRenderer(doc: Document, ctx: TabRendererContext): TabRendererController {
  const { innerEl, animator, stackLines, splitClips, preview, ports = {} } = ctx

  const nodeRecords = new Map<string, RenderRecord>()
  /** 最近一次渲染的投影（右键菜单与拖拽落点据此找「相邻项 / 所属组」）。 */
  let lastItems: TabbarProjectionItem[] = []

  const tabPorts = {
    onSelect: ports.onSelect,
    onSplitWithActive: ports.onSplitWithActive,
    // Arc 式入口：拖到网页区域松手 = 与"拖动前正在看的那一格"分屏。
    // ⚠ 这一条曾漏掉过：`index.js` 把 `onDropOnContent` 收进了 ports、`tabRecord` 也在调它，
    //   但**中间这一跳没转发** —— 于是横向标签条的拖动分屏永远不触发（纵向宿主反而正常）。
    //   典型的三跳端口链断在中间：两端都在、看不出来。
    onDropOnContent: ports.onDropOnContent,
    // 同一条链的**开始**那半（拖动一开始就报，主进程据此起光标采样 → 拖动期间画落位预览）。
    onDropOnContentBegin: ports.onDropOnContentBegin,
    onClose: ports.onClose,
    onToggleAudio: ports.onToggleAudio,
    // 权限请求标记：与关闭/静音同上，渲染记录负责补 tabId。
    onPermissionClick: ports.onPermissionClick,
    decorate: ports.decorateTab,
    preview,
    drag: ports.drag,
    openMenu: ports.openMenu
  }

  /**
   * 芯片端口 —— `getSiblings` 必须读**当前投影**，所以在这里按 item 现造
   * （渲染引擎是投影的持有者，只有它知道此刻有哪些标签组）。
   */
  function stackPortsFor(item: TabStackState) {
    return {
      onToggle: ports.onToggleStack,
      onRename: ports.onRenameStack,
      // 标签组的四个动作（解散 / 平铺成分屏 / 合并 / 配色）**整包**透传 ——
      // 与纵向组行取的是同一份（apps 侧 createStackMenuHandlers），本层不认识它们。
      stackMenu: ports.stackMenu,
      decorate: ports.decorateStack,
      showMenu: ports.showMenu,
      getSiblings: () => lastItems.filter(
        (it): it is TabStackState => it.type === 'stack' && String(it.stackId) !== String(item.stackId)
      )
    }
  }

  /** 投影项 → 节点表的 key（标签与标签组各有自己的键空间）。 */
  const recKeyOf = (item: TabbarProjectionItem): string => (
    item.type === 'stack' ? `stack:${item.stackId}` : `tab:${item.tabId}`
  )

  /**
   * 分屏「合体标签」的角色表：key → `first` / `middle` / `last`。
   *
   * 判据**不在这里**：整段连续成员由 `splitMarks().runs` 给出（与回形针 / 纵向列表
   * 同一份真源 —— 见 ui-common/tab/splitLink.ts）。本函数只做一件纯事：把「一段」
   * 摊成「哪一半贴左缘、哪一半贴右缘、中间的是谁」，供渲染层写三个类名。
   *
   * 为什么在渲染层写、而不是再开一个绘制层：合体是**标签自身的外形**（半宽 / 去圆角 /
   * 去内部边框 / 负 margin 消缝），只有 CSS 能逐帧跟着宽度动画走；用一层浮层去"盖住"
   * 接缝既盖不掉边框，也跟不上 180ms 的开合重排。
   */
  function splitRunRoles(items: readonly TabbarProjectionItem[]): Map<string, 'first' | 'middle' | 'last'> {
    const roles = new Map<string, 'first' | 'middle' | 'last'>()
    for (const run of splitMarks(items, recKeyOf).runs) {
      const last = run.keys.length - 1
      for (let i = 0; i <= last; i += 1) {
        roles.set(run.keys[i], i === 0 ? 'first' : i === last ? 'last' : 'middle')
      }
    }
    return roles
  }

  /**
   * 本轮**是否发生了重排**（已有节点的相对顺序变了）—— 决定要不要跑 FLIP。
   *
   * FLIP（capture + slide）只服务**重排让位**（拖拽换位）。而开/关标签、新建标签
   * 这些高频动作**不改已有节点的相对顺序**：关闭塌宽、新增展开都是逐帧重排带动的，
   * 再叠一层 transform 纯属白付代价 —— 实测每次关闭要为此付出 n 次强制布局
   * （26 个标签时最差帧 18ms，直接表现为"关一个标签顿一下"）。
   *
   * 判据只看**子节点序列与投影**（零布局开销）：把当前 DOM 里"仍在表内"的节点按顺序
   * 取键，与投影里同一批节点的顺序逐位比对；完全一致 = 没有重排 = 不需要 FLIP。
   * 正在播关闭动效的节点不在表里（出表即出序列），因此不会被算进来。
   */
  function willReorder(list: TabbarProjection): boolean {
    const keyByNode = new Map<Node, string>()
    for (const [key, rec] of nodeRecords) keyByNode.set(rec.node, key)
    const domSeq: string[] = []
    for (const el of innerEl.children) {
      const key = keyByNode.get(el)
      if (key) domSeq.push(key)
    }
    if (domSeq.length === 0) return false
    const live = new Set(domSeq)
    let i = 0
    for (const item of list) {
      if (!item) continue
      const key = recKeyOf(item)
      if (!live.has(key)) continue
      if (domSeq[i] !== key) return true
      i += 1
    }
    return i !== domSeq.length
  }

  /**
   * 调和：把投影渲染成 DOM。
   * @param {TabbarProjection} tabItems
   */
  function render(tabItems: TabbarProjection): void {
    const list = (Array.isArray(tabItems) ? tabItems : []).filter((item): item is TabbarProjectionItem => !!item)
    lastItems = list

    // 0) 记下重排前每个节点的位置（FLIP 的 First）——**只在真的会重排时**才量。
    //    必须在任何 DOM 改动**之前**量：否则量到的是「已经动过」的位置，偏移就错了。
    //    （`willReorder` 只看子节点序列与投影，不读布局，所以可以安心放在这里。）
    const posBefore = willReorder(list)
      ? animator.capture(Array.from(nodeRecords.values(), (rec) => rec.node), 'x')
      : null

    // 1) 建/取节点；仅对变化字段调一次 update
    const desired: RenderRecord[] = []
    const newNodes: HTMLElement[] = []
    const seen = new Set<string>()
    // 本轮**是否可能改了几何**（新节点 / 删节点 / 重排 / 会改行盒的字段 / 类名翻转）。
    // 装饰绘制层（组下划线、分屏回形针）只在它为真时才续期逐帧跟踪 ——
    // 否则每个纯内容事件（标题、favicon、loading、媒体）都会白跑 260ms 的逐帧测量。
    let geometryDirty = false
    // 本轮投影里**真的有芯片**的标签组：只有它们的成员才算「组内成员」(.in-tab-stack)，
    // 底部细线才会让位给组下划线。判据走共用件（`stackMarks`）—— 纵向列表用的是同一份，
    // 两端不再各推一遍（否则必然一边变了另一边不变）。
    const { visibleStackIds: stacks } = stackMarks(list, recKeyOf)
    // 分屏合体：本轮的「段内角色」。与 `stacks` 同一时点算好 —— 两者都是投影的纯函数，
    // 且都只在标签节点上写类名（不参与节点增删，因此不影响下面的 FLIP 判据）。
    const splitRoles = splitRunRoles(list)
    for (const item of list) {
      if (!item) continue
      const isStack = item.type === 'stack'
      const key = recKeyOf(item)
      let rec = nodeRecords.get(key)
      if (!rec) {
        rec = isStack ? createStackRecord(doc, item, stackPortsFor(item)) : createTabRecord(doc, item, tabPorts)
        nodeRecords.set(key, rec)
        newNodes.push(rec.node)
        geometryDirty = true
      } else {
        const changed = diffFields(rec.item, item)
        if (changed) {
          rec.update(changed)
          rec.item = item
          if (!isStack) Object.assign(rec.state, changed)
          if (affectsGeometry(changed)) geometryDirty = true
        }
      }
      if (!isStack) {
        if (toggleClass(rec.node, 'in-tab-stack', item.stackId != null && stacks.has(String(item.stackId)))) {
          geometryDirty = true
        }
        // 分屏合体：两半拼成一条普通标签宽（外形全在 styles.js）。
        // 三个类各管一件事：整段半宽 / 左半留外缘圆角 / 右半贴合并消缝 ——
        // 中间那些（理论上一段 >2）走 base 规则，同样方角、同样无内边框。
        const role = splitRoles.get(key)
        if (toggleClass(rec.node, 'in-split-run', role != null)) geometryDirty = true
        if (toggleClass(rec.node, 'split-run-first', role === 'first')) geometryDirty = true
        if (toggleClass(rec.node, 'split-run-last', role === 'last')) geometryDirty = true
      }
      seen.add(key)
      desired.push(rec)
    }

    // 2) 删除已消失的节点 —— 两阶段：先播关闭动效，动画结束才真正摘除
    for (const [key, rec] of nodeRecords) {
      if (!seen.has(key)) {
        geometryDirty = true
        // 节点被 remove() 不会派发 mouseout → 预览窗的关闭信号会丢，必须主动收起。
        // 走 hideIfTab → 状态机规则 ⑥（收起 + 锁到指针真的动过）：相邻标签会在指针
        // 没动的情况下滑到指针底下，不锁的话补发的 mouseover 会当场把预览又弹出来
        // —— 表现正是"关掉这个标签，预览还卡着"。
        if (preview && rec.state && rec.state.tabId) preview.hideIfTab(rec.state.tabId)
        // 先出表：同一 tabId 立刻被撤销恢复时应当建新节点，而不是复用这个正在消失的
        nodeRecords.delete(key)
        animator.exit(rec.node)
      }
    }

    // 3) 按目标顺序重排（仅位置变化才动 DOM，未变项零操作）
    //    正在播关闭动效的节点不算锚点（它马上就没了，拿它当参照会把别的标签推来推去）
    let refNode = animator.skipClosing(innerEl.firstChild)
    for (const rec of desired) {
      const node = rec.node
      if (node === refNode) {
        refNode = animator.skipClosing(refNode ? refNode.nextSibling : null)
      } else {
        innerEl.insertBefore(node, refNode)
      }
    }

    // 3.5) 滑动让位：把「因重排而换位」的标签滑到新位置，而不是生硬瞬移。
    //      只在**本轮真的重排过**时才播（step 0 的 willReorder 判据）—— 开/关标签
    //      不需要它：塌宽与展开本身就是逐帧重排带动的，让位由布局天然完成。
    //      正在播关闭动效的节点跳过 —— 它自己有一套宽度过渡，再叠 transform 会互相干扰。
    if (posBefore) {
      animator.slide(posBefore, 'x', { skip: (node: HTMLElement) => node.classList.contains('is-tab-closing') })
    }

    // 3.6) 标签组下划线：**必须赶在入场动效之前量**。runEnter 一挂上入场关键帧，
    //      宽度就立刻按动画的起始值（0）参与布局结算，这时候量什么都不作数。
    //      量完再开一段逐帧跟踪 —— 本次渲染带来的开合/让位动画期间，线要一直贴着走。
    //
    // 3.7) 分屏回形针：与下划线层同一时点、同一条口径（量真实矩形 + 动效期间逐帧跟随）。
    //      它画在**两条相邻标签之间那道缝的正中**，所以必须在下划线之后、入场动效之前量。
    //      （合体之后那道"缝"就是两半的接缝：负 margin 让两条边重合，中点即接缝本身。）
    //
    // ⚠ 只有**本轮真的可能改了几何**时才重画 + 续期跟踪。纯内容事件（标题、favicon、
    //   loading、媒体状态）走完整条渲染管线后像素一个都没动，若照样 ping，
    //   有标签组的窗口在页面加载期会常驻逐帧测量（实测正是"加载时卡一下"的来源）。
    //   窗口/容器尺寸变化由 ResizeObserver 兜住，CSS 几何过渡由 transition 中继兜住 ——
    //   两者都在装配处挂好，不依赖这一条路径。
    if (geometryDirty || posBefore) {
      stackLines.layout(list)
      stackLines.track(() => lastItems)
      splitClips.layout(list)
      splitClips.track(() => lastItems)
    }

    // 4) 新标签的展开动效：必须等节点真的进了 DOM 才有宽度可量
    animator.enterNew(newNodes)
  }

  return {
    render,
    /** 当前投影（拖拽落点 / 右键菜单 / 下划线跟踪都以它为准）。 */
    getItems: () => lastItems,
    /** 按 key 取节点 —— 下划线图层靠这一条与渲染引擎解耦。 */
    getNode: (key: string) => {
      const rec = nodeRecords.get(key)
      return rec ? rec.node : null
    }
  }
}
