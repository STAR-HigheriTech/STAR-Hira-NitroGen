/**
 * 小组件 · 搜索框（常驻）
 *
 * 它是**网格里的一个普通项** —— 能被拖动、能被缩放，别的组件也就能摆到它上方。
 * 与别的组件只有三处声明不同：`hidden`（不进「添加组件」）、`removable: false`
 * （不给 ✕）、`shape: 'capsule'`（保持胶囊外形，而不是圆角矩形卡）。
 * 板层全部靠声明行事，不需要认识 "search" 这个 id。
 *
 * 输入 → 打开那条路与改造前一致（像网址就直接导航，否则交给默认搜索引擎），
 * 出口统一走 `ctx.openUrl`（与组件里的链接同一个出口）。
 *
 * 输入框右侧的**动作按钮**（「询问 AI」之类）由插件经 `newtab.search-action` 插槽贡献，
 * 见 `create()` 末段。页面不认识 AI，只渲染宿主下发的 `{ id, label, icon, template }`：
 * 回车仍是搜索 / 导航，点按钮才走那条模板（`{query}` 由本页替换）。
 */
import { defineWidget } from '../registry.js'
import { rpc, subscribe, uiIconSvg } from 'hira://shared/runtime.js'
import { buildSearchUrl } from 'hira://shared/search-url.mjs'
// 兜底模板只认内置引擎真源（缺省引擎那条），不在这里再抄一份 bing / google 的地址。
import { DEFAULT_SEARCH_TEMPLATE } from 'hira://shared/search-engines.mjs'
import type { WidgetContext } from '../types.js'

interface SearchAction {
  id: string
  label?: string
  title?: string
  icon?: string
  template: string
}

interface SearchConfig {
  defaultTemplate?: string
  default?: string
  engines?: Record<string, string>
  searchActions?: SearchAction[]
}

/** 规范化输入 → 完整 URL 或 null（是网址则返回 URL，否则返回 null 表示当关键词）。 */
function looksLikeUrl(s: unknown): string | null {
  const v = String(s || '').trim()
  if (!v) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) return v
  // 含点且无空格 → 大概率域名
  if (v.indexOf('.') >= 0 && !/\s/.test(v)) return 'https://' + v
  return null
}

/** 拿不到搜索引擎配置时的兜底 —— 与域层回落同一条（缺省引擎模板）。 */
const FALLBACK_TEMPLATE = DEFAULT_SEARCH_TEMPLATE

