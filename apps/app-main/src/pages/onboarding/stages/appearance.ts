/**
 * 阶段 · 外观
 *
 * 点击卡片立即写入，且同一时间只接受一次写入。所有异步结果都绑定本次
 * mount；离开后再返回时重新读取真实主题，不依赖模块级单例状态。
 */

import { themeModeLabel } from 'hira://shared/theme.mjs'
import { errorMessage } from 'hira://shared/page-kit.js'
import { withTimeout } from './async.js'
import type { OnboardingContext, OnboardingStage, OnboardingStageView } from './types.js'

interface ThemeRecord {
  id: string
  name?: string
  mode?: string
  swatch?: Record<string, string>
}

interface ThemeCatalog {
  themes?: ThemeRecord[]
  activeId?: string
}

interface AppearanceView extends OnboardingStageView {
  disposed: boolean
  activeId: string
}

const appearance: OnboardingStage = {
  id: 'appearance',
  label: '外观',
  hint: '点击即生效，之后可在「设置 → 外观」更换',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', '挑一个顺眼的配色'))
    root.appendChild(ctx.el('p', 'oobe-sub', '先在当前窗口预览，选择会立即保存。'))

    const grid = ctx.el('div', 'oobe-themes')
    grid.appendChild(ctx.el('p', 'notice', '正在读取主题…'))
    root.appendChild(grid)

    let ready: Promise<void> = Promise.resolve()
    const view: AppearanceView = {
      el: root,
      disposed: false,
      activeId: '',
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

async function load (ctx: OnboardingContext, view: AppearanceView, grid: HTMLElement): Promise<void> {
  let catalog: ThemeCatalog | null = null
  try {
    catalog = await withTimeout(ctx.rpc<ThemeCatalog>(ctx.IPC_ROUTES.themeList), 4000, 'theme list')
  } catch (error) {
    console.warn('[onboarding] 主题清单读取失败:', errorMessage(error))
  }
  if (view.disposed) return

  const themes: ThemeRecord[] = catalog && Array.isArray(catalog.themes)
    ? catalog.themes.filter((theme: ThemeRecord) => theme && theme.id)
    : []
  if (!themes.length) {
    grid.textContent = ''
    grid.appendChild(ctx.el('p', 'notice', '暂时没有可用的主题，直接继续即可。'))
    return
  }

  const activeId = String((catalog && catalog.activeId) || '')
  view.activeId = activeId
  ctx.draft.themeId = activeId
  ctx.draft.themeName = themes.find((theme) => theme.id === activeId)?.name || ''

  grid.textContent = ''
  for (const theme of themes) {
    const card = buildCard(ctx, theme, theme.id === activeId)
    card.addEventListener('click', () => void select(ctx, view, theme, card))
    grid.appendChild(card)
  }
  syncSelection(grid, activeId)
}

function buildCard (ctx: OnboardingContext, theme: ThemeRecord, active: boolean): HTMLButtonElement {
  const card = ctx.el('button', 'oobe-choice oobe-choice--media') as HTMLButtonElement
  card.type = 'button'
  card.dataset.id = theme.id
  card.setAttribute('aria-pressed', active ? 'true' : 'false')
  card.setAttribute('aria-label', `使用 ${theme.name || theme.id} 主题`)
  if (active) card.classList.add('is-active')

  const bar = ctx.el('span', 'oobe-theme-bar')
  const swatch = theme.swatch || {}
  for (const key of ['bg', 'surface', 'accent', 'fg']) {
    const chip = ctx.el('i')
    chip.style.backgroundColor = swatch[key] || 'transparent'
    bar.appendChild(chip)
  }

  const body = ctx.el('span', 'oobe-choice-body')
  const head = ctx.el('span', 'oobe-choice-head')
  head.appendChild(ctx.el('span', 'oobe-choice-name', theme.name || theme.id))
  head.appendChild(ctx.el('span', 'oobe-choice-meta', themeModeLabel(theme.mode || 'system')))
  body.appendChild(head)
  card.append(bar, body)
  return card
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
  view: AppearanceView,
  theme: ThemeRecord,
  card: HTMLButtonElement
): Promise<void> {
  if (theme.id === view.activeId) return
  const previousId = view.activeId
  const previousName = ctx.draft.themeName

  await ctx.runExclusive(async () => {
    view.activeId = theme.id
    ctx.draft.themeId = theme.id
    ctx.draft.themeName = theme.name || theme.id
    const grid = card.parentElement
    if (grid) syncSelection(grid, theme.id)

    let result: { ok?: boolean } | null = null
    try {
      result = await withTimeout(
        ctx.rpc<{ ok?: boolean }>(ctx.IPC_ROUTES.themeSet, { id: theme.id }),
        5000,
        'theme write'
      )
    } catch {
      result = { ok: false }
    }
    if (result && result.ok !== false) return
    if (view.disposed) return

    view.activeId = previousId
    ctx.draft.themeId = previousId
    ctx.draft.themeName = previousName
    if (grid) syncSelection(grid, previousId)
    ctx.toast('主题切换失败，请稍后重试')
  })
}

export default appearance
