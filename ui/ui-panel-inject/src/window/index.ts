// @ts-check
/**
 * 网页注入规则（J10）· **独立窗口形态**（CSS / JS 编辑器）。
 *
 * 窄面板里只留一行「编辑 CSS / JS…」，真正的代码编辑在这里 —— 与插件中心 /
 * 主题编辑器 / 查看源代码同一个判断：代码需要的是**一屏几十行**，不是 58px 的小盒子。
 *
 * 数据来自设置项 `webview.inject_rules`（与面板同一份），按 `host` 定位到那一条规则；
 * 保存时整串写回（纯层的 parse/serialize 保证形状一致）。侧栏面板会自行重取，不会看到旧值。
 *
 * 端口注入：`ctx.clients.settings`（get/set）、`ctx.host`（要编辑哪个站点）。
 * 本包不认识 IPC / 主进程（ui → apps 的方向被 CONTRACT-11 禁止）。
 */

import type { WindowDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  parseInjectRules,
  serializeInjectRules,
  PAGE_INJECT_SETTING_KEYS,
  SITE_FORCE_DARK_OPTIONS
} from '@hira-ng/shared-types/src/page-inject.mjs'
import type { InjectRule } from '@hira-ng/shared-types/src/page-inject.mjs'

interface InjectSettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

type InjectEditorContext = Omit<PanelContext, 'clients'> & {
  host?: string
  hostSettingKey?: string
  clients?: (PanelContext['clients'] & { settings?: InjectSettingsPort }) | null
}

const RULES_KEY = PAGE_INJECT_SETTING_KEYS.rules
const STYLE_ID = 'inj-editor-styles'

const CSS = `
  .inje-root { display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; }
  .inje-head {
    display: flex; align-items: center; gap: 8px; padding: 10px 16px 6px; flex-shrink: 0;
  }
  .inje-host { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inje-grow { flex: 1 1 auto; }
  .inje-select {
    height: 26px; padding: 0 8px; box-sizing: border-box;
    font-family: inherit; font-size: 11.5px;
    border: 0; border-radius: var(--hira-radius-xs, 6px);
    background: var(--hira-field-bg, rgba(128, 128, 128, 0.10));
    color: inherit; outline: none;
    transition: box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  }
  .inje-select:focus-visible { box-shadow: var(--hira-focus-ring); }
  .inje-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; }
  .inje-field { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
  .inje-label {
    font-size: 11px; font-weight: 500; letter-spacing: .02em;
    color: var(--hira-text-tertiary, #8b8b8b);
  }
  .inje-area {
    flex: 1 1 auto; min-height: 0; width: 100%; box-sizing: border-box; resize: none;
    font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace); font-size: 12px; line-height: 1.6;
    padding: 10px 12px; border-radius: var(--hira-radius-md, 10px);
    border: 0;
    background: var(--hira-field-bg, rgba(128, 128, 128, 0.08));
    color: inherit; tab-size: 2; outline: none;
    transition: box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  }
  .inje-area:focus-visible { box-shadow: var(--hira-focus-ring); }
  .inje-foot {
    display: flex; align-items: center; gap: 6px; padding: 10px 16px; flex-shrink: 0;
    border-top: 1px solid var(--hira-hairline, rgba(128, 128, 128, 0.12));
  }
  .inje-status { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }
  .inje-btn {
    height: 28px; padding: 0 12px; box-sizing: border-box;
    font-family: inherit; font-size: 12px; font-weight: 500;
    cursor: pointer; border-radius: var(--hira-radius-sm, 8px);
    border: 0; background: transparent; color: inherit;
    transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
      color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  }
  .inje-btn:hover { background: var(--hira-surface-soft, rgba(128, 128, 128, 0.12)); }
  .inje-btn.primary { background: var(--hira-accent, #3b82f6); color: var(--hira-on-accent, #fff); }
  .inje-btn.primary:hover { background: color-mix(in srgb, var(--hira-accent, #3b82f6) 88%, #000); }
  .inje-empty {
    padding: 40px 16px; font-size: 12px; line-height: 18px; text-align: center;
    color: var(--hira-text-tertiary, #8b8b8b);
  }
`

