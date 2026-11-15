/**
 * 分区切换器 = 顶部小选项卡（Vivaldi 起始页导航条那种）+ 分区旁边的动作栏
 * + 分区的挂载 / 显隐。
 *
 * 为什么这些事放在一个模块里：选项卡的"选中项"、"当前分区"、
 * 以及"动作项该不该出现"是**同一份状态**的三个投影，拆开只会多出几层同步。
 * 对外只暴露 `activate(id)` 与 `addAction`（后者只给分区用，见 ctx.tabbar）。
 *
 * 分区的挂载策略：**首次进入才下载 + 挂载，挂载后常驻**。
 *   · 不在启动时全部下载 —— 没点开的分区连它的模块都不取（新闻页代价不小）；
 *   · 挂载后不销毁 —— 切回来时滚动位置、已加载的列表、组件内部状态都还在。
 * 这条是"流畅"的关键：切分区不该有任何重建与重新请求。
 */
import { getSection, listSections, ensureSection } from './registry.js'
import { activeSectionId, setActiveSectionId } from './store.js'
import type {
  DeclaredSection,
  SectionAction,
  SectionActionSpec,
  SectionContext,
  SectionLifecycle
} from './types.js'

interface MountedSection {
  id: string
  root: HTMLElement
  api: SectionLifecycle
}

interface ActionEntry {
  el: HTMLButtonElement
  selfHidden: boolean
  active: boolean
}

const mounted = new Map<string, MountedSection>()
let current = ''
/** 切换序号：懒加载期间用户又切走时，用它丢弃过期的挂载结果。 */
let activationSeq = 0

