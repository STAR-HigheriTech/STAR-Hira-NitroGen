import {
  IPC_EVENTS,
  rpc,
  el,
  initTheme,
  renderEmpty,
  spaceIconSvg,
  uiIconSvg,
  resolveSpaceIconId,
  SPACE_ICON_NAMES,
  DEFAULT_SPACE_ICON,
  subscribe
} from 'hira://shared/runtime.js'
import type { PageRpcRecord } from 'hira://shared/runtime.js'

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

/** 预设配色（成对使用，渲染为 135° 渐变，与空间切换器同一套 --space-accent-* 语义）。 */
const PALETTES = [
  { start: '', end: '' },                                   // 默认（跟随主题）
  { start: '#6366f1', end: '#8b5cf6' },                     // 靛紫
  { start: '#0ea5e9', end: '#22d3ee' },                     // 天青
  { start: '#10b981', end: '#34d399' },                     // 翡翠
  { start: '#f59e0b', end: '#fbbf24' },                     // 琥珀
  { start: '#ef4444', end: '#f87171' },                     // 珊瑚
  { start: '#ec4899', end: '#f472b6' },                     // 品红
  { start: '#64748b', end: '#94a3b8' }                      // 石墨
]

interface SpaceRecord extends PageRpcRecord {
  id: string
  profileId: string
  name?: string
  icon?: string
  color?: string
  bgStartColor?: string
  bgEndColor?: string
  isActive?: boolean
}

interface ProfileRecord extends PageRpcRecord {
  id: string
  name?: string
  color?: string
  isActive?: boolean
}

interface DragSource { profileId: string; spaceId: string }

function requiredElement<T>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Spaces page element #${id} is unavailable`)
  return element as unknown as T
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** 拖拽排序期间记住被拖的 { profileId, spaceId }（跨重渲染也不丢）。 */
let dragSource: DragSource | null = null

// ─────────────────────────────────────────────────────────────────────────────
// 通用原子
// ─────────────────────────────────────────────────────────────────────────────

/** 空间配色 → CSS 渐变（无色返回空串，交给 CSS 兜底）。 */
function gradientOf (space: SpaceRecord | null | undefined): string {
  const start = space && space.bgStartColor ? space.bgStartColor : ''
  const end = space && space.bgEndColor ? space.bgEndColor : start
  if (!start) return ''
  return `linear-gradient(135deg, ${start}, ${end || start})`
}

/**
 * 空间图标方块：有色 → 渐变底 + 反白图标；无色 → 中性底 + 常规前景。
 * 图标与 navbar 同族（hira://shared/icons.js），不是 unicode 字符。
 */
function buildIconTile (space: SpaceRecord): HTMLElement {
  const tile = el('div', 'swatch')
  const gradient = gradientOf(space)
  if (gradient) {
    tile.style.background = gradient
    tile.classList.add('swatch--colored')
  }
  const icon = spaceIconSvg(document, space.icon || DEFAULT_SPACE_ICON, { size: 16 })
  if (icon) tile.appendChild(icon)
  return tile
}

/** 图标按钮（统一 SVG，无 unicode 字符）。 */
function iconButton (icon: string, title: string, onClick: () => unknown, { danger = false, size = 16 }: { danger?: boolean; size?: number } = {}): HTMLButtonElement {
  const button = el('button', 'icon-btn' + (danger ? ' danger' : ''))
  button.type = 'button'
  button.title = title
  const svg = uiIconSvg(document, icon, { size })
  if (svg) button.appendChild(svg)
  button.onclick = onClick
  return button
}

/** 带图标 + 文案的按钮（次要动作，如「进入」「使用」）。 */
function textButton (label: string, icon: string, className = 'btn btn-sm'): HTMLButtonElement {
  const button = el('button', className)
  button.type = 'button'
  const svg = uiIconSvg(document, icon, { size: 14 })
  if (svg) button.appendChild(svg)
  button.appendChild(el('span', undefined, label))
  return button
}

/** 颜色选择器（编辑器 / 创建器共用）。 */
function buildPalette (selected: string, onPick: (item: { start: string; end: string }) => void): HTMLElement {
  const palette = el('div', 'palette')
  PALETTES.forEach((item) => {
    const button = el('button')
    button.type = 'button'
    button.style.background = item.start
      ? `linear-gradient(135deg, ${item.start}, ${item.end})`
      : 'var(--surface-solid)'
    if ((selected || '') === item.start) button.classList.add('sel')
    button.onclick = () => {
      palette.querySelectorAll('button').forEach((node) => node.classList.remove('sel'))
      button.classList.add('sel')
      onPick(item)
    }
    palette.appendChild(button)
  })
  return palette
}

