// @ts-check
/**
 * window/parts.js —— 管理窗口专用的**叶子 DOM**（卡片 / 表单控件 / 预览 mock）。
 *
 * 为什么不进 shared：侧栏窄面板**一个都不用**（它只有"当前主题 + 色卡 + 去窗口"）。
 * 把它们塞进 shared 会让面板也背上几百行用不到的代码 —— 那条纪律是：
 * "只有一个形态要 → 进那个形态自己的目录"。
 *
 * 每个 builder 返回 `{ element/row, …setValue }`：**控件引用交给调用方**，
 * 于是"草稿变了 → 更新控件显示"不需要任何选择器，也就不可能与结构脱节。
 */

import { el, clear, fieldRow, button } from '@hira-ng/shared-types/src/themes/dom.js'
import {
  toHexInput,
  toSliderValue,
  fromSliderValue,
  swatchBackground,
  swatchStrip,
  modeLabel,
  assetDisplayName,
  materialBadge,
  SOURCE_LABELS,
  sourceOf,
  AUTO_FG
} from '@hira-ng/shared-types/src/themes/format.js'

export interface ThemeSummary {
  id?: string
  name?: string
  mode?: string
  author?: string
  style?: Record<string, unknown>
  background?: Record<string, unknown>
  [key: string]: unknown
}

export interface ThemeOption {
  value: string
  label: string
}

export interface ThemeSliderSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
  scale: number
  hint?: string
}

export interface ThemeColorField {
  key: string
  label: string
  hint?: string
  getAuto?: () => unknown
}

interface ThemeCardOptions {
  active?: boolean
  onClick?: (theme: ThemeSummary) => void
}

interface FieldOptions { hint?: string }
interface TextRowOptions extends FieldOptions { disabled?: boolean; placeholder?: string }
interface AssetRowOptions extends FieldOptions {
  pickLabel?: string
  pickTitle?: string
  clearTitle?: string
  emptyText?: string
}

// ══════════════════════════════════════════════════════════════════════
// 主题卡片（库里一格）
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {Document} doc
 * @param {unknown} theme 目录摘要（见 main/ipc/theme.js#summarize）
 * @param {{ active?: boolean, onClick?: Function }} [opts]
 */
export function themeCard(doc: Document, theme: ThemeSummary, opts: ThemeCardOptions = {}): HTMLElement {
  const card = el(doc, 'div', 'thm-card')
  card.tabIndex = 0
  card.title = `${theme.name || theme.id}\n${SOURCE_LABELS[sourceOf(theme)]} · ${modeLabel(theme.mode)}`
  if (opts.active) card.dataset.active = '1'

  const shot = el(doc, 'div', 'thm-card__shot')
  shot.style.background = swatchBackground(theme)
  /**
   * 角标（左上角）。卡片不抽首帧（那要么进主进程解码、要么进渲染层 canvas，
   * 见 docs-ng/主题系统设计.md §6.4.3）—— 但"这条主题带动态壁纸"这件事
   * 必须在库里一眼看得出来，否则它与一条纯配色主题长得一模一样。
   *
   * 窗口材质同理，而且更隐蔽：亚克力预设的配色与基础浅色/深色**逐值相同**，
   * 光看卡片颜色分不出"哪张会让窗口透桌面"。合成一行文案，避免两个角标叠在一起。
   */
  const flags: string[] = []
  if (((theme.background || {}).kind) === 'video') flags.push('视频')
  const materialFlag = materialBadge(String((theme.style || {}).material || ''))
  if (materialFlag) flags.push(materialFlag)
  if (flags.length) shot.appendChild(el(doc, 'span', 'thm-card__flag', flags.join(' · ')))
  const strip = el(doc, 'div', 'thm-card__strip')
  for (const color of swatchStrip(theme)) {
    const cell = el(doc, 'span', 'thm-card__cell')
    cell.style.background = String(color)
    strip.appendChild(cell)
  }
  shot.appendChild(strip)
  if (opts.active) shot.appendChild(el(doc, 'span', 'thm-card__check', '✓'))

  const meta = el(doc, 'div', 'thm-card__meta')
  const nameLine = el(doc, 'div', 'thm-card__name')
  nameLine.appendChild(el(doc, 'span', 'thm-card__title', theme.name || theme.id))
  nameLine.appendChild(el(doc, 'span', 'thm-badge thm-badge--muted', modeLabel(theme.mode)))
  meta.appendChild(nameLine)
  const sub = el(doc, 'div', 'thm-card__sub', SOURCE_LABELS[sourceOf(theme)] + (theme.author ? ` · ${theme.author}` : ''))
  meta.appendChild(sub)

  card.append(shot, meta)

  if (typeof opts.onClick === 'function') {
    const onClick = opts.onClick
    card.addEventListener('click', () => onClick(theme))
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick(theme)
      }
    })
  }
  return card
}

