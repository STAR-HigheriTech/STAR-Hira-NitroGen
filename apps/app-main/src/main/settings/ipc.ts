import type { BrowserWindow, Session } from 'electron'
import { spellcheckLanguageOptions } from '@hira-ng/shared-types/src/spellcheck.mjs'
import {
  normalizeSettingsGroup,
  settingsGroupHref,
  settingsGroupIcon,
  settingsGroupLabel
} from '@hira-ng/shared-types/src/settings-groups.mjs'

interface IpcEventPort {
  sender: {
    id: number
    getOwnerBrowserWindow?(): BrowserWindow | null
  }
}

interface TypedMainPort {
  handle<TRequest = unknown, TResponse = unknown>(route: string, definition: {
    requestSchema: unknown
    responseSchema: unknown
    handler: (event: IpcEventPort, request: TRequest) => TResponse | Promise<TResponse>
  }): unknown
}

interface SettingsServicePort {
  get(key: string): unknown
  set(key: string, value: unknown, originId?: number): unknown
  setForSpace?(spaceId: string, key: string, value: unknown, profileId?: string): unknown
  list(section?: string): unknown
  reset(key?: string, originId?: number): unknown
  changedKeys?(): unknown
  cssVars?(): unknown
}

interface SettingsRegistryPort { getSchema(): unknown }
interface SlotRegistryPort { multi(name: string, context?: unknown): unknown[] }

interface SettingsIpcContext {
  routes: Record<string, string>
  schemas: Record<string, { request: unknown; response: unknown }>
  settingsService: SettingsServicePort
  settingsRegistry?: SettingsRegistryPort | null
  providerRegistry?: unknown
  slots?: SlotRegistryPort | null
  getSession?(): Session | null | undefined
}

interface SettingsEntryDescriptor {
  label: string
  desc?: string
  action?: string
  href?: string
  route?: string
  payload?: unknown
}

interface PluginSectionDescriptor extends SettingsEntryDescriptor {
  id: string
  group: unknown
  groupLabel: string
  groupIcon: string
  groupHref: string
  icon: string
  blurb: string
  entry: SettingsEntryDescriptor | SettingsEntryDescriptor[] | null
  fields: Array<Record<string, unknown>>
}
/**
 * settings/ipc.js — 设置域 IPC 路由（自包含，不在 ipc-routes.js 里散布）
 *
 * 输入 ctx：typedMain（infra-ipc 的带校验 IPC 注册器）、z（zod）、routes（IPC_ROUTES）、
 *           settingsService（domain-settings）、settingsRegistry（分区 schema）。
 *
 * 关键：`set/reset` 把发起方 webContentsId 透传给 domain —— 让 settings/sync 的
 * 广播跳过发起窗口（去回声），避免发起方（设置页）收到自己触发的重渲染。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, settingsService:any, settingsRegistry?:any, providerRegistry?:any, slots?:any }} ctx
 */