/** 图标选择网格（编辑器 / 创建器共用）。 */
function buildIconGrid (selected: string, onPick: (icon: string) => void): HTMLElement {
  const grid = el('div', 'icon-grid')
  const current = resolveSpaceIconId(selected)
  for (const icon of SPACE_ICON_NAMES) {
    const button = el('button', 'icon-choice')
    button.type = 'button'
    button.title = icon
    button.appendChild(spaceIconSvg(document, icon, { size: 18 }))
    if (icon === current) button.classList.add('sel')
    button.onclick = () => {
      grid.querySelectorAll('button').forEach((node) => node.classList.remove('sel'))
      button.classList.add('sel')
      onPick(icon)
    }
    grid.appendChild(button)
  }
  return grid
}

/** 表单行：左标签 + 右控件。 */
function field (label: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', 'field')
  wrap.appendChild(el('div', 'field-label', label))
  wrap.appendChild(control)
  return wrap
}

/** 编辑区底部动作行（取消 / 保存）。 */
function editorActions (onCancel: () => unknown, onSave: () => unknown, saveLabel = '保存'): HTMLElement {
  const actions = el('div', 'editor-actions')
  const cancel = el('button', 'btn btn-sm', '取消')
  cancel.onclick = onCancel
  const save = el('button', 'btn btn-sm btn-primary', saveLabel)
  save.onclick = onSave
  actions.append(cancel, save)
  return actions
}

// ─────────────────────────────────────────────────────────────────────────────
// 页面渲染
// ─────────────────────────────────────────────────────────────────────────────

async function refresh () {
  const list = requiredElement<HTMLElement>('list')
  list.textContent = ''

  let spaces: SpaceRecord[] = []
  let profiles: ProfileRecord[] = []
  let using: SpaceRecord | null = null
  try {
    spaces = await rpc<SpaceRecord[]>('space:list-all', {})
    profiles = await rpc<ProfileRecord[]>('profile:list-visible', {}).catch(() => [])
    using = await rpc<SpaceRecord>('space:get-using', {}).catch(() => null)
  } catch (e) {
    renderEmpty(list, '读取空间失败')
    return
  }

  // 以 profile 为驱动：没有空间的 profile 也要出现（可在卡片内直接新建空间）
  const groups = new Map<string, SpaceRecord[]>()
  for (const profile of profiles) groups.set(profile.id, [])
  for (const space of spaces) {
    if (!groups.has(space.profileId)) groups.set(space.profileId, [])
    groups.get(space.profileId)?.push(space)
  }

  if (groups.size === 0) {
    renderEmpty(list, '暂无配置文件')
    return
  }

  for (const [profileId, items] of groups) {
    const profile = profiles.find((item) => item.id === profileId) || { id: profileId, name: profileId }
    list.appendChild(buildProfileCard(profile, items, using, profiles, refresh))
  }
}

/** 一个配置文件 = 一张卡片：头部身份/操作 → 空间分区 → 新建空间页脚。 */
function buildProfileCard (profile: ProfileRecord, items: SpaceRecord[], using: PageRpcRecord | null, profiles: ProfileRecord[], reload: () => void | Promise<void>): HTMLElement {
  const card = el('section', 'profile-card')

  // ① 头部：身份 + 该配置文件级操作
  const head = el('div', 'card-head')
  const avatar = el('div', 'avatar', (profile.name || '?').charAt(0).toUpperCase())
  avatar.style.background = profile.color || 'var(--accent)'
  head.appendChild(avatar)

  const identity = el('div', 'head-text')
  const title = el('div', 'head-title', profile.name || profile.id)
  if (profile.isActive) title.appendChild(el('span', 'badge badge-accent', '当前配置文件'))
  identity.appendChild(title)
  identity.appendChild(el('div', 'head-meta', `${items.length} 个空间 · ${profile.id}`))
  head.appendChild(identity)

  const actions = el('div', 'head-actions')
  if (!profile.isActive) {
    const activate = textButton('使用', 'check')
    activate.onclick = async () => {
      // 同 profiles 页：失败要看得见、且无论如何都重渲染（显示主进程的真实状态），
      // 不能像以前那样"抛了就什么都不做" —— 那看起来就是"点了没反应"。
      try {
        await rpc('profile:set-active', { id: profile.id })
      } catch (e) {
        console.error('[spaces] 切换配置文件失败:', errorText(e, String(e)))
      }
      reload()
    }
    actions.appendChild(activate)
  }
  actions.appendChild(iconButton('upload', '导入空间', async () => {
    try {
      const res = await rpc('space:import', { profileId: profile.id })
      if (res && res.ok) {
        alert(res.message || '导入完成')
        reload()
      } else if (res && !res.canceled) {
        alert(res.error || '导入失败')
      }
    } catch (e) {
      alert(errorText(e, '导入失败'))
    }
  }))
  actions.appendChild(iconButton('pencil', '编辑配置文件', () => enterProfileEdit(card, profile, reload)))
  if (profile.id !== 'default') {
    actions.appendChild(iconButton('trash', '删除配置文件', async () => {
      if (confirm(`删除配置文件“${profile.name || profile.id}”？`)) {
        await rpc('profile:remove', { id: profile.id })
        reload()
      }
    }, { danger: true }))
  }
  head.appendChild(actions)
  card.appendChild(head)

  // ② 空间分区（编辑区就地展开在卡片内，不动头部身份信息）
  const section = el('div', 'card-section')
  const label = el('div', 'section-label')
  label.appendChild(el('span', undefined, 'Spaces'))
  label.appendChild(el('span', 'count', String(items.length)))
  section.appendChild(label)

  const spaceList = el('div', 'space-list')
  for (const space of items) {
    spaceList.appendChild(buildSpaceItem(space, using, items, profiles, reload))
  }
  section.appendChild(spaceList)
  card.appendChild(section)

  // ③ 页脚：只在这里提供「新建空间」
  const foot = el('div', 'card-foot')
  const add = textButton('新建空间', 'plus', 'btn btn-sm btn-ghost btn-block')
  add.onclick = () => openCreator(profile.id, spaceList)
  foot.appendChild(add)
  card.appendChild(foot)

  return card
}

