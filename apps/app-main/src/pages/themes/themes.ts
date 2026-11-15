// @ts-check
/**
 * 主题 · 内部页入口（`hira://themes`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三个视图，一个入口
 * ══════════════════════════════════════════════════════════════════════
 *   主题库  左：分组卡片列表（内置 / 我的主题 / 插件主题）
 *           右：**迷你浏览器窗口预览** + 编辑器表单（点卡片 = 应用并进入编辑）
 *   调度    不切换 / 跟随系统 / 白天夜间（21:00–06:00）/ 手动时段表
 *   私密窗口  私密窗口专用主题（'' = 与普通窗口相同）
 *
 * 为什么库与编辑器**同屏**（而不是像 Vivaldi 那样分两页）：编辑主题时最需要的
 * 是"立刻看到它在窗口里长什么样" —— 同屏才能"改一下、看一眼"地迭代；
 * 分页会逼用户来回切，而切换本身不产生任何信息。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 视图只做两件事
 * ══════════════════════════════════════════════════════════════════════
 *   ① 把内核给的状态画出来（`setCatalog` / `setDraft` / `setSchedule` …）
 *   ② 把用户的意图发出去（`emit({ type: … })`）—— 本文件**不认识**任何 IPC 通道
 *
 * 于是"页面里做的事"与"面板里做的事"必然一致：两者共用同一个内核
 * （`packages/shared-types/src/themes/core.js`），换主题 / 保存 / 调度都是同一段代码，
 * 差别只在画了多少控件。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 编辑器的重建 vs 更新（一个必须分清的细节）
 * ══════════════════════════════════════════════════════════════════════
 * 内核每次改草稿都会 `setDraft(newDraft, meta)`，而 `newDraft` 每次都是**新对象**
 * —— 所以不能用"对象变了"当"要重建表单"的判据，否则用户拖一次滑杆表单就被重建，
 * 焦点丢掉、拖动中断。判据是 `meta.session`：只有内核**另开一份草稿**时它才变，
 * 那时才重建；其余情况只把值写回控件（`update`）。
 */

import { initTheme, pageUrl, rpc, subscribe } from 'hira://shared/runtime.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createThemesController } from '@hira-ng/shared-types/src/themes/core.js'
import { createThemeClient } from '@hira-ng/shared-types/src/themes/client.js'
import { injectSharedStyles } from '@hira-ng/shared-types/src/themes/styles.js'
import { el, clear, button, sectionTitle, groupBlock } from '@hira-ng/shared-types/src/themes/dom.js'
import { themeCard, textRow, segmented, selectRow, valueRow, sliderRow, colorRow, checkboxRow, inlineSelect, assetRow } from './parts.js'
import type { ThemeSummary } from './parts.js'
import { createPreview } from './preview.js'
import { injectPageStyles } from './styles.js'
import type { ThemeBackground, ThemeData, ThemeSchedule, ThemeStyle } from '@hira-ng/shared-types/src/theme.js'
import type { ThemeOption } from './parts.js'
import {
  COLOR_FIELDS,
  STYLE_SLIDERS,
  THEME_MODE_OPTIONS,
  COLORIZE_MODES,
  WINDOW_MATERIALS,
  WINDOW_MATERIAL_UNSUPPORTED_HINT,
  BACKGROUND_KINDS,
  BACKGROUND_POSITIONS,
  BACKGROUND_SLIDERS,
  resolveVeilColor,
  resolveChromeOverlay,
  resolveChromeOverlayColor,
  resolveChromeFg,
  resolvePanelFg,
  resolveWebSidebarFg,
  resolvePanelOverlay,
  materialHint,
  MATERIAL_RECOMMENDED,
  hasMaterialTuning,
  AUTO_FG_KEYS,
  AUTO_FG,
  anyForegroundAuto,
  supportsAutoFg,
  VIDEO_FG_HINT,
  SCHEDULE_MODES,
  NIGHT_RANGE_TEXT,
  DEFAULT_GRADIENT,
  parseGradient,
  buildGradient,
  toHexInput,
  draftName
} from '@hira-ng/shared-types/src/themes/format.js'

/** 视图名（与顶部三段控件一一对应）。 */
const VIEWS = [
  { value: 'library', label: '主题库' },
  { value: 'schedule', label: '调度' },
  { value: 'private', label: '私密窗口' }
]

/**
 * "**生效值可能 ≠ 草稿原值**"的控件解析器表（唯一一处）。
 *
 * 这些控件的显示值必须取自共享层的 resolver（与主进程算 CSS 用的是同一份），
 * 否则就会重演那类"看到的是 A、实际生效是 B、于是怎么调都没反应"的假象
 * （遮罩色吃过一次、UI 前景也会吃）。表里没有的键 = 原值直接显示。
 */
const EFFECTIVE_VALUE: {
  colors: Record<string, (theme: ThemeData) => string>
  style: Record<string, (theme: ThemeData) => number>
} = {
  colors: {
    chromeFg: resolveChromeFg,
    panelFg: resolvePanelFg,
    webSidebarFg: resolveWebSidebarFg
  },
  style: {
    chromeOverlay: resolveChromeOverlay,
    panelOverlay: resolvePanelOverlay
  }
}

function themeStyleValue(style: ThemeStyle, key: string): unknown {
  return (style as unknown as Record<string, unknown>)[key]
}

function themeBackgroundValue(background: ThemeBackground, key: string): unknown {
  return (background as unknown as Record<string, unknown>)[key]
}

/** 下拉用的主题选项（`theme` 为空时给"不指定"的占位项）。 */
function themeOptions(themes: unknown, emptyLabel = ''): ThemeOption[] {
  const opts = (Array.isArray(themes) ? themes : []).flatMap((value): ThemeOption[] => {
    if (!value || typeof value !== 'object') return []
    const theme = value as ThemeSummary
    if (!theme.id) return []
    return [{ value: theme.id, label: theme.name || theme.id }]
  })
  if (emptyLabel) return [{ value: '', label: emptyLabel }, ...opts]
  return opts
}

/** 小时下拉（0~23）。 */
function hourOptions(): ThemeOption[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: `${String(hour).padStart(2, '0')}:00`
  }))
}

/**
 * @param {Document} doc
 * @param {{ emit: (intent: unknown) => void, confirm?: Function }} ports
 */
interface ThemeViewPorts {
  emit: (intent: Record<string, unknown>) => unknown
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean>
}

interface ThemeMeta {
  editable?: boolean
  session?: number
}

type ScheduleEntry = ThemeSchedule['entries'][number]
type ThemeEditor = ReturnType<typeof buildEditor>
type ThemesController = ReturnType<typeof createThemesController>

