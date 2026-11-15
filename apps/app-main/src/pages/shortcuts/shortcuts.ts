/**
 * 键盘快捷键（hira://shortcuts）
 *
 * 与旧实现（subwindow 时代的 keyboard-shortcuts 窗口，已删除）的关系：那份把
 * 「动作清单 + 名称 + 分类」抄在渲染层，主进程再加一条就得两处改，且只能列 30 条里的 28 条。
 * 现在清单唯一真源是 `shared-types/src/keybindings.mjs`（主进程 keybindings.js 读同一份），
 * 本页只负责**画**。
 *
 * 交互口径对齐 RT（参考项目）：
 *   · 搜索（300ms debounce，匹配名称 / 组合键 / 动作 id）；
 *   · 分类分组 + 「已修改」分区置顶；
 *   · 点组合键进入录制：Enter 保存、Backspace / Delete 清空、Esc 取消；
 *   · 单项重置（行内三按钮）、全部重置（带确认对话框）；
 *   · 冲突 / 非法组合的错误由主进程裁定，本页只把错误文案翻成人话。
 *
 * ⚠ 录制期间主进程必须「让出按键」：本页是普通标签页，webContents 也挂在 keybindings 上，
 *   不让出的话按 Ctrl+T 会先开一个新标签页，页面根本收不到这个键。
 *   进出编辑态时调 `keybindings:set-recording`；主进程另有 destroyed / did-navigate 兜底。
 */
import {
  IPC_ROUTES,
  rpc,
  el,
  initTheme,
  KEYBINDING_GROUPS,
  KEYBINDING_DEFAULTS,
  formatKeybindingCombo,
  comboFromParts,
  keybindingActionName
} from 'hira://shared/runtime.js'

initTheme()

/** 只按这些键时还不算"一个完整的快捷键"（等主键）。 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'])

interface ShortcutAction {
  id: string
  name: string
  default?: string
  groupId: string
  groupLabel: string
}

interface KeybindingGroup {
  id: string
  label: string
  actions: ReadonlyArray<{ id: string; name: string; default?: string }>
}

type KeybindingMap = Record<string, string>

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Shortcuts page element #${id} is unavailable`)
  return element as unknown as T
}

/** 主进程当前值 / 默认值。两者都以目录里的默认值为底，避免协议缺失时出现空行。 */
let keybindings: KeybindingMap = { ...KEYBINDING_DEFAULTS }
let defaults: KeybindingMap = { ...KEYBINDING_DEFAULTS }

/** 正在编辑的动作 id；null = 没有行处于编辑态。 */
let editingAction: string | null = null
/** 编辑中的草稿组合串（`Ctrl+Shift+,` / `Ctrl+Shift+` 表示只按了修饰键 / '' 表示已清空）。 */
let draft = ''
/** 草稿尚未形成完整组合（呼吸提示「请按组合键」）。 */
let recording = false
/** 已提交的搜索词（debounce 后）。 */
let query = ''

const groupsHost = requiredElement<HTMLElement>('groups')
const feedback = requiredElement<HTMLElement>('feedback')
const searchInput = requiredElement<HTMLInputElement>('search')
const countEl = requiredElement<HTMLElement>('count')
const resetAllBtn = requiredElement<HTMLButtonElement>('reset-all')
const resetDialog = requiredElement<HTMLDialogElement>('reset-dialog')

/** 目录里的全部动作（含所属分组名），按分组顺序展开一次。 */
function actionsOfGroup(group: KeybindingGroup): ShortcutAction[] {
  return group.actions.map((action) => ({ ...action, groupId: group.id, groupLabel: group.label }))
}

const ALL_ACTIONS: ShortcutAction[] = (() => {
  const list: ShortcutAction[] = []
  for (const group of KEYBINDING_GROUPS as unknown as readonly KeybindingGroup[]) {
    list.push(...actionsOfGroup(group))
  }
  return list
})()

// ── 反馈条 ──────────────────────────────────────────────────────────────
function showFeedback (message = '', type = 'error'): void {
  feedback.textContent = message
  feedback.dataset.type = type || 'error'
  feedback.hidden = false
}

function showError (message: string): void {
  showFeedback(message, 'error')
}

