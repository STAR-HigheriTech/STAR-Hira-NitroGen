/**
 * 阶段 1 · 欢迎 + 来源选择
 *
 * 这一步唯一的实质决定是「你从哪来」：
 *   · 其它浏览器 → 直接进设置流程（外观 / 布局 / 启动…）；
 *   · Hira Min   → 先多走一步迁移向导（见 stages/migrate）。
 *
 * 选择只改 `ctx.draft.source` 并调用 `ctx.enterFlow()`（壳据此重排进度点），
 * 本阶段不认识任何后续步骤 —— 加一步、减一步都在 stages/index.js 的 ORDER 里做。
 * 不写任何设置：来源是一次会话内的路线，不是需要落盘的偏好。
 */

import { USER_SOURCES } from './user-source.js'
import type { OnboardingContext, OnboardingStage } from './types.js'

const PATHS = Object.freeze([
  {
    id: USER_SOURCES.OTHER,
    name: '我从其它浏览器来',
    tag: '第一次使用',
    description: '依次选择外观、布局和启动方式。'
  },
  {
    id: USER_SOURCES.MIN,
    name: '我是 Hira Min 用户',
    tag: '升级迁移',
    description: '先带上旧数据，再完成新版本设置。'
  }
])

const welcome: OnboardingStage = {
  id: 'welcome',
  label: '欢迎',
  nextLabel: '开始设置',
  hint: '选一个来源后按 Enter 继续',

  mount (ctx: OnboardingContext) {
    const root = ctx.el('section', 'oobe-welcome')

    const icon = ctx.el('img', 'oobe-welcome-icon') as HTMLImageElement
    icon.src = 'hira://shared/app-icon.png'
    icon.alt = ''
    icon.width = 76
    icon.height = 76

    const title = ctx.el('h1', 'oobe-title', '欢迎使用 Hira')
    const subtitle = ctx.el('p', 'oobe-sub', '先告诉我们从哪里来，之后的设置会按你的情况展开。')

    const paths = ctx.el('div', 'oobe-paths')
    for (const path of PATHS) {
      paths.appendChild(buildPath(ctx, path))
    }

    root.append(icon, title, subtitle, paths)

    paint(root, ctx.draft.source)
    return root
  },

  /** 没点过任何卡片就继续 = 按「其它浏览器」走（最不需要额外步骤的那条路）。 */
  onNext (ctx: OnboardingContext) {
    ctx.enterFlow(ctx.draft.source || ctx.sources.OTHER)
  }
}

export default welcome

function buildPath (ctx: OnboardingContext, path: (typeof PATHS)[number]): HTMLElement {
  const card = ctx.el('button', 'oobe-choice') as HTMLButtonElement
  card.type = 'button'
  card.dataset.id = path.id

  const head = ctx.el('span', 'oobe-choice-head')
  head.appendChild(ctx.el('span', 'oobe-choice-name', path.name))
  head.appendChild(ctx.el('span', 'badge', path.tag))

  const body = ctx.el('span', 'oobe-choice-body')
  body.append(head, ctx.el('span', 'oobe-choice-desc', path.description))

  const mark = ctx.el('span', 'oobe-choice-mark')
  mark.setAttribute('aria-hidden', 'true')
  card.append(body, mark)
  card.addEventListener('click', () => {
    ctx.draft.source = path.id
    ctx.enterFlow(path.id)
    paint(card.parentElement, path.id)
    ctx.focusPrimary()
  })
  return card
}

function paint (root: HTMLElement | null, activeId: string): void {
  if (!root) return
  Array.from(root.querySelectorAll<HTMLElement>('.oobe-choice')).forEach((card) => {
    const on = card.dataset.id === activeId
    card.classList.toggle('is-active', on)
    card.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}