export function createThemePageView(doc: Document, { emit }: ThemeViewPorts) {
  const wrap = el(doc, 'div', 'thm-root thm-win')

  // ── 顶部工具条 ─────────────────────────────────────────────────────
  const bar = el(doc, 'div', 'thm-bar')
  const seg = segmented(doc, VIEWS, 'library', (value) => showView(value))
  const newBtn = button(doc, '新建主题', { variant: 'ghost', title: '以当前主题为起点新建', onClick: () => emit({ type: 'new-theme' }) })
  const importBtn = button(doc, '导入主题…', { variant: 'ghost', title: '导入主题包（.zip，兼容 Vivaldi 主题包）', onClick: () => emit({ type: 'import' }) })
  const refreshBtn = button(doc, '重新扫描', { variant: 'ghost', title: '重新扫描主题来源（含插件）', onClick: () => emit({ type: 'refresh' }) })
  const busyText = el(doc, 'span', 'thm-editor__note')
  bar.append(seg.element, newBtn, importBtn, refreshBtn, el(doc, 'div', 'thm-bar__spacer'), busyText)

  // ── 主题库 ─────────────────────────────────────────────────────────
  const libView = el(doc, 'div', 'thm-win__views')
  libView.dataset.view = 'library'
  const lib = el(doc, 'div', 'thm-lib')
  const libList = el(doc, 'div', 'thm-lib__list')
  const libSplit = el(doc, 'div', 'thm-lib__split')
  libSplit.setAttribute('role', 'separator')
  libSplit.title = '拖动调整两栏宽窄'
  const libSide = el(doc, 'div', 'thm-lib__side')
  lib.append(libList, libSplit, libSide)
  libView.appendChild(lib)

  /**
   * 两栏分隔条（拖拽改宽）。
   *
   * 与侧栏面板那根拖拽手柄的区别：那边必须用 `screenX`（面板视图的 x 会随宽度变，
   * clientX 恒接近 0 → 抖动）；**本窗口的分隔条在同一个视图内左右移动**，
   * clientX 就是屏幕位移 —— 用 clientX 更简单也更直接。
   * 宽度写在 `.thm-lib` 的 `--thm-list-w` 上（一次写、两栏自动分账），
   * 每帧最多写一次（拖拽期 mousemove 的频率远高于一次布局重算的成本）。
   */
  const LIST_MIN = 240
  const LIST_MAX = 720
  let splitDragging = false
  let splitStartX = 0
  let splitStartW = 0
  let splitPending = 0
  let splitFrame = 0
  const applySplitWidth = () => {
    splitFrame = 0
    if (!splitPending) return
    lib.style.setProperty('--thm-list-w', `${splitPending}px`)
    splitPending = 0
  }
  libSplit.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    splitDragging = true
    splitStartX = e.clientX
    splitStartW = libList.getBoundingClientRect().width
    libSplit.dataset.dragging = '1'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!splitDragging) return
    const next = Math.max(LIST_MIN, Math.min(LIST_MAX, splitStartW + (e.clientX - splitStartX)))
    splitPending = next
    if (!splitFrame) splitFrame = requestAnimationFrame(applySplitWidth)
  })
  const endSplit = () => {
    if (!splitDragging) return
    splitDragging = false
    delete libSplit.dataset.dragging
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (splitFrame) {
      cancelAnimationFrame(splitFrame)
      applySplitWidth()
    }
  }
  window.addEventListener('mouseup', endSplit)
  window.addEventListener('blur', endSplit)

  const preview = createPreview(doc)
  const editorHost = el(doc, 'div', 'thm-editor-host')
  const libHint = el(doc, 'div', 'thm-lib__hint', '点左侧任意主题卡片即可应用并编辑\n（内置与插件主题会以副本的形式编辑）')
  libSide.append(preview.element, editorHost, libHint)

  // ── 调度 ───────────────────────────────────────────────────────────
  const schedView = el(doc, 'div', 'thm-win__views')
  schedView.dataset.view = 'schedule'
  const schedPane = el(doc, 'div', 'thm-win__pane')
  const schedForm = el(doc, 'div', 'thm-form')
  schedPane.appendChild(schedForm)
  schedView.appendChild(schedPane)

  const schedDesc = el(doc, 'div', 'thm-form__desc')
  const schedMode = selectRow(
    doc,
    '切换方式',
    SCHEDULE_MODES.map((m) => ({ value: m.value, label: m.label })),
    'none',
    (value) => emit({ type: 'schedule-patch', patch: { mode: value } })
  )
  const schedLight = selectRow(doc, '浅色主题', [], '', (value) => emit({ type: 'schedule-patch', patch: { light: value } }))
  const schedDark = selectRow(doc, '深色主题', [], '', (value) => emit({ type: 'schedule-patch', patch: { dark: value } }))
  const schedNightHint = el(doc, 'div', 'thm-form__desc', `夜间窗口：${NIGHT_RANGE_TEXT}`)
  const entriesHost = el(doc, 'div', 'thm-rows')
  const entriesAdd = button(doc, '添加时段', { variant: 'ghost', onClick: () => emit({ type: 'schedule-entry-add' }) })
  schedForm.append(
    el(doc, 'div', 'thm-section-title', '主题调度'),
    schedDesc,
    schedMode.row,
    schedLight.row,
    schedDark.row,
    schedNightHint,
    entriesHost,
    entriesAdd
  )

  // ── 私密窗口 ───────────────────────────────────────────────────────
  const privView = el(doc, 'div', 'thm-win__views')
  privView.dataset.view = 'private'
  const privPane = el(doc, 'div', 'thm-win__pane')
  const privForm = el(doc, 'div', 'thm-form')
  privPane.appendChild(privForm)
  privView.appendChild(privPane)

  const privSelect = selectRow(doc, '私密窗口主题', [], '', (value) => emit({ type: 'private-set', id: value }))
  privForm.append(
    el(doc, 'div', 'thm-section-title', '私密窗口'),
    el(doc, 'div', 'thm-form__desc', '私密窗口（无痕窗口）单独使用一个主题，好让你一眼分辨"这扇窗不留痕迹"。选「与普通窗口相同」则跟随普通主题。'),
    privSelect.row
  )

  const status = el(doc, 'div', 'thm-status')

  wrap.append(bar, libView, schedView, privView, status)

  // ── 视图切换 ───────────────────────────────────────────────────────
  /** 当前视图名（切到主题库时才有必要刷新库——另两页不显示卡片）。 */
  let activeView = 'library'
  function showView(name: string) {
    activeView = VIEWS.some((v) => v.value === name) ? name : 'library'
    seg.setValue(activeView)
    for (const node of [libView, schedView, privView]) {
      node.dataset.active = node.dataset.view === activeView ? '1' : '0'
    }
  }
  showView('library')

  // ── 编辑器（按会话重建）────────────────────────────────────────────
  /** 当前的编辑器实例（`null` = 不在编辑）。 */
  let editor: ThemeEditor | null = null
  /** 当前编辑器对应的会话号（内核在另开草稿时会 +1）。 */
  let editorSession = -1

  function mountEditor(draft: ThemeData, meta: ThemeMeta = {}) {
    clear(editorHost)
    /**
     * 编辑器要用的两件**视图级能力**必须显式传进去：
     *   · `autoColorFor(key)` 读的是"草稿 + 壁纸实测亮度"（`draftLuminance` 在 setPreview 里更新）；
     *   · `colorControls` 是颜色行的控件表，`setPreview` 收到新亮度后要回头刷新那几行。
     * 两者都活在 createThemePageView 的闭包里，而 buildEditor 是模块级函数 ——
     * 靠隐式作用域抓是抓不到的（会 ReferenceError，被 call() 吞掉后表现为"编辑器打不开"）。
     */
    try {
      editor = buildEditor(doc, draft, meta, emit, { autoColorFor, colorControls })
    } catch (e) {
      // 构建失败必须**摆到脸上**：此前这类错误被 call() 静默吞掉，用户只看到"点了没反应"
      editor = null
      editorSession = -1
      console.error('[themes] 编辑器构建失败：', e)
      const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
      editorHost.appendChild(el(doc, 'div', 'thm-note thm-note--warn', `编辑器构建失败：${message}`))
      libHint.style.display = 'none'
      return
    }
    editorHost.appendChild(editor.element)
    libHint.style.display = 'none'
    editorSession = meta && typeof meta.session === 'number' ? meta.session : editorSession
  }

  function unmountEditor() {
    editor = null
    editorSession = -1
    clear(editorHost)
    libHint.style.display = ''
  }

  // ── 状态落地（内核调用的方法）──────────────────────────────────────
  interface ThemeGroup { label: string; themes: ThemeSummary[]; source?: string; id?: string }
  interface ThemeCatalog { themes: ThemeSummary[]; groups: ThemeGroup[]; activeId: string; privateId: string }
  let latest: ThemeCatalog = { themes: [], groups: [], activeId: '', privateId: '' }
  /**
   * 库列表**上一次画出来的**"当前主题 id"。
   *
   * 内核一次目录推送会连续调 `setCatalog` → `setActive` → `setPrivate`，而 setCatalog
   * 已经把"谁是当前主题"画进去了 —— 若 setActive 再整库重画一遍，每次 load 都是
   * 两倍的重建成本（卡片数 × 分组块）。这里记住画过的值，重复就一个节点都不动。
   */
  let renderedActiveId: string | null = null
  /** 上一次 `setCatalog` 收下的目录指纹（内容级，见下方判等）。 */
  let shownCatalog: string | null = null

  /**
   * 「插件主题」分组头部的出口。
   *
   * 主题插件的**安装 / 启停 / 验签**都在插件中心，这里只陈列它们贡献出来的主题 ——
   * 没有这个入口，用户看到"插件主题是空的"就只能靠猜"该去哪儿装"。
   * 落点带 `#theme-plugin` 深链，直接落在插件中心的「主题」板块，而不是让它再找一遍。
   */
  function pluginsPageAction() {
    return button(doc, '去插件页管理', {
      title: '打开插件中心的「主题」板块（安装 / 停用 / 验签主题插件）',
      onClick: () => { window.location.href = `${pageUrl('plugins')}#theme-plugin` }
    })
  }

  function renderLibrary() {
    renderedActiveId = latest.activeId
    clear(libList)
    const groups = latest.groups || []
    if (!groups.length) {
      libList.appendChild(el(doc, 'div', 'thm-empty', '没有可用主题。试试「重新扫描」或装一个主题插件。'))
      return
    }
    for (const group of groups) {
      const { block, body } = groupBlock(
        doc,
        `${group.label} · ${group.themes.length}`,
        group.source === 'plugin' ? { action: pluginsPageAction() } : {}
      )
      const frag = doc.createDocumentFragment()
      for (const theme of group.themes) {
        frag.appendChild(
          themeCard(doc, theme, {
            active: theme.id === latest.activeId,
            // 点卡片 = 应用 + 送进编辑器。两件事一起做的理由：用户点一张卡片想表达的
            // 就是"我想用这个（并看看它）"—— 分成两个入口只会让人先点错一次。
            onClick: (theme) => emit({ type: 'apply', id: theme.id || '' })
          })
        )
      }
      body.appendChild(frag)
      libList.appendChild(block)
    }
  }

  /** 主题集合变化后，三个"选主题"的下拉都要跟着换选项（否则新装的主题选不到）。 */
  let shownThemeOptions: string | null = null
  function renderThemeSelects() {
    const themes = latest.themes || []
    /* 选项指纹（id + 名字）：目录没变就不重建 3 × N 个 <option> —— 每次 load 都会走这里。 */
    const fingerprint = themes.map((theme) => `${theme.id || ''}\u0001${theme.name || ''}`).join('\u0002')
    if (fingerprint !== shownThemeOptions) {
      shownThemeOptions = fingerprint
      const opts = themeOptions(themes)
      schedLight.replaceOptions(opts)
      schedDark.replaceOptions(opts)
      privSelect.replaceOptions(themeOptions(themes, '与普通窗口相同'))
    }
    privSelect.setValue(latest.privateId || '')
  }

  /**
   * 当前草稿 + 它的**壁纸实测亮度** —— 「自动前景」那几行要显示"此刻会自动变成哪个色"。
   *
   * 亮度来自主进程的预览响应（`background.luminance`，见 main/theme-service.js）：
   * 与真正生效在浏览器界面上的那个数**同一份**，所以编辑器显示 = 实际生效。
   * 刚换图、主进程还在量的时候它是 null —— 那时自动档退回"按主题底色判"，
   * 与真实窗口同一口径（两边跑的是同一条 `autoFgFor`）。
   */
  let liveDraft: ThemeData | null = null
  let draftLuminance: number | null = null
  /** 颜色行的控件表（挂载时填）—— `setPreview` 收到亮度后要回头刷新那几行。 */
  const colorControls: Record<string, { setValue: (value: unknown) => void }> = {}

  /** 某一档前景在"自动"下此刻会取到什么色（给那一行显示用）。 */
  function autoColorFor(key: string): string {
    const t = liveDraft
    if (!t) return ''
    const opts = { wallpaperLuminance: draftLuminance }
    if (key === 'chromeFg') return resolveChromeFg(t, opts)
    if (key === 'panelFg') return resolvePanelFg(t, opts)
    if (key === 'webSidebarFg') return resolveWebSidebarFg(t, opts)
    return ''
  }

  // ── 手动时段表 ─────────────────────────────────────────────────────
  /**
   * 时段表的本地镜像：内核只收"整表"，所以增删都要在本地算出新表再上送。
   * 必须声明在 `return` 之前 —— 放 `return` 后面是不可达代码，`let` 永远不初始化，
   * `setSchedule` 一读就是 TDZ（Cannot access 'entries' before initialization）。
   */
  let entries: ScheduleEntry[] = []

  function renderEntries(list: unknown, visible: boolean) {
    entries = Array.isArray(list)
      ? list.filter((entry): entry is ScheduleEntry => entry != null && typeof entry === 'object').map((entry) => ({ ...entry }))
      : []
    clear(entriesHost)
    entriesHost.style.display = visible ? '' : 'none'
    entriesAdd.style.display = visible ? '' : 'none'
    if (!visible) return
    if (!entries.length) {
      entriesHost.appendChild(el(doc, 'div', 'thm-form__desc', '还没有时段。点「添加时段」后按需排列（自上而下命中即用）。'))
      return
    }
    entries.forEach((entry, index) => {
      const row = el(doc, 'div', 'thm-row')
      const themeSel = inlineSelect(doc, themeOptions(latest.themes || []), entry.theme || '', (value) => {
        entries[index] = { ...entries[index], theme: value }
        emit({ type: 'schedule-entries', entries })
      })
      themeSel.classList.add('thm-row__grow')
      const fromSel = inlineSelect(doc, hourOptions(), String(entry.from == null ? 0 : entry.from), (value) => {
        entries[index] = { ...entries[index], from: Number(value) }
        emit({ type: 'schedule-entries', entries })
      })
      const toSel = inlineSelect(doc, hourOptions(), String(entry.to == null ? 0 : entry.to), (value) => {
        entries[index] = { ...entries[index], to: Number(value) }
        emit({ type: 'schedule-entries', entries })
      })
      // 时段下拉只给两列宽度（一行要放"主题 + 起 + 至 + 止 + 移除"五项）
      fromSel.style.flex = '0 0 88px'
      toSel.style.flex = '0 0 88px'
      const sep = el(doc, 'span', 'thm-editor__note', '至')
      const del = button(doc, '移除', {
        variant: 'danger',
        onClick: () => emit({ type: 'schedule-entries', entries: entries.filter((_, i) => i !== index) })
      })
      row.append(themeSel, fromSel, sep, toSel, del)
      entriesHost.appendChild(row)
    })
  }

  return {
    element: wrap,

    /**
     * 切到「主题库」。
     *
     * 「新建主题」必须先把视图切回来：编辑器挂在主题库这一页里，若用户正停在
     * 「调度 / 私密窗口」，草稿建好了却画在 `display:none` 的容器里 ——
     * 表现就是"按了按钮完全没反应"。
     */
    showLibrary() {
      showView('library')
    },

    setCatalog({ themes, groups, activeId, privateId }: ThemeCatalog) {
      latest = { themes: themes || [], groups: groups || [], activeId: activeId || '', privateId: privateId || '' }
      /* 目录指纹：`theme:changed` 与"保存后重推"都会走这里，内容没变就不必重建整库。
         必须比**完整内容**（卡片配色也来自主题对象）—— 只比 id 会让"改了配色的自建主题
         保存后卡片还是旧色"。JSON 序列化对几十条摘要足够便宜，且不会漏字段。 */
      const fingerprint = [latest.activeId, latest.privateId, JSON.stringify(latest.themes)].join('\u0003')
      if (fingerprint !== shownCatalog) {
        shownCatalog = fingerprint
        renderLibrary()
      }
      renderThemeSelects()
    },

    setActive(theme?: ThemeSummary | null) {
      /* 内核紧跟在 setCatalog 之后调它，那时库已经画好了 → 同一个 id 直接返回。
         只有"调度半夜自动换了主题"这类**目录没重推**的变化才需要重画。 */
      const id = theme && theme.id ? String(theme.id) : latest.activeId
      if (id === renderedActiveId) return
      latest = { ...latest, activeId: id }
      if (activeView === 'library') renderLibrary()
    },

    setPrivate(id?: unknown) {
      privSelect.setValue(id || '')
    },

    setSchedule(schedule?: ThemeSchedule | null) {
      const s: ThemeSchedule = schedule || { mode: 'none', light: '', dark: '', entries: [] }
      schedMode.setValue(s.mode || 'none')
      const meta = SCHEDULE_MODES.find((mode) => mode.value === s.mode) || SCHEDULE_MODES[0]
      schedDesc.textContent = meta.hint
      schedLight.row.style.display = s.mode === 'system' || s.mode === 'night' ? '' : 'none'
      schedDark.row.style.display = s.mode === 'system' || s.mode === 'night' ? '' : 'none'
      schedNightHint.style.display = s.mode === 'night' ? '' : 'none'
      schedLight.setValue(s.light || '')
      schedDark.setValue(s.dark || '')
      renderEntries(s.entries || [], s.mode === 'manual')
    },

    setDraft(draft?: ThemeData | null, meta: ThemeMeta = {}) {
      if (!draft) {
        liveDraft = null
        unmountEditor()
        return
      }
      liveDraft = draft
      const session = meta && typeof meta.session === 'number' ? meta.session : -1
      // 会话变了 = 内核另开了一份草稿 → 重建表单；否则只把值写回（保住拖动与焦点）。
      if (!editor || session !== editorSession) mountEditor(draft, meta)
      else editor.update(draft, meta)
    },

    setPreview({ tokens, background, surface }: {
      tokens?: Record<string, string>
      background?: { luminance?: unknown; [key: string]: unknown }
      surface?: { material?: string; supported?: boolean } | null
    }) {
      if (tokens) preview.applyTokens(tokens)
      preview.applyBackground(background)
      // 「窗口材质」选了但机器给不出来 → 说出回退结果（见 format.js 的提示常量）
      if (editor && typeof editor.setSurface === 'function') editor.setSurface(surface)
      /* 壁纸亮度到了 → 刷新「自动」那几行显示的色（草稿值没变，变的是它此刻会算成什么）。
         不做这一步，换完图那几行会一直停在上一张图的取值上 —— 与真实窗口就对不上了。 */
      const lum = background && typeof background.luminance === 'number' ? background.luminance : null
      if (lum === draftLuminance) return
      draftLuminance = lum
      const c = (liveDraft && liveDraft.colors) || {}
      for (const key of AUTO_FG_KEYS) {
        const control = colorControls[key]
        if (control && typeof control.setValue === 'function') control.setValue(c[key] || '')
      }
    },

    setBusy(flag?: boolean) {
      busyText.textContent = flag ? '处理中…' : ''
    },

    setStatus(text?: string, kind?: 'ok' | 'error') {
      status.textContent = text || ''
      status.dataset.kind = kind || 'ok'
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 编辑器表单
// ══════════════════════════════════════════════════════════════════════

/**
 * 建一份编辑器表单，返回 `{ element, update(draft, meta) }`。
 *
 * 控件在建立时就把引用留在闭包里 —— 于是"更新显示"是纯赋值，不查选择器。
 *
 * @param {Document} doc
 * @param {unknown} draft
 * @param {unknown} meta
 * @param {(intent: unknown) => void} emit
 * @param {{ autoColorFor?: (key: string) => string, colorControls?: Record<string, unknown> }} [host]
 *   `autoColorFor`：某档前景在「自动」下此刻会算出的色（由视图注入，带最新壁纸亮度）；
 *   `colorControls`：颜色行控件表 —— 与视图共用**同一个对象**，视图收到新亮度后要回填。
 */
function buildEditor(
  doc: Document,
  draft: ThemeData,
  _meta: ThemeMeta,
  emit: (intent: Record<string, unknown>) => unknown,
  host?: {
    autoColorFor?: (key: string) => string
    colorControls?: Record<string, { setValue: (value: unknown) => void }>
  }
) {
  const root = el(doc, 'div', 'thm-editor')
  /** 颜色行控件表：由视图注入则共用，否则本地新建（独立使用时也不会炸）。 */
  const colorControls = (host && host.colorControls) || {}
  /** 「自动」前景的此刻取值：视图没注入时退回空串（控件自行按原值显示）。 */
  const autoColorFor = (host && host.autoColorFor) || (() => '')
  /**
   * 表单**当前**对应的草稿。
   *
   * 为什么需要它：控件在建立时就把回调留在了闭包里，而某些回调要看"别的字段当前是什么"
   * ——例如勾选框要把新值合并进已有的 `applyTo`。若读的是建立时捕获的那份 `draft`，
   * 连点两次就会用**旧的**集合去合并（第二次把第一次的勾选丢掉）。
   * 每次 `update()` 都刷新这一份，回调一律读它。
   */
  let latest: ThemeData = draft

  // 标题行：名字 + 明暗
  const head = el(doc, 'div', 'thm-bar')
  const nameRow = textRow(doc, '', draft.name || '', (value) => emit({ type: 'patch', section: 'name', key: 'name', value }), {
    placeholder: '主题名称'
  })
  nameRow.row.classList.add('thm-row__grow')
  const modeSeg = segmented(
    doc,
    THEME_MODE_OPTIONS,
    draft.mode || 'light',
    (value) => emit({ type: 'patch', section: 'mode', key: 'mode', value })
  )
  head.append(el(doc, 'span', 'thm-editor__title', '编辑主题'), nameRow.row, modeSeg.element)
  root.appendChild(head)

  // 颜色
  root.appendChild(sectionTitle(doc, '颜色'))
  /**
   * 「前景自动」总开关 —— 三档 UI 前景**一起**自动 / 一起手调。
   *
   * 为什么是总开关而不是三行各一个"自动"：三档（工具栏 / 面板 / 网页侧栏）压在
   * 同一张壁纸上，该取黑还是白由**同一份亮度**决定；每行一个开关只会产生
   * "这行开了那行没开"的互相矛盾状态，且"谁说了算"说不清。
   *
   * 开关不新增数据字段：真源仍是 `colors.*Fg = "auto"`（见 format.js#anyForegroundAuto）。
   *   · 开 → 三档一起写哨兵 `auto`，取色器与 hex 锁死，主进程按壁纸亮度取黑/白；
   *   · 关 → 三档写回**此刻自动算出的具体色**（不是清空），于是继续手调时看到的就是刚才那色。
   * 只在能量亮度的来源（图片 / 每日一图）、或主题里已存 auto 时出现
   * （见 syncBackgroundVisibility —— 后者保证"被锁死"时总有开关可关）。
   */
  const autoFg = checkboxRow(
    doc,
    '前景自动',
    [{ value: 'auto', label: '按壁纸明暗自动取黑/白' }],
    anyForegroundAuto(draft) ? ['auto'] : [],
    (_value, checked) => {
      const patch: Record<string, string> = {}
      for (const key of AUTO_FG_KEYS) patch[key] = checked ? AUTO_FG : (autoColorFor(key) || '')
      emit({ type: 'patch-many', section: 'colors', patch })
    },
    { hint: '三档一起锁死，关闭即手调' }
  )
  root.appendChild(autoFg.row)
  for (const field of COLOR_FIELDS) {
    const control = colorRow(
      doc,
      // 三档前景都可以是哨兵 auto：给它一个"此刻会自动算成什么色"的读取口（见 autoColorFor）
      AUTO_FG_KEYS.includes(field.key) ? { ...field, getAuto: () => autoColorFor(field.key) } : field,
      (draft.colors || {})[field.key] || '',
      (value) => emit({ type: 'patch', section: 'colors', key: field.key, value })
    )
    colorControls[field.key] = control
    root.appendChild(control.row)
  }

  // 外观
  root.appendChild(sectionTitle(doc, '外观'))
  /**
   * 着色模式 —— 只剩「全部统一着色」一档（见 `theme.mjs#COLORIZE_MODES`）。
   *
   * 为什么不再摆下拉：只含一个 option 的 select 点开与不点开完全一样，
   * 看起来就像"控件坏了"。这里改成一行**只读事实**，把这个口径说出来。
   * 判据是**数据**（选项数量），不是写死 `unified`：将来真加了第二档，
   * 这一行会自动长回下拉，视图不必跟着改。
   */
  const colorize = COLORIZE_MODES.length > 1
    ? selectRow(doc, '着色模式', COLORIZE_MODES, (draft.style || {}).colorizeMode || COLORIZE_MODES[0].value, (value?) =>
        emit({ type: 'patch', section: 'style', key: 'colorizeMode', value })
      )
    : valueRow(doc, '着色模式', COLORIZE_MODES[0].label, '主题色统一作用于标签栏、地址栏与面板')
  /**
   * 回写着色模式：下拉吃 id、只读行吃文案 —— 两种形态只差"取哪一列"，
   * 判据仍与上面建控件时同源（`COLORIZE_MODES.length`），不另立一套规则。
   */
  const syncColorize = COLORIZE_MODES.length > 1
    ? (mode: unknown) => colorize.setValue(mode ? String(mode) : COLORIZE_MODES[0].value)
    : (mode: unknown) => colorize.setValue((COLORIZE_MODES.find((item) => item.value === mode) || COLORIZE_MODES[0]).label)

  // ── 材质与玻璃 ──────────────────────────────────────────────────────
  /**
   * 这一组管"窗口怎么透"：材质（系统级模糊）+ 染色 + 浓度 + 模糊。
   *
   * 分组是**数据**而不是视图里的 if —— `STYLE_SLIDERS` 每项自带 `group`，
   * 这里只按 group 分两次排；将来加一条玻璃参数只改 format.js，不动这里。
   */
  root.appendChild(sectionTitle(doc, '材质与玻璃', { sub: true }))
  /**
   * 窗口材质（系统级模糊）—— 与「UI 遮罩」正交的一档：遮罩是**染色**，材质是**真透**。
   * 选了亚克力 / Mica 后 chrome 会走半透明玻璃（`--hira-chrome-bg` 带 alpha），
   * 桌面直接透出来（见 docs-ng/主题系统设计.md「窗口材质」）。
   */
  const material = selectRow(
    doc,
    '窗口材质',
    WINDOW_MATERIALS,
    (draft.style || {}).material || 'none',
    (value) => emit({ type: 'patch', section: 'style', key: 'material', value }),
    { hint: '系统级模糊：窗口直接透出桌面（Windows 11 22H2+）' }
  )
  /** 常驻说明：当前材质是什么观感、该怎么调（内容随 `update` 刷新）。 */
  const materialDesc = el(doc, 'div', 'thm-form__desc', materialHint((draft.style || {}).material || 'none'))
  /** 不支持提示行（内容与显隐由 `setSurface` 管，不在 update 里重算）。 */
  const materialNote = el(doc, 'div', 'thm-note thm-note--warn', '')
  materialNote.style.display = 'none'
  /**
   * 浏览器 UI（chrome）遮罩的**颜色** —— 与「UI 遮罩不透明度」配对。
   *
   * 与「背景」区那条遮罩的区别（两组各管一件事，互不相干）：
   *   · 这里管**工具栏/侧栏**压在壁纸上的那层；
   *   · 背景区那条管**壁纸本身**（网页四周 / 新标签页）。
   * 显示值走 `resolveChromeOverlayColor`（未声明 → 主题底色）＝ 实际生效的那个色。
   */
  const uiVeil = colorRow(
    doc,
    { key: 'chromeOverlayColor', label: 'UI 遮罩颜色', hint: '默认跟随底色' },
    resolveChromeOverlayColor(draft),
    (value) => emit({ type: 'patch', section: 'style', key: 'chromeOverlayColor', value })
  )
  const styleControls: Record<string, ReturnType<typeof sliderRow>> = {}
  for (const spec of STYLE_SLIDERS) {
    const control = sliderRow(doc, spec, themeStyleValue(draft.style, spec.key), (value) =>
      emit({ type: 'patch', section: 'style', key: spec.key, value })
    )
    styleControls[spec.key] = control
  }
  /**
   * 材质推荐值：原生层没有"染色 / 透明度"参数（`setBackgroundMaterial` 只认材质名），
   * 可调的只有 chrome 层这三项 —— 所以给出的是一个**起点**而不是开关：
   * 套完之后滑杆仍可继续拖（见 format.js#MATERIAL_RECOMMENDED）。
   */
  const applyRecommended = button(doc, '套用推荐值', {
    variant: 'ghost',
    title: '按当前材质设一组更接近系统原生观感的浓度（之后仍可自己微调）',
    onClick: () => {
      const rec = MATERIAL_RECOMMENDED[(latest.style || {}).material || 'none']
      if (!rec) return
      // 一次写多个字段：分开 emit 会让预览连算三次、界面抖三下
      emit({ type: 'patch-many', section: 'style', patch: { ...rec } })
    }
  })
  const materialActions = el(doc, 'div', 'thm-glass__actions')
  materialActions.append(applyRecommended, el(doc, 'span', 'thm-glass__hint', '不锁死：套完仍可拖上面的滑杆微调'))
  materialActions.style.display = 'none'

  // 行序：先"是什么材质"，再"染什么色、多不透"，最后才是与玻璃无关的形状项。
  root.append(colorize.row, material.row, materialDesc, materialNote, uiVeil.row)
  for (const spec of STYLE_SLIDERS) {
    if (spec.group === 'material') root.appendChild(styleControls[spec.key].row)
  }
  root.appendChild(materialActions)
  root.appendChild(sectionTitle(doc, '其它外观', { sub: true }))
  for (const spec of STYLE_SLIDERS) {
    if (spec.group !== 'material') root.appendChild(styleControls[spec.key].row)
  }

  // 背景
  root.appendChild(sectionTitle(doc, '背景'))
  const bg = draft.background || {}
  const bgKind = selectRow(doc, '来源', BACKGROUND_KINDS, bg.kind || 'none', (value) =>
    emit({ type: 'patch', section: 'background', key: 'kind', value })
  )
  const bgColor = colorRow(
    doc,
    { key: 'color', label: '背景色', hint: '纯色来源；也是图片加载前的兜底色' },
    bg.color || '',
    (value) => emit({ type: 'patch', section: 'background', key: 'color', value })
  )
  /**
   * 渐变 = **两个取色器**（不逼用户写 CSS）。
   *
   * 模型里仍然只有一个 `background.css` 字符串（Vivaldi 兼容字段，不动 schema）：
   * 所以这里做的是「原值 →(解析)→ 两个色 →(改哪个)→ 重新生成整串」的往返。
   * 方向等其余信息从原值里保留 —— 见 format.js#parseGradient 的说明。
   *
   * `seed` 每次都从 `latest`（最新草稿）现算，而不是建立时捕获一份：连点两次取色器时，
   * 第二次必须看到第一次的结果，否则后一次会把前一次覆盖回去（表现为"拖了没反应"）。
   */
  const seedGradient = (source?: ThemeData | null) => {
    const b: Partial<ThemeBackground> = (source && source.background) || {}
    const parsed = parseGradient(b.css || '')
    if (parsed) return parsed
    // 解析不出（空值 / 作者的复杂 CSS）→ 用背景色当起点拼一个合理的双色；
    // 一旦用户动取色器，整串就会被替换成双色线性渐变（下面 hint 里写明了这件事）。
    return {
      ...DEFAULT_GRADIENT,
      from: toHexInput(b.color || (source && source.colors.bg), DEFAULT_GRADIENT.from)
    }
  }
  const patchGradient = (patch: { from?: string; to?: string }) => {
    const next = { ...seedGradient(latest), ...patch }
    emit({ type: 'patch', section: 'background', key: 'css', value: buildGradient(next) })
  }
  const bgGradientFrom = colorRow(
    doc,
    { key: 'cssFrom', label: '渐变·起始', hint: '两个取色器拼成线性渐变（原值是复杂 CSS 时会被替换）' },
    seedGradient(draft).from,
    (value) => patchGradient({ from: value })
  )
  const bgGradientTo = colorRow(
    doc,
    { key: 'cssTo', label: '渐变·结束' },
    seedGradient(draft).to,
    (value) => patchGradient({ to: value })
  )
  /**
   * 图片 / 视频 = **从文件管理器选**（不再是让用户手填一个相对路径 —— 那条路对用户主题
   * 从来没有生效过，见 main/theme-assets.js）。
   *
   * 两者共用同一个控件（`assetRow`）与同一条链，差别只有文案与对话框的过滤器：
   * `asset-pick` 意图带上 `kind`，主进程按它给标题与过滤器；写进草稿的 `kind` 则以
   * **主进程按真实扩展名判出来的 `mediaKind`** 为准（见 core.js#pickAsset）。
   */
  const bgImage = assetRow(
    doc,
    '图片',
    () => emit({ type: 'asset-pick', kind: 'image' }),
    () => emit({ type: 'asset-clear' }),
    {
      hint: '从文件管理器选一张图片，它会被拷进主题资产库',
      pickLabel: '选择图片…',
      pickTitle: '从文件管理器里选一张图片（会拷进主题资产库）',
      clearTitle: '不再使用图片背景'
    }
  )
  /**
   * 动态壁纸。视频与图片走同一条链（选文件 → 拷进资产库 → 协议给地址），
   * 唯一多出来的一条事实是：**「自动」前景对它无效**（画面在动，没有单一亮度可代表它）——
   * 所以下面挂一句提示，而不是让作者以为"开了自动就没事了"。
   */
  const bgVideo = assetRow(
    doc,
    '视频',
    () => emit({ type: 'asset-pick', kind: 'video' }),
    () => emit({ type: 'asset-clear' }),
    {
      hint: '从文件管理器选一段视频（mp4 / webm / ogv），静音循环播放',
      pickLabel: '选择视频…',
      pickTitle: '从文件管理器里选一段视频（会拷进主题资产库）',
      clearTitle: '不再使用视频背景',
      emptyText: '未选择'
    }
  )
  const bgVideoHint = el(doc, 'div', 'thm-note thm-note--warn', VIDEO_FG_HINT)
  const bgPosition = selectRow(doc, '位置', BACKGROUND_POSITIONS, bg.position || 'cover', (value) =>
    emit({ type: 'patch', section: 'background', key: 'position', value })
  )
  /**
   * 这里**没有**「应用到（窗口 / 新标签页）」这一行。
   *
   * 壁纸现在只有一份，画在窗口外壳那一层；新标签页是透明画布，只是把它透出来。
   * 于是「只应用新标签页」在这套结构里根本无法表达（勾了也看不到），
   * 归一化会把 `newtab` 自动补成 `window`（见 shared-types/src/theme.mjs
   * `normalizeThemeBackground`）。留一个「会自己弹回去」的勾选框只会让人困惑，
   * 所以整个开关随旧的双层结构一起删掉 —— 数据字段保留，供主题包沿用。
   */
  /**
   * 遮罩颜色（与「遮罩不透明度」配对：**颜色 × 浓度**，两件事各自独立生效）。
   *
   * 显示的值 = **主进程真正会用的那个值**（`resolveVeilColor` 与共享层同一份实现）——
   * 没显式给过色时它显示白，那就是实际的遮罩色。显示与生效必须同源，
   * 否则会出现"看到白的、实际是深色 → 调不透明度没反应"。
   */
  const bgVeil = colorRow(
    doc,
    { key: 'overlayColor', label: '遮罩颜色', hint: '白=提亮 黑=压暗' },
    resolveVeilColor(bg),
    (value) => emit({ type: 'patch', section: 'background', key: 'overlayColor', value })
  )
  const bgSliders: Record<string, ReturnType<typeof sliderRow>> = {}
  for (const spec of BACKGROUND_SLIDERS) {
    const control = sliderRow(doc, spec, themeBackgroundValue(bg, spec.key), (value) =>
      emit({ type: 'patch', section: 'background', key: spec.key, value })
    )
    bgSliders[spec.key] = control
  }
  // 行序 = 阅读顺序：先"从哪来"，再"长什么样"（颜色 / 渐变 / 图片 / 视频 / 位置），
  // 最后"叠什么遮罩"。滑杆排在末尾 —— 它们是在上面那些选择之上做微调。
  root.append(
    bgKind.row,
    bgColor.row,
    bgGradientFrom.row,
    bgGradientTo.row,
    bgImage.row,
    bgVideo.row,
    bgPosition.row,
    bgVideoHint,
    bgVeil.row
  )
  for (const spec of BACKGROUND_SLIDERS) root.appendChild(bgSliders[spec.key].row)

  // 页脚
  const foot = el(doc, 'div', 'thm-editor__foot')
  const saveApply = button(doc, '保存并应用', { variant: 'primary', onClick: () => emit({ type: 'save', apply: true }) })
  const save = button(doc, '保存', { variant: 'ghost', onClick: () => emit({ type: 'save' }) })
  const dup = button(doc, '另存为副本', { variant: 'ghost', onClick: () => emit({ type: 'duplicate' }) })
  const exp = button(doc, '导出…', { variant: 'ghost', title: '导出为 .zip 主题包（含 Vivaldi 兼容字段）', onClick: () => emit({ type: 'export' }) })
  const del = button(doc, '删除', { variant: 'danger', onClick: () => emit({ type: 'remove-draft' }) })
  const note = el(doc, 'span', 'thm-editor__note')
  const close = button(doc, '退出编辑', { variant: 'ghost', onClick: () => emit({ type: 'close-editor' }) })
  foot.append(saveApply, save, dup, exp, del, el(doc, 'div', 'thm-editor__foot-spacer'), note, close)
  root.appendChild(foot)

  /**
   * 更新表单显示。
   * `meta.editable` 为假（内置/插件主题的草稿）时**不能覆盖保存** —— 保存按钮
   * 会新建一条用户主题，所以按钮文案随之改成「保存为新主题」，让后果可见。
   *
   * 性能口径：这里**不打增量补丁**（草稿各段之间有派生关系，分段回写就要维护一张
   * 跨段依赖表）。改为全量对齐 + 每处"值没变就不写"：
   *   · 控件自身幂等（见 parts.js 各 `setValue`）；
   *   · 行显隐 / 材质说明 / 页脚文案这类**没有控件宿主**的 DOM 在这里按指纹记忆。
   * 一次 update 在"什么都没变"时只剩几十次字符串比较。
   */
  function update(next: ThemeData, metaNow: ThemeMeta = {}) {
    const d = next
    latest = d
    // 名字用 `draftName`（草稿没名字时给占位），否则输入框会空着看不出在编辑什么
    nameRow.setValue(draftName(d))
    modeSeg.setValue(d.mode || 'light')

    const c = d.colors || {}
    for (const field of COLOR_FIELDS) {
      // 有效键（chromeFg）显示的是**生效值**：没给过就是主题前景色，而不是空/黑
      const effective = EFFECTIVE_VALUE.colors[field.key]
      colorControls[field.key].setValue(c[field.key] || (effective ? effective(d) : ''))
    }
    // 总开关的真实状态从数据推（三档里有 auto 就是开）—— 不另存一份"开关值"
    autoFg.setValue(anyForegroundAuto(d) ? ['auto'] : [])

    const st = d.style || {}
    for (const spec of STYLE_SLIDERS) {
      const effective = EFFECTIVE_VALUE.style[spec.key]
      styleControls[spec.key].setValue(effective ? effective(d) : themeStyleValue(st, spec.key))
    }
    syncColorize(st.colorizeMode)
    uiVeil.setValue(resolveChromeOverlayColor(d))
    material.setValue(st.material || 'none')
    // 说明随材质换：三种材质观感差别很大，一句"系统级模糊"讲不清该怎么调
    const materialName = st.material || 'none'
    if (materialName !== shownMaterial) {
      shownMaterial = materialName
      materialDesc.textContent = materialHint(materialName)
      // 推荐值只对能调的材质出现（none 没有浓度可言）
      materialActions.style.display = hasMaterialTuning(materialName) ? '' : 'none'
    }

    const b = d.background || {}
    bgKind.setValue(b.kind || 'none')
    bgColor.setValue(b.color || '')
    // 渐变的两个取色器：从**这一份**草稿的 `css` 现解析（每次都重算，见 seedGradient 的说明）
    const gradient = seedGradient(d)
    bgGradientFrom.setValue(gradient.from)
    bgGradientTo.setValue(gradient.to)
    bgImage.setValue(b.path || '')
    bgVideo.setValue(b.path || '')
    bgPosition.setValue(b.position || 'cover')
    bgVeil.setValue(resolveVeilColor(b))
    for (const spec of BACKGROUND_SLIDERS) bgSliders[spec.key].setValue(themeBackgroundValue(b, spec.key))

    syncBackgroundVisibility(d)
    syncFooter(d, metaNow)
    return undefined
  }

  /** 上一次设过的材质 / 背景来源+自动开关 / 页脚状态 —— 几处没有控件宿主的 DOM 的指纹。 */
  let shownMaterial: string | null = null
  let shownBgFingerprint: string | null = null
  let shownFooter: string | null = null

  /**
   * 只显示与当前来源有关的控件（"来源=无"时还摆一堆滑杆只会让人以为设置没生效）。
   *
   * 十余处 `style.display` 全按同一份草稿派生 → 只在这份**指纹**真的变了时写一遍
   * （来源 + "要不要摆自动前景开关"）。
   *
   * 「前景自动」开关的显隐判据有两条，缺一不可：
   *   · `supportsAutoFg(kind)` —— 只有能量到亮度的静帧壁纸（图片 / 每日一图）才算得出来；
   *   · `autoOn` —— 主题里已经存了 `auto` 时**必须**摆出来，否则那三档被锁死却没有入口关。
   * 于是视频 / 纯色 / 渐变（以及暂时取不到系统壁纸字节的「桌面壁纸」）下不出现，
   * 而已开自动的主题换任何来源都关得掉。
   */
  function syncBackgroundVisibility(draftNow?: ThemeData | null) {
    const d = draftNow
    if (!d) return
    const kind = ((d.background || {}).kind) || 'none'
    const autoOn = anyForegroundAuto(d)
    const showAutoFg = autoOn || supportsAutoFg(kind)
    const fingerprint = `${kind}\u0001${showAutoFg ? 1 : 0}`
    if (fingerprint === shownBgFingerprint) return
    shownBgFingerprint = fingerprint
    // 总开关排在颜色段第一行：只有能自动时才有意义
    autoFg.row.style.display = showAutoFg ? '' : 'none'
    bgColor.row.style.display = kind === 'color' ? '' : 'none'
    bgGradientFrom.row.style.display = kind === 'css' ? '' : 'none'
    bgGradientTo.row.style.display = kind === 'css' ? '' : 'none'
    bgImage.row.style.display = kind === 'image' ? '' : 'none'
    bgVideo.row.style.display = kind === 'video' ? '' : 'none'
    // 「自动」前景对动态画面无效 —— 只在选了视频来源时把这句话摆出来（见 format.js#VIDEO_FG_HINT）
    bgVideoHint.style.display = kind === 'video' ? '' : 'none'
    // 位置对**铺满型**背景才有意义（图片 / 每日一图 / 视频 —— 与 themeBackgroundStyle /
    // 渲染器的 object-fit 口径一致）。视频那条映射见 theme-background.mjs#OBJECT_FIT。
    bgPosition.row.style.display = (kind === 'image' || kind === 'daily' || kind === 'video') ? '' : 'none'
    // 遮罩是"叠在背景上的一层"，背景为空时它没有意义
    bgVeil.row.style.display = kind === 'none' ? 'none' : ''
    const showSliders = kind !== 'none'
    for (const spec of BACKGROUND_SLIDERS) bgSliders[spec.key].row.style.display = showSliders ? '' : 'none'
    bgKind.row.style.display = ''
  }

  /** 页脚只随"能不能覆盖保存"与"有没有落盘 id"变 —— 打字/拖滑杆时逐字符写文案是纯浪费。 */
  function syncFooter(d: ThemeData, metaNow: ThemeMeta = {}) {
    const editable = !!(metaNow && metaNow.editable)
    const id = d.id ? String(d.id) : ''
    const fingerprint = `${editable ? 1 : 0}\u0001${id}`
    if (fingerprint === shownFooter) return
    shownFooter = fingerprint
    saveApply.textContent = editable ? '保存并应用' : '保存并应用为新主题'
    save.textContent = editable ? '保存' : '保存为新主题'
    // 导出的是**已落盘的那条主题**（草稿没有 id，导出去也没有身份）——
    // 未保存的草稿上不显示导出，比点了之后弹一句"先保存"更直接。
    exp.style.display = editable ? '' : 'none'
    del.style.display = editable ? '' : 'none'
    note.textContent = id ? `id: ${id}` : '尚未保存'
  }

  /**
   * 更新"窗口材质能不能真的生效"的提示。
   *
   * 判据只用 `supported`（这台机器的能力），**不看 `applied`** —— 草稿预览里的
   * `applied` 恒为假（草稿没被应用到窗口上），拿它判会永远显示"没生效"。
   *
   * @param {{ material?: string, supported?: boolean }|null} surface
   */
  function setSurface(surface?: { material?: string, supported?: boolean }|null) {
    const want = !!(surface && surface.material && surface.material !== 'none')
    const unsupported = want && surface && surface.supported === false
    /* 预览每帧都会带着同一份 surface 进来 —— 结论没变就不动 DOM。 */
    if (unsupported === shownSurfaceWarning) return
    shownSurfaceWarning = unsupported
    materialNote.textContent = unsupported ? WINDOW_MATERIAL_UNSUPPORTED_HINT : ''
    materialNote.style.display = unsupported ? '' : 'none'
  }

  let shownSurfaceWarning: boolean | null = null

  update(draft, _meta)
  return { element: root, update, setSurface }
}


// ══════════════════════════════════════════════════════════════════════
// 页面引导（`hira://themes`）
// ══════════════════════════════════════════════════════════════════════

/**
 * 二次确认 —— 平台原语（`window.confirm`）。
 *
 * 与插件中心同一条实现口径：内部页拿不到 `ui/ui-common`（未打包的静态页只能
 * import `hira://shared/*`），所以保留同样十几行的薄壳，而**不**自绘模态框 ——
 * 层级 / 遮罩 / 焦点 / Esc 全归平台。
 *
 * @param {{ title?: string, message?: string }} [options]
 * @returns {Promise<boolean>}
 */
function confirmDialog(options: { title?: string; message?: string } = {}) : Promise<boolean> {
  const text = [options.title, options.message].filter(Boolean).join('\n\n') || '确定继续吗？'
  try {
    return Promise.resolve(window.confirm(text) === true)
  } catch (_) {
    return Promise.resolve(false)
  }
}

/** 主题域客户端：通道名与载荷形状收在共享层（页面与侧栏面板是**同一份**）。 */
const client = createThemeClient({ invoke: rpc, subscribe })

/** 内核实例（视图的 `emit` 在它就绪前就会被人点，所以用闭包转发）。 */
let controller: ThemesController | null = null

/**
 * 意图 → 内核动作（**唯一一处**）。
 *
 * 视图只发 `emit(intent)`，对"动作怎么落地"零知识 —— 于是加一个新按钮永远不用碰内核。
 */
function handleIntent(intent: Record<string, unknown>) {
  if (!intent || typeof intent !== 'object') return
  switch (intent.type) {
    case 'apply':
      // 「应用」= 切到它 + 把它送进编辑器（见 renderLibrary 的说明）。
      // 串行而不是并发：先落到主题再取草稿，避免两条链各自 setBusy 互相打断。
      void (async () => {
        if (!controller) return
        const id = String(intent.id || '')
        await controller.applyTheme(id)
        await controller.openEditor(id)
      })()
      break
    case 'new-theme':
      // 先切回主题库（编辑器住在那一页），再以当前主题为起点**另起**一份草稿
      view.showLibrary()
      controller && controller.openEditor('', { asNew: true })
      break
    case 'refresh':
      controller && controller.refreshSources()
      break
    case 'import':
      controller && controller.importTheme()
      break
    case 'export':
      controller && controller.exportTheme(controller.state.draftSavedId)
      break
    case 'patch':
      controller && controller.patchDraft(
        String(intent.section) as 'name' | 'mode' | 'colors' | 'style' | 'background',
        String(intent.key),
        intent.value
      )
      break
    /**
     * 一次改同一段的多个键（「套用推荐值」）。
     * 不拆成多次 `patch`：那会让内核连发多次预览，滑杆看起来在抖。
     */
    case 'patch-many':
      controller && controller.patchDraftMany(
        String(intent.section) as 'colors' | 'style' | 'background',
        intent.patch && typeof intent.patch === 'object' ? intent.patch as Record<string, unknown> : {}
      )
      break
    /**
     * 背景媒体：「选择图片 / 视频…」与「清除」。
     *
     * 选文件要弹**系统文件对话框**并落盘（拷进资产库），所以它是内核动作而不是一条
     * `patch` —— 拿到 key 之后再由内核写进草稿（见 core.js#pickAsset）。
     * `intent.kind` 只是对话框的过滤器提示，真正的 kind 由主进程按扩展名判定。
     */
    case 'asset-pick':
      controller && controller.pickAsset(intent.kind === 'video' ? 'video' : 'image')
      break
    case 'asset-clear':
      controller && controller.clearAsset()
      break
    case 'duplicate':
      controller && controller.duplicateDraft()
      break
    case 'save':
      controller && controller.saveDraft({ apply: intent.apply === true })
      break
    case 'remove-draft':
      controller && controller.deleteTheme(controller.state.draftSavedId || (controller.state.draft && controller.state.draft.id) || '')
      break
    case 'close-editor':
      controller && controller.closeEditor()
      break
    case 'schedule-patch':
      controller && controller.patchSchedule(intent.patch)
      break
    case 'schedule-entries':
      controller && controller.patchScheduleEntries(intent.entries)
      break
    case 'schedule-entry-add':
      // 追加一条默认时段（只放一条**空主题**的默认行：不替用户猜主题，让他自己选）。
      controller &&
        controller.patchScheduleEntries([
          ...((controller.state.schedule && controller.state.schedule.entries) || []),
          { theme: '', from: 18, to: 8 }
        ])
      break
    case 'private-set':
      controller && controller.setPrivate(String(intent.id || ''))
      break
    default:
      break
  }
}

// 跟随 app.theme 三态（浅 / 深 / 系统）：令牌由主进程推送，页面只负责接收。
initTheme()
injectSharedStyles(document)
injectPageStyles(document)

const view = createThemePageView(document, {
  emit: (intent) => handleIntent(intent)
})

const themesController = createThemesController({
  client: client as unknown as NonNullable<Parameters<typeof createThemesController>[0]>['client'],
  confirm: confirmDialog,
  view
})
controller = themesController
themesController.start()
subscribe(IPC_EVENTS.profileChanged, () => {
  void themesController.load({ silent: true })
})
window.addEventListener('pagehide', () => themesController.dispose(), { once: true })

const host = document.getElementById('app')
if (host) host.appendChild(view.element)
