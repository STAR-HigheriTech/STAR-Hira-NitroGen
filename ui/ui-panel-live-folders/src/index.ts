// @ts-check
/**
 * @hira-ng/ui-panel-live-folders —— 侧栏「实时更新」面板（J6 / Arc Live Folders）。
 *
 * 一个**会自己更新的文件夹**：选一个订阅源，新内容自动出现在里面（像收件箱）。
 *
 * 复用而非重造：订阅源的实现（少数派 / Hacker News / dev.to / 离线兜底精选）
 * 与取数、缓存、降级链全部住在共享层 `@hira-ng/shared-types/src/news/`
 * —— **与 NTP 新标签页的新闻组件用的是同一份代码**，这里不新建 RSS 引擎、
 * 不新建 domain、不加任何 IPC。面板只做"选源 + 画列表 + 定时刷新"。
 *
 * 落点说明：源在渲染层直接 fetch（与 NTP 页面同款，第三方 API 带 CORS 头），
 * 缓存写本渲染进程的 localStorage —— 因此**不需要主进程参与**。
 *
 * 接入面（满足工程红线「任何功能 ≥1 接入面」）：
 *   · 面板（本包 + manifest 的 contributes.panels）—— rail 图标栏入口
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  createFaviconBadge,
  resolvePanelOpenTarget,
  openPanelTarget,
  iconByName
} from '@hira-ng/ui-common'
import {
  listProviders,
  defaultProviderId,
  getProvider,
  loadNews,
  relativeTime,
  formatHot
} from '@hira-ng/shared-types/src/news/index.mjs'
import type { NewsItem } from '@hira-ng/shared-types/src/news/service.mjs'

interface LiveFolderTabsPort {
  newTab(input: { url: string }): unknown
}

interface LiveFolderBridge {
  provider: {
    invoke(route: string, payload?: unknown): Promise<unknown>
  }
}

type LiveFoldersContext = Omit<PanelContext, 'clients' | 'bridge'> & {
  clients?: (PanelContext['clients'] & { tabs?: LiveFolderTabsPort }) | null
  bridge?: LiveFolderBridge
}

/** 记住用户选的源（面板渲染进程自己的 localStorage，天然与主窗口隔离）。 */
const SOURCE_KEY = 'hira.livefolders.source'
/** 列表展示条数。 */
const COUNT = 30
/** 自动刷新周期 —— 与共享层缓存 TTL（15 分钟）对齐，避免无谓请求。 */
const AUTO_REFRESH_MS = 15 * 60 * 1000

const STYLE_ID = 'hira-live-folders-panel-styles'

