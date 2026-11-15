/**
 * 阶段 · 启动方式
 *
 * 只写既有 `app.startup_mode` 键。引导不提供 blank，缺省选中快速拨号页；
 * 选择写入与回滚绑定当前 mount，避免双击造成乱序落盘。
 */

import {
  STARTUP_SETTING_KEYS,
  STARTUP_MODES,
  DEFAULT_STARTUP_MODE
} from 'hira://shared/startup.mjs'
import { errorMessage } from 'hira://shared/page-kit.js'
import { withTimeout } from './async.js'
import type { OnboardingContext, OnboardingStage, OnboardingStageView } from './types.js'

interface StartupOption {
  value: string
  name: string
  description: string
}

interface StartupView extends OnboardingStageView {
  disposed: boolean
  interacted: boolean
  activeValue: string
}

const COPY: Record<string, { name: string; description: string }> = {
  home: { name: '主页 / 快速拨号', description: '打开常用网站和新标签页内容' },
  custom: { name: '自定义网页', description: '沿用已保存的启动页地址' },
  last_session: { name: '恢复上次会话', description: '继续上次关闭时的标签页' }
}

const OPTIONS: readonly StartupOption[] = STARTUP_MODES
  .filter((value) => value !== 'blank')
  .map((value) => ({
    value,
    ...(COPY[value] || { name: value, description: '' })
  }))

const SETTING_KEY = STARTUP_SETTING_KEYS.mode

const startup: OnboardingStage = {
  id: 'startup',
  label: '启动',
  hint: '之后可在「设置 → 启动与行为 → 常规」更改',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', '每次启动，先看到什么'))
    root.appendChild(ctx.el('p', 'oobe-sub', '启动方式会立即保存，不影响当前窗口。'))

    const list = ctx.el('div', 'oobe-options')
    for (const option of OPTIONS) {
      const item = ctx.el('button', 'oobe-choice oobe-choice--row') as HTMLButtonElement
      item.type = 'button'
      item.dataset.value = option.value
      item.setAttribute('aria-pressed', 'false')

      const body = ctx.el('span', 'oobe-choice-body')
      body.appendChild(ctx.el('span', 'oobe-choice-name', option.name))
      if (option.description) body.appendChild(ctx.el('span', 'oobe-choice-desc', option.description))

      item.append(body, ctx.el('span', 'oobe-radio'))
      item.addEventListener('click', () => void choose(ctx, view, list, option.value))
      list.appendChild(item)
    }
    root.appendChild(list)

    let ready: Promise<void> = Promise.resolve()
    const view: StartupView = {
      el: root,
      disposed: false,
      interacted: false,
      activeValue: '',
      async beforeNext () {
        await ready
      },
      destroy () {
        this.disposed = true
      }
    }
    ready = readCurrent(ctx, view, list)
    return view
  }
}

async function readCurrent (
  ctx: OnboardingContext,
  view: StartupView,
  list: HTMLElement
): Promise<void> {
  let value = ''
  try {
    const result = await withTimeout(
      ctx.rpc(ctx.IPC_ROUTES.settingsGet, { key: SETTING_KEY }),
      3000,
      'startup read'
    )
    value = result && typeof result.value === 'string' ? result.value : ''
  } catch (error) {
    console.warn('[onboarding] 读取启动方式失败:', errorMessage(error))
  }
  if (view.disposed || view.interacted) return

  const valid = OPTIONS.some((option) => option.value === value)
  const active = valid ? value : DEFAULT_STARTUP_MODE
  view.activeValue = active
  ctx.draft.startupMode = active
  paint(view, list, active)
}

function paint (view: StartupView, list: HTMLElement, value: string): void {
  view.activeValue = value
  Array.from(list.children).forEach((child) => {
    const item = child as HTMLElement
    const on = item.dataset.value === value
    item.classList.toggle('is-active', on)
    item.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

async function choose (
  ctx: OnboardingContext,
  view: StartupView,
  list: HTMLElement,
  value: string
): Promise<void> {
  view.interacted = true
  if (value === view.activeValue) return
  const previous = view.activeValue

  await ctx.runExclusive(async () => {
    paint(view, list, value)
    ctx.draft.startupMode = value

    let result: { ok?: boolean } | null = null
    try {
      result = await withTimeout(
        ctx.rpc<{ ok?: boolean }>(ctx.IPC_ROUTES.settingsSet, { key: SETTING_KEY, value }),
        4000,
        'startup write'
      )
    } catch {
      result = { ok: false }
    }
    if (result && result.ok !== false) return
    if (view.disposed) return

    paint(view, list, previous)
    ctx.draft.startupMode = previous
    ctx.toast('保存启动方式失败，请稍后再试')
  })
}

export default startup