export function registerSettingsIpc(typedMain: TypedMainPort, ctx: SettingsIpcContext): void {
  const { routes, schemas, settingsService, settingsRegistry, providerRegistry, slots } = ctx
  if (!typedMain || !settingsService) return
  const { createProviderInvoker } = require('../ipc/provider-bridge') as {
    createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown, context: unknown) => T | Promise<T>
  }
  const invoke = createProviderInvoker(providerRegistry)

  /**
   * 当前 profile 的会话（拼写检查的词典/可用语言都挂在会话上）。
   * 端口缺席时返回 null —— 下面每条路由都按"拿不到就当空"处理，不让设置页白屏。
   */
  const getSession = typeof ctx.getSession === 'function' ? ctx.getSession : null
  function currentSession(): Session | null {
    if (!getSession) return null
    try { return getSession() || null } catch (_) { return null }
  }

  /**
   * 入口归一化：`entry` 可以是单个对象，也可以是数组（一个分区挂多个内部页入口）。
   *
   * 三条通道与设置页渲染器（`pages/settings/settings.js#buildEntryRow`）逐字对应：
   *   · `href`   → 跳到某个内部页；
   *   · `window` → 开某个子窗口；
   *   · `route`  → 调一次 IPC（不是页面、也不是窗口的**窗口级动作**，如打开侧栏面板），
   *                `payload` 原样透传给那次调用。
   * **必须**有其中一条 —— 否则画出来是一个点了没反应的死按钮。
   *
   * `route` 的透传修的是这里原来的一个真空档：渲染器早就支持它，主进程却把它剪掉了，
   * 于是插件贡献的入口只能用 href/window。剪枝放在入口处（而不是让每个插件自己绕开）
   * 才是「一份契约、一处归一」。
   */
  function normalizeEntry(raw: unknown): SettingsEntryDescriptor | SettingsEntryDescriptor[] | null {
    const list = (Array.isArray(raw) ? raw : [raw])
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((e) => {
        const out: SettingsEntryDescriptor = { label: String(e.label || '') }
        if (e.desc) out.desc = String(e.desc)
        if (e.action) out.action = String(e.action)
        if (typeof e.href === 'string' && e.href) out.href = e.href
        if (typeof e.route === 'string' && e.route) {
          out.route = e.route
          if (e.payload && typeof e.payload === 'object') out.payload = e.payload
        }
        return out
      })
      .filter((e) => e.label && (e.href || e.route))
    if (!list.length) return null
    return Array.isArray(raw) ? list : list[0]
  }

  /**
   * 插件贡献的设置分区（扩展点 `settings.section-renderer`，MULTI）。
   *
   * 契约：实现返回**与内建分区同形**的描述符
   *   `{ id, label, icon?, blurb?, entry?, fields: [...] }`
   * —— 于是设置页（一个纯通用渲染器）零改动就能画出插件的分区与控件。
   *
   * 为什么校验得这么细：设置页对 schema 是**信任**的（它按 type 直接造 DOM）。
   * 一个字段缺 `key` 会让 values 表里出现 undefined 键；`fields` 不是数组会当场
   * 把整页渲染打断。所以入口处一律剪成"能画"的最小合法形态，宁可少画也不画坏。
   *
   * 每次请求现算（不缓存）：插件被禁用后它的分区必须立刻消失，缓存就得配失效链路。
   */
  function collectPluginSections(): PluginSectionDescriptor[] {
    if (!slots || typeof slots.multi !== 'function') return []
    const out: PluginSectionDescriptor[] = []
    for (const raw of slots.multi('settings.section-renderer', {}).flat(1)) {
      if (!raw || typeof raw !== 'object') continue
      const section = raw as Record<string, unknown>
      const id = String(section.id || '').trim()
      const fields = Array.isArray(section.fields)
        ? section.fields.filter((field): field is Record<string, unknown> => !!field && typeof field === 'object' && !!field.key)
        : []
      const entry = normalizeEntry(section.entry)
      // 只认"有 id 且至少有字段或入口"的分区：两者皆空在侧栏里是一条点了白屏的项。
      if (!id || (!fields.length && !entry)) continue
      // 分区归组同样只认共享表：插件写中文标题或写错 id 一律归一为「未分组」并在
      // 开发期喊一声 —— 静默接受会让设置页多出一个谁也不知道从哪冒出来的组。
      const group = normalizeSettingsGroup(section.group)
      if (section.group && !group) {
        console.warn(
          `[settings] 插件分区 ${id} 声明了未知的大类 group=${JSON.stringify(section.group)}，` +
            '已归入「其他」；合法值见 packages/shared-types/src/settings-groups.mjs'
        )
      }
      out.push({
        id,
        label: String(section.label || id),
        group,
        groupLabel: group ? settingsGroupLabel(group) : '',
        groupIcon: group ? settingsGroupIcon(group) : '',
        groupHref: group ? settingsGroupHref(group) : '',
        icon: section.icon ? String(section.icon) : 'puzzle',
        blurb: section.blurb ? String(section.blurb) : '',
        entry,
        fields: fields.map((f) => Object.assign({}, f))
      })
    }
    return out
  }

  typedMain.handle(routes.settingsGet, {
    requestSchema: schemas.get.request,
    responseSchema: schemas.get.response,
    handler: async (e, req: { key: string }) => ({ value: await invoke('settings.get', () => settingsService.get(req.key), req, { senderId: e?.sender?.id || 0 }) })
  })

  typedMain.handle(routes.settingsSet, {
    requestSchema: schemas.set.request,
    responseSchema: schemas.set.response,
    handler: async (e, req: { key: string; value: unknown }) => {
      const originId = e && e.sender ? e.sender.id : 0
      return { ok: await invoke('settings.set', () => settingsService.set(req.key, req.value, originId), req, { senderId: originId }) }
    }
  })

  // 「按空间」写设置（B2 / J13）：写**具名空间**（不依赖"当前空间"）。
  // 空间编辑器给别的空间配主题走这条；非按空间键 → ok:false（判据在 domain，不在 IPC）。
  if (typeof settingsService.setForSpace === 'function' && routes.settingsSetForSpace) {
    typedMain.handle(routes.settingsSetForSpace, {
      requestSchema: schemas.setForSpace.request,
      responseSchema: schemas.setForSpace.response,
      handler: async (e, req: { profileId?: string; spaceId: string; key: string; value: unknown }) => ({
        ok: await invoke('settings.set-for-space', () => settingsService.setForSpace?.(req.spaceId, req.key, req.value, req.profileId), req, { senderId: e?.sender?.id || 0 })
      })
    })
  }

  typedMain.handle(routes.settingsList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (e, req?: { section?: string }) => invoke('settings.list', () => settingsService.list(req?.section), req, { senderId: e?.sender?.id || 0 })
  })

  typedMain.handle(routes.settingsReset, {
    requestSchema: schemas.reset.request,
    responseSchema: schemas.reset.response,
    handler: async (e, req?: { key?: string }) => {
      const originId = e && e.sender ? e.sender.id : 0
      return { ok: await invoke('settings.reset', () => settingsService.reset(req?.key, originId), req, { senderId: originId }) }
    }
  })

  // 设置分区 schema（插件化）：设置页只认 schema，不硬编码任何 key。
  // 内建分区（settingsRegistry）在前、插件贡献的分区在后 —— 插件是"扩展"，
  // 不该把官方的常规/搜索/隐私挤到下面去。
  // ⚠ 插件分区的合并放在 `invoke` **外面**：`settings.schema` 这个能力由核心插件
  // （settings-service.cjs）提供时，provider 分支会直接返回内建 schema 而**不执行**
  // fallback —— 合并写在 fallback 里就等于永不生效。所以这里只让 `invoke` 负责
  // "拿到内建 schema"（provider 出错仍有兜底），合并本身由本层无条件完成。
  typedMain.handle(routes.settingsSchema, {
    requestSchema: schemas.schema.request,
    responseSchema: schemas.schema.response,
    handler: async (e, req) => {
      const base = await invoke('settings.schema', () => (settingsRegistry ? settingsRegistry.getSchema() : []), req, { senderId: e?.sender?.id || 0 })
      const builtin = Array.isArray(base) ? base : []
      const seen = new Set(builtin.map((section) => section && section.id))
      const plugin = collectPluginSections().filter((s) => !seen.has(s.id))
      return plugin.length ? builtin.concat(plugin) : builtin
    }
  })

  // 设置面板增强（additive）：方法未暴露时跳过注册，与 `if (tabManager.stats)` 同风格。
  if (settingsService.changedKeys) typedMain.handle(routes.settingsChangedKeys, {
    requestSchema: schemas.changedKeys.request,
    responseSchema: schemas.changedKeys.response,
    handler: async (e, req) => invoke('settings.changedKeys', () => settingsService.changedKeys?.(), req, { senderId: e?.sender?.id || 0 })
  })

  if (settingsService.cssVars) typedMain.handle(routes.settingsCssVars, {
    requestSchema: schemas.cssVars.request,
    responseSchema: schemas.cssVars.response,
    handler: async (e, req) => invoke('settings.cssVars', () => settingsService.cssVars?.(), req, { senderId: e?.sender?.id || 0 })
  })

  // 选择目录：directory 字段（如默认下载目录）点击打开原生目录选择器，返回选中路径。
  // 仅返回路径、由渲染进程写回对应设置键 —— 本模块不关心是哪一项目录。
  if (routes.settingsChooseDirectory) typedMain.handle(routes.settingsChooseDirectory, {
    requestSchema: schemas.chooseDirectory.request,
    responseSchema: schemas.chooseDirectory.response,
    handler: async (e) => {
      const win = e?.sender?.getOwnerBrowserWindow ? e.sender.getOwnerBrowserWindow() : null
      const dialog = require('electron').dialog
      let path = null
      try {
        const r = await dialog.showOpenDialog(win, {
          title: '选择目录',
          properties: ['openDirectory', 'createDirectory']
        })
        if (!r.canceled && r.filePaths && r.filePaths[0]) path = r.filePaths[0]
      } catch (_) {}
      return { path }
    }
  })

  // 「record」型设置的随机生成：页面只传生成器 id，具体逻辑在 record-generators。
  // 返回 null = 未知生成器（页面据此提示），其余原样回传。
  if (routes.settingsRecordGenerate) typedMain.handle(routes.settingsRecordGenerate, {
    requestSchema: schemas.recordGenerate.request,
    responseSchema: schemas.recordGenerate.response,
    handler: async (e, req: { generator: string }) => invoke('settings.record-generate', () => {
      const { generateRecord } = require('./record-generators.js')
      return generateRecord(req.generator)
    }, req, { senderId: e?.sender?.id || 0 })
  })

  // ── 拼写检查（设置页「语言」分区）───────────────────────────────────
  // 可用词典清单：Electron 自带，随构建/平台变化 → 由主进程现取，不写死进 schema。
  if (routes.spellcheckLanguages) typedMain.handle(routes.spellcheckLanguages, {
    requestSchema: schemas.spellcheckLanguages.request,
    responseSchema: schemas.spellcheckLanguages.response,
    handler: async (e, req) => invoke('spellcheck.languages', () => {
      const session = currentSession()
      let available: readonly string[] = []
      try {
        if (session && Array.isArray(session.availableSpellCheckerLanguages)) {
          available = session.availableSpellCheckerLanguages
        }
      } catch (_) { available = [] }
      return spellcheckLanguageOptions(available)
    }, req, { senderId: e?.sender?.id || 0 })
  })

  // 自定义词典：右键「添加到词典」加进来的词（存在 Chromium 会话里，只有会话能枚举）。
  // ⚠ `listWordsInSpellCheckerDictionary()` 是 **Promise<string[]>**（要等磁盘上的词典
  // 加载完），必须 await —— 当数组用会得到 `words.map is not a function`。
  // 返回值再做一次运行时收敛：不同 Electron 版本/异常分支可能给 null 或非数组。
  if (routes.spellcheckDictionary) typedMain.handle(routes.spellcheckDictionary, {
    requestSchema: schemas.spellcheckDictionary.request,
    responseSchema: schemas.spellcheckDictionary.response,
    handler: async (e, req) => invoke('spellcheck.dictionary', async () => {
      const session = currentSession()
      let words: readonly string[] = []
      try {
        if (session && typeof session.listWordsInSpellCheckerDictionary === 'function') {
          words = await session.listWordsInSpellCheckerDictionary()
        }
      } catch (_) { words = [] }
      const list = Array.isArray(words) ? words : []
      const seen = new Set<string>()
      return list
        .map((word) => String(word == null ? '' : word))
        .filter((word) => {
          if (!word || seen.has(word)) return false
          seen.add(word)
          return true
        })
        .sort((a, b) => a.localeCompare(b))
        .map((word) => ({ word }))
    }, req, { senderId: e?.sender?.id || 0 })
  })

  // 删一个词：只删当前 profile 会话里的那一条（其它 profile 是各自独立的词典）。
  if (routes.spellcheckDictionaryRemove) typedMain.handle(routes.spellcheckDictionaryRemove, {
    requestSchema: schemas.spellcheckDictionaryRemove.request,
    responseSchema: schemas.spellcheckDictionaryRemove.response,
    handler: async (e, req: { word: string }) => invoke('spellcheck.dictionary-remove', () => {
      const session = currentSession()
      if (!session || typeof session.removeWordFromSpellCheckerDictionary !== 'function') {
        return { ok: false }
      }
      try {
        session.removeWordFromSpellCheckerDictionary(req.word)
        return { ok: true }
      } catch (_) {
        return { ok: false }
      }
    }, req, { senderId: e?.sender?.id || 0 })
  })
}

