/**
 * 书签子窗口（add-bookmark / edit-bookmark / tag-bookmarks 共用模块）。
 *
 * 设计（对齐老版 Hira bookmarkEditor 的三态语义，现代化实现）：
 *   - 预取：主进程自行查库（bookmark:get-by-url / bookmark:tree），
 *     renderer 只发意图，不复制任何书签逻辑
 *   - 字段：标题 / URL / 文件夹（树扁平化下拉）/ tags
 *     + 三个**独立开关**：固定到书签栏 / 固定到 rail / 默认在侧栏打开
 *   - 三态返回：保存 → update+move+setPinned+setRailPinned+setOpenInSidebar；删除 → remove-by-url；
 *     取消 → 关窗不动数据
 *   - 解耦：只通过 window.hira.provider 通信，不 import 任何 infra/domain
 *
 * 打标签（2026-11 重构）：
 *   · 面板 / 内部页里的「打标签弹层」全部移除，单条走 edit-bookmark 窗口、
 *     批量与文件夹走 tag-bookmarks 窗口 —— 打标签只有一个落点（子窗口）；
 *   · 标签输入框旁是「添加」按钮：**点按钮才加一个标签**，
 *     回车绝不保存整单、也不再解析逗号 —— 标签是芯片，点 × 移除。
 */
import {
  SYSTEM_TAGS,
  tagLabel,
  isSystemTagLike,
  normalizeTagList,
  rowHasTag
} from '@hira-ng/shared-types/src/bookmark-tags.mjs'
import type { SubwindowMountContext } from './contract.js'

interface BookmarkTreeNode {
  id: string
  title?: string
  url?: string
  nickname?: string
  favicon?: string
  tags?: string | string[] | null
  children?: BookmarkTreeNode[]
  parentId?: string | null
  pinned?: boolean
  railPinned?: boolean
  openInSidebar?: boolean
  [key: string]: unknown
}

interface FolderOption {
  id: string
  title: string
}
interface BookmarkEditorState {
  bookmark: BookmarkTreeNode | null
  folders: FolderOption[]
  busy: boolean
}
interface TagEditorOptions {
  placeholder?: string
  loadTags?: ((selected: string[]) => Promise<string[]>) | null
  onChange?: (() => void) | null
}

const state: BookmarkEditorState = { bookmark: null, folders: [], busy: false }

function providerInvoke<T extends Record<string, unknown> = Record<string, unknown>>(route: string, arg?: unknown): Promise<T> {
  const bridge = globalThis.window && globalThis.window.hira
  if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
    throw new Error('window.hira.provider is unavailable')
  }
  return bridge.provider.invoke(route, arg)
}

function flattenFolders(nodes: readonly BookmarkTreeNode[], depth: number, out: FolderOption[]): FolderOption[] {
  for (const node of nodes) {
    if (node.url) continue // 只收文件夹
    out.push({ id: node.id, title: `${'　'.repeat(depth)}${node.title || '未命名'}` })
    flattenFolders(node.children || [], depth + 1, out)
  }
  return out
}

/**
 * 手填地址先补协议再解析。空值 / 空白 URL 以 `null` 返回，调用方负责给出就地提示；
 * 裸主机与 host:port 会自动补 `https://`，其余完整 scheme 原样保留。
 */
function normalizeBookmarkUrl(value: string): string | null {
  const text = String(value || '').trim()
  if (!text) return null
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /^(mailto|tel|magnet|data|javascript|about|file|hira|chrome|edge|view-source|blob):/i.test(text)
  const candidate = explicitScheme ? text : `https://${text}`
  try {
    const url = new URL(candidate)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null
    return url.href
  } catch (_) {
    return null
  }
}

/* ============================================================
 * 标签编辑器（书签窗口 / 批量标签窗口共用一套芯片语言）
 * ============================================================ */

/**
 * 芯片式标签输入：输入框 + 「添加」按钮 + 芯片列表。
 *
 * 为什么不再用"逗号分隔一个大输入框"：
 *   · 逗号既是分隔符又是内容的一部分，用户永远要先想"这个标签里能不能有逗号"；
 *   · 一次性提交整串没有"改主意"的过程 —— 芯片点 × 就移除，动作是离散的；
 *   · 回车在大表单里是「保存」的语义，标签框里回车必须只加标签（本组件 stopPropagation，
 *     页面级 Enter 收不到这次按键）。
 *
 * 自动补全只针对**当前输入的那一个词**（不再是"最后一段"）：数据源由 `loadTags(selected)`
 * 注入（书签窗口接 `bookmark:tag-autocomplete`，共现 × 时间衰减）。
 *
 * @param {{
 *   placeholder?: string,
 *   loadTags?: ((selected: string[]) => Promise<string[]>) | null,
 *   onChange?: (() => void) | null
 * }} [opts]
 */
