// @ts-check
/**
 * @hira-ng/ui-findbar —— 页内查找栏（查找栏浮层的**哑组件**）
 *
 * ── 边界（彻底解耦）────────────────────────────────────────────────
 *   进来：一个查询串 + 一组匹配计数；
 *   出去：`ctx` 上的**意图回调**（onQuery / onNext / onPrev / onClose）。
 * 本模块不认识 IPC、不认识 webContents、不认识浮层 —— 谁把 `findInPage` 打出去、
 * 结果是哪来的、浮层何时开合，全是宿主（findbar-overlay 渲染页 + 主进程控制器）的事。
 * 因此它可以被任何宿主复用，也可以在测试里单独驱动（`setResult` 喂数据即可）。
 *
 * ── 视觉 ───────────────────────────────────────────────────────────
 * 与 chrome 其余浮层（建议下拉、标签预览）同一套设计令牌：底色 `--hira-bg-elevated`、
 * 描边 `--hira-border-subtle`、文本 `--hira-text-primary/secondary/tertiary`、
 * hover `--hira-hover-bg`、无命中警示 `--hira-warn`。**深浅主题不需要本模块任何
 * 专属覆盖规则** —— 那几条令牌本身就是主题变量，深色由 `tokens-dark.css` 翻转，
 * 这里只消费。唯一按主题分叉的是投影（投影不是"颜色令牌"而是"两套明暗下的不同物理
 * 参数"），它在文件末尾按现有深色选择器各写一份。
 *
 * ── 计数是**渐进**的（不是"等结果全出来才显示"）────────────────────────
 * Chromium 的 `found-in-page` 是**逐条**报的：扫到第 N 个匹配就发一次事件，`matches`
 * 一路往上爬，最后一条才带 `finalUpdate`。所以这里**一拿到非零计数就先显示**
 * （`n/matches` 会随着扫描不停往上堆），只有"还不知道有没有命中"时才显示 `…`，
 * 而"无结果"只在**确定扫完且为 0** 时才出现。反过来做（`…` 挂到 finalUpdate）
 * 会让用户觉得"非得再按一下回车才出数字"。
 *
 * ── 为什么计数区要吃掉键盘事件 ──────────────────────────────────────
 * 这个 UI 住在一个**独立 WebContentsView** 里（网页是原生视图、盖在 chrome 之上，
 * 所以它必须是独立视图），于是 chrome 侧统一注册的快捷键（Ctrl+F / F3 / Ctrl+E）
 * 在这里**收不到** —— 本模块因此自己处理 Esc / Enter / F3 / Ctrl+F，
 * 并**阻止冒泡**，免得同一次按键在被转发回外壳时又被当成全局快捷键执行一次。
 */

import { Search, ChevronDown, X } from '@hira-ng/ui-common'

const STYLE_ID = 'hira-findbar-styles'

/**
 * 浮层视图比胶囊本身多出来的四周留白（投影扩散范围）。
 * 宿主按「胶囊尺寸 + 2×本值」上报 view 尺寸，胶囊自己按本值内缩定位。
 */
export const FINDBAR_SHADOW_PAD = 18

export interface FindQueryOptions {
  forward: boolean
  findNext: boolean
}

export interface FindbarOptions {
  onQuery?: (text: string, options: FindQueryOptions) => void
  onNext?: (text: string) => void
  onPrev?: (text: string) => void
  onClose?: () => void
}

export interface FindbarResult {
  matches: number
  activeMatchOrdinal: number
  finalUpdate?: boolean
}

export interface FindbarController {
  readonly element: HTMLElement
  setQuery(text: string): void
  setResult(result: Partial<FindbarResult>): void
  focus(options?: { select?: boolean }): void
  setShown(shown: boolean): void
  measure(): { width: number; height: number }
  destroy(): void
}

