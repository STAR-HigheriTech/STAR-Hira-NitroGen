// @ts-check
/**
 * 插件中心 · 「AI 技能」板块（`hira://plugins` → AI 技能）。
 *
 * 技能已经彻底插件化：内置 / 第三方技能由 **manifest `contributes.skills`** 声明，
 * 用户自建的技能单独存库。本板块只做管理与预览：
 *   · 插件技能 —— 只读（改文案请改插件），可**逐条启停**；
 *   · 我的技能 —— 可新建 / 编辑 / 删除 / 导出；
 *   · 两类共用同一条执行路径（`skills.run`），与面板 `/` 菜单完全一致。
 *
 * 本文件是**叶子视图**：不认识 IPC、不认识控制器，动作一律 emit 意图上抛；
 * 数据由 `plugins.ts` 通过 `setSkills` 推下来。这样它也能被别的宿主复用。
 */
import { el } from 'hira://shared/runtime.js'
import { actionButton, field, selectInput, textInput } from './controls.js'

export type SkillDispatch = (intent: Record<string, unknown>) => unknown
export type SkillNotice = (text: string, kind?: 'info' | 'error') => void

interface SkillRecord extends Record<string, unknown> {
  id: string
  label: string
  description: string
  kind: string
  prompt: string
  source: 'plugin' | 'user'
  enabled: boolean
  pluginId: string
  pluginName: string
  group: string
}

interface SkillKindMeta {
  kind: string
  label: string
  icon?: string
}

interface SkillOperationResult extends Record<string, unknown> {
  ok?: boolean
  code?: unknown
  message?: unknown
  text?: unknown
}

interface SkillDraft {
  id: string
  isNew: boolean
  label: string
  description: string
  kind: string
  prompt: string
}

export interface SkillsBoard {
  element: HTMLElement
  connect(dispatch: SkillDispatch, notify: SkillNotice): void
  setSkills(skills: unknown, kinds: unknown): void
  setError(message: string): void
  refresh(): void
}

/** 错误码 → 人话。空串 = 用户取消保存/打开对话框，不算错误。 */
const SKILL_ERROR: Readonly<Record<string, string>> = Object.freeze({
  AI_EXPORT_CANCELED: '',
  AI_SKILL_IMPORT_CANCELED: '',
  AI_SKILL_IMPORT_INVALID: '文件格式不对，需要 Hira 技能文件（.hira-ai-skill.json）',
  AI_SKILL_IMPORT_EMPTY: '文件里没有可导入的技能',
  AI_SKILL_EMPTY: '没有可导出的技能（插件贡献的技能不参与导出）',
  AI_SKILL_BUILTIN: '插件贡献的技能不能修改',
  AI_SKILL_INVALID: '技能内容不完整（名称与内容都不能为空）',
  AI_SKILL_NOT_FOUND: '技能不存在',
  AI_SKILL_NO_TAB: '当前没有可执行的页面',
  AI_SKILL_TIMEOUT: '脚本执行超时（3 秒）',
  AI_SKILL_SCRIPT_FAILED: '脚本执行出错',
  AI_SKILL_EMPTY_RESULT: '脚本没有返回内容',
  AI_EXPORT_FAILED: '导出失败'
})

const KIND_HINT: Readonly<Record<string, string>> = Object.freeze({
  prompt: '插入到输入框；支持 {{page}} / {{selection}} / {{context}} 三个自动引用占位符。',
  script: '在页面的只读快照上执行（隔离世界 + 脱离文档），改不到真实页面；返回值会变成一条文本引用。',
  agent: '自动采集所需引用后直接发送，适合「一步到位」的整段指令。'
})

const CONTENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  prompt: '提示词',
  script: '脚本源码',
  agent: '指令'
})

const SCRIPT_PLACEHOLDER = '// 直接写函数体；return 字符串/数组即为结果\n'
  + '// document 是页面的只读快照，删改都不会影响真实页面\n'
  + "return Array.from(document.querySelectorAll('h2')).map((el) => el.textContent)"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readSkill(value: unknown): SkillRecord | null {
  const row = asRecord(value)
  if (!row) return null
  const id = String(row.id || '').trim()
  if (!id) return null
  return {
    ...row,
    id,
    label: String(row.label || id),
    description: String(row.description || ''),
    kind: String(row.kind || 'prompt'),
    prompt: String(row.prompt || ''),
    source: row.source === 'plugin' ? 'plugin' : 'user',
    enabled: row.enabled !== false,
    pluginId: String(row.pluginId || ''),
    pluginName: String(row.pluginName || row.pluginId || ''),
    group: String(row.group || '通用')
  }
}

