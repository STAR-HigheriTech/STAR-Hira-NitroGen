// @ts-check
/**
 * @hira-ng/ui-panel-inject —— 网页注入规则面板（J10）。
 *
 * 一条通道服务三件事：**Boosts（自定义 CSS）/ 强制深色 / UserScripts**。
 * 本面板是这条通道的**管理界面**：每个站点一条规则，可单独启用、单独覆盖深色、
 * 进独立窗口写 CSS / JS（见下）。
 *
 * ── 为什么 CSS / JS 编辑器是**独立窗口** ──────────────────────────
 * 侧栏面板宽不过三百来像素，写 CSS/JS 需要的是一屏能放下 40 行代码的地方 ——
 * 挤在窄栏里只能得到一个 58px 高的小盒子（改一行要滚三下）。
 * 这与插件中心 / 主题编辑器 / 查看源代码是同一个判断，所以走同一条路：
 * **新窗口类型 `inject-editor`**（复用 `subwindow` 入口），本包同时导出
 * `windowDefinition`（双形态，学 `ui-panel-themes` / `ui-panel-easel`）。
 *
 * 解耦要点：
 *   · 不直接调 IPC —— 规则读写走注入的 `clients.settings`（面板端口，见 panels/main.js）
 *   · 「存什么形状」由纯层 `@hira-ng/shared-types/page-inject` 决定（面板不自己定协议）
 *   · 不 import apps / 不认识主进程 —— 端口注入，与其它面板同一口径
 */

import type { PanelDefinition, WindowDefinition, PanelContext } from '@hira-ng/ui-common'
import { injectPanelStyles, iconByName } from '@hira-ng/ui-common'
import {
  parseInjectRules,
  serializeInjectRules,
  upsertRuleForHost,
  PAGE_INJECT_SETTING_KEYS,
  SITE_FORCE_DARK_OPTIONS
} from '@hira-ng/shared-types/src/page-inject.mjs'
import type { InjectRule } from '@hira-ng/shared-types/src/page-inject.mjs'
import { siteKeyOf } from '@hira-ng/shared-types/src/url-protocols.mjs'

export { windowDefinition, createInjectEditor, injectEditorStyles } from "./window/index"

const RULES_KEY = PAGE_INJECT_SETTING_KEYS.rules

interface InjectSettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

interface InjectTabsPort {
  projection?: () => Promise<unknown>
  list: () => Promise<unknown>
}

interface UserScriptView {
  key: string
  name?: string
  version?: string
  description?: string
  enabled?: boolean
  pluginId?: string
  match?: string[]
  require?: string[]
}

interface PluginActionResult {
  ok?: boolean
  canceled?: boolean
  reason?: unknown
  id?: unknown
  name?: unknown
}

interface PluginsPort {
  listUserScripts(): Promise<UserScriptView[]>
  setUserScriptEnabled(key: string, enabled: boolean): Promise<PluginActionResult>
  installUserscript(options: Record<string, unknown>): Promise<PluginActionResult>
  openPluginDir(): Promise<PluginActionResult>
  onChanged(listener: () => void): () => void
}

type InjectPanelContext = Omit<PanelContext, 'clients' | 'openWindow'> & {
  clients?: (PanelContext['clients'] & {
    settings?: InjectSettingsPort
    tabs?: InjectTabsPort
    plugins?: PluginsPort
  }) | null
  openWindow?: (type: string) => unknown
}

