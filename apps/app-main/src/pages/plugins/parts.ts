// @ts-check
/**
 * 叶子 DOM 原子 —— 拼出「一个插件长什么样」的那些小块。
 *
 * 这里不认识 IPC、不认识控制器：拿到什么数据画什么，动作全部通过
 * `data-plugin-*` 属性向上冒泡，由视图的委托统一翻译成意图（见 core.ts）。
 *
 * 开关直接用 base.css 的 `.switch`（与扩展页 / 设置页同一颗），
 * 不再自带一份 —— 同一颗开关在三个页面里长得不一样是本页最不该出现的事。
 */
import { el } from 'hira://shared/runtime.js'
import { toggleButton } from './controls.js'
import { TYPE_ORDER, groupByType, relationLines, stateNotice, switchState, typeMeta } from './format.js'
import type { PluginRecord } from './types.js'

type PluginIndex = Map<string, PluginRecord>

/**
 * 拨动开关。原生 button，无图片无字体依赖，仅靠颜色/位移表达状态。
 *
 * 当前态写在 `aria-checked` 上 —— 委托人因此不必回查 items 数组
 * （也就不会与渲染时序打架）：翻转 = 取反那个属性。
 *
 * @param {unknown} plugin
 */
export function buildSwitch(plugin: PluginRecord): HTMLButtonElement {
  const { locked, title } = switchState(plugin)
  return toggleButton({
    checked: plugin.enabled === true,
    disabled: locked,
    title,
    attributes: {
      'data-plugin-switch': '1',
      'data-plugin-id': plugin.id
    }
  })
}

/**
 * 依赖关系（数据来自 format.ts#relationLines，这里只负责画）。
 *
 * @param {unknown} plugin
 * @param {Map<string, unknown>} index
 * @returns {HTMLElement | null} 没有关系时返回 null（不占位）
 */
export function buildRelations(plugin: PluginRecord, index: PluginIndex) : HTMLElement | null {
  const lines = relationLines(plugin, index)
  if (!lines.length) return null
  const relations = el('div', 'plugins-page__relations')
  for (const line of lines) {
    const row = el('div', 'plugins-page__relation')
    row.setAttribute('data-kind', line.kind)
    const tag = el('span', 'plugins-page__relation-tag', line.label)
    const value = el('span', 'plugins-page__relation-value', line.text)
    value.title = line.text
    if (line.emphasis) value.setAttribute('data-emphasis', 'true')
    row.append(tag, value)
    relations.appendChild(row)
  }
  return relations
}

/**
 * 「等用户授权」块（第 6 态）—— 逐条列出它想干什么。
 *
 * 用中文名而不是 `history:read` 这种标识：用户唯一能做的判断就是
 * 「我愿不愿意让它读我的浏览历史」。只给一个「同意」按钮而不说同意什么，
 * 那是把责任推给用户却不给信息。
 *
 * 两个按钮 → 两种意图。**拒绝也要给得出**：不然用户只有「同意」一条路，
 * 那不叫授权，叫通知。
 *
 * @param {unknown} plugin
 * @param {string[]} scopes
 */
export function buildConsent(plugin: PluginRecord, scopes: string[] = []): HTMLElement {
  const labels = plugin.requestedPermissionLabels || {}
  const consent = el('div', 'plugins-page__consent')
  const title = el('div', 'plugins-page__consent-title', '该插件申请以下权限，需要你确认后才会启用：')
  const list = el('ul', 'plugins-page__consent-list')
  for (const scope of scopes) {
    const li = el('li', '', `${labels[scope] || scope}（${scope}）`)
    list.appendChild(li)
  }
  const actions = el('div', 'plugins-page__consent-actions')
  const grantBtn = el('button', 'plugins-page__consent-btn', '同意并启用')
  grantBtn.setAttribute('type', 'button')
  grantBtn.setAttribute('data-kind', 'grant')
  grantBtn.setAttribute('data-plugin-grant', plugin.id)
  // scopes 挂在按钮上（而不是让编排层回查清单）：点击时列表大概率已被刷新重建，
  // 而「用户点的那一刻看到的是哪一份清单」才是他要同意的对象。
  grantBtn.setAttribute('data-plugin-scopes', JSON.stringify(scopes))
  const denyBtn = el('button', 'plugins-page__consent-btn', '暂不')
  denyBtn.setAttribute('type', 'button')
  denyBtn.setAttribute('data-kind', 'deny')
  denyBtn.setAttribute('data-plugin-deny', plugin.id)
  actions.append(grantBtn, denyBtn)
  consent.append(title, list, actions)
  return consent
}

/**
 * 一个插件的**主体**（左侧那一列）：名称 / 版本 / 描述 / id / 来源徽章 /
 * 依赖关系 / 不可禁用理由 / 五态提示。
 *
 * @param {unknown} plugin
 * @param {Map<string, unknown>} index
 */
