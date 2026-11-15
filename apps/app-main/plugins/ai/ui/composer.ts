/**
 * AI 面板 · 输入区（唯一的"发起回合"入口）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 四件事，各自独立
 * ══════════════════════════════════════════════════════════════════════
 * 1. **输入**：textarea 自增高、Enter 发送 / Shift+Enter 换行（输入法组合期不拦截）。
 * 2. **触发**：`@` 引用（页面 / 选区 / 截图 / 文件）、`/` 技能、模型选择 ——
 *    三者共用同一个浮层，只是数据源不同（一份实现，三处调用）。
 * 3. **拖入**：链接 → 页面引用；文件 → 文件引用；纯文本 → 文本引用。
 * 4. **引用 chip**：采集与去重都在 store，这里只画与删。
 *
 * 采集本身一律走 `store.captureInto` —— 空态卡、右键意图、拖入、`@` 菜单
 * 四条入口最终落到同一个函数，不会出现"某条入口的图没进上下文"。
 */

import { attach, h, icon, clip } from './dom.js'
import { chipElement } from './chips.js'
import { createReasonSlider } from './reason-slider.js'
import type { AiContextItem, AiSkill, AiUiState } from './types.js'
import type { AiStore } from './store.js'

interface SourceCandidate {
  title?: string
  url?: string
  sub?: string
  favicon?: string
  [key: string]: unknown
}

interface PopoverItemOptions {
  glyph?: string
  title: string
  sub?: string
  active?: boolean
  tone?: string
  onPick: () => void
}

/**
 * `@` 菜单的固定动作（顺序即优先级：最常用的页面引用在最上）。
 * 带 `source` 的条目是**二级列表**（打开的标签 / 已关闭 / 书签 / 历史），
 * 选中后进入 `mode === 'source'` 复用同一层浮层 —— 不另起一套 UI。
 */
const CONTEXT_ACTIONS = Object.freeze([
  { id: 'page', iconName: 'Globe', title: '当前页面', sub: '读取所在标签的正文' },
  { id: 'selection', iconName: 'MessageSquare', title: '选中文字', sub: '需要先在网页上选中一段' },
  { id: 'tab', iconName: 'Layers', title: '打开的标签…', sub: '从其它标签里挑一个', source: 'tab' },
  { id: 'closed-tab', iconName: 'Clock', title: '最近关闭…', sub: '刚关掉的页面也能找回', source: 'closed-tab' },
  { id: 'bookmark', iconName: 'Star', title: '书签…', sub: '从收藏里挑一个', source: 'bookmark' },
  { id: 'history', iconName: 'Clock', title: '历史记录…', sub: '按标题或网址搜', source: 'history' },
  { id: 'screenshot', iconName: 'Camera', title: '截图', sub: '把当前视图截下来' },
  { id: 'workspace', iconName: 'Folder', title: '本地工作区…', sub: '允许 AI 读写一个项目或文件夹' },
  { id: 'file', iconName: 'Folder', title: '本地文件…', sub: '也可以直接把文件拖进来' }
])

/** 二级来源列表的标题（浮层顶部那条）。 */
const SOURCE_TITLE: Record<string, string> = Object.freeze({
  tab: '打开的标签',
  'closed-tab': '最近关闭',
  bookmark: '书签',
  history: '历史记录'
})

const MODE_TITLE: Record<string, string> = Object.freeze({ context: '引用内容', source: '引用内容', skill: '技能', model: '选择模型', reasoning: '思考强度' })

/** 推理等级的说明（浮层副标题；沿用文档里的口径）。 */
const REASONING_HINT: Record<string, string> = Object.freeze({
  auto: '由服务端按任务决定，必要时最深',
  low: '更快，适合日常问答',
  medium: '平衡速度与深度',
  high: '深度思考，复杂问题'
})

/**
 * @param {Document} doc
 * @param {{
 *   store: any,
 *   onSent?: (result: any) => void,
 *   onOpenSettings?: (tab?: string) => void
 * }} deps
 */
