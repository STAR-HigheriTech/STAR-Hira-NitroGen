// @ts-check
/**
 * `hira://aisettings` · 模型服务分区（OpenAI 兼容 / Responses / Anthropic）。
 *
 * 两条不能越过的线（与面板抽屉是同一口径，因为消费的是同一份引擎契约）：
 *   1. **id 由前端生成**：`providers.save` 是按 id upsert，不生成 `p_xxx` 就会把第二条
 *      写进同一个空 id；新建一律走 `newId('p')`。
 *   2. **密钥只写不读**：引擎只回 `hasKey`；输入框永远不回显明文，留空 = 不修改，
 *      显式「清除」才发 `apiKey: ''`。
 *
 * 本分区自带数据：挂载后拉一次、`ai:state-changed#providers` 时再拉；
 * 表单打开期间**不重建**（否则外部一次广播就会把手里的输入抹掉），取消时用最新数据重画。
 */
import { el } from 'hira://shared/runtime.js'
import type { AiProviderRecord } from 'hira://shared/ai-client.js'
import type { AiSettingsSection, AiSettingsSectionPort } from '../contracts.js'
import { actionRow, badge, button, clip, errorText, field, newId, note, selectInput, textInput } from '../kit.js'

const PROTOCOLS = Object.freeze([
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' }
])

type EditingProvider = AiProviderRecord & { isNew: boolean }

function protocolLabel(value?: string): string {
  const hit = PROTOCOLS.find((p) => p.value === value)
  return hit ? hit.label : String(value || '未知协议')
}

