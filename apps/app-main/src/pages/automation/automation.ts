import { IPC_ROUTES, IPC_EVENTS, rpc, subscribe, el, renderEmpty, initTheme, type PageRpcRecord } from 'hira://shared/runtime.js'
import { DEFAULT_GESTURE_MAP, type AutomationChain, type GestureMap } from 'hira://shared/automation.mjs'
import {
  CHAIN_LIMITS,
  actionSummary,
  chainFromDraft,
  createChainDraft,
  createRuleId,
  createRuleDraft,
  errorMessage,
  groupActions,
  isAutomationSetting,
  readAutomationSnapshot,
  ruleFromDraft,
  upsertChain,
  upsertRule,
  workspaceActionOptions,
  type AutomationSnapshot,
  type ChainDraft,
  type RuleDraft,
  type SettingsChange
} from './model.js'
import {
  WORKSPACE_RULE_SETTING_KEYS,
  WORKSPACE_RULE_TEMPLATES,
  type WorkspaceRule,
  type WorkspaceTask
} from 'hira://shared/workspace-rules.mjs'
import {
  captureWorkspaceTask,
  loadWorkspaceTasks,
  removeWorkspaceTask,
  restoreWorkspaceTask
} from 'hira://shared/workspace-tasks.js'

type ViewId = 'chains' | 'gestures' | 'rules'
type FeedbackType = 'info' | 'success' | 'error'

interface SaveResult extends PageRpcRecord { ok: boolean }
interface RunResult extends PageRpcRecord { ok: boolean; ran: number }

interface PageState {
  snapshot: AutomationSnapshot
  activeView: ViewId
  draft: ChainDraft | null
  ruleDraft: RuleDraft | null
  loading: boolean
  loadError: string
  chainsBusy: boolean
  runningChains: Set<string>
  rulesBusy: boolean
  tasks: WorkspaceTask[]
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`自动化页缺少 #${id}`)
  return node as T
}

function button(className: string, text = ''): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  return node
}

initTheme()

const chainList = requiredElement<HTMLDivElement>('chain-list')
const chainEditor = requiredElement<HTMLDivElement>('chain-editor')
const editorTitle = requiredElement<HTMLHeadingElement>('editor-title')
const nameInput = requiredElement<HTMLInputElement>('chain-name')
const stepsBox = requiredElement<HTMLDivElement>('steps')
const stepPicker = requiredElement<HTMLSelectElement>('step-picker')
const addStepBtn = requiredElement<HTMLButtonElement>('add-step')
const saveChainBtn = requiredElement<HTMLButtonElement>('save-chain')
const cancelChainBtn = requiredElement<HTMLButtonElement>('cancel-chain')
const newChainBtn = requiredElement<HTMLButtonElement>('new-chain')
const viewChains = requiredElement<HTMLElement>('view-chains')
const viewGestures = requiredElement<HTMLElement>('view-gestures')
const gestureList = requiredElement<HTMLDivElement>('gesture-list')
const gesturesEnabled = requiredElement<HTMLInputElement>('gestures-enabled')
const resetGesturesBtn = requiredElement<HTMLButtonElement>('reset-gestures')
const tabChains = requiredElement<HTMLButtonElement>('tab-chains')
const tabGestures = requiredElement<HTMLButtonElement>('tab-gestures')
const chainCount = requiredElement<HTMLSpanElement>('chain-count')
const gestureCount = requiredElement<HTMLSpanElement>('gesture-count')
const chainStatus = requiredElement<HTMLParagraphElement>('chain-status')
const gestureStatus = requiredElement<HTMLParagraphElement>('gesture-status')
const viewRules = requiredElement<HTMLElement>('view-rules')
const ruleList = requiredElement<HTMLDivElement>('rule-list')
const rulesEnabled = requiredElement<HTMLInputElement>('rules-enabled')
const newRuleBtn = requiredElement<HTMLButtonElement>('new-rule')
const ruleEditor = requiredElement<HTMLElement>('rule-editor')
const ruleEditorTitle = requiredElement<HTMLHeadingElement>('rule-editor-title')
const ruleNameInput = requiredElement<HTMLInputElement>('rule-name')
const ruleTriggerSelect = requiredElement<HTMLSelectElement>('rule-trigger')
const ruleMatchInput = requiredElement<HTMLInputElement>('rule-match')
const ruleActionsBox = requiredElement<HTMLDivElement>('rule-actions')
const ruleActionPicker = requiredElement<HTMLSelectElement>('rule-action-picker')
const addRuleActionBtn = requiredElement<HTMLButtonElement>('add-rule-action')
const saveRuleBtn = requiredElement<HTMLButtonElement>('save-rule')
const cancelRuleBtn = requiredElement<HTMLButtonElement>('cancel-rule')
const tabRules = requiredElement<HTMLButtonElement>('tab-rules')
const ruleCount = requiredElement<HTMLSpanElement>('rule-count')
const ruleStatus = requiredElement<HTMLParagraphElement>('rule-status')
const ruleTemplateSelect = requiredElement<HTMLSelectElement>('rule-template')
const applyRuleTemplateBtn = requiredElement<HTMLButtonElement>('apply-rule-template')
const taskNameInput = requiredElement<HTMLInputElement>('task-name')
const saveTaskBtn = requiredElement<HTMLButtonElement>('save-task')
const taskList = requiredElement<HTMLDivElement>('task-list')

