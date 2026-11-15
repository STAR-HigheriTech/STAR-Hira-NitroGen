/**
 * 阶段 · 布局
 *
 * 四种人眼可见的外壳形态映射到既有布局真源。写设置与回滚都在本次 mount
 * 的闭包里完成；卡片高亮始终对应最后一次明确成功的写入。
 */

import {
  LAYOUT_SETTING_KEYS,
  layoutPresetWrites,
  matchLayoutPreset
} from 'hira://shared/layout.mjs'
import { withTimeout } from './async.js'
import type { OnboardingContext, OnboardingStage, OnboardingStageView } from './types.js'

interface LayoutOption {
  id: string
  label: string
  preset: string
  mode: string
}

interface LayoutView extends OnboardingStageView {
  disposed: boolean
  activeId: string
  snapshot: Record<string, unknown>
}

const OPTIONS: readonly LayoutOption[] = Object.freeze([
  { id: 'classic', label: '经典', preset: 'classic', mode: 'default' },
  { id: 'compact', label: '紧凑', preset: 'classic', mode: 'compact' },
  { id: 'vertical-tabs', label: '垂直标签', preset: 'vertical-tabs', mode: 'default' },
  { id: 'vertical-all-in-one', label: '全功能侧栏', preset: 'vertical-all-in-one', mode: 'default' }
])

const PREVIEW_SPECS: Record<string, { rows: string[][]; side: string[] }> = Object.freeze({
  classic: { rows: [['tab', 'tab'], ['nav']], side: [] },
  compact: { rows: [['tab', 'nav']], side: [] },
  'vertical-tabs': { rows: [['nav']], side: ['tab', 'tab', 'tab'] },
  'vertical-all-in-one': { rows: [['ctl']], side: ['nav', 'tab', 'tab', 'tab'] }
})

const layout: OnboardingStage = {
  id: 'layout',
  label: '布局',
  hint: '点击即生效，之后可在「设置 → 外观 → 布局」更换',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', '选一种顺手的外壳'))
    root.appendChild(ctx.el('p', 'oobe-sub', '布局会立即保存，之后仍可随时切换。'))

    const grid = ctx.el('div', 'oobe-layouts')
    grid.appendChild(ctx.el('p', 'notice', '正在读取当前布局…'))
    root.appendChild(grid)

    let ready: Promise<void> = Promise.resolve()
    const view: LayoutView = {
      el: root,
      disposed: false,
      activeId: '',
      snapshot: {},
      async beforeNext () {
        await ready
      },
      destroy () {
        this.disposed = true
      }
    }
    ready = load(ctx, view, grid)
    return view
  }
}

async function load (ctx: OnboardingContext, view: LayoutView, grid: HTMLElement): Promise<void> {
  const settings = await readSettings(ctx)
  if (view.disposed) return

  view.snapshot = { ...settings }
  const active = deriveOption(settings)
  view.activeId = active ? active.id : ''
  ctx.draft.layout = active
    ? { id: active.id, label: active.label, preset: active.preset, mode: active.mode }
    : null

  grid.textContent = ''
  for (const option of OPTIONS) {
    const card = buildCard(ctx, option, option.id === view.activeId)
    card.addEventListener('click', () => void select(ctx, view, option, card))
    grid.appendChild(card)
  }
  syncSelection(grid, view.activeId)
}

function readKeys (): string[] {
  const positions = LAYOUT_SETTING_KEYS.rowPosition
  return [
    LAYOUT_SETTING_KEYS.preset,
    LAYOUT_SETTING_KEYS.mode,
    LAYOUT_SETTING_KEYS.titlebarEnabled,
    positions.tabbar,
    positions.navbar,
    positions.titlebar,
    positions.bookmarkbar
  ]
}

async function readSettings (ctx: OnboardingContext): Promise<Record<string, unknown>> {
  const pairs = await Promise.all(
    readKeys().map(async (key) => {
      try {
        const result = await withTimeout(
          ctx.rpc(ctx.IPC_ROUTES.settingsGet, { key }),
          3000,
          'settings read'
        )
        return [key, result ? result.value : undefined] as const
      } catch (_) {
        return [key, undefined] as const
      }
    })
  )
  return Object.fromEntries(pairs)
}

