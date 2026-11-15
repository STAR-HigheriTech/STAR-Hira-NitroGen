/*
 * 设置页渲染逻辑（Hira 风格：本文件 + settings.css + 标准 preload IPC 桥）。
 *
 * 架构：本页是一个**通用渲染器**，不认识任何具体设置项。
 *   - 分区与字段来自主进程 settings:schema（功能模块通过 registerSettingsSection 注册）；
 *   - 值来自 settings:list；写入走 settings:set；外部变更经 settings:changed 同步。
 *   设置页只负责"把 schema 画出来 + 即时反馈"，业务逻辑全在 domain / applier 层。
 *
 * 加载方式：`hira://settings` 的**静态内部页**（`<script type="module" src="./settings.js">`），
 * 与 history / bookmarks / downloads 走的是同一条路 —— 一个普通 ES Module，**没有打包器**。
 * 代价是本页 import 不了 `@hira-ng/*` 共享模块，也因此不直接依赖插件系统（见 §15.11）。
 * 页面只认三样东西：标准 preload 桥（`window.hira`）、`settings:*` IPC、自己的 CSS。
 *
 * 性能（解决"按一下半天才动"）：
 *   1) 启动时拉一次 schema + 一次 list，本地缓存为 UI 唯一真源。
 *   2) 写入走乐观更新：点击当帧翻转换值，IPC 后台发，不等往返。
 *   3) 外部变更（其它窗口改了设置）只就地更新那一个控件（syncControl），
 *      绝不做整页 innerHTML 重建 —— 那才会重放动画、表现为"卡/闪"。
 *   4) 搜索是**纯本地**过滤（schema 已在手，比对 label / key），
 *      零 IPC 往返、零防抖延迟 —— 中文名、键名都能命中。
 */

/**
 * 本页也要吃**主题令牌** —— 与 history / bookmarks / downloads 等内部页**同一条路**：
 * `initTheme()` 把主进程算好的令牌表写进 html + body 的内联变量，并写 `data-theme`。
 *
 * 为什么它是必需的（而不是"本页已经有一套自己的配色"就够）：
 *   · 本页的 `settings.css` 里那套 `:root` / `html[data-theme='dark']` 只是**兜底**，
 *     而 `data-theme` **只有** initTheme 会写 —— 少了这一步，深色分支永远不生效，
 *     整页就停在兜底的浅色上（用户报的"别的内部页都跟着主题变，只有设置不能"）。
 *   · 内联变量优先级最高，接上之后 `--bg / --surface / --text / --accent …`
 *     全部来自主题，与别的内部页**逐字同源**，不需要在本页再抄一份配色。
 */
import { initTheme, type PageRpcRecord } from 'hira://shared/runtime.js'
import { errorMessage, requiredElement } from 'hira://shared/page-kit.js'
// rail 末尾的「更多页面」出口：与插件页共用同一个工厂（落点 / 文案 / 字形只有一份）。
import { createRailMoreLink } from 'hira://shared/rail-more.js'
// 图标字形真源：与本页 rail / 标签条 / 面板同一套 SVG 字面量，不在此手抄。
// 设置大类只有本页知道的字形（滑杆 / 标签栏 / 仪表 / 无障碍 / 文件 / 窗口）留下面，
// 其余能共用的直接取 SHARED_ICON_PATHS —— 避免"同一概念在设置里是另一颗图标"。
import { SHARED_ICON_PATHS } from 'hira://shared/icon-paths.mjs'
// 渲染侧插槽：设置页只声明自己宿主的槽，加载规则与壳层 / 面板共用。
// 设置页仍是静态内部页；构建只打包本入口依赖，不把页面迁进 renderer 构建。
import {
  activateRendererSlots,
  defineRendererSlots,
  onRendererSlotsChanged
} from '../../renderer/shared/plugin-slots.js'
import { pluginsClient } from '../../renderer/shared/plugins-client.js'
import { CUSTOM_WIDGET_SLOT, mountCustomWidgets } from './custom-widgets.js'
import { readSettingsRoute, settingsRouteHref } from './route.js'
import type { SettingsRoute, SettingsRouteState } from './route.js'
import type { SettingsField, SettingsFieldDefinition, SettingsGroupView, SettingsOption, SettingsSection } from './schema.js'
import {
  buildSettingsGroups, createSettingsSchemaIndex, groupIdForSection as resolveGroupIdForSection,
  isFieldVisible as schemaFieldVisible, matchesSettingQuery, normalizeSettingOptions as normalizeOptions,
  toSettingEntries as toEntryList
} from './schema.js'

initTheme()

const initialSettingsRoute = readSettingsRoute(location.search)

defineRendererSlots([CUSTOM_WIDGET_SLOT])

/** rail 末尾的「更多页面」出口：静态锚点，跟在 #nav 后面（不参与 renderNav 重建）。 */
function wireSidebarMore() {
  const nav = document.getElementById('nav')
  if (!nav || !nav.parentNode) return
  if (nav.parentNode.querySelector('.sidebar-more')) return
  const link = createRailMoreLink(document, {
    itemClass: 'nav-item',
    labelClass: 'label',
    extraClass: 'sidebar-more'
  })
  nav.parentNode.insertBefore(link, nav.nextSibling)
}

