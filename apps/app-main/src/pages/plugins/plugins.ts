// @ts-check
/**
 * 插件中心 · 内部页入口（`hira://plugins`）。
 *
 * 三层分工（与窗口形态当年一致，只是宿主从 subwindow 换成了 hira:// 页）：
 *   · `format.ts`  —— 纯数据层：分组 / 措辞 / 判定（零 DOM、零 IPC）；
 *   · `parts.ts`   —— 叶子 DOM 原子：一颗开关、一行插件的主体、依赖关系；
 *   · `core.ts`    —— 编排内核：状态与全部动作（拉清单 / 启停 / 安装 / 授权…）；
 *   · 本文件        —— **视图装配 + 宿主端口**：把页面 DOM 拼起来，把 rpc 包成 clients，
 *                     把意图的出口接到内核上。它不认识浏览器窗口类型，只认识一个页面。
 *
 * 为什么页面不再有第二套"面板形态"：插件中心只有一个形态（本页）。
 * 侧栏面板入口由清单的 `contributes.panels[].opensPage` 声明，
 * 派发时直接开 `hira://plugins`（见 renderer/shared/entry-action.js），
 * 因此这里不需要知道任何窗口常量，也不存在"面板与窗口各拉各的数据"。
 */
import { IPC_ROUTES, rpc, subscribe, el, initTheme, pageUrl, uiIconSvg } from 'hira://shared/runtime.js'
import { isRecord } from 'hira://shared/page-kit.js'
// rail 末尾的「更多页面」出口：与设置页共用同一个工厂（落点 / 文案 / 字形只有一份）。
import { createRailMoreLink } from 'hira://shared/rail-more.js'
import { createPluginsController } from './core.js'
import {
  TRUST_IMPORT_LEVELS,
  TRUST_LEVEL_LABEL,
  TYPE_ORDER,
  filterPlugins,
  groupByType,
  matchesMarketQuery,
  marketStatus,
  sourceStateText,
  summarize,
  typeMeta,
  typeOf
} from './format.js'
import { buildGroupedList, buildRowMain, buildSwitch, showNotice } from './parts.js'
import { createSkillsBoard } from './skills.js'
import { createUserScriptsBoard } from './userscripts.js'
import { createPluginPagesBoard } from './plugin-pages.js'
import type {
  MarketEntryRecord,
  MarketSourceRecord,
  MarketState,
  PluginActionResult,
  PluginClientPort,
  PluginDispatch,
  PluginMarketListResult,
  PluginPage,
  PluginRecord,
  PluginSkillListResult,
  TrustedKeyRecord
} from './types.js'

function readPlugins(value: unknown): PluginRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PluginRecord[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return []
    const pages = Array.isArray(item.pages) ? item.pages.filter(isRecord) as unknown as PluginPage[] : []
    return [{ ...item, id: item.id, pages }]
  })
}

function readTrustedKeys(value: unknown): TrustedKeyRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TrustedKeyRecord[] => (
    isRecord(item) && typeof item.keyId === 'string' && item.keyId ? [{ ...item, keyId: item.keyId }] : []
  ))
}

function readMarketState(value: unknown): MarketState {
  if (!isRecord(value)) return { ok: false, sources: [], entries: [] }
  const sources = Array.isArray(value.sources)
    ? value.sources.flatMap((source): MarketSourceRecord[] => (
        isRecord(source) && typeof source.url === 'string' ? [{ ...source, url: source.url }] : []
      ))
    : []
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry): MarketEntryRecord[] => (
        isRecord(entry) && typeof entry.id === 'string' ? [{ ...entry, id: entry.id }] : []
      ))
    : []
  return { ok: value.ok === true, sources, entries, reason: typeof value.reason === 'string' ? value.reason : undefined }
}

function eventButton(event: MouseEvent, selector: string): HTMLButtonElement | null {
  const target = event.target
  return target instanceof Element ? target.closest<HTMLButtonElement>(selector) : null
}

// 跟随 app.theme 三态（浅 / 深 / 系统），配色统一于设置页 → base.css 同源 token。
initTheme()

/**
 * 视图：完整实现内核的全部能力。
 *
 * `setMarket` / `setTrustedKeys` 的**存在本身就是声明** —— 内核据此决定拉不拉那两份数据
 * （鸭子类型协商，见 core.ts 文件头）。以后的精简形态只实现 `setItems`，内核一行不用改。
 */