function deriveOption (settings: Record<string, unknown>): LayoutOption | null {
  const positions = LAYOUT_SETTING_KEYS.rowPosition
  const preset = matchLayoutPreset(
    {
      tabbar: settings[positions.tabbar],
      navbar: settings[positions.navbar],
      titlebar: settings[positions.titlebar],
      bookmarkbar: settings[positions.bookmarkbar]
    },
    Boolean(settings[LAYOUT_SETTING_KEYS.titlebarEnabled])
  )
  const compact = settings[LAYOUT_SETTING_KEYS.mode] === 'compact'
  const id = preset === 'classic' && compact ? 'compact' : preset
  return OPTIONS.find((option) => option.id === id) || null
}

function writesFor (option: LayoutOption): [string, unknown][] {
  return [
    ...layoutPresetWrites(option.preset),
    [LAYOUT_SETTING_KEYS.preset, option.preset],
    [LAYOUT_SETTING_KEYS.mode, option.mode]
  ]
}

async function write (ctx: OnboardingContext, entries: Iterable<[string, unknown]>): Promise<void> {
  for (const [key, value] of entries) {
    if (value === undefined) continue
    const result = await withTimeout(
      ctx.rpc(ctx.IPC_ROUTES.settingsSet, { key, value }),
      4000,
      'settings write'
    )
    if (!result || result.ok === false) throw new Error(`Failed to write ${key}`)
  }
}

function buildCard (ctx: OnboardingContext, option: LayoutOption, active: boolean): HTMLButtonElement {
  const card = ctx.el('button', 'oobe-choice oobe-choice--media') as HTMLButtonElement
  card.type = 'button'
  card.dataset.id = option.id
  card.setAttribute('aria-pressed', active ? 'true' : 'false')
  card.setAttribute('aria-label', `使用${option.label}布局`)
  if (active) card.classList.add('is-active')

  const body = ctx.el('span', 'oobe-choice-body')
  const head = ctx.el('span', 'oobe-choice-head')
  head.appendChild(ctx.el('span', 'oobe-choice-name', option.label))
  body.appendChild(head)

  card.append(buildWire(ctx, option.id), body)
  return card
}

function buildWire (ctx: OnboardingContext, id: string): HTMLElement {
  const spec = PREVIEW_SPECS[id] || PREVIEW_SPECS.classic
  const wire = ctx.el('span', 'oobe-wire')

  const top = ctx.el('span', 'oobe-wire-top')
  for (const row of spec.rows) {
    const line = ctx.el('span', 'oobe-wire-row')
    for (const kind of row) line.appendChild(ctx.el('i', `oobe-wire-bar is-${kind}`))
    top.appendChild(line)
  }
  wire.appendChild(top)

  if (spec.side.length) {
    const side = ctx.el('span', 'oobe-wire-side')
    for (const kind of spec.side) side.appendChild(ctx.el('i', `oobe-wire-bar is-${kind}`))
    wire.appendChild(side)
  }

  wire.appendChild(ctx.el('span', 'oobe-wire-body'))
  return wire
}

function syncSelection (grid: HTMLElement, activeId: string): void {
  Array.from(grid.querySelectorAll<HTMLElement>('.oobe-choice')).forEach((card) => {
    const on = card.dataset.id === activeId
    card.classList.toggle('is-active', on)
    card.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

async function select (
  ctx: OnboardingContext,
  view: LayoutView,
  option: LayoutOption,
  card: HTMLButtonElement
): Promise<void> {
  if (option.id === view.activeId) return
  const previousId = view.activeId
  const previousDraft = ctx.draft.layout

  await ctx.runExclusive(async () => {
    view.activeId = option.id
    ctx.draft.layout = { id: option.id, label: option.label, preset: option.preset, mode: option.mode }
    if (card.parentElement) syncSelection(card.parentElement as HTMLElement, option.id)

    try {
      const entries = writesFor(option)
      await write(ctx, entries)
      for (const [key, value] of entries) view.snapshot[key] = value
    } catch (e) {
      await write(ctx, Object.entries(view.snapshot)).catch(() => {})
      if (view.disposed) return
      view.activeId = previousId
      ctx.draft.layout = previousDraft
      if (card.parentElement) syncSelection(card.parentElement as HTMLElement, previousId)
      ctx.toast('布局写入失败，已恢复原布局')
    }
  })
}

export default layout
