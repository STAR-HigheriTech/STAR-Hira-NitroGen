/**
 * hira://onboarding · 引导壳（ES Module）
 *
 * 职责边界（改这里之前先看 stages/index.ts）：
 *   · 本文件只负责**壳**：进度点、内容槽、上一步 / 下一步、关闭、轻提示、忙碌锁、流程切换。
 *   · 每一阶段长什么样、要不要写设置、能不能继续，全部由 stages/<name>.ts 决定。
 *   · 新增一步 = 写一个 stage 模块 + 在 stages/index.ts 的 ORDER 里加一项，本文件一行都不用改。
 *
 * 流程不是常量数组：`flow` 由用户来源（其它浏览器 / Hira Min）决定，
 * 切换来源时**原地换表**（见 enterFlow），进度点随之重排。
 *
 * 关闭语义（与主进程 main/onboarding/index.js 对齐）：
 *   点右上角 × → `window:close` → 主进程 close 事件里 preventDefault 并走 complete()。
 *   也就是说「关窗 = 跳过引导 = 视为完成」，不会把用户永远关在引导里。
 */

import { IPC_ROUTES, rpc, el, initTheme, initThemeBackground } from 'hira://shared/runtime.js'
import { errorMessage } from 'hira://shared/page-kit.js'
import { resolveFlow, USER_SOURCES } from './stages/index.js'
import { DEFAULT_USER_SOURCE, normalizeUserSource } from './stages/user-source.js'
import type {
  OnboardingDraft,
  OnboardingContext,
  OnboardingStage,
  OnboardingStageView
} from './stages/types.js'

// ── 页面级状态：只有这一份，stage 通过 ctx 读写 ─────────────────────
const state: { index: number; busy: boolean; done: boolean; source: string } = { index: 0, busy: false, done: false, source: DEFAULT_USER_SOURCE }

// 引导窗与独立面板共用主进程的“跟随主题材质”能力位。属性必须先于主题首帧写入，
// 否则会先铺一次不透明底，再切成材质态。
if (new URLSearchParams(window.location.search).get('windowMaterial') === '1') {
  document.documentElement.dataset.windowMaterial = '1'
}
void initTheme()
void initThemeBackground(
  document.getElementById('oobe-theme-background'),
  {
    scope: 'window',
    overlay: document.getElementById('oobe-theme-background-overlay')
  }
)

// 用户在这一轮引导里做出的选择。stage 只写这里，落盘时机由 stage 自己决定
// （主题 / 布局 / 启动方式点击即生效；导入在 migrate 那一屏当场入库）。
const draft: OnboardingDraft = {
  source: DEFAULT_USER_SOURCE,
  themeId: '',
  themeName: '',
  layout: null,
  startupMode: '',
  migration: {}
}

/** 当前流程（stage 模块数组）。来源一变，整串替换 —— 不缓存、不合并。 */
// 首屏前由 boot() 先探测运行态能力，再解析出真正的流程（见 capabilities）。
let flow: OnboardingStage[] = []

/**
 * 运行态能力表：决定某一步「该不该存在」。
 *
 * associations=false（开发态）时不出现 `default-browser` 阶段 ——
 * 主进程已把关联能力整块关闭（见 main/app/default-client.js），
 * 留着这一步只会让用户点到一个永远无效的按钮。
 */
const capabilities = { associations: false }

/** 向主进程要「应用事实」：`isDevelopment === true` 即开发态。探测失败按开发态处理。 */
async function resolveCapabilities () {
  let timer = 0
  try {
    const info = await Promise.race([
      rpc(IPC_ROUTES.appInfo, {}),
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('app info timeout')), 1200)
      })
    ]) as { isDevelopment?: boolean } | null
    capabilities.associations = Boolean(info) && info?.isDevelopment !== true
  } catch (_) {
    capabilities.associations = false // 宁可少一步，也不在不确定时把用户带去写系统
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

const nodes = {
  shell: document.querySelector('.oobe'),
  steps: document.getElementById('steps'),
  stage: document.getElementById('stage'),
  hint: document.getElementById('hint'),
  back: document.getElementById('btn-back') as HTMLButtonElement | null,
  next: document.getElementById('btn-next') as HTMLButtonElement | null,
  close: document.getElementById('btn-close') as HTMLButtonElement | null,
  toast: document.getElementById('toast')
}

// ── 轻提示：同一条文案重复触发时只重置计时器，不叠加节点 ───────────
let toastTimer = 0
function toast (message?: string): void {
  const toastNode = nodes.toast
  if (!toastNode) return
  const text = String(message || '').trim()
  if (!text) return
  toastNode.textContent = text
  toastNode.hidden = false
  // 先移除再强制重排，保证连续调用也有入场动画
  toastNode.classList.remove('is-in')
  void toastNode.offsetWidth
  toastNode.classList.add('is-in')
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastNode.classList.remove('is-in')
    toastTimer = window.setTimeout(() => {
      toastNode.hidden = true
      toastTimer = 0
    }, 200)
  }, 2600)
}

