/**
 * ChromeLayoutController —— 窗口外壳布局的**唯一施加方**。
 *
 * 它回答一个问题：「设置里的那几条布局键，此刻该把外壳摆成什么样？」
 *   · 读设置 → chromeLayoutStateFromSettings → planChromeLayout → chromeLayout.setPlan()
 *   · 窗口控制按钮归谁（tabbar / navbar / titlebar）→ 搬移同一个 DOM 节点（搬移而非复制）
 *   · 标题栏开关 → 在容器里注册 / 注销 titlebar 块
 *   · 导航栏所在侧 → 交给调用方（window-layout-controller 上报给主进程，
 *     决定地址栏下拉向上还是向下弹）
 *   · 网页标题 / 图标 → 灌进标题栏块（没启用就不灌），并组合成**原生窗口标题**
 *     推给调用方（任务栏上显示的那一行；与标题栏开关无关，永远更新）
 *
 * 为什么单独一个控制器：摆放是**策略**，app-shell 只该做装配（把块元素交出来）。
 * 于是「加第五块」「加第三种模式」只需要改两份文件 —— shared-types 的 planChromeLayout
 * 与本文件的一处注册，app-shell 一行都不用改。这正是插件化/解耦在布局上的落点。
 *
 * 边界：本控制器不认识 tabbar / navbar 的内部结构（按钮、地址栏、标签条），
 * 只认识「这几个 id ↔ 这几个元素」。块的内部语义归各哑组件自己。
 */
import {
  LAYOUT_SETTING_KEYS,
  LAYOUT_SETTING_KEY_LIST,
  layoutPresetWrites,
  matchLayoutPreset,
  chromeLayoutStateFromSettings,
  formatWindowTitle,
  planChromeLayout
} from '@hira-ng/shared-types/src/layout.mjs'

type ChromeLayoutPlan = ReturnType<typeof planChromeLayout>
type LayoutSettingKey = typeof LAYOUT_SETTING_KEY_LIST[number]

interface ChromeLayoutControllerOptions {
  chromeLayout: {
    setBlock(id: string, element: unknown): void
    setPlan(plan: ChromeLayoutPlan): void
    setSideReveal?(revealed: boolean): void
  }
  settingsClient: { get(key: string): Promise<unknown>; set?(key: string, value: unknown): Promise<unknown> }
  blocks: {
    tabbar: HTMLElement
    navbar: HTMLElement
    bookmarkbar: HTMLElement
    titlebar: { element: HTMLElement; setPageInfo(info: object): void; setControls(element: unknown): void } | null
  }
  windowControls: HTMLElement | null
  mountWindowControls(host: 'tabbar' | 'navbar' | 'titlebar'): void
  onPlan?(plan: ChromeLayoutPlan): void
  onHostAxis?(id: string, axis: 'row' | 'column'): void
  appName?: string
  setWindowTitle?(text: string): void
}

function isLayoutSettingKey(key: string): key is LayoutSettingKey {
  return (LAYOUT_SETTING_KEY_LIST as readonly string[]).includes(key)
}

/**
 * @param {{
 *   chromeLayout: {
 *     setBlock: (id: string, el: unknown) => void,
 *     setPlan: (plan: unknown) => void,
 *     setSideReveal?: (revealed: boolean) => void
 *   },
 *   settingsClient: { get: (key: string) => Promise<unknown> },
 *   blocks: {
 *     tabbar: HTMLElement,
 *     navbar: HTMLElement,
 *     bookmarkbar: HTMLElement,
 *     titlebar: { element: HTMLElement, setPageInfo: (info: object) => void, setControls: (el: unknown) => void } | null
 *   },
 *   windowControls: HTMLElement | null,
 *   mountWindowControls: (host: 'tabbar'|'navbar'|'titlebar') => void,
 *   onPlan?: (plan: object) => void,
 *   onHostAxis?: (id: string, axis: 'row'|'column') => void,
 *   appName?: string,
 *   setWindowTitle?: (text: string) => void
 * }} options
 */
