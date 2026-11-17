/**
 * LayerStack —— 图层堆叠与焦点调度的「纯规则」模块（对齐 RT LayerManager）。
 *
 * 来源：RT `src/shared/layers.ts` + `windows-controller/layer-manager/index.ts`。
 * 抽出两条 RT 独有机制，NG 此前缺失：
 *   1. **z-order 增量重排（前缀跳过）**：addChildView 对已存在的子 view 等价于「移到顶层」，
 *      因此「按 低→高 顺序逐个 addChildView」与「只重挂相对上次序列开始分歧的后缀」结果完全等价。
 *      后者可跳过不变的低层前缀 —— 面板/浮层增删时少掉大量 native 调用（极低开销、无闪烁）。
 *   2. **焦点优先级 + modal 阻塞**：任意图层被隐藏后，把键盘焦点重新分配给
 *      「优先级最高、且未被上层可见 modal 图层遮挡」的可见图层（RT `reallocateFocus`）。
 *
 * **彻底解耦**：本模块零依赖、零 electron、不持有任何 view / webContents。
 *   只吃纯数据 `{ name, visible, focusable, modalTo }`，吐纯结果。
 *   所有副作用（聚焦、取焦点态）由宿主（LayoutCoordinator）注入 —— 与 BoundsTween 同款。
 */

// 逻辑图层 → 焦点优先级（越大越优先拿到键盘焦点）。对齐 RT shared/layers.ts#focusPriorities。
// 语义映射：searchbar 下拉 ≈ RT omnibox(100)；siteinfo 弹层 ≈ webPrompt(22)；
//          tab ≈ tab(10)；浏览器外壳 ≈ 0。
const FOCUS_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  'float:searchbar-overlay': 100,
  'password-overlay': 40,
  // 查找栏：**高于网页（10）**——它就是被显示出来接住键盘输入的那个东西。
  // 比 siteinfo(22) 高：站点信息卡出现时若用户正在查找栏里打字，键盘理应留在查找栏
  // （卡片要的是鼠标；它照样画在最上层，见 Z_INDEX）。
  'float:findbar-overlay': 30,
  'float:siteinfo-overlay': 22,
  'tab-layer': 10,
  // 独立侧栏（Web Sidebar）：它是一个**真网页**，理应与标签同级持焦；但给 5 而不是 10 ——
  // 焦点**再分配**（某图层被隐藏后重挑一个持焦者）必须默认落回标签，否则会突然跳到侧栏。
  // 用户点侧栏时它自然持焦（原生点击），不依赖这个优先级。
  'web-sidebar': 5,
  'rail': 0,
  'panel': 0,
  'float:tabpreview-overlay': 0,
  // 悬停 URL 胶囊 / 缩放条：**不抢键盘焦点**（对齐 RT：tabTargetUrlIndicator 的
  // focusPriority = 0）。
  //   悬停 URL 本来就只有鼠标划过才存在；缩放条只要鼠标点，点完即收。
  //   两者若抢焦，都会把正在输入的网页/地址栏顶掉（同 tabpreview 的理由）。
  'float:hoverurl-overlay': 0,
  'float:zoom-overlay': 0,
  // 拖动落点预览：**不抢键盘焦点**（它只在拖动期间存在，抢焦点等于把用户正在
  // 拖到一半的操作打断 —— 与 hoverurl/zoom 同一条理由）。
  'float:dropzone-overlay': 0,
  // 分屏工具条：同样**不抢焦点**（它是 hover 浮出的小按钮排，抢焦点会把地址栏/网页的
  // 焦点抢走，用户下一次输入就落到按钮上了）。
  'float:split-toolbar': 0,
  // 插件浮层：默认**不抢焦点**（它可能是插件"顺手弹一下"的信息卡，不该打断用户正在
  // 输入的地址栏 / 网页）。用户点进卡片后原生焦点自然会落进去 —— 那是用户的主动选择，
  // 且收起时由 HIDE_FOCUS_REALLOC_FLOATS 捞回焦点。
  'float:plugin-overlay': 0
})