function setBusy (busy: boolean): void {
  state.busy = Boolean(busy)
  if (nodes.shell) nodes.shell.classList.toggle('is-busy', state.busy)
  if (nodes.shell) nodes.shell.setAttribute('aria-busy', state.busy ? 'true' : 'false')
  syncActions()
}

function current (): OnboardingStage | null {
  return flow[state.index] || null
}

function focusPrimary (): void {
  if (nodes.next && !nodes.next.disabled) nodes.next.focus({ preventScroll: true })
}

/** One interaction at a time: prevents duplicate writes from double clicks. */
async function runExclusive<T> (task: () => Promise<T> | T): Promise<T | undefined> {
  if (state.busy || state.done) return undefined
  setBusy(true)
  try {
    return await task()
  } finally {
    setBusy(false)
  }
}

// ── 流程切换（来源选择）─────────────────────────────────────────────
/**
 * 换一条流程。
 *
 * 只允许在欢迎页调用（所有流程的第一步都是 welcome）：内容槽里此刻画的就是欢迎页，
 * 于是这里**只重排进度点**，不重挂 DOM —— 点路径卡时界面不会闪一下。
 * 若将来从别处调用，则退化成从头开始，避免「索引与流程对不上」。
 *
 * @param {string} source USER_SOURCES 里的值
 * @returns {boolean} 流程是否真的变了
 */
function enterFlow (source?: string) : boolean {
  const id = normalizeUserSource(source)
  const changed = state.source !== id
  state.source = id
  draft.source = id
  if (!changed) return false

  const wasIndex = state.index
  flow = resolveFlow(id, { includeDefaultBrowser: capabilities.associations })
  renderSteps()
  if (wasIndex !== 0) {
    // 不在欢迎页却换了流程：索引与内容都对不上了，只能从头重挂。
    void show(0)
    return true
  }
  state.index = 0
  paintSteps()
  syncActions()
  return true
}

// ── 进度点 ───────────────────────────────────────────────────────────
function renderSteps (): void {
  const steps = nodes.steps
  if (!steps) return
  steps.textContent = ''
  flow.forEach((stage, i) => {
    const item = el('li', 'oobe-step')
    item.appendChild(el('span', 'oobe-step-dot'))
    item.appendChild(document.createTextNode(stage.label || stage.id))
    item.dataset.index = String(i)
    item.title = `第 ${i + 1} 步：${stage.label || stage.id}`
    steps.appendChild(item)
  })
  steps.dataset.count = String(flow.length)
}

function paintSteps (): void {
  const steps = nodes.steps
  if (!steps) return
  Array.from(steps.children).forEach((item, i) => {
    item.classList.toggle('is-active', i === state.index)
    item.classList.toggle('is-done', i < state.index)
    if (i === state.index) item.setAttribute('aria-current', 'step')
    else item.removeAttribute('aria-current')
  })
}

// ── 按钮态 ───────────────────────────────────────────────────────────
function syncActions () {
  const stage = current()
  const last = flow.length > 0 && state.index >= flow.length - 1
  if (nodes.next) {
    nodes.next.textContent = (stage && stage.nextLabel) || (last ? '完成' : '继续')
    nodes.next.disabled = state.busy || state.done
    nodes.next.setAttribute('aria-busy', state.busy ? 'true' : 'false')
  }
  if (nodes.back) {
    // 第一步没有「上一步」，但保留按钮占位（见 CSS .is-hidden）
    nodes.back.classList.toggle('is-hidden', state.index === 0)
    nodes.back.disabled = state.busy || state.done || state.index === 0
  }
  if (nodes.hint) nodes.hint.textContent = (stage && stage.hint) || ''
  document.title = stage ? `${stage.label || stage.id} · 欢迎使用 Hira` : '欢迎使用 Hira'
}

// ── 切换阶段 ─────────────────────────────────────────────────────────
/** Current disposable view. Async callbacks compare this identity before touching DOM. */
let mountedStage: OnboardingStageView | null = null

function normalizeView (value: HTMLElement | OnboardingStageView | null): OnboardingStageView | null {
  if (!value) return null
  if (value instanceof HTMLElement) return { el: value }
  return value
}

function disposeView (view: OnboardingStageView | null): void {
  if (!view || typeof view.destroy !== 'function') return
  try {
    view.destroy()
  } catch (error) {
    console.warn('[onboarding] 阶段卸载失败:', errorMessage(error))
  }
}

async function show (index: number): Promise<void> {
  const stage = flow[index]
  if (!stage) return

  disposeView(mountedStage)
  mountedStage = null

  state.index = index
  const stageHost = nodes.stage
  if (!stageHost) return
  stageHost.textContent = ''
  stageHost.dataset.stage = stage.id

  let rendered: OnboardingStageView | null = null
  try {
    rendered = normalizeView(stage.mount(ctx))
  } catch (error) {
    console.error('[onboarding] 阶段渲染失败:', errorMessage(error))
  }
  if (!rendered) {
    const fallback = el('section', 'oobe-view')
    fallback.appendChild(el('h1', 'oobe-title', '这一步加载失败了'))
    fallback.appendChild(el('p', 'oobe-sub', '可以直接关闭窗口跳过引导，设置里随时能重新运行。'))
    rendered = { el: fallback }
  }

  mountedStage = rendered
  rendered.el.classList.add('oobe-view')
  stageHost.appendChild(rendered.el)
  // 下一帧再上入场类，保证 transition 真的跑一次
  requestAnimationFrame(() => {
    if (mountedStage === rendered) rendered?.el.classList.add('is-in')
  })

  paintSteps()
  syncActions()
  const focusTarget = rendered.el.querySelector<HTMLElement>('[autofocus]') || nodes.next
  if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true })
}