export function injectLiveFoldersStyles(doc: Document): void {
  injectPanelStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .lf-root { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
    .lf-toolbar {
      display: flex; align-items: center; gap: 6px;
      padding: 0 0 8px; margin-bottom: 2px;
    }
    .lf-source {
      flex: 1 1 auto; min-width: 0; font-family: inherit; font-size: 12px;
      height: var(--hira-control-height, 32px); box-sizing: border-box;
      padding: 0 10px;
      border-radius: var(--hira-radius-md, 10px); border: 0;
      background: var(--hira-field-bg, rgba(0,0,0,0.04)); color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer; outline: none;
    }
    .lf-source:focus-visible { box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35)); }
    .lf-refresh {
      flex: 0 0 auto; font-family: inherit;
      display: inline-flex; align-items: center; justify-content: center;
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
      padding: 0; cursor: pointer;
      border: 0; border-radius: var(--hira-radius-sm, 8px);
      background: transparent; color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .lf-refresh:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .lf-refresh:disabled { opacity: 0.4; cursor: default; }
    .lf-list { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-bottom: 8px; }
    .lf-status {
      padding: 48px 20px; text-align: center; font-size: 12px; line-height: 19px;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .lf-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 6px 10px; min-height: var(--hira-row-height, 36px); box-sizing: border-box;
      border-radius: var(--hira-radius-md, 10px); cursor: pointer; contain: layout style;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .lf-item:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .lf-favicon { flex: 0 0 auto; margin-top: 2px; }
    .lf-main { flex: 1 1 auto; min-width: 0; }
    .lf-title {
      font-size: 12px; font-weight: 500; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .lf-meta {
      margin-top: 3px; font-size: 11px; line-height: 15px;
      color: var(--hira-text-tertiary, #8b8b8b);
      display: flex; gap: 6px; overflow: hidden; white-space: nowrap;
    }
    .lf-meta-hot { color: var(--hira-accent, #3b82f6); }
  `
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {LiveFoldersContext} ctx 面板端口（clients.tabs）
 * @returns {{ element: HTMLElement, refresh: () => Promise<void>, setItems: () => void, dispose: () => void }}
 */
export function createLiveFoldersPanel(doc: Document, ctx: PanelContext = {}) : { element: HTMLElement, refresh: () => Promise<void>, setItems: () => void, dispose: () => void } {
  injectLiveFoldersStyles(doc)
  const panelCtx = ctx as LiveFoldersContext
  const tabs = panelCtx.clients?.tabs || null
  let disposed = false
  let source = ''
  let items: NewsItem[] = []
  let loading = false
  let failed = false
  let timer: ReturnType<typeof setInterval> | null = null
  let requestController: AbortController | null = null
  /** 每次请求的序号：并发刷新时只认最后一次结果，避免旧结果覆盖新结果。 */
  let reqSeq = 0

  const root = doc.createElement('div')
  root.className = 'lf-root'

  const toolbar = doc.createElement('div')
  toolbar.className = 'lf-toolbar'
  const select = doc.createElement('select')
  select.className = 'lf-source'
  select.title = '选择订阅源'
  const refreshBtn = doc.createElement('button')
  refreshBtn.className = 'lf-refresh'
  refreshBtn.type = 'button'
  refreshBtn.title = '重新抓取订阅源'
  refreshBtn.setAttribute('aria-label', refreshBtn.title)
  const refreshIcon = iconByName('RefreshCw', doc, { size: 16 })
  if (refreshIcon) refreshBtn.appendChild(refreshIcon)
  toolbar.append(select, refreshBtn)

  const list = doc.createElement('div')
  list.className = 'lf-list'

  root.append(toolbar, list)

  function providerNameOf(id: string) {
    const p = getProvider(id)
    return p ? p.name : id
  }

  function rememberSource(id: string) {
    try { localStorage.setItem(SOURCE_KEY, id) } catch (_) {}
  }

  function recallSource() {
    try { return localStorage.getItem(SOURCE_KEY) || '' } catch (_) { return '' }
  }

  function buildSourceOptions() {
    select.textContent = ''
    for (const p of listProviders()) {
      const opt = doc.createElement('option')
      opt.value = p.id
      opt.textContent = p.name
      select.appendChild(opt)
    }
    if (!source) source = defaultProviderId()
    select.value = source
  }

  function render() {
    list.textContent = ''
    if (!items.length) {
      const status = doc.createElement('div')
      status.className = 'lf-status'
      status.textContent = loading ? '正在更新…' : failed ? '暂时取不到内容，稍后再试。' : '暂无内容。'
      list.appendChild(status)
      return
    }
    for (const item of items) {
      const row = doc.createElement('div')
      row.className = 'lf-item'
      row.title = item.title || item.url || ''
      row.appendChild(createFaviconBadge(doc, null, item.title || item.url, 16, item.url))

      const main = doc.createElement('div')
      main.className = 'lf-main'
      const title = doc.createElement('div')
      title.className = 'lf-title'
      title.textContent = item.title || item.url || ''
      const meta = doc.createElement('div')
      meta.className = 'lf-meta'
      const src = doc.createElement('span')
      src.textContent = item.source || providerNameOf(source)
      meta.appendChild(src)
      const hot = formatHot(item.hot)
      if (hot) {
        const hotEl = doc.createElement('span')
        hotEl.className = 'lf-meta-hot'
        hotEl.textContent = `热度 ${hot}`
        meta.appendChild(hotEl)
      }
      const time = relativeTime(item.time)
      if (time) {
        const timeEl = doc.createElement('span')
        timeEl.textContent = time
        meta.appendChild(timeEl)
      }
      main.append(title, meta)
      row.appendChild(main)

      row.addEventListener('click', (e: MouseEvent) => {
        if (!item.url) return
        // 面板去向规则唯一一份（ui-common#panel-open）：默认新标签，**Alt = 独立侧栏**。
        openPanelTarget(resolvePanelOpenTarget(e), {
          url: item.url,
          title: item.title,
          openTab: (u) => { if (tabs && typeof tabs.newTab === 'function') tabs.newTab({ url: u }) },
          openSidebar: (u, t) => {
            const bridge = panelCtx.bridge
            if (bridge && bridge.provider && typeof bridge.provider.invoke === 'function') {
              bridge.provider.invoke('web-sidebar:open', { url: u, title: t }).catch(() => {})
            }
          }
        })
      })
      list.appendChild(row)
    }
  }

  /**
   * 拉取当前源的条目。`force` 为真时绕过共享层缓存（用户点「刷新」）。
   * @param {boolean} [force]
   */
  async function refresh(force = false) {
    const seq = ++reqSeq
    requestController?.abort()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    requestController = controller
    loading = true
    failed = false
    if (!items.length) render()
    try {
      const res = await loadNews({
        providerId: source,
        limit: COUNT,
        force: !!force,
        signal: controller ? controller.signal : undefined
      })
      // 并发保护：只有最后一次请求的结果能落地。
      if (disposed || seq !== reqSeq) return
      items = res.items || []
      failed = !!res.failed
    } catch (_) {
      if (disposed || seq !== reqSeq) return
      items = []
      failed = true
    } finally {
      if (!disposed && seq === reqSeq) {
        loading = false
        render()
      }
      if (requestController === controller) requestController = null
    }
  }

  select.addEventListener('change', () => {
    source = select.value
    rememberSource(source)
    items = []
    refresh(false)
  })
  refreshBtn.addEventListener('click', () => refresh(true))

  // 启动：恢复上次选的源 → 建下拉 → 拉一次。
  const saved = recallSource()
  const providers = listProviders()
  if (saved && providers.some((p) => p.id === saved)) source = saved
  buildSourceOptions()
  refresh(false)

  /**
   * 定时自动刷新。
   *
   * **不可见时整拍跳过**（与 `download-controller` / `downloads` 页同一个口径）：
   * `refresh(false)` 会 `loadNews()` 发起**网络请求**，而"实时更新"面板挂着不动时
   * 用户根本看不到结果 —— 没人看就不该发。跳过只是错过这一拍，下一次可见时照常刷。
   * 不改成"隐藏即停表 + 可见再起"是因为隐藏/可见切换本身没有事件源（面板是原生视图，
   * 不是标签页），停表还得配一套恢复时机，不值当。
   */
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    refresh(false)
  }, AUTO_REFRESH_MS)

  return {
    element: root,
    refresh: () => refresh(true),
    setItems() {},
    dispose() {
      disposed = true
      requestController?.abort()
      requestController = null
      if (timer) clearInterval(timer)
      timer = null
      root.remove()
    }
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'live-folders-panel',
  injectStyles: injectLiveFoldersStyles,
  mount(doc, ctx) {
    return createLiveFoldersPanel(doc, ctx)
  }
}