// 逻辑图层 → z 序基准（仅用于「谁在谁之上」的比较，与像素无关）。
// 低→高：tab-layer(标签容器) → panel → rail → 各浮层 → password-overlay
// 注：chrome（窗口本体）不是图层 —— 它天然位于 contentView 所有子视图之下，不参与排序。
// （LayerManager 依此升序挂载，addChildView 对已存在子 view 等价于「移到顶层」。）
const Z_INDEX: Readonly<Record<string, number>> = Object.freeze({
  'tab-layer': 0,
  panel: 1,
  // 独立侧栏（Web Sidebar）：轨道上最靠内的一段（紧邻网页），压过面板/标签，
  // 但远低于 rail 与任何浮层 —— 它不是弹层，不该盖住任何 chrome。
  'web-sidebar': 2,
  rail: 20,
  // 侧栏浮出层（Edge 型自动隐藏的悬停展开）：**紧贴 rail 之上**（21）——
  // 它盖住的就是那条 56px 图标 rail 与网页左侧，所以必须高过 rail；
  // 又必须低于悬停预览卡（38）/ 各类瞬态浮层（32~36）/ 地址栏下拉（40）：
  // 悬停卡片从标签条往下挂时正落在它上面，用户照着卡片点标签才是预期行为。
  // focusPriority 走默认 0：它只是"鼠标贴边浮出来的面板"，不该抢键盘焦点。
  'float:sidebar-float': 21,
  // 悬停预览卡：**必须压过侧栏两件**（panel 1 / rail 20）
  // —— 卡片是"浮在空中的信息层"，被任何一条侧栏切掉半张都算画错。
  // 它**不吃指针**（`interactive:false` → `setIgnoreMouseEvents(true, {forward:true})`，
  // 见 LayoutCoordinator#_ensureFloatView / tabpreview-overlay renderer），
  // 所以抬高 z 不会把指针从侧栏手里抢走 —— 收敛在指针穿透上，而不是靠压低 z。
  //
  // 取 38 = **压过全部"chrome 级瞬态浮层"**（悬停 URL 12 / 缩放条 34 / 查找栏 35 /
  // 拖动落点 36 / **分屏工具条 32**），但仍低于地址栏下拉（40）与各模态弹层。
  // 理由：卡片是从标签条**笔直往下挂**的一大块，落在内容区里 —— 而那几个浮层都住在
  // 同一片区域（分屏工具条就贴在分屏格的左上角、缩放条/查找栏贴网页顶部），
  // 任何一条比它高、都会把卡片切成半张（"缺一角 / 缺一条"）。
  // 让工具条被卡片盖住**不会**让它点不到：卡片是穿透的，点击照样落到工具条上
  // —— 这正是上面"收敛在指针穿透上"那条取舍的作用。
  // focusPriority 仍为 0（见上）：只浮在表面，绝不抢键盘焦点。
  'float:tabpreview-overlay': 38,
  'float:searchbar-overlay': 40,
  // 通用选择目标浮层铺满整窗，只是鼠标下拉；必须高于面板 / rail / 网页，
  // 但低于站点信息与权限询问，保持“随手下拉”的层级。
  'float:target-picker-overlay': 41,
  // 站点信息卡：地址栏左端按钮的正下方，必须压过地址栏下拉之外的所有 chrome 层；
  // 与地址栏下拉不会同屏（点站点按钮会先让地址栏失焦并收起建议）。
  'float:siteinfo-overlay': 42,
  // 权限询问属于网页内容上的决定面，必须压过站点信息卡；
  // 仍让插件浮层 / 总览 / 编辑层按各自语义压在它上面。
  'float:permission-overlay': 43,
  // 「总览」浮层（空间胶囊的下拉卡片）：铺满整窗的模态层，必须压过地址栏下拉之外的
  // 所有 chrome 层 —— 卡片是"随手一次"的操作面，被任何一条浮层切成半张都算画错。
  // 仍低于按钮编辑浮层（46）：那是编辑期间唯一的交互面。
  'float:overview-overlay': 45,
  // 按钮编辑浮层：编辑期间铺满整窗、接管全部指针，故必须压在所有浮层之上。
  'float:buttons-edit-overlay': 46,
  // ── chrome 级瞬态浮层三兄弟 ──────────────────────────────────────────
  // 悬停 URL 胶囊：只要压过它真正要浮在其上的对象即可 —— 网页(0)、面板(1)。
  // 低于 rail(20) 是有意的：胶囊贴网页左下角，永远不与 rail 重叠，
  // 万一重叠也该让**交互面**（rail）在上面（同 tabpreview 的取舍）。
  // 它与悬停预览卡(38) 不会同时出现（一个划过网页、一个划过标签），谁高谁低无影响。
  // 但因卡片更高（38），万一同屏也只可能"卡片盖它"，而卡片穿透、不影响点击。
  // （RT 同层：tabTargetUrlIndicator zIndex 11，正好压在 tab(10) 之上。）
  'float:hoverurl-overlay': 12,
  // 缩放条 / 查找栏：都在网页顶部，必须高于 rail(20) ——
  // 低于 searchbar-overlay(40)：地址栏下拉是最高优先级的弹层，两者都不得盖住它。
  'float:zoom-overlay': 34,
  'float:findbar-overlay': 35,
  // 拖动落点预览：**压在最上**（36）—— 它只在"用户正拖着一个标签"这唯一场景里出现，
  // 那一刻其它浮层（缩放条 / 悬停 URL / 分屏工具条）都不该盖住它。
  // 「悬停预览卡（38）在它之上」不冲突：拖标签期间 hover 预览本来就被 hover 状态机收起
  // （`hide({forgetRound:true})`），两者不会同屏。
  // 仍然低于地址栏下拉（40）：那是最高优先级的弹层。
  'float:dropzone-overlay': 36,
  // 分屏工具条：压在其他**非模态**浮层之上（32）—— 它是用户此刻正在操作的分屏的一部分，
  // 被悬停 URL（12）/ 侧栏浮出层（21）之类偶然盖住会直接点不到；
  // 仍低于拖动落点预览（36，那是"正在拖一个标签"时唯一该出现的东西）与地址栏下拉（40）。
  // ⚠ 它**低于**悬停预览卡（38）是有意的（见上）：卡片是从标签条往下挂的一大块，
  // 工具条正落在它的范围里；卡片不吃指针，所以被盖上不影响点击。
  'float:split-toolbar': 32,
  // 插件浮层：压过站点信息卡（42）—— 它是插件**主动弹出**的内容，用户此刻的注意力
  // 应该在它身上；仍低于铺满整窗的模态族（spaces 45 / buttons-edit 46 / password 100），
  // 那几层打开时本来就不该有别的浮层抢在最上面。
  'float:plugin-overlay': 44,
  'password-overlay': 100
})