function createPageView () {
  const root = el('div', 'plugins-page')

  // ── 左侧 rail（本页自有，不接内部页统一外壳）────────────────────────
  // 与设置页同构：标题 + 搜索 + 板块切换。每一项切换的是**主区的一个板块**，
  // 不是页内锚点 —— 板块之间不互通，同一时刻只显示一块。
  const rail = el('nav', 'plugins-page__rail')
  rail.setAttribute('aria-label', '插件板块')
  const railTitle = el('div', 'plugins-page__rail-title', '插件')

  /* 搜索字段：放大镜 + 输入框合成**一块**软底（外观原语 = base.css 的 `.searchfield`）。
     只作用于插件板块 —— 插件源 / 公钥各有自己的搜索与筛选，共用一条词只会互相误导。
     三条与标签面板同一口径的纪律：
       · 不用 `input[type=search]` —— Chromium 会给它配原生的放大镜/清除按钮，
         在自定义软底上就是一块突兀的异物，深浅主题还各丑一遍；
       · 环画在整块软底上（`:focus-within`），输入框自己不吃环；
       · rail 给字段四邻各留 2px（见 plugins.css 的 `.plugins-page__rail`），
         否则 `--hira-focus-ring` 向外扩的那 2px 会被容器切掉。 */
  const searchField = el('div', 'searchfield plugins-page__search')
  const searchIcon = uiIconSvg(document, 'search', { size: 14 })
  if (searchIcon) searchField.appendChild(searchIcon)
  const searchInput = el('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索插件…'
  searchInput.setAttribute('aria-label', '搜索插件')
  searchInput.spellcheck = false
  searchInput.setAttribute('data-plugin-search', '1')
  searchInput.addEventListener('input', () => {
    pluginQuery = String(searchInput.value || '')
    renderList()
  })
  // Escape 清空（搜索框自己的约定：Esc = 放弃这次过滤，回到全量清单）
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    searchInput.value = ''
    pluginQuery = ''
    renderList()
  })
  searchField.appendChild(searchInput)

  const nav = el('div', 'plugins-page__nav')
  // 「更多页面」出口：与设置页同一个工厂、同一个落点（pages.mjs#MORE_PAGES_HOST）。
  // 静态锚点，不随 renderNav 重建 —— 板块数据变化不会把它洗掉。
  const moreLink = createRailMoreLink(document, {
    itemClass: 'plugins-page__nav-item',
    labelClass: 'plugins-page__nav-name',
    extraClass: 'plugins-page__more'
  })
  rail.append(railTitle, searchField, nav, moreLink)

  // ── 主区：板块标题 + 汇总 + 板块内容（只有一块可见）──
  const main = el('div', 'plugins-page__main-pane')
  const topbar = el('header', 'plugins-page__topbar')
  const heading = el('div', 'plugins-page__heading')
  const boardTitle = el('h1', 'plugins-page__title', '全部插件')
  const summary = el('p', 'plugins-page__summary')
  const refreshAll = el('button', 'btn-mini plugins-page__refresh-all', '刷新')
  refreshAll.type = 'button'
  refreshAll.title = '重新读取插件、技能、用户脚本、公钥与插件源'
  refreshAll.addEventListener('click', () => emit({ type: 'refresh-all' }))
  heading.append(boardTitle, summary)
  topbar.append(heading, refreshAll)

  const content = el('div', 'plugins-page__content')

  /* 板块级出口：有的板块"完整的管理面"在别的内部页（主题就是一整套编辑页），
     在本页只能启停，真正的编辑要去那里。它是一条**整宽的引导条**而不是标题旁的
     小按钮 —— 这是一句"接下来该去哪"的指引，不是可有可无的次级动作。
     地址在点击时按 host 现拼：`pageUrl` 是内部页地址的唯一拼法，不手写 hira://。 */
  const boardLink = el('button', 'plugins-page__cta')
  boardLink.type = 'button'
  boardLink.hidden = true
  const boardLinkText = el('span', 'plugins-page__cta-text')
  const boardLinkName = el('span', 'plugins-page__cta-name')
  const boardLinkHint = el('span', 'plugins-page__cta-hint')
  boardLinkText.append(boardLinkName, boardLinkHint)
  const boardLinkArrow = uiIconSvg(document, 'arrowRight', { size: 15 })
  if (boardLinkArrow) boardLinkArrow.classList.add('plugins-page__cta-arrow')
  boardLink.append(boardLinkText)
  if (boardLinkArrow) boardLink.appendChild(boardLinkArrow)
  boardLink.addEventListener('click', () => {
    const host = boardLink.getAttribute('data-page-host')
    if (host) window.location.href = pageUrl(host)
  })

  // 页面唯一的提示口径：就地说明，不弹窗。success / error 走 base.css 的 .feedback。
  const notice = el('div', 'feedback')
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  notice.hidden = true

  // ── 安装板块：原先横在页顶的动作条，改成一张张可点的卡片 ──────────────
  // 四个入口全部走意图上行（本视图不认识 IPC，更不认识文件系统）。
  const install = el('section', 'plugins-page__panel')
  install.hidden = true
  const installGrid = el('div', 'plugins-page__install-grid')
  for (const [source, text, hint] of [
    ['directory', '从文件夹安装', '选择一个插件文件夹（内含 hira-plugin.json）安装到用户插件目录'],
    ['archive', '从压缩包安装', '选择一个插件 zip 包，解压后安装到用户插件目录'],
    ['userscript', '安装用户脚本', '选择一个 .user.js 脚本，它会装成一个 userscript-plugin 插件']
  ]) {
    const card = el('button', 'plugins-page__install-card')
    card.type = 'button'
    card.setAttribute('data-plugin-install', source)
    card.append(
      el('span', 'plugins-page__install-name', text),
      el('span', 'plugins-page__install-hint', hint)
    )
    card.addEventListener('click', () => emit({ type: 'install', source }))
    installGrid.appendChild(card)
  }
  const dirCard = el('button', 'plugins-page__install-card')
  dirCard.type = 'button'
  dirCard.setAttribute('data-plugin-open-dir', '1')
  dirCard.append(
    el('span', 'plugins-page__install-name', '打开插件目录'),
    el('span', 'plugins-page__install-hint', '第三方插件放在这个目录里：每个插件一个子目录，内含 hira-plugin.json 与它的代码')
  )
  dirCard.addEventListener('click', () => emit({ type: 'open-dir' }))
  installGrid.appendChild(dirCard)
  install.appendChild(installGrid)

  // ── 插件源区 ──────────────────────────────────────────────────────
  const market = el('section', 'section plugins-page__block plugins-page__panel')
  market.hidden = true
  const marketHead = el('div', 'section-title')
  const marketTitle = el('span', '', '源地址')
  marketTitle.title = '静态 JSON 索引的地址（https://），可以配多个。顺序即优先级：同一个插件在多个源里出现时靠前的胜出'
  const marketRefresher = el('button', 'btn-mini plugins-page__push', '刷新')
  marketRefresher.type = 'button'
  marketRefresher.setAttribute('data-plugin-market-refresh', '1')
  marketRefresher.title = '重新拉取全部插件源（默认 60 秒内用缓存）'
  marketRefresher.addEventListener('click', () => emit({ type: 'market-refresh' }))
  marketHead.append(marketTitle, marketRefresher)

  const marketSources = el('div', 'plugins-page__market-sources')

  const marketRow = el('div', 'plugins-page__market-row')
  const marketInput = el('input', 'plugins-page__input')
  marketInput.type = 'text'
  marketInput.setAttribute('data-plugin-market-input', '1')
  marketInput.placeholder = 'https://example.com/hira-plugins/index.json'
  marketInput.spellcheck = false
  const submitSource = () => {
    const url = String(marketInput.value || '').trim()
    if (!url) return
    emit({ type: 'market-add-source', url })
  }
  marketInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    submitSource()
  })
  const marketAdd = el('button', 'btn-primary plugins-page__compact', '添加')
  marketAdd.type = 'button'
  marketAdd.setAttribute('data-plugin-market-add', '1')
  marketAdd.title = '把这个地址加进插件源列表（可以配多个）'
  marketAdd.addEventListener('click', submitSource)
  marketRow.append(marketInput, marketAdd)

  const marketStatusEl = el('div', 'plugins-page__market-status')

  const marketSearchRow = el('div', 'plugins-page__market-row')
  const marketSearch = el('input', 'plugins-page__input')
  marketSearch.type = 'text'
  marketSearch.setAttribute('data-plugin-market-search', '1')
  marketSearch.placeholder = '在结果里搜索…'
  marketSearch.spellcheck = false
  marketSearch.addEventListener('input', () => {
    marketQuery = String(marketSearch.value || '')
    renderMarket()
  })
  marketSearchRow.appendChild(marketSearch)

  const marketList = el('div', 'plugins-page__market-list')
  market.append(marketHead, marketSources, marketRow, marketStatusEl, marketSearchRow, marketList)

  /** @type {{ ok: boolean, reason?: string, sources: unknown[], duplicates?: number, entries: unknown[] }} */
  let marketState: MarketState = { ok: false, sources: [], entries: [] }
  /** 源内搜索词。**视图内部状态**：纯 UI 过滤，与任何 IPC 都无关。 */
  let marketQuery = ''

  /** 重画插件源区（数据由内核经 setMarket 推下来）。 */
  function renderMarket () {
    const sources = marketState.sources
    const all = marketState.entries

    // ── 已配的源（逐条：地址 + 它自己的状态 + 移除）──
    marketSources.textContent = ''
    for (const [index, s] of sources.entries()) {
      const row = el('div', 'plugins-page__market-source')
      const url = el('span', 'plugins-page__market-source-url', s.url)
      url.title = s.url
      const state = el('span', `plugins-page__market-source-state${s.ok ? '' : ' is-bad'}`, sourceStateText(s))
      // 失败原因也放进 title：正文里塞长错误会把这行撑爆，而"坏在哪"恰恰是最该能看到的
      if (!s.ok && s.reason) state.title = s.reason
      const del = el('button', 'btn-mini btn-danger plugins-page__compact', '移除')
      del.type = 'button'
      del.setAttribute('data-plugin-market-remove-source', s.url)
      del.title = '从插件源列表里移除它'
      const actions = el('div', 'plugins-page__market-source-actions')
      const up = el('button', 'btn-mini plugins-page__compact', '↑')
      up.type = 'button'
      up.disabled = index === 0
      up.title = '提高优先级'
      up.setAttribute('aria-label', '提高优先级')
      up.setAttribute('data-plugin-market-move', s.url)
      up.setAttribute('data-direction', '-1')
      const down = el('button', 'btn-mini plugins-page__compact', '↓')
      down.type = 'button'
      down.disabled = index === sources.length - 1
      down.title = '降低优先级'
      down.setAttribute('aria-label', '降低优先级')
      down.setAttribute('data-plugin-market-move', s.url)
      down.setAttribute('data-direction', '1')
      actions.append(up, down, del)
      row.append(url, state, actions)
      marketSources.appendChild(row)
    }

    const q = marketQuery.trim().toLowerCase()
    const visible = q ? all.filter((entry) => matchesMarketQuery(entry, q)) : all

    // 搜索框只在**有结果可搜**时出现；没有源时「刷新」没有意义
    marketSearchRow.hidden = all.length === 0
    marketRefresher.disabled = sources.length === 0

    const status = marketStatus(marketState, marketQuery)
    marketStatusEl.textContent = status.text
    marketStatusEl.classList.toggle('is-bad', status.bad)

    // ── 结果列表 ──
    marketList.textContent = ''
    if (q && all.length && !visible.length) {
      marketList.appendChild(el('div', 'plugins-page__muted', `没有匹配「${marketQuery.trim()}」的插件`))
      return
    }
    for (const e of visible) {
      const row = el('div', 'plugins-page__market-item')
      const main = el('div', 'plugins-page__market-main')
      main.appendChild(el('div', 'plugins-page__market-name', e.version ? `${e.name} ${e.version}` : e.name))
      const metaBits = [e.id]
      if (e.author) metaBits.push(e.author)
      if (e.installed && e.installedVersion) metaBits.push(`已装 ${e.installedVersion}`)
      if (!e.sha256) metaBits.push('未提供校验和')
      // 只在**配了多个源**时才标来源：单源时那是纯噪音
      if (sources.length > 1) {
        let host = ''
        try { host = new URL(e.sourceUrl || '').host } catch (_) { host = '' }
        if (e.sourceName || host) metaBits.push(`来自 ${e.sourceName || host}`)
      }
      main.appendChild(el('div', 'plugins-page__market-meta', metaBits.join(' · ')))
      if (e.description) main.appendChild(el('div', 'plugins-page__market-desc', e.description))

      const btn = el('button', 'btn plugins-page__compact')
      btn.type = 'button'
      btn.setAttribute('data-plugin-market-install', e.id)
      if (e.updateAvailable) {
        btn.textContent = '更新'
        btn.title = `从 ${e.installedVersion} 更新到 ${e.version}`
        btn.classList.add('btn-primary')
      } else if (e.installed) {
        btn.textContent = '重装'
        btn.title = '已经是这个版本；重装 = 用源里的包覆盖一遍'
      } else {
        btn.textContent = '安装'
        btn.classList.add('btn-primary')
      }
      row.append(main, btn)
      marketList.appendChild(row)
    }
  }

  // ── 受信任公钥区 ──────────────────────────────────────────────────
  const trust = el('section', 'section plugins-page__block plugins-page__panel')
  trust.hidden = true
  const trustHead = el('div', 'section-title')
  const trustTitle = el('span', '', '已导入的公钥')
  trustTitle.title = '带有 signature 的插件会用这里的公钥验签。导入的是公钥（.pem），文件名就是 manifest 里的 signature.keyId'
  const trustCount = el('span', 'plugins-page__muted')
  /** 导入到哪一级。刻意**没有**"官方"这一项：那是"随应用分发"的同义词。 */
  const trustLevel = el('select', 'plugins-page__select')
  trustLevel.setAttribute('data-plugin-trust-level-select', '1')
  trustLevel.title = '导入到哪一级 —— 社区：作者公布、可移除；本地：自己生成、开发用。官方级随应用分发，不能在这里写入'
  for (const value of TRUST_IMPORT_LEVELS) {
    const opt = el('option', '', TRUST_LEVEL_LABEL[value])
    opt.value = value
    trustLevel.appendChild(opt)
  }
  const trustAdd = el('button', 'btn-mini plugins-page__push', '导入公钥')
  trustAdd.type = 'button'
  trustAdd.setAttribute('data-plugin-trust-add', '1')
  trustAdd.title = '选择一个公钥文件（.pem）；文件名（去掉 .pem）就是 keyId'
  trustAdd.addEventListener('click', () => emit({ type: 'trust-import', level: trustLevel.value }))
  trustHead.append(trustTitle, trustCount, trustLevel, trustAdd)
  const trustList = el('div', 'plugins-page__trust-list')
  trust.append(trustHead, trustList)

  /** @type {unknown[]} */
  let trustedKeys: TrustedKeyRecord[] = []
  /** 重画公钥区（数据由内核经 setTrustedKeys 推下来）。 */
  function renderTrust () {
    trustCount.textContent = trustedKeys.length ? `${trustedKeys.length} 把` : ''
    trustList.textContent = ''
    if (!trustedKeys.length) {
      trustList.appendChild(el(
        'div',
        'plugins-page__muted',
        '还没有导入任何公钥。未导入时，带签名的插件仍可安装，只会提示"本机没有对应公钥"。'
      ))
      return
    }
    for (const k of trustedKeys) {
      const row = el('div', 'plugins-page__trust-row')
      const level = k.level || 'community'
      const badge = el('span', `plugins-page__trust-badge is-${level}`, TRUST_LEVEL_LABEL[level] || level || '社区')
      const name = el('span', 'plugins-page__trust-key', k.keyId)
      const fp = el('code', 'plugins-page__trust-fp')
      // 解析失败的文件必须显式说出来 —— 否则用户会一直奇怪"签名为什么不生效"
      fp.textContent = k.readable === false ? '无法解析（文件可能损坏或不是公钥）' : `${k.algo || 'key'} · ${k.fingerprint || '（无指纹）'}`
      if (k.readable === false) fp.classList.add('is-bad')
      row.append(badge, name, fp)
      // 官方级**不给移除按钮**：它在应用资源目录里（打包后只读），而且"官方签名"
      // 不该被一次误操作搞没。主进程同样会拒，但界面更该先不提供。
      if (k.removable !== false) {
        const del = el('button', 'btn-mini btn-danger plugins-page__compact', '移除')
        del.type = 'button'
        del.setAttribute('data-plugin-trust-remove', k.keyId)
        del.setAttribute('data-plugin-trust-level', level)
        del.title = '移除后，用它签名的插件会退回"本机没有对应公钥"（仍可安装，只是不再显示已校验）'
        row.appendChild(del)
      }
      trustList.appendChild(row)
    }
  }

  // ── 板块容器：同一时刻只显示一块（板块之间不互通）────────────────────
  // 「插件列表」与各「配置」板块各有自己的容器；`all` / `type:*` 共用 listPanel，
  // 只是过滤条件不同 —— 它们本来就是同一块陈列面上的不同切面。
  const listPanel = el('section', 'plugins-page__panel')
  const list = el('div', 'plugins-page__list')
  listPanel.appendChild(list)

  /**
   * AI 技能板块：与插件列表并列的独立内容区（`type:ai-skill-plugin` 时两块同时可见）。
   *
   * 为什么不做成第二套管理页：技能已经是插件体系的一等公民，
   * 它的「归属插件」与「单条清单」本来就该在同一条目里一起看 ——
   * 拆到 `hira://aisettings` 就必然出现两套清单、两种刷新时机。
   */
  const skillsBoard = createSkillsBoard()
  const userScriptsBoard = createUserScriptsBoard()
  const pluginPagesBoard = createPluginPagesBoard()

  /** 配置类板块的标题与一句话说明（插件类板块的标题来自 TYPE_SECTIONS）。 */
  const BOARD_TEXT: Record<string, { title: string; desc: string }> = {
    all: { title: '全部插件', desc: '' },
    market: {
      title: '插件源',
      desc: '静态 JSON 索引的地址（https://）—— 可以配多个，顺序即优先级：同一个插件在多个源里出现时靠前的胜出。'
    },
    trust: {
      title: '受信任的签名公钥',
      desc: '带 signature 的插件用这里的公钥验签。导入的是公钥（.pem），文件名就是 manifest 里的 signature.keyId。'
    },
    install: {
      title: '安装插件',
      desc: '从文件夹、压缩包或用户脚本安装，也可以直接打开用户插件目录手动放入。'
    },
    pages: {
      title: '插件页面',
      desc: '插件通过 contributes.pages 声明的内部页；地址由宿主解析，停用插件后入口不可用。'
    }
  }
  /**
   * 板块 → 外部出口（去哪个内部页）。只声明"去哪"，地址由 `pageUrl` 现拼，
   * 不写死 `hira://themes` —— 内部页身份/地址的唯一真源是 shared-types/pages.mjs。
   */
  const BOARD_LINKS: Record<string, { label: string; hint?: string; host: string }> = {
    'type:theme-plugin': {
      label: '打开主题页面',
      hint: '创建、编辑主题与调度都在主题页里做；这里只管插件的启停与验签',
      host: 'themes'
    }
  }
  /** 板块 key → 它自己的容器（插件类板块共用 listPanel，不在此表里）。 */
  const panels: Record<string, HTMLElement> = { market, trust, install }

  /** 当前板块：`all` | `type:<type>` | `pages` | `market` | `trust` | `install`。 */
  let activeBoard = 'all'

  const boardFromHash = (value?: unknown): string => {
    const raw = String(value || '').replace(/^#/, '').trim()
    if (!raw) return ''
    if (raw === 'all' || raw === 'market' || raw === 'trust' || raw === 'install' || raw === 'pages') return raw
    if (raw.startsWith('type:')) return raw.length > 5 ? raw : ''
    return `type:${raw}`
  }

  // 深链与上次板块都落到同一个 key；hash 优先，避免外链被本地记忆覆盖。
  try {
    const linkedBoard = boardFromHash(location.hash)
    if (linkedBoard) activeBoard = linkedBoard
    else {
      const remembered = localStorage.getItem('hira.plugins.board')
      const rememberedBoard = boardFromHash(remembered)
      if (rememberedBoard) activeBoard = rememberedBoard
    }
  } catch (_) { /* hash / localStorage 不可用时保持默认板块 */ }

  // 装配：侧栏只放导航，主区 = 顶栏 + 板块内容（只有一块可见）。
  main.append(topbar, content)
  content.append(boardLink, notice, skillsBoard.element, userScriptsBoard.element, pluginPagesBoard.element, listPanel, market, trust, install)
  root.append(rail, main)

  /** 最近一次下发的**全量**清单。搜索从它过滤，不重新问主进程。 */
  let allPlugins: PluginRecord[] = []
  let pluginsLoaded = false
  /** 搜索词。**视图内部状态**：纯 UI 过滤，与任何 IPC 都无关。 */
  let pluginQuery = ''

  /** 插件类板块（`all` 与 `type:*`）共用同一个列表容器。 */
  const isPluginBoard = (key: unknown): key is string => typeof key === 'string' && (key === 'all' || key.startsWith('type:'))

  /** 某一板块下的插件（不含搜索词过滤）。 */
  function boardItems (key: string): PluginRecord[] {
    if (key === 'all') return allPlugins
    const type = key.slice(5)
    return allPlugins.filter((plugin) => typeOf(plugin) === type)
  }

  function boardTitleOf (key: string): string {
    if (key === 'all') return BOARD_TEXT.all.title
    if (typeof key === 'string' && key.startsWith('type:')) return typeMeta(key.slice(5)).title
    return (BOARD_TEXT[key] || {}).title || '插件'
  }

  function boardSummaryOf (key: string): string {
    if (key === 'all') return summarize(allPlugins)
    if (typeof key === 'string' && key.startsWith('type:')) {
      return [summarize(boardItems(key)), typeMeta(key.slice(5)).hint].filter(Boolean).join(' · ')
    }
    return (BOARD_TEXT[key] || {}).desc || ''
  }

  function renderTopbar () {
    boardTitle.textContent = boardTitleOf(activeBoard)
    summary.textContent = boardSummaryOf(activeBoard)
  }

  /** 重画列表 —— 板块变化、清单变化与搜索词变化都走这里（唯一的渲染入口）。 */
  function renderList () {
    const base = boardItems(activeBoard)
    const visible = filterPlugins(base, pluginQuery)
    list.textContent = ''

    if (!pluginsLoaded) {
      list.appendChild(el('div', 'empty', '正在读取插件清单…'))
      return
    }

    if (!base.length) {
      list.appendChild(el('div', 'empty', activeBoard === 'all' ? '暂无插件' : '这一组暂无插件'))
      return
    }
    if (!visible.length) {
      list.appendChild(el('div', 'empty', `没有匹配「${pluginQuery.trim()}」的插件`))
      return
    }
    // 搜索 / 分类只过滤“当前行”，依赖关系仍按全量插件还原名称与状态 ——
    // 不能在过滤后的索引里把已安装的 ai-engine 说成“未安装”。
    list.appendChild(buildGroupedList(visible, renderRow, allPlugins).fragment)
  }

  /** 一颗 rail 项：板块名 + 计数（计数是参考值，退到第二层）。 */
  function navItem (key: string, label: string, count?: number): HTMLButtonElement {
    const btn = el('button', 'plugins-page__nav-item')
    btn.type = 'button'
    btn.setAttribute('data-plugin-board', key)
    btn.append(el('span', 'plugins-page__nav-name', label))
    if (typeof count === 'number') btn.appendChild(el('span', 'plugins-page__nav-count', String(count)))
    btn.addEventListener('click', () => selectBoard(key))
    return btn
  }

  /**
   * 重画 rail 的板块清单。只有**数据**变化时才调（插件清单 / 源 / 公钥）；
   * 单纯切板块走 `applyActiveBoard()` —— 重建 DOM 会把键盘焦点一起扔掉。
   */
  function renderNav () {
    const groups = groupByType(allPlugins)
    const activeType = activeBoard.startsWith('type:') ? activeBoard.slice(5) : ''
    nav.textContent = ''

    nav.appendChild(navItem('all', '全部插件', allPlugins.length))

    const typeItems = []
    const extraTypes = new Set(Array.from(groups.keys()).filter((type) => !TYPE_ORDER.includes(type)))
    if (activeType && !TYPE_ORDER.includes(activeType)) extraTypes.add(activeType)
    const orderedTypes = [
      ...TYPE_ORDER.filter((type) => groups.has(type) || type === activeType),
      ...Array.from(extraTypes).sort()
    ]
    for (const type of orderedTypes) {
      const count = (groups.get(type) || []).length
      // 空分组不出现（不留一排 0）；但**当前选中的**那一个要留着 ——
      // 否则清单一变它就凭空消失，用户会以为自己的点击没生效。
      if (!count && type !== activeType) continue
      typeItems.push(navItem(`type:${type}`, typeMeta(type).title, count))
    }
    if (typeItems.length) {
      nav.appendChild(el('div', 'plugins-page__nav-label', '按类型'))
      for (const item of typeItems) nav.appendChild(item)
    }

    const contributedPages = allPlugins.reduce((total, plugin) => (
      total + (Array.isArray(plugin.pages) ? plugin.pages.length : 0)
    ), 0)
    nav.appendChild(el('div', 'plugins-page__nav-label', '入口'))
    nav.appendChild(navItem('pages', '插件页面', contributedPages))

    nav.appendChild(el('div', 'plugins-page__nav-label', '配置'))
    nav.appendChild(navItem('install', '安装插件'))
    nav.appendChild(navItem('market', '插件源', Array.isArray(marketState.sources) ? marketState.sources.length : 0))
    nav.appendChild(navItem('trust', '受信任公钥', trustedKeys.length))

    // 清单变了可能让当前板块从"空"变"有"（或反之），高亮与内容都要跟着对一次。
    applyActiveBoard()
  }

  /** 把「当前板块」落到界面上：rail 高亮 + 面板显隐 + 顶栏文案 + 列表重画。 */
  function applyActiveBoard () {
    for (const item of nav.querySelectorAll('[data-plugin-board]')) {
      const on = item.getAttribute('data-plugin-board') === activeBoard
      item.classList.toggle('is-active', on)
      if (on) item.setAttribute('aria-current', 'true')
      else item.removeAttribute('aria-current')
    }

    // 搜索只作用于插件板块：插件源 / 公钥各有自己的筛选，共用一条词只会互相误导。
    const pluginBoard = isPluginBoard(activeBoard)
    searchField.hidden = !pluginBoard || activeBoard === 'type:userscript-plugin'
    listPanel.hidden = !pluginBoard
    skillsBoard.element.hidden = activeBoard !== 'type:ai-skill-plugin'
    userScriptsBoard.element.hidden = activeBoard !== 'type:userscript-plugin'
    pluginPagesBoard.element.hidden = activeBoard !== 'pages'
    for (const key of Object.keys(panels)) panels[key].hidden = activeBoard !== key

    // 出口跟着板块走：只有声明了出口的板块才出现（其余板块上它没有意义）
    const link = BOARD_LINKS[activeBoard]
    boardLink.hidden = !link
    if (link) {
      boardLinkName.textContent = link.label
      boardLinkHint.textContent = link.hint || ''
      boardLink.setAttribute('data-page-host', link.host)
    }

    renderTopbar()
    if (pluginBoard) renderList()
  }

  function selectBoard (key: string): void {
    if (key === activeBoard) return
    activeBoard = key
    try {
      const next = `#${activeBoard.startsWith('type:') ? activeBoard.slice(5) : activeBoard}`
      if (location.hash !== next) history.replaceState(null, '', next)
      localStorage.setItem('hira.plugins.board', activeBoard)
    } catch (_) { /* 非关键状态，存储失败不阻断切换 */ }
    // 换板块 = 换一块内容：沿用上一块的滚动位置会让人以为"新板块是空的"。
    content.scrollTop = 0
    applyActiveBoard()
  }

  window.addEventListener('hashchange', () => {
    const next = boardFromHash(location.hash)
    if (!next || next === activeBoard) return
    activeBoard = next
    content.scrollTop = 0
    applyActiveBoard()
  })

  // ── 事件委托：每块数据挂**一个** listener ──────────────────────────
  // 公钥区与插件源区各自挂在自己的块上：它们的 DOM 与插件列表是两套数据，
  // 混在一个委托人里只会让"这个按钮属于哪一块"变得要靠猜。插件列表同理。
  trust.addEventListener('click', (e: MouseEvent) => {
    const del = eventButton(e, '[data-plugin-trust-remove]')
    if (!del) return
    e.stopPropagation()
    emit({
      type: 'trust-remove',
      keyId: del.getAttribute('data-plugin-trust-remove') || '',
      // 级别必须一起带上：不同级别允许同名公钥，只给 keyId 无法确定删的是哪一个
      level: del.getAttribute('data-plugin-trust-level') || 'community'
    })
  })

  market.addEventListener('click', (e: MouseEvent) => {
    const move = eventButton(e, '[data-plugin-market-move]')
    if (move && !move.disabled) {
      e.stopPropagation()
      emit({
        type: 'market-move-source',
        url: move.getAttribute('data-plugin-market-move') || '',
        direction: Number(move.getAttribute('data-direction')) || 0
      })
      return
    }
    const removeSource = eventButton(e, '[data-plugin-market-remove-source]')
    if (removeSource) {
      e.stopPropagation()
      emit({ type: 'market-remove-source', url: removeSource.getAttribute('data-plugin-market-remove-source') || '' })
      return
    }
    const btn = eventButton(e, '[data-plugin-market-install]')
    if (!btn) return
    e.stopPropagation()
    emit({ type: 'market-install', id: btn.getAttribute('data-plugin-market-install') || '' })
  })

  list.addEventListener('click', (e: MouseEvent) => {
    const pageButton = eventButton(e, '[data-plugin-open-page]')
    if (pageButton && !pageButton.disabled) {
      e.stopPropagation()
      emit({
        type: 'page-open',
        pluginId: pageButton.getAttribute('data-plugin-page-owner') || '',
        url: pageButton.getAttribute('data-plugin-open-page') || '',
        title: pageButton.getAttribute('data-plugin-page-title') || ''
      })
      return
    }
    // 授权弹窗的两个动作**先判**：它们与开关同在一个列表里，
    // 先判开关会让授权按钮的点击被 closest('[data-plugin-switch]') 的 null 短路吞掉。
    const grant = eventButton(e, '[data-plugin-grant]')
    if (grant) {
      e.stopPropagation()
      emit({
        type: 'grant',
        id: grant.getAttribute('data-plugin-grant') || '',
        // scopes **由插件清单带回来**，UI 不自己拼（与主进程的"取交集"校验配合）
        scopes: grant.getAttribute('data-plugin-scopes') || ''
      })
      return
    }
    const deny = eventButton(e, '[data-plugin-deny]')
    if (deny) {
      e.stopPropagation()
      emit({ type: 'deny', id: deny.getAttribute('data-plugin-deny') || '' })
      return
    }
    // 「重新加载」与「卸载」同样**先判于开关**：它们与开关并列在行尾动作区。
    const reload = eventButton(e, '[data-plugin-reload]')
    if (reload && !reload.disabled) {
      e.stopPropagation()
      emit({ type: 'reload', id: reload.getAttribute('data-plugin-reload') || '' })
      return
    }
    const uninstall = eventButton(e, '[data-plugin-uninstall]')
    if (uninstall && !uninstall.disabled) {
      e.stopPropagation()
      emit({ type: 'uninstall', id: uninstall.getAttribute('data-plugin-uninstall') || '' })
      return
    }
    const sw = eventButton(e, '[data-plugin-switch]')
    if (!sw || sw.disabled) return
    e.stopPropagation()
    emit({
      type: 'toggle',
      id: sw.getAttribute('data-plugin-id') || '',
      enabled: sw.getAttribute('aria-checked') !== 'true'
    })
  })

  /**
   * 一行插件 = 主体 + 行尾动作区（重新加载 / 卸载 / 开关）。
   *
   * 两条按钮的显示条件（判据都在数据上，不在这里自己拼）：
   *   · 「重新加载」—— 只要是装好的插件就给（改完代码不必重启整个浏览器）；
   *   · 「卸载」   —— **只对运行时安装的**出现。内置插件的文件在应用安装目录里，
   *                  删掉等于自毁；不可禁用的同理。
   */
  function renderRow (plugin: unknown, index: Map<string, PluginRecord>): HTMLElement {
    const record = readPlugins([plugin])[0]
    if (!record) return el('div', 'plugins-page__row plugins-page__muted', '插件数据无效')
    const row = el('div', 'plugins-page__row' + (record.enabled ? '' : ' plugins-page__row--disabled'))
    row.appendChild(buildRowMain(record, index))

    const actions = el('div', 'plugins-page__row-actions')
    if (record.installed) {
      const reloadBtn = el('button', 'btn-mini', '重新加载')
      reloadBtn.type = 'button'
      reloadBtn.setAttribute('data-plugin-reload', record.id)
      reloadBtn.title = '重新读取 manifest 与代码并重启该插件（开发插件时用）'
      actions.appendChild(reloadBtn)
    }
    if (record.runtime === true && record.nonDisableable !== true) {
      const uninstallBtn = el('button', 'btn-mini btn-danger', '卸载')
      uninstallBtn.type = 'button'
      uninstallBtn.setAttribute('data-plugin-uninstall', record.id)
      uninstallBtn.title = '从用户插件目录里删除它（会先停用；此操作不可撤销）'
      actions.appendChild(uninstallBtn)
    }
    actions.appendChild(buildSwitch(record))
    row.appendChild(actions)
    return row
  }

  // 首次首帧就把板块显隐与 rail 高亮落到正确状态，避免数据回来前技能/用户脚本区短暂同时出现。
  renderNav()

  /** 意图出口 —— 由下面装配时接到内核上（视图不认识控制器）。 */
  let emit: PluginDispatch = () => {}

  return {
    element: root,
    /** 宿主装配完成后把内核的 dispatch 接进来。 */
    connect (dispatch: PluginDispatch): void {
      emit = dispatch
      const acceptUnknown = (intent: unknown): unknown => {
        return isRecord(intent) ? dispatch(intent) : undefined
      }
      // 技能板块的提示也走页面唯一的提示口径（不弹窗）。
      skillsBoard.connect(acceptUnknown, (text?, kind?) => showNotice(notice, text, kind))
      userScriptsBoard.connect(acceptUnknown)
      pluginPagesBoard.connect(acceptUnknown)
    },
    setItems (plugins: unknown): void {
      allPlugins = readPlugins(plugins)
      pluginsLoaded = true
      pluginPagesBoard.setPlugins(allPlugins)
      // rail 的计数与顶栏的汇总说的都是**全量**（与搜索无关）：跟着搜索变会让
      // "我搜了个不存在的词，于是插件好像都被删了"。renderNav 末尾会对齐当前板块。
      renderNav()
    },
    setItemsError (): void {
      pluginsLoaded = true
      list.textContent = ''
      list.appendChild(el('div', 'empty', '插件清单读取失败，请点击刷新重试'))
      pluginPagesBoard.setError('插件清单读取失败，暂时无法列出插件页面')
    },
    setTrustedKeys (keys: unknown): void {
      trustedKeys = readTrustedKeys(keys)
      renderTrust()
      renderNav()
    },
    setMarket (state: unknown): void {
      marketState = readMarketState(state)
      renderMarket()
      renderNav()
    },
    /** AI 技能：全量清单 + kind 元数据（插件贡献与用户自建已由引擎合并）。 */
    setSkills (skills: unknown, kinds: unknown): void {
      skillsBoard.setSkills(Array.isArray(skills) ? skills : [], Array.isArray(kinds) ? kinds : [])
    },
    setSkillsError (message: string): void {
      skillsBoard.setError(message)
    },
    setUserScripts (items: unknown): void {
      userScriptsBoard.setScripts(Array.isArray(items) ? items : [])
    },
    setUserScriptsError (message: string): void {
      userScriptsBoard.setError(message)
    },
    setNotice (text: string, kind?: 'info' | 'error'): void {
      showNotice(notice, text, kind)
    }
  }
}