function readKind(value: unknown): SkillKindMeta | null {
  const row = asRecord(value)
  const kind = String(row?.kind || '').trim()
  if (!kind) return null
  return {
    kind,
    label: String(row?.label || kind),
    icon: row?.icon == null ? undefined : String(row.icon)
  }
}

function readResult(value: unknown): SkillOperationResult | null {
  return asRecord(value)
}

function clip(text: unknown, max = 180): string {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function newSkillId() {
  return `k_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createSkillsBoard(): SkillsBoard {
  const element = el('section', 'plugins-skills')
  element.hidden = true

  let skills: SkillRecord[] = []
  let kinds: SkillKindMeta[] = []
  let loading = true
  let failed = ''
  let draft: SkillDraft | null = null

  /** 意图出口 / 提示出口 —— 由 `plugins.ts` 在装配时接进来。 */
  let emit: SkillDispatch = () => undefined
  let notify: SkillNotice = () => {}

  function kindMeta(kind: unknown): SkillKindMeta {
    return kinds.find((item) => item.kind === String(kind || ''))
      || kinds[0]
      || { kind: 'prompt', label: '提示词', icon: 'Zap' }
  }

  function defaultKind(): string {
    return (kinds[0] && kinds[0].kind) || 'prompt'
  }

  /** 已知错误码翻中文；取消保持沉默。 */
  function explain(res: SkillOperationResult | null): string {
    if (!res) return ''
    const code = String(res.code || '')
    if (code in SKILL_ERROR) return SKILL_ERROR[code]
    return String(res.message || '') || (code ? `操作失败（${code}）` : '')
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function render() {
    element.textContent = ''

    if (loading && !skills.length) {
      element.appendChild(el('div', 'empty', '读取技能…'))
      return
    }
    if (draft) {
      element.appendChild(skillForm(draft))
      return
    }

    const bar = el('div', 'plugins-skills__toolbar')
    bar.append(
      actionButton('新建技能', { primary: true, onClick: () => startCreate() }),
      actionButton('导入…', { onClick: () => emit({ type: 'skill-import' }) }),
      actionButton('导出全部', { onClick: () => emit({ type: 'skill-export' }) }),
      actionButton('刷新', { onClick: () => { loading = true; render(); emit({ type: 'skill-refresh' }) } })
    )
    element.appendChild(bar)

    if (failed) {
      element.appendChild(el('div', 'plugins-skills__error', `读取技能失败：${failed}`))
      return
    }

    if (!skills.length) {
      const empty = el('div', 'empty')
      empty.appendChild(el('div', 'empty-title', '还没有技能'))
      empty.appendChild(el('div', 'empty-hint', '新建后可在 AI 输入框里用 / 调用；插件技能也能在这里逐条启停。'))
      empty.appendChild(actionButton('新建技能', { primary: true, onClick: () => startCreate() }))
      element.appendChild(empty)
      return
    }

    const pluginSkills = skills.filter((skill) => skill.source === 'plugin')
    const userSkills = skills.filter((skill) => skill.source !== 'plugin')

    if (pluginSkills.length) {
      element.appendChild(sectionTitle('插件贡献', pluginSkills.length, '随插件启停；单条可在这里关掉'))
      const groups = new Map<string, SkillRecord[]>()
      for (const skill of pluginSkills) {
        const key = skill.group || '通用'
        const bucket = groups.get(key)
        if (bucket) bucket.push(skill)
        else groups.set(key, [skill])
      }
      for (const [group, items] of groups) {
        element.appendChild(el('div', 'plugins-skills__group-title', `${group} · ${items.length}`))
        const grid = el('div', 'plugins-skills__grid')
        for (const skill of items) grid.appendChild(skillCard(skill))
        element.appendChild(grid)
      }
    }
    if (userSkills.length) {
      element.appendChild(sectionTitle('我的技能', userSkills.length, '存在本地，可编辑 / 删除 / 导出'))
      const grid = el('div', 'plugins-skills__grid')
      for (const skill of userSkills) grid.appendChild(skillCard(skill))
      element.appendChild(grid)
    }
  }

  function sectionTitle(title: string, count: number, hint: string): HTMLElement {
    const head = el('div', 'plugins-skills__section')
    head.append(
      el('span', 'plugins-skills__section-name', title),
      el('span', 'plugins-skills__section-count', String(count)),
      el('span', 'plugins-skills__section-hint', hint)
    )
    return head
  }

  function skillCard(skill: SkillRecord): HTMLElement {
    const meta = kindMeta(skill.kind)
    const card = el('div', 'plugins-skills__card' + (skill.enabled === false ? ' is-off' : ''))

    const head = el('div', 'plugins-skills__card-head')
    head.appendChild(el('span', 'plugins-skills__card-name', skill.label || skill.id))
    head.appendChild(el('span', 'plugins-skills__badge', meta.label || meta.kind))
    head.appendChild(el('span', 'plugins-skills__badge is-source', skill.source === 'plugin' ? (skill.pluginName || '插件') : '自建'))
    head.appendChild(skillSwitch(skill))
    card.appendChild(head)

    if (skill.description) card.appendChild(el('div', 'plugins-skills__desc', clip(skill.description, 140)))
    card.appendChild(el('div', 'plugins-skills__preview', clip(skill.prompt || '', 180)))

    const actions = el('div', 'plugins-skills__actions')
    actions.appendChild(actionButton('试运行', { small: true, onClick: () => runInline(skill, card) }))

    if (skill.source === 'plugin') {
      actions.appendChild(el('span', 'plugins-skills__muted', '内容由插件提供，改动请更新插件'))
    } else {
      actions.append(
        actionButton('编辑', { small: true, onClick: () => startEdit(skill) }),
        actionButton('导出', { small: true, onClick: () => emit({ type: 'skill-export', ids: [skill.id] }) }),
        actionButton('删除', {
          small: true,
          danger: true,
          onClick: () => emit({ type: 'skill-remove', id: skill.id, label: skill.label || skill.id })
        })
      )
    }
    card.appendChild(actions)

    const output = el('pre', 'plugins-skills__output')
    output.hidden = true
    card.appendChild(output)
    return card
  }

  /** 单条启停开关（与插件开关同一颗 `.switch`）。 */
  function skillSwitch(skill: SkillRecord): HTMLButtonElement {
    const sw = el('button', 'switch')
    sw.type = 'button'
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', skill.enabled === false ? 'false' : 'true')
    sw.setAttribute('data-skill-switch', skill.id)
    sw.title = skill.enabled === false ? '已停用（不会出现在 / 菜单里）' : '已启用（出现在 / 菜单里）'
    sw.addEventListener('click', () => {
      emit({ type: 'skill-toggle', id: skill.id, enabled: sw.getAttribute('aria-checked') !== 'true' })
    })
    return sw
  }

  async function runInline(skill: SkillRecord, card: HTMLElement): Promise<void> {
    const output = card.querySelector<HTMLPreElement>('.plugins-skills__output')
    if (!output) return
    output.hidden = false
    output.textContent = '运行中…'
    const res = readResult(await emit({
      type: 'skill-run',
      draft: { id: skill.id, kind: skill.kind, label: skill.label, prompt: skill.prompt }
    }))
    if (!res || res.ok === false) {
      output.textContent = explain(res) || '运行失败'
      return
    }
    output.textContent = String(res.text || '（没有输出）')
  }

  function startCreate() {
    draft = { id: newSkillId(), isNew: true, label: '', description: '', kind: defaultKind(), prompt: '' }
    render()
    const input = element.querySelector<HTMLInputElement>('.plugins-skills__form input')
    if (input) { try { input.focus() } catch (_) {} }
  }

  function startEdit(skill: SkillRecord): void {
    draft = {
      id: String(skill.id || ''),
      isNew: false,
      label: String(skill.label || ''),
      description: String(skill.description || ''),
      kind: String(skill.kind || 'prompt'),
      prompt: String(skill.prompt || '')
    }
    render()
  }

  function skillForm(current: SkillDraft): HTMLElement {
    const form = el('div', 'plugins-skills__form')
    const head = el('div', 'plugins-skills__form-head', current.isNew ? '新建技能' : '编辑技能')
    form.appendChild(head)

    const labelInput = textInput(current.label, '例如 总结要点')
    const descInput = textInput(current.description, '一句话说明（会显示在 / 列表里）')
    const kindSelect = selectInput(
      (kinds.length ? kinds : [{ kind: 'prompt', label: '提示词' }])
        .map((meta) => ({ value: meta.kind, label: meta.label })),
      current.kind
    )
    form.append(field('名称', labelInput), field('说明', descInput), field('类型', kindSelect))

    const hint = el('div', 'plugins-skills__hint', KIND_HINT[current.kind] || '')
    form.appendChild(hint)

    const contentArea: HTMLTextAreaElement = /** @type {HTMLTextAreaElement} */ (el('textarea', 'plugins-skills__textarea'))
    contentArea.rows = current.kind === 'script' ? 12 : 8
    contentArea.spellcheck = false
    contentArea.value = current.prompt
    contentArea.placeholder = current.kind === 'script' ? SCRIPT_PLACEHOLDER : '指令正文'
    const contentLabel = el('div', 'plugins-skills__label', CONTENT_LABEL[current.kind] || '内容')
    form.append(contentLabel, contentArea)

    kindSelect.addEventListener('change', () => {
      const next = kindSelect.value
      hint.textContent = KIND_HINT[next] || ''
      contentArea.rows = next === 'script' ? 12 : 8
      contentArea.placeholder = next === 'script' ? SCRIPT_PLACEHOLDER : '指令正文'
      contentLabel.textContent = CONTENT_LABEL[next] || '内容'
    })

    const output = el('pre', 'plugins-skills__output')
    output.hidden = true
    form.appendChild(output)

    const actions = el('div', 'plugins-skills__actions')
    actions.append(
      actionButton('试运行', {
        onClick: async () => {
          const prompt = contentArea.value.trim()
          if (!prompt) { notify('内容不能为空', 'error'); return }
          output.hidden = false
          output.textContent = '运行中…'
          const res = readResult(await emit({
            type: 'skill-run',
            draft: { id: current.id, kind: kindSelect.value, label: labelInput.value.trim(), prompt }
          }))
          if (!res || res.ok === false) {
            output.textContent = explain(res) || '运行失败'
            return
          }
          output.textContent = String(res.text || '（没有输出）')
        }
      }),
      actionButton('保存', {
        primary: true,
        onClick: async () => {
          const label = labelInput.value.trim()
          const prompt = contentArea.value.trim()
          if (!label || !prompt) { notify('名称与内容都不能为空', 'error'); return }
          const kind = kindSelect.value
          const res = readResult(await emit({
            type: 'skill-save',
            id: current.id,
            label,
            description: descInput.value.trim(),
            prompt,
            kind,
            icon: kindMeta(kind).icon || 'Zap'
          }))
          if (!res || res.ok === false) return
          draft = null
          loading = true
          render()
        }
      }),
      actionButton('取消', { onClick: () => { draft = null; render() } })
    )
    form.appendChild(actions)
    return form
  }

  // ── 宿主端口 ────────────────────────────────────────────────────────
  return {
    element,
    connect(dispatch, notice) {
      emit = dispatch
      notify = notice
    },
    setSkills(nextSkills, nextKinds) {
      skills = (Array.isArray(nextSkills) ? nextSkills : [])
        .map(readSkill)
        .filter((skill): skill is SkillRecord => skill !== null)
      kinds = (Array.isArray(nextKinds) ? nextKinds : [])
        .map(readKind)
        .filter((kind): kind is SkillKindMeta => kind !== null)
      if (!kinds.length) kinds = [{ kind: 'prompt', label: '提示词', icon: 'Zap' }]
      loading = false
      failed = ''
      render()
    },
    setError(message) {
      failed = String(message || '未知错误')
      loading = false
      render()
    },
    refresh() {
      loading = true
      failed = ''
      render()
      emit({ type: 'skill-refresh' })
    }
  }
}