export function createProvidersSection(port: AiSettingsSectionPort): AiSettingsSection {
  const element = el('div', 'ai-view')

  let providers: AiProviderRecord[] = []
  let loading = true
  let failed = ''
  let editing: EditingProvider | null = null
  /** 正在内联添加模型的 provider id。 */
  let addingModelFor: string | null = null

  // ── 取数 ────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    try {
      const res = await port.client.providers.list()
      if (res && res.ok === false) throw new Error(res.message || res.code || '无法读取模型服务')
      providers = Array.isArray(res.providers) ? res.providers : []
      failed = ''
    } catch (e) {
      failed = errorText(e)
    }
    loading = false
    port.setCount(providers.length)
    // 表单打开时不重建：外部广播不该抹掉用户正在填的内容（取消时自然用最新数据重画）
    if (!editing) render()
  }

  function activate(): void {
    if (!loading) return
    render()
    load()
  }

  /**
   * 测一次连接，并让引擎把服务端模型灌进目录（引擎只在"该服务还没有模型"时导入）。
   *
   * 「测试连接」按钮与"保存后自动探测"共用这一份：两处各写一遍，迟早出现
   * 一套导入了模型、另一套只弹了句"连接成功"的偏差。
   *
   * @param {string} providerId
   * @param {boolean} [auto] 是否为保存后自动触发（只影响进度文案）
   */
  async function probe(providerId: string, auto = false): Promise<void> {
    port.notify(auto ? '已保存，正在测试连接并获取模型…' : '正在测试连接…')
    const res = await port.request(() => port.client.providers.test(providerId))
    if (res) {
      const imported = Number(res.imported) || 0
      const found = Array.isArray(res.models) ? res.models.length : 0
      if (imported) port.notify(`连接成功，已获取 ${imported} 个模型`, true)
      else if (found) port.notify(`连接成功（服务端共 ${found} 个模型）`, true)
      else port.notify('连接成功', true)
    }
    // 失败时 port.request 已经提示了原因；无论成败都把最新目录画出来
    await load()
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function render(): void {
    element.textContent = ''
    if (loading) {
      element.appendChild(el('div', 'empty', '读取模型服务…'))
      return
    }
    if (editing) {
      element.appendChild(providerForm(editing))
      return
    }

    const bar = el('div', 'toolbar')
    bar.appendChild(button('添加模型服务', { primary: true, onClick: () => startCreate() }))
    bar.appendChild(button('刷新', { onClick: () => { loading = true; render(); load() } }))
    element.appendChild(bar)

    if (failed) {
      element.appendChild(note(`读取模型服务失败：${failed}`, true))
      return
    }

    if (!providers.length) {
      const empty = el('div', 'empty')
      empty.appendChild(el('div', 'empty-title', '还没有模型服务'))
      empty.appendChild(el('div', 'empty-hint', '添加一个 OpenAI 兼容服务（或 Anthropic）后即可在 AI 面板对话。密钥保存在系统钥匙串。'))
      empty.appendChild(button('添加模型服务', { primary: true, onClick: () => startCreate() }))
      element.appendChild(empty)
      return
    }

    for (const provider of providers) element.appendChild(providerCard(provider))
  }

  function startCreate(): void {
    editing = { id: newId('p'), isNew: true, protocol: PROTOCOLS[0]?.value ?? 'openai-completions', label: '', baseUrl: '', enabled: true, hasKey: false }
    addingModelFor = null
    render()
    const input = element.querySelector<HTMLInputElement>('.ai-form input')
    if (input) { try { input.focus() } catch (_) {} }
  }

  function providerCard(provider: AiProviderRecord): HTMLElement {
    const card = el('div', 'card ai-card')

    const head = el('div', 'ai-card-head')
    head.appendChild(el('span', 'ai-card-name', provider.label || provider.id))
    head.appendChild(badge(protocolLabel(provider.protocol), 'accent'))
    head.appendChild(badge(provider.hasKey ? '已配密钥' : '未配密钥', provider.hasKey ? 'success' : 'danger'))
    if (provider.enabled === false) head.appendChild(badge('已停用'))
    card.appendChild(head)

    card.appendChild(el('div', 'ai-card-url mono', clip(provider.baseUrl || '', 120)))

    card.appendChild(actionRow(
      button('编辑', { small: true, onClick: () => startEdit(provider) }),
      button('测试连接', { small: true, onClick: () => probe(provider.id) }),
      button('删除', {
        small: true,
        danger: true,
        onClick: async () => {
          const name = provider.label || provider.id
          if (!window.confirm(`删除模型服务「${name}」及其模型配置？会话记录不受影响。`)) return
          await port.request(() => port.client.providers.remove(provider.id), '已删除')
          await load()
        }
      })
    ))

    card.appendChild(modelList(provider))

    if (addingModelFor === provider.id) {
      const input = textInput('', '模型 id，例如 gpt-4o-mini')
      const addRow = el('div', 'ai-actions')
      addRow.appendChild(input)
      addRow.appendChild(button('添加', {
        primary: true,
        small: true,
        onClick: async () => {
          const id = input.value.trim()
          if (!id) { port.notify('模型 id 不能为空', false); return }
          const res = await port.request(() => port.client.providers.upsertModel(provider.id, { id, label: id }), '模型已添加')
          if (!res) return
          addingModelFor = null
          await load()
        }
      }))
      addRow.appendChild(button('取消', { small: true, onClick: () => { addingModelFor = null; render() } }))
      card.appendChild(addRow)
    } else {
      card.appendChild(button('+ 添加模型', {
        small: true,
        onClick: () => { addingModelFor = provider.id; render() }
      }))
    }

    return card
  }

  function modelList(provider: AiProviderRecord): HTMLElement {
    const box = el('div', 'ai-model-list')
    const models = Array.isArray(provider.models) ? provider.models : []
    if (!models.length) {
      box.appendChild(el('div', 'ai-hint', '还没有模型。保存时会自动获取，也可以点「测试连接」或手动添加。'))
      return box
    }
    for (const model of models) {
      const row = el('div', 'ai-model-row')
      row.appendChild(el('span', 'ai-model-name', model.label || model.id))
      row.appendChild(el('span', 'ai-model-id mono', model.id))
      const remove = el('button', 'btn btn-sm btn-danger', '移除')
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        await port.request(() => port.client.providers.removeModel(provider.id, model.id), '已移除')
        await load()
      })
      row.appendChild(remove)
      box.appendChild(row)
    }
    return box
  }

  function startEdit(provider: AiProviderRecord): void {
    editing = {
      id: provider.id,
      isNew: false,
      label: provider.label,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled !== false,
      hasKey: !!provider.hasKey
    }
    addingModelFor = null
    render()
  }

  function providerForm(draft: EditingProvider): HTMLElement {
    const form = el('div', 'panel ai-form')
    const head = el('div', 'panel-head')
    head.appendChild(el('span', 'card-title', draft.isNew ? '添加模型服务' : '编辑模型服务'))
    form.appendChild(head)

    const grid = el('div', 'form-grid')
    const labelInput = textInput(draft.label, '例如 DeepSeek')
    grid.appendChild(field('名称', labelInput))

    const protocolSelect = selectInput(PROTOCOLS, draft.protocol)
    if (draft.protocol && !PROTOCOLS.some((p) => p.value === draft.protocol)) {
      const extra = el('option', '', draft.protocol)
      extra.value = draft.protocol
      extra.selected = true
      protocolSelect.appendChild(extra)
    }
    grid.appendChild(field('协议', protocolSelect))

    const baseInput = textInput(draft.baseUrl, 'https://api.example.com/v1')
    grid.appendChild(field('Base URL', baseInput))

    const keyInput = textInput('', draft.hasKey ? '已保存，留空则不修改' : '粘贴 API Key', 'password')
    keyInput.autocomplete = 'off'
    grid.appendChild(field('API Key', keyInput, '写入系统钥匙串（safeStorage 加密），不会以明文落库，也不会回到界面。'))
    form.appendChild(grid)

    const enabledRow = el('label', 'check')
    const enabled = el('input')
    enabled.type = 'checkbox'
    enabled.checked = draft.enabled !== false
    enabledRow.append(enabled, el('span', '', '启用这个服务'))
    form.appendChild(enabledRow)

    const actions = actionRow(
      button('保存', {
        primary: true,
        onClick: async () => {
          const label = labelInput.value.trim()
          const baseUrl = baseInput.value.trim()
          if (!baseUrl) { port.notify('Base URL 不能为空', false); return }
          if (!/^https?:\/\//i.test(baseUrl)) { port.notify('Base URL 需要以 http:// 或 https:// 开头', false); return }
          const payload: {
            id: string
            label: string
            protocol: string
            baseUrl: string
            enabled: boolean
            apiKey?: string
          } = {
            id: draft.id,
            label: label || draft.id,
            protocol: protocolSelect.value,
            baseUrl,
            enabled: enabled.checked
          }
          const apiKey = keyInput.value.trim()
          if (apiKey) payload.apiKey = apiKey
          const res = await port.request(() => port.client.providers.save(payload))
          if (!res) return
          editing = null
          const saved = res.provider
          const models = saved?.models ?? []
          // 先收起表单、把新服务画出来，再决定要不要自动探测（探测最长 20s，不能把表单挂在那儿）
          await load()
          // 有密钥、但目录还是空 → 立刻自动探一次，省掉"再点测试连接、再手抄模型 id"
          if (saved?.hasKey && !models.length) await probe(saved.id, true)
          else port.notify('已保存', true)
        }
      }),
      button('取消', { onClick: () => { editing = null; render() } })
    )
    if (draft.hasKey) {
      actions.appendChild(button('清除已保存的密钥', {
        small: true,
        danger: true,
        onClick: async () => {
          const res = await port.request(() => port.client.providers.save({
            id: draft.id,
            label: labelInput.value.trim() || draft.id,
            protocol: protocolSelect.value,
            baseUrl: baseInput.value.trim(),
            apiKey: ''
          }), '密钥已清除')
          if (!res) return
          draft.hasKey = false
          await load()
        }
      }))
    }
    form.appendChild(actions)

    return form
  }

  // ── 外部变更 ────────────────────────────────────────────────────────
  /** @param {string} reason */
  function onStateChanged(reason?: string): void {
    if (!reason) return
    if (reason === 'providers' || reason === 'purged') load()
  }

  return { element, activate, refresh: load, onStateChanged }
}