/** 就地编辑配置文件：展开在头部下方，头部信息保持可见。 */
function enterProfileEdit (card: HTMLElement, profile: ProfileRecord, reload: () => void | Promise<void>): void {
  if (card.querySelector('.card-editor')) return
  const draft = { name: profile.name || profile.id, color: profile.color || '' }

  const editor = el('div', 'card-editor')
  const input = el('input', 'input')
  input.value = draft.name
  input.oninput = () => { draft.name = input.value }

  const fields = el('div', 'editor-fields')
  fields.appendChild(field('名称', input))
  editor.appendChild(fields)

  editor.appendChild(field('颜色', buildPalette(draft.color, (item) => { draft.color = item.start })))

  editor.appendChild(editorActions(() => editor.remove(), async () => {
    const name = draft.name.trim()
    if (!name) return input.focus()
    await rpc('profile:update', { id: profile.id, name, color: draft.color })
    reload()
  }))

  card.querySelector<HTMLElement>('.card-head')?.after(editor)
  input.focus()
  input.select()
}

/** 一个空间 = 一行信息 + 就地展开的编辑区（同一包装内，便于分割线收口）。 */
function buildSpaceItem (space: SpaceRecord, using: PageRpcRecord | null, siblings: SpaceRecord[], profiles: ProfileRecord[], reload: () => void | Promise<void>): HTMLElement {
  const isUsing = !!(using && using.id === space.id && using.profileId === space.profileId)
  const item = el('div', 'space-item')
  const row = el('div', 'space-row')

  row.appendChild(buildIconTile(space))

  const main = el('div', 'space-main')
  const name = el('div', 'space-name', space.name || space.id)
  if (isUsing) name.appendChild(el('span', 'badge badge-accent', '使用中'))
  main.appendChild(name)
  main.appendChild(el('div', 'space-meta', `id: ${space.id}`))
  row.appendChild(main)

  const actions = el('div', 'space-actions')
  if (!isUsing) {
    const use = textButton('进入', 'arrowRight')
    use.onclick = async () => {
      await rpc('space:set-using', { profileId: space.profileId, spaceId: space.id })
      reload()
    }
    actions.appendChild(use)
  }
  actions.appendChild(iconButton('download', '导出空间', async () => {
    try {
      const res = await rpc('space:export', { profileId: space.profileId, spaceId: space.id })
      if (res && res.ok) {
        alert(res.message || '导出完成')
      } else if (res && !res.canceled) {
        alert(res.error || '导出失败')
      }
    } catch (e) {
      alert(errorText(e, '导出失败'))
    }
  }))
  actions.appendChild(iconButton('pencil', isUsing ? '编辑空间（当前空间不可更换配置文件）' : '编辑空间', () => {
    enterEdit(item, space, profiles, isUsing, reload)
  }))
  // 默认空间不可删（保证 profile 永远有一个可进入的空间，与 domain-space 同语义）
  if (space.id !== 'default') {
    actions.appendChild(iconButton('trash', '删除空间', async () => {
      await rpc('space:remove', { profileId: space.profileId, spaceId: space.id })
      reload()
    }, { danger: true }))
  }
  row.appendChild(actions)
  item.appendChild(row)

  // ── 组内拖拽排序（HTML5 DnD，仅同 profile 内生效）──
  row.draggable = true
  row.addEventListener('dragstart', (e) => {
    dragSource = { profileId: space.profileId, spaceId: space.id }
    row.classList.add('dragging')
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })
  row.addEventListener('dragend', () => {
    dragSource = null
    row.classList.remove('dragging')
    document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'))
  })
  row.addEventListener('dragover', (e) => {
    if (!dragSource || dragSource.profileId !== space.profileId) return
    e.preventDefault()
    row.classList.add('drop-target')
  })
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'))
  row.addEventListener('drop', async (e) => {
    e.preventDefault()
    row.classList.remove('drop-target')
    if (!dragSource || dragSource.profileId !== space.profileId) return
    if (dragSource.spaceId === space.id) return

    const ids = siblings.map((s) => s.id).filter((id) => id !== dragSource?.spaceId)
    const at = ids.indexOf(space.id)
    if (at < 0) return
    ids.splice(at, 0, dragSource.spaceId)
    const entries = ids.map((id, index) => ({ profileId: space.profileId, spaceId: id, order: index }))
    try {
      await rpc('space:reorder', { entries })
    } finally {
      dragSource = null
      reload()
    }
  })

  return item
}