function createTagEditor(settings: TagEditorOptions = {}) {
  const { placeholder = '输入标签，点「添加」', loadTags = null, onChange = null } = settings
  const root = document.createElement('div')
  root.className = 'bk-tag-editor'

  const chips = document.createElement('div')
  chips.className = 'bk-tag-chips'

  const row = document.createElement('div')
  row.className = 'bk-tag-row'

  const input = document.createElement('input')
  input.className = 'bk-input bk-tag-input'
  input.type = 'text'
  input.placeholder = placeholder
  input.spellcheck = false

  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'bk-btn bk-tag-add'
  addBtn.textContent = '添加'

  row.append(input, addBtn)

  // 推荐标签（按页面上下文）的落点：由书签窗口填充，点击即加（见 appendTag）
  const suggest = document.createElement('div')
  suggest.className = 'bk-tag-suggest'
  suggest.style.display = 'none'

  root.append(chips, row, suggest)

  const pop = document.createElement('div')
  pop.className = 'bk-tag-pop'
  pop.style.display = 'none'
  document.body.appendChild(pop)

  /** @type {string[]} 已选标签（顺序即用户添加顺序） */
  let tags: string[] = []
  let suggestions: string[] = []
  let activeIdx = -1
  let seq = 0

  const notify = () => { if (typeof onChange === 'function') { try { onChange() } catch (_) {} } }

  const renderChips = () => {
    chips.textContent = ''
    chips.style.display = tags.length ? '' : 'none'
    for (const tag of tags) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'bk-tag-chip'
      chip.title = '移除这个标签'
      const label = document.createElement('span')
      label.className = 'bk-tag-chip-label'
      label.textContent = tag
      const mark = document.createElement('span')
      mark.className = 'bk-tag-chip-mark'
      mark.textContent = '×'
      chip.append(label, mark)
      // mousedown preventDefault：点 × 不抢输入框焦点（否则补全浮层会先收起来）
      chip.addEventListener('mousedown', (e) => e.preventDefault())
      chip.addEventListener('click', () => removeTag(tag))
      chips.appendChild(chip)
    }
  }

  const hidePop = () => { pop.style.display = 'none'; activeIdx = -1 }

  const pick = (tag: string) => {
    addTag(tag)
    hidePop()
  }

  const renderPop = () => {
    if (!suggestions.length || document.activeElement !== input) return hidePop()
    activeIdx = -1
    pop.textContent = ''
    suggestions.forEach((tag, index) => {
      const item = document.createElement('div')
      item.className = 'bk-tag-pop__item'
      item.textContent = tag
      item.addEventListener('mousedown', (e) => { e.preventDefault(); pick(tag) })
      item.addEventListener('mouseenter', () => {
        activeIdx = index
        Array.from(pop.children).forEach((el, i) => el.classList.toggle('is-active', i === index))
      })
      pop.appendChild(item)
    })
    const rect = input.getBoundingClientRect()
    pop.style.left = `${Math.round(rect.left)}px`
    pop.style.top = `${Math.round(rect.bottom + 2)}px`
    pop.style.minWidth = `${Math.round(rect.width)}px`
    pop.style.display = 'block'
  }

  const refresh = async () => {
    const q = input.value.trim().toLowerCase()
    const mySeq = ++seq
    let all: string[] = []
    if (typeof loadTags === 'function') {
      try { all = await loadTags(tags.slice()) } catch (_) { all = [] }
    }
    if (mySeq !== seq) return
    suggestions = (Array.isArray(all) ? all : [])
      .map((tag) => String(tag || '').trim())
      .filter((tag) => tag &&
        !tags.some((chosen) => chosen.toLowerCase() === tag.toLowerCase()) &&
        (!q || tag.toLowerCase().includes(q)))
      .slice(0, 8)
    renderPop()
  }

  function addTag(raw: unknown) {
    const tag = String(raw == null ? '' : raw).trim()
    if (!tag) return false
    if (isSystemTagLike(tag)) return false // system: 是保留命名空间
    input.value = ''
    if (tags.some((item) => item.toLowerCase() === tag.toLowerCase())) {
      refresh()
      return false
    }
    tags = [...tags, tag]
    renderChips()
    refresh()
    notify()
    try { input.focus() } catch (_) {}
    return true
  }

  function removeTag(tag: string) {
    const key = String(tag || '').toLowerCase()
    const next = tags.filter((item) => item.toLowerCase() !== key)
    if (next.length === tags.length) return
    tags = next
    renderChips()
    refresh()
    notify()
  }

  const commitInput = () => { addTag(input.value) }
  addBtn.addEventListener('mousedown', (e) => e.preventDefault())
  addBtn.addEventListener('click', commitInput)
  input.addEventListener('mousedown', (e) => e.stopPropagation())
  input.addEventListener('input', refresh)
  input.addEventListener('focus', refresh)
  input.addEventListener('blur', () => setTimeout(hidePop, 120))
  input.addEventListener('keydown', (e) => {
    // Escape + 空输入 = 把这一下交还给页面（关窗）；其余按键一律**不冒泡**，
    // 尤其 Enter —— 它只负责"添加当前标签"，绝不触发整单保存。
    if (e.key === 'Escape' && pop.style.display === 'none' && !input.value) return
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (pop.style.display === 'none') return
      e.preventDefault()
      activeIdx = e.key === 'ArrowDown'
        ? Math.min(activeIdx + 1, suggestions.length - 1)
        : Math.max(activeIdx - 1, 0)
      Array.from(pop.children).forEach((el, i) => el.classList.toggle('is-active', i === activeIdx))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (pop.style.display !== 'none' && activeIdx >= 0) pick(suggestions[activeIdx])
      else commitInput()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (pop.style.display !== 'none') hidePop()
      else input.value = ''
    }
  })

  renderChips()

  return {
    root,
    input,
    suggest,
    /** 直接加一个标签（推荐胶囊 / 批量窗口的"新标签"输入用） */
    addTag,
    removeTag,
    getTags: () => tags.slice(),
    setTags: (next: unknown) => { tags = normalizeTagList(next); renderChips(); refresh() }
  }
}