function clearFeedback (): void {
  feedback.hidden = true
  feedback.textContent = ''
  delete feedback.dataset.type
}

/**
 * 主进程错误 → 用户能看懂的一句话。
 * 主进程只认动作 id（它不知道界面上的中文名），这里用同一份目录把 id 换回名称。
 */
function explainError (cause: unknown, combo = ''): string {
  const record = cause && typeof cause === 'object' ? cause as { message?: unknown; error?: unknown } : null
  const text = String(record?.message || record?.error || cause || '')
  let match = /Shortcut already belongs to: *([^\s']+)/.exec(text)
  if (match) {
    return '「' + formatKeybindingCombo(combo) + '」已经用于「' + keybindingActionName(match[1]) + '」，请换一个组合键。'
  }
  match = /Default shortcut conflicts with: *([^\s']+)/.exec(text)
  if (match) {
    return '默认键位与「' + keybindingActionName(match[1]) + '」冲突，请先修改那一项。'
  }
  match = /Unsupported shortcut key: *(.+)$/m.exec(text)
  if (match) return '不支持把「' + match[1].trim() + '」设为快捷键。'
  if (/Shortcut cannot be empty/.test(text)) return '组合键不能为空。'
  if (/Shortcut requires a modifier key/.test(text)) return '除 F1–F12 外，组合键必须包含 Ctrl / Shift / Alt。'
  if (/Duplicate shortcut modifier/.test(text)) return '同一个修饰键不能出现两次。'
  if (/must contain exactly one key/.test(text)) return '一个快捷键只能包含一个非修饰键。'
  if (/Unknown shortcut action/.test(text)) return '未知的快捷键动作。'
  return text || '保存快捷键失败。'
}

// ── 录制让位 ────────────────────────────────────────────────────────────
function setRecordingOnMain (value: boolean): void {
  // 失败不阻塞 UI：主进程还有销毁 / 导航兜底，最坏情况是内置键没让出（重试一次即可）。
  rpc(IPC_ROUTES.keybindingsSetRecording, { recording: value }).catch(() => {})
}

// ── 状态判定 ────────────────────────────────────────────────────────────
function isModified (action: ShortcutAction): boolean {
  return keybindings[action.id] !== defaults[action.id]
}

/**
 * 草稿 → 输入框显示文本。
 * 尾随 `+` 表示只按下了修饰键，用省略号明确"还差一个主键"。
 */
function draftText (value = ''): string {
  if (!value) return ''
  if (value.endsWith('+')) return formatKeybindingCombo(value.slice(0, -1)) + ' + …'
  return formatKeybindingCombo(value)
}

function paintInput (input: HTMLInputElement): void {
  input.value = draftText(draft)
  input.classList.toggle('is-recording', recording)
}

// ── 行 / 分组 ───────────────────────────────────────────────────────────
function buildRow (action: ShortcutAction): HTMLElement {
  const modified = isModified(action)
  const editing = editingAction === action.id

  const row = el('div', 'kb-row')
  row.dataset.action = action.id
  if (modified && !editing) row.classList.add('is-modified')
  if (editing) row.classList.add('is-editing')

  const name = el('div', 'kb-name')
  name.appendChild(el('span', 'kb-name-text', action.name))
  // 已修改的行在名字旁挂一条划掉的默认键位，用户不用去翻文档对照。
  if (modified && !editing) {
    const fallback = el('span', 'kb-default', formatKeybindingCombo(defaults[action.id]))
    fallback.title = '默认键位'
    name.appendChild(fallback)
  }
  row.appendChild(name)

  if (editing) {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'kb-combo kb-combo-input'
    input.readOnly = true
    input.spellcheck = false
    input.placeholder = '按下组合键…'
    input.setAttribute('aria-label', action.name + '：按下新的组合键')
    paintInput(input)
    input.addEventListener('keydown', (event) => onRecordKeydown(event, action, input))
    row.appendChild(input)

    const actions = el('div', 'kb-actions')
    actions.append(
      miniButton('保存', '保存这个组合键', () => saveEditing(action, input), 'btn-mini btn-primary'),
      miniButton('取消', '放弃这次修改', () => cancelEditing(), 'btn-mini'),
      miniButton('重置', '恢复默认键位', () => resetOne(action), 'btn-mini', defaults[action.id] === keybindings[action.id])
    )
    row.appendChild(actions)

    // 渲染完才知道节点在树上；下一帧聚焦，用户点「编辑」后可直接按键。
    requestAnimationFrame(() => {
      try { input.focus() } catch (_) {}
    })
  } else {
    const display = formatKeybindingCombo(keybindings[action.id]) || '未设置'
    const combo = el(
      'button',
      'kb-combo' + (modified ? ' is-modified' : ''),
      display
    )
    combo.type = 'button'
    combo.title = '点击修改'
    combo.setAttribute('aria-label', action.name + '：' + display + '，点击修改')
    combo.addEventListener('click', () => startEditing(action.id))
    row.appendChild(combo)

    const actions = el('div', 'kb-actions')
    actions.appendChild(miniButton('编辑', '修改快捷键', () => startEditing(action.id)))
    row.appendChild(actions)
  }

  return row
}

function miniButton (label: string, title: string, onClick: () => unknown, className?: string, disabled = false): HTMLButtonElement {
  const button = el('button', className || 'btn-mini', label)
  button.type = 'button'
  if (title) button.title = title
  if (disabled) button.disabled = true
  button.addEventListener('click', onClick)
  return button
}

function buildGroup (label: string, actions: ShortcutAction[]): HTMLElement {
  const section = el('section', 'section kb-group')
  const title = el('div', 'section-title', label)
  title.appendChild(el('span', 'count', String(actions.length)))
  section.appendChild(title)

  const list = el('div', 'kb-list')
  for (const action of actions) list.appendChild(buildRow(action))
  section.appendChild(list)
  return section
}

function renderEmptyState (title: string, hint: string): void {
  const box = el('div', 'empty')
  box.appendChild(el('div', 'empty-title', title))
  box.appendChild(el('div', 'empty-hint', hint))
  groupsHost.appendChild(box)
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function matchesQuery (action: ShortcutAction): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [
    action.name,
    action.id,
    formatKeybindingCombo(keybindings[action.id]),
    formatKeybindingCombo(defaults[action.id])
  ].some((value?) => String(value || '').toLowerCase().includes(q))
}

function render () {
  groupsHost.textContent = ''

  const visible = ALL_ACTIONS.filter(matchesQuery)
  const modified = visible.filter(isModified)

  // 「已修改」置顶；同一动作只在顶部出现一次，不在原分类里重复一行。
  if (modified.length) groupsHost.appendChild(buildGroup('已修改', modified))

  for (const group of KEYBINDING_GROUPS as unknown as readonly KeybindingGroup[]) {
    const actions = actionsOfGroup(group)
      .filter(matchesQuery)
      .filter((action) => !isModified(action))
    if (actions.length) groupsHost.appendChild(buildGroup(group.label, actions))
  }

  if (!visible.length) {
    renderEmptyState(
      '没有匹配的快捷键',
      '换个关键词试试：可以搜动作名称（例如「标签页」）或组合键（例如「Ctrl」）。'
    )
  }

  const modifiedTotal = ALL_ACTIONS.filter(isModified).length
  countEl.textContent = query
    ? '匹配 ' + visible.length + ' 项'
    : ALL_ACTIONS.length + ' 个动作 · ' + modifiedTotal + ' 项已修改'
  resetAllBtn.disabled = modifiedTotal === 0
}

// ── 编辑流程 ────────────────────────────────────────────────────────────
function startEditing (actionId: string): void {
  if (editingAction === actionId) return
  editingAction = actionId
  draft = keybindings[actionId] || ''
  recording = false
  clearFeedback()
  // 先让主进程停掉内置分发，再画输入框：反过来的话，用户在这两行之间按下
  // Ctrl+T 时按键还在走主进程，会先开出一个新标签页。
  setRecordingOnMain(true)
  render()
}

function stopEditing (): void {
  editingAction = null
  draft = ''
  recording = false
  setRecordingOnMain(false)
}

function cancelEditing (): void {
  stopEditing()
  clearFeedback()
  render()
}

async function saveEditing (action: ShortcutAction, input: HTMLInputElement): Promise<void> {
  if (!draft || draft.endsWith('+')) {
    showError('请先按下一个非修饰键（字母、数字、标点或 F1–F12 都可以）。')
    try { input.focus() } catch (_) {}
    return
  }
  try {
    const result = await rpc<{ combo?: string }>(IPC_ROUTES.keybindingsSet, { action: action.id, combo: draft })
    keybindings[action.id] = (result && result.combo) || draft
    stopEditing()
    clearFeedback()
    render()
  } catch (cause) {
    showError(explainError(cause, draft))
    try { input.focus() } catch (_) {}
  }
}

async function resetOne (action: ShortcutAction): Promise<void> {
  try {
    const result = await rpc<{ combo?: string }>(IPC_ROUTES.keybindingsResetOne, { action: action.id })
    keybindings[action.id] = (result && result.combo) || defaults[action.id]
    stopEditing()
    clearFeedback()
    render()
  } catch (cause) {
    showError(explainError(cause, defaults[action.id]))
  }
}

/**
 * 录制器的按键处理。只做「收集 → 显示」，保存永远是显式的 Enter ——
 * 按到一半就落库会让冲突提示连续弹好几次，也会把用户的试键操作变成既成事实。
 */
function onRecordKeydown (event: KeyboardEvent, action: ShortcutAction, input: HTMLInputElement): void {
  // 输入法组合中 / 合成事件（keyCode 229）：既不拦截也不当成快捷键
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    cancelEditing()
    return
  }

  if (event.key === 'Enter') {
    saveEditing(action, input)
    return
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    draft = ''
    recording = true
    clearFeedback()
    paintInput(input)
    return
  }

  if (MODIFIER_KEYS.has(event.key)) {
    // 只按下修饰键：显示已按住的修饰键 + 省略号，松手 / 继续按主键都不会误存。
    draft = comboFromParts({
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey
    })
    recording = true
    paintInput(input)
    return
  }

  draft = comboFromParts({
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode
  })
  recording = false
  clearFeedback()
  paintInput(input)
}

// ── 工具条 / 对话框 ─────────────────────────────────────────────────────
let searchTimer = 0
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer)
  // 300ms debounce：每次按键都重排 53 行会让输入发飘（RT 同值）。
  searchTimer = window.setTimeout(() => {
    query = searchInput.value.trim()
    render()
  }, 300)
})

