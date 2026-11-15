/**
 * AI 引擎 · 浏览器操作工具（设置 / 内部页 / 面板 / 历史 / 集锦 / 书签）。
 *
 * 与 `tools.cjs` 的分工：那边只碰「网页」与「标签」，这边只碰**浏览器本身**。
 * 拆成独立文件是为了让「再加一类浏览器能力」永远只动一处 —— 注册出口仍是
 * `createBuiltinTools()` 一个（见 tools.cjs 末尾的 concat），模型看到的是一张工具表。
 *
 * 三条纪律：
 *   1. **不认识 Electron 窗口模型** —— 布局 / 面板宿主 / 域服务全部走注入端口；
 *   2. **结果必须短** —— 工具结果进模型前会被截断（6000 字符），所以一律分页 +
 *      limit 上限 + 摘录截断，绝不把整份设置 / 整个书签树原样倒出去；
 *   3. **先查后改** —— 写类工具按 schema 归一（开关 / 数字 / 下拉按取值或中文名匹配），
 *      避免模型把 "true" 当字符串写进布尔键。
 *
 * 审批策略见 tools.cjs 文件头：设置写入用 `site`（同一会话问一次，可勾"记住"），
 * 开关面板 / 打开内部页只影响看得见的界面，用 `never`。
 */

const { PAGES, pageUrl } = require('@hira-ng/shared-types/src/pages.mjs')

import type {
  AiToolDefinition,
  AiToolHost,
  BrowserLayoutPort,
  JsonSchema,
  PageDescriptor,
  PanelCatalogEntry,
  PanelPresentationPort,
  SettingsField,
  SettingsOption,
  SettingsSection,
  ToolArgs
} from '../types'

const pageDescriptors = PAGES as PageDescriptor[]
const PAGE_BY_HOST = new Map<string, PageDescriptor>(pageDescriptors.map((page) => [page.host, page]))

interface SettingsFieldView {
  key: string
  label: string
  type: string
  value: unknown
  section: string
  sectionLabel: string
  effect: string
  options?: SettingsOption[]
  desc?: string
  default?: unknown
}

interface SettingsMutationView {
  ok: true
  key: string
  label: string
  type: string
  known: boolean
  previous: unknown
  value: unknown
  effect: string
  note?: string
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/** 整数夹取：模型给的 limit 不可信，越界一律夹到区间内。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

/** 单行摘录（压掉换行与连续空白，超长截断）。 */
function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 设置字段的选项归一化。
 * registry 里的 `options` 是 `[[value, label], ...]` 二元组（个别字段可能给对象），
 * 这里统一成 `{ value, label }` —— 模型既看得懂中文名，也拿得到要写回的值。
 */
function optionPairs(field: SettingsField): SettingsOption[] {
  const raw = field && field.options
  if (!Array.isArray(raw)) return []
  const out: SettingsOption[] = []
  for (const opt of raw) {
    if (Array.isArray(opt)) {
      if (opt[0] === undefined) continue
      out.push({ value: opt[0], label: String(opt[1] == null ? opt[0] : opt[1]) })
    } else if (opt && typeof opt === 'object') {
      if (opt.value === undefined) continue
      out.push({ value: opt.value, label: String(opt.label == null ? opt.value : opt.label) })
    } else if (opt !== undefined) {
      out.push({ value: opt, label: String(opt) })
    }
  }
  return out
}

/** 开关类取值：接受 true/false、1/0、开/关、on/off、yes/no。 */
function coerceToggle(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
  if (['true', '1', 'on', 'yes', '开', '开启', '是', '打开'].includes(s)) return true
  if (['false', '0', 'off', 'no', '关', '关闭', '否', '关上'].includes(s)) return false
  throw new Error(`这是开关项，值只能是 true / false（也接受 开 / 关），收到：${String(raw)}`)
}

/** 下拉项匹配：先按值，再按中文名（大小写与首尾空白不敏感）。 */
function matchOption(options: SettingsOption[], raw: unknown): SettingsOption | null {
  const key = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!key) return null
  for (const opt of options) if (String(opt.value).toLowerCase() === key) return opt
  for (const opt of options) if (String(opt.label).trim().toLowerCase() === key) return opt
  return null
}

/**
 * @param {{
 *   getTabManager: () => any,
 *   getServices: () => any,
 *   getLayout?: () => any,
 *   getPanelPresentation?: () => any,
 *   listPanels?: () => any[]
 * }} host
 */