/* ============================================================
 * 书签编辑 / 新增窗口
 * ============================================================ */

function buildForm(content: HTMLElement, { url = '', title = '' }: { url?: string; title?: string } = {}) {
  content.innerHTML = ''

  const field = (labelText: string, inputEl: HTMLElement) => {
    const wrap = document.createElement('div')
    wrap.className = 'bk-field'
    const label = document.createElement('label')
    label.className = 'bk-field__label'
    label.textContent = labelText
    wrap.appendChild(label)
    wrap.appendChild(inputEl)
    return wrap
  }

  const titleInput = document.createElement('input')
  titleInput.className = 'bk-input'
  titleInput.value = title
  titleInput.placeholder = '书签标题'

  // 昵称（N11）：窄书签栏 / 收藏夹放不下长标题时，用它显示一个短名。
  // 留空 = 回落到标题（既有行为逐字不变）——所以这一项**纯加法**，不填就等于没有。
  const nicknameInput = document.createElement('input')
  nicknameInput.className = 'bk-input'
  nicknameInput.placeholder = '昵称（可选，窄处显示的短名，留空用标题）'

  const urlInput = document.createElement('input')
  urlInput.className = 'bk-input'
  urlInput.value = url
  urlInput.placeholder = 'https://…'
  urlInput.inputMode = 'url'
  urlInput.setAttribute('autocomplete', 'url')
  urlInput.spellcheck = false

  const urlError = document.createElement('div')
  urlError.className = 'bk-field__error'
  urlError.setAttribute('role', 'alert')
  urlError.hidden = true

  const folderSelect = document.createElement('select')
  folderSelect.className = 'bk-input'
  const rootOpt = document.createElement('option')
  rootOpt.value = ''
  rootOpt.textContent = '书签栏（根目录）'
  folderSelect.appendChild(rootOpt)

  const tagEditor = createTagEditor()

  const pinnedLabel = document.createElement('label')
  pinnedLabel.className = 'bk-check'
  const pinnedInput = document.createElement('input')
  pinnedInput.type = 'checkbox'
  pinnedLabel.appendChild(pinnedInput)
  pinnedLabel.appendChild(document.createTextNode(' 固定到书签栏'))

  // 「固定到 rail」——与「固定到书签栏」**相互独立**的两个固定位：
  // 书签栏是横向一条，rail 是纵向一列。固定到 rail 后，图标栏上会多一个图标，
  // 点击即在**独立侧栏**打开这个书签（不是打开面板）。
  const railPinnedLabel = document.createElement('label')
  railPinnedLabel.className = 'bk-check'
  const railPinnedInput = document.createElement('input')
  railPinnedInput.type = 'checkbox'
  railPinnedLabel.appendChild(railPinnedInput)
  railPinnedLabel.appendChild(document.createTextNode(' 固定到侧栏图标栏（rail）'))

  // 「默认在侧栏打开」——**打开偏好**（不是一次性动作）：勾上后，在书签栏 / 收藏面板里
  // 点这个书签会默认放进独立侧栏。它只管"平时怎么开"，修饰键仍可覆盖它
  //（Shift 侧栏 / Ctrl 新标签优先，见 ui-common#resolveBookmarkOpenTarget）。
  const sidebarLabel = document.createElement('label')
  sidebarLabel.className = 'bk-check'
  const sidebarInput = document.createElement('input')
  sidebarInput.type = 'checkbox'
  sidebarLabel.appendChild(sidebarInput)
  sidebarLabel.appendChild(document.createTextNode(' 默认在侧栏打开'))

  content.appendChild(field('标题', titleInput))
  content.appendChild(field('昵称', nicknameInput))
  content.appendChild(field('URL', urlInput))
  content.appendChild(urlError)
  content.appendChild(field('文件夹', folderSelect))
  const tagsField = field('标签', tagEditor.root)
  content.appendChild(tagsField)
  content.appendChild(pinnedLabel)
  content.appendChild(railPinnedLabel)
  content.appendChild(sidebarLabel)

  const actions = document.createElement('div')
  actions.className = 'bk-actions'
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'bk-btn bk-btn--danger'
  deleteBtn.textContent = '删除'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'bk-btn'
  cancelBtn.textContent = '取消'
  const saveBtn = document.createElement('button')
  saveBtn.className = 'bk-btn bk-btn--primary'
  saveBtn.textContent = '保存'
  actions.appendChild(deleteBtn)
  actions.appendChild(cancelBtn)
  actions.appendChild(saveBtn)
  content.appendChild(actions)

  return {
    titleInput,
    nicknameInput,
    urlInput,
    urlError,
    folderSelect,
    tagEditor,
    pinnedInput,
    railPinnedInput,
    sidebarInput,
    deleteBtn,
    cancelBtn,
    saveBtn
  }
}