const state: PageState = {
  snapshot: readAutomationSnapshot({}),
  activeView: location.hash === '#gestures' ? 'gestures' : location.hash === '#rules' ? 'rules' : 'chains',
  draft: null,
  ruleDraft: null,
  loading: true,
  loadError: '',
  chainsBusy: false,
  runningChains: new Set(),
  rulesBusy: false,
  tasks: []
}

let chainStatusTimer = 0
let gestureStatusTimer = 0
let ruleStatusTimer = 0
let pendingGestureSave: { gestures: GestureMap; gesturesEnabled: boolean } | null = null
let gestureSaveRunning = false
let loadSequence = 0

function showGestureStatus(message = '', type: FeedbackType = 'info'): void {
  gestureStatus.textContent = message
  gestureStatus.dataset.type = type
  gestureStatus.hidden = !message
  window.clearTimeout(gestureStatusTimer)
  if (message) gestureStatusTimer = window.setTimeout(() => { gestureStatus.hidden = true }, 4200)
}

function showChainsStatus(message: string, type: FeedbackType): void {
  chainStatus.textContent = message
  chainStatus.dataset.type = type
  chainStatus.hidden = false
  window.clearTimeout(chainStatusTimer)
  chainStatusTimer = window.setTimeout(() => { chainStatus.hidden = true }, 4200)
}

function showRulesStatus(message = '', type: FeedbackType = 'info'): void {
  ruleStatus.textContent = message
  ruleStatus.dataset.type = type
  ruleStatus.hidden = !message
  window.clearTimeout(ruleStatusTimer)
  if (message) ruleStatusTimer = window.setTimeout(() => { ruleStatus.hidden = true }, 4200)
}

function setTab(view: ViewId, updateHash = true): void {
  state.activeView = view
  const chainsActive = view === 'chains'
  const gesturesActive = view === 'gestures'
  const rulesActive = view === 'rules'
  viewChains.hidden = !chainsActive
  viewGestures.hidden = !gesturesActive
  viewRules.hidden = !rulesActive
  tabChains.classList.toggle('btn-primary', chainsActive)
  tabGestures.classList.toggle('btn-primary', gesturesActive)
  tabRules.classList.toggle('btn-primary', rulesActive)
  tabChains.setAttribute('aria-selected', String(chainsActive))
  tabGestures.setAttribute('aria-selected', String(gesturesActive))
  tabRules.setAttribute('aria-selected', String(rulesActive))
  tabChains.tabIndex = chainsActive ? 0 : -1
  tabGestures.tabIndex = gesturesActive ? 0 : -1
  tabRules.tabIndex = rulesActive ? 0 : -1
  if (updateHash) {
    const url = new URL(location.href)
    url.hash = chainsActive ? '' : view
    try { history.replaceState(null, '', url) } catch { location.hash = url.hash }
  }
}

function renderChains(): void {
  chainList.setAttribute('aria-busy', String(state.loading))
  chainList.textContent = ''
  chainCount.textContent = String(state.snapshot.chains.length)

  if (state.loading) {
    chainList.appendChild(el('div', 'empty', '正在载入命令链…'))
    return
  }
  if (state.loadError) {
    const empty = el('div', 'empty')
    empty.appendChild(el('div', 'empty-title', '命令链暂时不可用'))
    empty.appendChild(el('div', 'empty-hint', state.loadError))
    const retry = button('btn', '重新载入')
    retry.addEventListener('click', () => { void load() })
    empty.appendChild(retry)
    chainList.appendChild(empty)
    return
  }
  if (!state.snapshot.chains.length) {
    const empty = el('div', 'empty')
    empty.appendChild(el('div', 'empty-title', '还没有命令链'))
    empty.appendChild(el('div', 'empty-hint', '把常用操作串起来，之后从这一页或地址栏一次执行。'))
    chainList.appendChild(empty)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const chain of state.snapshot.chains) fragment.appendChild(buildChainRow(chain))
  chainList.appendChild(fragment)
}

