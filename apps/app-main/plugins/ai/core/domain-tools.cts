/**
 * AI 引擎 · 域数据工具（历史 / 下载 / 扩展 / 权限 / 空间 / 密码 / 应用 / 命名会话 / 集锦 / 书签）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 与另外两张工具表的分工
 * ══════════════════════════════════════════════════════════════════════
 *   · `tools.cjs`      —— 网页与标签（页面、点击、输入、滚动）
 *   · `browser-tools`  —— 浏览器界面（设置、内部页、面板）与只读数据列表
 *   · `app-tools.cjs`  —— 菜单动作面（窗口 / 导航 / 视图 / PWA …）
 *   · **本文件**        —— 上面几张表「看得见但改不动」的数据：删除历史、控制下载、
 *                        启停扩展、改站点权限、建空间、存命名会话……
 *
 * 为什么必须分开：菜单动作是"点一下按钮"，数据面是"改一条记录"，两者的审批语义
 * 与返回形状完全不同。混在一个文件里，加能力时又会回到"这里补一个 if、那里补一个
 * case"的老路。这里只做一件事：把域服务已有的写能力**如实**映射成工具，不重写业务。
 *
 * 三条纪律（与 `browser-tools.cjs` 同源）：
 *   1. 不认识 Electron 窗口模型 —— 域服务全部走注入端口 `getServices()`；
 *   2. 结果必须短 —— 一律分页 + limit 上限 + 摘录截断；
 *   3. 先查后改 —— 写类工具要求调用方先拿到 id（列表工具统一带 id）。
 *
 * 安全边界：密码工具**只暴露站点 / 用户名等元数据**，绝不返回明文密码；
 * 删除类动作一律 `always` 审批，用户每次都要看见。
 */

import type { AiToolDefinition, AiToolHost, JsonSchema, ToolArgs, UnknownRecord } from '../types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/** 整数夹取：模型给的 limit 不可信。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

/** 单行摘录。 */
function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 时间参数归一：接受毫秒 / 秒时间戳、ISO 字符串、`2026-01-01` 这类日期。
 * 秒与毫秒按量级区分（10 位 = 秒），绝不把 2026 年当成 1970 年。
 * @returns {number|null}
 */