export function createComposer(doc: Document, deps: {
  store: AiStore,
  onSent?: (result: unknown) => void,
  onOpenSettings?: (tab?: string) => void
}) {
  const { store } = deps
  const win = doc.defaultView
  const element = h(doc, 'div', 'ai-composer')

  const chipsBox = h(doc, 'div', 'ai-composer__chips')
  const box = h(doc, 'div', 'ai-composer__box')
  const input: HTMLTextAreaElement = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', 'ai-composer__input'))
  input.rows = 1
  input.placeholder = '问点什么，或输入 @ 引用页面…'
  input.spellcheck = false

  const bar = h(doc, 'div', 'ai-composer__bar')
  const attachBtn = toolButton(doc, 'Paperclip', '引用内容')
  const skillBtn = toolButton(doc, 'Zap', '技能')
  const modelBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-model-btn'))
  modelBtn.type = 'button'
  modelBtn.title = '选择模型'
  const modelLabel = h(doc, 'span', 'ai-model-btn__label', '模型')
  modelBtn.appendChild(modelLabel)
  const modelChevron = icon(doc, 'ChevronDown', 10)
  if (modelChevron) modelBtn.appendChild(modelChevron)

  // 思考强度（模型的 `reasoning: 'none'` 时整颗按钮不出现 —— 不留一个点不动的死按钮）
  const reasonBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-model-btn ai-reason-btn'))
  reasonBtn.type = 'button'
  reasonBtn.title = '思考强度'
  const reasonLabel = h(doc, 'span', 'ai-model-btn__label', '自动')
  reasonBtn.appendChild(reasonLabel)
  const reasonChevron = icon(doc, 'ChevronDown', 10)
  if (reasonChevron) reasonBtn.appendChild(reasonChevron)

  // 审批模式（两态）：允许 = 非破坏性工具一律放行；询问 = 按工具声明先弹审批卡。
  // 语义与引擎侧 `tool-gate#evaluate` 是同一套（判定只在主进程实现一次），这里只是一个开关。
  const approvalBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-model-btn ai-approval-btn'))
  approvalBtn.type = 'button'
  const approvalGlyph = h(doc, 'span', 'ai-approval-btn__glyph')
  const approvalLabel = h(doc, 'span', 'ai-model-btn__label', '询问')
  attach(approvalBtn, approvalGlyph, approvalLabel)

  const spacer = h(doc, 'span', 'ai-composer__spacer')
  const sendBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-composer__send'))
  sendBtn.type = 'button'
  sendBtn.title = '发送'
  sendBtn.setAttribute('aria-label', '发送')
  // 先画一次图标：setRunning 有「状态没变就早退」的短路，
  // 若只靠它初始化，首次 false→false 会直接被跳过，按钮就成了空圆。
  paintSendGlyph(false)

  attach(bar, attachBtn, skillBtn, modelBtn, reasonBtn, approvalBtn, spacer, sendBtn)
  attach(box, input, bar)
  attach(element, chipsBox, box)

  // 浮层（三个触发源共用）
  const popover = h(doc, 'div', 'ai-popover')
  popover.hidden = true
  element.appendChild(popover)

  // 选文件用的隐藏 input（面板没有 dialog 权限，走系统原生选择器）
  const filePicker: HTMLInputElement = /** @type {HTMLInputElement} */ (h(doc, 'input', 'ai-composer__file'))
  filePicker.type = 'file'
  filePicker.multiple = true
  filePicker.hidden = true
  element.appendChild(filePicker)

  /** @type {null|'context'|'source'|'skill'|'model'|'reasoning'} */
  let mode: null|'context'|'source'|'skill'|'model'|'reasoning' = null
  /** 当前浮层里可选的数据（context 是静态动作，另两种是实时列表）。 */
  let query = ''
  /** 二级来源列表：当前来源类型 + 已取回的候选（本地过滤，不再往返 IPC）。 */
  let sourceKind = ''
  /** @type {any[]} */
  let sourceItems: SourceCandidate[] = []
  let sourceLoading = false
  /** 异步取候选的序号：迟到的旧响应不能覆盖新列表。 */
  let sourceToken = 0
  let chipsSignature = ''
  let approvalSignature = ''
  let running = false
  let busy = false
  /** 推理滑块实例 + 档位签名（档位集合变了才重建，避免状态刷新把焦点/拖拽打断）。 */
  /** @type {any} */
  let reasonSlider: ReturnType<typeof createReasonSlider> | null = null
  let reasonSliderSig = ''

  // ── 浮层 ────────────────────────────────────────────────────────────
  /** @returns {boolean} 之前是否真的有一层浮层（宿主的 Esc 分层据此判断）。 */
  function closePopover() : boolean {
    if (mode === null && popover.hidden) return false
    mode = null
    query = ''
    sourceKind = ''
    sourceItems = []
    sourceLoading = false
    sourceToken++
    popover.hidden = true
    popover.classList.remove('is-reason')
    popover.textContent = ''
    // 滑块 DOM 已随浮层销毁，引用一并清掉（否则下次开浮层会拿到一个脱树的控件）
    if (reasonSlider && typeof reasonSlider.dispose === 'function') reasonSlider.dispose()
    reasonSlider = null
    reasonSliderSig = ''
    return true
  }

  function isPopoverOpen(): boolean {
    return mode !== null || !popover.hidden
  }

  function openPopover(next: 'context' | 'source' | 'skill' | 'model' | 'reasoning', nextQuery: string = ''): void {
    mode = next
    query = nextQuery
    popover.hidden = false
    renderPopover()
  }

  /** @param {any} opts */
  function popoverItem({ glyph, title, sub, active, tone, onPick }: PopoverItemOptions): HTMLButtonElement {
    const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', `ai-popover__item${active ? ' is-active' : ''}`))
    btn.type = 'button'
    if (glyph) {
      const box2 = h(doc, 'span', `ai-popover__glyph${tone ? ` is-tone-${tone}` : ''}`)
      const svg = icon(doc, glyph, 14)
      if (svg) box2.appendChild(svg)
      btn.appendChild(box2)
    }
    const main = h(doc, 'span', 'ai-popover__main')
    main.appendChild(h(doc, 'span', 'ai-popover__title', title))
    if (sub) main.appendChild(h(doc, 'span', 'ai-popover__sub', sub))
    btn.appendChild(main)
    // 浮层点击不能让 textarea 先失焦（否则 selectionStart 丢）
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', () => { onPick() })
    return btn
  }

  function match(text: unknown, needle: string): boolean {
    if (!needle) return true
    return String(text || '').toLowerCase().includes(needle.toLowerCase())
  }

  function renderPopover() {
    if (mode === null) return
    // 思考强度是唯一一个"有状态"的浮层：走独立路径，不重画控件本身
    if (mode === 'reasoning') { renderReasoning(); return }
    popover.classList.remove('is-reason')
    popover.textContent = ''
    const state = store.get()
    let count = 0

    if (mode === 'context') {
      for (const action of CONTEXT_ACTIONS) {
        if (!match(action.title, query)) continue
        popover.appendChild(popoverItem({
          glyph: action.iconName,
          title: action.title,
          sub: action.sub,
          onPick: () => {
            // 二级列表：不消耗触发符（要留着当过滤词），只把 `@xxx` 收成 `@`
            if (action.source) { openSource(action.source); return }
            consumeTrigger()
            closePopover()
            runContextAction(action.id)
          }
        }))
        count++
      }
    } else if (mode === 'source') {
      const head = h(doc, 'div', 'ai-popover__nav')
      const back: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-popover__back', '引用内容'))
      back.type = 'button'
      back.addEventListener('mousedown', (e) => e.preventDefault())
      back.addEventListener('click', () => backToContext())
      head.appendChild(back)
      head.appendChild(h(doc, 'span', 'ai-popover__nav-title', SOURCE_TITLE[sourceKind] || ''))
      popover.appendChild(head)

      for (const it of sourceItems) {
        if (query && !match(it.title, query) && !match(it.url, query) && !match(it.sub, query)) continue
        popover.appendChild(popoverItem({
          glyph: it.favicon ? '' : 'Globe',
          title: String(it.title || it.url || ''),
          sub: it.sub || clip(it.url, 60),
          onPick: () => { pickSource(it) }
        }))
        count++
      }
      if (!count) {
        popover.appendChild(h(doc, 'div', 'ai-popover__empty', sourceLoading ? '正在读取…' : '没有匹配项'))
      }
    } else if (mode === 'skill') {
      const skills = Array.isArray(state.skills) ? state.skills : []
      for (const skill of skills) {
        if (!skill || !skill.id) continue
        if (!match(skill.label, query) && !match(skill.description, query)) continue
        const meta = store.skillKindMeta(skill.kind)
        popover.appendChild(popoverItem({
          glyph: meta.icon || 'Zap',
          tone: meta.tone,
          title: String(skill.label || skill.id),
          sub: clip(skill.description || skill.prompt || '', 60),
          onPick: () => { pickSkill(skill) }
        }))
        count++
      }
      if (!count) {
        popover.appendChild(popoverItem({
          glyph: 'Plus',
          title: '还没有技能',
          sub: '在设置里新建一条，就能用 / 快速调用',
          onPick: () => { closePopover(); if (deps.onOpenSettings) deps.onOpenSettings('skills') }
        }))
        count++
      }
    } else if (mode === 'model') {
      const options = store.modelOptions()
      let lastProvider = ''
      for (const opt of options) {
        if (opt.providerLabel !== lastProvider) {
          lastProvider = opt.providerLabel
          popover.appendChild(h(doc, 'div', 'ai-popover__group', lastProvider))
        }
        popover.appendChild(popoverItem({
          title: opt.label,
          sub: opt.modelId,
          active: opt.key === state.modelChoice,
          onPick: () => {
            closePopover()
            store.chooseModel(opt.key)
            focus()
          }
        }))
        count++
      }
      if (!count) {
        popover.appendChild(popoverItem({
          glyph: 'Settings',
          title: '还没有可用模型',
          sub: '先去设置里添加一个模型服务',
          onPick: () => { closePopover(); if (deps.onOpenSettings) deps.onOpenSettings('providers') }
        }))
        count++
      }
    } else if (mode === 'reasoning') {
      // 见下方 renderReasoning（单独一条路径：状态回流时不重画控件本身）
    }

    const currentMode: string = mode || ''
    if (!count && currentMode !== 'source' && currentMode !== 'reasoning') {
      popover.appendChild(h(doc, 'div', 'ai-popover__empty', `${MODE_TITLE[mode]} · 没有匹配项`))
    }
  }

  /**
   * 推理浮层：滑块只建一次，之后只是把值灌回去。
   *
   * 之所以不跟着 `renderPopover` 一起 `textContent = ''` 重画：滑块是**有状态控件**，
   * 拖动中重画会摘掉 DOM（pointer capture 中断），键盘焦点也会跟着丢 ——
   * 于是拖动一卡一卡、方向键按一次就失效。档位集合（`sig`）变了才重建。
   */
  function renderReasoning() {
    const state = store.get()
    const options = store.reasoningOptions()
    const sig = options.map((o) => o.value).join('|')
    if (reasonSlider && reasonSliderSig === sig && reasonSlider.element.parentNode === popover) {
      reasonSlider.setValue(state.reasoning)
      return
    }
    if (reasonSlider && typeof reasonSlider.dispose === 'function') reasonSlider.dispose()
    popover.textContent = ''
    popover.classList.add('is-reason')
    reasonSliderSig = sig
    reasonSlider = createReasonSlider(doc, {
      options,
      value: state.reasoning,
      hints: REASONING_HINT,
      // 拖动 / 点标签 / 键盘都走这里；**不关浮层** —— 用户可以连着拧
      onChange: (value) => { store.chooseReasoning(value as 'auto' | 'low' | 'medium' | 'high') }
    })
    popover.appendChild(reasonSlider.element)
  }

  // ── 二级来源列表（打开的标签 / 已关闭 / 书签 / 历史） ─────────────────
  /**
   * 进入二级来源列表。**只保留 `@` 触发符**（`@书签` → `@`），
   * 于是接下来敲的字就是候选列表的过滤词 —— 与 `@` 的一级过滤完全同构，
   * 不需要第二套"输入捕获"逻辑。
   */
  function openSource(kind: string): void {
    sourceKind = kind
    sourceItems = []
    sourceLoading = true
    const token = ++sourceToken
    mode = 'source'
    query = ''
    popover.hidden = false
    keepTriggerOnly()
    renderPopover()

    store.fetchCandidates(kind as 'tab' | 'closed-tab' | 'bookmark' | 'history', '').then((items) => {
      // 迟到的响应 / 已经离开这一层 → 丢弃（否则会把新列表覆盖成旧数据）
      if (token !== sourceToken || mode !== 'source') return
      sourceItems = Array.isArray(items)
        ? items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') as SourceCandidate[]
        : []
      sourceLoading = false
      renderPopover()
    })
  }

  function backToContext() {
    sourceKind = ''
    sourceItems = []
    sourceLoading = false
    sourceToken++
    mode = 'context'
    query = ''
    renderPopover()
  }

  async function pickSource(it: SourceCandidate): Promise<void> {
    if (!it || !it.url) return
    const kind = sourceKind
    const payload: { url: string; title: string; favicon?: string } = { url: String(it.url), title: String(it.title || '') }
    if (it.favicon) payload.favicon = String(it.favicon)
    consumeTrigger()
    closePopover()
    const item = await store.captureInto(kind, payload)
    if (item) focus()
  }

  /** 把 `@xxx` 收成 `@`（保留触发符、清掉已输入的一级过滤词）。 */
  function keepTriggerOnly() {
    const trigger = currentTrigger()
    if (!trigger) return
    const value = input.value
    const next = value.slice(0, trigger.start) + '@' + value.slice(trigger.caret)
    setValue(next)
    const caret = trigger.start + 1
    try { input.setSelectionRange(caret, caret) } catch (_) {}
  }

  // ── `@` / `/` 触发 ──────────────────────────────────────────────────
  /** 取光标前的触发词：`{ mode, query, start }`（start 是触发符的位置）。 */
  function currentTrigger() {
    const value = input.value
    const caret = input.selectionStart == null ? value.length : input.selectionStart
    const before = value.slice(0, caret)
    const m = /(^|\s)([@/])([^\s@/]*)$/.exec(before)
    if (!m) return null
    return {
      mode: m[2] === '@' ? 'context' : 'skill',
      query: m[3] || '',
      start: m.index + m[1].length,
      caret
    }
  }

  /** 选中浮层项后抹掉触发词（只删那一段，不碰用户其余文字）。 */
  function consumeTrigger() {
    const trigger = currentTrigger()
    if (!trigger) return
    const value = input.value
    const next = value.slice(0, trigger.start) + value.slice(trigger.caret)
    setValue(next)
    try { input.setSelectionRange(trigger.start, trigger.start) } catch (_) {}
  }

  function syncTrigger() {
    if (isMenuMode()) return
    const trigger = currentTrigger()
    if (!trigger) { closePopover(); return }
    // 二级来源列表：打字只更新过滤词，不回到一级菜单
    if (mode === 'source') {
      if (query === trigger.query) return
      query = trigger.query
      renderPopover()
      return
    }
    if (mode === trigger.mode && query === trigger.query) return
    openPopover(trigger.mode as 'context' | 'source' | 'skill' | 'model' | 'reasoning', trigger.query)
  }

  /** 由按钮打开、不参与 `@` / `/` 打字触发的浮层（模型、推理等级）。 */
  function isMenuMode() {
    return mode === 'model' || mode === 'reasoning'
  }

  // ── 采集动作 ────────────────────────────────────────────────────────
  async function runContextAction(id: string): Promise<void> {
    if (id === 'file') {
      try { filePicker.click() } catch (_) {}
      return
    }
    const item = await store.captureInto(id, undefined)
    if (item) focus()
  }

  filePicker.addEventListener('change', async () => {
    const files = filePicker.files ? Array.from(filePicker.files) : []
    filePicker.value = ''
    for (const file of files) {
      const path = pathFor(file)
      if (!path) continue
      await store.captureInto('file', { path, name: file.name })
    }
    focus()
  })

  /** Electron 43 起 `File.path` 已删除，唯一正路是 preload 暴露的 `webUtils`。 */
  function pathFor(file: File): string {
    const bridge = (win as unknown as { hira?: { files?: { pathFor?(file: File): string } } } | null)?.hira
    if (bridge && bridge.files && typeof bridge.files.pathFor === 'function') {
      try { return bridge.files.pathFor(file) || '' } catch (_) { return '' }
    }
    return (file as File & { path?: string }).path || ''
  }

  // ── 发送 / 停止 ─────────────────────────────────────────────────────
  /** 画发送 / 停止图标（`Send` 缺失时退化为 ↑，保证永远有可见指示）。 */
  function paintSendGlyph(isStop: boolean): void {
    sendBtn.textContent = ''
    if (isStop) {
      sendBtn.appendChild(h(doc, 'span', 'ai-stop-glyph'))
      return
    }
    const svg = icon(doc, 'Send', 15)
    if (svg) sendBtn.appendChild(svg)
    else sendBtn.textContent = '↑'
  }

  function setRunning(next: boolean): void {
    if (running === next) return
    running = next
    sendBtn.classList.toggle('is-stop', running)
    sendBtn.title = running ? '停止' : '发送'
    sendBtn.setAttribute('aria-label', running ? '停止' : '发送')
    paintSendGlyph(running)
    syncSendDisabled()
  }

  function syncSendDisabled() {
    const state = store.get()
    if (state.unavailable) { sendBtn.disabled = true; return }
    if (running) { sendBtn.disabled = false; return }
    sendBtn.disabled = busy || (!input.value.trim() && !state.chips.length)
  }

  async function submit() {
    if (busy) return
    const text = input.value.trim()
    const chips = store.get().chips
    if (!text && !chips.length) return
    busy = true
    syncSendDisabled()
    closePopover()
    let res
    try {
      // 回合进行中时 store.send 会自动走 steer（追加一句），这里不必分支
      res = await store.send({ text })
    } finally {
      busy = false
    }
    if (res && res.ok) setValue('')
    syncSendDisabled()
    if (typeof deps.onSent === 'function') deps.onSent(res)
    if (res && res.ok) focus()
  }

  async function toggleSend() {
    if (running) { await store.stop(); return }
    await submit()
  }

  sendBtn.addEventListener('click', () => { toggleSend() })
  attachBtn.addEventListener('click', () => {
    if (mode === 'context' || mode === 'source') { closePopover(); return }
    openPopover('context')
    focus()
  })
  skillBtn.addEventListener('click', () => {
    if (mode === 'skill') { closePopover(); return }
    openPopover('skill')
    focus()
  })
  modelBtn.addEventListener('click', () => {
    if (mode === 'model') { closePopover(); return }
    openPopover('model')
  })
  reasonBtn.addEventListener('click', () => {
    if (mode === 'reasoning') { closePopover(); return }
    openPopover('reasoning')
  })
  // 一按即切（两态开关，不做浮层）：用户要的是"少一次打扰"，不是再选一次
  approvalBtn.addEventListener('click', () => {
    store.chooseApprovalMode(store.get().approvalMode === 'allow' ? 'ask' : 'allow')
    focus()
  })

  // ── 键盘 ────────────────────────────────────────────────────────────
  input.addEventListener('input', () => {
    autosize()
    syncTrigger()
    syncSendDisabled()
  })
  input.addEventListener('click', () => { syncTrigger() })

  input.addEventListener('keydown', (e) => {
    // 输入法组合期：Enter 是在选词，不是在发送
    if (e.isComposing || e.keyCode === 229) return

    if (e.key === 'Escape') {
      if (mode !== null) { closePopover(); e.preventDefault() }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mode !== null && !isMenuMode()) {
        // 浮层开着时 Enter = 选中第一项（"打 @ 回车" 的直觉）
        const first: HTMLElement|null = /** @type {HTMLElement|null} */ (popover.querySelector('.ai-popover__item'))
        if (first) { e.preventDefault(); first.click(); return }
      }
      if (isMenuMode()) return
      e.preventDefault()
      submit()
    }
  })

  // ── 拖入 ────────────────────────────────────────────────────────────
  function hasPayload(dt: DataTransfer): boolean {
    if (!dt) return false
    const types = dt.types
    if (!types) return false
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files' || types[i] === 'text/uri-list' || types[i] === 'text/plain') return true
    }
    return false
  }

  element.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !hasPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    element.classList.add('is-drag-over')
  })
  element.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !hasPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    try { e.dataTransfer.dropEffect = 'copy' } catch (_) {}
    element.classList.add('is-drag-over')
  })
  element.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return
    element.classList.remove('is-drag-over')
  })
  element.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !hasPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    element.classList.remove('is-drag-over')

    const dt = e.dataTransfer
    const files = dt && dt.files ? Array.from(dt.files) : []
    if (files.length) {
      for (const file of files) {
        const path = pathFor(file)
        if (path) { await store.captureInto('file', { path, name: file.name }); continue }
        // 取不到路径（虚拟文件）时退回文本
        const text = await readAsText(file)
        if (text) await store.captureInto('text', { text })
      }
      focus()
      return
    }

    const uriList = dt ? safeGet(dt, 'text/uri-list') : ''
    const urls = uriList.split(/\r?\n/).map((u) => u.trim()).filter((u) => /^https?:/i.test(u))
    if (urls.length) {
      for (const url of urls) await store.captureInto('page', { url })
      focus()
      return
    }

    const plain = dt ? safeGet(dt, 'text/plain') : ''
    if (plain && plain.trim()) {
      await store.captureInto('text', { text: plain.trim() })
      focus()
    }
  })

  function safeGet(dt: DataTransfer, type: string): string {
    try { return String(dt.getData(type) || '') } catch (_) { return '' }
  }

  function readAsText(file: File): Promise<string> {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || '').slice(0, 200_000))
        reader.onerror = () => resolve('')
        reader.readAsText(file)
      } catch (_) { resolve('') }
    })
  }

  // ── 外部点击关浮层 ──────────────────────────────────────────────────
  function onDocMouseDown(e: MouseEvent): void {
    if (mode === null) return
    const target = e.target instanceof Node ? e.target : null
    if (target && (element.contains(target) || popover.contains(target))) return
    closePopover()
  }
  doc.addEventListener('mousedown', onDocMouseDown, true)

  // ── 值 / 焦点 ───────────────────────────────────────────────────────
  function autosize() {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }

  function setValue(value: unknown): void {
    const next = String(value == null ? '' : value)
    if (input.value === next) return
    input.value = next
    autosize()
    syncSendDisabled()
  }

  function getValue() {
    return input.value
  }

  function focus() {
    try { input.focus() } catch (_) {}
  }

  /** 技能的 prompt 拼在已有草稿后面（不覆盖用户已经写的字）。 */
  function joinDraft(text: unknown): string {
    const cur = input.value.trim()
    if (!cur) return String(text)
    return `${cur}\n\n${text}`
  }

  // ── 技能（`/` 选中） ────────────────────────────────────────────────
  /**
   * 三类技能的落点不同，但"取结果"只有一个入口（`store.runSkill`）：
   *   - `prompt`：把模板插进输入区；模板要用到页面/选区就先替用户采好（`needs`）；
   *   - `script`：隔离世界里跑完的文本**回填成文本引用**（不再塞进输入框 ——
   *     目录/正文这种长内容当草稿会把输入区撑成一堵墙）；
   *   - `agent`：同上插模板，但**直接发送**（它就是一条完整的指令）。
   * 外部扩展的 kind 走同一条路：拿回文本就插模板，`autoSend` 由实现决定。
   * @param {any} skill
   */
  async function pickSkill(skill: AiSkill): Promise<void> {
    consumeTrigger()
    closePopover()
    const res = await store.runSkill({ id: skill.id })
    // 失败原因由 store 的错误条显示（这里不再另造一套提示）
    if (!res || res.ok === false) return
    const kind = String(res.kind || skill.kind || 'prompt')

    if (kind === 'script') {
      const text = String(res.text || '')
      if (text) {
        await store.captureInto('text', { text, title: String(res.title || skill.label || '') }, { silent: true })
      }
      focus()
      return
    }

    for (const need of Array.isArray(res.needs) ? res.needs : []) {
      if (need === 'page' || need === 'selection') await store.captureInto(need, undefined, { silent: true })
    }
    const text = String(res.text || '')
    if (text) setValue(joinDraft(text))
    focus()
    if (res.autoSend) await submit()
  }

  /**
   * 按 id 触发一条技能（面板空态卡等"固定入口"用）。
   *
   * 与 `/` 菜单的 `pickSkill` 走**同一条路径**（prompt 插模板 / script 变引用 /
   * agent 采集后自动发送），不在这里重写一套发送逻辑。
   */
  async function pickSkillById(id: string): Promise<void> {
    const key = String(id || '')
    if (!key) return
    const skills = (store.get && store.get().skills) || []
    // 列表还没到位也照跑：`runSkill` 只认 id，`kind` 缺省会按 prompt 处理。
    await pickSkill(skills.find((s) => s && s.id === key) || { id: key })
  }

  // ── 视图更新 ────────────────────────────────────────────────────────
  /**
   * @param {any} state
   */
  function update(state: AiUiState): void {
    // chips
    const sig = (state.chips || []).map((c) => `${c.key}|${c.kind}`).join('~')
    if (sig !== chipsSignature) {
      chipsSignature = sig
      chipsBox.textContent = ''
      for (const chip of state.chips || []) {
        chipsBox.appendChild(chipElement(doc, chip, (key) => store.removeChip(key)))
      }
    }

    // 模型按钮
    const options = store.modelOptions()
    const current = options.find((o) => o.key === state.modelChoice)
    const label = current ? current.label : (state.providers.length ? '选择模型' : '未配置模型')
    if (modelLabel.textContent !== label) modelLabel.textContent = label

    // 思考强度：模型不支持（`reasoning: 'none'`）时整颗按钮隐藏
    const levels = store.reasoningOptions()
    const supported = levels.length > 1
    reasonBtn.hidden = !supported
    if (supported) {
      const level = levels.find((o) => o.value === state.reasoning) || levels[0]
      if (reasonLabel.textContent !== level.label) reasonLabel.textContent = level.label
      reasonBtn.title = `思考强度：${level.label}`
    }

    // 审批模式（允许 / 询问）：两态开关，图标 + 文案一起换
    const approvalMode = state.approvalMode === 'allow' ? 'allow' : 'ask'
    if (approvalMode !== approvalSignature) {
      approvalSignature = approvalMode
      const opt = store.approvalOptions().find((o) => o.value === approvalMode)
      approvalLabel.textContent = opt ? opt.label : approvalMode
      approvalBtn.title = opt ? opt.hint : ''
      approvalBtn.classList.toggle('is-allow', approvalMode === 'allow')
      approvalGlyph.textContent = ''
      const glyph = icon(doc, approvalMode === 'allow' ? 'ShieldCheck' : 'Shield', 12)
      if (glyph) approvalGlyph.appendChild(glyph)
      else approvalGlyph.textContent = approvalMode === 'allow' ? '✓' : '?'
    }

    // 运行态 / 可用性
    setRunning(!!state.sessionId && state.running.has(state.sessionId))
    input.disabled = !!state.unavailable
    attachBtn.disabled = !!state.unavailable
    skillBtn.disabled = !!state.unavailable
    approvalBtn.disabled = !!state.unavailable
    const placeholder = state.unavailable
      ? ''
      : running ? '回合进行中 · 回车追加一句…' : '问点什么，或输入 @ 引用页面…'
    if (input.placeholder !== placeholder) input.placeholder = placeholder
    syncSendDisabled()

    // 浮层开着时数据可能变了（模型列表 / 技能列表 / 推理档位）
    if (mode === 'model' || mode === 'skill' || mode === 'reasoning') renderPopover()
  }

  function dispose() {
    closePopover()
    doc.removeEventListener('mousedown', onDocMouseDown, true)
    if (element.parentNode) element.parentNode.removeChild(element)
  }

  setRunning(false)
  autosize()

  return {
    element,
    update,
    getValue,
    setValue,
    focus,
    submit,
    pickSkillById,
    closePopover,
    isPopoverOpen,
    dispose
  }
}

/**
 * 输入栏里的小图标按钮（比通用 icon-btn 更矮，不吃掉输入高度）。
 * @param {Document} doc
 * @param {string} iconName
 * @param {string} label
 */
function toolButton(doc: Document, iconName: string, label: string) {
  const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-composer__tool'))
  btn.type = 'button'
  btn.title = label
  btn.setAttribute('aria-label', label)
  const svg = icon(doc, iconName, 15)
  if (svg) btn.appendChild(svg)
  else btn.textContent = label.slice(0, 1)
  return btn
}