const PANEL_CSS = `
  .inj-root { padding: 0; box-sizing: border-box; height: 100%; overflow-y: auto; }
  .inj-desc {
    font-size: 11px; line-height: 17px; margin: 0 0 12px;
    color: var(--hira-text-tertiary, #8b8b8b);
  }
  .inj-toolbar { display: flex; gap: 4px; margin-bottom: 8px; }
  .inj-btn {
    font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
    box-sizing: border-box;
    padding: 0; cursor: pointer;
    border: 0; border-radius: var(--hira-radius-sm, 8px);
    background: transparent; color: var(--hira-text-secondary, #6b7280);
    transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  }
  .inj-btn:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.05)); color: var(--hira-text-primary, #1a1a1a); }
  .inj-btn:disabled { opacity: .4; cursor: default; }
  .inj-empty {
    font-size: 12px; line-height: 19px; padding: 48px 20px; text-align: center;
    color: var(--hira-text-tertiary, #8b8b8b);
  }
  .inj-item {
    border: 0; border-radius: var(--hira-radius-md, 10px);
    margin-bottom: 6px; padding: 10px;
    background: var(--hira-surface-soft, rgba(0,0,0,0.035));
  }
  /* 第一行：勾选 + 站点域名（域名独占一行，长主机名不再被按钮挤成省略号）。 */
  .inj-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .inj-host { font-size: 12px; font-weight: 500; line-height: 18px; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 第二行：按钮组（换行显示，不参与上一行的宽度竞争）。 */
  .inj-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .inj-select {
    font-family: inherit; font-size: 12px;
    height: var(--hira-control-height, 32px); box-sizing: border-box; padding: 0 12px;
    border-radius: var(--hira-radius-xs, 6px);
    border: 0; background: var(--hira-field-bg, rgba(0,0,0,0.05)); color: inherit;
    outline: none;
  }
  .inj-select:focus-visible { box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35)); }
  .inj-spacer { flex: 1 1 auto; }
  /* ── 用户脚本分区（Tampermonkey 风格脚本也是插件的一种）──────────────
     与上面的站点规则共用一套列表视觉：分区只是加一条分隔线，不换语言。 */
  .inj-section {
    margin-top: 18px; padding-top: 12px;
    border-top: 1px solid var(--hira-border-soft, rgba(0,0,0,0.08));
  }
  .inj-section-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .inj-section-title {
    font-size: 12px; font-weight: 600; line-height: 18px;
    flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .inj-us-meta {
    font-size: 11px; line-height: 16px; margin-top: 6px;
    color: var(--hira-text-tertiary, #8b8b8b);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .inj-us-status {
    font-size: 11px; line-height: 16px; margin-top: 8px;
    color: var(--hira-text-secondary, #6b7280);
  }
  .inj-us-status.is-error { color: var(--hira-danger, #dc2626); }
`

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '未知错误'
}

