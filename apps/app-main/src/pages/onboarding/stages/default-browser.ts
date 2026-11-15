/**
 * 阶段 · 默认浏览器
 *
 * 与设置页共用 IPC、状态文案和回读节奏。定时器、焦点监听与小窗状态全部
 * 属于本次 mount，destroy 后不会继续写已卸载的 DOM。
 */

import { APP_NAME, DEFAULT_BROWSER_ACTION } from '@hira-ng/shared-types/src/associations.mjs'
import { withTimeout } from './async.js'
import type { OnboardingContext, OnboardingStage, OnboardingStageView } from './types.js'

interface BrowserState extends OnboardingStageView {
  disposed: boolean
  busy: boolean
  probing: boolean
  checked: boolean
  isDefault: boolean
  pollTimer: number | null
  pollAttempts: number
  badge: HTMLElement
  button: HTMLButtonElement
}

const defaultBrowser: OnboardingStage = {
  id: 'default-browser',
  label: '默认',
  hint: '不是默认浏览器也能正常使用，之后可在设置里再开',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', `让网页默认交给 ${APP_NAME}`))
    root.appendChild(ctx.el('p', 'oobe-sub', '接管网页链接和 HTML 文档；系统策略不允许时会给出明确提示。'))

    const card = ctx.el('div', 'oobe-surface oobe-status-card')
    const main = ctx.el('div', 'oobe-status-main')
    const line = ctx.el('div', 'oobe-status-line')
    const badge = ctx.el('span', 'badge', '检查中')
    badge.setAttribute('role', 'status')
    line.append(ctx.el('span', undefined, '默认浏览器'), badge)
    main.append(line, ctx.el('span', 'oobe-status-desc', '之后随时可以改回系统默认。'))

    const button = ctx.el('button', 'btn', DEFAULT_BROWSER_ACTION.runLabel) as HTMLButtonElement
    button.type = 'button'
    card.append(main, button)
    root.appendChild(card)

    const state: BrowserState = {
      el: root,
      disposed: false,
      busy: false,
      probing: false,
      checked: false,
      isDefault: false,
      pollTimer: null,
      pollAttempts: 0,
      badge,
      button,
      destroy () {
        this.disposed = true
        stopPoll(this)
        window.removeEventListener('focus', onFocus)
      }
    }

    button.addEventListener('click', () => void apply(ctx, state))
    window.addEventListener('focus', onFocus)
    paint(state)
    void probe(ctx, state)
    return state

    function onFocus (): void {
      if (state.disposed || document.hidden || state.busy) return
      void probe(ctx, state)
    }
  }
}

function stopPoll (state: BrowserState): void {
  if (state.pollTimer === null) return
  window.clearInterval(state.pollTimer)
  state.pollTimer = null
  state.pollAttempts = 0
}

function paint (state: BrowserState): void {
  if (state.disposed) return
  state.badge.classList.toggle('badge-success', state.isDefault)
  state.badge.textContent = !state.checked
    ? '检查中'
    : (state.isDefault ? '已设置' : (state.busy ? '登记中' : '未设置'))
  state.button.textContent = state.isDefault ? DEFAULT_BROWSER_ACTION.doneLabel : DEFAULT_BROWSER_ACTION.runLabel
  state.button.disabled = state.busy || state.isDefault || !state.checked
  if (state.isDefault) stopPoll(state)
}

function setDefault (state: BrowserState, value: boolean): void {
  if (state.isDefault === value) return
  state.isDefault = value
  paint(state)
}

async function probe (ctx: OnboardingContext, state: BrowserState): Promise<void> {
  if (state.disposed || state.busy || state.probing) return
  state.probing = true
  try {
    const isDefault = Boolean(await withTimeout(
      ctx.rpc(ctx.IPC_ROUTES.appIsDefaultBrowser),
      2500,
      'default browser probe'
    ))
    if (!state.disposed && !state.busy) {
      state.checked = true
      setDefault(state, isDefault)
      paint(state)
    }
  } catch (_) {
    if (!state.disposed && !state.busy) {
      state.checked = true
      paint(state)
    }
  } finally {
    state.probing = false
  }
}

function startPoll (ctx: OnboardingContext, state: BrowserState): void {
  if (state.disposed || state.isDefault || state.pollTimer !== null || !(DEFAULT_BROWSER_ACTION.poll > 0)) return
  state.pollAttempts = 0
  state.pollTimer = window.setInterval(() => {
    if (++state.pollAttempts > 60) { stopPoll(state); return }
    if (state.disposed || document.hidden || state.busy || state.isDefault) return
    void probe(ctx, state)
  }, DEFAULT_BROWSER_ACTION.poll)
}

async function apply (ctx: OnboardingContext, state: BrowserState): Promise<void> {
  if (state.disposed || state.busy || state.isDefault) return
  await ctx.runExclusive(async () => {
    if (state.disposed) return
    state.busy = true
    state.checked = true
    paint(state)

    let isDefault = false
    try {
      isDefault = Boolean(await withTimeout(
        ctx.rpc(ctx.IPC_ROUTES.appSetDefaultBrowser),
        10000,
        'default browser write'
      ))
    } catch (_) {
      isDefault = false
    }
    state.busy = false
    if (state.disposed) return

    state.isDefault = isDefault
    paint(state)
    if (!isDefault) {
      void probe(ctx, state)
      startPoll(ctx, state)
    }
    ctx.toast(isDefault ? DEFAULT_BROWSER_ACTION.toastDone : DEFAULT_BROWSER_ACTION.toastPending)
  })
}

export default defaultBrowser