function buildChainRow(chain: AutomationChain): HTMLElement {
  const row = el('div', 'row automation-chain-row')
  const copy = el('div', 'automation-chain-copy')
  copy.appendChild(el('div', 'title', chain.name))
  const summary = el('div', 'summary', actionSummary(chain.steps, state.snapshot.actions))
  summary.title = summary.textContent || ''
  copy.appendChild(summary)
  row.appendChild(copy)

  const actions = el('div', 'actions')
  const running = state.runningChains.has(chain.id)
  const chainExecutionBusy = state.runningChains.size > 0
  const runButton = button('btn', running ? '执行中…' : '运行')
  runButton.disabled = chainExecutionBusy || state.chainsBusy
  runButton.title = '立刻按顺序执行这条命令链'
  runButton.addEventListener('click', () => { void runChain(chain) })

  const editButton = button('btn', '编辑')
  editButton.disabled = chainExecutionBusy || state.chainsBusy
  editButton.addEventListener('click', () => openEditor(chain))

  const deleteButton = button('btn btn-danger', '删除')
  deleteButton.disabled = chainExecutionBusy || state.chainsBusy
  deleteButton.addEventListener('click', () => { void removeChain(chain) })

  actions.append(runButton, editButton, deleteButton)
  row.appendChild(actions)
  return row
}

async function persistChains(next: readonly AutomationChain[], successMessage: string): Promise<boolean> {
  if (state.chainsBusy) return false
  const previous = state.snapshot.chains
  state.chainsBusy = true
  state.snapshot = { ...state.snapshot, chains: [...next] }
  renderChains()
  renderChainEditorControls()
  try {
    const result = await rpc<SaveResult>(IPC_ROUTES.automationSave, { chains: state.snapshot.chains })
    if (result && result.ok === false) throw new Error(String(result.reason || result.message || '保存失败'))
    showChainsStatus(successMessage, 'success')
    return true
  } catch (error) {
    state.snapshot = { ...state.snapshot, chains: previous }
    showChainsStatus(`保存失败：${errorMessage(error, '主进程没有响应')}`, 'error')
    return false
  } finally {
    state.chainsBusy = false
    renderChains()
    renderChainEditorControls()
  }
}

async function removeChain(chain: AutomationChain): Promise<void> {
  if (!window.confirm(`删除命令链“${chain.name}”？`)) return
  const next = state.snapshot.chains.filter((item) => item.id !== chain.id)
  const saved = await persistChains(next, `已删除“${chain.name}”`)
  if (saved && state.draft?.id === chain.id) closeEditor()
}

async function runChain(chain: AutomationChain): Promise<void> {
  if (state.runningChains.has(chain.id)) return
  state.runningChains.add(chain.id)
  renderChains()
  renderChainEditorControls()
  try {
    const result = await rpc<RunResult>(IPC_ROUTES.automationRun, { chainId: chain.id })
    if (!result || result.ok === false) {
      showChainsStatus('这条链暂时无法执行；请检查步骤是否仍由当前版本支持。', 'error')
      return
    }
    showChainsStatus(`已执行 ${result.ran} / ${chain.steps.length} 步`, 'success')
  } catch (error) {
    showChainsStatus(`运行失败：${errorMessage(error, '主进程没有响应')}`, 'error')
  } finally {
    state.runningChains.delete(chain.id)
    renderChains()
    renderChainEditorControls()
  }
}

function openEditor(chain?: AutomationChain | null): void {
  state.draft = createChainDraft(chain)
  editorTitle.textContent = chain ? '编辑命令链' : '新建命令链'
  nameInput.value = state.draft.name
  chainEditor.hidden = false
  renderSteps()
  renderChainEditorControls()
  nameInput.focus()
}

function closeEditor(): void {
  state.draft = null
  chainEditor.hidden = true
}

function renderChainEditorControls(): void {
  const unavailable = state.loading || Boolean(state.loadError)
  const disabled = state.chainsBusy || state.runningChains.size > 0 || unavailable || !state.draft
  addStepBtn.disabled = disabled || !stepPicker.value || (state.draft?.steps.length || 0) >= CHAIN_LIMITS.maxSteps
  saveChainBtn.disabled = disabled
  cancelChainBtn.disabled = disabled
  newChainBtn.disabled = state.chainsBusy || state.runningChains.size > 0 || unavailable || state.snapshot.chains.length >= CHAIN_LIMITS.maxChains
  newChainBtn.title = state.snapshot.chains.length >= CHAIN_LIMITS.maxChains
    ? `最多可以保存 ${CHAIN_LIMITS.maxChains} 条命令链`
    : '新建一条命令链'
}