// ══════════════════════════════════════════════════════════════════════
// 表单控件
// ══════════════════════════════════════════════════════════════════════

/**
 * 一行文本输入（主题名）。
 * @returns {{ row: HTMLElement, setValue: (v: string) => void }}
 */
export function textRow(
  doc: Document,
  label: string,
  value: unknown,
  onInput: (value: string) => void,
  opts: TextRowOptions = {}
): {
  row: HTMLElement
  input: HTMLInputElement
  setValue: (v?: unknown) => void
  setDisabled: (flag?: boolean) => void
} {
  const [row, host] = fieldRow(doc, label, opts.hint || '')
  const input = el(doc, 'input', 'thm-input')
  input.type = 'text'
  input.value = value == null ? '' : String(value)
  if (opts.disabled) input.disabled = true
  if (opts.placeholder) input.placeholder = opts.placeholder
  input.addEventListener('input', () => {
    lastShown = input.value
    onInput(input.value)
  })
  host.appendChild(input)
  /** 上一次推下来的值：同值不再写，避免每帧回写。 */
  let lastShown = value == null ? '' : String(value)
  return {
    row,
    input,
    setValue(v?: unknown) {
      const next = v == null ? '' : String(v)
      if (next === lastShown) return
      lastShown = next
      // 正在输入时不回写：否则光标会跳到末尾（每次按键都重建 value）
      if (doc.activeElement !== input) input.value = next
    },
    setDisabled(flag?: boolean) {
      input.disabled = !!flag
    }
  }
}

/**
 * 分段控件（浅色 / 深色、视图切换）。
 * @param {{ value: string, label: string }[]} options
 */
export function segmented(
  doc: Document,
  options: ThemeOption[],
  value: string,
  onChange: (value: string) => void
) {
  const wrap = el(doc, 'div', 'thm-seg')
  const items = new Map<string, HTMLButtonElement>()
  for (const opt of options) {
    const btn = el(doc, 'button', 'thm-seg__item', opt.label)
    btn.type = 'button'
    btn.dataset.value = opt.value
    btn.addEventListener('click', () => onChange(opt.value))
    items.set(opt.value, btn)
    wrap.appendChild(btn)
  }
  let lastActive: string | null = null
  const setValue = (next: string) => {
    if (next === lastActive) return
    /* 只碰状态真的变了的两颗按钮，其余保持原样（3 颗以内也不值得全量扫）。 */
    const prevBtn = lastActive == null ? null : items.get(lastActive)
    const nextBtn = items.get(next) || null
    if (prevBtn && prevBtn !== nextBtn) prevBtn.dataset.active = '0'
    if (nextBtn) nextBtn.dataset.active = '1'
    lastActive = next
  }
  setValue(value)
  return { element: wrap, setValue }
}

/**
 * 一行只读事实（标签 + 结论）。
 *
 * 用在"配置项只剩唯一取值"的场合（着色模式只剩「全部统一着色」）：仍然把它**说出来**
 * ——用户要知道界面是按什么口径着色的；但不摆一个只含一个 option 的下拉：
 * 那种控件点开与不点开完全一样，只会让人怀疑是不是坏了。
 */