const DEFAULT_Z_INDEX = 0
const DEFAULT_FOCUS_PRIORITY = 0

export function focusPriorityFor(name: unknown): number {
  const p = FOCUS_PRIORITY[String(name)]
  return Number.isFinite(p) ? p : DEFAULT_FOCUS_PRIORITY
}

export function zIndexFor(name: unknown): number {
  const z = Z_INDEX[String(name)]
  return Number.isFinite(z) ? z : DEFAULT_Z_INDEX
}

/**
 * 构造「本图层对其它图层的 modal 遮断谓词」（对齐 RT createModalTo）。
 *
 * 约定：返回的谓词 `(otherName) => boolean` 表示「本图层是否遮挡 / 阻断 otherName 的交互」。
 *   - searchbar 下拉、标签页搜索面板、password 浮层：对除自身外的所有图层 modal（最高层弹层）。
 *   - permission 弹窗（网页权限提示）：仅对标签内容层 modal（对齐 RT webPrompt）。
 *   - 其余图层不遮挡任何东西（返回 false）。
 */
export function createModalTo(name: unknown): (otherName: unknown) => boolean {
  const key = String(name)
  if (key === 'float:searchbar-overlay' || key === 'password-overlay') {
    return (otherName) => String(otherName) !== key
  }
  if (key === 'float:siteinfo-overlay') {
    const modalToLayers = ['tab']
    return (otherName) => modalToLayers.includes(String(otherName))
  }
  return () => false
}

/**
 * 注：焦点再分配 / modal 阻塞 / z 序增量重排的「运行时」实现都在 LayerManager
 * （它持有 view、需要副作用）。本模块只保留被实际调用的纯规则，避免同一逻辑两处实现。
 */