function injectStyles() {
  if (document.getElementById('bk-editor-styles')) return
  const style = document.createElement('style')
  style.id = 'bk-editor-styles'
  style.textContent = `
    .bk-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .bk-field__label { font-size: 12px; color: var(--hira-text-secondary, #6b7280); }
    .bk-input {
      width: 100%; padding: 7px 10px; font-size: 13px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.15)); border-radius: var(--hira-radius-xs, 6px);
      background: transparent; color: inherit; outline: none;
    }
    .bk-input:focus { border-color: var(--hira-accent, #3b82f6); }
    /* ── 标签芯片编辑器 ─────────────────────────────────────────────── */
    .bk-tag-editor { display: flex; flex-direction: column; gap: 6px; }
    .bk-tag-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .bk-tag-chip {
      display: inline-flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 8px; border: 0; border-radius: 999px;
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      color: var(--hira-accent, #3b82f6);
      font-family: inherit; font-size: 12px; cursor: pointer;
    }
    .bk-tag-chip:hover { background: var(--hira-accent-soft-strong, rgba(59,130,246,0.2)); }
    .bk-tag-chip-mark { opacity: 0.75; font-size: 11px; }
    .bk-tag-row { display: flex; align-items: center; gap: 6px; }
    .bk-tag-row .bk-input { flex: 1; min-width: 0; }
    .bk-tag-add { white-space: nowrap; padding: 7px 14px; }
    /* 标签自动补全浮层：fixed 定位避免被滚动容器裁剪；层级走 token，不裸写 z-index。 */
    .bk-tag-pop {
      position: fixed; z-index: var(--hira-z-popover, 50);
      max-height: 200px; overflow-y: auto; padding: 4px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.12)); border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-bg-elevated, #fff); color: inherit;
      box-shadow: 0 8px 24px rgba(0,0,0,0.14);
    }
    .bk-tag-pop__item { padding: 6px 10px; font-size: 13px; border-radius: var(--hira-radius-2xs, 4px); cursor: pointer; }
    .bk-tag-pop__item:hover, .bk-tag-pop__item.is-active { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); }
    /* 推荐标签胶囊：与输入框同宽的行内换行布局 */
    .bk-tag-suggest { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .bk-tag-suggest__chip {
      padding: 3px 9px; font-size: 12px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--hira-accent-soft-strong, rgba(59,130,246,0.35));
      color: var(--hira-accent, #3b82f6); background: var(--hira-accent-soft, rgba(59,130,246,0.08));
      outline: none;
    }
    .bk-input.is-invalid { border-color: var(--hira-danger, #e5484d); }
    .bk-field__error { margin: -8px 0 10px; color: var(--hira-danger, #e5484d); font-size: 12px; }
    .bk-field__error[hidden] { display: none; }
    .bk-tag-suggest__chip:hover { background: var(--hira-accent-soft-strong, rgba(59,130,246,0.18)); }
    /* ── 批量打标签窗口 ─────────────────────────────────────────────── */
    .bk-tags-window { display: flex; flex-direction: column; gap: 10px; }
    .bk-tags-summary { font-size: 12px; color: var(--hira-text-secondary, #6b7280); }
    .bk-tags-section { display: flex; flex-direction: column; gap: 5px; }
    .bk-tags-section-title { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }
    .bk-tags-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .bk-decision-chip {
      display: inline-flex; align-items: center; gap: 4px;
      height: 24px; padding: 0 8px; border: 0; border-radius: 999px;
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      color: var(--hira-text-secondary, #6b7280);
      font-family: inherit; font-size: 12px; cursor: pointer;
    }
    .bk-decision-chip:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.08)); }
    .bk-decision-chip.is-all {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .bk-decision-chip.is-some { outline: 1px dashed var(--hira-border, rgba(0,0,0,0.22)); outline-offset: -1px; }
    .bk-decision-chip.will-add { background: rgba(34,197,94,0.18); color: #16a34a; }
    .bk-decision-chip.will-remove { background: rgba(239,68,68,0.18); color: #dc2626; text-decoration: line-through; }
    .bk-decision-chip-mark { font-weight: 700; }
    .bk-tags-empty { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }
    .bk-check { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 16px; cursor: pointer; }
    .bk-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .bk-btn {
      padding: 7px 16px; font-size: 13px; border-radius: var(--hira-radius-xs, 6px);
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.15));
      background: transparent; color: inherit; cursor: pointer;
    }
    .bk-btn:hover { background: var(--hira-hover-bg, rgba(128,128,128,0.12)); }
    .bk-btn--primary {
      background: var(--hira-accent, #3b82f6);
      border-color: transparent;
      color: var(--hira-on-accent, #fff);
    }
    .bk-btn--primary:hover { background: color-mix(in srgb, var(--hira-accent, #3b82f6) 88%, #000); }
    .bk-btn--danger { color: var(--hira-danger, #e5484d); border-color: var(--hira-danger-bg, rgba(229,72,77,0.4)); }
    .bk-btn[disabled] { opacity: 0.5; pointer-events: none; }
  `
  document.head.appendChild(style)
}