export function createChromeLayoutController({
  chromeLayout,
  settingsClient,
  blocks,
  windowControls,
  mountWindowControls,
  onPlan,
  onHostAxis,
  appName,
  setWindowTitle
}: ChromeLayoutControllerOptions) {
  /** 布局设置键 → 当前值（本控制器的唯一真源，热更新时只覆写变化的那一个键）。 */
  const state: Record<string, unknown> = {}
  let plan: ChromeLayoutPlan | null = null
  let editingMode = false
  const ownerVisibility = { bookmarkbar: true }
  /** 最近一次灌入的网页标题 / 图标：换布局（开关标题栏）后要能立刻补上，不必等下一次切标签。 */
  let pageTitle = ''
  let pageFavicon = ''
  /** 最近一次推出去的原生窗口标题（去重，标题高频变化时不做无谓 IPC）。 */
  let lastWindowTitle: string | null = null

  const titlebar = blocks && blocks.titlebar ? blocks.titlebar : null

  /** 块 id → 已登记进容器的元素（null = 未登记）。用来把重复登记挡在门外。 */
  const registered: Record<string, HTMLElement | null> = {}

  /** 块 id → 上次通告的宿主轴。只在**真的变了**时通告（块内搬家不是免费操作）。 */
  const lastAxis: Record<string, 'row' | 'column'> = {}

  /**
   * 从摆放计划推出「每块此刻住在什么轴的区域里」。
   *
   * 容器的 `data-host-axis` 标记是给 CSS 看的；这条是给**块自己**看的 ——
   * 块据此决定内部形态（导航栏在纵排宿主里要变多行堆叠、标签栏要换成纵向列表…）。
   * 注意：侧栏区被隐藏时块不在文档里，但它的归属区域仍是侧栏，
   * 故这里照常记为 column —— 等它回来时形态已经是对的。
   * @param {object} p
   * @returns {Record<string, 'row'|'column'>}
   */
  function axesFromPlan(p: ChromeLayoutPlan) : Record<string, 'row'|'column'> {
    /** @type {Record<string, 'row'|'column'>} */
    const out: Record<string, 'row'|'column'> = {}
    const mark = (rows: string[][] | undefined, axis: 'row' | 'column') => {
      for (const ids of rows || []) for (const id of ids) out[id] = axis
    }
    mark(p.top, 'row')
    mark(p.bottom, 'row')
    if (p.side) mark(p.side.rows, 'column')
    return out
  }

  /**
   * 通告「块 → 宿主轴」的变化。
   *
   * 为什么由控制器统一做而不是让容器调块的方法：容器只认识元素、块的方法长在组件上，
   * 只有编排层同时认识两者。于是块完全不需要知道「谁在管布局」，只回答一个问题：
   * 「你现在住在什么轴的区域里了」。
   */
  function syncHostAxis() {
    if (typeof onHostAxis !== 'function') return
    if (!plan) return
    const axes = axesFromPlan(plan)
    for (const id of Object.keys(axes)) {
      if (lastAxis[id] === axes[id]) continue
      lastAxis[id] = axes[id]
      onHostAxis(id, axes[id])
    }
  }

  /**
   * 登记（或注销）一个块。
   *
   * 幂等且**零副作用**：元素没变就什么都不做 —— 于是「可见性同步」这类高频调用
   * 不会引起容器的重摆（重摆会摘掉全部块再插回去，标签条那种重块被摘一下就是一次可见抖动）。
   * @returns {boolean} 是否真的发生了变化（调用方据此决定要不要重新上报占高）
   */
  function registerBlock(id: string, el: HTMLElement | null) : boolean {
    const next = el || null
    if (registered[id] === next) return false
    registered[id] = next
    chromeLayout.setBlock(id, next)
    return true
  }

  // 三个常驻块只登记一次：它们永远存在，不随任何设置开关。
  // 标题栏不同 —— 它可以被关掉，因此它的登记/注销在每次 apply() 里跟着计划走。
  registerBlock('tabbar', blocks.tabbar)
  registerBlock('navbar', blocks.navbar)
  // 书签栏可被**它自己的主人**临时注销（空书签栏 / 仅新标签页模式 = 这块此刻不存在），
  // 见 setBlockVisible：不可见的块若仍登记着，容器里就会留着它那一行。
  registerBlock('bookmarkbar', blocks.bookmarkbar)

  /** 首次全量读取（8 次 get 并发，只在启动发生一次）。 */
  function readAll() {
    return Promise.all(LAYOUT_SETTING_KEY_LIST.map(
      (key) => settingsClient.get(key).catch(() => undefined)
    )).then((values) => {
      LAYOUT_SETTING_KEY_LIST.forEach((key, i) => { state[key] = values[i] })
    })
  }

  /**
   * 编辑模式是**临时展示态**：不写任何设置，只把真实状态投影成“全部可见、全部展开”。
   * 退出后下一轮 apply() 会按原设置恢复。
   */
  function layoutStateForPresentation() {
    const source = chromeLayoutStateFromSettings(state)
    const immersiveMode = state[LAYOUT_SETTING_KEYS.immersiveMode] === true
    if (!editingMode && !immersiveMode) return source
    const positions = { ...source.positions }
    const sideColumn = { ...source.sideColumn }
    if (editingMode && positions.titlebar === 'side') positions.titlebar = 'top'
    if (editingMode && positions.bookmarkbar === 'side') positions.bookmarkbar = 'top'
    const hasSideRow = positions.tabbar === 'side' || positions.navbar === 'side'
    // 沉浸模式属于“整个 chrome 收起、贴边整体恢复”，侧栏不能再同时走 hover：
    // 否则同一块侧栏被沉浸恢复和悬停巡看两套状态争抢。这里把它临时投影成常驻占位，
    // 不改用户保存的悬停设置。
    if (hasSideRow && (editingMode || immersiveMode)) {
      sideColumn.visibility = 'attached'
      sideColumn.collapsed = false
    }
    return {
      ...source,
      titlebarEnabled: editingMode ? true : source.titlebarEnabled,
      positions,
      sideColumn
    }
  }

  /**
   * 施加当前 state。幂等：重复调用只是重摆同一套位置，不做差量判断
   * （差量在「某块同时换侧又换序」时极易漏判，而重摆的代价只是几个空行 div）。
   */
  function apply() {
    plan = planChromeLayout(layoutStateForPresentation())
    const titlebarOn = plan.titlebarEnabled && !!titlebar

    // 1) 标题栏关闭 = 这块**不存在**：从容器注销（元素随之离开文档流），
    //    它不参与摆放，也不可作为窗口控制按钮宿主。
    registerBlock('titlebar', titlebarOn ? titlebar.element : null)
    registerBlock(
      'bookmarkbar',
      editingMode || ownerVisibility.bookmarkbar !== false ? blocks.bookmarkbar : null
    )

    // 2) 窗口控制按钮换宿主。搬移同一个 DOM 节点 —— 按钮上的监听与状态因此不丢。
    //    先把它从标题栏摘出来，再交给目标宿主，避免“还挂在 titlebar 里就被 setPlan 搬走”。
    //    ⚠ 原生 WCO 窗口（按钮由系统画）根本没有这颗节点：windowControls 为 null，
    //      此时任何一种宿主都只是"无事可做"，让位给系统按钮（见 app-shell/wco.js）。
    if (windowControls && plan.windowControlsHost === 'titlebar' && titlebarOn) {
      // 先让**导航栏那块**放手（它自己也管着同一颗节点：宿主为标签栏 / 导航栏时是它的），
      // 再交给标题栏 —— 顺序反了的话，它随后一次内部重摆会把节点从标题栏里抢回来。
      mountWindowControls('titlebar')
      titlebar.setControls(windowControls)
    } else {
      if (titlebar) titlebar.setControls(null)
      // 无自绘簇（原生 WCO）时不主张宿主：mountWindowControls 内部会整体让位。
      mountWindowControls(plan.windowControlsHost === 'navbar' ? 'navbar' : 'tabbar')
    }

    // 3) 摆放。块元素被搬移而非复制，块内状态（地址栏内容、标签条）不受影响。
    chromeLayout.setPlan(plan)

    // 4) 通告「块 → 宿主轴」：行区 = 横排宿主，侧栏区 = 纵排宿主。
    //    块据此重排自己的内部形态（标签栏换成纵向列表、导航栏变多行堆叠…）。
    //    必须在 onPlan（触发重新上报占高）之前 —— 否则量到的是变形前的尺寸。
    syncHostAxis()

    // 5) 标题栏刚被打开时，页面上一次灌进来的标题 / 图标要立刻补上 ——
    //    否则要等到下一次切标签或标题变化才出现（中间是一段空白标题栏）。
    if (titlebarOn) titlebar.setPageInfo({ title: pageTitle, favicon: pageFavicon })

    // 6) 原生窗口标题与标题栏开关**无关**：任务栏/Alt-Tab 上那一行永远跟随当前网页。
    pushWindowTitle()

    // 7) 预设下拉的真实性：把「当前组合反推出的预设」写回设置键（值没变则一次不写）。
    syncPresetLabel()

    if (typeof onPlan === 'function') onPlan(plan)
    return plan
  }

  /**
   * 组合并推出原生窗口标题（`页面标题 | 应用名`）。
   * 与上一次相同则不发 —— 标题类事件在页面加载期很密集，去重省掉整串 IPC。
   */
  function pushWindowTitle() {
    if (typeof setWindowTitle !== 'function') return
    const next = formatWindowTitle(pageTitle, appName)
    if (next === lastWindowTitle) return
    lastWindowTitle = next
    setWindowTitle(next)
  }

  /** 写一个设置键（缺 set 能力的客户端静默跳过，保证本控制器在只读环境下也能跑）。 */
  function persist(key: string, value: unknown) {
    const set = settingsClient.set
    if (typeof set !== 'function') return
    try { set.call(settingsClient, key, value).catch(() => {}) } catch (_) {}
  }

  /**
   * 预设是**宏**：选中它 → 把预设定义的几个**区域键**写进去。
   *
   * 真源永远是「每块各自的区域」，预设只是一次性把若干区域键写好的快捷方式 ——
   * 所以写完仍然可以逐块微调，微调后由 syncPresetLabel 把下拉改成「自定义」，
   * 绝不反向覆盖用户的选择。`custom` 不是第四种布局：它不写任何区域键。
   * @param {unknown} presetId
   */
  function applyPresetSelection(presetId: unknown) {
    const writes = layoutPresetWrites(presetId)
    if (!writes.length) return
    for (const [key, value] of writes) {
      state[key] = value
      persist(key, value)
    }
    apply()
  }

  /**
   * 把「当前区域组合反推出的预设」写回设置键。
   *
   * 为什么要有这一条：下拉显示的是 `app.layout_preset`，而它可能落后于用户后来的微调 ——
   * 只写主体的宏会让下拉撒谎（显示「默认布局」但标签栏其实在侧栏）。
   * 这里由**唯一的施加方**反推真实状态，值与实际不符才写；写入回来后会再跑一次 apply，
   * 那时两者已经相等 → 不再写，环路自然收敛。
   */
  function syncPresetLabel() {
    const key = LAYOUT_SETTING_KEYS.preset
    const p = LAYOUT_SETTING_KEYS.rowPosition
    const matched = matchLayoutPreset(
      {
        tabbar: state[p.tabbar],
        navbar: state[p.navbar],
        titlebar: state[p.titlebar],
        bookmarkbar: state[p.bookmarkbar]
      },
      state[LAYOUT_SETTING_KEYS.titlebarEnabled] === true
    )
    const next = matched || 'custom'
    if (state[key] === next) return
    state[key] = next
    persist(key, next)
  }

  /** 启动：读一次 → 摆一次。 */
  const ready = readAll().then(apply).catch(() => apply())

  /** 重新全量读取并施加（设置被整体重置 / 需要强制对齐时用）。 */
  function refresh() {
    return readAll().then(apply).catch(() => apply())
  }

  /**
   * 热更新入口（settings:changed 时由 app-shell 调用）。
   *
   * 预设键特殊对待：它是**宏**，选中后要落成几个区域键（模板写在 shared-types 里，
   * 与本控制器共享同一份真源），再按新的区域重摆。
   * @param {string} key
   * @param {unknown} value
   */
  function setSetting(key: string, value: unknown) {
    if (!isLayoutSettingKey(key)) return false
    state[key] = value
    if (key === LAYOUT_SETTING_KEYS.preset) {
      applyPresetSelection(value)
      return true
    }
    apply()
    return true
  }

  /**
   * 一次动作写入多个布局键时只重排一次。
   *
   * 拖放会同时改变栏位区域、行序、侧序与模式；逐键调用 setSetting 会触发
   * 多次 DOM 搬运和几何上报，表现为松手后连续抖动。这里先收敛状态，
   * 再让唯一的施加函数 apply() 跑一次。
   * @param {Array<[string, unknown]>} changes
   */
  function setSettings(changes: Array<[string, unknown]>) {
    let changed = false
    let preset: unknown = null
    for (const [key, value] of changes || []) {
      if (!isLayoutSettingKey(key)) continue
      state[key] = value
      changed = true
      if (key === LAYOUT_SETTING_KEYS.preset) preset = value
    }
    if (!changed) return false
    if (preset != null) applyPresetSelection(preset)
    else apply()
    return true
  }

  return {
    /** 启动完成（app-shell 可 await 后再上报高度）。 */
    ready,

    /** 当前摆放计划（含 navbarSide，供调用方上报给主进程）。 */
    getPlan: () => plan,

    /** 当前设置值快照（只读用途；不要直接改它 —— 改设置走 setSetting）。 */
    getState: () => ({ ...state }),

    /** 热更新一个布局设置键。非布局键返回 false（调用方据此跳过）。 */
    setSetting,

    /** 批量热更新；同一拍多个键只施加一次。 */
    setSettings,

    /** 手动重摆（窗口结构变化等场合）。 */
    apply,

    /** 全量重读并重摆（设置被整体重置时用）。 */
    refresh,

    /**
     * 某块此刻是否参与摆放 —— 由**块自己的主人**在可见性变化时调用。
     *
     * 为什么需要：有些块会自我隐身（空书签栏 / 「仅新标签页显示」模式下，书签栏是
     * `display:none`）。它若仍登记在容器里，就会占着**一行空行** —— 容器的布局与
     * 容器级留白（底部那道呼吸空隙）都会按「这里有一块 bar」来算，于是出现
     * 「底部一块 bar 都没有，却还留着一条边距」。
     *
     * 幂等且零副作用：可见性没变时连容器的重摆都不会发生（见 registerBlock）。
     * 只该用于「自己会隐身」的块；标题栏的开关由 apply() 按摆放计划统一处理。
     * @param {string} id
     * @param {boolean} visible
     * @returns {boolean} 是否真的发生了变化 —— 变了才需要重新上报顶/底占高
     *   （容器高度跟着变了，主进程那份 bounds 参数必须跟上）。
     */
    setBlockVisible(id: string, visible: boolean) : boolean {
      const block = Object.prototype.hasOwnProperty.call(blocks, id)
        ? blocks[id as keyof typeof blocks]
        : null
      if (!block) return false
      if (id === 'bookmarkbar') ownerVisibility.bookmarkbar = visible !== false
      const el = 'element' in block ? block.element : block
      return registerBlock(id, editingMode || visible !== false ? el : null)
    },

    /** 临时进入“全展开”编辑展示态；不改用户布局设置。 */
    setEditing(on: boolean) {
      const next = on === true
      if (next === editingMode) return false
      editingMode = next
      apply()
      return true
    },

    /**
     * 换掉某块的**代表元素**（宿主切换）。
     *
     * 同一块在不同区域可能是两种呈现（横向标签条 ⇄ 纵向标签列），由与它同源的两个
     * 组件分别提供 —— 控制器只负责登记「此刻住进布局的是哪一个」，不认识它们的内部。
     * 幂等：元素没变则什么都不做（见 registerBlock）。
     * @param {string} id
     * @param {HTMLElement|null} el
     * @returns {boolean} 是否真的发生了变化
     */
    setBlockElement(id: string, el: HTMLElement|null) : boolean {
      return registerBlock(id, el || null)
    },

    /**
     * 灌入当前网页的标题与站点图标（活动标签变化 / 页面标题变化时由 app-shell 调用）。
     *
     * 两件事分开、都不省：
     *   · 标题栏块（若启用）→ 显示图标 + 文本；
     *   · 原生窗口标题 → **始终**更新（标题栏关着也要管，那是任务栏上的一行）。
     * @param {{ title?: unknown, favicon?: unknown }} [info]
     */
    setPageInfo(info?: { title?: unknown, favicon?: unknown }) {
      const src = info || {}
      pageTitle = src.title == null ? '' : String(src.title)
      pageFavicon = src.favicon == null ? '' : String(src.favicon)
      if (plan && plan.titlebarEnabled && titlebar) {
        titlebar.setPageInfo({ title: pageTitle, favicon: pageFavicon })
      }
      pushWindowTitle()
    },

    /**
     * 侧栏「悬停唤出」态（主进程贴边巡看推下来的运行期状态）。
     *
     * 只把宽度口径从 restWidth 切到 revealWidth，别的一概不动 —— 侧栏 DOM 不重建、
     * 不搬动，所以唤出时网页是**真的让位**（见 ui-chrome-layout#setSideReveal）。
     * @param {boolean} revealed
     */
    setSideReveal(revealed: boolean) {
      if (typeof chromeLayout.setSideReveal === 'function') chromeLayout.setSideReveal(revealed === true)
    },

    /** 布局设置键清单（调用方订阅 settings:changed 时用来过滤）。 */
    keys: LAYOUT_SETTING_KEY_LIST,

    /** 是否关心这个键（与 keys 同源，避免调用方再抄一遍字符串）。 */
    handles: (key: string) => LAYOUT_SETTING_KEY_LIST.includes(key as LayoutSettingKey)
  }
}

