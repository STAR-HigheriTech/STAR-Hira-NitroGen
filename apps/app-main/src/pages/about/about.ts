import { IPC_ROUTES, rpc, el, initTheme } from 'hira://shared/runtime.js'
import { createUpdatePanel } from './update-panel.js'

// 配色统一于设置页 → base.css 同源 token（主题值本身由主进程按调度解析）
initTheme()

/** 页内两个选项卡的 id（顺序即按钮顺序）。 */
const TABS = ['about', 'update']

interface AboutInfo {
  name?: string
  version?: string
  isPackaged?: boolean
  electron?: string
  chrome?: string
  node?: string
  v8?: string
  platform?: string
  arch?: string
  osVersion?: string
  userDataPath?: string
  defaultUserAgent?: string
}

function requiredElement<T>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`About page element ${selector} is unavailable`)
  return element as unknown as T
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** 追加一行「名称 / 值」；无值则跳过（不显示占位假数据）。 */
function addRow (host: HTMLElement, label: string, value: unknown, mono = false): void {
  if (value === undefined || value === null || value === '') return
  host.appendChild(el('dt', undefined, label))
  host.appendChild(el('dd', mono ? 'mono' : undefined, String(value)))
}

/** 分类无任何数据时整卡隐藏，避免出现只有标题的空卡片。 */
function hideWhenEmpty (cardId: string, host: HTMLElement): void {
  const card = document.getElementById(cardId)
  if (card && host.children.length === 0) card.hidden = true
}

async function renderAbout () {
  const nameEl = requiredElement<HTMLElement>(document, '#app-name')
  const versionEl = requiredElement<HTMLElement>(document, '#app-version')
  const appHost = requiredElement<HTMLElement>(document, '#app')
  const runtimeHost = requiredElement<HTMLElement>(document, '#runtime')
  const systemHost = requiredElement<HTMLElement>(document, '#system')
  const dataHost = requiredElement<HTMLElement>(document, '#data')
  const uaEl = requiredElement<HTMLElement>(document, '#ua')
  const noteEl = requiredElement<HTMLElement>(document, '#note')

  // app:info 由主进程提供应用自身事实（应用版本 / userData / 是否打包），
  // 这些字段渲染进程无法从 UA 反推，故一律以主进程返回值为准。
  let info: AboutInfo | null = null
  try {
    info = await rpc<AboutInfo>(IPC_ROUTES.appInfo, {})
  } catch (error) {
    noteEl.className = 'about-note error'
    noteEl.textContent = '读取应用信息失败：' + errorText(error, String(error))
    return
  }
  info = info && typeof info === 'object' ? info : {}

  if (info.name) nameEl.textContent = info.name
  versionEl.textContent = info.version ? `版本 ${info.version}` : '未获取到应用版本号'

  // ── 应用 ──
  addRow(appHost, '应用名称', info.name)
  addRow(appHost, '应用版本', info.version)
  if (info.version) {
    addRow(appHost, '运行方式', info.isPackaged ? '已打包（正式构建）' : '开发模式（未打包）')
  }

  // ── 运行环境 ──
  addRow(runtimeHost, 'Electron', info.electron)
  addRow(runtimeHost, 'Chromium', info.chrome)
  addRow(runtimeHost, 'Node.js', info.node)
  addRow(runtimeHost, 'V8', info.v8)

  // ── 系统 ──
  addRow(systemHost, '平台', info.platform)
  addRow(systemHost, '架构', info.arch)
  addRow(systemHost, '系统版本', info.osVersion)

  // ── 用户数据目录 ──
  addRow(dataHost, '数据目录', info.userDataPath, true)

  // ── 默认 User-Agent ──
  if (info.defaultUserAgent) uaEl.textContent = info.defaultUserAgent

  // 当前配置文件 / 界面主题：来自已有的 IPC 通道，非推算。
  // 主题读 `theme:active`（调度解析后的**实际生效**主题），不要读 `app.theme` ——
  // 后者在主题系统里存的是主题 id（`hira-dark` / `user.xxx`），拿它做中文映射
  // 只会显示成原始 id，且三态时代早就不存在了。
  const [profile, activeTheme] = await Promise.all([
    rpc<Record<string, unknown>>(IPC_ROUTES.profileGetActive, {}).catch(() => null),
    rpc<{ theme?: Record<string, unknown> | null }>(IPC_ROUTES.themeActive, {}).catch(() => null)
  ])
  const themeInfo = activeTheme && activeTheme.theme ? activeTheme.theme : null
  addRow(appHost, '当前配置文件', profile ? String(profile.name || profile.id || '') : '')
  addRow(appHost, '界面主题', themeInfo ? String(themeInfo.name || themeInfo.id || '') : '')

  hideWhenEmpty('card-app', appHost)
  hideWhenEmpty('card-runtime', runtimeHost)
  hideWhenEmpty('card-system', systemHost)
  hideWhenEmpty('card-data', dataHost)
  if (!info.defaultUserAgent) {
    const uaCard = document.getElementById('card-ua')
    if (uaCard) uaCard.hidden = true
  }

  if (!info.name && !info.version) {
    noteEl.className = 'about-note error'
    noteEl.textContent = '主进程未返回应用信息，以上字段为空。'
    return
  }
  noteEl.hidden = true
}