/**
 * 宿主端口：把 IPC 路由包成内核认识的形状。
 *
 * 与 `renderer/shared/plugins-client.js` **同一条契约**（同一批路由、同样省略可选字段），
 * 但这里走内部页的 `rpc`：页面只有桥，拿不到打包后的 client 模块。
 * 返回形状一律保持主进程原样（`{ ok, ... }` / 数组），内核据此判断成功与原因。
 */
const clients: PluginClientPort = {
  list: (): Promise<PluginRecord[]> => rpc<{ plugins?: unknown[] }>(IPC_ROUTES.pluginsList).then((res) => readPlugins(res.plugins)),
  listTrustedKeys: (): Promise<TrustedKeyRecord[]> => rpc<{ keys?: unknown[] }>(IPC_ROUTES.pluginsTrustList).then((res) => readTrustedKeys(res.keys)),
  listUserScripts: (): Promise<unknown[]> => rpc<{ scripts?: unknown[] }>(IPC_ROUTES.pluginsListUserscripts, {}).then((res) => res.scripts || []),
  setUserScriptEnabled: (key: string, enabled: boolean) => rpc<PluginActionResult>(IPC_ROUTES.pluginsSetUserscriptEnabled, {
    key,
    enabled
  }),
  openPage: (url: string) => rpc<PluginActionResult>(IPC_ROUTES.tabNew, {
    url,
    openInBackground: false
  }),
  setEnabled: (id: string, enabled: boolean, opts: { cascade?: boolean } = {}) => rpc<PluginActionResult>(IPC_ROUTES.pluginsSetEnabled, {
    id,
    enabled,
    cascade: opts.cascade === true
  }),
  grantPermissions: (id: string, scopes: unknown) => rpc<PluginActionResult>(IPC_ROUTES.pluginsGrantPermissions, {
    id,
    scopes: Array.isArray(scopes) ? scopes.map(String) : []
  }),
  reload: (id: string) => rpc<PluginActionResult>(IPC_ROUTES.pluginsReload, { id }),
  openPluginDir: () => rpc<PluginActionResult>(IPC_ROUTES.pluginsOpenDir, {}),
  // 渲染层不需要任何本地路径能力：`path` 省略时由主进程弹系统选择框。
  installPlugin: (opts: { source?: string; overwrite?: boolean } = {}) => rpc<PluginActionResult>(IPC_ROUTES.pluginsInstall, {
    source: opts.source === 'archive' ? 'archive' : 'directory',
    overwrite: opts.overwrite === true
  }),
  installUserscript: (opts: { text?: string; overwrite?: boolean } = {}) => {
    const payload: { text?: string; overwrite: boolean } = { overwrite: opts.overwrite === true }
    if (opts.text) payload.text = String(opts.text)
    return rpc<PluginActionResult>(IPC_ROUTES.pluginsInstallUserscript, payload)
  },
  uninstallPlugin: (id: string) => rpc<PluginActionResult>(IPC_ROUTES.pluginsUninstall, { id }),
  addTrustedKey: (opts: { overwrite?: boolean; level?: string | number } = {}) => {
    const payload: { overwrite: boolean; level?: string } = { overwrite: opts.overwrite === true }
    if (opts.level) payload.level = String(opts.level)
    return rpc<PluginActionResult>(IPC_ROUTES.pluginsTrustAdd, payload)
  },
  removeTrustedKey: (keyId: string, level?: string) => {
    const payload: { keyId: string; level?: string } = { keyId }
    if (level) payload.level = String(level)
    return rpc<PluginActionResult>(IPC_ROUTES.pluginsTrustRemove, payload)
  },
  marketList: (opts: { force?: boolean } = {}) => rpc<PluginMarketListResult>(IPC_ROUTES.pluginsMarketList, { force: opts.force === true }),
  // 「整表提交」是源列表唯一的写语义（增 / 删 / 排序都是它），见 marketSetSources 契约。
  marketSetSources: (sources: string[]) => rpc<PluginActionResult>(IPC_ROUTES.pluginsMarketSetSources, {
    sources
  }),
  marketInstall: (id: string, opts: { overwrite?: boolean; force?: boolean } = {}) => rpc<PluginActionResult>(IPC_ROUTES.pluginsMarketInstall, {
    id,
    overwrite: opts.overwrite !== false,
    force: opts.force === true
  }),

  // ── AI 技能 ────────────────────────────────────────────────────────
  // 与 `renderer/shared/ai-client.js` 同一批路由；页面只有桥，所以在这里走 rpc。
  aiSkillList: () => rpc<PluginSkillListResult>(IPC_ROUTES.aiSkillList, {}),
  aiSkillSave: (payload: Record<string, unknown>) => rpc<PluginActionResult>(IPC_ROUTES.aiSkillSave, payload),
  aiSkillRemove: (id: string) => rpc<PluginActionResult>(IPC_ROUTES.aiSkillRemove, { id }),
  aiSkillSetEnabled: (id: string, enabled: boolean) => rpc<PluginActionResult>(IPC_ROUTES.aiSkillSetEnabled, { id, enabled }),
  aiSkillExport: (ids: unknown) => rpc<PluginActionResult>(IPC_ROUTES.aiSkillExport, Array.isArray(ids) ? { ids: ids.map(String) } : {}),
  aiSkillImport: () => rpc<PluginActionResult>(IPC_ROUTES.aiSkillImport, {}),
  aiSkillRun: (payload: Record<string, unknown> = {}) => rpc<PluginActionResult>(IPC_ROUTES.aiSkillRun, payload)
}