/** 就地编辑空间：名称 + 所属配置文件 + 图标 + 颜色（改完即存，不弹独立窗口）。 */
function enterEdit (item: HTMLElement, space: SpaceRecord, profiles: ProfileRecord[], isCurrent: boolean, reload: () => void | Promise<void>): void {
  if (item.querySelector('.editor')) return
  const draft = {
    name: space.name || space.id,
    profileId: space.profileId,
    icon: resolveSpaceIconId(space.icon),
    start: space.bgStartColor || '',
    end: space.bgEndColor || ''
  }

  const editor = el('div', 'editor')

  const input = el('input', 'input')
  input.value = draft.name
  input.addEventListener('input', () => { draft.name = input.value })

  const profileSelect = document.createElement('select')
  profileSelect.className = 'input'
  profileSelect.disabled = isCurrent
  for (const profile of profiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = profile.name || profile.id
    option.selected = profile.id === draft.profileId
    profileSelect.appendChild(option)
  }
  if (isCurrent) profileSelect.title = '当前空间不能更换配置文件'
  else profileSelect.onchange = () => { draft.profileId = profileSelect.value }

  const fields = el('div', 'editor-fields')
  fields.appendChild(field('名称', input))
  fields.appendChild(field('所属配置文件', profileSelect))
  editor.appendChild(fields)

  editor.appendChild(field('图标', buildIconGrid(draft.icon, (icon) => { draft.icon = icon })))
  editor.appendChild(field('颜色', buildPalette(draft.start, (itemPalette) => {
    draft.start = itemPalette.start
    draft.end = itemPalette.end
  })))

  editor.appendChild(editorActions(() => editor.remove(), async () => {
    const name = draft.name.trim()
    const patch: { icon: string; bgStartColor: string; bgEndColor: string; name?: string } = { icon: draft.icon, bgStartColor: draft.start, bgEndColor: draft.end }
    if (name) patch.name = name
    if (!profileSelect.disabled && draft.profileId !== space.profileId) {
      await rpc('space:move', { profileId: space.profileId, spaceId: space.id, targetProfileId: draft.profileId })
      await rpc('space:update', { profileId: draft.profileId, spaceId: space.id, patch })
    } else {
      await rpc('space:update', { profileId: space.profileId, spaceId: space.id, patch })
    }
    reload()
  }))

  item.appendChild(editor)
  input.focus()
  input.select()
}