function renderSteps(): void {
  stepsBox.textContent = ''
  if (!state.draft) return
  if (!state.draft.steps.length) {
    stepsBox.appendChild(el('div', 'empty', '尚未添加步骤。从下方选择一条命令，然后点“添加步骤”。'))
    renderChainEditorControls()
    return
  }

  const fragment = document.createDocumentFragment()
  state.draft.steps.forEach((action, index) => {
    const row = el('div', 'row automation-step-row')
    row.appendChild(el('div', 'idx', String(index + 1)))
    row.appendChild(el('div', 'step-label', actionSummary([action], state.snapshot.actions)))

    const actions = el('div', 'actions')
    const up = button('icon-btn', '↑')
    up.title = '上移'
    up.setAttribute('aria-label', `上移第 ${index + 1} 步`)
    up.disabled = state.chainsBusy || index === 0
    up.addEventListener('click', () => moveStep(index, index - 1))
    const down = button('icon-btn', '↓')
    down.title = '下移'
    down.setAttribute('aria-label', `下移第 ${index + 1} 步`)
    down.disabled = state.chainsBusy || index === (state.draft?.steps.length || 0) - 1
    down.addEventListener('click', () => moveStep(index, index + 1))
    const remove = button('icon-btn', '×')
    remove.title = '移除这一步'
    remove.setAttribute('aria-label', `移除第 ${index + 1} 步`)
    remove.disabled = state.chainsBusy
    remove.addEventListener('click', () => {
      if (!state.draft) return
      state.draft.steps.splice(index, 1)
      renderSteps()
    })
    actions.append(up, down, remove)
    row.appendChild(actions)
    fragment.appendChild(row)
  })
  stepsBox.appendChild(fragment)
  renderChainEditorControls()
}

function moveStep(from: number, to: number): void {
  if (!state.draft || to < 0 || to >= state.draft.steps.length) return
  const [item] = state.draft.steps.splice(from, 1)
  if (!item) return
  state.draft.steps.splice(to, 0, item)
  renderSteps()
}

function renderStepPicker(): void {
  stepPicker.textContent = ''
  let total = 0
  for (const group of groupActions(state.snapshot.actions)) {
    const optionGroup = document.createElement('optgroup')
    optionGroup.label = group.label
    for (const action of group.actions) {
      const option = document.createElement('option')
      option.value = action.id
      option.textContent = action.label
      optionGroup.appendChild(option)
      total++
    }
    stepPicker.appendChild(optionGroup)
  }
  if (!total) stepPicker.appendChild(new Option('当前没有可编排命令', ''))
  renderChainEditorControls()
}

async function saveEditor(): Promise<void> {
  const draft = state.draft
  if (!draft) return
  const chain = chainFromDraft({ ...draft, name: nameInput.value })
  if (!chain) {
    if (!nameInput.value.trim()) nameInput.focus()
    showChainsStatus('请输入名称，并至少添加一个步骤。', 'error')
    return
  }
  if (draft.isNew && state.snapshot.chains.length >= CHAIN_LIMITS.maxChains) {
    showChainsStatus(`最多可以保存 ${CHAIN_LIMITS.maxChains} 条命令链。`, 'error')
    return
  }
  const availableActions = new Set(state.snapshot.actions.map((action) => action.id))
  if (chain.steps.some((step) => !availableActions.has(step))) {
    showChainsStatus('有步骤对应的命令已不可用，请移除后重新添加。', 'error')
    return
  }
  const next = upsertChain(state.snapshot.chains, chain)
  const saved = await persistChains(next, draft.isNew ? '命令链已创建' : '命令链已更新')
  if (saved) closeEditor()
}