resetAllBtn.addEventListener('click', () => {
  if (typeof resetDialog.showModal === 'function' && !resetDialog.open) resetDialog.showModal()
})

requiredElement<HTMLButtonElement>('reset-cancel').addEventListener('click', () => resetDialog.close())

requiredElement<HTMLButtonElement>('reset-confirm').addEventListener('click', async () => {
  resetDialog.close()
  try {
    await rpc(IPC_ROUTES.keybindingsReset)
    keybindings = { ...defaults }
    stopEditing()
    clearFeedback()
    render()
    showFeedback('已恢复全部默认快捷键。', 'success')
  } catch (cause) {
    showError(explainError(cause, ''))
  }
})

// 页面离开 / 关闭：立刻解除让位（主进程还有 destroyed / did-navigate 兜底，这里是双保险）。
window.addEventListener('pagehide', () => setRecordingOnMain(false))

// 切到别的标签：本页仍驻留在内存里（没有 pagehide），但已经收不到任何按键。
// 若不在这里解除让位，主进程会一直停在「按键不分发」状态 —— 用户以为整个浏览器的
// 快捷键都坏了。隐藏即当作取消编辑：反正用户也没法在这个页面上继续按键。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !editingAction) return
  stopEditing()
  clearFeedback()
  render()
})

// ── 启动 ────────────────────────────────────────────────────────────────
async function load () {
  try {
    const [current, defaultsResult] = await Promise.all([
      rpc<KeybindingMap>(IPC_ROUTES.keybindingsGet),
      rpc<KeybindingMap>(IPC_ROUTES.keybindingsDefaults)
    ])
    keybindings = { ...KEYBINDING_DEFAULTS, ...(current || {}) }
    defaults = { ...KEYBINDING_DEFAULTS, ...(defaultsResult || {}) }
  } catch (cause) {
    showError('读取快捷键失败：' + explainError(cause))
  }
  render()
}

load()