function createBrowserTools(host: AiToolHost): AiToolDefinition[] {
  const getTabManager = host.getTabManager
  const getServices = host.getServices
  const getLayout = host.getLayout || (() => null)
  const getPanelPresentation = host.getPanelPresentation || (() => null)
  const listPanels = host.listPanels || (() => [])
  const getAppActions = () => host.appActions || null

  const layoutOf = () => {
    try { return getLayout() || null } catch (_) { return null }
  }
  const presentationOf = () => {
    try { return getPanelPresentation() || null } catch (_) { return null }
  }
  const panelsOf = () => {
    try {
      const rows = listPanels()
      return Array.isArray(rows) ? rows : []
    } catch (_) { return [] }
  }
  /** 面板数据面摘要：`{ [panelId]: { kind, source } }`。没有数据面的面板不在表里。 */
  const panelDataSummary = () => {
    try {
      const data = host.panelData
      return data && typeof data.summary === 'function' ? (data.summary() || {}) : {}
    } catch (_) { return {} }
  }
  const sideOf = (layout: BrowserLayoutPort | null, panelId: string): string | null => {
    if (!layout || typeof layout.getPanelSideOf !== 'function') return null
    try { return layout.getPanelSideOf(panelId) || null } catch (_) { return null }
  }
  const closePanel = (layout: BrowserLayoutPort | null, panelId: string): boolean => {
    if (!layout || typeof layout.closePanel !== 'function') return false
    try { return !!layout.closePanel(panelId) } catch (_) { return false }
  }
  const isDetached = (presentation: PanelPresentationPort | null, panelId: string): boolean => {
    if (!presentation || typeof presentation.isDetached !== 'function') return false
    try { return !!presentation.isDetached(panelId) } catch (_) { return false }
  }

  /** 设置域端口（服务 + schema 注册中心）。 */
  function settingsPort() {
    const s = getServices() || {}
    if (!s.settingsService || typeof s.settingsService.set !== 'function') throw new Error('设置服务不可用')
    return s
  }

  /** 设置 schema（按导航顺序的分区数组）。插件没装/注册中心缺失时返回空数组。 */
  function schemaSections(): SettingsSection[] {
    const reg = (getServices() || {}).settingsRegistry
    if (!reg || typeof reg.getSchema !== 'function') return []
    try {
      const rows = reg.getSchema()
      return Array.isArray(rows) ? rows as SettingsSection[] : []
    } catch (_) { return [] }
  }

  function findField(sections: SettingsSection[], key: string): { section: SettingsSection; field: SettingsField } | null {
    for (const section of sections) {
      for (const field of section.fields || []) {
        if (field.key === key) return { section, field }
      }
    }
    return null
  }

  function settingText(value: unknown): string {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[\s._:/\\\-]+/g, '')
  }

  function settingCandidates(sections: SettingsSection[], query: string) {
    const needle = settingText(query)
    if (!needle) return []
    const grams = Array.from(needle).length > 1
      ? Array.from({ length: Array.from(needle).length - 1 }, (_value, index) => Array.from(needle).slice(index, index + 2).join(''))
      : []
    const subject = needle
      .replace(/显示方式|是否启用|是否显示|开关状态|启用状态|默认值/g, '')
      .replace(/打开|关闭|启用|禁用|显示|设置|模式|开关|选项/g, '')
    const scored: Array<{ section: SettingsSection; field: SettingsField; score: number }> = []
    for (const section of sections) {
      for (const field of section.fields || []) {
        const key = settingText(field.key)
        const label = settingText(field.label)
        const desc = settingText(field.desc)
        const sectionLabel = settingText(section.label)
        let score = 0
        if (key === needle) score = 1000
        else if (label === needle) score = 900
        else if (label.startsWith(needle)) score = 700
        else if (key.includes(needle)) score = 560
        else if (label.includes(needle)) score = 500
        else if (desc.includes(needle)) score = 260
        else if (sectionLabel.includes(needle)) score = 120
        if (grams.length) {
          const searchable = `${key}${label}${desc}`
          score += grams.filter((gram) => searchable.includes(gram)).length * 75
          if (subject.length >= 2 && searchable.includes(subject)) score += subject.length * 90
        }
        if (score) scored.push({ section, field, score })
      }
    }
    return scored.sort((left, right) => right.score - left.score)
  }

  function resolveSetting(sections: SettingsSection[], keyValue: unknown, queryValue: unknown) {
    const key = String(keyValue || '').trim()
    if (key) {
      const exact = findField(sections, key)
      if (exact) return { exact, candidates: [] as Array<{ section: SettingsSection; field: SettingsField; score: number }> }
    }
    const query = String(queryValue || key || '').trim()
    const candidates = settingCandidates(sections, query)
    if (candidates.length === 1) return { exact: { section: candidates[0].section, field: candidates[0].field }, candidates }
    // 中文描述常把词序打乱（“书签栏显示方式” vs “显示书签栏”）。仅当第一名
    // 明显领先时自动采用，接近分数仍返回候选，避免静默改错设置。
    if (candidates.length > 1 && candidates[0].score >= 180 && candidates[0].score - candidates[1].score >= 60) {
      return { exact: { section: candidates[0].section, field: candidates[0].field }, candidates }
    }
    return { exact: null, candidates }
  }

  function candidateViews(candidates: Array<{ section: SettingsSection; field: SettingsField; score: number }>) {
    const settingsService = settingsPort().settingsService
    return candidates.slice(0, 8).map(({ section, field }) => ({
      key: field.key,
      label: field.label || field.key,
      section: section.id,
      sectionLabel: section.label || section.id,
      type: field.type || 'text',
      value: settingsService.get(field.key),
      options: optionPairs(field),
      ...(field.type === 'action' ? actionView(field) : {})
    }))
  }

  function actionView(field: SettingsField) {
    const action = recordOf(field.action)
    const route = String(action.runRoute || '')
    const actions = getAppActions()
    const routes = actions && typeof actions.settingsActionRoutes === 'function'
      ? actions.settingsActionRoutes()
      : []
    return {
      runRoute: route,
      runnable: !!route && routes.includes(route),
      runLabel: String(action.runLabel || '执行')
    }
  }

  function actionSettings(sections: SettingsSection[]) {
    const out: Array<Record<string, unknown>> = []
    for (const section of sections) {
      for (const field of section.fields || []) {
        if (field.type !== 'action') continue
        out.push({
          key: field.key,
          label: field.label || field.key,
          section: section.id,
          sectionLabel: section.label || section.id,
          ...actionView(field)
        })
      }
    }
    return out
  }

  function fieldView(section: SettingsSection | null, field: SettingsField, value: unknown, withDesc: boolean): SettingsFieldView {
    const view: SettingsFieldView = {
      key: field.key,
      label: field.label || field.key,
      type: field.type || 'text',
      value,
      section: section ? section.id : '',
      sectionLabel: section ? section.label : '',
      effect: field.effect || 'live'
    }
    const options = optionPairs(field)
    if (options.length) view.options = options
    if (withDesc && field.desc) view.desc = field.desc
    return view
  }

  /**
   * 执行一个动作型设置。与设置页共用同一份 runRoute 实现，避免导出/导入等
   * 能力在 UI 与 Agent 两侧各写一套。未知或歧义时返回候选，绝不猜着执行。
   */
  async function runSettingAction(args: ToolArgs) {
    const key = String(args.key || '').trim()
    if (!key && !String(args.query || '').trim()) throw new Error('key 或 query 至少提供一个')
    const resolved = resolveSetting(schemaSections(), key, args.query)
    if (!resolved.exact) {
      return {
        ok: false,
        code: resolved.candidates.length ? 'AI_SETTING_AMBIGUOUS' : 'AI_SETTING_NOT_FOUND',
        message: resolved.candidates.length ? '匹配到多个设置项，请从 candidates 中选择 key' : '没有找到这个设置动作',
        candidates: candidateViews(resolved.candidates)
      }
    }
    const { section, field } = resolved.exact
    if (field.type !== 'action') {
      return {
        ok: false,
        code: 'AI_SETTING_NOT_ACTION',
        message: `「${field.label || field.key}」是普通设置项，请使用 setting_set`,
        key: field.key,
        type: field.type || 'text'
      }
    }
    const action = recordOf(field.action)
    const route = String(action.runRoute || '').trim()
    if (!route) throw new Error(`「${field.label || field.key}」没有声明可执行路由`)
    const actions = getAppActions()
    if (!actions || typeof actions.runSettingAction !== 'function') {
      throw new Error(`设置动作执行器不可用，无法执行「${field.label || field.key}」`)
    }
    const wrapped = recordOf(await actions.runSettingAction(route, {}))
    const result = recordOf(wrapped.result)
    return {
      ok: result.ok !== false && result.canceled !== true,
      key: field.key,
      label: field.label || field.key,
      section: section.id,
      sectionLabel: section.label || section.id,
      type: 'action',
      runRoute: route,
      executed: true,
      canceled: result.canceled === true,
      result,
      note: '动作型设置已执行；结果已包含在本次返回中，不需要再读取该设置项'
    }
  }

  /** 打开一个内部页（`hira://<host>`），返回新标签。 */
  async function openPage(hostName: string, query?: unknown) {
    const tm = getTabManager && getTabManager()
    if (!tm || typeof tm.newTab !== 'function') throw new Error('标签管理器不可用')
    const url = pageUrl(hostName, query)
    const res = await tm.newTab({ url })
    return { url, tabId: res && res.tabId }
  }

  function activeTabView() {
    try {
      const tm = getTabManager && getTabManager()
      const tabId = tm && typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : null
      const tab = tabId && tm && typeof tm.list === 'function'
        ? (tm.list() || []).find((item: { tabId?: string }) => String(item.tabId) === String(tabId))
        : null
      return tab ? {
        tabId: tab.tabId,
        title: tab.title || '',
        url: tab.url || '',
        loading: !!tab.loading
      } : null
    } catch (_) {
      return null
    }
  }

  const tools: AiToolDefinition[] = [
    // ── 设置：读 ─────────────────────────────────────────────────────────
    {
      name: 'settings_list',
      description: '查看浏览器设置。不带参数：列出所有设置分区；带 section：列出该分区；带 query：按中文名称、说明或内部键名搜索。设置写入不需要先调用它，settings_set 也能直接按中文名称匹配。',
      parameters: obj({
        section: { type: 'string', description: '分区 id（如 general / appearance / privacy）；省略则返回分区目录' },
        query: { type: 'string', description: '关键词，匹配键名 / 中文名 / 说明' },
        limit: { type: 'number', description: '最多返回多少条字段，默认 40，上限 80' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const { settingsService } = settingsPort()
        const sections = schemaSections()
        if (!sections.length) throw new Error('设置表不可用（设置注册中心未就绪）')

        const sectionId = String(args.section || '').trim()
        const query = String(args.query || '').trim().toLowerCase()

        if (!sectionId && !query) {
          const items = sections
            .map((s) => ({
              id: s.id,
              label: s.label,
              group: s.groupLabel || s.group || '',
              blurb: s.blurb || '',
              fields: (s.fields || []).length
            }))
            .filter((s) => s.fields > 0)
          return { total: items.length, sections: items, hint: '用 settings_list({section:"<id>"}) 查看该分区的具体设置项' }
        }

        if (sectionId && !sections.some((s) => s.id === sectionId)) {
          throw new Error(`没有这个设置分区：${sectionId}。可用分区：${sections.map((s) => s.id).join(', ')}`)
        }

        const picked = []
        for (const s of sections) {
          if (sectionId && s.id !== sectionId) continue
          for (const f of s.fields || []) {
            if (query) {
              const hay = `${f.key} ${f.label || ''} ${f.desc || ''} ${s.label || ''}`.toLowerCase()
              if (!hay.includes(query)) continue
            }
            picked.push({ section: s, field: f })
          }
        }

        const limit = clampInt(args.limit, 40, 1, 80)
        const items = picked.slice(0, limit).map(({ section, field }) =>
          fieldView(section, field, settingsService.get(field.key), false))
        return {
          total: picked.length,
          returned: items.length,
          items,
          ...(picked.length > items.length ? { hint: '结果已截断，用 limit 或更精确的 section 继续查' } : {})
        }
      }
    },
    {
      name: 'settings_get',
      description: '读取单个设置。key 或 query 至少给一个；query 可用中文名称或关键词，唯一命中时直接返回，模糊时返回候选。',
      parameters: obj({
        key: { type: 'string', description: '设置键名；已知时可直接给' },
        query: { type: 'string', description: '中文名称或关键词，例如“深色主题”“下载目录”' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const { settingsService } = settingsPort()
        const sections = schemaSections()
        const key = String(args.key || '').trim()
        if (!key && !String(args.query || '').trim()) throw new Error('key 或 query 至少提供一个')
        const resolved = resolveSetting(sections, key, args.query)
        if (!resolved.exact) {
          if (key && !String(args.query || '').trim()) {
            return { key, known: false, value: settingsService.get(key), note: '该键不在设置表里，可能来自插件或扩展' }
          }
          return {
            ok: false,
            code: 'AI_SETTING_AMBIGUOUS',
            message: resolved.candidates.length ? '匹配到多个设置项，请从 candidates 中选择更准确的名称或 key' : '没有找到匹配的设置项',
            candidates: candidateViews(resolved.candidates)
          }
        }
        const found = resolved.exact
        const view = fieldView(found.section, found.field, settingsService.get(found.field.key), true)
        if (found.field.default !== undefined) view.default = found.field.default
        return view
      }
    },

    // ── 设置：写（按 schema 归一；同会话问一次）─────────────────────────
    {
      name: 'settings_set',
      description: '修改一个浏览器设置。可直接传中文 query（如“深色主题”“下载前询问”），无需提前查询内部键名；唯一命中时自动应用。值会按开关、数字、下拉或文本自动归一。模糊或未知时返回候选，不写入。',
      parameters: obj({
        key: { type: 'string', description: '可选，准确的设置键名' },
        query: { type: 'string', description: '可选，中文名称或关键词' },
        value: { description: '新值：开关 true/false，数字 number，下拉用中文名或取值，文本用字符串' },
        allowUnknown: { type: 'boolean', description: '仅当 key 是已确认的插件/扩展设置键时设为 true，允许写入设置表之外的键' }
      }, ['value']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const { settingsService } = settingsPort()
        let key = String(args.key || '').trim()
        if (!key && !String(args.query || '').trim()) throw new Error('key 或 query 至少提供一个')
        if (args.value === undefined) throw new Error('value 不能为空')

        const sections = schemaSections()
        const resolved = resolveSetting(sections, key, args.query)
        const found = resolved.exact
        if (!found && args.allowUnknown !== true) {
          return {
            ok: false,
            code: resolved.candidates.length ? 'AI_SETTING_AMBIGUOUS' : 'AI_SETTING_NOT_FOUND',
            message: resolved.candidates.length
              ? '匹配到多个设置项，请从 candidates 中选择 key 后重试'
              : '没有找到这个设置；若确认是插件设置，需要 allowUnknown=true 和准确 key',
            candidates: candidateViews(resolved.candidates)
          }
        }
        if (found) key = String(found.field.key)
        const previous = settingsService.get(key)
        let next: unknown = args.value
        let label = key
        let type = 'text'
        let effect = 'live'

        if (found) {
          const { field } = found
          label = field.label || key
          type = field.type || 'text'
          effect = field.effect || 'live'
          if (type === 'action') {
            return {
              ok: false,
              code: 'AI_SETTING_ACTION_REQUIRED',
              message: `「${label}」是动作型条目（执行一次），请改用 browser_control 的 setting_action`,
              key: field.key,
              candidates: [{
                key: field.key,
                label,
                section: found.section.id,
                sectionLabel: found.section.label || found.section.id,
                type: 'action',
                ...actionView(field)
              }]
            }
          }
          if (type === 'select') {
            const options = optionPairs(field)
            const hit = matchOption(options, next)
            if (!hit) {
              throw new Error(`「${label}」的取值无效：${String(next)}。可选：${options.map((o) => `${o.value}（${o.label}）`).join(' / ')}`)
            }
            next = hit.value
          } else if (type === 'toggle') {
            next = coerceToggle(next)
          } else if (type === 'number') {
            const n = Number(next)
            if (!Number.isFinite(n)) throw new Error(`「${label}」是数字项，收到：${String(next)}`)
            next = n
          } else {
            next = String(next)
          }
        } else if (next !== null && typeof next === 'object') {
          throw new Error(`不认识的设置键「${key}」，且值不是简单类型；先用 settings_list 查准确键名`)
        }

        settingsService.set(key, next)
        const out: SettingsMutationView = {
          ok: true,
          key,
          label,
          type,
          known: found !== null,
          previous,
          value: settingsService.get(key),
          effect
        }
        if (effect === 'restart') out.note = '该项需要重启浏览器后生效'
        if (!found) out.note = '已按 allowUnknown=true 写入设置表之外的键'
        return out
      }
    },
    {
      name: 'settings_reset',
      description: '把单个设置恢复为默认值。可传准确 key，也可传中文 query；唯一命中时直接恢复。',
      parameters: obj({
        key: { type: 'string' },
        query: { type: 'string', description: '中文名称或关键词' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const { settingsService } = settingsPort()
        let key = String(args.key || '').trim()
        if (!key && !String(args.query || '').trim()) throw new Error('key 或 query 至少提供一个')
        const resolved = resolveSetting(schemaSections(), key, args.query)
        if (!resolved.exact) {
          return {
            ok: false,
            code: resolved.candidates.length ? 'AI_SETTING_AMBIGUOUS' : 'AI_SETTING_NOT_FOUND',
            message: resolved.candidates.length ? '匹配到多个设置项，请选择 key 后重试' : '没有找到这个设置',
            candidates: candidateViews(resolved.candidates)
          }
        }
        if (resolved.exact.field.type === 'action') {
          return {
            ok: false,
            code: 'AI_SETTING_ACTION_REQUIRED',
            message: `「${resolved.exact.field.label || key}」是动作型条目，没有可恢复的常驻值；请使用 browser_control 的 setting_action`,
            key: resolved.exact.field.key
          }
        }
        key = String(resolved.exact.field.key)
        const previous = settingsService.get(key)
        const ok = settingsService.reset(key)
        if (!ok) throw new Error(`「${key}」没有默认值（或键不存在），无法恢复默认`)
        return { ok: true, key, previous, value: settingsService.get(key) }
      }
    },

    // ── 内部页 ───────────────────────────────────────────────────────────
    {
      name: 'internal_page_list',
      description: '列出全部浏览器内部页（设置 / 历史 / 书签 / 下载 / 扩展 / 任务管理器…）及其 host。要打开某个管理页面时先查 host。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        return {
          total: PAGES.length,
          pages: pageDescriptors.map((page) => ({ host: page.host, label: page.label, group: page.section || '' }))
        }
      }
    },
    {
      name: 'internal_page_open',
      description: '在新标签打开一个浏览器内部页（hira://）。host 取 internal_page_list 的结果，例如 settings / history / bookmarks / downloads / extensions。query 是可选参数对象（如 {section:"privacy"}）。',
      parameters: obj({
        host: { type: 'string', description: '内部页 host，也可直接给 hira://xxx' },
        query: { type: 'object', description: '可选查询参数（键值对）' }
      }, ['host']),
      risk: 'write',
      approval: 'never',
      async execute(args: ToolArgs) {
        const raw = String(args.host || '')
          .trim()
          .replace(/^hira:\/\//i, '')
          .replace(/[?#].*$/, '')
          .replace(/\/+$/, '')
          .toLowerCase()
        const def = PAGE_BY_HOST.get(raw)
        if (!def) throw new Error(`没有这个内部页：${raw || '(空)'}。可用：${pageDescriptors.map((page) => page.host).join(', ')}`)
        const query = args.query && typeof args.query === 'object' ? args.query : undefined
        const opened = await openPage(def.host, query)
        return { ok: true, label: def.label, ...opened }
      }
    },

    // ── 侧栏面板 ─────────────────────────────────────────────────────────
    {
      name: 'panel_list',
      description: '列出侧栏面板（收藏 / 集锦 / 历史 / 下载 / 扩展…），标明每个面板开在哪一侧、是否拆成独立窗口、是否被固定（pinned），以及有没有可供 panel_read 读取的数据面（hasData / dataKind）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const layout = layoutOf()
        const presentation = presentationOf()
        const summary = panelDataSummary()
        const items = panelsOf().map((p: PanelCatalogEntry) => {
          const panelId = String(p.id || '')
          const side = sideOf(layout, panelId)
          const detached = isDetached(presentation, panelId)
          const item: Record<string, unknown> = { panelId, title: p.title || panelId, open: !!(side || detached) }
          if (side) item.side = side
          if (detached) item.detached = true
          // 面板图钉：钉在 rail / 导航上的常驻入口（与书签的 pinned 不是一回事）。
          if (layout && typeof layout.isPanelPinned === 'function') {
            item.pinned = !!layout.isPanelPinned(panelId)
          }
          if (p.opensPage) item.opensPage = p.opensPage
          const data = summary[panelId]
          item.hasData = !!data
          if (data) {
            item.dataKind = data.kind
            item.dataSource = data.source
          }
          return item
        })
        return {
          total: items.length,
          panels: items,
          ...(items.some((p) => p.hasData) ? { hint: '用 panel_read(panelId) 读取任意面板里的完整数据' } : {})
        }
      }
    },
    {
      name: 'panel_control',
      description: '打开 / 关闭 / 切换一个侧栏面板。action 取 open / close / toggle；side 取 left / right（省略用默认侧）。某些入口本质是内部页（返回里带 opensPage），会自动改成开标签。',
      parameters: obj({
        panelId: { type: 'string', description: 'panel_list 返回的 panelId' },
        action: { type: 'string', enum: ['open', 'close', 'toggle'], description: '默认 toggle' },
        side: { type: 'string', enum: ['left', 'right'], description: '打开到哪一侧，省略用默认' }
      }, ['panelId']),
      risk: 'write',
      approval: 'never',
      async execute(args: ToolArgs) {
        const panelId = String(args.panelId || '').trim()
        if (!panelId) throw new Error('panelId 不能为空')
        const panels = panelsOf()
        const entry = panels.find((p) => String(p.id) === panelId)
        if (!entry) {
          throw new Error(`没有这个面板：${panelId}。可用：${panels.map((panel: PanelCatalogEntry) => panel.id).join(', ')}`)
        }
        const requestedAction = String(args.action || '')
        const action = ['open', 'close', 'toggle'].includes(requestedAction) ? requestedAction : 'toggle'

        // 目录里标了 opensPage 的「面板」其实是一个内部页入口 —— 直接开页，别硬塞进面板槽。
        if (entry.opensPage) {
          if (action === 'close') {
            return { ok: true, panelId, action, note: '该入口是内部页，请在标签栏关闭它' }
          }
          const opened = await openPage(String(entry.opensPage))
          return { ok: true, panelId, action, opened: 'page', ...opened }
        }

        const layout = layoutOf()
        if (!layout) throw new Error('窗口布局不可用')
        const presentation = presentationOf()
        const side = args.side === 'left' || args.side === 'right' ? args.side : undefined

        if (action === 'open') {
          if (isDetached(presentation, panelId)) {
            return { ok: true, panelId, action, open: true, detached: true }
          }
          const res = recordOf(layout.showPanel(panelId, side))
          return { ok: true, panelId, action, open: res.open !== false, side: res.side || null, detached: false }
        }

        if (action === 'close') {
          if (isDetached(presentation, panelId) && presentation && typeof presentation.dock === 'function') {
            try { presentation.dock(panelId) } catch (_) {}
          }
          const closed = closePanel(layout, panelId)
          return { ok: true, panelId, action, open: false, closed, detached: false }
        }

        // toggle：已开（任意宿主）→ 关；没开 → 开。
        if (isDetached(presentation, panelId)) {
          if (presentation && typeof presentation.dock === 'function') {
            try { presentation.dock(panelId) } catch (_) {}
          }
          closePanel(layout, panelId)
          return { ok: true, panelId, action, open: false, detached: false }
        }
        if (sideOf(layout, panelId)) {
          return { ok: true, panelId, action, open: false, closed: closePanel(layout, panelId), detached: false }
        }
        const res = recordOf(layout.showPanel(panelId, side))
        return { ok: true, panelId, action, open: res.open !== false, side: res.side || null, detached: false }
      }
    },

    // ── 浏览数据：历史 / 集锦 / 书签 ─────────────────────────────────────
    {
      name: 'history_list',
      description: '列出最近访问过的页面（按时间倒序）。要按关键词找历史用 history_search；这里用于「我最近看了什么」。',
      parameters: obj({ limit: { type: 'number', description: '条数，默认 20，上限 100' } }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = (getServices() || {}).historyService
        if (!svc || typeof svc.listRecent !== 'function') throw new Error('历史服务不可用')
        const limit = clampInt(args.limit, 20, 1, 100)
        const rows = await svc.listRecent(limit)
        const items = (Array.isArray(rows) ? rows : []).map((r: { id?: string; title?: string | null; url?: string; favicon?: string | null; lastVisitAt?: number; visitCount?: number }) => ({
          // id 供 history_remove 精确删除；没有它模型只能按 url 猜，容易删错条目。
          id: r.id || '',
          title: r.title || '',
          url: r.url || '',
          favicon: r.favicon || '',
          visitedAt: r.lastVisitAt || null,
          visitCount: r.visitCount || 1
        }))
        return { total: items.length, items }
      }
    },
    {
      name: 'collection_list',
      description: '查看「集锦」（收藏的素材 / 稍后读），可按关键词搜索或按文件夹取。返回标题、来源地址、标签与内容摘录。',
      parameters: obj({
        query: { type: 'string', description: '关键词；省略则列出最近的集锦' },
        folderId: { type: 'string', description: '只看某个文件夹（省略 = 全部）' },
        limit: { type: 'number', description: '条数，默认 20，上限 60' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = (getServices() || {}).notesService
        if (!svc || typeof svc.list !== 'function') throw new Error('集锦服务不可用')
        const query = String(args.query || '').trim()
        let rows
        if (query) {
          if (typeof svc.search !== 'function') throw new Error('集锦搜索不可用')
          rows = await svc.search(query)
        } else {
          const options: Record<string, unknown> = {}
          if (args.folderId !== undefined && args.folderId !== null && String(args.folderId).trim()) {
            options.folderId = String(args.folderId).trim()
          }
          rows = await svc.list(options)
        }
        const list = listOf(rows)
        const limit = clampInt(args.limit, 20, 1, 60)
        return {
          total: list.length,
          items: list.slice(0, limit).map((raw: unknown) => {
            const n = recordOf(raw)
            return {
              id: n.id,
              title: n.title || '',
              kind: n.kind || 'note',
              url: n.url || '',
              folderId: n.folderId || null,
              tags: Array.isArray(n.tags) ? n.tags : [],
              pinned: !!n.pinned,
              modifiedAt: n.modifiedAt || null,
              excerpt: clip(n.content, 120)
            }
          }),
          ...(list.length > limit ? { hint: '还有更多，请加 query 或减小范围' } : {})
        }
      }
    },
    {
      name: 'bookmark_list',
      description: '查看书签。带 query：按关键词搜索；带 parentId：列出该文件夹下的条目；都不带：按文件夹层级展开（含 folder 路径）。',
      parameters: obj({
        query: { type: 'string' },
        parentId: { type: 'string', description: '文件夹 id（省略 = 整个书签树）' },
        limit: { type: 'number', description: '条数，默认 40，上限 80' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = (getServices() || {}).bookmarkService
        if (!svc) throw new Error('书签服务不可用')
        const limit = clampInt(args.limit, 40, 1, 80)
        const query = String(args.query || '').trim()
        const parentId = args.parentId == null ? '' : String(args.parentId).trim()

        /**
         * 书签的「细节标签」：三个固定位相互独立，模型必须能分辨。
         *   pinned        —— 固定到书签栏（用户说"固定在顶部/书签栏"）
         *   railPinned    —— 固定到左侧图标栏（rail）
         *   openInSidebar —— 点击时默认在独立侧栏打开，而不是新标签
         */
        const flagsOf = (b: Record<string, unknown>) => {
          const out: Record<string, unknown> = {
            pinned: !!b.pinned,
            railPinned: !!b.railPinned,
            openInSidebar: !!b.openInSidebar
          }
          if (b.pinnedOrder) out.pinnedOrder = b.pinnedOrder
          if (Array.isArray(b.tags) && b.tags.length) out.tags = b.tags.slice(0, 12)
          if (b.nickname) out.nickname = String(b.nickname)
          if (b.summary) {
            out.summary = clip(b.summary, 160)
            out.hasSummary = true
          } else {
            out.hasSummary = false
          }
          if (b.createdAt) out.createdAt = b.createdAt
          if (b.modifiedAt) out.modifiedAt = b.modifiedAt
          return out
        }

        const summarize = (rows: unknown) => listOf(rows).slice(0, limit).map((raw: unknown) => {
          const b = recordOf(raw)
          return {
            id: b.id,
            title: b.title || '',
            url: b.url || '',
            parentId: b.parentId || null,
            type: b.url ? 'bookmark' : 'folder',
            ...flagsOf(b)
          }
        })

        if (query) {
          if (typeof svc.search !== 'function') throw new Error('书签搜索不可用')
          const rows = await svc.search(query)
          return { total: Array.isArray(rows) ? rows.length : 0, items: summarize(rows) }
        }
        if (parentId) {
          if (typeof svc.list !== 'function') throw new Error('书签列表不可用')
          const rows = await svc.list(parentId)
          return { total: Array.isArray(rows) ? rows.length : 0, items: summarize(rows) }
        }

        if (typeof svc.tree !== 'function') throw new Error('书签树不可用')
        const tree = await svc.tree()
        const items: Array<Record<string, unknown>> = []
        const walk = (nodes: unknown, path: string) => {
          for (const node of Array.isArray(nodes) ? nodes : []) {
            if (items.length >= limit) return
            const bookmark = recordOf(node)
            const title = bookmark.title || ''
            const isFolder = !bookmark.url
            items.push({
              id: bookmark.id,
              title,
              url: bookmark.url || '',
              folder: path,
              type: isFolder ? 'folder' : 'bookmark',
              ...flagsOf(bookmark)
            })
            if (Array.isArray(bookmark.children) && bookmark.children.length) {
              walk(bookmark.children, path ? `${path}/${String(title)}` : String(title))
            }
          }
        }
        walk(tree, '')
        return {
          total: items.length,
          items,
          ...(items.length >= limit ? { hint: '书签树已截断，用 parentId 查看某个文件夹' } : {})
        }
      }
    }
  ]

  const toolByName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`内部能力 ${name} 不可用`)
    return tool
  }

  const flatActions = (): Array<Record<string, unknown>> => {
    const actions = getAppActions()
    if (!actions || typeof actions.list !== 'function') return []
    return (actions.list(undefined, { availableOnly: true }) as Array<{ id: string; label: string; actions: Array<Record<string, unknown>> }>)
      .flatMap((group) => (Array.isArray(group.actions) ? group.actions : []).map((action) => ({
        ...(action as Record<string, unknown>),
        group: group.id,
        groupLabel: group.label
      })))
  }

  tools.push({
    name: 'browser_control',
    description:
      '浏览器设置与操作的首选高层入口。可直接按中文名称改设置、执行动作型设置、查找并执行菜单动作、开关面板、打开内部页或读取浏览器状态；优先一次调用完成，不必先反复搜索工具。' +
      'action_find/action_run 覆盖主菜单、标签页右键和网页右键能力（复制/归档/定时刷新/分屏/速览、剪切复制粘贴、链接与媒体、选区搜索、画中画、元素检查等）；' +
      'status=一次读取设置分区/动作型设置/面板/动作概况；setting_set/reset 会返回 previous/value/effect，已经是确认结果，不要修改前后重复 get；setting_action 按中文 query 执行导出、导入等一次性设置动作并直接返回结果；action_run 可按 actionName 或中文 query 直接执行并返回 currentTab；panel/page_open 同样支持中文 query 唯一命中。',
    parameters: obj({
      command: {
        type: 'string',
        enum: ['status', 'setting_get', 'setting_set', 'setting_reset', 'setting_action', 'action_find', 'action_run', 'panel', 'page_open'],
        description: '要执行的浏览器控制动作'
      },
      query: { type: 'string', description: '设置中文名称/关键词，或动作名称关键词' },
      key: { type: 'string', description: '已知设置键名，可替代 query' },
      value: { description: '设置新值；开关用 true/false 或 开/关' },
      allowUnknown: { type: 'boolean', description: '仅插件设置且 key 已确认时使用' },
      actionName: { type: 'string', description: 'action_run 的准确动作名；省略时可使用 query 自动匹配' },
      actionArgs: { type: 'object', description: 'action_run 的动作参数对象' },
      panelId: { type: 'string', description: 'panel 命令的面板 id；省略时用 query 匹配标题' },
      panelAction: { type: 'string', enum: ['open', 'close', 'toggle'], description: '默认 toggle' },
      side: { type: 'string', enum: ['left', 'right'], description: '面板打开侧' },
      pageHost: { type: 'string', description: 'page_open 的内部页 host；省略时用 query 匹配页面名称' },
      pageQuery: { type: 'object', description: 'page_open 的查询参数对象' }
    }, ['command']),
    risk: 'write',
    approval: (args: ToolArgs) => ['setting_set', 'setting_reset', 'setting_action', 'action_run', 'panel'].includes(String(args.command || ''))
      ? 'site'
      : 'never',
    async execute(args: ToolArgs) {
      const command = String(args.command || '').trim()
      if (command === 'status') {
        const actions = getAppActions()
        const actionGroups = actions && typeof actions.list === 'function'
          ? (actions.list(undefined, { availableOnly: true }) as Array<{ id: string; label: string; actions: unknown[] }>)
            .map((group) => ({ id: group.id, label: group.label, count: Array.isArray(group.actions) ? group.actions.length : 0 }))
          : []
        return {
          ok: true,
          settings: await toolByName('settings_list').execute({}, { sessionId: '' } as never),
          settingsActions: actionSettings(schemaSections()),
          panels: await toolByName('panel_list').execute({}, { sessionId: '' } as never),
          browser: actions && typeof actions.targets === 'function' ? actions.targets() : {},
          actionGroups
        }
      }
      if (command === 'setting_get') {
        return toolByName('settings_get').execute({ key: args.key, query: args.query }, { sessionId: '' } as never)
      }
      if (command === 'setting_set') {
        return toolByName('settings_set').execute({
          key: args.key,
          query: args.query,
          value: args.value,
          allowUnknown: args.allowUnknown === true
        }, { sessionId: '' } as never)
      }
      if (command === 'setting_reset') {
        return toolByName('settings_reset').execute({ key: args.key, query: args.query }, { sessionId: '' } as never)
      }
      if (command === 'setting_action') {
        return runSettingAction(args)
      }
      if (command === 'action_find') {
        const needle = String(args.query || '').trim().toLowerCase()
        if (!needle) throw new Error('action_find 需要 query')
        return {
          query: needle,
          actions: flatActions().filter((action) => {
            const keywords = Array.isArray(action.keywords) ? action.keywords.join(' ') : ''
            const hay = `${action.name || ''} ${action.label || ''} ${action.desc || ''} ${action.groupLabel || ''} ${keywords}`.toLowerCase()
            return hay.includes(needle)
          }).slice(0, 20)
        }
      }
      if (command === 'action_run') {
        const actions = getAppActions()
        if (!actions || typeof actions.run !== 'function') throw new Error('浏览器动作表不可用')
        let name = String(args.actionName || '').trim()
        if (!name) {
          const needle = String(args.query || '').trim().toLowerCase()
          if (!needle) throw new Error('action_run 需要 actionName 或 query')
          const matches = flatActions().filter((action) => {
            const label = String(action.label || '').toLowerCase()
            const actionId = String(action.name || '').toLowerCase()
            const desc = String(action.desc || '').toLowerCase()
            const keywords = Array.isArray(action.keywords) ? action.keywords.join(' ').toLowerCase() : ''
            return label === needle || actionId === needle || label.includes(needle) || desc.includes(needle) || keywords.includes(needle)
          })
          if (matches.length !== 1) {
            return {
              ok: false,
              code: matches.length ? 'CLI_ACTION_AMBIGUOUS' : 'CLI_ACTION_NOT_FOUND',
              message: matches.length ? '匹配到多个浏览器动作，请从 candidates 中选择 actionName' : '没有找到匹配的浏览器动作',
              candidates: matches.slice(0, 10)
            }
          }
          name = String(matches[0].name || '')
        }
        const result = await actions.run(name, args.actionArgs && typeof args.actionArgs === 'object'
          ? args.actionArgs as Record<string, unknown>
          : {})
        return { ...recordOf(result), currentTab: activeTabView() }
      }
      if (command === 'panel') {
        let panelId = String(args.panelId || '').trim()
        if (!panelId) {
          const needle = String(args.query || '').trim().toLowerCase()
          if (!needle) throw new Error('panel 需要 panelId 或 query')
          const matches = panelsOf().filter((panel) => {
            const id = String(panel.id || '').toLowerCase()
            const title = String(panel.title || '').toLowerCase()
            return id.includes(needle) || title.includes(needle)
          })
          if (matches.length !== 1) {
            return {
              ok: false,
              code: matches.length ? 'CLI_PANEL_AMBIGUOUS' : 'CLI_PANEL_NOT_FOUND',
              message: matches.length ? '匹配到多个面板，请选择 panelId' : '没有找到匹配的面板',
              candidates: matches.slice(0, 10).map((panel) => ({ panelId: panel.id, title: panel.title || panel.id }))
            }
          }
          panelId = String(matches[0].id || '')
        }
        return toolByName('panel_control').execute({
          panelId,
          action: args.panelAction,
          side: args.side
        }, { sessionId: '' } as never)
      }
      if (command === 'page_open') {
        let raw = String(args.pageHost || '').trim()
        if (!raw) {
          const needle = String(args.query || '').trim().toLowerCase()
          if (!needle) throw new Error('page_open 需要 pageHost 或 query')
          const matches = pageDescriptors.filter((page) => `${page.host} ${page.label || ''}`.toLowerCase().includes(needle))
          if (matches.length !== 1) {
            return {
              ok: false,
              code: matches.length ? 'CLI_PAGE_AMBIGUOUS' : 'CLI_PAGE_NOT_FOUND',
              message: matches.length ? '匹配到多个内部页，请选择 pageHost' : '没有找到匹配的内部页',
              candidates: matches.slice(0, 10).map((page) => ({ host: page.host, label: page.label }))
            }
          }
          raw = matches[0].host
        }
        const def = PAGE_BY_HOST.get(raw.replace(/^hira:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase())
        if (!def) throw new Error(`没有这个内部页：${raw}`)
        return { ok: true, label: def.label, ...(await openPage(def.host, args.pageQuery)) }
      }
      throw new Error(`不支持的 browser_control.command：${command}`)
    }
  })

  return tools
}

module.exports = { createBrowserTools }
