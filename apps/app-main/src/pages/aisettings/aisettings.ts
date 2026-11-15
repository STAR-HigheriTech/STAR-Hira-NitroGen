// @ts-check
/**
 * `hira://aisettings` —— **AI 设置的唯一实现**（模型服务 / 用量）。
 *
 * ── 为什么是内部页，而不是面板里的抽屉 ────────────────────────────────
 * 面板有三种宿主：侧栏面板、独立窗口、内部页 `hira://ai`。抽屉是"在面板里再开一个模态"，
 * 换宿主就要再实现一次（生命周期、焦点、尺寸全不同）。内部页天然与宿主无关，
 * 还能深链（`hira://aisettings#providers`）、前进后退、被收藏 —— 于是这里是设置的**唯一落点**：
 *   · AI 面板右上角的齿轮 → 打开本页；
 *   · 设置页「AI 助手」分区 → href 直达本页。
 *
 * 聊天界面**不在本页**：它是 `hira://ai`，与「面板移到窗口」完全同构地复用同一份
 * panelDefinition（见 `pages/ai/page.js` 与 `renderer/shared/panel-*.js`）。
 * 技能也**不在本页**：它已经彻底插件化，管理入口统一在 `hira://plugins` 的
 * 「AI 技能」大类（见 `pages/plugins/skills.js`）—— 同一份清单只有一处管理界面。
 *
 * ── 模块边界 ─────────────────────────────────────────────────────────
 *   aisettings.js         外壳：页签、反馈条、引擎事件分发、不可用兜底
 *   sections/providers.js 模型服务（增删改 / 测试连接 / 模型清单）
 *   sections/usage.js     用量与数据（审计导出 / 彻底移除）
 *   kit.js                纯 UI 原语（按钮 / 字段 / 徽标 / 错误文案）
 * 数据只经 `hira://shared/ai-client.js`；任何业务判定都不在这一层。
 *
 * ── 分区契约 ─────────────────────────────────────────────────────────
 * `createSection(port) → { element, activate(), refresh(), onStateChanged(reason) }`
 *   · 每个分区**自带数据**（切页不重拉，`ai:state-changed` 时各自刷新）；
 *   · 外壳只负责显示 / 隐藏与转发事件，不认识分区里的字段。
 */
import { el, initTheme, pageUrl, pageIconSvg, uiIconSvg } from 'hira://shared/runtime.js'
import { aiClient } from 'hira://shared/ai-client.js'
import type { AiActionResponse, AiSharedState } from 'hira://shared/ai-client.js'
import { requiredById } from 'hira://shared/page-kit.js'
import { errorText } from './kit.js'
import { createProvidersSection } from './sections/providers.js'
import { createUsageSection } from './sections/usage.js'
import type { AiSettingsSection, AiSettingsSectionFactory, AiSettingsSectionPort } from './contracts.js'

interface TabDefinition {
  id: string
  label: string
  create: AiSettingsSectionFactory
}

const TABS: readonly TabDefinition[] = Object.freeze([
  { id: 'providers', label: '模型服务', create: createProvidersSection },
  { id: 'usage', label: '用量', create: createUsageSection }
])

initTheme()

const doc = document
const pane = requiredById<HTMLElement>('pane')
const tabBar = requiredById<HTMLElement>('tabs')
const feedback = requiredById<HTMLElement>('feedback')

// ── AI 技能入口 ──────────────────────────────────────────────────────
// 技能的管理界面只有插件页一处（见文件头：不在本页复制第二套清单），
// 这里只负责把跳板做醒目：目标地址由 `pageUrl` 拼（深链落到「AI 技能」大类），
// 图标取 `hira://ai` 的页字形 —— 与 rail 上的 AI 面板同一颗，不在本页另画。
function mountSkillLink(): void {
  const link = doc.getElementById('skill-link')
  if (!(link instanceof HTMLAnchorElement)) return
  link.href = pageUrl('plugins') + '#ai-skill-plugin'
  const slot = doc.getElementById('skill-link-icon')
  if (slot) {
    slot.textContent = ''
    const glyph = pageIconSvg(doc, 'ai', { size: 24, strokeWidth: 1.5 })
    if (glyph) slot.appendChild(glyph)
  }
  const go = link.querySelector<HTMLElement>('.ai-skill-cta__go')
  if (go) {
    go.textContent = ''
    const arrow = uiIconSvg(doc, 'arrowRight', { size: 18 })
    if (arrow) go.appendChild(arrow)
  }
}

mountSkillLink()

const instances = new Map<string, AiSettingsSection>()
/** tabId → 分区按钮里的计数节点（模型服务显示条数，用量不显示）。 */
const counts = new Map<string, HTMLElement>()
let activeTab = ''
let feedbackTimer = 0

// ── 反馈条（3.2s 自动收起；错误与成功只换语义色）──────────────────────
function notify(text: string, ok = true): void {
  if (!text) return
  feedback.textContent = String(text)
  feedback.dataset.type = ok ? 'success' : 'error'
  feedback.hidden = false
  if (feedbackTimer) window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => {
    feedback.hidden = true
    feedbackTimer = 0
  }, 3200)
}

