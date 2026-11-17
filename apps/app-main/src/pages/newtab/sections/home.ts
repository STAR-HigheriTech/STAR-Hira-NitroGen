/**
 * 分区 · 首页
 *
 * 就是这个新标签页原本的全部内容：搜索框 + 用户自定义摆放的组件看板。
 *
 * 「自定义 / 添加组件」这两个动作**不在页面里另起一条浮动的编排条** ——
 * 而是通过 `ctx.tabbar.addAction()` 挂到**顶部选项卡栏的最右侧**，
 * 与选项卡同款样式（`.ntp-tab`）。理由：
 *   · 这两个动作本来就只属于首页，挂在选项卡栏上"哪一个分区的东西"一眼可辨；
 *   · 显隐由切换器统一管（动作项的归属分区不激活就自动隐去），
 *     首页这里不必再自己盯着"什么时候该显出工具条"；
 *   · 少一层固定在底部的浮层，页面就少一处要跟内容抢视线的东西。
 */
import { defineSection } from './registry.js'
import { createBoard } from '../widgets/board.js'
import type { SectionContext } from './types.js'

// 组件清单。import 即注册（模块内部调用 defineWidget）。
// 搜索框也在里面 —— 它是网格里的常驻项，不是页面写死的一行。
import '../widgets/defs/search.js'
import '../widgets/defs/clock.js'
import '../widgets/defs/date.js'
import '../widgets/defs/news.js'
import '../widgets/defs/speed-dial.js'

/**
 * 默认摆放**预设表**（按修订号排列，最后一个生效）。
 *
 * 坐标一律按**主断点 16 列**给；窄屏那一档由板层按比例推导（见 widgets/board.js#ensureLayout）。
 * 用户一旦动过摆放（哪怕全删光），默认就再也不生效 —— 见 widgets/store.js 的 seeded。
 *
 * 为什么要保留旧版本而不是只留一份：
 *   板层靠「当前布局是否与**某一版旧默认**逐格一致」来判断这位用户的看板
 *   "还是不是当年那套没动过的默认"（见 board.js#upgradePreset）。
 *   只有旧版本还在表里，老用户才能被识别出来、进而换成新默认；
 *   用户亲手摆过的布局一份都不会被碰。
 *
 * 每重做一次默认构图：往末尾追加一版，**不要改历史版本**。
 * 修订 2 = 收紧版：整块从 13 行压到 8 行（约 820px → 500px），
 * 900p 屏首屏不再需要滚动；每张卡也同步瘦身（见各 defs 的 defaultSize）。
 * 修订 3 = 极简版：默认只保留顶部居中的搜索框，并把宽度从 8 格微调到 9 格。
 * 修订 4 = 下移版：搜索框下移一行，宽度再增加到 10 格。
 */
const PRESETS = [
  {
    revision: 1,
    layout: [
      { widget: 'search', rect: { x: 3, y: 0, w: 10, h: 1 } },
      { widget: 'clock', rect: { x: 0, y: 2, w: 7, h: 3 } },
      { widget: 'date', rect: { x: 7, y: 2, w: 9, h: 3 } },
      { widget: 'news', rect: { x: 0, y: 5, w: 16, h: 5 } },
      { widget: 'speed-dial', rect: { x: 0, y: 10, w: 16, h: 3 } }
    ]
  },
  {
    revision: 2,
    layout: [
      // 搜索框居中（8 列 ≈ 半屏宽，够长又不霸屏）
      { widget: 'search', rect: { x: 4, y: 0, w: 8, h: 1 } },
      // 时间 / 日期左右对称、各两行高（116px）：大字仍在，纵向不再空半张卡
      { widget: 'clock', rect: { x: 0, y: 2, w: 7, h: 2 } },
      { widget: 'date', rect: { x: 9, y: 2, w: 7, h: 2 } },
      // 新闻 / 快速拨号左右各半屏、四行高（244px）：信息密度够，整页仍是一屏
      { widget: 'news', rect: { x: 0, y: 4, w: 8, h: 4 } },
      { widget: 'speed-dial', rect: { x: 8, y: 4, w: 8, h: 4 } }
    ]
  },
  {
    revision: 3,
    layout: [
      // 极简首屏：只保留常驻搜索框，位置仍为顶部正中；宽度 8 → 9 格，
      // 只做轻微加长，不改变视觉重心。
      { widget: 'search', rect: { x: 3.5, y: 0, w: 9, h: 1 } }
    ]
  },
  {
    revision: 4,
    layout: [
      // 居中下移一行，宽度再增加一格；仍保持顶部区域的轻量构图。
      { widget: 'search', rect: { x: 3, y: 1, w: 10, h: 1 } }
    ]
  }
]

defineSection({
  id: 'home',
  name: '首页',
  description: '搜索框 + 自定义组件',
  mount(ctx: SectionContext) {
    const host = document.createElement('div')
    host.className = 'ntp__board'
    host.setAttribute('role', 'list')
    host.setAttribute('aria-label', '新标签页组件')
    ctx.root.appendChild(host)

    const board = createBoard({ host, openUrl: ctx.openUrl, presets: PRESETS })

    // ── 选项卡栏上的两个动作项 ────────────────────────────────────────────
    // 「添加组件」只在自定义模式下出现（setHidden 由板层回调驱动）；
    // 「自定义」是模式开关，标签在"自定义 / 完成"之间切换，并以选中态高亮。
    const addAction = ctx.tabbar.addAction({
      id: 'add-widget',
      label: '添加组件',
      onClick: () => board.openPicker(addAction.el)
    })
    addAction.setHidden(true)

    const editAction = ctx.tabbar.addAction({
      id: 'edit',
      label: '自定义',
      onClick: () => board.toggleEditing()
    })

    board.onEditingChange((editing) => {
      editAction.setLabel(editing ? '完成' : '自定义')
      editAction.setActive(editing)
      addAction.setHidden(!editing)
    })

    // Esc 退出自定义模式（浮层打开时 Esc 由浮层自己吃掉，到不了这里 —— 见 popover.js）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && board.isEditing()) board.setEditing(false)
    }
    // 页面切到后台时收起浮层，避免回来时挂着一个悬空的菜单
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') board.closePickers()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', onVisibility)

    return {
      /** 离开首页时不把"自定义中"的状态带出去（否则切回来还是编辑态，很突兀） */
      onHide() {
        board.setEditing(false)
      },
      destroy() {
        document.removeEventListener('keydown', onKey)
        document.removeEventListener('visibilitychange', onVisibility)
        addAction.remove()
        editAction.remove()
        board.destroy()
      }
    }
  }
})
