// @ts-check
/** 插件贡献的内部页总览。URL 由主进程随 plugins:list 一并下发。 */
import { el } from 'hira://shared/runtime.js'
import { actionButton } from './controls.js'
import { isPluginPageUrl } from './format.js'

export interface PluginPageSummary {
  id: string
  pluginId: string
  title: string
  entry: string
  dir: string
  host: string
  url: string
  order: number
}

export interface PluginWithPages {
  id: string
  name?: string
  enabled?: boolean
  pages?: PluginPageSummary[]
}

interface PageRow extends PluginPageSummary {
  pluginName: string
  pluginEnabled: boolean
}

export interface PluginPagesBoard {
  element: HTMLElement
  connect(dispatch: (intent: Record<string, unknown>) => unknown): void
  setPlugins(items: PluginWithPages[]): void
  setError(message?: string): void
}

function matches(row: PageRow, query: string): boolean {
  if (!query) return true
  return [row.title, row.pluginName, row.pluginId, row.url]
    .some((value) => String(value || '').toLowerCase().includes(query))
}

export function createPluginPagesBoard(): PluginPagesBoard {
  const element = el('section', 'plugins-contributed-pages')
  element.hidden = true

  const toolbar = el('div', 'plugins-contributed-pages__toolbar')
  const search = /** @type {HTMLInputElement} */ (el('input', 'plugins-board__input plugins-contributed-pages__search'))
  search.type = 'text'
  search.placeholder = '搜索页面、插件或地址…'
  search.spellcheck = false
  search.setAttribute('aria-label', '搜索插件页面')
  toolbar.appendChild(search)

  const status = el('div', 'plugins-contributed-pages__status')
  const list = el('div', 'plugins-contributed-pages__list')
  element.append(toolbar, status, list)

  let rows: PageRow[] = []
  let loading = true
  let error = ''
  let query = ''
  let emit = (_intent: Record<string, unknown>) => {}

  function rowForPage(page: PluginPageSummary, plugin: PluginWithPages): PageRow | null {
    if (!page || !isPluginPageUrl(page.url)) return null
    return {
      ...page,
      pluginName: String(plugin.name || page.pluginId),
      pluginEnabled: plugin.enabled !== false
    }
  }

  function render() {
    search.hidden = !loading && rows.length === 0
    status.textContent = rows.length ? `${rows.length} 个页面 · ${new Set(rows.map((row) => row.pluginId)).size} 个插件` : ''
    list.textContent = ''

    if (error) list.appendChild(el('div', 'plugins-contributed-pages__error', error))
    if (loading) {
      list.appendChild(el('div', 'empty', '正在读取插件页面…'))
      return
    }
    if (!rows.length) {
      if (!error) {
        list.appendChild(el('div', 'empty', '还没有插件贡献内部页。插件在 manifest 的 contributes.pages 中声明后会自动出现在这里。'))
      }
      return
    }

    const normalizedQuery = query.trim().toLowerCase()
    const visible = rows.filter((row) => matches(row, normalizedQuery))
    if (!visible.length) {
      list.appendChild(el('div', 'empty', `没有匹配「${query.trim()}」的插件页面`))
      return
    }

    for (const row of visible) {
      const item = el('article', 'plugins-contributed-pages__row')
      const main = el('div', 'plugins-contributed-pages__main')
      const titleLine = el('div', 'plugins-contributed-pages__title-line')
      titleLine.append(
        el('h2', 'plugins-contributed-pages__title', row.title || row.id),
        el('span', 'plugins-contributed-pages__plugin', row.pluginName)
      )
      if (!row.pluginEnabled) titleLine.appendChild(el('span', 'plugins-contributed-pages__badge', '已停用'))
      main.append(
        titleLine,
        el('code', 'plugins-contributed-pages__url', row.url)
      )

      const action = actionButton('打开', {
        primary: true,
        small: true,
        disabled: !row.pluginEnabled,
        title: row.pluginEnabled ? '在新标签页打开' : '插件已停用，页面当前不可用',
        onClick: () => emit({ type: 'page-open', pluginId: row.pluginId, url: row.url, title: row.title })
      })
      item.append(main, action)
      list.appendChild(item)
    }
  }

  search.addEventListener('input', () => {
    query = search.value
    render()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    search.value = ''
    query = ''
    render()
  })

  render()

  return {
    element,
    connect(dispatch) {
      emit = dispatch
    },
    setPlugins(items) {
      rows = []
      for (const plugin of Array.isArray(items) ? items : []) {
        for (const page of Array.isArray(plugin.pages) ? plugin.pages : []) {
          const row = rowForPage(page, plugin)
          if (row) rows.push(row)
        }
      }
      rows.sort((a, b) => a.order - b.order || a.pluginName.localeCompare(b.pluginName) || a.title.localeCompare(b.title))
      loading = false
      error = ''
      render()
    },
    setError(message) {
      loading = false
      error = String(message || '无法读取插件页面')
      render()
    }
  }
}