;(function () {
  'use strict';

  type SettingControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement

  interface RepaintControl {
    repaint(): void
  }

  type ControlEntry = SettingControl | RepaintControl
  type Disposer = () => void

  function isRepaintControl(value: ControlEntry): value is RepaintControl {
    return typeof (value as Partial<RepaintControl>).repaint === 'function'
  }

  // 只保留「设置大类专有」的字形；凡是共享字形集里已有的概念一律引用，不手抄。
  const ICONS: Record<string, string> = {
    sliders: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none"/>',
    search: SHARED_ICON_PATHS.Search,
    shield: SHARED_ICON_PATHS.Shield,
    tabs: '<path d="M3 8h18"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8"/><path d="M9 8V6a1 1 0 011-1h4a1 1 0 011 1v2"/>',
    download: SHARED_ICON_PATHS.Download,
    layers: SHARED_ICON_PATHS.Layers,
    puzzle: SHARED_ICON_PATHS.Puzzle,
    gauge: '<path d="M12 14l4-4"/><path d="M4.5 18a9 9 0 1115 0"/>',
    accessibility: '<circle cx="12" cy="5" r="2"/><path d="M4 9h16"/><path d="M12 9v6"/><path d="M9 20l3-5 3 5"/>',
    globe: SHARED_ICON_PATHS.Globe,
    file: '<path d="M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V7l-4-4z"/><path d="M14 3v4h4"/>',
    palette: SHARED_ICON_PATHS.Palette,
    // 自动化（D2 命令链 / D3 手势）：一道闪电 —— "一次触发，一串动作"。
    automation: SHARED_ICON_PATHS.Zap,
    // 键盘快捷键（Lucide Keyboard）：与标签栏徽标同一套字形语义。
    keyboard: SHARED_ICON_PATHS.Keyboard,
    // 内部页面（浏览器窗口）：一个窗口轮廓 + 标题栏分隔线。
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6" fill="currentColor" stroke="none"/>',
    // 关于 Hira（信息圆点）：设置页最后一个大类的图标。
    info: SHARED_ICON_PATHS.Info
  }

  const bridge = window.hira
  let schema: SettingsSection[] = []           // 分区数组（来自 settings:schema）
  let sections: SettingsSection[] = []         // 同 schema（语义别名，便于阅读）
  let fieldByKey: Record<string, SettingsField> = {}       // key -> field 定义
  let sectionByFieldKey: Record<string, SettingsSection> = {} // key -> 所属 section（深链 / 搜索索引，O(1)）
  let values: Record<string, unknown> = {}           // key -> value（本地缓存，UI 唯一真源）
  let controlEls: Record<string, ControlEntry> = {}       // key -> 控件 DOM（外部变更就地更新用）
  const dependKeys: Record<string, true> = {}     // 依赖键集合：某键变更后需要重排显隐（field.when 的反向索引，避免整页重建）
  const repaintKeys: Record<string, string[]> = {}    // 反向索引：某键变更后需要**就地重绘**的「顺序」型控件（key -> [控件 key]）
  const restartKeys: Record<string, true> = {}    // effect:'restart' 的键集合（由 schema 驱动，页面不认识业务）
  const saveSeq: Record<string, number> = {}        // key -> 最近一次乐观写入序号（失败回滚只认最新请求）
  let restartBase: Record<string, string> = {}      // 键 -> 本页载入时（= 已生效）的值快照
  let restartPending: string[] = []   // 当前偏离已生效值、需重启才生效的键
  // 本轮渲染挂出去、需要在下次 renderContent 前解绑的副作用（轮询定时器 / 全局监听）。
  // 为什么必须集中管理：renderContent 会重建整棵内容树，控件里的 setInterval
  // 不会因为节点游离而自己停 —— 漏一个就多一个永久轮询，反复打主进程。
  let contentDisposers: Disposer[] = []

  function invoke<T = PageRpcRecord>(route: string, payload?: unknown): Promise<T> {
    if (bridge && bridge.provider && typeof bridge.provider.invoke === 'function') {
      return bridge.provider.invoke<T>(route, payload || {})
    }
    return Promise.reject(new Error('window.hira.provider unavailable'))
  }

  /** 插件动态选项不能让整页等一个失联的 Provider；超时后保留 schema 兜底值。 */
  function withTimeout<T>(promise: Promise<T>, ms = 1800): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('设置服务响应超时')), ms)
      promise.then(
        (value) => { window.clearTimeout(timer); resolve(value) },
        (error) => { window.clearTimeout(timer); reject(error) }
      )
    })
  }

  /* ── 默认值：优先字段自带 default，否则按类型推导 ── */
  function defaultFor(field: SettingsField): unknown {
    if (field.default !== undefined) return field.default
    if (field.type === 'toggle') return false
    if (field.type === 'number') return 0
    if (field.type === 'multi-select') return []
    if (field.type === 'record') return null   // 「未启用」= 没有对象，不能退化成 ''
    if (field.type === 'select' && field.options && field.options.length) return field.options[0][0]
    return ''
  }

  function indexSchema(): void {
    sections = schema || []
    const index = createSettingsSchemaIndex(sections)
    fieldByKey = index.fieldByKey
    sectionByFieldKey = index.sectionByFieldKey
    Object.keys(dependKeys).forEach(function (k) { delete dependKeys[k] })
    Object.keys(repaintKeys).forEach(function (k) { delete repaintKeys[k] })
    Object.keys(restartKeys).forEach(function (k) { delete restartKeys[k] })
    Object.assign(dependKeys, index.dependKeys)
    Object.assign(restartKeys, index.restartKeys)
    Object.keys(index.repaintKeys).forEach(function (key) {
      repaintKeys[key] = index.repaintKeys[key].slice()
    })
  }

  /** 依 field.when 判断某设置项当前是否显示（无 when 恒显示）。 */
  function isFieldVisible(f: SettingsField): boolean {
    return schemaFieldVisible(f, values)
  }

  /**
   * 轻提示：保存 / 删除这类「动作已发生」的反馈。2 秒后自动消失，不阻挡操作。
   */
  let toastTimer: number | null = null
  function showToast(text?: string): void {
    if (!text) return
    let el = document.getElementById('toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'toast'
      el.className = 'toast'
      el.setAttribute('role', 'status')
      document.body.appendChild(el)
    }
    el.textContent = text
    // 强制回流后再加 show：连续两次提示也能重新触发过渡
    void el.offsetWidth
    el.classList.add('show')
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () { el.classList.remove('show') }, 1800)
  }

  /**
   * 重新解析某个 `optionsRoute` 的所有下拉。
   *
   * 为什么要它：设置值域会因**用户数据**变化（新建 / 删除自定义搜索引擎）。
   * 保存后不能整页重建（会打断用户），所以只重填受影响的那几个 <select>；
   * 当前值若已不存在（删掉的正是它），回落到第一项并写回。
   */
  function refreshOptionsRoute(route?: string): Promise<void> {
    if (!route) return Promise.resolve()
    return invoke(route, {}).then(normalizeOptions).then(function (options) {
      if (!options || !options.length) return
      Object.keys(fieldByKey).forEach(function (k) {
        const f = fieldByKey[k]
        if (f.optionsRoute !== route) return
        f.options = options
        const el = controlEls[f.key]
        if (!(el instanceof HTMLSelectElement)) return
        const cur = String(values[f.key])
        el.innerHTML = ''
        let matched = false
        options.forEach(function (o) {
          const op = document.createElement('option')
          op.value = String(o[0])
          op.textContent = o[1]
          if (String(o[0]) === cur) { op.selected = true; matched = true }
          el.appendChild(op)
        })
        if (!matched) {
          el.value = String(options[0][0])
          commit(f.key, String(options[0][0]))
        }
      })
    }).catch(function () { /* 拿不到就保留现有选项 */ })
  }

  /**
   * 解析 schema 里的**动态选项源**。
   *
   * 为什么需要：设置项的值域不总是静态的。拼写检查语言就是典型 ——
   * 可用语言清单由 Electron 构建/平台决定，只能运行时问会话；
   * 插件贡献的下拉同理，路由由它自己声明。
   *
   * 声明方式只有一种：`optionsRoute`（任意 IPC 路由，页面无需改动就能支持新分区）。
   *
   * 取不到时**保留原 options**：宁可画一个空列表，也不能因为某个域暂时不可用
   * 就让整页设置渲染失败。
   */
  function resolveDynamicOptions(): Promise<void[]> {
    const pending: Array<Promise<void>> = []
    Object.keys(fieldByKey).forEach(function (key) {
      const f = fieldByKey[key]
      if (!f.optionsRoute) return
      pending.push(
        withTimeout(invoke(f.optionsRoute, {})).then(normalizeOptions).then(function (options) {
          if (options && options.length) f.options = options
        }).catch(function () { /* 保留 schema 里的兜底 options */ })
      )
    })
    return Promise.all(pending)
  }

  function loadAll(): Promise<void> {
    return invoke('settings:list', {}).then(function (all) {
      values = {}
      for (const k in fieldByKey) {
        const f = fieldByKey[k]
        const v = all ? all[k] : undefined
        values[k] = (v === undefined || v === null) ? defaultFor(f) : v
      }
    }).catch(function (e) {
      console.error('[settings] load failed:', e && e.message)
      throw e
    })
  }

  /**
   * 写入设置 —— 乐观更新：本地缓存与 UI 立即变更，IPC 在后台发。
   * 用户点下去的那一帧控件就已经到位，不会等 IPC 往返
   * （那正是"点了半天才动"的来源）。
   */
  function commit(key: string, value: unknown): void {
    const previous = values[key]
    const seq = (saveSeq[key] || 0) + 1
    saveSeq[key] = seq
    values[key] = value
    invoke('settings:set', { key: key, value: value }).catch(function (e) {
      console.error('[settings] save failed:', key, e && e.message)
      if (saveSeq[key] !== seq) return
      values[key] = previous
      if (dependKeys[key] && !query) renderContent()
      else {
        syncControl(key)
        const reps = repaintKeys[key]
        if (reps) reps.forEach(function (k) {
          const control = controlEls[k]
          if (isRepaintControl(control)) control.repaint()
        })
      }
      refreshChangedBadge()
      refreshRestartPending()
      refreshCssVars()
      showToast('保存失败，已恢复原值')
    })
    refreshChangedBadge()
    refreshRestartPending()
    // 该键是某字段显隐的依赖（下拉联动）→ 重建当前分区以刷新显隐
    if (dependKeys[key] && !query) {
      renderContent()
      return
    }
    // 该键只影响「顺序」控件的分组徽标 / 可移动范围（如某栏换到另一侧）→ 就地重绘它。
    // 不做整页重建：顺序表本身没变，重建只会让这一页重放动画、闪一下。
    const reps = repaintKeys[key]
    if (reps) {
      reps.forEach(function (k) {
        const c = controlEls[k]
        if (isRepaintControl(c)) c.repaint()
      })
    }
  }

  /* ── 本页的深/浅由**主题域**决定，这里不再自己算 ──────────────────────
   *
   * 这里曾有一套 `resolveTheme(app.theme)`：`'system'` 看系统的
   * `prefers-color-scheme`，其余非 `'dark'` 一律当 `'light'`。
   * 那是**旧三态**（light / dark / system）时代的产物 —— 而 `app.theme` 现在是
   * **主题 id**（`hira-dark` / `user.xxx` / 插件主题…），落进那个函数里全部命中
   * "非 dark ⇒ light"，于是本页永远停在浅色上：这正是
   * "别的内部页都跟着主题变，只有设置不能"的根因（见文件头 import 处的说明）。
   *
   * 现在深浅只有一个真源：主进程 → `theme:tokens` / `theme:changed` → `initTheme()`。
   * 它给的是**当前生效**的结果（含调度、插件装饰器、私密窗口皮肤），
   * 比在本页重算一遍更准，也少一处"主题系统改了要记得跟着改"的地方。
   */

  /* ── 展示型 CSS 变量（settings:css-vars）：注入 --hira-* 到页面根，
   *    供「设置面板实时预览」消费（打开时拉一次，变更时防抖刷新）。── */
  let cssVarsTimer: number | null = null
  function refreshCssVars(): void {
    if (cssVarsTimer) window.clearTimeout(cssVarsTimer)
    cssVarsTimer = window.setTimeout(function () {
      invoke('settings:css-vars', {}).then(function (vars) {
        if (!vars || typeof vars !== 'object') return
        const root = document.documentElement
        for (const suffix of Object.keys(vars)) {
          root.style.setProperty('--hira-' + suffix, String(vars[suffix]))
        }
      }).catch(function () {})
    }, 120)
  }

  /* ── 偏离默认项徽标（settings:changed-keys）：顶部计数 + title 列出键 ── */
  let changedKeysCache: string[] = []
  let changedKeysTimer: number | null = null
  function renderChangedBadge(): void {
    const badge = document.getElementById('changed-badge') as HTMLButtonElement | null
    if (!badge) return
    if (changedKeysCache.length) {
      const labels = changedKeysCache.map((key) => fieldByKey[key]?.label || key)
      badge.hidden = false
      badge.textContent = String(changedKeysCache.length)
      badge.title = '偏离默认值的设置项：\n' + labels.join('\n')
      badge.setAttribute('aria-label', '有 ' + changedKeysCache.length + ' 项已修改，点击定位')
      badge.onclick = focusFirstChangedSetting
    } else {
      badge.hidden = true
      badge.title = ''
      badge.onclick = null
    }
  }
  function refreshChangedBadge(): void {
    if (changedKeysTimer) window.clearTimeout(changedKeysTimer)
    changedKeysTimer = window.setTimeout(function () {
      invoke('settings:changed-keys', {}).then(function (keys) {
        changedKeysCache = Array.isArray(keys) ? keys : []
        renderChangedBadge()
      }).catch(function () {})
    }, 120)
  }

  /* ── 「需重启生效」跟踪（schema 的 field.effect === 'restart'）──────────
   *
   * 页面不向主进程要「哪些键待重启」：它只需要一份**已生效基线** ——
   * 本页载入时的值就是应用启动时读到的值（重启型设置只在启动读一次）。
   * 之后无论本页写入还是收到 settings:changed，只要 restart 键偏离基线，
   * 就提示「重启后生效」；改回基线（或恢复默认）提示自动消失。
   *
   * 为什么不做成新 IPC：这类提示是「相对本页载入时刻」的判断，
   * 主进程没有会话之外的真源；多窗口各看各的基线反而语义一致。
   */
  function stableValue(v: unknown): string {
    if (v === undefined) return 'null'
    try { return JSON.stringify(v) } catch (e) { return String(v) }
  }

  function captureRestartBaseline(): void {
    restartBase = {}
    Object.keys(restartKeys).forEach(function (k) { restartBase[k] = stableValue(values[k]) })
    refreshRestartPending()
  }

  function refreshRestartPending(): void {
    const next: string[] = []
    Object.keys(restartKeys).forEach(function (k) {
      if (stableValue(values[k]) !== restartBase[k]) next.push(k)
    })
    // 集合没变就不碰 DOM（避免每次按键式写入都触发一次重排）
    if (next.length === restartPending.length && next.every(function (k, i) { return k === restartPending[i] })) return
    restartPending = next
    renderRestartBanner()
  }

  function renderRestartBanner(): void {
    const el = document.getElementById('restart-banner')
    if (!el) return
    if (!restartPending.length) {
      el.hidden = true
      el.textContent = ''
      el.removeAttribute('title')
      return
    }
    const labels = restartPending.map(function (k) {
      const f = fieldByKey[k]
      return (f && f.label) || k
    })
    el.hidden = false
    el.textContent = '以下设置需要重启应用后生效：' + labels.join('、')
    el.title = restartPending.join('\n')
  }

  /* ── 值 ↔ 控件显示值（限速项按 KB/s 展示、按字节存储）── */
  function toDisplay(field: SettingsField): string {
    const v = values[field.key]
    if (field.scale) return String(Math.round((Number(v) || 0) / field.scale))
    return v == null ? '' : String(v)
  }
  function fromDisplay(field: SettingsField, raw: unknown): unknown {
    if (field.type === 'number') {
      let n = Number(raw)
      if (!isFinite(n)) n = 0
      if (field.min !== undefined && n < field.min) n = field.min
      return field.scale ? Math.round(n * field.scale) : n
    }
    return raw
  }

  /* ── 导航层级 ──────────────────────────────────────────────────────
   * rail = **大类**（section.group），内容区 = 该大类下所有分区顺次堆叠。
   * 大类的名字与顺序全部来自 schema（主进程按 SETTINGS_GROUP_ORDER 排好，见
   * packages/shared-types/src/settings-groups.mjs），页面不硬编码任何分组名；
   * 插件注册的分区若没声明 group，落到末尾「其他」—— 于是
   * 「加一个新分区」永远只改 registry，页面零改动。
   *
   * 标题旁的小选项卡只是**页内快捷跳转**：点一下滚到对应分区，滚动时反向高亮。
   * 它不切页、不过滤字段 —— 内容区永远是整个大类（用户要的「只是快捷跳转」）。
   */
  let currentGroup: string | null = null   // 当前大类 id（共享分组表的 id；插件未声明时落 'other'）
  let query = ''
  let routeWriteTimer = 0

  function sectionOfField(key?: string): SettingsSection | null {
    return key && sectionByFieldKey[key] ? sectionByFieldKey[key] : null
  }

  function searchInput(): HTMLInputElement {
    return document.getElementById('q') as HTMLInputElement
  }

  function groupIdForSection(section: SettingsSection | null): string {
    return resolveGroupIdForSection(groupList(), section)
  }

  /** 导航状态只写 URL，不触发整页重载；未知 query 参数原样保留。 */
  function replaceSettingsRoute(patch?: SettingsRouteState, push = false): void {
    if (routeWriteTimer) {
      window.clearTimeout(routeWriteTimer)
      routeWriteTimer = 0
    }
    const next = {
      group: currentGroup,
      section: '',
      key: '',
      query: query
    }
    Object.assign(next, patch || {})
    const href = settingsRouteHref(location.href, next)
    if (href !== location.pathname + location.search + location.hash) {
      if (push) history.pushState(history.state, '', href)
      else history.replaceState(history.state, '', href)
    }
  }

  function scheduleSettingsRoute(patch?: SettingsRouteState): void {
    if (routeWriteTimer) window.clearTimeout(routeWriteTimer)
    routeWriteTimer = window.setTimeout(function () {
      routeWriteTimer = 0
      replaceSettingsRoute(patch)
    }, 100)
  }

  /** 深链落到分区 / 字段：字段优先，滚动后短暂描边，便于从外部入口定位。 */
  function focusSettingsTarget(sectionId = '', key = ''): void {
    requestAnimationFrame(function () {
      const reduceMotion = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth'
      if (sectionId && !key) scrollToSection(sectionId, behavior)
      if (!key) return
      let node = null
      try { node = document.querySelector('[data-setting-key="' + CSS.escape(key) + '"]') } catch (_) {}
      if (!node) return
      node.classList.add('is-deep-link')
      node.scrollIntoView({ block: 'center', behavior: behavior })
      window.setTimeout(function () { node.classList.remove('is-deep-link') }, 1600)
    })
  }

  /** 浏览器前进 / 后退：复用初始装配逻辑，不另维护一套页面状态。 */
  function applySettingsRoute(route: SettingsRoute): void {
    if (routeWriteTimer) {
      window.clearTimeout(routeWriteTimer)
      routeWriteTimer = 0
    }
    const fieldSection = sectionOfField(route.key)
    const section = fieldSection || sections.filter(function (s) { return s.id === route.section })[0] || null
    const groups = groupList()
    const wantedGroup = route.group || groupIdForSection(section) ||
      (groups.some(function (g) { return g.id === route.section }) ? route.section : '')
    const group = groups.filter(function (g) { return !g.href && g.id === wantedGroup })[0] ||
      groups.filter(function (g) { return !g.href })[0] || groups[0]
    currentGroup = group ? group.id : null
    query = route.query
    searchInput().value = query
    renderNav()
    renderContent()
    const content = document.querySelector('.content')
    if (content) content.scrollTop = 0
    focusSettingsTarget(section ? section.id : '', route.key)
  }

  function focusFirstChangedSetting(): void {
    const key = changedKeysCache.find((item) => fieldByKey[item] && sectionByFieldKey[item] && isFieldVisible(fieldByKey[item]))
    if (!key) return
    const section = sectionByFieldKey[key]
    currentGroup = resolveGroupIdForSection(groupList(), section) || currentGroup
    query = ''
    searchInput().value = ''
    renderNav()
    renderContent()
    replaceSettingsRoute({ group: currentGroup, section: section.id, key }, true)
    focusSettingsTarget(section.id, key)
  }

  function matchesQuery(field: SettingsField): boolean {
    return matchesSettingQuery(field, query, sectionOfField(field.key))
  }

  /** 按 section.group（共享分组表的 id）归并；沿用 schema 的先后顺序（同组内也保持原顺序）。
   *  显示名一律取主进程注入的 groupLabel，页面不自带任何中文组名。 */
  function groupList(): SettingsGroupView[] {
    return buildSettingsGroups(sections)
  }

  function activeGroup(): SettingsGroupView | null {
    const groups = groupList()
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].id === currentGroup) return groups[i]
    }
    return groups[0] || null
  }

  /** 大类图标：优先取 schema 里的 groupIcon（分组表真源）；
   *  插件自建的「其他」组没有 groupIcon，退回组内第一个带图标的 section。 */
  function groupIcon(group: SettingsGroupView): string {
    if (group.icon && ICONS[group.icon]) return ICONS[group.icon]
    for (let i = 0; i < group.sections.length; i++) {
      const icon = group.sections[i]?.icon
      const tpl = icon ? ICONS[icon] : ''
      if (tpl) return tpl
    }
    return ICONS.sliders
  }

  function renderNav(): void {
    const nav = document.getElementById('nav')
    if (!nav) return
    nav.innerHTML = ''
    groupList().forEach(function (g) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'nav-item' + (g.id === currentGroup && !query && !g.href ? ' active' : '')
      b.innerHTML =
        '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + groupIcon(g) + '</svg></span>' +
        '<span class="label"></span>'
      const label = b.querySelector<HTMLElement>('.label')
      if (label) label.textContent = g.name
      b.addEventListener('click', function () {
        // 「门」型大类（schema 带 groupHref，如 关于 Hira → hira://about/）：
        // 不切内容区，直接离开设置页去那一页 —— 唯一的界面在那边，避免两套口径。
        if (g.href) { window.location.href = g.href; return }
        if (g.id === currentGroup && !query) return
        currentGroup = g.id
        query = ''
        searchInput().value = ''
        replaceSettingsRoute({ group: g.id, section: '', key: '', query: '' }, true)
        renderNav()
        renderContent()
        const c = document.querySelector('.content')
        if (c) c.scrollTop = 0
        updateSubtabSpy()
      })
      nav.appendChild(b)
    })
  }

  /* ── 标题旁的小选项卡：盘内快捷跳转 + 滚动联动 ─────────────────────
   * 条目 = 当前大类里的各个分区；只有一个分区时整条隐藏（没得跳）。
   */
  let spyBound = false
  let spyFrame = 0
  let spyActive = ''
  let spyHoldUntil = 0   // 点击跳转后的短暂「锁定」，避免平滑滚动途中高亮乱跳
  interface SubtabTarget { id: string; label: string; sectionId: string }

  /** 滚动容器：内容区自己滚，不是 window。 */
  function contentEl(): HTMLElement | null {
    return document.querySelector('.content')
  }

  function sectionAnchor(id: string): HTMLElement | null {
    return document.getElementById(id)
  }

  function subtabTargets(group: SettingsGroupView): SubtabTarget[] {
    const targets: SubtabTarget[] = []
    group.sections.forEach(function (section) {
      const fields = (section.fields || []).filter(isFieldVisible)
      const subtabs = section.subtabs || []
      if (subtabs.length) {
        subtabs.forEach(function (tab) {
          if (!fields.some(function (field) {
            return field.subtab === tab.id && field.group !== 'advanced'
          })) return
          targets.push({
            id: 'subtab-' + section.id + '-' + tab.id,
            label: tab.label || tab.id,
            sectionId: section.id
          })
        })
      } else {
        targets.push({
          id: 'sec-' + section.id,
          label: section.label || section.id,
          sectionId: section.id
        })
      }
    })
    return targets
  }

  function setActiveSubtab(id: string): void {
    if (spyActive === id) return
    spyActive = id
    const host = document.getElementById('subtabs')
    if (!host) return
    for (let i = 0; i < host.children.length; i++) {
      const b = host.children[i]
      const on = b.getAttribute('data-sec') === id
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    }
  }

  /** 以内容区顶部为基准，找出「已经滚过线」的最后一个分区。 */
  function updateSubtabSpy(): void {
    const group = activeGroup()
    const host = contentEl()
    if (!group || !host || query) return
    const targets = subtabTargets(group)
    if (!targets.length) return
    const ids = targets.map(function (target) { return target.id })
    // 触底时直接点最后一项：末段太短、滚不过判定线也不会"卡"在上一项
    if (host.scrollHeight > host.clientHeight + 2 && host.scrollTop + host.clientHeight >= host.scrollHeight - 2) {
      setActiveSubtab(ids[ids.length - 1])
      return
    }
    const base = host.getBoundingClientRect().top
    let id = ids[0]
    targets.forEach(function (target) {
      const el = sectionAnchor(target.id)
      if (!el) return
      // 24px 容差：正好停在边界时仍算上一块
      if (el.getBoundingClientRect().top - base <= 24) id = target.id
    })
    setActiveSubtab(id)
  }

  function onContentScroll(): void {
    if (spyFrame) return
    spyFrame = requestAnimationFrame(function () {
      spyFrame = 0
      if (Date.now() < spyHoldUntil) return
      updateSubtabSpy()
    })
  }

  function setupScrollSpy(): void {
    if (spyBound) return
    const host = contentEl()
    if (!host) return
    spyBound = true
    host.addEventListener('scroll', onContentScroll, { passive: true })
  }

  /** 滚到某个设置分组（页内锚点，不重建 DOM、不改路由）。 */
  function scrollToSection(id: string, behavior: ScrollBehavior = 'smooth'): void {
    const host = contentEl()
    const el = sectionAnchor(id)
    if (!host || !el) return
    const top = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
    setActiveSubtab(id)
    spyHoldUntil = Date.now() + 700
    host.scrollTo({ top: Math.max(0, top - 10), behavior: behavior })
  }

  function renderSubtabs(group: SettingsGroupView | null): void {
    const host = document.getElementById('subtabs')
    if (!host) return
    const targets = !query && group ? subtabTargets(group) : []
    if (query || !group || targets.length < 2) {
      host.hidden = true
      host.innerHTML = ''
      return
    }
    host.hidden = false
    host.innerHTML = ''
    spyActive = ''
    targets.forEach(function (target) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'subtab'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', 'false')
      b.setAttribute('data-sec', target.id)
      b.textContent = target.label
      b.addEventListener('click', function () {
        scrollToSection(target.id)
        replaceSettingsRoute({ section: target.sectionId, key: '' }, true)
      })
      host.appendChild(b)
    })
  }

  /**
   * 「列表」型设置项：内容不定长、来自主进程路由，需要整行铺开
   * （不能像开关那样塞进右侧的 control 列）。
   * 与其它类型一样由 schema 驱动：页面只认 field.list 里的路由与字段名，
   * 不认识列表里装的到底是什么业务数据（当前是「已授权的外部协议」）。
   */
  function buildListRow(field: SettingsField): HTMLElement {
    const cfg = field.list || {}
    const wrap = document.createElement('div')
    wrap.className = 'list-field'
    wrap.dataset.settingKey = field.key

    const head = document.createElement('div')
    head.className = 'row'
    const hinfo = document.createElement('div')
    hinfo.className = 'info'
    const hlabel = document.createElement('div')
    hlabel.className = 'label'
    hlabel.textContent = field.label || field.key
    hinfo.appendChild(hlabel)
    head.appendChild(hinfo)
    wrap.appendChild(head)

    const items = document.createElement('div')
    wrap.appendChild(items)

    function appendEmpty(text: string): void {
      const r = document.createElement('div')
      r.className = 'row'
      const d = document.createElement('div')
      d.className = 'desc'
      d.textContent = text
      r.appendChild(d)
      items.appendChild(r)
    }

    function render() {
      items.innerHTML = ''
      if (!cfg.route) { appendEmpty(cfg.emptyText || '不可用。'); return }
      invoke(cfg.route, {}).then(function (rows) {
        const list: Array<Record<string, unknown>> = Array.isArray(rows)
          ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
          : []
        if (!list.length) { appendEmpty(cfg.emptyText || '暂无记录。'); return }
        list.forEach(function (item) {
          const r = document.createElement('div')
          r.className = 'row'
          const info = document.createElement('div')
          info.className = 'info'
          const l = document.createElement('div')
          l.className = 'label'
          const primary = cfg.primary ? item[cfg.primary] : undefined
          l.textContent = String(primary ?? '')
          info.appendChild(l)
          const sub = cfg.secondary ? item[cfg.secondary] : ''
          if (sub != null && sub !== '') {
            const d = document.createElement('div')
            d.className = 'desc'
            d.textContent = String(sub)
            info.appendChild(d)
          }
          const ctrl = document.createElement('div')
          ctrl.className = 'control'
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'btn'
          btn.textContent = cfg.removeLabel || '撤销'
          btn.addEventListener('click', function () {
            if (!cfg.removeRoute) return
            btn.disabled = true
            // 整项作为载荷回传：契约只取其中的 requestingURL / openingProtocol
            invoke(cfg.removeRoute, item || {}).then(function () {
              render()
            }).catch(function () { btn.disabled = false })
          })
          ctrl.appendChild(btn)
          r.appendChild(info)
          r.appendChild(ctrl)
          items.appendChild(r)
        })
      }).catch(function () {
        items.innerHTML = ''
        appendEmpty(cfg.emptyText || '加载失败。')
      })
    }
    render()
    return wrap
  }

  /**
   * 「动态列表」型设置项（自定义 Bang / 自定义搜索引擎…）：列表 + 就地增删改。
   *
   * 与 list 型同样是**整行铺开**，区别是它不是只读列表 —— 用户要能新增/编辑/删除，
   * 校验失败（触发词重复、URL 不是 http(s) 等）要就地回显。
   *
   * 页面依然不认识业务：路由、文案、条目长什么样全来自 schema 的 `itemSchema`：
   *   routes      = { list, save, remove, refreshOptions? }
   *   emptyText / addLabel / toast = { saved, removed }
   *   itemSchema  = { badge, badgePrefix?, title, subtitle, usage,
   *                   tagWhen?, tagInvert?, tagLabel?,
   *                   fields: [{ key, label, placeholder, prefix?, hint?, required?, requiredMessage? }],
   *                   toggles: [{ key, label, hint?, default? }] }
   * 数据真源在主进程 SQLite，这里只做「拉取 → 画 → 提交 → 重画」。
   * 编辑器草稿单独存一份 `draft`：外部变更触发 repaint 时不会把正在输入的内容冲掉。
   */
  function buildDynamicListRow(field: SettingsField): HTMLElement {
    type KeyedDefinition = SettingsFieldDefinition & { key: string }
    interface DynamicEntry extends Record<string, unknown> {
      id: string
      hitCount?: unknown
    }
    const routes = field.routes || {}
    const cm = field.itemSchema || {}
    const fieldDefs: KeyedDefinition[] = (Array.isArray(cm.fields) ? cm.fields : [])
      .filter((def): def is KeyedDefinition => typeof def.key === 'string' && def.key.length > 0)
    const toggleDefs: KeyedDefinition[] = (Array.isArray(cm.toggles) ? cm.toggles : [])
      .filter((def): def is KeyedDefinition => typeof def.key === 'string' && def.key.length > 0)
    /** 徽标前缀（如 Bang 的 `!`）：由 itemSchema.fields 里同名项的 prefix 决定。 */
    const badgePrefix = (function () {
      const hit = fieldDefs.filter(function (d) { return d.key === cm.badge })[0]
      return (hit && hit.prefix) || cm.badgePrefix || ''
    })()
    const wrap = document.createElement('div')
    wrap.className = 'bang-field'
    wrap.dataset.settingKey = field.key

    // ── 头部：标题 + 说明 + 「新增」 ──
    const head = document.createElement('div')
    head.className = 'row'
    const hinfo = document.createElement('div')
    hinfo.className = 'info'
    const hlabel = document.createElement('div')
    hlabel.className = 'label'
    hlabel.textContent = field.label || field.key
    hinfo.appendChild(hlabel)
    const hctrl = document.createElement('div')
    hctrl.className = 'control'
    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'btn'
    addBtn.textContent = field.addLabel || '新增'
    addBtn.addEventListener('click', function () { openEditor(null) })
    hctrl.appendChild(addBtn)
    head.appendChild(hinfo)
    head.appendChild(hctrl)
    wrap.appendChild(head)

    const items = document.createElement('div')
    items.className = 'bang-items'
    wrap.appendChild(items)

    const editorHost = document.createElement('div')
    wrap.appendChild(editorHost)

    let entries: DynamicEntry[] = []
    let loaded = false
    let loadFailed = false
    let editingId: string | null = null   // null = 关闭；'' = 新增；其它 = 编辑该 id
    let draft: Record<string, unknown> | null = null
    let error = ''
    let saving = false
    let confirmId: string | null = null   // 二次确认删除中的条目 id

    function render() {
      renderList()
      renderEditor()
    }

    function renderList() {
      items.innerHTML = ''
      if (!routes.list) {
        const d = document.createElement('div')
        d.className = 'desc'
        d.textContent = '不可用。'
        items.appendChild(d)
        return
      }
      if (!loaded) {
        const d = document.createElement('div')
        d.className = 'desc'
        d.textContent = '加载中…'
        items.appendChild(d)
        return
      }
      if (loadFailed) {
        const d = document.createElement('div')
        d.className = 'desc'
        d.textContent = '加载失败。'
        items.appendChild(d)
        return
      }
      if (!entries.length) {
        const d = document.createElement('div')
        d.className = 'desc'
        d.textContent = field.emptyText || '暂无条目。'
        items.appendChild(d)
        return
      }
      entries.forEach(function (entry) {
        items.appendChild(buildItem(entry))
      })
    }

    function buildItem(entry: DynamicEntry): HTMLElement {
      const row = document.createElement('div')
      row.className = 'bang-item'

      const info = document.createElement('div')
      info.className = 'info'

      const line = document.createElement('div')
      line.className = 'bang-line'
      const badgeValue = cm.badge ? entry[cm.badge] : ''
      if (badgeValue !== undefined && badgeValue !== null && badgeValue !== '') {
        const trig = document.createElement('code')
        trig.className = 'bang-trigger'
        trig.textContent = badgePrefix + String(badgeValue)
        line.appendChild(trig)
      }
      const title = document.createElement('span')
      title.className = 'label'
      title.textContent = String((cm.title && entry[cm.title]) || badgeValue || '')
      line.appendChild(title)
      // 条件标签（如 Bang 的「仅回车直搜」）：tagWhen 为假值时显示，tagInvert 取反
      if (cm.tagLabel && cm.tagWhen) {
        const on = !!entry[cm.tagWhen]
        if (cm.tagInvert ? !on : on) {
          const tag = document.createElement('span')
          tag.className = 'bang-tag'
          tag.textContent = cm.tagLabel
          line.appendChild(tag)
        }
      }
      info.appendChild(line)

      const subtitle = cm.subtitle ? entry[cm.subtitle] : ''
      if (subtitle) {
        const url = document.createElement('div')
        url.className = 'bang-url'
        url.textContent = String(subtitle)
        info.appendChild(url)
      }

      if (cm.usage && Number(entry.hitCount) > 0) {
        const meta = document.createElement('div')
        meta.className = 'desc'
        meta.textContent = '已使用 ' + Number(entry.hitCount) + ' 次'
        info.appendChild(meta)
      }

      const ctrl = document.createElement('div')
      ctrl.className = 'control'
      if (confirmId === entry.id) {
        const yes = document.createElement('button')
        yes.type = 'button'
        yes.className = 'btn bang-danger'
        yes.textContent = '确认删除'
        yes.addEventListener('click', function () {
          confirmId = null
          if (!routes.remove) return
          invoke(routes.remove, { id: entry.id }).then(function (res) {
            if (res && res.ok === false) { error = String(res.error || '删除失败'); render() ; return }
            if (editingId === entry.id) closeEditor()
            if (field.toast && field.toast.removed) showToast(field.toast.removed)
            refreshOptions()
            load()
          }).catch(function () { render() })
        })
        const no = document.createElement('button')
        no.type = 'button'
        no.className = 'btn'
        no.textContent = '取消'
        no.addEventListener('click', function () { confirmId = null; renderList() })
        ctrl.appendChild(yes)
        ctrl.appendChild(no)
      } else {
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'btn'
        edit.textContent = '编辑'
        edit.addEventListener('click', function () { openEditor(entry) })
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'btn'
        del.textContent = '删除'
        del.addEventListener('click', function () { confirmId = entry.id; renderList() })
        ctrl.appendChild(edit)
        ctrl.appendChild(del)
      }

      row.appendChild(info)
      row.appendChild(ctrl)
      return row
    }

    function blankDraft(): Record<string, unknown> {
      const d: Record<string, unknown> = {}
      fieldDefs.forEach(function (def) { d[def.key] = '' })
      toggleDefs.forEach(function (def) { d[def.key] = def.default !== false })
      return d
    }

    function openEditor(entry: DynamicEntry | null = null): void {
      editingId = entry ? entry.id : ''
      const nextDraft = blankDraft()
      draft = nextDraft
      if (entry) {
        fieldDefs.forEach(function (def) {
          if (entry[def.key] != null) nextDraft[def.key] = String(entry[def.key])
        })
        toggleDefs.forEach(function (def) {
          if (entry[def.key] !== undefined) nextDraft[def.key] = entry[def.key] !== false
        })
      }
      error = ''
      confirmId = null
      render()
      const first = fieldDefs[0]
      const input = first ? editorHost.querySelector('input[data-k="' + first.key + '"]') : null
      if (input) (input as HTMLInputElement).focus()
    }

    function closeEditor(): void {
      editingId = null
      draft = null
      error = ''
      saving = false
      renderEditor()
    }

    function renderEditor(): void {
      editorHost.innerHTML = ''
      if (editingId === null || !draft) return
      const currentDraft = draft

      const form = document.createElement('div')
      form.className = 'bang-editor'

      function textField(def: KeyedDefinition): void {
        const box = document.createElement('div')
        box.className = 'field'
        const lb = document.createElement('div')
        lb.className = 'field-label'
        lb.textContent = def.label || def.key
        box.appendChild(lb)
        const line = document.createElement('div')
        line.className = 'bang-prefix-row'
        if (def.prefix) {
          const pre = document.createElement('span')
          pre.className = 'bang-prefix'
          pre.textContent = def.prefix
          line.appendChild(pre)
        }
        const inp = document.createElement('input')
        inp.type = 'text'
        inp.dataset.k = def.key
        inp.placeholder = def.placeholder || ''
        const value = currentDraft[def.key]
        inp.value = value == null ? '' : String(value)
        inp.addEventListener('input', function () { currentDraft[def.key] = inp.value })
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); save() }
          if (e.key === 'Escape') { e.preventDefault(); closeEditor() }
        })
        line.appendChild(inp)
        box.appendChild(line)
        if (def.hint) {
          const hint = document.createElement('div')
          hint.className = 'bang-hint'
          hint.textContent = def.hint
          box.appendChild(hint)
        }
        form.appendChild(box)
      }

      fieldDefs.forEach(textField)

      toggleDefs.forEach(function (def) {
        const check = document.createElement('label')
        check.className = 'bang-check'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !!currentDraft[def.key]
        cb.addEventListener('change', function () { currentDraft[def.key] = cb.checked })
        check.appendChild(cb)
        const text = document.createElement('span')
        text.textContent = def.label || def.key
        check.appendChild(text)
        form.appendChild(check)
        if (def.hint) {
          const hint = document.createElement('div')
          hint.className = 'bang-check-desc'
          hint.textContent = def.hint
          form.appendChild(hint)
        }
      })

      const err = document.createElement('div')
      err.className = 'bang-error'
      err.textContent = error || ''
      form.appendChild(err)

      const actions = document.createElement('div')
      actions.className = 'bang-actions'
      const ok = document.createElement('button')
      ok.type = 'button'
      ok.className = 'btn'
      ok.textContent = saving ? '保存中…' : '保存'
      ok.disabled = saving
      ok.addEventListener('click', save)
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'btn'
      cancel.textContent = '取消'
      cancel.disabled = saving
      cancel.addEventListener('click', closeEditor)
      actions.appendChild(ok)
      actions.appendChild(cancel)
      form.appendChild(actions)

      editorHost.appendChild(form)
    }

    function save(): void {
      if (saving || !draft || !routes.save) return
      const currentDraft = draft
      // 必填项在本地先拦一下，免得为了同一句话跑一趟 IPC
      for (let i = 0; i < fieldDefs.length; i++) {
        const def = fieldDefs[i]
        if (def.required && !String(currentDraft[def.key] || '').trim()) {
          error = String(def.requiredMessage || (String(def.label || def.key) + '不能为空'))
          renderEditor()
          return
        }
      }
      saving = true
      error = ''
      renderEditor()
      const payload: Record<string, unknown> = { id: editingId || undefined }
      fieldDefs.forEach(function (def) { payload[def.key] = currentDraft[def.key] })
      toggleDefs.forEach(function (def) { payload[def.key] = !!currentDraft[def.key] })
      invoke(routes.save, payload).then(function (res) {
        saving = false
        if (!res || res.ok === false) {
          error = String((res && res.error) || '保存失败')
          renderEditor()
          return
        }
        editingId = null
        draft = null
        if (field.toast && field.toast.saved) showToast(field.toast.saved)
        refreshOptions()
        load()
      }).catch(function (cause) {
        saving = false
        error = errorMessage(cause)
        renderEditor()
        renderEditor()
      })
    }

    /** 保存/删除后让「引用同一路由」的下拉重新解析选项（如默认搜索引擎下拉）。 */
    function refreshOptions(): void {
      if (routes.refreshOptions) refreshOptionsRoute(routes.refreshOptions)
    }

    function load(): void {
      if (!routes.list) return
      invoke(routes.list, {}).then(function (rows) {
        entries = Array.isArray(rows)
          ? rows.flatMap((row): DynamicEntry[] => {
              if (!row || typeof row !== 'object' || Array.isArray(row)) return []
              const record = row as Record<string, unknown>
              return typeof record.id === 'string' && record.id ? [{ ...record, id: record.id }] : []
            })
          : []
        loaded = true
        loadFailed = false
        render()
      }).catch(function () {
        loaded = true
        loadFailed = true
        render()
      })
    }

    load()
    // 外部变更（其它窗口新增/改名/删除）→ 就地重绘，不整页重建
    controlEls[field.key] = { repaint: function () { load() } }
    return wrap
  }

  /**
   * 「顺序」型设置项：值是 id 数组（如「各栏上下顺序」）。
   * 与 list 一样整行铺开 —— 右侧控件列塞不下 N 个可排序条目。
   * 页面只认 field.options（[id, 名称]）与 field.key，不认识被排序的到底是什么。
   * 用 ↑ / ↓ 调序而非拖拽：无需引入拖拽库，键盘可达、行为确定。
   *
   * ── 为什么还要「分组」（bucketOf / bucketLabels / disabledWhen）──────
   * 顺序表是一份**全局序列**，真正摆放时却会按「每项所属的组」拆开分别排
   * （如各栏按所在侧拆到窗口上/下两侧，各自自上而下）。若 ↑ / ↓ 仍与全局相邻项交换，
   * 遇到「相邻项在另一组」时两组渲染出来的顺序都不变 —— 表现就是「点了没反应」。
   * 因此这里只在**同组**内找相邻项交换，并把组名做成徽标显示出来，让用户看得见为什么。
   *
   * 这三张表都是**纯 JSON**（设置页没有打包器，函数无法跨 IPC 传递），
   * 页面因此不需要知道「组」究竟是位置、分类还是别的什么。
   */
  function buildOrderRow(field: SettingsField): HTMLElement {
    const opts = field.options || []
    const nameOf: Record<string, string> = {}
    const ids = opts.map(function (o) {
      const id = String(o[0])
      nameOf[id] = o[1]
      return id
    })
    const bucketKeys = field.bucketOf || {}
    const bucketLabels = field.bucketLabels || {}
    const disabledWhen = field.disabledWhen || {}

    /** 当前顺序的规范化副本：剔未知 id、去重、补全缺失项 —— 值可能来自手改的 JSON。 */
    function current(): string[] {
      const raw = values[field.key]
      const out: string[] = []
      if (Array.isArray(raw)) {
        raw.map(String).forEach(function (id) { if (ids.includes(id) && !out.includes(id)) out.push(id) })
      }
      ids.forEach(function (id) { if (!out.includes(id)) out.push(id) })
      return out
    }

    /**
     * 某项当前是否不生效（如标题栏已关闭 / 该栏不住在侧栏）。
     *
     * 判据来自 schema 的纯 JSON 条件：
     *   · `{ key, value }`   —— 该键**等于**这个值时停用（如「标题栏关闭」）；
     *   · `{ key, values }`  —— 该键命中列表里任一值时停用（如「位置不是侧栏」= ['top','bottom']）。
     * 两种写法都不含逻辑，页面只做比较 —— 布局知识仍然全部留在 registry。
     */
    function isInactive(id: string): boolean {
      const cond = disabledWhen[id]
      if (!cond || !cond.key) return false
      const v = String(values[cond.key])
      if (Array.isArray(cond.values)) return cond.values.some(function (x) { return String(x) === v })
      return v === String(cond.value)
    }

    /**
     * 某项当前所属的组。
     * @returns {string|null} null = 不生效（不能作为交换对象，自己也不能移动）
     */
    function bucketOfId(id: string): string | null {
      if (isInactive(id)) return null
      const key = bucketKeys[id]
      if (!key) return ''
      const v = values[key]
      return v == null ? '' : String(v)
    }

    /** 同组内朝 delta 方向最近的一项的下标；没有则 -1。 */
    function neighbor(index: number, delta: number): number {
      const order = current()
      const bucket = bucketOfId(order[index])
      if (bucket === null) return -1
      for (let j = index + delta; j >= 0 && j < order.length; j += delta) {
        if (bucketOfId(order[j]) === bucket) return j
      }
      return -1
    }

    const wrap = document.createElement('div')
    wrap.className = 'order-field'
    wrap.dataset.settingKey = field.key

    const head = document.createElement('div')
    head.className = 'row'
    const hinfo = document.createElement('div')
    hinfo.className = 'info'
    const hlabel = document.createElement('div')
    hlabel.className = 'label'
    hlabel.textContent = field.label || field.key
    hinfo.appendChild(hlabel)
    head.appendChild(hinfo)
    wrap.appendChild(head)

    const items = document.createElement('div')
    items.className = 'order-items'
    wrap.appendChild(items)

    /**
     * 上移 / 下移：与**同组**内相邻的一项交换位置。
     * 组内相对顺序因此变化，而其它组的相对顺序一个都没动。
     */
    function move(index: number, delta: number): void {
      const to = neighbor(index, delta)
      if (to < 0) return
      const order = current()
      const tmp = order[index]
      order[index] = order[to]
      order[to] = tmp
      commit(field.key, order)
      paint()
    }

    function paint() {
      items.innerHTML = ''
      const order = current()
      order.forEach(function (id, i) {
        const r = document.createElement('div')
        r.className = 'row order-item'
        const inactive = bucketOfId(id) === null
        if (inactive) r.classList.add('is-inactive')

        const info = document.createElement('div')
        info.className = 'info'
        const l = document.createElement('div')
        l.className = 'label'
        l.textContent = nameOf[id] || id
        info.appendChild(l)

        // 组徽标：让「同一侧的栏才互相排」这件事在界面上看得见。
        const bucket = bucketOfId(id)
        const bucketKey = bucket ?? ''
        const badgeText = inactive
          ? (field.inactiveLabel || '未启用')
          : (Object.prototype.hasOwnProperty.call(bucketLabels, bucketKey) ? bucketLabels[bucketKey] : '')
        if (badgeText) {
          const badge = document.createElement('span')
          badge.className = 'order-side' + (inactive ? ' is-off' : '')
          badge.textContent = badgeText
          info.appendChild(badge)
        }

        const ctrl = document.createElement('div')
        ctrl.className = 'control'
        const moves: Array<[string, number]> = [['↑', -1], ['↓', 1]]
        moves.forEach(function (pair) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'btn order-move'
          b.textContent = pair[0]
          b.disabled = neighbor(i, pair[1]) < 0
          b.setAttribute('aria-label', (pair[1] < 0 ? '上移：' : '下移：') + (nameOf[id] || id))
          b.addEventListener('click', function () { move(i, pair[1]) })
          ctrl.appendChild(b)
        })
        r.appendChild(info)
        r.appendChild(ctrl)
        items.appendChild(r)
      })
    }

    paint()
    // 外部变更（其它窗口改了顺序）→ 就地重绘这一个控件，不整页重建
    controlEls[field.key] = { repaint: paint }
    return wrap
  }

  /**
   * 「多选」型设置项：值是 id 数组（如「拼写检查语言」）。
   * 选项可能来自 `optionsRoute`（运行时才知道的清单），所以整行铺开、chip 平铺，
   * 不用下拉 —— 多选下拉在原生 select 里要按修饰键，触控与键盘都不顺手。
   * 页面只认 field.options / field.key，不认识被勾选的到底是什么。
   */
  function buildMultiSelectRow(field: SettingsField): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'multi-field'
    wrap.dataset.settingKey = field.key

    const head = document.createElement('div')
    head.className = 'row'
    const info = document.createElement('div')
    info.className = 'info'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = field.label || field.key
    info.appendChild(label)
    head.appendChild(info)
    wrap.appendChild(head)

    const box = document.createElement('div')
    box.className = 'multi-options'
    wrap.appendChild(box)

    /** 当前选中集合（规范化：只留字符串、去重）。 */
    function selected(): string[] {
      const raw = values[field.key]
      const out: string[] = []
      const source: unknown[] = Array.isArray(raw) ? raw : []
      for (const item of source) {
        const code = String(item)
        if (code && !out.includes(code)) out.push(code)
      }
      return out
    }

    function paint(): void {
      const on = selected()
      // 选项 + 「已选但清单里没有」的残留值：否则用户没法把失效项去掉
      const opts: SettingsOption[] = (field.options || []).slice()
      const known: Record<string, true> = {}
      opts.forEach(function (o) { known[String(o[0])] = true })
      on.forEach(function (code) { if (!known[code]) opts.push([code, code]) })

      box.innerHTML = ''
      if (!opts.length) {
        const d = document.createElement('div')
        d.className = 'desc'
        d.textContent = field.emptyText || '暂无可选项。'
        box.appendChild(d)
        return
      }
      opts.forEach(function (o) {
        const code = String(o[0])
        const isOn = on.indexOf(code) >= 0
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'multi-item' + (isOn ? ' is-on' : '')
        chip.setAttribute('role', 'checkbox')
        chip.setAttribute('aria-checked', isOn ? 'true' : 'false')
        chip.textContent = o[1]
        chip.addEventListener('click', function () {
          const cur = selected()
          const at = cur.indexOf(code)
          if (at >= 0) cur.splice(at, 1)
          else cur.push(code)
          commit(field.key, cur)
          paint()
        })
        box.appendChild(chip)
      })
    }

    paint()
    // 外部变更（其它窗口改了该项）→ 就地重绘，不整页重建
    controlEls[field.key] = { repaint: paint }
    return wrap
  }

  /**
   * 「记录」型设置项：值是一个对象（如「浏览器指纹」），语义是
   * 「开关关掉 = 整个对象不存在（null）」。
   *
   * 页面只认 schema：
   *   field.record.fields   子字段（select / number / text，类型驱动渲染）
   *   field.record.summary  折叠态摘要（name + suffix）
   *   field.record.generate 生成器 id（主进程 record-generators 注册表里的条目）
   * 具体被编辑的是什么业务，本页一概不知。
   *
   * 交互语义（与旧版一致）：
   *   开 → 没有值就先调用生成器拿一份随机值并保存；已有值则直接展示。
   *   关 → 写入 null（对象整体消失）。
   *   随机生成 → 只填草稿，**不保存**，用户确认后点「应用」才落盘。
   *   应用 → 收集当前草稿写入设置。
   */
  function buildRecordRow(field: SettingsField): HTMLElement {
    type NamedFieldDefinition = SettingsFieldDefinition & { name: string }
    const spec = field.record || {}
    const subs: NamedFieldDefinition[] = (Array.isArray(spec.fields) ? spec.fields : [])
      .filter((sub): sub is NamedFieldDefinition => typeof sub.name === 'string' && sub.name.length > 0)
    let draft: Record<string, unknown> | null = null
    let busy = false

    const wrap = document.createElement('div')
    wrap.className = 'record-field'
    wrap.dataset.settingKey = field.key

    const head = document.createElement('div')
    head.className = 'row'
    const info = document.createElement('div')
    info.className = 'info'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = field.label || field.key
    info.appendChild(label)
    head.appendChild(info)

    const control = document.createElement('div')
    control.className = 'control'
    const toggle = document.createElement('button')
    toggle.className = 'toggle'
    toggle.type = 'button'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-label', field.label || field.key)
    control.appendChild(toggle)
    head.appendChild(control)

    const body = document.createElement('div')
    body.className = 'record-body'

    wrap.appendChild(head)
    wrap.appendChild(body)

    /** 已保存的值（不是对象就是「未启用」）。 */
    function saved(): Record<string, unknown> | null {
      const v = values[field.key]
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
    }

    function subDefault(sub: NamedFieldDefinition): unknown {
      if (sub.default !== undefined) return sub.default
      if (sub.type === 'number') return 0
      if (sub.type === 'select' && sub.options && sub.options.length) return String(sub.options[0][0])
      return ''
    }

    /** 任意来源（已存值 / 生成器返回值 / null）→ 完整草稿。 */
    function draftFrom(src: unknown): Record<string, unknown> {
      const out: Record<string, unknown> = {}
      const source = src && typeof src === 'object' && !Array.isArray(src) ? src as Record<string, unknown> : null
      subs.forEach(function (sub) {
        let v = source && Object.prototype.hasOwnProperty.call(source, sub.name) ? source[sub.name] : undefined
        if (v === undefined || v === null || v === '') v = subDefault(sub)
        out[sub.name] = v
      })
      return out
    }

    function summaryText(v: unknown): string {
      const list: Array<string | { name?: string; suffix?: string }> = Array.isArray(spec.summary) && spec.summary.length
        ? spec.summary
        : subs
      const parts: string[] = []
      const source = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
      list.forEach(function (item) {
        const name = typeof item === 'string' ? item : item && item.name
        if (!name) return
        const suffix = (item && typeof item === 'object' && item.suffix) || ''
        let x = source?.[name]
        if (Array.isArray(x)) x = x.join(',')
        if (x === undefined || x === null || x === '') return
        parts.push(String(x) + suffix)
      })
      return parts.join(' / ')
    }

    /** 草稿 → 可持久化的值（数值夹界，其余原样）。 */
    function collectDraft(): Record<string, unknown> {
      const out: Record<string, unknown> = {}
      subs.forEach(function (sub) {
        const v = draft ? draft[sub.name] : undefined
        if (sub.type === 'number') {
          let n = Number(v)
          if (!isFinite(n)) n = Number(subDefault(sub)) || 0
          if (sub.min !== undefined && n < sub.min) n = sub.min
          if (sub.max !== undefined && n > sub.max) n = sub.max
          out[sub.name] = n
        } else if (v === undefined || v === null) {
          out[sub.name] = subDefault(sub)
        } else {
          out[sub.name] = v
        }
      })
      return out
    }

    /** 只画主体（草稿必须已就绪）。 */
    function render(): void {
      body.innerHTML = ''
      if (!draft) return
      const currentDraft = draft
      const sum = document.createElement('div')
      sum.className = 'record-summary'
      sum.textContent = summaryText(saved()) || (spec.emptyText || '')
      body.appendChild(sum)

      const grid = document.createElement('div')
      grid.className = 'record-grid'
      subs.forEach(function (sub) {
        const item = document.createElement('label')
        item.className = 'record-item'
        const lab = document.createElement('span')
        lab.className = 'record-label'
        lab.textContent = sub.label || sub.name
        item.appendChild(lab)

        let input: HTMLInputElement | HTMLSelectElement
        if (sub.type === 'select') {
          input = document.createElement('select')
          ;(sub.options || []).forEach(function (o) {
            const op = document.createElement('option')
            op.value = String(o[0])
            op.textContent = o[1]
            if (String(currentDraft[sub.name]) === String(o[0])) op.selected = true
            input.appendChild(op)
          })
          input.addEventListener('change', function () { currentDraft[sub.name] = input.value })
        } else if (sub.type === 'number') {
          input = document.createElement('input')
          input.type = 'number'
          if (sub.min !== undefined) input.min = String(sub.min)
          if (sub.max !== undefined) input.max = String(sub.max)
          input.value = String(currentDraft[sub.name])
          input.addEventListener('input', function () { currentDraft[sub.name] = input.value })
        } else {
          input = document.createElement('input')
          input.type = 'text'
          if (sub.placeholder) input.placeholder = sub.placeholder
          // 数组值（如语言列表）以逗号串联编辑；改回数组交给 collectDraft 原样保存
          const value = currentDraft[sub.name]
          const arrayValue = Array.isArray(value) ? value.map(String) : null
          input.value = arrayValue ? arrayValue.join(',') : String(value)
          input.addEventListener('input', function () {
            currentDraft[sub.name] = arrayValue
              ? input.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
              : input.value
          })
        }
        item.appendChild(input)
        grid.appendChild(item)
      })
      body.appendChild(grid)

      const actions = document.createElement('div')
      actions.className = 'record-actions'
      if (spec.generate) {
        const gen = document.createElement('button')
        gen.type = 'button'
        gen.className = 'btn'
        gen.textContent = spec.generateLabel || '随机生成'
        gen.addEventListener('click', function () {
          if (busy) return
          busy = true
          gen.disabled = true
          invoke('settings:record-generate', { generator: spec.generate }).then(function (res) {
            if (res && typeof res === 'object' && !Array.isArray(res)) {
              draft = draftFrom(res)
              render()
            }
          }).catch(function (cause) {
            console.error('[settings] generate failed:', errorMessage(cause))
          }).then(function () {
            busy = false
            gen.disabled = false
          })
        })
        actions.appendChild(gen)
      }
      const apply = document.createElement('button')
      apply.type = 'button'
      apply.className = 'btn'
      apply.textContent = spec.applyLabel || '应用'
      apply.addEventListener('click', function () {
        commit(field.key, collectDraft())
        draft = null
        paint()
      })
      actions.appendChild(apply)
      body.appendChild(actions)
    }

    /** 全量重绘（开/关状态 + 主体）。 */
    function paint(): void {
      const v = saved()
      toggle.setAttribute('aria-checked', v ? 'true' : 'false')
      body.hidden = !v
      if (!v) { body.innerHTML = ''; draft = null; return }
      draft = draftFrom(v)
      render()
    }

    /** 打开：没有已存值先向主进程要一份随机值（生成器可由 schema 省略）。 */
    function enable(): void {
      if (busy) return
      if (!spec.generate) { commit(field.key, draftFrom(null)); return }
      busy = true
      invoke('settings:record-generate', { generator: spec.generate }).then(function (res) {
        commit(field.key, (res && typeof res === 'object' && !Array.isArray(res)) ? res : draftFrom(null))
      }).catch(function () {
        commit(field.key, draftFrom(null))
      }).then(function () {
        busy = false
        paint()
      })
    }

    toggle.addEventListener('click', function () {
      if (saved()) { commit(field.key, null); paint() }
      else enable()
    })

    paint()
    // 外部变更（其它窗口改了该项）→ 就地重绘，不整页重建
    controlEls[field.key] = { repaint: paint }
    return wrap
  }

  /** 单个设置项的一行（字段驱动，与具体 key 无关）*/
  function buildRow(field: SettingsField): HTMLElement {
    // 列表型走独立布局（整行铺开），不进「信息 + 右侧控件」的两列结构
    if (field.type === 'list') return buildListRow(field)
    // 动态列表（自定义 Bang / 自定义搜索引擎…）：整行铺开 + 就地增删改。
    // 只认 schema 的 itemSchema，不认识具体业务。
    if (field.itemSchema) return buildDynamicListRow(field)
    // 顺序型同样整行铺开（N 个条目 + 上移/下移按钮，右侧控件列放不下）
    if (field.type === 'order') return buildOrderRow(field)
    // 多选型：选项可能很多且需要平铺可见，同样整行铺开
    if (field.type === 'multi-select') return buildMultiSelectRow(field)
    // 记录型（对象值 + 开关）：子字段整行铺开
    if (field.type === 'record') return buildRecordRow(field)

    const row = document.createElement('div')
    row.className = 'row'
    row.dataset.settingKey = field.key

    const info = document.createElement('div')
    info.className = 'info'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = field.label || field.key
    info.appendChild(label)

    const control = document.createElement('div')
    control.className = 'control'

    if (field.type === 'toggle') {
      const t = document.createElement('button')
      t.className = 'toggle'
      t.type = 'button'
      t.setAttribute('role', 'switch')
      t.setAttribute('aria-label', field.label || field.key)
      function sync(): void {
        t.setAttribute('aria-checked', values[field.key] ? 'true' : 'false')
      }
      sync()
      t.addEventListener('click', function () {
        commit(field.key, !values[field.key])
        sync()
      })
      control.appendChild(t)
      controlEls[field.key] = t
    } else if (field.type === 'select') {
      const sel = document.createElement('select')
      ;(field.options || []).forEach(function (o) {
        const op = document.createElement('option')
        op.value = String(o[0])
        op.textContent = o[1]
        if (String(values[field.key]) === String(o[0])) op.selected = true
        sel.appendChild(op)
      })
      sel.addEventListener('change', function () { commit(field.key, sel.value) })
      control.appendChild(sel)
      controlEls[field.key] = sel
    } else if (field.type === 'action') {
      // 「动作」型：没有常驻值，点击即调用 field.action.runRoute 执行一次操作，
      // 并用 checkRoute 回读状态决定按钮文案与可否再点（如「设为默认浏览器」）。
      // 页面不认识具体动作，只认 action 里的路由 —— 与其它类型一样由 schema 驱动。
      const act = field.action || {}
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn'
      let busy = false
      let probing = false
      let pollAttempts = 0
      let doneState = false
      let pollTimer: number | null = null
      // 只有 todo（可点）/ done（已完成，禁用）/ busy（执行中，禁用）三态
      function paint(done: boolean): void {
        doneState = done === true
        btn.disabled = busy || doneState
        btn.textContent = doneState ? (act.doneLabel || '已完成') : (act.runLabel || '执行')
        // 一旦确认为已完成就不再需要回读
        if (doneState) stopPoll()
      }
      function stopPoll(): void {
        if (!pollTimer) return
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      /** 仅在「点过了、还在等外部确认」期间启动回读。 */
      function startPoll(): void {
        const interval = act.poll || 0
        if (pollTimer || interval <= 0 || !act.checkRoute) return
        pollAttempts = 0
        pollTimer = window.setInterval(function () {
          if (!btn.isConnected) { stopPoll(); return }
          if (++pollAttempts > 60) { stopPoll(); return }
          if (document.hidden || busy || doneState) return
          probe()
        }, interval)
      }
      // 回读结果落位：状态没变就一个字节都不动（轮询每 2s 跑一次，不能每次都重写 DOM）
      function reflect(done: boolean): void {
        if (done === doneState) return
        paint(done)
      }
      // resultHint：动作返回 `{ ok, message, error }` 时，把结果渲染成按钮旁的一行提示。
      // 导出/导入这类"看得见结果"的动作靠它回话；没开这个开关的动作（如「设为默认浏览器」）
      // 行为与从前逐字一致 —— 只翻按钮状态，不产生文字。
      const hint = document.createElement('span')
      hint.className = 'action-hint'
      function showHint(res: PageRpcRecord | null): void {
        if (!act.resultHint) return
        hint.classList.remove('is-error')
        if (!res) { hint.textContent = ''; return }
        if (res.ok === false) {
          if (res.canceled) { hint.textContent = ''; return }
          hint.textContent = String(res.error || '操作失败')
          hint.classList.add('is-error')
        } else {
          hint.textContent = String(res.message || '已完成')
        }
      }
      // 回读一次真实状态。执行中不回写（否则会把「执行中」的禁用态冲掉）；
      // 控件已被下一次 renderContent 换掉时也不再写（btn.isConnected === false）。
      function probe(): void {
        if (!act.checkRoute) return
        if (probing) return
        probing = true
        invoke<boolean>(act.checkRoute, {}).then(function (done) {
          if (busy || !btn.isConnected) return
          reflect(done === true)
        }).catch(function () { /* 查询失败保留当前状态，不把已完成的按钮降级 */ })
          .finally(function () { probing = false })
      }
      function refresh(): void {
        paint(false)
        probe()
      }
      btn.addEventListener('click', function () {
        if (busy || !act.runRoute) return
        busy = true
        paint(false)
        showHint(null)
        invoke(act.runRoute, {}).then(function (res) {
          busy = false
          paint(false)      // 先恢复可点态，再由回读决定是否升级成「已完成」
          probe()
          startPoll()       // 动作把用户送去了别的窗口 -> 开始等确认
          showHint(res)
        }).catch(function (cause) {
          busy = false
          paint(false)
          showHint({ ok: false, error: errorMessage(cause) })
        })
      })
      control.appendChild(btn)
      if (act.resultHint) control.appendChild(hint)
      refresh()

      // ── 点击之后的确认回读（schema 用 action.poll 声明间隔，页面不认识业务）──
      // 为什么需要：有些动作点下去只是把用户送到**别的窗口**完成确认
      // （「设为默认浏览器」就是 -> 系统设置），本进程收不到任何通知。
      // 所以只在「已经点过、还没等到状态翻转」期间轮询；页面闲置时一次都不打主进程。
      // 窗口重新获得焦点时也立刻对一次 —— 用户从系统设置切回来的那一刻就更新。
      if (act.checkRoute && (act.poll || 0) > 0) {
        const onFocus = function () { if (!document.hidden && !busy) probe() }
        window.addEventListener('focus', onFocus)
        contentDisposers.push(function () {
          window.removeEventListener('focus', onFocus)
          stopPoll()
        })
      }
    } else {
      const inp = document.createElement('input')
      inp.type = field.type === 'number' ? 'number' : 'text'
      inp.value = toDisplay(field)
      if (field.min !== undefined) inp.min = String(field.min)
      if (field.placeholder) inp.placeholder = field.placeholder
      // change 在失焦/回车时触发：避免每敲一个键就写一次盘
      inp.addEventListener('change', function () { commit(field.key, fromDisplay(field, inp.value)) })
      if (field.type === 'number') {
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur() })
      }
      control.appendChild(inp)
      // directory 字段：附「选择…」按钮，点击打开原生目录选择器并写回该键
      if (field.type === 'directory') {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'btn'
        btn.textContent = '选择…'
        btn.addEventListener('click', function () {
          invoke('settings:choose-directory', {}).then(function (res) {
            if (res && res.path) {
              inp.value = res.path
              commit(field.key, res.path)
            }
          }).catch(function () {})
        })
        control.appendChild(btn)
      }
      controlEls[field.key] = inp
      if (field.unit) {
        const u = document.createElement('span')
        u.className = 'unit'
        u.textContent = field.unit
        control.appendChild(u)
      }
    }

    row.appendChild(info)
    row.appendChild(control)
    return row
  }

  /**
   * 「恢复默认」只对真有持久值的字段有意义：
   * 动作型（无值）、列表型（路由数据）、动态列表（条目存在各自表里）都不该被 reset。
   */
  function isResettable(field: SettingsField): boolean {
    return field.type !== 'action' && field.type !== 'list' && !field.itemSchema
  }

  /**
   * 「转到 xx」入口行。两条通道由 schema 声明，页面不认识业务：
   *   · `href`  → 跳到内部页（hira://extensions / hira://themes 等）；
   *   · `route` → 调一次 IPC（按钮编辑这类不是页面、也不是窗口的**窗口级模式**）。
   * 按钮文案 = `action`（缺省「转到」）。
   */
  function buildEntryRow(entry: Record<string, unknown>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'row'
    const info = document.createElement('div')
    info.className = 'info'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = String(entry.label ?? '')
    info.appendChild(label)
    const control = document.createElement('div')
    control.className = 'control'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn'
    btn.textContent = String(entry.action || '转到')
    btn.addEventListener('click', function () {
      if (entry.href) {
        window.location.href = String(entry.href)
      } else if (entry.route) {
        // 模式型入口（按钮编辑）：主进程按自己的契约回 `{ active }` / `{ ok }`，
        // 两种都按「false = 没打开」处理，页面不为此认识具体业务。
        invoke(String(entry.route), entry.payload || {}).then(function (res) {
          if (res && (res.ok === false || res.active === false)) showToast('暂时打不开这个界面')
        }).catch(function () { showToast('暂时打不开这个界面') })
      }
    })
    control.appendChild(btn)
    row.appendChild(info)
    row.appendChild(control)
    return row
  }

  function buildCard(title: string, fields: SettingsField[], showReset: boolean, entry: unknown = null): HTMLElement {
    const card = document.createElement('section')
    card.className = 'card'
    const entries = toEntryList(entry)

    const head = document.createElement('div')
    head.className = 'card-head'
    const h2 = document.createElement('h2')
    h2.textContent = title
    head.appendChild(h2)
    if (fields.length || entries.length) card.appendChild(head)

    fields.forEach(function (f) { card.appendChild(buildRow(f)) })
    entries.forEach(function (e) { card.appendChild(buildEntryRow(e)) })

    if (showReset) {
      const foot = document.createElement('div')
      foot.className = 'row row--end'
      // 不要说明文字：按钮「恢复默认」本身已经把意思说清楚，这一行只留按钮。
      const fc = document.createElement('div')
      fc.className = 'control'
      const btn = document.createElement('button')
      btn.className = 'btn'
      btn.textContent = '恢复默认'
      btn.addEventListener('click', function () {
        if (btn.disabled) return
        btn.disabled = true
        // 动作型 / 列表型 / 动态列表条目没有可重置的持久值 —— 跳过它们，避免去 reset 一个不存在的键
        const pending = fields.filter(isResettable).map(function (f) {
          return invoke<{ ok?: boolean }>('settings:reset', { key: f.key })
            .then(function (res) { return !res || res.ok !== false })
            .catch(function () { return false })
        })
        Promise.all(pending).then(function (results) {
          if (results.some(function (ok) { return !ok })) showToast('部分设置恢复失败，请重试')
          return withTimeout(loadAll(), 4000)
        }).then(function () {
          renderContent()
          refreshChangedBadge()
          refreshRestartPending()
        }).catch(function () {
          showToast('恢复默认后重新读取失败，请重试')
        }).finally(function () {
          btn.disabled = false
        })
      })
      fc.appendChild(btn)
      foot.appendChild(fc)
      card.appendChild(foot)
    }
    return card
  }

  /**
   * 只更新某一个控件到最新值（外部变更/其它窗口改了设置时调用）。
   * 关键：就地改这一个 DOM 节点，绝不 innerHTML 清空重建整页 ——
   * 否则每次变更都会重放动画、闪一下，表现为"点了之后延迟/卡"。
   */
  function syncControl(key: string): void {
    const el = controlEls[key]
    if (!el) return
    const field = fieldByKey[key]
    if (!field) return
    if (field.type === 'order' || field.type === 'multi-select' || field.itemSchema || field.type === 'record') {
      // 这几类没有单一控件节点，交给它自己的重绘函数
      if (isRepaintControl(el)) el.repaint()
    } else if (field.type === 'toggle' && el instanceof HTMLButtonElement) {
      el.setAttribute('aria-checked', values[key] ? 'true' : 'false')
    } else if (field.type === 'select' && el instanceof HTMLSelectElement) {
      el.value = String(values[key])
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = toDisplay(field)
    }
  }

  /** 插槽逻辑在独立模块中；设置页只把清理函数交给本轮内容重建统一管理。 */
  function appendCustomWidgets(wrap: HTMLElement, section: SettingsSection): void {
    contentDisposers.push(...mountCustomWidgets(document, wrap, section.id))
  }

  /**
   * 一个大类 = 一串分区块（<section id="sec-…">）。
   * 每个分区块自己决定怎么摆字段（全部由 schema 驱动，页面不认识业务）：
   *   · 有 subtabs：块标题（分区名 + 说明）+ 每个子分区一张卡片；
   *   · 没有 subtabs：单卡片，分区名/说明就是卡片标题。
   * 「高级」组的字段永远单独收一张卡。入口按钮挂在分区最后一张卡上。
   */
  function buildSectionBlock(section: SettingsSection): HTMLElement {
    const wrap = document.createElement('section')
    wrap.className = 'block'
    wrap.id = 'sec-' + section.id

    const fields = (section.fields || []).filter(isFieldVisible)
    const advanced = fields.filter(function (f) { return f.group === 'advanced' })
    const body = fields.filter(function (f) { return f.group !== 'advanced' })
    const subtabs = section.subtabs || []

    if (!subtabs.length) {
      // 只有「高级」项时不再拆两张卡（否则会先冒出一张没有内容的空卡）
      const single = !body.length && advanced.length > 0
      const items = single ? advanced : body
      wrap.appendChild(buildCard(section.label || section.id, items, items.some(isResettable), section.entry || null))
      if (!single && advanced.length) wrap.appendChild(buildCard('高级', advanced, false))
      appendCustomWidgets(wrap, section)
      return wrap
    }

    const head = document.createElement('div')
    head.className = 'block-head'
    const h2 = document.createElement('h2')
    h2.textContent = section.label || section.id
    head.appendChild(h2)
    wrap.appendChild(head)

    const specs: Array<{ title: string; fields: SettingsField[]; reset: boolean; targetId?: string }> = []
    subtabs.forEach(function (t) {
      const items = body.filter(function (f) { return f.subtab === t.id })
      if (items.length) specs.push({
        title: t.label || t.id,
        fields: items,
        reset: true,
        targetId: 'subtab-' + section.id + '-' + t.id
      })
    })
    if (advanced.length) specs.push({ title: '高级', fields: advanced, reset: false })

    specs.forEach(function (sp, i) {
      const isLast = i === specs.length - 1
      const card = buildCard(
        sp.title,
        sp.fields,
        sp.reset && sp.fields.some(isResettable),
        isLast ? (section.entry || null) : null
      )
      if (sp.targetId) card.id = sp.targetId
      wrap.appendChild(card)
    })
    appendCustomWidgets(wrap, section)
    return wrap
  }

  /** 解绑上一轮渲染挂出的副作用（见 contentDisposers 的说明）。 */
  function disposeContent(): void {
    contentDisposers.forEach(function (fn) { try { fn() } catch (_) {} })
    contentDisposers = []
  }

  function renderContent(): void {
    const host = document.getElementById('content')
    if (!host) return
    disposeContent() // 先解绑旧树的定时器 / 监听，再丢掉旧节点
    host.innerHTML = ''
    controlEls = {} // 旧节点即将被游离，先清空引用，syncControl 才不会更新到幽灵节点
    spyActive = ''

    // 搜索模式：跨分区列出命中项（仅显示满足显隐条件的项）
    if (query) {
      renderSubtabs(null)
      const hits: SettingsField[] = []
      sections.forEach(function (s) {
        ;(s.fields || []).forEach(function (f) {
          if (!isFieldVisible(f)) return
          if (matchesQuery(f)) hits.push(f)
        })
      })
      const pageTitle = document.getElementById('page-title')
      if (pageTitle) pageTitle.textContent = '搜索结果'
      const q = query.toLowerCase()
      // 只挂入口的分区（如「软件更新」「内部页面」）没有字段可匹配 ——
      // 用分区标题 / 入口文案参与搜索，否则这类分区永远搜不到。
      const entryHits: Record<string, true> = {}
      sections.forEach(function (s) {
        if (!toEntryList(s.entry).length) return
        const hay = [s.label]
        toEntryList(s.entry).forEach(function (e) { hay.push(String(e.label || '')) })
        if (hay.join(' ').toLowerCase().indexOf(q) >= 0) entryHits[s.id] = true
      })
      if (!hits.length && !Object.keys(entryHits).length) {
        const e = document.createElement('div')
        e.className = 'empty'
        e.textContent = '没有匹配「' + query + '」的设置项'
        host.appendChild(e)
        return
      }
      // 按分区归组
      const bySection: Record<string, SettingsField[]> = {}
      hits.forEach(function (f) {
        const sid = sectionIdOf(f)
        if (!bySection[sid]) bySection[sid] = []
        bySection[sid].push(f)
      })
      sections.forEach(function (s) {
        const sec = bySection[s.id]
        if (sec) host.appendChild(buildCard(s.label || s.id, sec, false))
        else if (entryHits[s.id]) host.appendChild(buildCard(s.label || s.id, [], false, s.entry))
      })
      return
    }

    const group = activeGroup()
    if (!group) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '暂无设置项。'
      host.appendChild(empty)
      return
    }
    const pageTitle = document.getElementById('page-title')
    if (pageTitle) pageTitle.textContent = group.name
    renderSubtabs(group)

    group.sections.forEach(function (s) { host.appendChild(buildSectionBlock(s)) })

    setupScrollSpy()
    updateSubtabSpy()
  }

  function renderPageError(error?: unknown): void {
    const host = document.getElementById('content')
    if (!host) return
    host.textContent = ''
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '设置加载失败：' + (error instanceof Error ? error.message : '未知原因')
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'btn'
    retry.textContent = '重试'
    retry.addEventListener('click', function () { window.location.reload() })
    empty.appendChild(retry)
    host.appendChild(empty)
  }

  function sectionIdOf(field: SettingsField): string {
    const section = sectionOfField(field && field.key)
    return section ? section.id : (sections[0] && sections[0].id)
  }

  /* ── 搜索框：**纯本地**过滤（schema 已在手），比对 label / key ——
   *     中文名与键名都能命中；不再走 settings:search（那条只认英文键名，
   *     且用分区 id 去套设置键前缀，两边口径本来就不一致）。── */
  requiredElement<HTMLInputElement>('#q').addEventListener('input', function (e) {
    const target = e.target
    query = target instanceof HTMLInputElement ? target.value.trim() : ''
    renderNav()
    renderContent()
    scheduleSettingsRoute({ section: '', key: '', query: query })
  })

  document.addEventListener('keydown', function (event: KeyboardEvent) {
    const input = searchInput()
    const target = event.target as HTMLElement | null
    const editing = !!target && !!target.closest('input, textarea, select, [contenteditable="true"]')
    if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === '/') {
      event.preventDefault()
      input.focus()
      input.select()
      return
    }
    if (event.key === 'Escape' && document.activeElement === input && query) {
      event.preventDefault()
      query = ''
      input.value = ''
      renderNav()
      renderContent()
      replaceSettingsRoute({ section: '', key: '', query: '' })
    }
  })

  window.addEventListener('popstate', function () {
    applySettingsRoute(readSettingsRoute(location.search))
  })

  /* ── 订阅变更：其它窗口改了设置时本页同步刷新。
   *     程序化改控件值不会触发 change 事件，因此不会回环写回。 */
  if (bridge && bridge.on && typeof bridge.on.subscribe === 'function') {
    bridge.on.subscribe<{ scope?: string; key?: string; value?: unknown }>('settings:changed', function (c) {
      if (!c) return
      if (c.scope === 'all') {
        for (const key in saveSeq) saveSeq[key] = (saveSeq[key] || 0) + 1
        withTimeout(loadAll(), 4000).then(function () {
          renderContent(); refreshChangedBadge(); refreshRestartPending(); refreshCssVars()
        }).catch(function () {
          showToast('设置同步失败，已保留当前显示')
        })
        return
      }
      if (!c.key) return
      const field = fieldByKey[c.key]
      if (!field) return
      saveSeq[c.key] = (saveSeq[c.key] || 0) + 1
      // 动态列表（自定义 Bang / 自定义搜索引擎）由路由驱动，没有可比较的持久值：
      // 每次变更（新增/改名/删除）都重新拉取并就地重绘。
      if (field.itemSchema) {
        syncControl(c.key)
        return
      }
      const next = (c.value === undefined || c.value === null) ? defaultFor(field) : c.value
      // 值没变就不重绘，避免打断用户正在输入
      if (values[c.key] === next) return
      values[c.key] = next
      // 就地更新单个控件，而非整页重建 —— 消除卡顿的关键
      syncControl(c.key)
      refreshChangedBadge()
      refreshRestartPending()
      refreshCssVars()
    })
  }

  /* ── 启动：先拿 schema（决定画什么），再拿值（决定画成什么样）── */
  wireSidebarMore()
  const rendererSlotsReady = withTimeout(activateRendererSlots(), 2500).catch(function (e) {
    // 插件系统不可用不阻断设置页；内建控件与值仍然必须可用。
    console.warn('[settings] 渲染侧插件插槽加载失败:', e && e.message)
  })
  pluginsClient.onChanged(function () {
    withTimeout(activateRendererSlots(), 2500).catch(function (e) {
      console.warn('[settings] 渲染侧插件插槽刷新失败:', e && e.message)
    })
  })
  onRendererSlotsChanged(function () {
    if (sections.length) renderContent()
  })
  withTimeout(invoke('settings:schema', {}), 4000).then(function (s) {
    schema = Array.isArray(s) ? s : []
    indexSchema()
    const groups = groupList()
    const fieldSection = sectionOfField(initialSettingsRoute.key)
    const section = fieldSection || sections.filter(function (item) {
      return item.id === initialSettingsRoute.section
    })[0] || null
    const wantedGroup = initialSettingsRoute.group || groupIdForSection(section) ||
      (groups.some(function (g) { return g.id === initialSettingsRoute.section }) ? initialSettingsRoute.section : '')
    // 深链可直达大类 / 分区 / 字段；无效 id 回到第一个真正的大类，
    // 「门」型大类不承载内容，不能成为落点。
    const home = groups.filter(function (g) { return !g.href && g.id === wantedGroup })[0] ||
      groups.filter(function (g) { return !g.href })[0] || groups[0]
    currentGroup = home ? home.id : null
    query = initialSettingsRoute.query
    searchInput().value = query
    // 动态选项（如主题目录）必须在 loadAll 之前解析完：defaultFor 会读 field.options[0]，
    // 空选项会让"值缺失时"的回落落到空串，进而把下拉画成未选中。
    return resolveDynamicOptions().then(function () { return withTimeout(loadAll(), 4000) })
  }).then(async function () {
    await rendererSlotsReady
    renderNav()
    renderContent()
    refreshChangedBadge()
    // 载入时的值 = 应用启动时读到的值（重启型设置只在启动读一次）→ 作为已生效基线
    captureRestartBaseline()
    refreshCssVars()
    const targetFieldSection = sectionOfField(initialSettingsRoute.key)
    const targetSection = targetFieldSection || sections.filter(function (item) {
      return item.id === initialSettingsRoute.section
    })[0]
    replaceSettingsRoute({
      group: currentGroup,
      section: targetSection ? targetSection.id : '',
      key: targetFieldSection ? initialSettingsRoute.key : '',
      query: query
    })
    focusSettingsTarget(targetSection ? targetSection.id : '', targetFieldSection ? initialSettingsRoute.key : '')
  }).catch(function (e) {
    console.error('[settings] schema/init failed:', e && e.message)
    renderPageError(e)
  })
})()