export function injectEditorStyles(doc: Document): void {
  if (!doc || !doc.head) return
  const existing = doc.getElementById(STYLE_ID)
  if (existing) { existing.textContent = CSS; return }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {InjectEditorContext} [ctx]
 */
export function createInjectEditor(doc: Document, ctx: PanelContext = {}) {
  const editorCtx = ctx as InjectEditorContext
  const settings = editorCtx.clients?.settings || null
  let host = String(editorCtx.host || '')
  let ruleId = ''
  let disposed = false

  const root = doc.createElement('div')
  root.className = 'inje-root'

  const head = doc.createElement('div')
  head.className = 'inje-head'
  const hostEl = doc.createElement('span')
  hostEl.className = 'inje-host'
  hostEl.textContent = host || '（未指定站点）'
  hostEl.title = host
  const grow = doc.createElement('span')
  grow.className = 'inje-grow'

  const enabled = doc.createElement('input')
  enabled.type = 'checkbox'
  enabled.title = '启用这条规则'

  const dark = doc.createElement('select')
  dark.className = 'inje-select'
  dark.title = '本站点的强制深色覆盖'
  for (const [value, label] of SITE_FORCE_DARK_OPTIONS) {
    const opt = doc.createElement('option')
    opt.value = value
    opt.textContent = label
    dark.appendChild(opt)
  }

  head.appendChild(hostEl)
  head.appendChild(grow)
  head.appendChild(enabled)
  head.appendChild(dark)

  const body = doc.createElement('div')
  body.className = 'inje-body'

  function field(labelText: string, placeholder: string) {
    const wrap = doc.createElement('div')
    wrap.className = 'inje-field'
    const label = doc.createElement('div')
    label.className = 'inje-label'
    label.textContent = labelText
    const area = doc.createElement('textarea')
    area.className = 'inje-area'
    area.placeholder = placeholder
    area.spellcheck = false
    area.addEventListener('input', () => setStatus('未保存'))
    wrap.appendChild(label)
    wrap.appendChild(area)
    return { wrap, area }
  }

  const cssField = field('自定义 CSS', '例如：.ad-banner { display: none !important; }')
  const jsField = field('自定义 JS（用户脚本）', '例如：document.body.dataset.hira = "1"')
  body.appendChild(cssField.wrap)
  body.appendChild(jsField.wrap)

  const foot = doc.createElement('div')
  foot.className = 'inje-foot'
  const status = doc.createElement('span')
  status.className = 'inje-status'
  function setStatus(text: unknown) { status.textContent = String(text || '') }
  const grow2 = doc.createElement('span')
  grow2.className = 'inje-grow'
  const reload = doc.createElement('button')
  reload.className = 'inje-btn'
  reload.type = 'button'
  reload.textContent = '重新载入'
  const save = doc.createElement('button')
  save.className = 'inje-btn primary'
  save.type = 'button'
  save.textContent = '保存'

  foot.appendChild(status)
  foot.appendChild(grow2)
  foot.appendChild(reload)
  foot.appendChild(save)

  root.appendChild(head)
  root.appendChild(body)
  root.appendChild(foot)

  async function readRules() {
    if (!settings || typeof settings.get !== 'function') return []
    try { return parseInjectRules(await settings.get(RULES_KEY)) } catch (_) { return [] }
  }

  let rules: InjectRule[] = []
  function currentRule() { return rules.find((rule) => rule.id === ruleId) || null }

  function fillForm() {
    const rule = currentRule()
    if (!rule) {
      setStatus(host ? '没有找到该站点的规则' : '未指定站点')
      cssField.area.value = ''
      jsField.area.value = ''
      return
    }
    enabled.checked = rule.enabled !== false
    dark.value = rule.forceDark || ''
    cssField.area.value = rule.css || ''
    jsField.area.value = rule.js || ''
    setStatus('')
  }

  async function load() {
    // 站点从哪来：优先构造参数（窗口载荷），否则读面板写下的设置项
    //（面板只负责"开窗"，不保证载荷被转发 —— 见 panel/index.js）。
    if (!host && editorCtx.hostSettingKey && settings && typeof settings.get === 'function') {
      try { host = String((await settings.get(editorCtx.hostSettingKey)) || '') } catch (_) { host = '' }
      hostEl.textContent = host || '（未指定站点）'
      hostEl.title = host
    }
    rules = await readRules()
    const rule = rules.find((candidate) => candidate.host === host)
    ruleId = rule ? rule.id : ''
    if (disposed) return
    fillForm()
  }

  async function persist() {
    const rule = currentRule()
    if (!rule) { setStatus('没有可保存的规则'); return }
    if (!settings || typeof settings.set !== 'function') { setStatus('设置通道不可用'); return }
    rule.enabled = enabled.checked
    rule.forceDark = dark.value === 'on' || dark.value === 'off' ? dark.value : null
    rule.css = cssField.area.value
    rule.js = jsField.area.value
    try {
      await settings.set(RULES_KEY, serializeInjectRules(rules))
      setStatus('已保存 · 该站点的页面刷新后生效')
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '未知错误'
      setStatus(`保存失败：${message}`)
    }
  }

  save.addEventListener('click', persist)
  reload.addEventListener('click', load)

  // Ctrl/Cmd+S 保存（写代码的人的手癖；本窗口没有别的保存入口冲突）。
  doc.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
      event.preventDefault()
      persist()
    }
  })

  load()

  return {
    element: root,
    reload: load,
    dispose() { disposed = true; root.remove() }
  }
}

/** 窗口形态定义（宿主 `subwindow/windows/inject-editor.js` 按同形契约挂载）。 */
export const windowDefinition: WindowDefinition = {
  id: 'inject-editor',
  injectStyles: injectEditorStyles,
  mount(doc, ctx) {
    return createInjectEditor(doc, ctx)
  }
}