function injectLocalStyles(doc: Document) {
  if (doc.getElementById('inj-panel-styles')) return
  const style = doc.createElement('style')
  style.id = 'inj-panel-styles'
  style.textContent = PANEL_CSS
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {InjectPanelContext} ctx 面板端口（clients.settings / clients.tabs / openWindow）
 */
export function createInjectPanel(doc: Document, ctx: PanelContext = {}) {
  injectPanelStyles(doc)
  injectLocalStyles(doc)

  const panelCtx = ctx as InjectPanelContext
  const settings = panelCtx.clients?.settings || null
  const tabs = panelCtx.clients?.tabs || null
  let disposed = false
  let rules: InjectRule[] = []

  // 用户脚本客户端（插件体系的一部分）。端口缺席时整个分区不渲染 ——
  // 这与「站点规则读不到就显示空」不同：能力都没有，就不该给一个点了没反应的按钮。
  const plugins = panelCtx.clients?.plugins || null
  const usAvailable = !!(plugins && typeof plugins.listUserScripts === 'function')
  let userScripts: UserScriptView[] = []

  const root = doc.createElement('div')
  root.className = 'inj-root'

  const desc = doc.createElement('p')
  desc.className = 'inj-desc'
  desc.textContent = '为指定站点注入自定义 CSS / JS，或覆盖「强制深色」。'

  const toolbar = doc.createElement('div')
  toolbar.className = 'inj-toolbar'
  const addBtn = doc.createElement('button')
  addBtn.className = 'inj-btn'
  addBtn.type = 'button'
  addBtn.title = '为当前站点新建规则'
  addBtn.setAttribute('aria-label', addBtn.title)
  const addIcon = iconByName('Plus', doc, { size: 16 })
  if (addIcon) addBtn.appendChild(addIcon)
  toolbar.appendChild(addBtn)

  const list = doc.createElement('div')

  // ── 用户脚本分区 ─────────────────────────────────────────────────
  // 站点规则是「本窗口手写的补丁」，用户脚本是「可分发、可被 AI 生成的插件」。
  // 两者执行时机相同（页面加载完成后注入），所以放在同一块面板里最顺手。
  const usSection = doc.createElement('div')
  usSection.className = 'inj-section'
  usSection.style.display = usAvailable ? '' : 'none'

  const usHead = doc.createElement('div')
  usHead.className = 'inj-section-head'
  const usTitle = doc.createElement('span')
  usTitle.className = 'inj-section-title'
  usTitle.textContent = '用户脚本'
  usTitle.title = 'Tampermonkey 风格的 .user.js：由 Hira 插件提供，在匹配站点上执行'

  const usInstall: HTMLButtonElement = doc.createElement('button')
  usInstall.className = 'inj-btn'
  usInstall.type = 'button'
  usInstall.title = '安装用户脚本（选择 .user.js 文件）'
  usInstall.setAttribute('aria-label', usInstall.title)
  const installIcon = iconByName('Download', doc, { size: 16 })
  if (installIcon) usInstall.appendChild(installIcon)

  const usFolder = doc.createElement('button')
  usFolder.className = 'inj-btn'
  usFolder.type = 'button'
  usFolder.title = '打开插件目录（脚本与其它插件同目录）'
  usFolder.setAttribute('aria-label', usFolder.title)
  const folderIcon = iconByName('Folder', doc, { size: 16 })
  if (folderIcon) usFolder.appendChild(folderIcon)

  usHead.appendChild(usTitle)
  usHead.appendChild(usInstall)
  usHead.appendChild(usFolder)

  const usDesc = doc.createElement('p')
  usDesc.className = 'inj-desc'
  usDesc.textContent = '安装后在匹配站点自动执行，可单独启停。'

  const usList = doc.createElement('div')
  const usStatus = doc.createElement('p')
  usStatus.className = 'inj-us-status'
  usStatus.style.display = 'none'

  usSection.appendChild(usHead)
  usSection.appendChild(usDesc)
  usSection.appendChild(usList)
  usSection.appendChild(usStatus)

  root.appendChild(desc)
  root.appendChild(toolbar)
  root.appendChild(list)
  root.appendChild(usSection)

  async function readRules() {
    if (!settings || typeof settings.get !== 'function') return []
    try {
      return parseInjectRules(await settings.get(RULES_KEY))
    } catch (_) {
      return []
    }
  }

  async function writeRules(next: readonly InjectRule[]) {
    if (!settings || typeof settings.set !== 'function') return false
    try {
      await settings.set(RULES_KEY, serializeInjectRules(next))
      return true
    } catch (_) {
      return false
    }
  }

  /** 当前活动标签的站点键（用于「为当前站点新建规则」）。 */
  async function activeHost() {
    if (!tabs) return ''
    try {
      const listData = await (typeof tabs.projection === 'function' ? tabs.projection() : tabs.list())
      const active = (Array.isArray(listData) ? listData : []).find((item) => (
        !!item && typeof item === 'object' && (item as { active?: unknown }).active === true
      ))
      const url = active && typeof active === 'object' ? (active as { url?: unknown }).url : undefined
      return siteKeyOf(url)
    } catch (_) {
      return ''
    }
  }

  /** 打开 CSS / JS 编辑器窗口（规则按 host 定位；窗口自己去设置里读同一条规则）。 */
  function openEditor(host: string) {
    // ⚠ 「当前要编辑哪个站点」走**设置项**而不是窗口载荷：`openWindow` 只保证开窗口，
    //   载荷不保证被转发。写一个键 = 零依赖、且窗口刷新/重开都还在。
    try { if (settings && typeof settings.set === 'function') settings.set(PAGE_INJECT_SETTING_KEYS.editorHost, host) } catch (_) {}
    if (typeof panelCtx.openWindow === 'function') panelCtx.openWindow('inject-editor')
  }

  function ruleRow(rule: InjectRule) {
    const item = doc.createElement('div')
    item.className = 'inj-item'

    const head = doc.createElement('div')
    head.className = 'inj-head'

    const enabled = doc.createElement('input')
    enabled.type = 'checkbox'
    enabled.checked = rule.enabled !== false
    enabled.title = '启用这条规则'
    enabled.addEventListener('change', async () => {
      rule.enabled = enabled.checked
      await writeRules(rules)
    })

    // 站点域名独占一行：它是这一行的"标题"，不该与后面的控件抢宽度。
    const host = doc.createElement('span')
    host.className = 'inj-host'
    host.textContent = rule.host
    host.title = rule.host

    head.appendChild(enabled)
    head.appendChild(host)

    const actions = doc.createElement('div')
    actions.className = 'inj-actions'

    const dark = doc.createElement('select')
    dark.className = 'inj-select'
    dark.title = '本站点的强制深色覆盖'
    for (const [value, label] of SITE_FORCE_DARK_OPTIONS) {
      const opt = doc.createElement('option')
      opt.value = value
      opt.textContent = label
      dark.appendChild(opt)
    }
    dark.value = rule.forceDark || ''
    dark.addEventListener('change', async () => {
      rule.forceDark = dark.value === 'on' || dark.value === 'off' ? dark.value : null
      await writeRules(rules)
    })

    const edit = doc.createElement('button')
    edit.className = 'inj-btn'
    edit.type = 'button'
    const editIcon = iconByName('Pencil', doc, { size: 16 })
    if (editIcon) edit.appendChild(editIcon)
    edit.setAttribute('aria-label', '编辑 CSS / JS')
    edit.title = '在独立窗口中编辑 CSS / JS（窄面板写不下代码）'
    edit.addEventListener('click', () => openEditor(rule.host))

    const spacer = doc.createElement('span')
    spacer.className = 'inj-spacer'

    const remove = doc.createElement('button')
    remove.className = 'inj-btn'
    remove.type = 'button'
    const removeIcon = iconByName('Trash2', doc, { size: 16 })
    if (removeIcon) remove.appendChild(removeIcon)
    remove.title = '删除该规则'
    remove.setAttribute('aria-label', remove.title)
    remove.addEventListener('click', async () => {
      rules = rules.filter((candidate) => candidate.id !== rule.id)
      await writeRules(rules)
      render()
    })

    actions.appendChild(dark)
    actions.appendChild(edit)
    actions.appendChild(spacer)
    actions.appendChild(remove)

    item.appendChild(head)
    item.appendChild(actions)
    return item
  }

  function render() {
    list.textContent = ''
    if (!rules.length) {
      const empty = doc.createElement('div')
      empty.className = 'inj-empty'
      empty.textContent = '还没有规则。点上面的按钮为当前站点建一条。'
      list.appendChild(empty)
      return
    }
    for (const rule of rules) list.appendChild(ruleRow(rule))
  }

  async function refresh() {
    rules = await readRules()
    if (!disposed) render()
  }

  // ── 用户脚本：读取 / 渲染 / 单条启停 / 安装 ───────────────────────

  function setStatus(text: string, isError: boolean) {
    usStatus.textContent = text || ''
    usStatus.className = 'inj-us-status' + (isError ? ' is-error' : '')
    usStatus.style.display = text ? '' : 'none'
  }

  async function readUserScripts() {
    if (!usAvailable) return []
    try {
      const data = await plugins.listUserScripts()
      return Array.isArray(data) ? data : []
    } catch (error) {
      setStatus(`读取用户脚本失败：${errorMessage(error)}`, true)
      return []
    }
  }

  function userScriptRow(script: UserScriptView) {
    const item = doc.createElement('div')
    item.className = 'inj-item'

    const head = doc.createElement('div')
    head.className = 'inj-head'

    const toggle = doc.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = script.enabled !== false
    toggle.title = '启用这条脚本'

    const name = doc.createElement('span')
    name.className = 'inj-host'
    name.textContent = script.name || script.key || '未命名脚本'
    // 描述常有一句话就够的信息量，塞进 title 比在窄面板里换三行更划算。
    name.title = [name.textContent, script.description].filter(Boolean).join('\n')

    head.appendChild(toggle)
    head.appendChild(name)

    const patterns = Array.isArray(script.match) ? script.match : []
    const requires = Array.isArray(script.require) ? script.require : []
    const meta = doc.createElement('div')
    meta.className = 'inj-us-meta'
    const bits: string[] = []
    if (script.version) bits.push(`v${script.version}`)
    if (script.pluginId) bits.push(script.pluginId)
    if (patterns.length) bits.push(`匹配 ${patterns.length} 条`)
    if (requires.length) bits.push(`@require ${requires.length}`)
    meta.textContent = bits.join(' · ')
    meta.title = patterns.join('\n')

    toggle.addEventListener('change', async () => {
      if (!usAvailable || typeof plugins.setUserScriptEnabled !== 'function') return
      const next = toggle.checked
      toggle.disabled = true
      try {
        const res = await plugins.setUserScriptEnabled(script.key, next)
        if (!res || res.ok !== true) {
          toggle.checked = !next
          setStatus(String(res?.reason || '切换失败'), true)
          return
        }
        script.enabled = next
        setStatus(next ? `已启用「${name.textContent}」` : `已停用「${name.textContent}」`, false)
      } catch (error) {
        toggle.checked = !next
        setStatus(`切换失败：${errorMessage(error)}`, true)
      } finally {
        toggle.disabled = false
      }
    })

    item.appendChild(head)
    item.appendChild(meta)
    return item
  }

  function renderUserScripts() {
    if (!usAvailable) return
    usList.textContent = ''
    if (!userScripts.length) {
      const empty = doc.createElement('div')
      empty.className = 'inj-empty'
      empty.textContent = '还没有用户脚本。点右上角按钮安装一条 .user.js。'
      usList.appendChild(empty)
      return
    }
    for (const script of userScripts) usList.appendChild(userScriptRow(script))
  }

  async function refreshUserScripts() {
    userScripts = await readUserScripts()
    if (!disposed) renderUserScripts()
  }

  usInstall.addEventListener('click', async () => {
    if (!usAvailable || typeof plugins.installUserscript !== 'function') return
    usInstall.disabled = true;
    setStatus('', false)
    try {
      // 不传 path = 由主进程弹系统选择框（渲染层不碰本地路径 API）。
      const res = await plugins.installUserscript({})
      if (res && res.canceled) return
      if (!res || res.ok !== true) {
        setStatus(String(res?.reason || '安装失败'), true)
        return
      }
      setStatus(`已安装「${String(res.name || res.id || '')}」`, false)
      await refreshUserScripts()
    } catch (error) {
      setStatus(`安装失败：${errorMessage(error)}`, true)
    } finally {
      usInstall.disabled = false
    }
  })

  usFolder.addEventListener('click', async () => {
    if (!usAvailable || typeof plugins.openPluginDir !== 'function') return
    try {
      const res = await plugins.openPluginDir()
      if (res && res.ok === false) setStatus(String(res.reason || '未能打开插件目录'), true)
    } catch (error) {
      setStatus(`未能打开插件目录：${errorMessage(error)}`, true)
    }
  })

  // 任一窗口改了插件 / 脚本 → 对账一次。只重读用户脚本，不重读站点规则。
  let unsubscribePlugins: (() => void) | null = null
  if (usAvailable && typeof plugins.onChanged === 'function') {
    try {
      unsubscribePlugins = plugins.onChanged(() => {
        if (!disposed) refreshUserScripts()
      })
    } catch (_) {
      unsubscribePlugins = null
    }
  }

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true
    try {
      const host = await activeHost()
      if (!host) return
      // 归一 + 去重走纯层同一份实现（任何"从站点快捷建规则"的入口都从这里取）。
      const result = upsertRuleForHost(rules, host)
      if (!result.rule) return
      rules = result.rules
      if (result.created) await writeRules(rules)
      render()
    } finally {
      addBtn.disabled = false
    }
  })

  /** 整体对账：站点规则 + 用户脚本（宿主 refresh 走这里）。 */
  async function refreshAll() {
    await Promise.all([refresh(), refreshUserScripts()])
  }

  refreshAll()

  return {
    element: root,
    refresh: refreshAll,
    setItems() {},
    dispose() {
      disposed = true
      if (typeof unsubscribePlugins === 'function') {
        try { unsubscribePlugins() } catch (_) {}
      }
      unsubscribePlugins = null
      root.remove()
    }
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'inject-panel',
  injectStyles: (doc) => {
    injectPanelStyles(doc)
    injectLocalStyles(doc)
  },
  mount(doc, ctx) {
    return createInjectPanel(doc, ctx)
  }
}