/** 新建空间：就地在所属卡片的空间列表末尾展开编辑区。 */
async function openCreator (profileId: string, spaceList: HTMLElement): Promise<void> {
  if (spaceList.querySelector('.editor')) return
  const profiles = await rpc<Array<{ id: string; name?: string }>>('profile:list-visible', {})
    .catch((): Array<{ id: string; name?: string }> => [])
  const firstProfileId = profiles[0]?.id
  if (!firstProfileId) return

  const draft = {
    name: '',
    profileId: profileId || firstProfileId,
    icon: DEFAULT_SPACE_ICON,
    start: PALETTES[1].start,
    end: PALETTES[1].end
  }

  const item = el('div', 'space-item')
  const row = el('div', 'space-row')

  const preview = el('div', 'swatch swatch--colored')
  preview.style.background = `linear-gradient(135deg, ${draft.start}, ${draft.end})`
  const paintPreview = () => {
    preview.textContent = ''
    preview.appendChild(spaceIconSvg(document, draft.icon, { size: 16 }))
  }
  paintPreview()
  row.appendChild(preview)

  const main = el('div', 'space-main')
  main.appendChild(el('div', 'space-name', '新建空间'))
  main.appendChild(el('div', 'space-meta', '填写名称并选择图标与颜色'))
  row.appendChild(main)
  item.appendChild(row)

  const editor = el('div', 'editor')
  const input = el('input', 'input')
  input.placeholder = '空间名称'
  input.addEventListener('input', () => { draft.name = input.value })
  editor.appendChild(field('名称', input))
  editor.appendChild(field('图标', buildIconGrid(draft.icon, (icon) => {
    draft.icon = icon
    paintPreview()
  })))
  editor.appendChild(field('颜色', buildPalette(draft.start, (itemPalette) => {
    draft.start = itemPalette.start
    draft.end = itemPalette.end
    preview.style.background = itemPalette.start
      ? `linear-gradient(135deg, ${itemPalette.start}, ${itemPalette.end})`
      : ''
    preview.classList.toggle('swatch--colored', !!itemPalette.start)
  })))
  editor.appendChild(editorActions(() => item.remove(), async () => {
    const name = draft.name.trim()
    if (!name) return input.focus()
    await rpc('space:create', {
      profileId: draft.profileId,
      name,
      icon: draft.icon,
      bgStartColor: draft.start,
      bgEndColor: draft.end
    })
    refresh()
  }, '创建'))
  item.appendChild(editor)

  spaceList.appendChild(item)
  input.focus()
}

/** 新建配置文件：顶部工具栏触发，在列表最前展开一张待创建卡片。 */
function openProfileCreator (): void {
  const list = requiredElement<HTMLElement>('list')
  if (list.querySelector('.profile-card--creating')) return

  const card = el('section', 'profile-card profile-card--creating')
  const head = el('div', 'card-head')
  const avatar = el('div', 'avatar avatar--ghost')
  const avatarIcon = uiIconSvg(document, 'plus', { size: 18 })
  if (avatarIcon) avatar.appendChild(avatarIcon)
  head.appendChild(avatar)
  const identity = el('div', 'head-text')
  identity.appendChild(el('div', 'head-title', '新建配置文件'))
  identity.appendChild(el('div', 'head-meta', '配置文件隔离 Cookie / 存储 / 扩展等浏览器数据'))
  head.appendChild(identity)
  card.appendChild(head)

  const editor = el('div', 'card-editor')
  const draft = { name: '', color: PALETTES[1]?.start || '' }
  const input = el('input', 'input')
  input.placeholder = '配置文件名称'
  input.addEventListener('input', () => { draft.name = input.value })
  editor.appendChild(field('名称', input))
  editor.appendChild(field('颜色', buildPalette(draft.color, (item) => { draft.color = item.start })))
  editor.appendChild(editorActions(() => card.remove(), async () => {
    const name = draft.name.trim()
    if (!name) return input.focus()
    await rpc('profile:create', { name, color: draft.color })
    refresh()
  }, '创建'))
  card.appendChild(editor)

  list.prepend(card)
  input.focus()
}

// 工具栏：仅保留「新建配置文件」（新建空间下沉到各配置文件卡片的页脚）
const addProfile = textButton('新建配置文件', 'plus')
addProfile.onclick = openProfileCreator
requiredElement<HTMLElement>('page-tools').appendChild(addProfile)

/**
 * 外部变更同步。
 *
 * 空间 / 配置文件都在**别处**也会被改：外壳的空间切换器、其它窗口、导入档案。
 * 本页原先只在载入时取一次数，于是「在切换器里新建了空间，回到本页看不到」
 * —— 表现为这一页像是静态截图。这里订阅两条应用级事件后按需重拉。
 *
 * 编辑中不动：正在展开的编辑区（新建 / 重命名）里有用户没保存的草稿，
 * 被一次后台刷新清掉是最糟的体验；等用户收起编辑区后下一次事件再拉。
 */
let reloadTimer = 0
function scheduleReload () {
  if (document.querySelector('.editor, .card-editor')) return
  if (reloadTimer) return
  reloadTimer = window.setTimeout(() => {
    reloadTimer = 0
    refresh()
  }, 120)
}
subscribe(IPC_EVENTS.spaceChanged, scheduleReload)
subscribe(IPC_EVENTS.profileChanged, scheduleReload)

refresh()