export function injectFindbarStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* 浮在**网页上方**的一枚胶囊（对齐 RT 的查找栏：不占位、不挤网页）。
       位置由宿主给（left/top 内缩 FINDBAR_SHADOW_PAD），对齐由主进程按网页矩形算。 */
    .hira-findbar {
      position: fixed;
      display: flex; align-items: center; gap: 3px;
      box-sizing: border-box;
      padding: 5px 6px 5px 8px;
      border-radius: var(--hira-theme-radius, 12px);
      background: var(--hira-bg-elevated, #f7f9fc);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
      box-shadow: var(--hira-findbar-shadow, 0 8px 24px rgba(0, 0, 0, 0.2));
      /* 唯一字体令牌（shared-types/theme.mjs#UI_FONT_STACK）；兜底串同值。 */
      font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
      font-size: 13px;
      color: var(--hira-text-primary, #1a1a1a);
      -webkit-font-smoothing: antialiased;
      /* 入场：位移 + 缩放 + 透明度，全在合成器上跑（不触发布局） */
      transform-origin: top right;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .hira-findbar:focus-within {
      border-color: var(--hira-accent-soft-strong, rgba(0, 0, 0, 0.2));
      box-shadow: var(--hira-findbar-focus-shadow, 0 10px 28px rgba(0, 0, 0, 0.24));
    }
    .hira-findbar.is-shown { animation: hira-findbar-in 140ms cubic-bezier(0.2, 0.8, 0.3, 1); }
    @keyframes hira-findbar-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .hira-findbar.is-shown { animation: none; }
    }

    .hira-findbar__icon {
      display: flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; flex-shrink: 0;
      margin: 0 1px 0 2px;
      color: var(--hira-text-tertiary, #9ca3af);
    }
    .hira-findbar__input {
      width: 230px;
      height: 32px;
      padding: 0 11px;
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
      border-radius: 9px;
      outline: 0;
      background: var(--hira-bg-surface, rgba(255, 255, 255, 0.72));
      color: inherit;
      font: inherit;
      /* 输入框自带的行高会让整条高度浮动，钉死避免"打字时整条跳 1px" */
      line-height: 30px;
      box-sizing: border-box;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .hira-findbar__input:focus {
      border-color: var(--hira-accent-soft-strong, rgba(0, 0, 0, 0.18));
      background: var(--hira-bg-surface, #fff);
    }
    .hira-findbar__input::placeholder { color: var(--hira-text-tertiary, #9ca3af); }
    /* 没命中：输入文字切警示色（对齐 Chrome 的橙红），底色不变（不喧宾夺主） */
    .hira-findbar.is-empty .hira-findbar__input { color: var(--hira-warn, #d97706); }

    .hira-findbar__count {
      min-width: 56px; padding: 0 6px;
      text-align: center; white-space: nowrap;
      color: var(--hira-text-secondary, #6b7280);
      font-variant-numeric: tabular-nums;
      user-select: none;
    }
    .hira-findbar.is-empty .hira-findbar__count { color: var(--hira-warn, #d97706); }

    .hira-findbar__btn {
      display: flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; flex-shrink: 0;
      border: 0; padding: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      cursor: pointer;
      transition: background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
                  color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .hira-findbar__btn:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.05)); color: var(--hira-text-primary, #1a1a1a); }
    .hira-findbar__btn:focus-visible {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: 1px;
    }
    .hira-findbar__btn:disabled { opacity: 0.35; cursor: default; }
    .hira-findbar__btn:disabled:hover { background: transparent; color: var(--hira-text-secondary, #6b7280); }
    /* 上一个 = 下一个图标转 180°（同一枚图标，两个方向 —— 少一份资源、不会画歪） */
    .hira-findbar__btn--prev svg { transform: rotate(180deg); }
  `
  doc.head.appendChild(style)
  // 投影：唯一按主题分叉的一项（深色下同样的投影在深底上"糊"成一块，必须加深、拉大）
  const shadow = doc.createElement('style')
  shadow.textContent = `
    :root {
      --hira-findbar-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      --hira-findbar-focus-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
    }
    body.dark, body.dark-mode, html[data-theme='dark'] {
      --hira-findbar-shadow: 0 10px 30px rgba(0, 0, 0, 0.58);
      --hira-findbar-focus-shadow: 0 12px 34px rgba(0, 0, 0, 0.66);
    }
  `
  doc.head.appendChild(shadow)
}

/** 创建查找栏；所有检索动作通过 ctx 端口交给宿主。 */
export function createFindbar(doc: Document, ctx: FindbarOptions = {}): FindbarController {
  const root = doc.createElement('div')
  root.className = 'hira-findbar'

  const icon = doc.createElement('span')
  icon.className = 'hira-findbar__icon'
  icon.appendChild(Search(doc, { size: 16 }))
  root.appendChild(icon)

  const input = doc.createElement('input')
  input.className = 'hira-findbar__input'
  input.type = 'text'
  input.placeholder = '在页面中查找'
  input.setAttribute('aria-label', '在页面中查找')
  input.spellcheck = false
  input.autocomplete = 'off'
  // 输入框自身不能吃掉整条上的点击（点空白处不该把焦点从输入框挪走）
  input.addEventListener('mousedown', (e) => e.stopPropagation())
  root.appendChild(input)

  const count = doc.createElement('span')
  count.className = 'hira-findbar__count'
  count.textContent = ''
  root.appendChild(count)

  const btnPrev = makeButton(doc, 'prev', '上一个匹配项 (Shift+Enter)', ChevronDown(doc, { size: 17 }))
  const btnNext = makeButton(doc, 'next', '下一个匹配项 (Enter)', ChevronDown(doc, { size: 17 }))
  const btnClose = makeButton(doc, 'close', '关闭 (Esc)', X(doc, { size: 16 }))
  root.appendChild(btnPrev)
  root.appendChild(btnNext)
  root.appendChild(btnClose)

  /** 本次查找会话**已知**的匹配数（渐进：随扫描往上爬，见 refresh 的说明） */
  let matches = 0
  let activeOrdinal = 0
  /** 最近一次**已发出去**的查询串（去重基准，见 emitQuery） */
  let query = ''
  /**
   * 「查询已发出、还没有任何命中报回来」。
   *
   * 注意它**不**等于"结果还没出来"：Chromium 会边扫边报，`matches` 一到非零就
   * 直接显示数字（见 refresh）。这个标记只负责区分两种 0：
   *   · `pending` 且 0 命中 → `…`（还不知道）
   *   · 扫完仍 0（`!pending`）→ "无结果"
   */
  let pending = false
  /** 输入法组合中（拼音还没上屏）—— 组合期间不发起检索：拼音串没有检索价值。 */
  let composing = false

  function refresh() {
    const hasQuery = query.length > 0
    const empty = hasQuery && !pending && matches === 0
    root.classList.toggle('is-empty', empty)
    if (!hasQuery) count.textContent = ''
    // ① 已知有命中 → 直接摆数字（扫描中还会继续涨，这正是"慢慢堆上去"）
    else if (matches > 0) count.textContent = `${activeOrdinal || 1}/${matches}`
    // ② 还没有任何命中报回来 → 等待
    else if (pending) count.textContent = '…'
    // ③ 扫完了仍然是 0 → 无结果
    else count.textContent = '无结果'
    // 导航按钮：没有查询串或还没有任何命中时不可点（此时"下一个"没有意义）。
    // 刻意**不**因为"还在扫"而禁用 —— 计数可以边涨边点下一个（Chrome 同款）。
    const noNav = !hasQuery || matches === 0
    btnPrev.disabled = noNav
    btnNext.disabled = noNav
  }

  function makeButton(d: Document, act: string, title: string, svg: Node): HTMLButtonElement {
    const b = d.createElement('button')
    b.type = 'button'
    b.className = `hira-findbar__btn hira-findbar__btn--${act}`
    b.title = title
    b.setAttribute('data-act', act)
    b.tabIndex = -1 // 不用 Tab 停在这排按钮上：键盘上下应由 Enter/Shift+Enter 承担
    b.appendChild(svg)
    return b
  }

  /**
   * 计算「查什么」并上报意图。输入变化走这条；导航按钮不走（它们要 findNext）。
   *
   * **输入即检索**（对齐 Hira `pages/findBar/findBarRenderer.js`：input 直接发查）：
   * 不做去抖、不等回车、不等输入法上屏 —— 每敲一个字符就发一次。
   */
  function emitQuery(findNext: boolean) {
    const next = input.value
    // 同一串不重复发起：`compositionend` 与紧随其后的 `input` 会各来一次，
    // 两次"新搜索"只会互相取消（白扫两遍、结果还慢一拍）。导航（findNext）不受此限。
    if (!findNext && next === query) return
    query = next
    if (!query) {
      matches = 0
      activeOrdinal = 0
      pending = false
    } else {
      // ⚠ **不清空已知计数**（Chrome 同款）：新查询已经发出但结果还没回来时，计数区
      // 继续显示**上一次的数字**，等新结果到达再换成新数字。
      // 反过来做（清空 + 显示 `…`）会让每个按键都把数字抹掉、几百毫秒后才重现 ——
      // 用户感受就是"不按回车就看不到数量"。只有**第一次**输入（本来就没有旧数字）
      // 才真的只能显示 `…`，那一次是全页扫描的固有耗时。
      pending = true
    }
    // 先在本地把状态画出来（等结果回来再画一次），然后才把意图交出去 ——
    // 顺序反了会出现"结果比状态先到"的竞态。
    refresh()
    if (typeof ctx.onQuery === 'function') ctx.onQuery(query, { forward: true, findNext: !!findNext })
  }

  /**
   * 关闭：交出去即可。
   * （「撤掉挂起的检索」这件事不在渲染层做 —— 浮层这个 WebContentsView 的定时器
   *   会被 Chromium 节流，靠它兜底只会时灵时不灵；收尾全部由主进程侧收口。）
   */
  function requestClose() {
    if (typeof ctx.onClose === 'function') ctx.onClose()
  }

  /**
   * 输入：**同步**把意图交出去。
   *
   * ⚠ 这里**不能**用 `setTimeout` 做去抖/延后：本组件住在一个常驻 0×0 的
   * WebContentsView 里，Chromium 对这类页面的定时器会**节流甚至暂停** ——
   * 依赖定时器的链路会时灵时不灵（表现正是"输入了没反应，按回车才动"：
   * 回车走的是同步的 keydown 路径，不吃节流）。合并连续输入是主进程的事
   * （见 main/find-bar.js：扫描期间只记最新文本，扫完立刻发那一次）。
   */
  input.addEventListener('input', (e: Event) => {
    // 组合中的每一次按键只是拼音串在变（拿它去搜必然 0 结果，却会让真实扫描
    // 被取消重开）。上屏那一次由 compositionend 立即检索。
    if (composing || (e as InputEvent).isComposing) return
    emitQuery(false)
  })

  /**
   * 上屏 = **"输入"真正发生的时刻**，立即检索。
   *
   * `compositionend` 之后并非所有输入法都会再补一个 `input` 事件，
   * 少了这一下，中文/日文上屏那一次就可能没人发查 —— 表现正是"打完字却没结果"。
   */
  input.addEventListener('compositionstart', () => { composing = true })

  input.addEventListener('compositionend', () => {
    composing = false
    // **同步**读：compositionend 触发时 value 已经是上屏后的最终串（Chromium 保证）。
    // 若个别输入法还要再补一个 input 事件，那一次会被 emitQuery 的同串去重挡住。
    emitQuery(false)
  })

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    // 本组件自己吃完这一组键：它住在一个**独立 WebContentsView** 里（浮层），
    // 而主进程的 keybindings 只挂在外壳与标签的 webContents 上 —— 在这里不处理，
    // Esc / Enter / F3 就完全没人管。
    //
    // 但**输入法组合中的按键属于输入法**，一概不抢：上屏用的那个回车（isComposing）
    // 若被当成"下一个匹配"，打中文时每上屏一次就跳一次；取消组字的那个 Esc 若被
    // 当成"关闭"，用户只是想撤销拼音却把整个查找栏关了。
    if (e.isComposing || composing) return
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      requestClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      step(!e.shiftKey)
      return
    }
    // ↑/↓：上一个 / 下一个匹配（对齐 Chrome 的查找栏）。
    // 单行输入框里上下键本来没有意义（既不移动光标也不翻历史），占用它不会抢走
    // 任何既有行为；且它与 Enter/Shift+Enter 走**同一条** step()，两套键位不会各写一份逻辑。
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation()
      step(true)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      step(false)
      return
    }
    if (e.key === 'F3') {
      e.preventDefault(); e.stopPropagation()
      step(!e.shiftKey)
      return
    }
    // Ctrl+F：已在查找栏里 → 全选已有内容（Chrome 同款：连按两次 = 重新输入）
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); e.stopPropagation()
      input.select()
    }
  })

  /**
   * 步进到上/下一个匹配。**把当前查询串一起交出去** —— 宿主发 `findInPage` 时必须
   * 带上它，而"当前串"的真源在输入框里（宿主手里只有上一次 query 的副本，容易过时）。
   *
   * 与 Enter/Shift+Enter 走**同一条** step()：键位再多也不会各写一份导航逻辑。
   * 立即生效 —— 导航是对**既有结果集**的步进（实测 1–3ms），不需要也不该排队。
   */
  function step(forward: boolean) {
    const text = input.value
    if (!text) return
    query = text
    if (forward) { if (typeof ctx.onNext === 'function') ctx.onNext(text) }
    else if (typeof ctx.onPrev === 'function') ctx.onPrev(text)
  }

  btnPrev.addEventListener('mousedown', (e) => e.preventDefault()) // 别把焦点从输入框抢走
  btnNext.addEventListener('mousedown', (e) => e.preventDefault())
  btnClose.addEventListener('mousedown', (e) => e.preventDefault())
  btnPrev.addEventListener('click', () => step(false))
  btnNext.addEventListener('click', () => step(true))
  btnClose.addEventListener('click', () => requestClose())

  // root 自己也吃掉 Esc：焦点可能在按钮上（用户点了下一条又按 Esc）
  root.addEventListener('keydown', (e) => {
    // 同输入框那条守卫：组合中的 Esc 是"取消组字"，不能当成关闭
    // （输入框那条在组合时是直接 return 的，事件会继续冒泡到这里）。
    if (e.isComposing || composing) return
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      requestClose()
    }
  })

  refresh()

  return {
    element: root,

    /** 用外部值回填输入框（Ctrl+F 重开时恢复上次的查询串）。不触发查询。 */
    setQuery(text: string) {
      const next = String(text == null ? '' : text)
      if (next === input.value) return
      input.value = next
      query = next
      matches = 0
      activeOrdinal = 0
      pending = false
      refresh()
    },

    /** 喂入匹配计数（来自 Chromium 的 found-in-page，**渐进到达**，可能来很多次）。 */
    setResult(result: Partial<FindbarResult>) {
      const r = result || {}
      matches = Number(r.matches) || 0
      activeOrdinal = Number(r.activeMatchOrdinal) || 0
      query = input.value
      // 只有「这次扫描到此为止」的那一条（finalUpdate）才算定论。中途那条即使报 0
      // 也不能宣布"无结果" —— Chromium 边扫边报，早期完全可能先给一个 0。
      // 反过来，中途只要已经报了非零命中，refresh 会立刻把数字摆出来（数字会继续爬）。
      pending = !r.finalUpdate
      refresh()
    },

    /**
     * 拿焦点并把已有内容全选 —— 打开查找栏时调用。
     * `select: false` 用于「只是把焦点要回来」（例如从网页点回查找栏）。
     */
    focus(opts: { select?: boolean } = {}) {
      input.focus()
      if (opts.select !== false) {
        try { input.select() } catch (_) {}
      }
    },

    /** 显隐切换（重播入场动效）。view 本身由主进程按 bounds 收起，这里只做视觉。 */
    setShown(shown: boolean) {
      const on = Boolean(shown)
      root.classList.toggle('is-shown', on)
      // 重播关键帧：先移除类、强制一次样式失效、再加回来
      if (on) {
        root.classList.remove('is-shown')
        void root.offsetWidth
        root.classList.add('is-shown')
      }
    },

    /** 胶囊自身的实际尺寸（宿主据此 + 2×FINDBAR_SHADOW_PAD 上报 view 尺寸）。 */
    measure() {
      const r = root.getBoundingClientRect()
      return { width: Math.ceil(r.width), height: Math.ceil(r.height) }
    },

    destroy() {
      root.remove()
    }
  }
}

/**
 * 浮层宿主用的插件式定义（与 `@hira-ng/ui-panel-*` 的 `panelDefinition` 同形）。
 * 宿主只需 `injectStyles(doc)` + `mount(doc, ctx)`；将来要换宿主（另一种窗口形态、
 * 甚至独立窗口）时不必改本模块一行。
 */
export const findbarDefinition = {
  id: 'findbar',
  injectStyles: injectFindbarStyles,
  mount(doc: Document, ctx: FindbarOptions = {}) {
    return createFindbar(doc, ctx)
  }
}
