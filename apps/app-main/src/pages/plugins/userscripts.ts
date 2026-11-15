// @ts-check
/** 插件中心 · 用户脚本板块。数据来自 `plugins:list-userscripts`，启停粒度是单条脚本。 */
import { el } from 'hira://shared/runtime.js'
import { actionButton, toggleButton } from './controls.js'

export interface UserScriptSummary {
  key: string
  id?: string
  pluginId?: string
  name?: string
  namespace?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  runAt?: string
  match?: string[]
  include?: string[]
  exclude?: string[]
  grant?: string[]
  require?: string[]
  connect?: string[]
  order?: number
  file?: string
  enabled?: boolean
}

export type UserScriptDispatch = (intent: Record<string, unknown>) => unknown

export interface UserScriptsBoard {
  element: HTMLElement
  connect(dispatch: UserScriptDispatch): void
  setScripts(items: unknown): void
  setError(message?: string): void
  refresh(): void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readScript(value: unknown, index: number): UserScriptSummary | null {
  const row = asRecord(value)
  if (!row) return null
  const key = String(row.key || '').trim()
  if (!key) return null
  return {
    key,
    id: row.id == null ? undefined : String(row.id),
    pluginId: row.pluginId == null ? undefined : String(row.pluginId),
    name: row.name == null ? undefined : String(row.name),
    namespace: row.namespace == null ? undefined : String(row.namespace),
    version: row.version == null ? undefined : String(row.version),
    description: row.description == null ? undefined : String(row.description),
    author: row.author == null ? undefined : String(row.author),
    homepage: row.homepage == null ? undefined : String(row.homepage),
    runAt: row.runAt == null ? undefined : String(row.runAt),
    match: stringList(row.match),
    include: stringList(row.include),
    exclude: stringList(row.exclude),
    grant: stringList(row.grant),
    require: stringList(row.require),
    connect: stringList(row.connect),
    order: Number.isFinite(Number(row.order)) ? Number(row.order) : index,
    file: row.file == null ? undefined : String(row.file),
    enabled: row.enabled === true
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function matches(script: UserScriptSummary, query: string): boolean {
  if (!query) return true
  return [
    script.name,
    script.id,
    script.pluginId,
    script.description,
    script.author,
    ...(script.match || []),
    ...(script.include || [])
  ].some((value) => String(value || '').toLowerCase().includes(query))
}

export function createUserScriptsBoard(): UserScriptsBoard {
  const element = el('section', 'plugins-userscripts')
  element.hidden = true

  const toolbar = el('div', 'plugins-userscripts__toolbar')
  const search = /** @type {HTMLInputElement} */ (el('input', 'plugins-board__input plugins-userscripts__search'))
  search.type = 'text'
  search.placeholder = '搜索脚本、来源或匹配站点…'
  search.spellcheck = false
  search.setAttribute('aria-label', '搜索用户脚本')
  const refreshButton = actionButton('刷新', {
    small: true,
    onClick: () => requestRefresh()
  })
  const installFileButton = actionButton('安装文件', {
    small: true,
    onClick: () => emit({ type: 'install', source: 'userscript' })
  })
  const pasteButton = actionButton('粘贴安装', {
    small: true,
    onClick: () => {
      installForm.hidden = false
      installText.focus()
    }
  })
  toolbar.append(search, installFileButton, pasteButton, refreshButton)

  const installForm = el('div', 'plugins-userscripts__install')
  installForm.hidden = true
  const installText = /** @type {HTMLTextAreaElement} */ (el('textarea', 'plugins-userscripts__install-input'))
  installText.rows = 7
  installText.spellcheck = false
  installText.placeholder = '粘贴完整的 UserScript，需包含 ==UserScript== 元数据头'
  installText.setAttribute('aria-label', '用户脚本内容')
  const installHint = el('div', 'plugins-userscripts__install-hint', '安装后会进入用户插件目录，可在这里单独启停。')
  const installActions = el('div', 'plugins-userscripts__install-actions')
  const installTextButton = actionButton('安装', {
    primary: true,
    small: true,
    disabled: true,
    onClick: () => {
      const text = installText.value.trim()
      if (!text) return
      installTextButton.disabled = true
      installTextButton.textContent = '安装中…'
      Promise.resolve()
        .then(() => emit({ type: 'userscript-install-text', text }))
        .then((value) => {
          const res = asRecord(value)
          if (res?.ok === true) {
            installText.value = ''
            installForm.hidden = true
          }
        })
        .catch(() => {
          installHint.textContent = '安装没有完成，请查看页面顶部的提示。'
        })
        .finally(() => {
          installTextButton.textContent = '安装'
          installTextButton.disabled = !installText.value.trim()
        })
    }
  })
  const cancelInstall = actionButton('取消', {
    small: true,
    onClick: () => {
      installForm.hidden = true
      installText.value = ''
      installHint.textContent = '安装后会进入用户插件目录，可在这里单独启停。'
      installTextButton.disabled = true
    }
  })
  installActions.append(installTextButton, cancelInstall)
  installForm.append(installText, installActions, installHint)
  installText.addEventListener('input', () => {
    installTextButton.disabled = !installText.value.trim()
  })

  const status = el('div', 'plugins-userscripts__status')
  const body = el('div', 'plugins-userscripts__body')
  element.append(toolbar, installForm, status, body)

  let scripts: UserScriptSummary[] = []
  let query = ''
  let loading = true
  let error = ''
  let emit: UserScriptDispatch = () => undefined

  function requestRefresh() {
    loading = true
    error = ''
    render()
    emit({ type: 'userscript-refresh' })
  }

  function scriptCard(script: UserScriptSummary) {
    const card = el('article', 'plugins-userscripts__card')
    if (!script.enabled) card.classList.add('is-off')

    const head = el('div', 'plugins-userscripts__card-head')
    const title = el('div', 'plugins-userscripts__title', script.name || script.id || '未命名脚本')
    title.title = title.textContent || ''
    const state = el('span', 'plugins-userscripts__badge', script.enabled ? '运行中' : '已关闭')
    state.classList.toggle('is-off', !script.enabled)
    if (script.version) head.append(title, el('span', 'plugins-userscripts__version', `v${script.version}`), state)
    else head.append(title, state)

    const meta = [script.pluginId, script.author, script.runAt].filter(Boolean).join(' · ')
    const metaNode = el('div', 'plugins-userscripts__meta', meta)
    if (script.file) metaNode.title = script.file

    const description = el(
      'p',
      'plugins-userscripts__desc',
      script.description || '这个脚本没有提供说明。'
    )

    const matchesList = stringList(script.match)
    const patterns = matchesList.length ? matchesList : stringList(script.include)
    const patternRow = el('div', 'plugins-userscripts__patterns')
    for (const pattern of patterns.slice(0, 3)) {
      patternRow.appendChild(el('code', 'plugins-userscripts__pattern', pattern))
    }
    if (patterns.length > 3) {
      patternRow.appendChild(el('span', 'plugins-userscripts__more', `+${patterns.length - 3}`))
    }
    if (!patterns.length) patternRow.appendChild(el('span', 'plugins-userscripts__more', '未声明匹配范围'))

    const grants = stringList(script.grant)
    const requirements = stringList(script.require)
    const details = el('div', 'plugins-userscripts__details')
    if (grants.length) details.appendChild(el('span', '', `权限 ${grants.length}`))
    if (requirements.length) details.appendChild(el('span', '', `依赖 ${requirements.length}`))
    if (stringList(script.connect).length) details.appendChild(el('span', '', '允许跨域请求'))
    if (stringList(script.exclude).length) details.appendChild(el('span', '', `排除 ${stringList(script.exclude).length} 个站点`))

    const actions = el('div', 'plugins-userscripts__actions')
    const toggle = toggleButton({
      checked: script.enabled === true,
      title: script.enabled ? '仅关闭这条脚本，插件本身保持启用' : '启用这条脚本（下一次页面加载生效）',
      attributes: {
        'data-userscript-toggle': script.key,
        'aria-label': script.enabled ? `关闭 ${script.name || script.id}` : `启用 ${script.name || script.id}`
      }
    })
    actions.append(toggle)

    card.append(head, metaNode, description, patternRow)
    if (details.childElementCount) card.append(details)
    card.append(actions)
    return card
  }

  function render() {
    refreshButton.disabled = loading
    refreshButton.textContent = loading ? '刷新中…' : '刷新'
    search.hidden = scripts.length === 0 && !loading

    const running = scripts.filter((script) => script.enabled).length
    status.textContent = scripts.length
      ? `共 ${scripts.length} 条 · ${running} 条运行`
      : ''

    body.textContent = ''
    if (error) body.appendChild(el('div', 'plugins-userscripts__error', error))

    if (loading && !scripts.length) {
      body.appendChild(el('div', 'empty', '正在读取用户脚本…'))
      return
    }

    if (!scripts.length) {
      if (!error) {
        const empty = el('div', 'plugins-userscripts__empty')
        empty.append(
          el('div', 'empty-title', '还没有用户脚本'),
          el('div', 'empty-hint', '导入 .user.js 后，可以在这里查看匹配站点并单独启停每一条脚本。'),
          actionButton('安装用户脚本', {
            primary: true,
            onClick: () => emit({ type: 'install', source: 'userscript' })
          })
        )
        body.appendChild(empty)
      }
      return
    }

    const normalizedQuery = query.trim().toLowerCase()
    const visible = scripts.filter((script) => matches(script, normalizedQuery))
    if (!visible.length) {
      body.appendChild(el('div', 'empty', `没有匹配「${query.trim()}」的用户脚本`))
      return
    }

    const grid = el('div', 'plugins-userscripts__grid')
    for (const script of visible) grid.appendChild(scriptCard(script))
    body.appendChild(grid)
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

  element.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-userscript-toggle]')
    if (!button || button.disabled) return
    event.stopPropagation()
    const next = button.getAttribute('aria-checked') !== 'true'
    button.setAttribute('aria-checked', next ? 'true' : 'false')
    button.disabled = true
    const card = button.closest('.plugins-userscripts__card')
    card?.classList.toggle('is-off', !next)
    emit({
      type: 'userscript-toggle',
      key: button.getAttribute('data-userscript-toggle') || '',
      enabled: next
    })
  })

  render()

  return {
    element,
    connect(dispatch) {
      emit = dispatch
    },
    setScripts(items) {
      scripts = (Array.isArray(items) ? items : [])
        .map(readScript)
        .filter((script): script is UserScriptSummary => script !== null)
      loading = false
      error = ''
      render()
    },
    setError(message) {
      loading = false
      error = String(message || '无法读取用户脚本')
      render()
    },
    refresh: requestRefresh
  }
}