defineWidget({
  id: 'search',
  name: '搜索框',
  description: '搜索或输入网址',
  hidden: true,
  removable: false,
  unique: true,
  shape: 'capsule',
  defaultSize: { w: 10, h: 1 },
  minSize: { w: 4, h: 1 },
  // 不再锁死一行高：搜索框和别的卡片一样能改尺寸（宽 / 高都放开）。
  // 改尺寸仍走网格规则——尺寸吸附整格，横向落点归到新宽度下最近的对称锚点（见 widgets/grid.js）。
  // 高度放开后它就是一枚"拉高的胶囊"，输入区自动撑满、文字垂直居中。
  maxSize: { w: 16, h: 6 },
  // 通用外观（底色不透明度 / 背景模糊 / 字体颜色）由注册中心统一注入，
  // 这里不写 —— 与别的组件一致，搜索框的设置里也能调透明度 / 模糊了。
  settings: [],
  create(ctx: WidgetContext) {
    const root = document.createElement('div')
    root.className = 'wg wg-search'

    const form = document.createElement('form')
    form.className = 'wg-search__form'
    form.noValidate = true
    form.innerHTML =
      '<svg class="wg-search__icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M10 2a8 8 0 1 0 5.3 14l4.2 4.2 1.4-1.4-4.2-4.2A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/>' +
      '</svg>'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'wg-search__input'
    input.placeholder = '搜索或输入网址'
    input.autocomplete = 'off'
    input.spellcheck = false
    form.appendChild(input)

    // 动作按钮的宿主：贴在胶囊右端（位置由 CSS 决定），内容由插件贡献。
    // 没有动作时它是**空的**（零尺寸、不占位），输入区右内边距也不动 —— 不用
    // `hidden` 属性收起来：作者样式的 `display:flex` 会盖掉 `[hidden]` 的 UA
    // `display:none`，空容器本身就不产生任何视觉。
    const actions = document.createElement('div')
    actions.className = 'wg-search__actions'
    form.appendChild(actions)

    root.appendChild(form)
    ctx.root.appendChild(root)

    async function submit(raw: string): Promise<void> {
      const q = String(raw || '').trim()
      if (!q) return
      const url = looksLikeUrl(q)
      if (url) {
        ctx.openUrl(url)
        return
      }
      // 记一条搜索词（地址栏与这里共用同一份历史）；失败不影响开新页
      rpc('search:record', { query: q }).catch(() => {})
      // 模板由域层解析后下发（内置引擎名 / 自定义引擎 id 都已被解析成实际模板），
      // 这里只做"模板 → URL"这一步，规则与地址栏同一份。
      let template: string = FALLBACK_TEMPLATE
      try {
        const cfg = await rpc<SearchConfig>('search:config', {})
        if (typeof cfg?.defaultTemplate === 'string' && cfg.defaultTemplate) {
          template = cfg.defaultTemplate
        } else if (cfg?.engines && cfg.default && cfg.engines[cfg.default]) {
          template = cfg.engines[cfg.default]
        }
      } catch (_) {}
      ctx.openUrl(buildSearchUrl(template, q))
    }

    form.addEventListener('submit', (e: SubmitEvent) => {
      e.preventDefault()
      void submit(input.value)
    })

    // Esc 清空输入（搜索框的常规预期）。只在真有内容时吃事件，
    // 否则把 Esc 留给页面（退出自定义模式）。
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && input.value) {
        input.value = ''
        e.stopPropagation()
      }
    })

    // ── 插件动作按钮 ────────────────────────────────────────────────────
    // 清单来自 `search:config.searchActions`（主进程 `newtab.search-action` 插槽汇总）。
    // 本页**不判断任何插件是否启用**：AI 插件在跑就多一枚「询问 AI」，停用它按钮自然消失。
    function actionTarget(action: SearchAction, query: string): string {
      return action.template.split('{query}').join(encodeURIComponent(query))
    }

    /** 把一份动作清单画成按钮（先清空再画，重复调用不会叠出两份）。 */
    function renderActions(rows: SearchAction[]): void {
      actions.replaceChildren()
      // 右内边距先复位：没有动作时要与改造前一模一样。
      input.style.paddingRight = ''
      if (!rows.length) return
      for (const action of rows) {
        const btn = document.createElement('button')
        // type=button：绝不能触发 form 的 submit（那是回车那条路，语义不同）
        btn.type = 'button'
        btn.className = 'wg-search__action'
        btn.dataset.action = action.id
        btn.title = action.title || action.label || ''
        btn.setAttribute('aria-label', action.label || action.id)
        const icon = action.icon ? uiIconSvg(document, action.icon, { size: 16 }) : null
        if (icon) btn.appendChild(icon)
        // 文字与图标**同时**出现：只留一枚雪花图标，用户猜不出它做什么。
        if (action.label) {
          const text = document.createElement('span')
          text.className = 'wg-search__action-label'
          text.textContent = action.label
          btn.appendChild(text)
        }
        // 既没图标也没文字（插件没给）时不留下一个空的点击热区。
        if (!icon && !action.label) btn.textContent = action.id
        btn.addEventListener('click', (e: MouseEvent) => {
          const q = input.value.trim()
          // 空输入没有内容可交出去：把焦点还给输入框（比"点了没反应"明确）
          if (!q) {
            input.focus()
            return
          }
          ctx.openUrl(actionTarget(action, q), e)
        })
        actions.appendChild(btn)
      }
      // 输入区让位：按钮是绝对定位的，宽度得**实测**才知道 —— 动作数量、文案长短
      // （中文「询问 AI」/ 英文「Ask AI」）都不必回头改 CSS 里的像素。
      input.style.paddingRight = (actions.offsetWidth + 22) + 'px'
    }

    /** 拉一次清单并重画（清单没变就什么都不做，避免无谓的重排）。 */
    let actionsKey = ''
    function syncActions() {
      rpc<SearchConfig>('search:config', {}).then((cfg) => {
        const rows = (Array.isArray(cfg?.searchActions) ? cfg.searchActions : [])
          .filter((a: SearchAction) => !!a && typeof a.id === 'string' && typeof a.template === 'string')
        const key = JSON.stringify(rows)
        if (key === actionsKey) return
        actionsKey = key
        renderActions(rows)
      }).catch(() => {})
    }

    syncActions()
    // 插件启停不改本页 URL，只广播 —— 不订阅的话「关掉 AI 插件后按钮还挂着、
    // 打开后要重开标签页才出现」。返回的退订函数交给板层的 destroy。
    const offPlugins = subscribe('plugins:changed', syncActions)
    return { destroy: () => { if (typeof offPlugins === 'function') offPlugins() } }
  }
})