export function mountBookmarkEditor({ type, params, content }: SubwindowMountContext): void {
  injectStyles()
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(params.get('payload') || '{}') || {}
  } catch (_) {
    payload = {}
  }

  const form = buildForm(content, {
    url: typeof payload.url === 'string' ? payload.url : '',
    title: typeof payload.title === 'string' ? payload.title : ''
  })
  const isAddMode = type === 'add-bookmark'
  if (isAddMode) form.deleteBtn.style.display = 'none'

  function setUrlError(message = '') {
    form.urlError.textContent = message
    form.urlError.hidden = !message
    form.urlInput.classList.toggle('is-invalid', !!message)
    form.urlInput.setAttribute('aria-invalid', message ? 'true' : 'false')
  }
  form.urlInput.addEventListener('input', () => setUrlError())

  // ---------------------------------------------------------------------------
  // 标签索引接线（F-0756~F-0760）
  // 打分/共现/时间衰减全部在 domain（shared-types#tag-index），渲染层只做两件事：
  //   1. 把「URL + 标题 + 已选标签」当上下文发给 `bookmark:tag-suggestions`，渲染胶囊；
  //   2. 补全浮层的数据源走 `bookmark:tag-autocomplete`，空结果回落热度榜。
  // ---------------------------------------------------------------------------
  let hotTags: unknown[] = []
  let suggestSeq = 0
  let suggestTimer: ReturnType<typeof setTimeout> | null = null

  const loadTags = async (selected: string[]) => {
    try {
      const list = await providerInvoke('bookmark:tag-autocomplete', { tags: selected, limit: 20 })
      if (Array.isArray(list) && list.length) return list
    } catch (_) {}
    return hotTags
  }

  async function refreshTagSuggestions() {
    const tags = form.tagEditor.getTags()
    const url = form.urlInput.value.trim()
    const title = form.titleInput.value.trim()
    if (!url && !title) {
      form.tagEditor.suggest.style.display = 'none'
      return
    }
    const mySeq = ++suggestSeq
    let list: unknown = []
    try {
      list = await providerInvoke('bookmark:tag-suggestions', { url, title, tags, limit: 3 })
    } catch (_) {
      list = []
    }
    if (mySeq !== suggestSeq) return
    const chosen = new Set(tags.map((tag) => tag.toLowerCase()))
    const chips = (Array.isArray(list) ? list : [])
      .map((tag) => String(tag || '').trim())
      .filter((tag) => tag && !chosen.has(tag.toLowerCase()))
      .slice(0, 6)
    const suggest = form.tagEditor.suggest
    suggest.textContent = ''
    if (!chips.length) {
      suggest.style.display = 'none'
      return
    }
    for (const tag of chips) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'bk-tag-suggest__chip'
      chip.textContent = tag
      // mousedown + preventDefault：点胶囊不抢走输入框焦点，也不会顺带触发保存
      chip.addEventListener('mousedown', (e) => { e.preventDefault(); form.tagEditor.addTag(tag) })
      suggest.appendChild(chip)
    }
    suggest.style.display = 'flex'
  }

  // 芯片变化（加 / 移除 / 输入）→ 重算推荐（防抖）
  const queueTagSuggestions = () => {
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(refreshTagSuggestions, 200)
  }
  form.tagEditor.input.addEventListener('input', queueTagSuggestions)
  // 推荐胶囊也需要随着已选标签变化而收敛：addTag/removeTag 都会 focus + input 事件，
  // 但芯片 × 不会触发 input —— 用一次轻量的轮询式对账（在本窗口生命周期内，成本可忽略）。
  form.tagEditor.root.addEventListener('click', queueTagSuggestions)

  form.urlInput.addEventListener('change', refreshTagSuggestions)
  form.titleInput.addEventListener('change', refreshTagSuggestions)

  // 预取：书签（edit 模式按 url 查）+ 文件夹树
  async function prefill() {
    try {
      const [tree] = await Promise.all([
        providerInvoke('bookmark:tree'),
        (async () => {
          if (payload.url) {
            state.bookmark = await providerInvoke<BookmarkTreeNode>('bookmark:get-by-url', { url: payload.url })
          }
        })()
      ])
      flattenFolders((tree || []) as unknown as BookmarkTreeNode[], 0, state.folders).forEach((folder) => {
        const opt = document.createElement('option')
        opt.value = folder.id
        opt.textContent = folder.title
        form.folderSelect.appendChild(opt)
      })
      // 从书签管理页的当前文件夹发起新增时，直接预选该文件夹。
      if (!state.bookmark && payload.parentId) form.folderSelect.value = String(payload.parentId)
      // 热度榜：补全浮层的兜底数据源（标签索引尚未构建 / 无共现时用）——失败静默。
      try {
        const rows = await providerInvoke('bookmark:tags')
        hotTags = (Array.isArray(rows) ? rows : [])
          .map((row) => (row && typeof row === 'object' ? row.tag : row))
          .map((tag) => String(tag || '').trim())
          .filter(Boolean)
      } catch (e) {
        console.warn('[bookmark-editor] tag index unavailable:', e instanceof Error ? e.message : String(e))
      }
      const bm = state.bookmark
      if (bm) {
        form.titleInput.value = bm.title || ''
        form.nicknameInput.value = bm.nickname || ''
        form.urlInput.value = bm.url || ''
        if (bm.parentId) form.folderSelect.value = bm.parentId
        form.tagEditor.setTags(bm.tags)
        form.pinnedInput.checked = !!bm.pinned
        form.railPinnedInput.checked = !!bm.railPinned
        form.sidebarInput.checked = !!bm.openInSidebar
        // edit 模式下把删除按钮放出来（add 模式是"先收藏后微调"，删除=取消收藏，
        // 用户直接再点一次星标即可，不需要删除按钮）
        form.deleteBtn.style.display = ''
      }
      // 预填完成后按当前 URL/标题给一轮推荐（add 模式来自 payload，edit 模式来自库）
      refreshTagSuggestions()
    } catch (e) {
      console.error('[bookmark-editor] prefill failed:', e)
    }
  }

  function close() {
    // 子窗口无 window.close 权限问题（普通 BrowserWindow）
    window.close()
  }

  function collectInput() {
    return {
      title: form.titleInput.value.trim(),
      nickname: form.nicknameInput.value.trim(),
      url: form.urlInput.value.trim(),
      parentId: form.folderSelect.value || null,
      tags: form.tagEditor.getTags(),
      pinned: form.pinnedInput.checked,
      railPinned: form.railPinnedInput.checked,
      openInSidebar: form.sidebarInput.checked
    }
  }

  async function onSave() {
    if (state.busy) return
    state.busy = true
    form.saveBtn.disabled = true
    try {
      const input = collectInput()
      const normalizedUrl = normalizeBookmarkUrl(input.url)
      if (!normalizedUrl) {
        setUrlError(input.url ? '请输入有效地址' : '请输入书签地址')
        form.urlInput.focus()
        return
      }
      input.url = normalizedUrl
      form.urlInput.value = normalizedUrl
      setUrlError()
      // 三种落库路径，全部以 domain 为唯一写入口：
      //  1) 新收藏 → add
      //  2) 已有书签改 URL → update（含 url）——URL 变更后星标等按新 URL 对账
      //  3) 文件夹变化 → move；固定状态 → pinnedSet
      let id = state.bookmark ? state.bookmark.id : null
      if (!id) {
        const created = await providerInvoke<{ id: string }>('bookmark:add', {
          url: input.url,
          title: input.title || input.url,
          ...(input.nickname ? { nickname: input.nickname } : {}),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          tags: input.tags
        })
        id = created ? created.id : null
      } else {
        await providerInvoke('bookmark:update', {
          id,
          title: input.title,
          // 昵称整列覆盖：空串 → NULL（等价于"清除昵称"，回落到标题）
          nickname: input.nickname,
          url: input.url,
          tags: input.tags
        })
      }
      if (id) {
        if (state.bookmark && state.bookmark.parentId !== input.parentId) {
          await providerInvoke('bookmark:move', { id, parentId: input.parentId })
        }
        const wantPinned = !!input.pinned
        const isPinned = !!(state.bookmark && state.bookmark.pinned)
        if (wantPinned !== isPinned) {
          await providerInvoke('bookmark:pinned-set', { id, pinned: wantPinned })
        }
        // rail 固定位：**另一个独立开关**（书签栏是横向一条、rail 是纵向一列），
        // 走自己的通道 —— 两条语义不同，合并成一个"pinned"必然又变成一处改两处忘。
        const wantRail = !!input.railPinned
        const isRail = !!(state.bookmark && state.bookmark.railPinned)
        if (wantRail !== isRail) {
          await providerInvoke('bookmark:rail-pinned-set', { id, pinned: wantRail })
        }
        // 打开偏好（默认在侧栏打开）：又是一个**独立开关**，走它自己的通道。
        // 与固定位无关 —— 一个书签可以既不固定、又默认在侧栏打开。
        const wantSidebar = !!input.openInSidebar
        const isSidebar = !!(state.bookmark && state.bookmark.openInSidebar)
        if (wantSidebar !== isSidebar) {
          await providerInvoke('bookmark:open-in-sidebar-set', { id, value: wantSidebar })
        }
      }
      close()
    } catch (e) {
      console.error('[bookmark-editor] save failed:', e)
    } finally {
      state.busy = false
      form.saveBtn.disabled = false
    }
  }

  async function onDelete() {
    if (state.busy || !state.bookmark) return
    state.busy = true
    try {
      await providerInvoke('bookmark:remove-by-url', { url: state.bookmark.url })
      close()
    } catch (e) {
      console.error('[bookmark-editor] delete failed:', e)
      state.busy = false
    }
  }

  form.saveBtn.addEventListener('click', onSave)
  form.cancelBtn.addEventListener('click', close)
  form.deleteBtn.addEventListener('click', onDelete)
  content.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.isComposing) {
      close()
    } else if (e.key === 'Enter' && !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 对齐老 Hira：在输入框/下拉里按 Enter 直接保存（按钮聚焦时走原生 click，避免双触发）。
      // 标签输入框**已经 stopPropagation**，这里收不到它的 Enter —— 标签框的 Enter 只加标签。
      const tag = document.activeElement && document.activeElement.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || !tag) {
        e.preventDefault()
        onSave()
      }
    }
  })

  prefill().then(() => { try { form.titleInput.focus(); form.titleInput.select() } catch (_) {} })
}

