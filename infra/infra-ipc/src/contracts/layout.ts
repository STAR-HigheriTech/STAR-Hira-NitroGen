import { z } from 'zod'

const floatBoundsRequest = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional()
})

/**
 * 一条面板目录项（PanelEntry）。
 *
 * 这是「UI 动态装配」的契约核心：rail / navbar / 按钮编辑浮层 / 面板渲染页
 * 全部消费同一个形状，因此新增一个面板插件时它们**同时**看得见，不需要各自改代码。
 *
 * icon 是**图标名字符串**（如 'Star'）而非组件：目录要过 IPC，函数不可序列化；
 * 渲染层用 ui-common#ICON_REGISTRY 查表还原成构造器。
 *
 * ⚠ 字段名与 `packages/shared-types/src/panel-entry.mjs#normalizePanelEntry` **必须逐字一致**
 *（那边是纯函数回落，这边是可序列化校验；两者不可合并，改动时一起改）。
 * 面板**只有一种种类**（本地渲染页）——远程网页侧栏是**独立子系统**，不再是面板
 *（见 docs/web-sidebar-design.md），因此这里没有 `kind` / `web`。
 */
const panelEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  order: z.number(),
  segment: z.string(),
  // 该面板由哪个插件提供（null = 保底目录，插件系统未就绪）
  pluginId: z.string().nullable(),
  // 声明「从外壳点进来时开的不是侧栏面板，而是这个子窗口类型」。
  // 只影响入口的**去向**，不改变 id —— 面板渲染页 `?panelId=` 照旧可用。
  // 形状真源见 packages/shared-types/src/panel-entry.mjs（字段名必须逐字一致）。
  opensWindow: z.string().nullable(),
  // 声明「从外壳点进来时在标签页里打开内部页 hira://<host>」（host 如 'plugins'）。
  // 与 opensWindow 对称：二者都只是**入口去向**，不改变 id / 图标 / 按钮位。
  opensPage: z.string().nullable(),
  // 声明「这块面板另有一份内部页形态」（host 如 'ai'）：面板照旧能开，只是宿主会
  // 多画一颗「在页面中打开」。与上面的 opensPage 是两件事（那个是入口改道）。
  // 形状真源见 packages/shared-types/src/panel-entry.mjs（字段名必须逐字一致）。
  hostPage: z.string().nullable(),
  // 面板的可搜索别名（`!笔记` / `!集锦` 都能直达）。zod 默认**剥掉未声明字段**——
  // 不在这里登记，别名就会在 `panel:catalog` 的响应校验里被丢掉（真源那边加了也没用）。
  bangs: z.array(z.string()),
  // 呈现形态：'dock' = 只能住侧栏；'both' = 宿主渲染「弹出 / 停靠」切换，可拆成独立窗口。
  // 单实例语义由主进程 PanelPresentationService 保证（同一 panelId 同时只住一处）。
  presentation: z.enum(['dock', 'both'])
})