export function valueRow(doc: Document, label: string, value: unknown, hint = '') {
  const [row, host] = fieldRow(doc, label, hint)
  const text = el(doc, 'span', 'thm-value', value == null ? '' : String(value))
  host.appendChild(text)
  let lastText = value == null ? '' : String(value)
  return {
    row,
    setValue(v?: unknown) {
      const next = v == null ? '' : String(v)
      if (next === lastText) return
      lastText = next
      text.textContent = next
    }
  }
}

/** 一行下拉。 */
export function selectRow(doc: Document, label: string, options: Array<{label:string;value:string}>, value: unknown, onChange: (value:string)=>void, opts: FieldOptions = {}) {
  const [row, host] = fieldRow(doc, label, opts.hint || '')
  const select = el(doc, 'select', 'thm-select')
  const fill = (list?: ThemeOption[]) => {
    const current = select.value
    clear(select)
    for (const opt of list || []) {
      const o = el(doc, 'option', '', opt.label)
      o.value = opt.value
      select.appendChild(o)
    }
    select.value = current
  }
  fill(options)
  select.value = String(value ?? '')
  select.addEventListener('change', () => onChange(select.value))
  host.appendChild(select)
  /**
   * 上一次设过的值（不能用 `select.value` 判等：值不在 options 里时读回来是 ''，
   * 会与传入值永远不等 → 每帧重写）。
   */
  let lastValue = value == null ? '' : String(value)
  /** 上一次设过的可见性（`setVisible` 内部判等用；初值与行本身的默认可见一致）。 */
  let shownVisible = true
  return {
    row,
    select,
    setValue(v: unknown) {
      const next = v == null ? '' : String(v)
      if (next === lastValue) return
      lastValue = next
      select.value = next
    },
    /** 选项变了（主题目录随插件启停变化）→ 换一批 option，尽量保住当前选中值。 */
    replaceOptions(list?: ThemeOption[]) {
      const keep = select.value
      fill(list)
      // 保住选中：新列表里还有这个值就留着，否则落到第一项（并同步通知调用方）
      if (keep && Array.from(select.options).some((o) => o.value === keep)) select.value = keep
      else select.value = select.options.item(0)?.value || ''
      lastValue = select.value
    },
    setVisible(flag?: boolean) {
      const next = !!flag
      if (next === shownVisible) return
      shownVisible = next
      row.style.display = next ? '' : 'none'
    }
  }
}

/** 裸下拉（不带"标签 + 控件"两列结构）—— 用在时段表这种一行多控件的场合。 */
export function inlineSelect(
  doc: Document,
  options: ThemeOption[],
  value: string,
  onChange: (value: string) => void
) {
  const select = el(doc, 'select', 'thm-select')
  for (const opt of options || []) {
    const o = el(doc, 'option', '', opt.label)
    o.value = opt.value
    select.appendChild(o)
  }
  select.value = value
  select.addEventListener('change', () => onChange(select.value))
  return select
}

/**
 * 一行滑杆（存储值是 0~1 或裸数值，控件用整数 —— 见 format.js#toSliderValue）。
 * @param {{ key: string, label: string, min: number, max: number, step: number, unit: string, scale: number }} spec
 */
export function sliderRow(
  doc: Document,
  spec: ThemeSliderSpec,
  value: unknown,
  onChange: (value: number) => void
) {
  const [row, host] = fieldRow(doc, spec.label, spec.hint || '')
  const line = el(doc, 'div', 'thm-slider')
  const input = el(doc, 'input', 'thm-slider__input')
  input.type = 'range'
  input.min = String(spec.min)
  input.max = String(spec.max)
  input.step = String(spec.step)
  const out = el(doc, 'span', 'thm-slider__value')
  /**
   * 上一次显示过的刻度值。
   *
   * 拖动时内核会把同一个值再推回来（草稿变了 → update → setValue），同值写 range
   * 会打断拖动、并让数字闪一下。记住它 = 拖动期间这根滑杆**零 DOM 写入**。
   */
  let lastShown: number | null = null
  const render = (v: number) => {
    if (v === lastShown) return
    lastShown = v
    input.value = String(v)
    out.textContent = `${v}${spec.unit || ''}`
  }
  render(toSliderValue(value, spec.scale, spec.min, spec.max))
  input.addEventListener('input', () => {
    const raw = Number(input.value)
    lastShown = raw
    out.textContent = `${raw}${spec.unit || ''}`
    onChange(fromSliderValue(raw, spec.scale))
  })
  line.append(input, out)
  host.appendChild(line)
  return {
    row,
    setValue(v?: unknown) {
      render(toSliderValue(v, spec.scale, spec.min, spec.max))
    }
  }
}