/* ============================================================
 * 批量打标签窗口（tag-bookmarks）
 *
 * 右键「打标签…」（文件夹 / 多选）与批量条的「打标签…」都开到这里，
 * 不再在面板或内部页里塞一个浮层。三态芯片（不变 → 加上 → 移除）沿用老弹层的语义：
 * 批量场景里"这一项有、那一项没有"是常态，二态开关说不清点一下到底给全部加还是全部删。
 * 系统标签（书签栏 / 侧栏图标栏）与用户标签在同一排 —— 写路径仍由 domain 的
 * bulkUpdateTags 统一解释（system:* → 固定列）。
 * ============================================================ */

export function mountTagBookmarks({ params, content }: SubwindowMountContext): void {
  injectStyles()
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(params.get('payload') || '{}') || {}
  } catch (_) {
    payload = {}
  }

  const ids = Array.isArray(payload.ids)
    ? payload.ids.map((id) => String(id == null ? '' : id).trim()).filter(Boolean)
    : []

  content.innerHTML = ''
  const root = document.createElement('div')
  root.className = 'bk-tags-window'
  content.appendChild(root)

  const summary = document.createElement('div')
  summary.className = 'bk-tags-summary'
  root.appendChild(summary)

  const body = document.createElement('div')
  root.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'bk-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'bk-btn'
  cancelBtn.textContent = '取消'
  const applyBtn = document.createElement('button')
  applyBtn.className = 'bk-btn bk-btn--primary'
  applyBtn.textContent = '应用'
  actions.append(cancelBtn, applyBtn)
  root.appendChild(actions)

  const close = () => window.close()
  cancelBtn.addEventListener('click', close)

  /** 大小写归一后的键 → 展示用写法（保留首次出现的大小写） */
  const canonical = new Map<string, string>()
  const remember = (tag: string): string => {
    const key = String(tag).toLowerCase()
    if (!canonical.has(key)) canonical.set(key, String(tag))
    return key
  }
  /** @type {Map<string, 'add'|'remove'>} 只存"有动作"的键 */
  const decisions: Map<string, 'add'|'remove'> = new Map()
  let targets: BookmarkTreeNode[] = []
  let inputRow: ReturnType<typeof createTagEditor> | null = null

  const allHave = (tag: string): boolean => targets.length > 0 && targets.every((row) => rowHasTag(row, tag))
  const anyHave = (tag: string): boolean => targets.some((row) => rowHasTag(row, tag))

  const toggle = (tag: string): void => {
    const key = remember(tag)
    const current = decisions.get(key)
    if (!current) decisions.set(key, 'add')
    else if (current === 'add') decisions.set(key, 'remove')
    else decisions.delete(key)
    render()
  }

  function chipsSection(title: string, tags: readonly string[]): HTMLDivElement {
    const wrap = document.createElement('div')
    wrap.className = 'bk-tags-section'
    const heading = document.createElement('div')
    heading.className = 'bk-tags-section-title'
    heading.textContent = title
    const chips = document.createElement('div')
    chips.className = 'bk-tags-chips'
    for (const tag of tags) {
      const system = isSystemTagLike(tag)
      const stateNow = decisions.get(String(tag).toLowerCase()) || ''
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'bk-decision-chip'
        + (system ? ' is-system' : '')
        + (allHave(tag) ? ' is-all' : anyHave(tag) ? ' is-some' : '')
        + (stateNow === 'add' ? ' will-add' : stateNow === 'remove' ? ' will-remove' : '')
      chip.title = stateNow === 'add'
        ? (system ? '将固定' : '将添加')
        : stateNow === 'remove' ? (system ? '将取消固定' : '将移除') : '再点一次选择加 / 减'
      chip.appendChild(document.createTextNode(system ? tagLabel(tag) : tag))
      const mark = document.createElement('span')
      mark.className = 'bk-decision-chip-mark'
      mark.textContent = stateNow === 'add' ? '+' : stateNow === 'remove' ? '−' : ''
      chip.appendChild(mark)
      chip.addEventListener('click', () => toggle(tag))
      chips.appendChild(chip)
    }
    if (!tags.length) {
      const empty = document.createElement('span')
      empty.className = 'bk-tags-empty'
      empty.textContent = '还没有用户标签'
      chips.appendChild(empty)
    }
    wrap.append(heading, chips)
    return wrap
  }

  function render() {
    body.textContent = ''
    body.appendChild(chipsSection('固定位（系统标签）', SYSTEM_TAGS.map((meta) => meta.id)))
    const userTags = [...canonical.values()]
      .filter((tag) => !isSystemTagLike(tag))
      .sort((a, b) => a.localeCompare(b))
    body.appendChild(chipsSection('标签', userTags))
    if (inputRow) body.appendChild(inputRow.root)
  }

  async function prefill() {
    try {
      const tree = await providerInvoke('bookmark:tree')
      const wanted = new Set(ids)
      const found = new Map<string, BookmarkTreeNode>()
      ;(function walk(nodes: BookmarkTreeNode[]) {
        for (const node of nodes || []) {
          if (!node) continue
          if (wanted.has(node.id)) found.set(node.id, node)
          walk(node.children || [])
        }
      })(tree as unknown as BookmarkTreeNode[])
      targets = ids.map((id) => found.get(id)).filter((node): node is BookmarkTreeNode => node !== undefined)
      for (const row of targets) {
        for (const tag of normalizeTagList(row.tags)) {
          if (isSystemTagLike(tag)) continue
          remember(tag)
        }
      }
      summary.textContent = targets.length
        ? `共 ${targets.length} 项 · 点标签切换「添加 / 移除」，再点一次取消`
        : '目标项已不存在'
    } catch (e) {
      console.error('[tag-bookmarks] prefill failed:', e)
      summary.textContent = '无法读取目标项目'
    }
    // 新标签输入：与书签窗口同一个芯片语义（输入框 + 添加按钮，回车只加标签）。
    // 加进来的新标签**立刻**转成上面那排决策芯片（编辑器自身清空），
    // 这样"要加什么"只有一处展示，不会出现两套 chip 说同一件事。
    const editor = createTagEditor({
      placeholder: '新标签，点「添加」',
      onChange: () => {
        const pending = editor.getTags()
        if (!pending.length) return
        for (const tag of pending) {
          remember(tag)
          decisions.set(tag.toLowerCase(), 'add')
        }
        editor.setTags([])
        render()
      }
    })
    editor.root.classList.add('bk-tags-new')
    inputRow = editor
    render()
  }

  applyBtn.addEventListener('click', async () => {
    if (state.busy) return
    const addTags: string[] = []
    const removeTags: string[] = []
    for (const [key, value] of decisions) {
      const tag = canonical.get(key) || key
      if (value === 'add') addTags.push(tag)
      else removeTags.push(tag)
    }
    if (!targets.length || (!addTags.length && !removeTags.length)) { close(); return }
    state.busy = true
    applyBtn.disabled = true
    try {
      await providerInvoke('bookmark:tag-bulk', { ids: targets.map((row) => row.id), addTags, removeTags })
      close()
    } catch (e) {
      console.error('[tag-bookmarks] apply failed:', e)
      state.busy = false
      applyBtn.disabled = false
    }
  })

  render()
  prefill()
}