const layoutSchemas = Object.freeze({
  panelList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.string()) }),
  panelCatalog: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ panels: z.array(panelEntrySchema) })
  }),
  panelToggle: Object.freeze({
    request: z.object({
      panelId: z.string(),
      // 本次打开「指定面板显示在哪一侧」。缺省（null/undefined）= 跟随 app.sidebar_position。
      //
      // 为什么由**打开它的入口**决定而不是全局设置：设置项描述的是「工具图标栏放在哪边」，
      // 而各入口分布在不同位置 —— rail 图标在自己那一侧（跟随设置），导航栏的面板按钮
      // 则由它此刻住哪决定（在顶部导航栏时靠右；随工具按钮行借住到标签侧栏时就是侧栏
      // 那一侧，见 sideDock 的说明）。
      side: z.enum(['left', 'right']).nullish()
    }),
    response: z.object({ open: z.boolean(), panelId: z.string() })
  }),
  /** 强制打开（不是 toggle）：已经打开时保持打开，供总览式“转到面板”使用。 */
  panelShow: Object.freeze({
    request: z.object({
      panelId: z.string(),
      side: z.enum(['left', 'right']).nullish()
    }),
    response: z.object({ open: z.boolean(), panelId: z.string() })
  }),
  // 某面板**实际在哪一侧**（null = 没打开）：面板宿主用它决定拖拽手柄在哪条边，
  // 以及宽度要按哪个槽（普通位 / 钉住位）读写 —— 所以一并回答 pinned。
  panelSide: Object.freeze({
    request: z.object({ panelId: z.string() }),
    response: z.object({
      side: z.enum(['left', 'right']).nullable(),
      pinned: z.boolean()
    })
  }),
  // 钉住 / 取消钉住。pinned 省略 = 切换（面板自己那块按钮的语义）。
  panelPin: Object.freeze({
    request: z.object({
      panelId: z.string(),
      pinned: z.boolean().nullish()
    }),
    response: z.object({
      pinned: z.boolean(),
      side: z.enum(['left', 'right']).nullable()
    })
  }),
  // 把面板移到另一侧，并与对侧同类型槽位里的面板互换。
  // 视图与面板状态原地复用，只交换槽位归属；swappedPanelId 为 null 表示对侧同位原本为空。
  panelSwapSides: Object.freeze({
    request: z.object({ panelId: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      panelId: z.string(),
      side: z.enum(['left', 'right']).nullable(),
      swappedPanelId: z.string().nullable()
    })
  }),
  // ── 独立侧栏（Web Sidebar）───────────────────────────────────────────
  // 打开：url 只允许 http/https（判据在 shared-types#web-sidebar.mjs）—— 非法一律 `open:false`。
  webSidebarOpen: Object.freeze({
    request: z.object({
      // 省略 = 「把**当前页**放上侧栏」（rail 的 `+` 就是这个语义）。
      url: z.string().nullish(),
      side: z.enum(['left', 'right']).nullish(),
      title: z.string().nullish()
    }),
    response: z.object({ open: z.boolean(), url: z.string() })
  }),
  webSidebarClose: Object.freeze({ request: z.unknown().optional(), response: z.object({ open: z.boolean() }) }),
  webSidebarSetWidth: Object.freeze({
    request: z.object({ width: z.number() }),
    response: z.object({ ok: z.boolean() })
  }),
  setHeaderHeight: Object.freeze({ request: z.object({ height: z.number() }), response: z.object({ ok: z.boolean() }) }),
  setPageLayoutParams: Object.freeze({ request: z.object({
    topbarHeight: z.number(),
    topbarVisible: z.boolean(),
    // 沉浸模式（设置 app.immersive_mode）：chrome 整体收起、网页铺满窗口，鼠标贴窗口边缘
    // 才唤出对应那一块。与全屏共用同一条判据与同一套呈现（见 LayoutCoordinator#_chromeHidden），
    // 所以这里只报设置值，不报"此刻有没有被唤出" —— 那是主进程按指针位置算出来的。
    // 缺省 nullish：旧渲染层不带时按关处理。
    immersiveMode: z.boolean().nullish(),
    // 底部工具栏占用高度（底部布局 = 工具栏高度；其余布局为 0）。
    // 页面/rail/面板都要让出这段，否则会被贴在窗口底部的工具栏盖住。
    bottombarHeight: z.number(),
    // 导航栏（地址栏所在那块）当前落在哪一侧。主进程据此决定地址栏下拉浮层的锚定方向：
    // 导航栏在底部时要向上弹，否则会跑到窗口顶端、离锚点一整屏远。
    // 不能靠 `bottombarHeight > 0` 推断 —— 底部可能只有书签栏，而导航栏在顶部。
    navSide: z.enum(['top', 'bottom']),
    // 省略 = 保留主进程当前宽度（rail 展开 / 拖拽宽度由 layout:setRailWidth 独占写入）。
    sidebarWidth: z.number().nullish(),
    sidebarSide: z.enum(['left', 'right']),
    // rail 自己的轴向 + 两条按钮起始边（渲染层才是加载了这套设置的那一方）。
    // 缺省 nullish：旧渲染层不带时沿用主进程当前值；带了则由这里**重算** sidebarSide
    //（见 LayoutCoordinator#setPageLayoutParams）—— 面板侧永远只有一份算术。
    railPosition: z.enum(['left', 'right', 'top', 'bottom']).nullish(),
    railHorizontalAlign: z.enum(['left', 'right']).nullish(),
    railVerticalAlign: z.enum(['top', 'bottom']).nullish(),
    sidebarAnimating: z.boolean(),
    // 侧栏区（垂直标签栏 / 未来任何住侧栏的块）的占宽。
    // 与 sidebarWidth（rail 图标栏）是纵向轨道上相邻但独立的两段：
    // 外侧 → 内侧 = [侧栏区][rail][面板][网页]。
    // 缺省给 .nullish()：旧渲染层不带这两个字段时按「无侧栏区」处理（0 / 可见）。
    sideColumnWidth: z.number().nullish(),
    sideColumnVisible: z.boolean().nullish(),
    // 侧栏区**自己那一侧**。与 sidebarSide（rail / 面板）是两条独立设置：
    // 纵向轨道上两段可以各靠一边，主进程按各自的侧算内缩与 x。
    // 缺省（nullish）= 跟随 sidebarSide（历史行为：两段同侧）。
    sideColumnSide: z.enum(['left', 'right']).nullish(),
    // ── 侧栏区的**悬停唤出**（自动隐藏）───────────────────────────────────
    // 由渲染层随上面几项一起上报的三条事实（形态由 layout.mjs#planChromeLayout 分型）：
    //   · sideColumnAutoHide     —— 形态开关（设置 app.sidebar_visibility === 'floating'）；
    //   · sideColumnRevealWidth  —— 唤出后的宽度（折叠着就是图标条宽，否则是用户拖的宽度）；
    //   · sideColumnRevealOverlay —— 唤出方式：
    //       true  → Edge 型：静止是**标签 rail 常驻**（占 restWidth），唤出的是**覆盖网页的
    //               独立浮层**（网页不缩进、不重排）；
    //       false → 全功能型：静止宽度 0，唤出把同一块侧栏变宽，网页**真的让位**。
    // "此刻是否唤出"由主进程按屏幕指针位置裁定（渲染层拿不到）。
    sideColumnAutoHide: z.boolean().nullish(),
    sideColumnRevealWidth: z.number().nullish(),
    sideColumnRevealOverlay: z.boolean().nullish(),
    // 宽度把手按住期间为 true：主进程冻结侧栏悬停唤出的进/出状态，
    // 避免拖宽时指针越过旧保持圈导致侧栏收起、拖拽源消失。
    sideColumnResizing: z.boolean().nullish(),
    // 侧栏区**实测矩形**（窗口内容区坐标）：Edge 型覆盖浮层的落位真相。
    // 为什么不由主进程用 topbar/bottombar 反推：那两项还含主列内部的"让位段"
    // （书签栏等），只缩短主列、不缩短侧栏区 —— 反推出来的浮层会比 rail 矮一整行。
    sideColumnRect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number()
    }).nullish(),
    contentTopOffset: z.number()
  }), response: z.object({ ok: z.boolean() }) }),
  setPanelWidth: Object.freeze({
    // side：两侧面板位各有独立宽度（各拖各的、各自记忆），所以写入必须指明是哪一侧。
    // slot：同一侧有普通位与钉住位两格，宽度也各记各的（缺省 = 普通位）。
    request: z.object({
      width: z.number(),
      side: z.enum(['left', 'right']).nullish(),
      slot: z.enum(['normal', 'pinned']).nullish()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  // rail 的**实际呈现宽度**：拖拽逐帧写入，面板开关 / 展开切换在边界处写入。
  // 与 app.rail_width 分开 —— 设置项记忆“用户选择的宽度”，这里表达“此刻原生视图多宽”。
  setRailWidth: Object.freeze({
    request: z.object({ width: z.number() }),
    response: z.object({ ok: z.boolean() })
  }),
  // 面板打开时记录 rail 的关闭恢复意图。主进程在最后一个面板关闭、
  // 执行布局之前先恢复该宽度，使“rail 展开 + 面板移除”合并为一次布局计算。
  setRailRestore: Object.freeze({
    request: z.object({
      expanded: z.boolean().nullable(),
      width: z.number().optional()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  // 把**原生键盘焦点**交给某个已打开面板的视图。
  // 面板显示本身不会自动获焦（FOCUS_PRIORITY=0，低于 tab-layer），
  // 而「打开面板即聚焦它的搜索框」需要 DOM 焦点 + 原生视图焦点两件事，
  // DOM 那只由渲染层自己 focus()，原生这只走本条。
  focusPanel: Object.freeze({
    request: z.object({ panelId: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  toggleRail: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ visible: z.boolean(), pinned: z.boolean(), width: z.number() })
  }),
  // ── 面板换宿主（通用能力，与 AI 无关）───────────────────────────────
  // 主进程 PanelPresentationService 据此开/关 `detached-panel` 窗口。
  // 单实例语义：同一 panelId 同时只住一处，切换即迁移（见 docs PART15 §11.2）。
  panelTransfer: Object.freeze({
    request: z.object({
      panelId: z.string().min(1),
      direction: z.enum(['detach', 'dock']),
      // 面板自己的 serialize() 快照（只有数据，没有消息历史）。
      state: z.unknown().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      panelId: z.string(),
      direction: z.enum(['detach', 'dock']),
      windowId: z.number().optional(),
      error: z.string().optional()
    })
  }),
  // 取走「迁移到本宿主」的状态（一次即焚）。宿主挂载后调用。
  panelTransferState: Object.freeze({
    request: z.object({ panelId: z.string().min(1) }),
    response: z.object({ state: z.unknown().optional() })
  }),
  setRailReveal: Object.freeze({ request: z.object({ revealed: z.boolean() }), response: z.object({ revealed: z.boolean() }) }),
  floatBounds: Object.freeze({ request: floatBoundsRequest, response: z.object({ ok: z.boolean() }) }),
  floatInteractive: Object.freeze({ request: z.object({ interactive: z.boolean() }), response: z.object({ ok: z.boolean() }) }),
  floatReady: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) }),
  // 分隔条拖拽：渲染层只报「指针在窗口内容区坐标里的位置 + 是哪一条分隔条」——
  // 比例怎么算是主进程用共享算术（shared-types#split-layout）算的，渲染层拿不到也不该拿内容区矩形。
  splitDrag: Object.freeze({
    request: z.object({ index: z.number(), axis: z.enum(['x', 'y']), position: z.number() }),
    response: z.object({ ok: z.boolean(), ratios: z.array(z.number()).optional() })
  }),
  // 分屏几何快照（渲染层挂载时拉一次；`split:changed` 是推送，首帧可能早于订阅）。
  splitGeometry: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  }),
  // 独立侧栏**聚焦框**几何快照（同上：`web-sidebar:changed` 是推送，首帧可能早于订阅）。
  webSidebarGeometry: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  }),
  // 速览（A1）**外环阴影**的几何快照（同上：`glance:changed` 是推送，
  // 而会话恢复能在外壳订阅之前就还原好速览）。蓝聚焦框不走这条通道（它注入进网页里）。
  glanceGeometry: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  })
})

export { layoutSchemas }