export function buildRowMain(plugin: PluginRecord, index: PluginIndex): HTMLElement {
  const main = el('div', 'plugins-page__row-main')

  const titleLine = el('div', 'plugins-page__title-line')
  const name = el('span', 'plugins-page__name', plugin.name || plugin.id)
  name.title = plugin.name || plugin.id
  const version = el('span', 'plugins-page__version', `v${plugin.version}`)
  titleLine.append(name, version)
  main.appendChild(titleLine)

  if (plugin.description) {
    main.appendChild(el('div', 'plugins-page__desc', plugin.description))
  }

  // 元信息行只留 id。依赖关系走下面专列 —— 那里能显示中文名、能分硬/软、能给双向，
  // 挤在这一行里既看不清也没法解释「为什么关不掉」。
  const meta = el('div', 'plugins-page__meta', plugin.id)
  meta.title = plugin.id
  main.appendChild(meta)

  /**
   * 「已安装」标记 —— 这个插件来自**用户插件目录**（运行时安装的第三方插件），
   * 而不是随应用分发的内置插件。
   *
   * 为什么必须区分：两者的**信任级与后果完全不同**（第三方走沙箱、要授权、
   * 卸载应用时不会被清掉）。用户在排查「这个插件哪来的 / 为什么它要权限」时，
   * 第一眼就要能分辨 —— 混在一列里只能靠记忆 id 是对用户的负担。
   */
  if (plugin.runtime) {
    const badge = el('span', 'plugins-page__badge', '已安装')
    badge.title = '来自用户插件目录（运行时安装，非随应用分发）'
    main.appendChild(badge)
  }

  if (Array.isArray(plugin.pages) && plugin.pages.length) {
    const pagesBadge = el('span', 'plugins-page__badge', `${plugin.pages.length} 个页面`)
    pagesBadge.title = '这个插件贡献的内部页，可在「插件页面」板块中打开'
    main.appendChild(pagesBadge)
  }

  const relations = buildRelations(plugin, index)
  if (relations) main.appendChild(relations)

  /**
   * **不可禁用（唯一出口类）**：开关是灰的，必须说明为什么。
   *
   * 一个灰掉的开关如果不给理由，用户会以为「界面坏了」或「我的权限不够」，
   * 然后反复点它 —— 而真实原因是**设计如此**（关掉它就没有回头路）。
   *
   * `core` 不在这里重复说明：它的分组标签已经写着「不可禁用」。
   */
  if (plugin.nonDisableable && plugin.trustLevel !== 'core') {
    const lockedNote = el('div', 'plugins-page__meta', '此插件不可禁用：关掉它之后再没有界面入口能把它打开')
    lockedNote.title = lockedNote.textContent
    main.appendChild(lockedNote)
  }

  const notice = stateNotice(plugin, index)
  if (notice) {
    if (notice.kind === 'consent') {
      main.appendChild(buildConsent(plugin, notice.scopes))
    } else {
      const MODIFIER: Record<string, string> = {
        failed: 'plugins-page__error',
        autoDisabled: 'plugins-page__warning',
        blocked: 'plugins-page__blocked',
        health: 'plugins-page__warning'
      }
      const line = el('div', MODIFIER[notice.kind] || 'plugins-page__warning', notice.text)
      line.title = notice.text
      main.appendChild(line)
    }
  }

  const technical = buildTechnicalDetails(plugin, index)
  if (technical) main.appendChild(technical)

  return main
}