/**
 * 一行颜色（取色器 + hex 文本框）。
 * 两者**双向同步**，且只在颜色真的变了才回调 —— 拖取色盘时避免用同值反复写草稿。
 *
 * `field.getAuto` = 这一档允许「**自动**」：值是哨兵 `auto`（见 shared-types#AUTO_FG），
 * 由主进程按"背景明暗 + 遮罩设置"算出黑/白。此时取色器与 hex **显示的是生效值**
 * （只读，取自 `field.getAuto()`）—— 于是"自动"这一档也守住"显示 = 生效"。
 *
 * 开关**不在这里**：三档一起自动是编辑器「前景自动」总开关的事（见 themes.js），
 * 所以本函数只负责"值是不是 auto"的呈现与锁定 —— 一行一个"自动"按钮会让开关语义
 * 碎成三份（开一个、关一个，谁说了算说不清），已被总开关取代。
 */
export function colorRow(
  doc: Document,
  field: ThemeColorField,
  value: unknown,
  onChange: (value: string) => void
) {
  const [row, host] = fieldRow(doc, field.label, field.hint || '')
  const wrap = el(doc, 'div', 'thm-color')
  const picker = el(doc, 'input', 'thm-color__picker')
  picker.type = 'color'
  const hex = el(doc, 'input', 'thm-input thm-color__hex')
  hex.type = 'text'
  hex.spellcheck = false
  /** 是否允许 `auto` 哨兵 —— 由调用方是否给了 `getAuto` 决定（真源是 AUTO_FG_KEYS）。 */
  const getAuto = field.getAuto
  const canAuto = typeof getAuto === 'function'
  const isAutoValue = (raw?: unknown) => String(raw == null ? '' : raw).trim().toLowerCase() === AUTO_FG
  const autoColor = () => toHexInput(canAuto ? getAuto?.() : '', '#ffffff')
  let auto = false
  /** 上一次显示过的（原值, 生效色）—— 同值重复写会顶掉正在输入的选区，也白白触发重绘。 */
  let lastRaw: unknown = null
  let lastShown: string | null = null

  const render = (raw?: unknown) => {
    auto = canAuto && isAutoValue(raw)
    const shown = auto ? autoColor() : toHexInput(raw, '#000000')
    /* 「自动」档的显示色随壁纸亮度变，所以判据是（原值 + 当前生效色）两个都相同才算没变。 */
    if (raw === lastRaw && shown === lastShown) return
    lastRaw = raw
    lastShown = shown
    /* 别打断正在输入的那一格（用同值反复写会顶掉光标/选区）—— 自动档两个都禁用了，
       它们不是输入目标，所以自动时一律强制刷新（"自动算成什么色"必须立刻可见）。 */
    if (auto || doc.activeElement !== picker) picker.value = shown
    if (auto || doc.activeElement !== hex) hex.value = shown
    picker.disabled = auto
    hex.disabled = auto
  }

  const apply = (raw: unknown, source: 'picker' | 'hex') => {
    const next = toHexInput(raw, '#000000')
    if (source !== 'picker') picker.value = next
    if (source !== 'hex') hex.value = next
    onChange(next)
  }

  picker.addEventListener('input', () => apply(picker.value, 'picker'))
  hex.addEventListener('change', () => apply(hex.value, 'hex'))

  render(value)
  wrap.append(picker, hex)
  host.appendChild(wrap)
  return {
    row,
    setValue(v?: unknown) {
      render(v)
    }
  }
}

/**
 * 一行多选（背景应用到哪几个面）。
 * @param {{ value: string, label: string }[]} options
 * @param {string[]} values
 */