// ── 统一请求出口：域错误（`ok:false`）与 reject 都变成一条可读提示 ──────
async function request<T extends AiActionResponse>(fn: () => Promise<T>, okText?: string): Promise<T | null> {
  try {
    const res = await fn()
    if (res && res.ok === false) {
      notify(res.message || res.code || '操作失败', false)
      return null
    }
    if (okText) notify(okText, true)
    return res
  } catch (e) {
    notify(errorText(e), false)
    return null
  }
}

// ── 三宿主共享状态条（侧栏面板 / 独立窗口 / 本页 同一份）──────────────
// 真源在主进程（`plugins/ai/main/ui-state.cjs` + `ai_ui_state` 表）：
// 面板里换了模型 / 切了会话，本页这一条跟着变；反之亦然。本页只读展示。
const REASONING_TEXT: Readonly<Record<string, string>> = Object.freeze({ auto: '自动', low: '低', medium: '中', high: '高' })
const APPROVAL_TEXT: Readonly<Record<string, string>> = Object.freeze({ allow: '允许', ask: '询问' })

const sharedBar = doc.getElementById('shared-state')

function createSharedBar(): { apply(next?: AiSharedState): void; loadLabels(): Promise<void> } | null {
  if (!sharedBar) return null

  const bar = sharedBar
  const ui: { sessionId: string | null; modelChoice: string | null; reasoning: string; approvalMode: 'allow' | 'ask' } = {
    sessionId: null,
    modelChoice: null,
    reasoning: 'auto',
    approvalMode: 'ask'
  }
  /** 会话 id → 标题、模型 key → 可读名（引擎广播按需刷新）。 */
  const sessionTitles = new Map<string, string>()
  const modelLabels = new Map<string, string>()

  bar.textContent = ''
  bar.appendChild(el('span', 'ai-shared__label', '三宿主共用'))
  const fields = {
    session: el('span', 'ai-shared__value', '—'),
    model: el('span', 'ai-shared__value', '—'),
    reasoning: el('span', 'ai-shared__value', '—'),
    approval: el('span', 'ai-shared__value', '—')
  }
  const labels: Array<[keyof typeof fields, string]> = [
    ['session', '会话'],
    ['model', '模型'],
    ['reasoning', '思考'],
    ['approval', '网页审批']
  ]
  for (const [key, label] of labels) {
    const item = el('span', 'ai-shared__item')
    item.appendChild(el('span', 'ai-shared__key', label))
    item.appendChild(fields[key])
    bar.appendChild(item)
  }

  function paint(): void {
    fields.session.textContent = ui.sessionId
      ? (sessionTitles.get(ui.sessionId) || '未命名会话')
      : '暂无会话'
    fields.model.textContent = ui.modelChoice
      ? (modelLabels.get(ui.modelChoice) || ui.modelChoice)
      : '跟随会话'
    fields.reasoning.textContent = REASONING_TEXT[ui.reasoning] || '自动'
    fields.approval.textContent = APPROVAL_TEXT[ui.approvalMode] || '询问'
    bar.hidden = false
  }

  /** 拉一次"翻译表"（会话标题 / 模型可读名），再重画。 */
  async function loadLabels(): Promise<void> {
    const [sessions, providers] = await Promise.all([
      aiClient.sessions.list({ limit: 50 }).catch(() => null),
      aiClient.providers.list().catch(() => null)
    ])
    if (sessions && Array.isArray(sessions.sessions)) {
      sessionTitles.clear()
      for (const s of sessions.sessions) if (s && s.id) sessionTitles.set(s.id, s.title || '')
    }
    if (providers && Array.isArray(providers.providers)) {
      modelLabels.clear()
      for (const p of providers.providers) {
        for (const m of p && Array.isArray(p.models) ? p.models : []) {
          if (m && m.id) modelLabels.set(`${p.id}:${m.id}`, `${p.label || p.id} · ${m.label || m.id}`)
        }
      }
    }
    paint()
  }

  /** 对齐一份共享状态（字段缺省时保持原值）。 */
  function apply(next?: AiSharedState): void {
    if (!next || typeof next !== 'object') return
    if ('sessionId' in next) ui.sessionId = next.sessionId ? String(next.sessionId) : null
    if ('modelChoice' in next) ui.modelChoice = next.modelChoice ? String(next.modelChoice) : null
    if ('reasoning' in next) ui.reasoning = String(next.reasoning || 'auto')
    if ('approvalMode' in next) ui.approvalMode = next.approvalMode === 'allow' ? 'allow' : 'ask'
    paint()
  }

  return { apply, loadLabels }
}

const shared = createSharedBar()