function buildTechnicalDetails(plugin: PluginRecord, index: PluginIndex): HTMLElement | null {
  const rows: Array<[string, string]> = []
  if (plugin.type) rows.push(['类型', String(plugin.type)])
  if (plugin.trustLevel) rows.push(['信任级别', String(plugin.trustLevel)])
  if (plugin.permissionLevel) rows.push(['权限级别', String(plugin.permissionLevel)])
  if (plugin.main) rows.push(['主进程入口', String(plugin.main)])
  if (plugin.render) rows.push(['渲染入口', String(plugin.render)])

  const capabilities = Array.isArray(plugin.capabilities) ? plugin.capabilities.map(String) : []
  const requested = Array.isArray(plugin.requestedPermissions) ? plugin.requestedPermissions.map(String) : []
  const granted = Array.isArray(plugin.grantedPermissions) ? plugin.grantedPermissions.map(String) : []
  const conflicts = Array.isArray(plugin.conflictsWith) ? plugin.conflictsWith.map((id) => {
    const hit = index?.get(id)
    return hit ? (hit.name || hit.id) : id
  }) : []
  const pageEntries = Array.isArray(plugin.pages) ? plugin.pages : []
  const pages = pageEntries.map((page) => String(page.title || page.id || '')).filter(Boolean)
  const panels = Array.isArray(plugin.panelUi)
    ? plugin.panelUi.map((panel) => String(panel.title || panel.panelId || '')).filter(Boolean)
    : []
  const contributes = plugin.contributes && typeof plugin.contributes === 'object' ? plugin.contributes : {}

  if (!rows.length && !capabilities.length && !requested.length && !granted.length && !panels.length && !pages.length && !conflicts.length) return null
  const details = el('details', 'plugins-page__details')
  details.appendChild(el('summary', 'plugins-page__details-summary', '技术信息'))

  const grid = el('dl', 'plugins-page__details-grid')
  const add = (label: string, value: string) => {
    if (!value) return
    grid.append(el('dt', '', label), el('dd', '', value))
  }
  for (const [label, value] of rows) add(label, value)
  if (capabilities.length) add('能力面', capabilities.join('、'))
  if (requested.length) {
    const labels = plugin.requestedPermissionLabels || {}
    add('申请权限', requested.map((scope) => labels[scope] || scope).join('、'))
  }
  if (granted.length) add('已授权', granted.join('、'))
  if (panels.length) add('面板入口', panels.join('、'))
  if (pageEntries.length) {
    grid.append(el('dt', '', '内部页'))
    const pageActions = el('dd', 'plugins-page__details-pages')
    for (const page of pageEntries) {
      const button = el('button', 'btn-mini', String(page.title || page.id || '打开页面'))
      button.type = 'button'
      button.disabled = plugin.enabled !== true
      button.setAttribute('data-plugin-open-page', String(page.url || ''))
      button.setAttribute('data-plugin-page-owner', String(page.pluginId || plugin.id || ''))
      button.setAttribute('data-plugin-page-title', String(page.title || page.id || ''))
      pageActions.appendChild(button)
    }
    grid.appendChild(pageActions)
  }
  for (const [key, label] of [
    ['bangs', '搜索指令'],
    ['menus', '菜单项'],
    ['userscripts', '用户脚本'],
    ['themes', '主题'],
    ['skills', 'AI 技能'],
    ['commands', '命令'],
    ['overlays', '浮层']
  ]) {
    const count = Array.isArray(contributes[key]) ? contributes[key].length : 0
    if (count) add(label, `${count} 项`)
  }
  if (conflicts.length) add('冲突', conflicts.join('、'))
  details.appendChild(grid)
  return details
}

/**
 * 按 type 分组渲染整张列表。
 *
 * 分组标题下的 `__section-hint` **不是装饰**：`core` 那一段写着「不可禁用」，
 * 没有它用户只会看到一个点不动的开关，然后认为界面出了问题。
 *
 * @param {unknown[]} items
 * @param {(plugin: unknown, index: Map<string, unknown>) => HTMLElement} renderRow
 * @returns {{
 *   fragment: DocumentFragment,
 *   sections: { key: string, title: string, count: number, element: HTMLElement }[]
 * }}
 *   `sections` 把各分组的**标题元素**一并交出去 —— 调用方据此做「一键定位」
 *   （点一下滚到那一组）。交元素而不是让它回头 querySelector：后者等于把类名
 *   当成对外契约，类名一改就静默失效。
 */
export function buildGroupedList(
  items: PluginRecord[] = [],
  renderRow?: (plugin: PluginRecord, index: PluginIndex) => HTMLElement,
  relationItems: PluginRecord[] = items
) : {
  fragment: DocumentFragment,
  sections: { key: string, title: string, count: number, element: HTMLElement }[]
} {
  const frag = document.createDocumentFragment()
  /** @type {{ key: string, title: string, count: number, element: HTMLElement }[]} */
  const sections: { key: string, title: string, count: number, element: HTMLElement }[] = []
  // 关系渲染要把 id 还原成中文名（「谁依赖我」里可能出现在本组之外的插件），
  // 所以先建一次全量索引，随渲染函数传下去 —— 避免每个 row 各建一份。
  const index: PluginIndex = new Map(relationItems.map((plugin) => [plugin.id, plugin]))
  const groups = groupByType(items)
  const orderedTypes = [
    ...TYPE_ORDER.filter((type) => groups.has(type)),
    ...Array.from(groups.keys()).filter((type) => !TYPE_ORDER.includes(type)).sort()
  ]
  for (const type of orderedTypes) {
    const group = groups.get(type)
    if (!group || !group.length) continue
    const { title, hint } = typeMeta(type)
    const heading = el('div', 'plugins-page__section-title')
    heading.append(
      el('span', 'plugins-page__section-name', title),
      el('span', 'plugins-page__section-count', String(group.length)),
      el('span', 'plugins-page__section-hint', hint)
    )
    frag.appendChild(heading)
    sections.push({ key: type, title, count: group.length, element: heading })
    if (renderRow) for (const p of group) frag.appendChild(renderRow(p, index))
  }
  return { fragment: frag, sections }
}

/** 行内提示的显示/隐藏 —— 页面唯一的提示口径（不弹窗，就地说明）。 */
export function showNotice(notice: HTMLElement, text?: string, kind?: 'info' | 'error'): void {
  if (!text) {
    notice.hidden = true
    notice.textContent = ''
    return
  }
  notice.textContent = text
  notice.setAttribute('data-type', kind === 'error' ? 'error' : 'info')
  notice.hidden = false
}