export function checkboxRow(doc: Document, label: string, options: Array<{label:string;value:string}>, values: string[], onToggle: (value:string,checked:boolean)=>void, opts: FieldOptions = {}) {
  const [row, host] = fieldRow(doc, label, opts.hint || '')
  const wrap = el(doc, 'div', 'thm-checks')
  const boxes = new Map()
  const initial = new Set(Array.isArray(values) ? values : [])
  for (const opt of options) {
    const line = el(doc, 'label', 'thm-check')
    const box = el(doc, 'input', 'thm-check__box')
    box.type = 'checkbox'
    box.checked = initial.has(opt.value)
    box.addEventListener('change', () => onToggle(opt.value, box.checked))
    boxes.set(opt.value, box)
    line.append(box, el(doc, 'span', 'thm-check__label', opt.label))
    wrap.appendChild(line)
  }
  host.appendChild(wrap)
  /** 上一次的勾选指纹（排序后拼接）——没变就一个 DOM 都不碰。 */
  let lastFingerprint = fingerprintOf(initial)
  return {
    row,
    setValue(list: unknown) {
      const set = new Set(Array.isArray(list) ? list : [])
      const fingerprint = fingerprintOf(set)
      if (fingerprint === lastFingerprint) return
      lastFingerprint = fingerprint
      for (const [key, box] of boxes) {
        const want = set.has(key)
        if (box.checked !== want) box.checked = want
      }
    }
  }
}

/** 勾选集合的指纹：与顺序无关（`a,b` 与 `b,a` 等价）。 */
function fingerprintOf(set: Iterable<string>) {
  let out = ''
  for (const key of Array.from(set).sort()) out += (out ? '\u0001' : '') + key
  return out
}

/**
 * 一行「背景资产」：**选择…** 按钮 + 当前文件名 + 清除。图片与视频共用这一行
 * （两者走的是同一条链，只有文案不同 —— 见 format.js#BACKGROUND_KINDS）。
 *
 * 为什么不给一个路径输入框（原来就是那样）：用户主题的资产是**拷进资产库**的
 * （选完就是内部 key），让用户看见并手改那个 key 既没有意义，也诱导他去写一个
 * 永远不生效的路径 —— 那正是这一栏原来的状态。名字只作反馈：他得看得出选的是哪个。
 *
 * @param {Document} doc
 * @param {string} label
 * @param {() => void} onPick 打开系统文件对话框（意图经宿主 → 主进程）
 * @param {() => void} onClear 清掉这个文件
 * @param {{ hint?: string, pickLabel?: string, pickTitle?: string, clearTitle?: string, emptyText?: string }} [opts]
 * @returns {{ row: HTMLElement, setValue: (key: string) => void }}
 */
export function assetRow(doc: Document, label: string, onPick: () => void, onClear: () => void, opts: AssetRowOptions = {}) : { row: HTMLElement, setValue: (key: string) => void } {
  const [row, host] = fieldRow(doc, label, opts.hint || '')
  const wrap = el(doc, 'div', 'thm-image')
  const pick = button(doc, opts.pickLabel || '选择图片…', {
    title: opts.pickTitle || '从文件管理器里选一个文件（会拷进主题资产库）',
    onClick: onPick
  })
  const name = el(doc, 'span', 'thm-image__name')
  const drop = button(doc, '清除', { title: opts.clearTitle || '不再使用它作为背景', onClick: onClear })
  wrap.append(pick, name, drop)
  host.appendChild(wrap)
  const emptyText = opts.emptyText || '未选择'
  /** 上一次设过的资产 key —— 没换文件就不碰文字/标题/清除按钮。 */
  let lastRaw: string | null = null
  return {
    row,
    setValue(key?: unknown) {
      const raw = key == null ? '' : String(key)
      if (raw === lastRaw) return
      lastRaw = raw
      name.textContent = raw ? assetDisplayName(raw) : emptyText
      name.title = raw
      // 没选文件时不摆一个必然无效果的"清除"
      drop.style.display = raw ? '' : 'none'
    }
  }
}