/**
 * 二次确认 —— 平台原语（`window.confirm`）。
 *
 * 与 `ui/ui-common/src/confirm.ts` 同一实现口径：内部页拿不到那个包（未打包的静态页
 * 只能 import `hira://shared/*`），所以在这里保留同样十几行的薄壳，而**不**自绘模态框 ——
 * 层级 / 遮罩 / 焦点 / Esc 全归平台，且与网页里的 `confirm()` 是同一个观感。
 * 代价同样如实写在这：`danger` / `confirmLabel` 表达不了，所以动作动词已经写进
 * 内核的那句问句里（见 core.ts 的 uninstall / cascade 文案）。
 *
 * @param {{ title?: string, message?: string }} [options]
 * @returns {Promise<boolean>}
 */
function confirmDialog (options: { title?: string; message?: string } = {}) : Promise<boolean> {
  const text = [options.title, options.message].filter(Boolean).join('\n\n') || '确定继续吗？'
  try {
    return Promise.resolve(window.confirm(text) === true)
  } catch (_) {
    return Promise.resolve(false)
  }
}

const view = createPageView()
const controller = createPluginsController({
  clients,
  // 任何来源的插件变更（其它标签 / 本页动作）→ 实时对账刷新。
  on: subscribe,
  confirm: confirmDialog,
  view
})
view.connect(controller.dispatch)

const host = document.getElementById('app')
if (host) host.appendChild(controller.element)
controller.start()