function toTs(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n < 1e12 ? n * 1000 : n
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** 归一设置值。 */
function settingOf(raw: unknown): string {
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
  if (['allow', 'block', 'ask'].includes(s)) return s
  throw new Error(`权限设置只能是 allow / block / ask，收到：${String(raw)}`)
}

/**
 * @param {{
 *   getServices: () => any,
 *   getTabManager?: () => any
 * }} host
 */
function createDomainTools(host: AiToolHost): AiToolDefinition[] {
  const getServices = host.getServices

  function services() {
    return getServices() || {}
  }

  function need(name: string, label: string): UnknownRecord {
    const svc = services()[name]
    if (!svc) throw new Error(`${label}不可用（域服务未装配）`)
    return svc as UnknownRecord
  }

  function method(svc: UnknownRecord, name: string, label: string): (...args: unknown[]) => unknown {
    if (!svc || typeof svc[name] !== 'function') throw new Error(`${label}不支持 ${name}`)
    return (svc[name] as (...args: unknown[]) => unknown).bind(svc)
  }

  /** 当前 profile：空间 / 权限这类方法仍按 profile 参数定位。 */
  function pid() {
    try {
      const s = services()
      return typeof s.getProfileId === 'function' ? String(s.getProfileId() || 'default') : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /** 标签条：游戏 / 内部页这类"打开一个页面"的动作走宿主的 getTabManager。 */
  function tabs() {
    const tm = typeof host.getTabManager === 'function' ? host.getTabManager() : null
    if (!tm) throw new Error('标签管理器不可用（宿主未注入 getTabManager）')
    return tm
  }

  const tools: AiToolDefinition[] = [
    // ── 历史：删除 ────────────────────────────────────────────────────────
    {
      name: 'history_remove',
      description: '删除浏览历史。四种方式**任选其一**：ids（按 id，来自 history_list / history_search）、before（某时间之前）、after（某时间之后）、all（全部清空）。时间接受 ISO 字符串或时间戳。',
      parameters: obj({
        ids: { type: 'array', items: { type: 'string' }, description: '要删除的历史条目 id 列表' },
        before: { type: 'string', description: '删除这个时间之前的历史（ISO 或时间戳）' },
        after: { type: 'string', description: '删除这个时间之后的历史（ISO 或时间戳）' },
        all: { type: 'boolean', description: '清空全部历史（危险）' }
      }),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const svc = need('historyService', '历史服务')
        const ids = Array.isArray(args.ids) ? args.ids.map((v) => String(v || '').trim()).filter(Boolean) : []
        const before = toTs(args.before)
        const after = toTs(args.after)
        const all = args.all === true
        const picked = [ids.length > 0, before != null, after != null, all].filter(Boolean).length
        if (picked === 0) throw new Error('要给 ids / before / after / all 之一')
        if (picked > 1) throw new Error('一次只能选一种删除方式（ids / before / after / all），避免误删')

        if (ids.length) {
          const removed = await method(svc, 'removeMany', '历史服务')(ids)
          return { ok: true, target: 'ids', requested: ids.length, removed }
        }
        if (before != null) {
          const removed = await method(svc, 'removeBefore', '历史服务')(before)
          return { ok: true, target: 'before', before, removed }
        }
        if (after != null) {
          const removed = await method(svc, 'removeAfter', '历史服务')(after)
          return { ok: true, target: 'after', after, removed }
        }
        const removed = await method(svc, 'clearAll', '历史服务')()
        return { ok: true, target: 'all', removed }
      }
    },

    // ── 下载：列表 + 控制 ─────────────────────────────────────────────────
    {
      name: 'downloads_list',
      description: '查看下载列表（含进度 / 状态 / 保存路径）。只读；暂停 / 取消 / 重试走 download_control。',
      parameters: obj({
        activeOnly: { type: 'boolean', description: '只看进行中 / 等待中的下载' },
        limit: { type: 'number', description: '条数，默认 30，上限 100' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = need('downloadService', '下载服务')
        const rows = args.activeOnly === true
          ? await method(svc, 'listActive', '下载服务')()
          : await method(svc, 'list', '下载服务')(clampInt(args.limit, 30, 1, 100))
        const list = listOf(rows)
        const limit = clampInt(args.limit, 30, 1, 100)
        return {
          total: list.length,
          items: list.slice(0, limit).map((raw: unknown) => {
            const d = recordOf(raw)
            return {
              id: d.id,
              filename: d.filename || '',
              url: d.url || '',
              state: d.state || '',
              receivedBytes: d.receivedBytes || 0,
              totalBytes: d.totalBytes || 0,
              filePath: d.filePath || '',
              danger: d.danger || null,
              startedAt: d.startedAt || null,
              completedAt: d.completedAt || null
            }
          })
        }
      }
    },
    {
      name: 'download_control',
      description: '控制下载任务。action：pause / resume / cancel / retry（真正操作下载项，走下载控制器）；remove（按 id 删记录）、clear-completed（清已完成记录）、clear-all（清全部记录）。删除记录不删文件。',
      parameters: obj({
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'cancel', 'retry', 'remove', 'clear-completed', 'clear-all'],
          description: '要执行的动作'
        },
        id: { type: 'string', description: '下载 id（pause/resume/cancel/retry/remove 必填）' }
      }, ['action']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const action = String(args.action || '').trim()
        const id = String(args.id || '').trim()

        if (['pause', 'resume', 'cancel', 'retry'].includes(action)) {
          if (!id) throw new Error('这个动作需要 id')
          const getController = services().getDownloadController
          const controller = typeof getController === 'function' ? getController() : null
          if (!controller || typeof controller[action] !== 'function') {
            throw new Error(`下载控制器不支持 ${action}（可能该任务已结束）`)
          }
          const ok = !!controller[action](id)
          return { ok, action, id }
        }

        const svc = need('downloadService', '下载服务')
        if (action === 'remove') {
          if (!id) throw new Error('remove 需要 id')
          const ok = await method(svc, 'remove', '下载服务')(id)
          return { ok: !!ok, action, id }
        }
        if (action === 'clear-completed') {
          const removed = await method(svc, 'clearCompleted', '下载服务')()
          return { ok: true, action, removed }
        }
        if (action === 'clear-all') {
          const removed = await method(svc, 'clearAll', '下载服务')()
          return { ok: true, action, removed }
        }
        throw new Error(`不认识的下载动作：${action}`)
      }
    },

    // ── 扩展：列表 + 启停 / 卸载 / 重载 / 固定 ────────────────────────────
    {
      name: 'extensions_list',
      description: '列出已安装的浏览器扩展（含启用状态、是否已解压、是否有加载错误）。',
      parameters: obj({ limit: { type: 'number', description: '条数，默认 50，上限 200' } }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = need('extensionService', '扩展服务')
        const rows = await method(svc, 'listExtensions', '扩展服务')()
        const list = Array.isArray(rows) ? rows : []
        const limit = clampInt(args.limit, 50, 1, 200)
        return {
          total: list.length,
          items: list.slice(0, limit).map((e) => ({
            id: e.id,
            name: e.name || '',
            version: e.version || '',
            enabled: e.enabled !== false,
            pinned: !!e.pinned,
            unpacked: !!e.isUnpacked,
            description: clip(e.description, 120),
            loadError: e.loadError ? clip(e.loadError, 160) : ''
          }))
        }
      }
    },
    {
      name: 'extension_control',
      description: '控制一个扩展。action：enable / disable / toggle / uninstall / reload / pin / unpin。id 取 extensions_list 的结果。',
      parameters: obj({
        id: { type: 'string' },
        action: {
          type: 'string',
          enum: ['enable', 'disable', 'toggle', 'uninstall', 'reload', 'pin', 'unpin']
        }
      }, ['id', 'action']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('extensionService', '扩展服务')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const action = String(args.action || '').trim()

        if (action === 'enable' || action === 'disable' || action === 'toggle') {
          const enabled = action === 'enable' ? true : action === 'disable' ? false : undefined
          const res = await method(svc, 'toggle', '扩展服务')(id, enabled)
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        if (action === 'uninstall') {
          const res = await method(svc, 'uninstall', '扩展服务')(id)
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        if (action === 'reload') {
          const res = await method(svc, 'reload', '扩展服务')(id)
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        if (action === 'pin' || action === 'unpin') {
          const res = await method(svc, 'setPinned', '扩展服务')(id, action === 'pin')
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        throw new Error(`不认识的扩展动作：${action}`)
      }
    },

    // ── 站点权限 ─────────────────────────────────────────────────────────
    {
      name: 'permissions_list',
      description: '查看站点权限规则。带 origin：看该站点；带 type：看某权限类型被哪些站点设置过；都不带：列出全部站点规则。includeDefaults=true 时附带各类型的全局默认值。',
      parameters: obj({
        origin: { type: 'string', description: '站点（域名或 origin），如 example.com' },
        type: { type: 'string', description: '权限类型，如 notifications / geolocation / camera' },
        includeDefaults: { type: 'boolean', description: '是否附带全局默认规则' },
        limit: { type: 'number', description: '条数，默认 60，上限 200' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = need('permissionService', '权限服务')
        const limit = clampInt(args.limit, 60, 1, 200)
        const origin = String(args.origin || '').trim()
        const type = String(args.type || '').trim()
        const out: Record<string, unknown> = { ok: true }

        if (origin) {
          out.origin = origin
          out.rules = await method(svc, 'getSitePermissions', '权限服务')(origin, pid())
        } else if (type) {
          out.type = type
          const rows = await method(svc, 'listByType', '权限服务')(type, pid())
          out.total = Array.isArray(rows) ? rows.length : 0
          out.rules = (Array.isArray(rows) ? rows : []).slice(0, limit)
        } else {
          const rows = await method(svc, 'listAll', '权限服务')(pid())
          out.total = Array.isArray(rows) ? rows.length : 0
          out.rules = (Array.isArray(rows) ? rows : []).slice(0, limit)
          if (args.includeDefaults === true) {
            out.defaults = await method(svc, 'defaultsView', '权限服务')(pid())
          }
        }
        return out
      }
    },
    {
      name: 'permission_set',
      description: '给某个站点设置一项权限：allow / block / ask。改完立即生效。',
      parameters: obj({
        origin: { type: 'string', description: '站点（域名或 origin）' },
        type: { type: 'string', description: '权限类型，如 notifications / geolocation' },
        setting: { type: 'string', enum: ['allow', 'block', 'ask'] }
      }, ['origin', 'type', 'setting']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('permissionService', '权限服务')
        const origin = String(args.origin || '').trim()
        const type = String(args.type || '').trim()
        if (!origin || !type) throw new Error('origin 与 type 都不能为空')
        const setting = settingOf(args.setting)
        await method(svc, 'setPermission', '权限服务')(origin, type, setting, pid())
        return { ok: true, origin, type, setting }
      }
    },
    {
      name: 'permission_clear',
      description: '清除权限规则。三种方式任选其一：origin（清该站点全部规则）、type（清某类型的全部站点规则）、all（清空全部站点规则）。',
      parameters: obj({
        origin: { type: 'string' },
        type: { type: 'string' },
        all: { type: 'boolean' }
      }),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const svc = need('permissionService', '权限服务')
        const origin = String(args.origin || '').trim()
        const type = String(args.type || '').trim()
        const all = args.all === true
        const picked = [!!origin, !!type, all].filter(Boolean).length
        if (picked === 0) throw new Error('要给 origin / type / all 之一')
        if (picked > 1) throw new Error('一次只能选一种清除方式（origin / type / all）')

        if (origin) {
          const removed = await method(svc, 'clearSite', '权限服务')(origin, pid())
          return { ok: true, target: 'origin', origin, removed: removed === undefined ? null : removed }
        }
        if (type) {
          const removed = await method(svc, 'clearByType', '权限服务')(type, pid())
          return { ok: true, target: 'type', type, removed: removed === undefined ? null : removed }
        }
        const removed = await method(svc, 'clearAll', '权限服务')(pid())
        return { ok: true, target: 'all', removed: removed === undefined ? null : removed }
      }
    },
    {
      name: 'permission_default_set',
      description: '设置某权限类型的全局默认值（站点没有单独规则时用它）：allow / block / ask。',
      parameters: obj({
        type: { type: 'string', description: '权限类型' },
        setting: { type: 'string', enum: ['allow', 'block', 'ask'] }
      }, ['type', 'setting']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('permissionService', '权限服务')
        const type = String(args.type || '').trim()
        if (!type) throw new Error('type 不能为空')
        const setting = settingOf(args.setting)
        await method(svc, 'setDefault', '权限服务')(type, setting, pid())
        return { ok: true, type, setting }
      }
    },

    // ── 空间 ─────────────────────────────────────────────────────────────
    {
      name: 'spaces_list',
      description: '列出当前配置档案下的全部空间（工作区），含名称 / 图标 / 最后使用时间。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('spaceService', '空间服务')
        const rows = await method(svc, 'list', '空间服务')(pid())
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.map((s) => ({
            id: s.id,
            name: s.name || '',
            icon: s.icon || '',
            order: s.order || 0,
            lastUsed: s.lastUsed || null,
            createdAt: s.createdAt || null
          }))
        }
      }
    },
    {
      name: 'space_manage',
      description: '管理空间：create（新建，name 必填）、update（改名 / 换图标 / 换颜色，给 id + patch）、remove（删除，给 id）。',
      parameters: obj({
        action: { type: 'string', enum: ['create', 'update', 'remove'] },
        id: { type: 'string', description: '空间 id（update / remove 必填）' },
        name: { type: 'string', description: '空间名称（create / update）' },
        patch: { type: 'object', description: 'update 时的其余字段（如 icon / bgStartColor / bgEndColor）' }
      }, ['action']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('spaceService', '空间服务')
        const action = String(args.action || '').trim()
        const id = String(args.id || '').trim()
        const name = String(args.name || '').trim()

        if (action === 'create') {
          if (!name) throw new Error('新建空间需要 name')
          const input: Record<string, unknown> = { name, ...(args.patch && typeof args.patch === 'object' ? args.patch : {}) }
          const created = await method(svc, 'create', '空间服务')(pid(), input)
          return { ok: true, action, space: created || null }
        }
        if (action === 'update') {
          if (!id) throw new Error('update 需要 id')
          const patch: Record<string, unknown> = { ...(args.patch && typeof args.patch === 'object' ? args.patch : {}) }
          if (name) patch.name = name
          if (!Object.keys(patch).length) throw new Error('update 需要至少一个要改的字段')
          const updated = await method(svc, 'update', '空间服务')(pid(), id, patch)
          return { ok: true, action, id, space: updated || null }
        }
        if (action === 'remove') {
          if (!id) throw new Error('remove 需要 id')
          const ok = await method(svc, 'remove', '空间服务')(pid(), id)
          return { ok: !!ok, action, id }
        }
        throw new Error(`不认识的空间动作：${action}`)
      }
    },

    // ── 密码（只给元数据，绝不给明文）─────────────────────────────────────
    {
      name: 'passwords_status',
      description: '查看密码库状态：可用后端、当前后端、免存站点。注意：这里永远拿不到明文密码。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('passwordService', '密码服务')
        const backends = typeof svc.listBackends === 'function' ? svc.listBackends() : []
        const active = typeof svc.getActiveBackend === 'function' ? svc.getActiveBackend() : null
        const neverSave = typeof svc.getNeverSaveDomains === 'function'
          ? await svc.getNeverSaveDomains(pid())
          : []
        return {
          backends: (Array.isArray(backends) ? backends : []).map((b) => ({
            name: b.name || b.id || '',
            label: b.label || b.name || '',
            readOnly: !!b.readOnly,
            available: b.available !== false
          })),
          active: active ? (active.name || active.id || String(active)) : null,
          neverSaveDomains: Array.isArray(neverSave) ? neverSave.slice(0, 100) : []
        }
      }
    },
    {
      name: 'passwords_list',
      description: '列出已保存凭据的**元数据**（站点 / 用户名 / 最近使用），用于回答「我有没有存过这个站的账号」。不含密码。',
      parameters: obj({
        limit: { type: 'number', description: '条数，默认 40，上限 100' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const svc = need('passwordService', '密码服务')
        const rows = await method(svc, 'listCredentials', '密码服务')(pid())
        const list = Array.isArray(rows) ? rows : []
        const limit = clampInt(args.limit, 40, 1, 100)
        return {
          total: list.length,
          items: list.slice(0, limit).map((c) => ({
            id: c.id,
            domain: c.domain || '',
            username: c.username || '',
            lastUsedAt: c.lastUsedAt || null,
            manager: c.manager || ''
          }))
        }
      }
    },

    // ── 已安装应用（PWA）─────────────────────────────────────────────────
    {
      name: 'apps_list',
      description: '列出已安装到浏览器的应用（PWA / 快捷方式），含名称 / 启动地址 / 来源。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('pwaService', '应用服务')
        const rows = await method(svc, 'list', '应用服务')()
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.map((a) => ({
            id: a.id,
            name: a.name || '',
            startUrl: a.startUrl || '',
            display: a.display || '',
            installKind: a.installKind || '',
            source: a.source || ''
          }))
        }
      }
    },
    {
      name: 'app_control',
      description: '控制已安装应用：open（在应用窗口打开）、uninstall（卸载；不会删除浏览器外的文件）。id 取 apps_list。',
      parameters: obj({
        id: { type: 'string' },
        action: { type: 'string', enum: ['open', 'uninstall'] }
      }, ['id', 'action']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const action = String(args.action || '').trim()

        if (action === 'open') {
          const runtime = need('pwaRuntime', '应用运行时')
          const res = await method(runtime, 'open', '应用运行时')(id, pid())
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        if (action === 'uninstall') {
          const uninstaller = need('pwaUninstaller', '应用卸载器')
          const res = await method(uninstaller, 'uninstall', '应用卸载器')(id, pid())
          return { ok: true, id, action, result: res === undefined ? null : res }
        }
        throw new Error(`不认识的应用动作：${action}`)
      }
    },

    // ── 命名会话（保存的标签集）─────────────────────────────────────────
    {
      name: 'named_sessions_list',
      description: '列出用户保存的命名会话（一组标签的快照），含名称 / 标签数 / 创建时间。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('namedSessions', '命名会话服务')
        const rows = await method(svc, 'list', '命名会话服务')()
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.map((s) => ({
            id: s.id,
            name: s.name || '',
            tabs: Array.isArray(s.tabs) ? s.tabs.length : 0,
            createdAt: s.createdAt || null
          }))
        }
      }
    },
    {
      name: 'named_session_manage',
      description: '管理命名会话：save（把当前窗口的标签存成新快照，name 必填）、restore（打开某快照里的标签）、remove（删除快照）。',
      parameters: obj({
        action: { type: 'string', enum: ['save', 'restore', 'remove'] },
        id: { type: 'string', description: 'restore / remove 必填' },
        name: { type: 'string', description: 'save 必填' }
      }, ['action']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('namedSessions', '命名会话服务')
        const action = String(args.action || '').trim()
        const id = String(args.id || '').trim()

        if (action === 'save') {
          const name = String(args.name || '').trim()
          if (!name) throw new Error('save 需要 name')
          const res = recordOf(await method(svc, 'save', '命名会话服务')(name))
          return { ok: res.ok !== false, action, result: res }
        }
        if (action === 'restore') {
          if (!id) throw new Error('restore 需要 id')
          const res = recordOf(await method(svc, 'restore', '命名会话服务')(id))
          return { ok: res.ok !== false, action, id, result: res }
        }
        if (action === 'remove') {
          if (!id) throw new Error('remove 需要 id')
          const res = recordOf(await method(svc, 'remove', '命名会话服务')(id))
          return { ok: res.ok !== false, action, id, result: res }
        }
        throw new Error(`不认识的命名会话动作：${action}`)
      }
    },

    // ── 集锦（笔记）：新增 / 删除 ────────────────────────────────────────
    {
      name: 'collection_add',
      description: '往「集锦」里新增一条素材（标题 / 来源地址 / 正文 / 文件夹 / 标签）。',
      parameters: obj({
        title: { type: 'string' },
        url: { type: 'string' },
        content: { type: 'string' },
        folderId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      }, ['title']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('notesService', '集锦服务')
        const input: Record<string, unknown> = { title: String(args.title || '').trim() }
        if (!input.title) throw new Error('title 不能为空')
        if (args.url) input.url = String(args.url)
        if (args.content) input.content = String(args.content)
        if (args.folderId) input.folderId = String(args.folderId)
        if (Array.isArray(args.tags)) input.tags = args.tags.map((t) => String(t)).filter(Boolean)
        const note = recordOf(await method(svc, 'add', '集锦服务')(input))
        return { ok: true, id: note.id || null, title: input.title }
      }
    },
    {
      name: 'collection_remove',
      description: '删除一条集锦。id 取 collection_list。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const svc = need('notesService', '集锦服务')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const ok = await method(svc, 'remove', '集锦服务')(id)
        return { ok: ok !== false, id }
      }
    },

    // ── 书签：删除 ────────────────────────────────────────────────────────
    {
      name: 'bookmark_remove',
      description: '删除一个书签或书签文件夹（删文件夹会连同子项一起删除）。id 取 bookmark_list / bookmark_search。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const svc = need('bookmarkService', '书签服务')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const ok = await method(svc, 'remove', '书签服务')(id)
        return { ok: ok !== false, id }
      }
    },

    // ══════════════════════════════════════════════════════════════════
    // 内部页数据面（cookies / browsing-data / formfill / themes / shortcuts /
    // automation / games / profiles / crash-report / certificates /
    // task-manager / plugins）
    //
    // 这些页面的按钮以前只有 UI 能点 —— 现在把**同一个域服务实例**映射成工具，
    // 不另写业务规则：清哪些数据类型、cookie 怎么删、主题怎么发布，
    // 全部复用页面的唯一实现。
    // ══════════════════════════════════════════════════════════════════

    // ── Cookie 明细 ───────────────────────────────────────────────────────
    {
      name: 'cookies_list',
      description: '列出当前 profile 的 Cookie（可按 domain 或 url 过滤）。value 只回脱敏预览（前 2 字符），足够判断"这个站点登录了吗"，绝不回完整凭据。',
      parameters: obj({
        domain: { type: 'string', description: '按域名过滤，如 example.com' },
        url: { type: 'string', description: '按 URL 过滤（与 domain 二选一，url 优先）' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const jar = need('cookies', 'Cookie 端口')
        const filter: Record<string, unknown> = {}
        if (args.url) filter.url = String(args.url)
        else if (args.domain) filter.domain = String(args.domain)
        const list = await method(jar, 'list', 'Cookie 端口')(filter)
        const rows = listOf(list)
        return {
          total: rows.length,
          items: rows.slice(0, 80).map((raw: unknown) => {
            const c = recordOf(raw)
            return {
              name: c.name,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              session: c.session,
              expires: c.expirationDate,
            // 只回脱敏预览：Cookie 值本身就是会话令牌，全量进提示词等于把凭据
            // 交给模型（页面注入即可经 web_search / web_fetch 外带）。
              value: c.value ? `${String(c.value).slice(0, 2)}…` : '',
              valueLength: c.value ? String(c.value).length : 0
            }
          }),
          ...(rows.length > 80 ? { hint: '只显示前 80 条，用 domain / url 收窄范围' } : {})
        }
      }
    },
    {
      name: 'cookie_remove',
      description: '删除（注销）某条 Cookie。需要 url + name，name 取 cookies_list。',
      parameters: obj({
        url: { type: 'string', description: '这条 cookie 所属的 URL（含协议）' },
        name: { type: 'string' }
      }, ['url', 'name']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const jar = need('cookies', 'Cookie 端口')
        const url = String(args.url || '').trim()
        const name = String(args.name || '').trim()
        if (!url || !name) throw new Error('cookie_remove 需要 url 与 name')
        const res = recordOf(await method(jar, 'remove', 'Cookie 端口')(url, name))
        return { ok: res.ok !== false, url, name }
      }
    },
    {
      name: 'cookies_clear',
      description: '清空当前 profile 的**全部** Cookie（所有站点都会退出登录）。不可撤销，执行前必须征得用户确认。',
      parameters: obj({}),
      risk: 'write',
      approval: 'always',
      async execute() {
        const jar = need('cookies', 'Cookie 端口')
        const res = recordOf(await method(jar, 'clear', 'Cookie 端口')())
        return { ok: res.ok !== false, cleared: 'cookies' }
      }
    },

    // ── 浏览数据清除 ──────────────────────────────────────────────────────
    {
      name: 'browsing_data_clear',
      description: '按类型清除浏览数据（与「浏览数据」页的「立即清除」同一套规则）。types 可选：cookies / localStorage / indexedDB / serviceWorkers / cacheStorage / siteData / history / downloads / cache。可选 since（时间之后）与 origin（只清某个站点）。',
      parameters: obj({
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage', 'siteData', 'history', 'downloads', 'cache']
          },
          description: '要清除的数据类型（至少一项）'
        },
        since: { type: 'number', description: '只清这个时间之后的数据（毫秒时间戳）' },
        origin: { type: 'string', description: '只清这个站点，如 https://example.com' }
      }, ['types']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const clear = services().clearBrowsingData
        if (typeof clear !== 'function') throw new Error('浏览数据清除不可用（域服务未装配）')
        const types = Array.isArray(args.types) ? args.types.map((t) => String(t)) : []
        if (types.length === 0) throw new Error('types 至少要有一项')
        const req: Record<string, unknown> = { types }
        if (Number.isFinite(Number(args.since))) req.since = Number(args.since)
        if (args.origin) req.origin = String(args.origin)
        const res = recordOf(await clear(req))
        return {
          ok: res.ok !== false,
          results: res.results || {},
          ...(res.errors ? { errors: res.errors } : {})
        }
      }
    },

    // ── 数据导入（导入数据页）────────────────────────────────────────────
    {
      name: 'data_import',
      description: '导入数据（与「导入数据」页同一套解析）。kind=bookmarks 时 content 传 Netscape 书签 HTML；kind=passwords 时 content 传浏览器导出的密码 CSV（同「网站+用户名」会覆盖旧值）。',
      parameters: obj({
        kind: { type: 'string', enum: ['bookmarks', 'passwords'] },
        content: { type: 'string', description: '文件原文' }
      }, ['kind', 'content']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const kind = args.kind === 'passwords' ? 'passwords' : 'bookmarks'
        const content = String(args.content == null ? '' : args.content)
        if (!content.trim()) throw new Error('content 不能为空')
        if (kind === 'bookmarks') {
          const svc = need('bookmarkService', '书签服务')
          const res = recordOf(await method(svc, 'importHtml', '书签服务')(content))
          return {
            ok: !res.error,
            kind,
            imported: res.imported || 0,
            skipped: res.skipped || 0,
            ...(res.error ? { error: res.error } : {})
          }
        }
        const svc = need('passwordService', '密码服务')
        const res = recordOf(await method(svc, 'importCredentials', '密码服务')(content, { profileId: pid() }))
        return {
          ok: !res.error,
          kind,
          imported: res.imported || 0,
          merged: res.merged || 0,
          skipped: res.skipped || 0,
          total: res.total || 0,
          ...(res.error ? { error: res.error } : {})
        }
      }
    },

    // ── 表单填充（只给掩码，绝不给明文）──────────────────────────────────
    {
      name: 'formfill_list',
      description: '列出自动填充条目（地址 / 银行卡）的**掩码摘要**。不会返回任何明文；需要新增请用 formfill_add。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const vault = need('formFillVault', '表单填充保管库')
        const res = recordOf(await method(vault, 'list', '表单填充保管库')())
        const items = listOf(res.items)
        return {
          total: items.length,
          items: items.map((raw: unknown) => {
            const it = recordOf(raw)
            return { id: it.id, kind: it.kind, label: it.label, detail: it.detail, updatedAt: it.updatedAt || null }
          })
        }
      }
    },
    {
      name: 'formfill_add',
      description: '新增一条自动填充记录（会加密落盘）。kind=address 时 data 可含 name / company / street / city / state / zip / country / email / phone；kind=card 时 data 可含 holder / number / expiry / cvc。',
      parameters: obj({
        kind: { type: 'string', enum: ['address', 'card'] },
        label: { type: 'string', description: '给这条记录起的名字' },
        data: { type: 'object', properties: {}, additionalProperties: true, description: '字段值对象' }
      }, ['kind', 'data']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const vault = need('formFillVault', '表单填充保管库')
        const kind = args.kind === 'card' ? 'card' : 'address'
        const data = args.data && typeof args.data === 'object' ? args.data : null
        if (!data) throw new Error('formfill_add 需要 data 对象')
        const res = recordOf(await method(vault, 'add', '表单填充保管库')({
          kind,
          label: args.label ? String(args.label) : '',
          data
        }))
        if (res.ok === false) throw new Error(String(res.reason || '保存失败'))
        return { ok: true, id: res.id, kind }
      }
    },
    {
      name: 'formfill_remove',
      description: '删除一条自动填充记录。id 取 formfill_list。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const vault = need('formFillVault', '表单填充保管库')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const res = recordOf(await method(vault, 'remove', '表单填充保管库')(id))
        return { ok: res.ok !== false, id }
      }
    },

    // ── 主题 ──────────────────────────────────────────────────────────────
    {
      name: 'themes_list',
      description: '列出全部主题（内置 / 用户自建 / 插件贡献），标出当前启用的那个。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('themeService', '主题服务')
        const list = method(svc, 'list', '主题服务')()
        const rows = listOf(list)
        const activeId = typeof svc.getActiveId === 'function' ? svc.getActiveId() : null
        return {
          total: rows.length,
          activeId,
          items: rows.map((raw: unknown) => {
            const t = recordOf(raw)
            return { id: t.id, name: t.name || t.id, mode: t.mode || '', source: t.source || '', active: t.id === activeId }
          })
        }
      }
    },
    {
      name: 'theme_apply',
      description: '切换当前主题（会立刻发布到所有窗口，并把主题调度切回「不自动切换」）。id 取 themes_list。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const svc = need('themeService', '主题服务')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const res = recordOf(await method(svc, 'setActive', '主题服务')(id, { reason: 'user' }))
        if (res.ok === false) throw new Error(String(res.reason || '切换失败'))
        // 与主题页同一个收尾：setActive 只落盘 + 发事件，真正把配色推到窗口是 publish
        const runtime = recordOf(services().themeRuntime)
        if (runtime && typeof runtime.publish === 'function') await runtime.publish()
        return { ok: true, id, changed: res.changed !== false }
      }
    },

    // ── 快捷键 ────────────────────────────────────────────────────────────
    {
      name: 'shortcuts_list',
      description: '列出全部快捷键的当前键位与出厂默认值（action → 组合键）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const kb = need('keybindings', '快捷键服务')
        const current = recordOf(method(kb, 'getKeybindings', '快捷键服务')())
        const defaults = recordOf(method(kb, 'getDefaults', '快捷键服务')())
        return {
          items: Object.keys(defaults).map((action) => ({
            action,
            combo: current[action] || '',
            default: defaults[action] || '',
            customized: current[action] !== defaults[action]
          }))
        }
      }
    },
    {
      name: 'shortcut_set',
      description: '改一个快捷键。combo 形如 Ctrl+Shift+Y（必须带修饰键，单 F1-F12 除外），冲突会被拒绝。',
      parameters: obj({
        action: { type: 'string', description: '动作名，取 shortcuts_list' },
        combo: { type: 'string' }
      }, ['action', 'combo']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const kb = need('keybindings', '快捷键服务')
        const action = String(args.action || '').trim()
        const combo = String(args.combo || '').trim()
        if (!action || !combo) throw new Error('shortcut_set 需要 action 与 combo')
        const normalized = method(kb, 'setKeybinding', '快捷键服务')(action, combo)
        return { ok: true, action, combo: normalized }
      }
    },
    {
      name: 'shortcut_reset',
      description: '把快捷键恢复默认：给 action 只重置一个，all=true 重置全部。',
      parameters: obj({
        action: { type: 'string' },
        all: { type: 'boolean' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const kb = need('keybindings', '快捷键服务')
        if (args.all) {
          method(kb, 'reset', '快捷键服务')()
          return { ok: true, all: true }
        }
        const action = String(args.action || '').trim()
        if (!action) throw new Error('shortcut_reset 需要 action，或传 all=true')
        const combo = method(kb, 'resetKeybinding', '快捷键服务')(action)
        return { ok: true, action, combo }
      }
    },

    // ── 自动化（命令链 + 手势）────────────────────────────────────────────
    {
      name: 'automation_get',
      description: '读取自动化配置：命令链、手势映射、手势开关，以及可用的动作 id 与手势方向。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const auto = need('automation', '自动化控制器')
        const cfg = recordOf(method(auto, 'getConfig', '自动化控制器')())
        return {
          chains: Array.isArray(cfg.chains) ? cfg.chains : [],
          gestures: cfg.gestures || {},
          gesturesEnabled: cfg.gesturesEnabled !== false,
          actions: Array.isArray(cfg.actions) ? cfg.actions : [],
          directions: Array.isArray(cfg.directions) ? cfg.directions : []
        }
      }
    },
    {
      name: 'automation_save',
      description: '保存自动化配置：chains（完整命令链数组，会整体覆盖）、gestures（方向序列 → 动作 id）、gesturesEnabled。只写传入的字段。',
      parameters: obj({
        chains: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } },
        gestures: { type: 'object', properties: {}, additionalProperties: true },
        gesturesEnabled: { type: 'boolean' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const auto = need('automation', '自动化控制器')
        const payload: Record<string, unknown> = {}
        if (Array.isArray(args.chains)) payload.chains = args.chains
        if (args.gestures && typeof args.gestures === 'object') payload.gestures = args.gestures
        if (typeof args.gesturesEnabled === 'boolean') payload.gesturesEnabled = args.gesturesEnabled
        if (Object.keys(payload).length === 0) throw new Error('没有要保存的字段')
        const res = recordOf(await method(auto, 'save', '自动化控制器')(payload))
        return { ok: res.ok !== false, saved: Object.keys(payload) }
      }
    },
    {
      name: 'automation_run',
      description: '执行一条自动化：chainId（跑整条命令链）或 action（跑单个动作 id）。',
      parameters: obj({
        chainId: { type: 'string' },
        action: { type: 'string' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const auto = need('automation', '自动化控制器')
        const payload: Record<string, unknown> = {}
        if (args.chainId) payload.chainId = String(args.chainId)
        else if (args.action) payload.action = String(args.action)
        else throw new Error('automation_run 需要 chainId 或 action')
        const res = recordOf(await method(auto, 'run', '自动化控制器')(payload))
        return { ok: !!res.ok, ran: res.ran || 0 }
      }
    },

    // ── 游戏 ──────────────────────────────────────────────────────────────
    {
      name: 'games_list',
      description: '列出内置小游戏（外部 bundle 目录），含 id / 名称 / 分类 / 入口地址。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const catalog = need('externalGamesCatalog', '游戏目录')
        const rows = await method(catalog, 'list', '游戏目录')()
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.map((raw: unknown) => {
            const g = recordOf(raw)
            return {
              id: g.id,
              name: g.name,
              category: g.category || '',
              description: g.description || '',
              url: g.url,
              variants: Array.isArray(g.variants) ? g.variants.map((entry: unknown) => { const v = recordOf(entry); return { name: v.name, url: v.url } }) : []
            }
          })
        }
      }
    },
    {
      name: 'game_open',
      description: '在新标签页打开一个游戏。给 id（取 games_list）或直接的 hira-game:// 地址。',
      parameters: obj({
        id: { type: 'string' },
        url: { type: 'string', description: 'hira-game://<id>/<entry>' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        let url = String(args.url || '').trim()
        if (!url) {
          const id = String(args.id || '').trim()
          if (!id) throw new Error('game_open 需要 id 或 url')
          const catalog = need('externalGamesCatalog', '游戏目录')
          const rows = await method(catalog, 'list', '游戏目录')()
          const hit = (Array.isArray(rows) ? rows : []).find((g) => g.id === id.toLowerCase())
          if (!hit) throw new Error(`没有这个游戏：${id}`)
          url = hit.url
        }
        if (!/^hira-game:\/\//i.test(url)) throw new Error('game_open 只接受 hira-game:// 地址')
        await tabs().newTab({ url })
        return { ok: true, url }
      }
    },

    // ── 配置档案 ──────────────────────────────────────────────────────────
    {
      name: 'profiles_list',
      description: '列出全部配置档案（profile），含 id / 名称 / 是否临时档案。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const svc = need('profileService', '配置档案服务')
        const rows = method(svc, 'list', '配置档案服务')()
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          current: pid(),
          items: list.map((p) => ({
            id: p.id,
            name: p.name || p.id,
            ephemeral: !!p.ephemeral,
            icon: p.icon || ''
          }))
        }
      }
    },
    {
      name: 'profile_switch',
      description: '切换到另一个配置档案（会重建会话与全部界面数据，属于重操作）。id 取 profiles_list。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const switchTo = services().switchProfile
        if (typeof switchTo !== 'function') throw new Error('配置档案切换不可用（域服务未装配）')
        const res = await switchTo(id)
        return { ok: !!(res && res.ok !== false), id }
      }
    },

    // ── 崩溃报告 / 证书 ───────────────────────────────────────────────────
    {
      name: 'crash_reports_list',
      description: '列出本机保存的崩溃报告（日期 / 类型 / id）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const read = services().getCrashReports
        if (typeof read !== 'function') throw new Error('崩溃报告不可用')
        const rows = read()
        const list = Array.isArray(rows) ? rows : []
        return { total: list.length, items: list.slice(0, 100) }
      }
    },
    {
      name: 'certificates_list',
      description: '列出本次运行中遇到的证书错误（站点 / 错误码 / 时间）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const read = services().getCertificateErrors
        if (typeof read !== 'function') throw new Error('证书错误列表不可用')
        const rows = read()
        const list = Array.isArray(rows) ? rows : []
        return { total: list.length, items: list.slice(0, 100) }
      }
    },

    // ── 任务管理器 ────────────────────────────────────────────────────────
    {
      name: 'tasks_list',
      description: '列出浏览器进程与标签的资源占用（CPU / 内存），按内存降序。用于回答"谁在吃内存"。',
      parameters: obj({ limit: { type: 'number' } }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const read = services().getAppMetrics
        if (typeof read !== 'function') throw new Error('进程指标不可用')
        const rows = read()
        const list = (Array.isArray(rows) ? rows : []).slice()
        const limit = clampInt(args.limit, 30, 1, 100)
        return {
          total: list.length,
          items: list.slice(0, limit).map((m) => ({
            pid: m.pid,
            type: m.type,
            name: m.name || '',
            cpuPercent: m.cpuPercent || 0,
            memoryMB: Math.round((Number(m.memoryKB) || 0) / 1024),
            owner: m.owner || null
          }))
        }
      }
    },

    // ── 插件中心 ──────────────────────────────────────────────────────────
    {
      name: 'plugins_list',
      description: '列出全部插件及其启用状态、依赖关系（谁依赖我 / 我依赖谁）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const hostPort = need('pluginHost', '插件中心')
        const rows = method(hostPort, 'list', '插件中心')()
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.map((raw: unknown) => {
            const p = recordOf(raw)
            return {
              id: p.id,
              name: p.name || p.id,
              version: p.version || '',
              type: p.type || '',
              enabled: !!p.enabled,
              userDisabled: !!p.userDisabled,
              failed: !!p.failed,
              dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [],
              requiredBy: Array.isArray(p.requiredBy) ? p.requiredBy : []
            }
          })
        }
      }
    },
    {
      name: 'plugin_toggle',
      description: '启用 / 禁用一个插件。cascade=true 时同时处理依赖链（与插件中心开关同一条路径）。',
      parameters: obj({
        id: { type: 'string' },
        enabled: { type: 'boolean' },
        cascade: { type: 'boolean' }
      }, ['id', 'enabled']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const hostPort = need('pluginHost', '插件中心')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const res = recordOf(await method(hostPort, 'setEnabled', '插件中心')(id, !!args.enabled, args.cascade !== false))
        if (res.ok === false) throw new Error(String(res.reason || '插件启停失败'))
        return { ok: true, id, enabled: !!args.enabled, result: res }
      }
    }
  ]
  return tools
}

module.exports = { createDomainTools }