export function createSectionSwitcher({
  stripHost,
  viewsHost,
  openUrl
}: {
  stripHost: HTMLElement
  viewsHost: HTMLElement
  openUrl: SectionContext['openUrl']
}) {
  const defs = listSections()
  const tabs = new Map<string, HTMLButtonElement>()

  /**
   * 分区注册的**动作项**。key = 分区 id。
   * 动作项不是分区：点了不切页，只是"借住"在选项卡栏**旁边**的一颗小药丸里。
   * 归属规则：**只有归属分区处于激活态时才出现** ——
   * 于是"自定义"只待在首页，切到推广 / 新闻时自动隐去，
   * 调用方不需要自己盯着显隐（那正是"这里一个规则、那里一个变化"的开端）。
   */
  const actionsOf = new Map<string, ActionEntry[]>()

  /**
   * 动作项的宿主：**独立的一颗小药丸**，紧挨在选项卡条右侧 ——
   * 刻意**不复用** `.ntp__sections`：动作项不是分区，和选项卡连成一长条会让人以为
   * 它也是个分区（用户反馈"要单独一个小的"）。材质仍走 §1 那条统一材质，
   * 所以它看起来与选项卡是**同一族**、但彼此分开。
   *
   * 由本模块自建并插在自己后面：外壳（index.html）不需要知道"选项卡栏旁边还有一颗药丸"，
   * 分区也不需要知道 —— 它们只调 `ctx.tabbar.addAction()`。
   */
  const actionsHost = document.createElement('nav')
  actionsHost.className = 'ntp__actions'
  actionsHost.setAttribute('aria-label', '起始页操作')
  actionsHost.hidden = true
  stripHost.insertAdjacentElement('afterend', actionsHost)

  for (const def of defs) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'ntp-tab'
    tab.id = `ntp-tab-${def.id}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', `ntp-view-${def.id}`)
    tab.setAttribute('aria-selected', 'false')
    tab.textContent = def.name
    tab.addEventListener('click', () => activate(def.id))
    stripHost.appendChild(tab)
    tabs.set(def.id, tab)
  }

  /**
   * 往选项卡栏右侧那颗小药丸里加一个动作项（与选项卡同款 `.ntp-tab`）。
   */
  function addAction(ownerId: string, spec: SectionActionSpec): SectionAction {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ntp-tab'
    btn.id = `ntp-action-${spec.id}`
    btn.textContent = spec.label
    btn.addEventListener('click', () => {
      if (typeof spec.onClick === 'function') spec.onClick()
    })
    actionsHost.appendChild(btn)

    const entry = { el: btn, selfHidden: false, active: false }
    const list = actionsOf.get(ownerId) || []
    list.push(entry)
    actionsOf.set(ownerId, list)
    syncActions()

    return {
      el: btn,
      setLabel: (text: string) => {
        btn.textContent = text
      },
      /** 调用方自己的显隐（例如"添加组件"只在编辑态出现） */
      setHidden: (hidden: boolean) => {
        entry.selfHidden = !!hidden
        syncActions()
      },
      /** 视觉上的"正在进行"（编辑态），复用选项卡的选中样式 */
      setActive: (on: boolean) => btn.classList.toggle('is-active', on),
      remove: () => {
        const arr = actionsOf.get(ownerId)
        if (arr) {
          const at = arr.indexOf(entry)
          if (at >= 0) arr.splice(at, 1)
        }
        btn.remove()
        syncActions()
      }
    }
  }

  /**
   * 动作项的显隐 = 归属分区激活 **且** 调用方没让自己隐藏；
   * 一个可见的都没有时，连**整颗药丸**一起收起（不留空气泡占位）。
   */
  function syncActions() {
    let anyVisible = false
    for (const [ownerId, list] of actionsOf) {
      for (const a of list) {
        a.active = ownerId === current
        a.el.hidden = !a.active || a.selfHidden
        if (!a.el.hidden) anyVisible = true
      }
    }
    actionsHost.hidden = !anyVisible
  }

  // 左右方向键在选项卡之间移动（tablist 的标准行为，也顺手做完了键盘可达）
  stripHost.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const ids = listSections().map((d) => d.id)
    const at = ids.indexOf(current)
    if (at < 0) return
    const step = e.key === 'ArrowRight' ? 1 : ids.length - 1
    const next = ids[(at + step) % ids.length]
    activate(next)
    const tab = tabs.get(next)
    if (tab) tab.focus()
    e.preventDefault()
  })

  /**
   * 懒加载分区：先确保模块到位（`ensureSection` 里跑 dynamic import），再挂载。
   * 模块没下载完时先返回 null，由 activate 的序号守卫丢弃过期结果。
   */
  async function mountSection(id: string): Promise<MountedSection | null> {
    let def: DeclaredSection | null = null
    try {
      def = await ensureSection(id)
    } catch (e) {
      console.error(`[ntp] 分区 ${id} 加载失败`, e)
    }
    if (!def || typeof def.mount !== 'function') return null

    const root = document.createElement('div')
    root.className = 'ntp__view'
    root.id = `ntp-view-${id}`
    root.setAttribute('role', 'tabpanel')
    root.setAttribute('aria-labelledby', `ntp-tab-${id}`)
    // 刻意**不设 hidden**：此时调用方已经让其他分区让位了，所以它是可见的。
    // 必须可见再挂载 —— 分区里的东西（看板）要在挂载瞬间量真实宽度，
    // 量到 0 就会先按最窄断点排一遍版，之后才被 ResizeObserver 纠正，肉眼可见错位。
    viewsHost.appendChild(root)

    const api =
      def.mount({
        root,
        openUrl,
        isActive: () => current === id,
        // 分区往选项卡栏加动作项的唯一入口（见 addAction）
        tabbar: { addAction: (spec: SectionActionSpec) => addAction(id, spec) }
      }) || {}

    const entry = { id, root, api }
    mounted.set(id, entry)
    return entry
  }

  /** 选项卡视觉（选中态 / roving tabindex），与"分区是否已挂载"无关。 */
  function syncTabs(id: string): void {
    for (const [tabId, tab] of tabs) {
      const on = tabId === id
      tab.classList.toggle('is-active', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
      // roving tabindex：只有选中项可 Tab 聚焦，组内用左右键移动
      tab.tabIndex = on ? 0 : -1
    }
  }

  /**
   * 切换分区。
   * 关键点：**选项卡视觉立即切换**（不等懒加载），内容在模块到位后再露面；
   * 快速连点时用序号守卫丢弃过期的挂载结果，绝不会把旧分区画回来。
   */
  async function activate(id: string): Promise<void> {
    if (!getSection(id) || current === id) return

    const prev = mounted.get(current)
    if (prev && typeof prev.api.onHide === 'function') prev.api.onHide()

    // 顺序要紧：**先让旧分区让位，再挂新分区**。
    // 反过来的话新分区会在 display:none（宽度 0）状态下挂载，
    // 首帧按最窄断点排一遍版，然后才被 ResizeObserver 纠正 —— 看得见的错位闪动。
    current = id
    const seq = ++activationSeq
    syncTabs(id)
    for (const entry of mounted.values()) entry.root.hidden = true
    // 动作项先按新归属同步一次（已挂载的分区立即正确；懒加载的那个挂载后再同步）
    syncActions()

    let entry: MountedSection | null = mounted.get(id) || null
    if (!entry) entry = await mountSection(id)
    // 期间用户又切走了：这次结果作废（模块已被缓存，下次进入即时命中）。
    // 已经 append 的 root 必须自己收起来，否则它会和当前分区叠在一起。
    if (seq !== activationSeq) {
      if (entry) entry.root.hidden = true
      return
    }
    if (!entry) return
    entry.root.hidden = false

    syncActions()
    setActiveSectionId(id)

    if (typeof entry.api.onShow === 'function') entry.api.onShow()
  }

  // 启动：优先回到上次停留的分区。存的那个 id 可能已经不存在了
  // （分区被删或改名），那就回到第一个 —— 不因为一条陈旧记录让页面空着。
  const saved = activeSectionId()
  const first = getSection(saved) ? saved : defs.length ? defs[0].id : ''
  if (first) void activate(first)

  return {
    activate,
    current: () => current
  }
}