// ── 选项卡（关于 / 软件更新）────────────────────────────────────────────
//
// 更新不再是独立页面：它在这个页面里是第二个选项卡。深链形如
// `hira://about?tab=update` —— 应用菜单 / 地址栏命令 / 设置里的入口全落在这条 URL 上。
// 切换用 `history.replaceState` 让地址栏同步（不新增历史条目，否则来回切两下
// 就会在"后退"里塞一串同页记录）；不支持时静默跳过，功能不受影响。

const paneEls: Record<string, HTMLElement> = {
  about: requiredElement<HTMLElement>(document, '[data-pane="about"]'),
  update: requiredElement<HTMLElement>(document, '[data-pane="update"]')
}
const tabEls = Array.from(document.querySelectorAll<HTMLElement>('.about-tab'))
const updatePanel = createUpdatePanel(paneEls.update)

let activeTab = 'about'

/** 从地址栏读初始选项卡（不认识的取值一律回落到「关于」）。 */
function readTabFromUrl (): string {
  const wanted = new URLSearchParams(location.search).get('tab') || ''
  return TABS.indexOf(wanted) >= 0 ? wanted : 'about'
}

/** 把当前选项卡写回地址栏（不产生新历史条目）。 */
function writeTabToUrl (tab: string): void {
  try {
    const url = new URL(location.href)
    if (tab === 'about') url.searchParams.delete('tab')
    else url.searchParams.set('tab', tab)
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // 自定义协议下若被安全策略拒绝，就只保留页内状态
  }
}

/** 切到某个选项卡（幂等）；`updateUrl` 只在用户点击时为 true。 */
function selectTab (tab: string, { updateUrl = false }: { updateUrl?: boolean } = {}): void {
  const next = TABS.indexOf(tab) >= 0 ? tab : 'about'
  activeTab = next
  for (const btn of tabEls) {
    const on = btn.dataset.tab === next
    btn.classList.toggle('is-active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    btn.tabIndex = on ? 0 : -1
  }
  for (const id of TABS) {
    const pane = paneEls[id]
    if (pane) pane.hidden = id !== next
  }
  // 更新面板懒接线：只有真的被打开过才去订阅 / 拉状态
  if (next === 'update') updatePanel.activate()
  if (updateUrl) writeTabToUrl(next)
}

const tabsHost = requiredElement<HTMLElement>(document, '.about-tabs')
tabsHost.addEventListener('click', (event: MouseEvent) => {
  const target = event.target
  const btn = target instanceof Element ? target.closest<HTMLElement>('.about-tab') : null
  if (btn?.dataset.tab) selectTab(btn.dataset.tab, { updateUrl: true })
})

// 键盘：左右方向键在选项卡间移动（tablist 的标准行为）
tabsHost.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const step = event.key === 'ArrowRight' ? 1 : -1
  const index = (TABS.indexOf(activeTab) + step + TABS.length) % TABS.length
  selectTab(TABS[index], { updateUrl: true })
  const button = tabEls.find((b) => b.dataset.tab === TABS[index])
  if (button) button.focus()
})

selectTab(readTabFromUrl())

renderAbout().catch((error?) => {
  console.error('[about] render failed:', error)
})
