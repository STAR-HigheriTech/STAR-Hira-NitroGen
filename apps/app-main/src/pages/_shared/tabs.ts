/**
 * 内部页 · 分段选项卡（tab）控制器
 *
 * 一份实现，所有内部页共用：页面只写结构，**不写"选中态长什么样"**。
 * 视觉（软底槽 + 选中项浮起）全部来自 base.css 的 `.segmented`，
 * 这里只负责三件事：切 `.btn-primary`、写 `aria-selected`、切 `[hidden]`。
 *
 * HTML 约定：
 *   <div class="segmented" id="tabs" role="tablist">
 *     <button class="btn btn-primary" role="tab" data-tab="sites">…</button>
 *     <button class="btn" role="tab" data-tab="backends">…</button>
 *   </div>
 *   <section data-panel="sites">…</section>
 *   <section data-panel="backends" hidden>…</section>
 *
 * 用法：
 *   import { mountTabs } from 'hira://shared/tabs.js'
 *   const tabs = mountTabs(bar, document.querySelectorAll('[data-panel]'), {
 *     initial: 'sites',
 *     onChange: (name) => { … }   // 需要按需加载时才用；纯本地切换可省略
 *   })
 *   tabs.select('audit')
 *
 * 键盘：← / → 在选项卡之间移动（与原生 tablist 一致），Home / End 跳到首尾。
 * 面板在切换时**不重建 DOM** —— 页面渲染过一次就留着，来回切不会闪。
 */

/**
 * @param {HTMLElement} bar                    选项卡条（含 [data-tab] 按钮）
 * @param {Iterable<HTMLElement>} panels       面板集合（每个带 [data-panel]）
 * @param {{ initial?: string, onChange?: (name: string) => void }} [options]
 * @returns {{ select: (name: string, opts?: { silent?: boolean, focus?: boolean }) => string, readonly current: string }}
 */
interface MountTabsOptions {
  initial?: string
  onChange?: (name: string) => void
}

export interface TabsController {
  select(name: string, opts?: { silent?: boolean; focus?: boolean }): string
  readonly current: string
}

export function mountTabs (
  bar: HTMLElement,
  panels: Iterable<HTMLElement>,
  options: MountTabsOptions = {}
): TabsController {
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-tab]'))
  const panelsByName = new Map<string, HTMLElement>()
  for (const panel of panels) {
    const name = panel && panel.dataset ? panel.dataset.panel : ''
    if (name) panelsByName.set(name, panel)
  }

  let current = ''

  const select = (name: string, { silent = false, focus = false }: { silent?: boolean; focus?: boolean } = {}): string => {
    if (!panelsByName.has(name)) return current
    current = name
    for (const btn of buttons) {
      const active = btn.dataset.tab === name
      btn.classList.toggle('btn-primary', active)
      btn.setAttribute('aria-selected', String(active))
      // 只有当前 tab 留在 Tab 键序列里，其余用方向键访问（roving tabindex）
      btn.tabIndex = active ? 0 : -1
      if (active && focus) btn.focus()
    }
    for (const [key, panel] of panelsByName) panel.hidden = key !== name
    if (!silent && typeof options.onChange === 'function') options.onChange(name)
    return current
  }

  bar.addEventListener('click', (event) => {
    const target = event.target
    const btn = target instanceof Element ? target.closest<HTMLButtonElement>('[data-tab]') : null
    if (btn && bar.contains(btn) && btn.dataset.tab) select(btn.dataset.tab)
  })

  bar.addEventListener('keydown', (event: KeyboardEvent) => {
    const last = buttons.length - 1
    if (last < 0) return
    const index = buttons.findIndex((btn) => btn.dataset.tab === current)

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      const button = buttons[(index + step + buttons.length) % buttons.length]
      if (button.dataset.tab) select(button.dataset.tab, { focus: true })
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const button = buttons[event.key === 'Home' ? 0 : last]
      if (button.dataset.tab) select(button.dataset.tab, { focus: true })
    }
  })

  const initial = options.initial || buttons[0]?.dataset.tab
  if (initial) select(initial, { silent: true })

  return {
    select,
    get current () {
      return current
    }
  }
}