// ── 前进 / 后退 ──────────────────────────────────────────────────────
async function next (): Promise<void> {
  if (state.busy || state.done) return
  const stage = current()
  if (!stage) return

  const view = mountedStage
  let verdict
  try {
    verdict = await runExclusive(async () => {
      if (view && typeof view.beforeNext === 'function') await view.beforeNext()
      if (typeof stage.onNext === 'function') return await stage.onNext(ctx)
    })
  } catch (error) {
    console.error('[onboarding] 阶段提交失败:', errorMessage(error))
    toast('这一步没有保存成功，请重试')
    return
  }
  // 约定：返回 false 表示「停在原地」（用户没填完 / 调用失败 / 已自行完成）
  if (verdict === false) return

  if (state.index >= flow.length - 1) return
  await show(state.index + 1)
}

async function back (): Promise<void> {
  if (state.busy || state.done || state.index === 0) return
  await show(state.index - 1)
}

/** 关窗 = 跳过 = 完成（主进程在 close 事件里 preventDefault 后走 onboarding:complete） */
function close () {
  if (state.done) return
  state.done = true
  rpc(IPC_ROUTES.windowClose).catch(() => {
    state.done = false
    syncActions()
    toast('关闭窗口失败，请再试一次')
  })
}

/**
 * 收尾：交给主进程挂主窗口 + 记住版本号 + 销毁本窗口。
 * 成功路径下本页会被直接销毁，所以这里**不**再做任何 UI 收尾。
 */
async function complete (): Promise<void> {
  if (state.done) return
  state.done = true
  setBusy(true)
  try {
    const res = await rpc(IPC_ROUTES.onboardingComplete, {})
    if (!res || res.ok === false) throw new Error('complete failed')
  } catch {
    state.done = false
    setBusy(false)
    toast('没能完成引导，请重试，或关闭窗口稍后再来')
  }
}

// ── 交给各 stage 的上下文（契约见 stages/index.ts 顶部注释）──────────
const ctx: OnboardingContext = {
  rpc,
  IPC_ROUTES,
  el,
  draft,
  sources: USER_SOURCES,
  enterFlow,
  next,
  back,
  close,
  setBusy,
  toast,
  focusPrimary,
  complete,
  runExclusive
}

// ── 键盘：空白处 Enter 继续、Alt+← 返回、Esc 关闭 ───────────────────
function onKeydown (event: KeyboardEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null
  const tag = target?.tagName
  const interactive = Boolean(
    target?.isContentEditable ||
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    target?.closest('[role="button"], [role="dialog"]')
  )
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.altKey && event.key === 'ArrowLeft' && !interactive) {
    event.preventDefault()
    back()
    return
  }
  if (event.key === 'Enter' && !interactive) {
    event.preventDefault()
    next()
  }
}

// ── 启动 ─────────────────────────────────────────────────────────────
async function boot (): Promise<void> {
  nodes.close?.addEventListener('click', close)
  nodes.next?.addEventListener('click', next)
  nodes.back?.addEventListener('click', back)
  window.addEventListener('keydown', onKeydown)
  setBusy(true)
  if (nodes.stage) {
    const loading = el('section', 'oobe-view is-in oobe-loading')
    loading.append(
      el('span', 'oobe-loading-mark'),
      el('p', 'oobe-sub', '正在准备设置…')
    )
    nodes.stage.appendChild(loading)
  }
  try {
    // 先问主进程「是不是开发态」，再解析流程：关联能力关闭时 `default-browser` 整步不出现。
    await resolveCapabilities()
    flow = resolveFlow(state.source, { includeDefaultBrowser: capabilities.associations })
    if (!flow.length) {
      setBusy(false)
      if (nodes.stage) {
        nodes.stage.textContent = ''
        nodes.stage.appendChild(el('p', 'oobe-sub', '没有可用的引导步骤。'))
      }
      if (nodes.next) nodes.next.disabled = true
      return
    }

    setBusy(false)
    renderSteps()
    await show(0)
  } catch (error) {
    setBusy(false)
    console.error('[onboarding] 初始化失败:', errorMessage(error))
    if (nodes.stage) {
      nodes.stage.textContent = ''
      const fallback = el('section', 'oobe-view is-in')
      fallback.appendChild(el('h1', 'oobe-title', '欢迎使用 Hira'))
      fallback.appendChild(el('p', 'oobe-sub', '引导暂时没有加载完整，关闭窗口即可进入浏览器。'))
      nodes.stage.appendChild(fallback)
    }
    if (nodes.next) nodes.next.disabled = true
  }
}

boot()