// ── 页签 ────────────────────────────────────────────────────────────
function buildTabs(): void {
  for (const tab of TABS) {
    const btn = el('button', 'btn', tab.label)
    btn.type = 'button'
    btn.dataset.tab = tab.id
    btn.setAttribute('role', 'tab')
    const count = el('span', 'count')
    if (tab.id !== 'usage') {
      btn.appendChild(count)
      counts.set(tab.id, count)
    }
    btn.addEventListener('click', () => select(tab.id))
    tabBar.appendChild(btn)
  }
}

function setTabCount(tabId: string, n: number): void {
  const node = counts.get(tabId)
  if (!node) return
  node.textContent = n > 0 ? String(n) : ''
}

/** 惰性创建 + 显示指定分区（各分区保留自己的表单状态，来回切页不丢）。 */
function mountTab(id: string): AiSettingsSection | null {
  let instance = instances.get(id)
  if (!instance) {
    const tab = TABS.find((t) => t.id === id)
    if (!tab) return null
    instance = tab.create({
      client: aiClient,
      request,
      notify,
      setCount: (n: number) => setTabCount(id, n)
    })
    instance.element.hidden = true
    pane.appendChild(instance.element)
    instances.set(id, instance)
  }
  return instance
}

function select(id: string): void {
  const target = TABS.some((t) => t.id === id) ? id : TABS[0]?.id
  if (!target) return
  if (target === activeTab) return
  activeTab = target

  for (const tab of TABS) {
    const instance = instances.get(tab.id)
    if (instance) instance.element.hidden = true
  }
  const btn = tabBar.querySelector<HTMLButtonElement>(`[data-tab="${target}"]`)
  if (btn) {
    for (const other of tabBar.querySelectorAll('[data-tab]')) {
      other.classList.toggle('btn-primary', other === btn)
      other.setAttribute('aria-selected', other === btn ? 'true' : 'false')
    }
  }

  const instance = mountTab(target)
  if (!instance) return
  instance.element.hidden = false
  if (typeof instance.activate === 'function') instance.activate()

  // 深链：把当前页签写进 hash（replace 而非 push —— 切页签不该堆历史记录）
  try {
    history.replaceState(null, '', `#${target}`)
  } catch (_) { /* 不影响功能 */ }
}

// ── 不可用兜底（引擎插件被禁用时通道不存在）────────────────────────────
function renderUnavailable(err?: unknown): void {
  tabBar.hidden = true
  pane.textContent = ''
  const empty = el('div', 'empty')
  empty.appendChild(el('div', 'empty-title', 'AI 助手不可用'))
  empty.appendChild(el('div', 'empty-hint',
    `${errorText(err)}。到「扩展 → 插件」里启用 ai-engine 后重新打开本页；已保存的配置不会因此丢失。`))
  pane.appendChild(empty)
}

// ── 启动 ────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  buildTabs()
  // 探活：providers.list 是最便宜的一次调用；通道不存在会 reject（= 插件未启用）
  try {
    const probe = await aiClient.providers.list()
    if (probe && probe.ok === false && String(probe.code || '') === 'AI_NO_ENGINE') {
      renderUnavailable(new Error(String(probe.message || probe.code || 'AI 引擎不可用')))
      return
    }
  } catch (e) {
    renderUnavailable(e)
    return
  }

  const fromHash = String(location.hash || '').replace(/^#/, '')
  select(TABS.some((t) => t.id === fromHash) ? fromHash : (TABS[0]?.id ?? 'providers'))

  // 共享状态条：一次初值 + 两条订阅（引擎事件 / 共享状态事件）
  if (shared) {
    aiClient.uiState.get()
      .then((res) => shared.apply(res.uiState))
      .catch(() => {})
    shared.loadLabels()
  }

  const offs: Array<() => void> = []
  // 引擎广播：别处改了模型服务，这一页立刻跟上（反过来同理）
  offs.push(aiClient.onStateChanged((payload) => {
    const reason = String(payload.reason || '')
    if (!reason) return
    for (const instance of instances.values()) {
      try { instance.onStateChanged(reason) } catch (e) { console.error('[ai] 分区刷新失败：', e) }
    }
    // 会话标题 / 模型目录变了：共享状态条的可读名也要跟着换
    if (shared && (reason === 'created' || reason === 'deleted' || reason === 'renamed' || reason === 'title' || reason === 'providers')) {
      shared.loadLabels()
    }
  }))
  // 任一宿主改了会话 / 模型 / 推理 / 审批 → 本页对齐（只读，不回写）
  offs.push(aiClient.onUiStateChanged((payload) => {
    if (shared) shared.apply(payload.uiState)
  }))

  const win = doc.defaultView
  if (win) {
    win.addEventListener('pagehide', () => {
      for (const off of offs) { try { off() } catch (_) {} }
    }, { once: true })
  }
}

// hash 变化（前进 / 后退 / 从别处带旧页签深链打开）→ 切到可用分区
window.addEventListener('hashchange', () => {
  const next = String(location.hash || '').replace(/^#/, '')
  if (next && TABS.some((t) => t.id === next)) select(next)
})

boot().catch((error: unknown) => renderUnavailable(error))