function renderGestures(): void {
  gestureList.textContent = ''
  gestureCount.textContent = String(Object.keys(state.snapshot.gestures).length)
  gesturesEnabled.checked = state.snapshot.gesturesEnabled
  gesturesEnabled.disabled = state.loading || Boolean(state.loadError)
  resetGesturesBtn.disabled = state.loading || Boolean(state.loadError)

  if (state.loading) {
    gestureList.appendChild(el('div', 'empty', '正在载入手势设置…'))
    return
  }
  if (state.loadError) {
    gestureList.appendChild(el('div', 'empty', state.loadError))
    return
  }
  if (!state.snapshot.directions.length) {
    gestureList.appendChild(el('div', 'empty', '当前版本没有可配置的手势方向。'))
    return
  }

  const groups = groupActions(state.snapshot.actions)
  const fragment = document.createDocumentFragment()
  for (const direction of state.snapshot.directions) {
    const row = el('div', 'row automation-gesture-row')
    row.appendChild(el('div', 'dir', direction.label))
    const select = document.createElement('select')
    select.setAttribute('aria-label', `${direction.label} 手势对应的命令`)
    const unset = new Option('未映射', '')
    select.appendChild(unset)
    for (const group of groups) {
      const optionGroup = document.createElement('optgroup')
      optionGroup.label = group.label
      for (const action of group.actions) optionGroup.appendChild(new Option(action.label, action.id))
      select.appendChild(optionGroup)
    }
    select.value = state.snapshot.gestures[direction.id] || ''
    select.addEventListener('change', () => {
      const next = { ...state.snapshot.gestures }
      if (select.value) next[direction.id] = select.value
      else delete next[direction.id]
      state.snapshot = { ...state.snapshot, gestures: next }
      gestureCount.textContent = String(Object.keys(next).length)
      queueGestureSave()
    })
    row.appendChild(select)
    fragment.appendChild(row)
  }
  gestureList.appendChild(fragment)
}

function queueGestureSave(): void {
  pendingGestureSave = {
    gestures: { ...state.snapshot.gestures },
    gesturesEnabled: state.snapshot.gesturesEnabled
  }
  if (!gestureSaveRunning) void flushGestureSaves()
}

async function flushGestureSaves(): Promise<void> {
  gestureSaveRunning = true
  let saved = false
  try {
    while (pendingGestureSave) {
      const payload = pendingGestureSave
      pendingGestureSave = null
      const result = await rpc<SaveResult>(IPC_ROUTES.automationSave, payload)
      if (result && result.ok === false) throw new Error(String(result.reason || result.message || '保存失败'))
      saved = true
    }
    if (saved) showGestureStatus('手势设置已保存', 'success')
  } catch (error) {
    showGestureStatus(`手势设置保存失败：${errorMessage(error, '主进程没有响应')}`, 'error')
    pendingGestureSave = null
    await load(true)
  } finally {
    gestureSaveRunning = false
    if (pendingGestureSave) void flushGestureSaves()
  }
}

async function persistRules(next: readonly WorkspaceRule[], successMessage: string): Promise<boolean> {
  if (state.rulesBusy) return false
  const previous = state.snapshot.rules
  state.rulesBusy = true
  state.snapshot = { ...state.snapshot, rules: [...next] }
  renderRules()
  renderRuleEditorControls()
  try {
    const result = await rpc<SaveResult>(IPC_ROUTES.automationSave, {
      rules: state.snapshot.rules,
      rulesEnabled: state.snapshot.rulesEnabled
    })
    if (result && result.ok === false) throw new Error(String(result.reason || result.message || '保存失败'))
    showRulesStatus(successMessage, 'success')
    return true
  } catch (error) {
    state.snapshot = { ...state.snapshot, rules: previous }
    showRulesStatus(`保存失败：${errorMessage(error, '主进程没有响应')}`, 'error')
    return false
  } finally {
    state.rulesBusy = false
    renderRules()
    renderRuleEditorControls()
  }
}

function buildRuleRow(rule: WorkspaceRule): HTMLElement {
  const row = el('div', 'row automation-rule-row')
  const copy = el('div', 'automation-rule-copy')
  copy.appendChild(el('div', 'title', rule.name))
  const triggerLabel = state.snapshot.ruleTriggers.find((item) => item.id === rule.trigger)?.label
    || (rule.trigger === 'open' ? '标签打开时' : rule.trigger === 'navigate' ? '页面跳转后' : rule.trigger)
  copy.appendChild(el('div', 'summary', `${triggerLabel} · ${rule.match} · ${actionSummary(rule.actions, workspaceActionOptions(state.snapshot.actions))}`))
  row.appendChild(copy)
  const actions = el('div', 'actions')
  const toggle = button('btn', rule.enabled ? '已启用' : '已停用')
  toggle.disabled = state.rulesBusy
  toggle.addEventListener('click', () => {
    const next = state.snapshot.rules.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item)
    void persistRules(next, rule.enabled ? `已停用“${rule.name}”` : `已启用“${rule.name}”`)
  })
  const edit = button('btn', '编辑')
  edit.disabled = state.rulesBusy
  edit.addEventListener('click', () => openRuleEditor(rule))
  const remove = button('btn btn-danger', '删除')
  remove.disabled = state.rulesBusy
  remove.addEventListener('click', () => { void removeRule(rule) })
  actions.append(toggle, edit, remove)
  row.appendChild(actions)
  return row
}

function renderRules(): void {
  ruleCount.textContent = String(state.snapshot.rules.length)
  rulesEnabled.checked = state.snapshot.rulesEnabled
  rulesEnabled.disabled = state.loading || Boolean(state.loadError) || state.rulesBusy
  newRuleBtn.disabled = state.loading || Boolean(state.loadError) || state.rulesBusy
  ruleList.textContent = ''
  if (state.loading) {
    ruleList.appendChild(el('div', 'empty', '正在载入工作区规则…'))
    return
  }
  if (state.loadError) {
    ruleList.appendChild(el('div', 'empty', state.loadError))
    return
  }
  if (!state.snapshot.rules.length) {
    const empty = el('div', 'empty')
    empty.appendChild(el('div', 'empty-title', '还没有工作区规则'))
    empty.appendChild(el('div', 'empty-hint', '按网址匹配标签打开或跳转，再自动执行固定、静音、建栈或命令链。'))
    ruleList.appendChild(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const rule of state.snapshot.rules) fragment.appendChild(buildRuleRow(rule))
  ruleList.appendChild(fragment)
}

async function removeRule(rule: WorkspaceRule): Promise<void> {
  if (!window.confirm(`删除工作区规则“${rule.name}”？`)) return
  const saved = await persistRules(state.snapshot.rules.filter((item) => item.id !== rule.id), `已删除“${rule.name}”`)
  if (saved && state.ruleDraft?.id === rule.id) closeRuleEditor()
}

function openRuleEditor(rule?: WorkspaceRule | null): void {
  state.ruleDraft = createRuleDraft(rule)
  ruleEditorTitle.textContent = rule ? '编辑工作区规则' : '新建工作区规则'
  ruleNameInput.value = state.ruleDraft.name
  renderRuleTriggers(state.ruleDraft.trigger)
  ruleMatchInput.value = state.ruleDraft.match
  ruleEditor.hidden = false
  renderRuleActions()
  renderRuleEditorControls()
  ruleNameInput.focus()
}

function closeRuleEditor(): void {
  state.ruleDraft = null
  ruleEditor.hidden = true
}

function renderRuleEditorControls(): void {
  const disabled = state.rulesBusy || state.loading || Boolean(state.loadError) || !state.ruleDraft
  ruleNameInput.disabled = disabled
  ruleTriggerSelect.disabled = disabled
  ruleMatchInput.disabled = disabled
  ruleActionPicker.disabled = disabled
  addRuleActionBtn.disabled = disabled || !ruleActionPicker.value ||
    (state.ruleDraft?.actions.length || 0) >= 8
  saveRuleBtn.disabled = disabled
  cancelRuleBtn.disabled = disabled
  newRuleBtn.disabled = disabled || state.snapshot.rules.length >= 80
}

function renderRuleActions(): void {
  ruleActionsBox.textContent = ''
  if (!state.ruleDraft) return
  if (!state.ruleDraft.actions.length) {
    ruleActionsBox.appendChild(el('div', 'empty', '尚未添加动作。从下方选择一项后点击“添加动作”。'))
    renderRuleEditorControls()
    return
  }
  const options = workspaceActionOptions(state.snapshot.actions)
  const fragment = document.createDocumentFragment()
  state.ruleDraft.actions.forEach((action, index) => {
    const row = el('div', 'row automation-step-row')
    row.appendChild(el('div', 'idx', String(index + 1)))
    row.appendChild(el('div', 'step-label', actionSummary([action], options)))
    const remove = button('btn', '移除')
    remove.disabled = state.rulesBusy
    remove.addEventListener('click', () => {
      if (!state.ruleDraft) return
      state.ruleDraft.actions.splice(index, 1)
      renderRuleActions()
    })
    const actions = el('div', 'actions')
    actions.appendChild(remove)
    row.appendChild(actions)
    fragment.appendChild(row)
  })
  ruleActionsBox.appendChild(fragment)
  renderRuleEditorControls()
}

function renderRuleActionPicker(): void {
  ruleActionPicker.textContent = ''
  for (const group of groupActions(workspaceActionOptions(state.snapshot.actions))) {
    const optionGroup = document.createElement('optgroup')
    optionGroup.label = group.label
    for (const action of group.actions) optionGroup.appendChild(new Option(action.label, action.id))
    ruleActionPicker.appendChild(optionGroup)
  }
  renderRuleEditorControls()
}

async function saveRuleEditor(): Promise<void> {
  if (!state.ruleDraft) return
  const rule = ruleFromDraft({
    ...state.ruleDraft,
    name: ruleNameInput.value,
    trigger: ruleTriggerSelect.value || 'open',
    match: ruleMatchInput.value
  })
  if (!rule) {
    showRulesStatus('请填写名称、网址匹配，并至少添加一个动作。', 'error')
    return
  }
  const saved = await persistRules(upsertRule(state.snapshot.rules, rule), state.ruleDraft.isNew ? '工作区规则已创建' : '工作区规则已更新')
  if (saved) closeRuleEditor()
}

function renderRuleTemplates(): void {
  ruleTemplateSelect.textContent = ''
  ruleTemplateSelect.appendChild(new Option('选择规则模板…', ''))
  for (const template of WORKSPACE_RULE_TEMPLATES) {
    const option = new Option(template.name, template.id)
    option.title = template.description
    ruleTemplateSelect.appendChild(option)
  }
}

function renderRuleTriggers(selected = ''): void {
  const current = selected || ruleTriggerSelect.value || 'open'
  ruleTriggerSelect.textContent = ''
  ruleTriggerSelect.appendChild(new Option('标签打开时', 'open'))
  ruleTriggerSelect.appendChild(new Option('页面跳转后', 'navigate'))
  for (const trigger of state.snapshot.ruleTriggers) {
    if (trigger.id === 'open' || trigger.id === 'navigate') continue
    ruleTriggerSelect.appendChild(new Option(trigger.label, trigger.id))
  }
  if (current && !Array.from(ruleTriggerSelect.options).some((option) => option.value === current)) {
    ruleTriggerSelect.appendChild(new Option(current, current))
  }
  ruleTriggerSelect.value = current || 'open'
}

function renderTasks(): void {
  taskList.textContent = ''
  if (!state.tasks.length) {
    renderEmpty(taskList, '还没有保存的任务工作区。')
    return
  }
  const fragment = document.createDocumentFragment()
  for (const task of state.tasks) {
    const row = el('div', 'row automation-rule-row')
    const copy = el('div', 'automation-rule-copy')
    copy.appendChild(el('div', 'title', task.name))
    copy.appendChild(el('div', 'summary', `${task.tabs.length} 个标签 · ${fmtTaskDate(task.createdAt)}`))
    row.appendChild(copy)
    const actions = el('div', 'actions')
    const open = button('btn', '恢复')
    open.onclick = () => { void restoreTask(task) }
    const remove = button('icon-btn', '×')
    remove.title = '删除任务工作区'
    remove.onclick = () => { void removeTask(task) }
    actions.append(open, remove)
    row.appendChild(actions)
    fragment.appendChild(row)
  }
  taskList.appendChild(fragment)
}

function fmtTaskDate(value: number): string {
  try { return new Date(value).toLocaleString() } catch { return '' }
}

async function loadTasks(): Promise<void> {
  state.tasks = await loadWorkspaceTasks()
  renderTasks()
}

async function saveCurrentTask(): Promise<void> {
  const name = taskNameInput.value.trim()
  if (!name) {
    taskNameInput.focus()
    return
  }
  try {
    const result = await captureWorkspaceTask(name)
    state.tasks = result.tasks
    renderTasks()
    if (!result.ok) {
      showRulesStatus(result.error || '保存任务失败', 'error')
      return
    }
    taskNameInput.value = ''
    showRulesStatus('任务工作区已保存', 'success')
  } catch (error) {
    showRulesStatus(`保存任务失败：${errorMessage(error, '主进程没有响应')}`, 'error')
  }
}

async function restoreTask(task: WorkspaceTask): Promise<void> {
  try {
    const restored = await restoreWorkspaceTask(task)
    showRulesStatus(`已恢复 ${restored} 个标签`, 'success')
  } catch (error) {
    showRulesStatus(`恢复任务失败：${errorMessage(error, '主进程没有响应')}`, 'error')
  }
}

async function removeTask(task: WorkspaceTask): Promise<void> {
  if (!confirm(`删除任务工作区“${task.name}”？`)) return
  state.tasks = await removeWorkspaceTask(task.id)
  renderTasks()
}

async function applyRuleTemplate(): Promise<void> {
  const id = ruleTemplateSelect.value
  const template = WORKSPACE_RULE_TEMPLATES.find((item) => item.id === id)
  if (!template) return
  const additions: WorkspaceRule[] = template.rules.map((rule) => ({
    id: `${template.id}-${createRuleId()}`,
    name: rule.name,
    enabled: true,
    trigger: rule.trigger,
    match: rule.match,
    actions: [...rule.actions]
  }))
  const saved = await persistRules([...state.snapshot.rules, ...additions], `已应用“${template.name}”模板`)
  if (saved) ruleTemplateSelect.value = ''
}

async function load(silent = false): Promise<void> {
  const sequence = ++loadSequence
  if (!silent) {
    state.loading = true
    state.loadError = ''
    renderChains()
    renderGestures()
    renderRules()
    renderChainEditorControls()
  }
  try {
    const payload = await rpc<unknown>(IPC_ROUTES.automationGet, {})
    if (sequence !== loadSequence) return
    state.snapshot = readAutomationSnapshot(payload)
    state.loadError = ''
  } catch (error) {
    if (sequence !== loadSequence) return
    state.loadError = `载入失败：${errorMessage(error, '主进程没有响应')}`
  } finally {
    if (sequence !== loadSequence) return
    state.loading = false
    renderStepPicker()
    renderRuleActionPicker()
    renderRuleTriggers()
    renderChains()
    renderGestures()
    renderRules()
    renderSteps()
    renderRuleActions()
    renderChainEditorControls()
  }
}

tabChains.addEventListener('click', () => setTab('chains'))
tabGestures.addEventListener('click', () => setTab('gestures'))
tabRules.addEventListener('click', () => setTab('rules'))
for (const [index, tab] of [tabChains, tabGestures, tabRules].entries()) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? 2
        : event.key === 'ArrowLeft'
          ? (index + 2) % 3
          : (index + 1) % 3
    const target = [tabChains, tabGestures, tabRules][next]
    setTab(next === 0 ? 'chains' : next === 1 ? 'gestures' : 'rules')
    target.focus()
  })
}
newChainBtn.addEventListener('click', () => openEditor())
cancelChainBtn.addEventListener('click', closeEditor)
nameInput.addEventListener('input', renderChainEditorControls)
stepPicker.addEventListener('change', renderChainEditorControls)
addStepBtn.addEventListener('click', () => {
  if (!state.draft || !stepPicker.value || state.draft.steps.length >= CHAIN_LIMITS.maxSteps) return
  state.draft.steps.push(stepPicker.value)
  renderSteps()
  stepPicker.focus()
})
saveChainBtn.addEventListener('click', () => { void saveEditor() })
gesturesEnabled.addEventListener('change', () => {
  state.snapshot = { ...state.snapshot, gesturesEnabled: gesturesEnabled.checked }
  queueGestureSave()
})
resetGesturesBtn.addEventListener('click', () => {
  if (!window.confirm('恢复出厂手势映射？当前映射会被覆盖。')) return
  state.snapshot = { ...state.snapshot, gestures: { ...DEFAULT_GESTURE_MAP } }
  renderGestures()
  queueGestureSave()
})
newRuleBtn.addEventListener('click', () => openRuleEditor())
cancelRuleBtn.addEventListener('click', closeRuleEditor)
addRuleActionBtn.addEventListener('click', () => {
  if (!state.ruleDraft || !ruleActionPicker.value || state.ruleDraft.actions.length >= 8) return
  if (!state.ruleDraft.actions.includes(ruleActionPicker.value)) {
    state.ruleDraft.actions.push(ruleActionPicker.value)
  }
  renderRuleActions()
})
saveRuleBtn.addEventListener('click', () => { void saveRuleEditor() })
rulesEnabled.addEventListener('change', () => {
  state.snapshot = { ...state.snapshot, rulesEnabled: rulesEnabled.checked }
  void persistRules(state.snapshot.rules, rulesEnabled.checked ? '工作区规则已启用' : '工作区规则已停用')
})
applyRuleTemplateBtn.addEventListener('click', () => { void applyRuleTemplate() })
saveTaskBtn.addEventListener('click', () => { void saveCurrentTask() })

const unsubscribeSettings = subscribe<SettingsChange>(IPC_EVENTS.settingsChanged, (change) => {
  if (!change || (change.scope !== 'all' && !isAutomationSetting(change.key))) return
  void load(true)
})

window.addEventListener('beforeunload', () => {
  unsubscribeSettings()
  window.clearTimeout(chainStatusTimer)
  window.clearTimeout(gestureStatusTimer)
  window.clearTimeout(ruleStatusTimer)
})

setTab(state.activeView, false)
renderRuleTemplates()
renderStepPicker()
renderChains()
renderGestures()
renderRules()
renderRuleActionPicker()
renderTasks()
void load()
void loadTasks()
