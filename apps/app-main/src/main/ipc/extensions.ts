/**
 * IPC · Extension 域（扩展系统 + Adblocker，C10）
 * —— 自 ipc-routes.js 原样搬入（Step 5，语义零改动）；
 *    增量：extension:list 返回项拼入 buildExtensionMeta 展示字段
 *    （本地化名称/描述 / 权限（中文）/V3/来源/版本）；响应项可带**按需**算出的 `size`。
 *
 * 本地化的读盘与目录大小的计算都不在本文件：本文件只做接线（域层纯规则 + infra 端口），
 * 这样 domain 保持零 IO、infra 独占读盘，两边都各自可测。
 */

import { BrowserWindow, dialog, type SaveDialogOptions, type WebContents } from 'electron'
import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface ExtensionServiceEvents {
  on(channel: string, listener: (payload: unknown) => void): unknown
  removeListener(channel: string, listener: (payload: unknown) => void): unknown
}
interface ExtensionServicePort {
  profileId?: string
  session?: { extensions?: { getAllExtensions?(): unknown[] } }
  events?: ExtensionServiceEvents
  getLocaleMessages?(id: string, locales: readonly string[]): Promise<unknown> | unknown
  listInstallRecords?(): unknown[]
  getExtensionSize?(id: string): Promise<unknown> | unknown
  getInspectViewSources?(id: string): unknown
  getBrowserActionStates?(tabId?: number): unknown[]
  getBrowserActionIconDataUrl?(id: string, tabId?: number): Promise<string> | string
  getExtensionIconDataUrl?(id: string): Promise<string> | string
  ensureLoaded(extensionId: string): Promise<unknown> | unknown
  listExtensions(): unknown
  getOptionsUrl(id: string): unknown
  openPopup(id: string, options: unknown): unknown
  installFromCrx(path: string): unknown
  installFromPath(path: string): unknown
  uninstall(id: string): unknown
  toggle(id: string, enabled: unknown): unknown
  setPinned(id: string, pinned: unknown): unknown
  getRuntimeStatus(id: string): unknown
  reload(id: string): unknown
  getDiagnostics(id: string): unknown
  getWarnings(id: string): unknown
  inspectView(id: string, target: unknown): unknown
  updateAllExtensions(): unknown
  setAdblockerEnabled(enabled: unknown): unknown
  isAdblockerEnabled(): unknown
  getAdblockerLevel(): unknown
  getBlockedCount(): unknown
}
interface ExtensionIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['extensions']
  extensionService: ExtensionServicePort | (() => ExtensionServicePort | null | undefined)
  providerRegistry?: ProviderRegistryPort | null
  openTab?: (url: string) => unknown
  layoutCoordinator?: MethodPort | null
  getActiveWebContents?: () => { id?: number } | null | undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

const { buildExtensionMeta, localeChainOf, formatBytes, buildInspectViews } = require('@hira-ng/domain-extension') as {
  buildExtensionMeta(ext: unknown, options: Record<string, unknown>): Record<string, unknown>
  localeChainOf(defaultLocale: unknown): string[]
  formatBytes(bytes: unknown): string | null | undefined
  buildInspectViews(id: string, sources: unknown): unknown[]
}
const { EXTENSION_CHANGE_TYPES } = require('@hira-ng/shared-types/src/extension-labels.mjs') as { EXTENSION_CHANGE_TYPES: readonly string[] }
// 扩展系统设置键名真源（开发者模式开关，与设置页 / 扩展页同源）。
const { EXTENSIONS_SETTING_KEYS } = require('@hira-ng/shared-types/src/extensions-settings.mjs') as {
  EXTENSIONS_SETTING_KEYS: { developerMode: string }
}
// 图标地址的拼法在 shared-types（与标签图标兜底共用一份，不在这里重抄端点名）。
const { extensionIconUrl } = require('@hira-ng/shared-types/src/extension-icon.mjs') as {
  extensionIconUrl(id: string, version: unknown, profileId?: unknown): string
}

// ── 开发者模式（extensions.developer_mode）──────────────────────────────
// 语义边界：本键只决定**诊断类内容的露出**（运行时诊断 + 「重新加载」按钮），
// 不决定任何能力 —— 「能不能加载未打包扩展」由 extensions.allow-unpacked 在
// 构造期接管（见 main.js 的 extensionOptionsPort），二者互不影响，故本键
// 永远不该碰 allow-unpacked 的既有语义。
//
// 为什么把「扩展 ID / 安装路径 / 清单版本 / 权限明细」从开发者视图**移出来**：
// 这四项正是详情视图（requirement：名称 / 版本 / 描述 / 图标 / 来源 / 权限 / ID / 路径）
// 的必要内容，也是用户判断「这个扩展到底能做什么」的依据 —— 把它们藏在开发者开关后面，
// 等于普通用户永远看不到扩展要哪些权限。真正只对开发者有意义的是**诊断信息**
// （清单是否合法、运行时是否提供路径）与**重新加载**这类破坏性调试动作。
const DEVELOPER_MODE_KEY = EXTENSIONS_SETTING_KEYS.developerMode
// settings-service 插件注册的能力名（apps/app-main/plugins/settings-service.cjs）。
const SETTINGS_GET_CAPABILITY = 'settings.get'

/**
 * 组装单个扩展的展示元数据（含**本地化**后的名称 / 描述）。
 *
 * 「域层纯规则 + infra 读盘」的组合：
 *   1. 语言回退链由 domain 的 localeChainOf 排（中文优先 → `default_locale`，见其注释）；
 *   2. 消息表由 infra 的 `getLocaleMessages` 端口按这份单子读回来（它按 id 缓存，
 *      同一扩展同一份候选语言只读一次盘）；
 *   3. 展开与回退仍在 domain 的 buildExtensionMeta 里做（纯函数）。
 * 端口缺失（例如单测里没有该服务方法）时 locales 为 null，buildExtensionMeta 自动
 * 退回清单原文 —— 与本次改造前的行为完全一致，绝不因为读不到消息而丢字段。
 * @param {any} service 扩展服务（infra）
 * @param {any} ext 运行时扩展对象，或「安装记录形状」的 `{ id, manifest }`
 * @param {string} id
 * @param {string} path
 * @param {string} [fallbackName]
 * @returns {Promise<any>}
 */
async function buildLocalizedMeta(service: ExtensionServicePort | null, ext: unknown, id: string, path: string, fallbackName?: unknown): Promise<Record<string, unknown>> {
  const extRecord = asRecord(ext)
  const manifest = asRecord(extRecord.manifest)
  const chain = localeChainOf(manifest.default_locale)
  let locales: unknown = null
  if (service && typeof service.getLocaleMessages === 'function') {
    try { locales = await service.getLocaleMessages(id, chain) } catch (_) { locales = null }
  }
  const meta = buildExtensionMeta(ext, { locales, localeCandidates: chain, fallbackName })
  // 安装路径：buildExtensionMeta 不产出这个字段，而列表项里已有 `path`。
  // 这里**总是**写成一个字符串（拿不到就是空串），而不是「有才写」—— `{...it, ...meta}`
  // 的合并里，值为 undefined 的键会把列表项原有的 path 覆盖掉（已停用的扩展靠安装
  // 记录里的 path 显示安装位置，覆盖成 undefined 就等于把它弄丢了）。
  meta.path = path || ''
  return meta
}

/**
 * 汇总所有已安装扩展的展示元数据（中文权限 / 本地化名称与描述 / 来源 / 商店地址 /
 * V3 / manifest 版本 / 安装路径），键为扩展 id。
 *
 * 两个数据源，缺一不可：
 *   1. ECE 运行时的扩展对象（`session.extensions.getAllExtensions()`）—— 正在运行的扩展；
 *   2. infra 的**安装记录**（`listInstallRecords()`）—— **已停用**的扩展不在运行时
 *      （停用 = 从运行时卸载），但管理页仍必须显示它的名称 / 版本 / 权限 / 来源，
 *      否则用户看到的就是「一停用就消失」。记录里带清单快照，元数据照样算得出来
 *      （`path` 也从记录里取：本地化读的就是那条路径下的 `_locales`）。
 * 取不到任何扩展对象 / 记录时返回空 Map（调用方安全降级为原列表）。
 */
export async function collectExtensionMeta(extensionService: ExtensionServicePort | null): Promise<Map<string, Record<string, unknown>>> {
  const metas = new Map()
  const all = extensionService && extensionService.session && extensionService.session.extensions &&
    typeof extensionService.session.extensions.getAllExtensions === 'function'
    ? extensionService.session.extensions.getAllExtensions()
    : []
  try {
    const allEntries = Array.isArray(all) ? all : []
    const runtimeEntries = await Promise.all(allEntries.map(async (ext) => {
      const row = asRecord(ext)
      const manifest = asRecord(row.manifest)
      const id = row.id || manifest.id
      if (!id) return null
      const path = typeof row.path === 'string' ? row.path : ''
      return [id, await buildLocalizedMeta(extensionService, ext, String(id), path)] as const
    }))
    for (const entry of runtimeEntries) if (entry) metas.set(String(entry[0]), entry[1])

    // 补上「不在运行时」的扩展（已停用的）：清单快照在安装记录里。
    const records = extensionService && typeof extensionService.listInstallRecords === 'function'
      ? extensionService.listInstallRecords()
      : []
    const recordEntries = await Promise.all((Array.isArray(records) ? records : []).map(async (value) => {
      const rec = asRecord(value)
      if (!rec.id || metas.has(String(rec.id)) || !rec.manifest) return null
      const meta = await buildLocalizedMeta(
        extensionService,
        { id: rec.id, manifest: rec.manifest },
        String(rec.id),
        typeof rec.path === 'string' ? rec.path : '',
        rec.name
      )
      return [String(rec.id), meta] as const
    }))
    for (const entry of recordEntries) if (entry) metas.set(String(entry[0]), entry[1])
  } catch (_) { /* 元数据增强失败时列表保持原样 */ }
  return metas
}

/**
 * 给指定 id 的列表项补上可读的「大小」（如 `1.2 MB`）。
 *
 * 为什么**不在**普通列表下发：目录大小是递归扫盘（infra 的 getExtensionSize），
 * 随每次刷新对每个扩展算一遍是纯粹的浪费。这里是**按需**入口：渲染层只在用户
 * 打开某个扩展的详情时，经既有的 `extension:list` 传 `includeSize: [id]` 问一次；
 * infra 侧算完即缓存，重复展开不再扫盘，扩展发生任何变更时缓存自动作废。
 *
 * 走既有通道而不是新开一条：`list.request` 本就是 `z.any().optional()`、响应项是
 * `z.any()`，加一个可选入参 / 一个可选出参**不动任何契约**，也就不会多一条要维护
 * 的通道。测不出大小的（目录不存在 / 无权限 / 已停用且原目录被删）不写 `size`
 * 字段 —— UI 少显示一行，而不是显示假的 `0 B`。
 * @param {any} service
 * @param {any[]} items
 * @param {unknown} requestedIds
 * @returns {Promise<any[]>}
 */
async function attachExtensionSizes(service: ExtensionServicePort | null, items: unknown[], requestedIds: unknown): Promise<unknown[]> {
  if (!Array.isArray(items)) return items
  const wanted = new Set((Array.isArray(requestedIds) ? requestedIds : []).filter((id) => typeof id === 'string' && id))
  if (!wanted.size || !service || typeof service.getExtensionSize !== 'function') return items
  const getExtensionSize = service.getExtensionSize
  try {
    return await Promise.all(items.map(async (item) => {
      const row = asRecord(item)
      if (!row.id || !wanted.has(String(row.id))) return item
      let bytes = null
      try { bytes = await getExtensionSize(String(row.id)) } catch (_) { bytes = null }
      const size = formatBytes(bytes)
      return size ? { ...row, size } : item
    }))
  } catch (_) {
    return items
  }
}

/**
 * 给列表项补上「检查视图」（**开发者视图专属**）。
 *
 * 数据链与本地化同构：infra 收集**实时上下文**（背景页 WebContents / MV3 service worker
 * 都是 Electron 运行时对象），domain 的 buildInspectViews 只做纯规则（归拢 / 命名 /
 * 标注可调试性）。主进程只接线，既不碰 Electron 运行时细节，也不自己拼文案。
 *
 * 为什么要按开发者视图收窄：RT 把这一栏放在 `isDeveloperMode` 块里（extension-details.tsx:72），
 * Chrome 的「检查视图」同样只在开发者模式显示 —— 它是排障入口，不是普通用户要看的信息。
 * 关闭时**从主进程侧不下发**该字段（与 diagnostics / warnings 同一口径），
 * 顺带也省掉「为每个扩展各枚举一次 WebContents」的开销。
 *
 * 拿不到上下文时**不写这个字段**：UI 据此整段不渲染 —— 宁可没有这一栏，
 * 也绝不给一个点了没反应的死链。
 * @param {any} service
 * @param {any[]} items
 * @param {boolean} devViewOff
 * @returns {any[]}
 */
function attachInspectViews(service: ExtensionServicePort | null, items: unknown[], devViewOff: boolean): unknown[] {
  if (devViewOff || !Array.isArray(items) || !items.length) return items
  if (!service || typeof service.getInspectViewSources !== 'function') return items
  const getSources = service.getInspectViewSources
  try {
    return items.map((item) => {
      const row = asRecord(item)
      if (!row.id) return item
      let sources: unknown = null
      try { sources = getSources(String(row.id)) } catch (_) { sources = null }
      const views = buildInspectViews(String(row.id), sources)
      return views.length ? { ...row, inspectViews: views } : item
    })
  } catch (_) {
    // 展示信息增强失败不该拖垮列表：原样返回（与 collectExtensionMeta 的降级一致）。
    return items
  }
}

/**
 * 给列表项补上**可渲染**的图标（`iconDataUrl` 优先，协议地址仅作兜底）。
 *
 * 为什么是 data URL（对齐参考实现 Hira main/extensions/extensionIcons.js）：
 * 管理页 / 侧栏在生产环境跑在 `file://` 上，自定义协议子资源并不可靠；主进程
 * 读盘后直接内联成 `data:<mime>;base64,…` 才是 `<img src>` 确定可用的形式，
 * 且与协议注册、会话、CSP 全部解耦。图标本身很小，内联代价可忽略。
 *
 * Electron 的 `Extension` 对象没有 iconPath 字段，infra 下发的 `iconPath` 只能是
 * 清单 `icons` 里的**相对路径**（`icons/128.png`）—— 它进 `<img src>` 会相对当前
 * 页面解析，必然 404。因此：
 *   - `iconDataUrl`：主进程内联的最终图标（有就能直接显示）；
 *   - `iconUrl`：`hira://extension-icon?id=…&v=…`，读盘失败时的协议兜底；
 *   - 两者都没有 → 不写字段，UI 退回首字母徽标（绝不发注定 404 的请求）。
 * @param {any} service
 * @param {any[]} items
 * @returns {Promise<any[]>}
 */
async function attachIconUrls(service: ExtensionServicePort | null, items: unknown[]): Promise<unknown[]> {
  if (!Array.isArray(items)) return items
  const canInline = service && typeof service.getExtensionIconDataUrl === 'function'
  const getIconDataUrl = service && canInline ? service.getExtensionIconDataUrl : null
  return Promise.all(items.map(async (item) => {
    const row = asRecord(item)
    if (!row.id || !row.iconPath) return item
    let iconDataUrl = ''
    if (getIconDataUrl) {
      try { iconDataUrl = await getIconDataUrl(String(row.id)) } catch (_) { iconDataUrl = '' }
    }
    return {
      ...row,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      iconUrl: extensionIconUrl(String(row.id), row.version, service?.profileId)
    }
  }))
}

/**
 * 把 ECE 的 browserAction 状态合并到列表项。
 *
 * manifest 只描述默认图标/标题；扩展运行后会通过 chrome.action.setBadgeText、
 * setTitle、setPopup 改当前标签的状态。工具栏如果不吃这份快照，就会出现
 * “扩展明明在显示角标，宿主图标却永远静止”的假接线。
 */
function attachBrowserActionStates(
  service: ExtensionServicePort | null,
  items: unknown[],
  tabId: number | undefined
): unknown[] {
  if (!service || typeof service.getBrowserActionStates !== 'function' || !Array.isArray(items)) return items
  let states: unknown[] = []
  try { states = service.getBrowserActionStates(tabId) || [] } catch (_) { return items }
  const byId = new Map<string, Record<string, unknown>>()
  for (const value of states) {
    const row = asRecord(value)
    if (typeof row.id === 'string' && row.id) byId.set(row.id, row)
  }
  if (!byId.size) return items
  return items.map((value) => {
    const row = asRecord(value)
    const state = typeof row.id === 'string' ? byId.get(row.id) : null
    if (!state) return value
    const title = typeof state.title === 'string' ? state.title.trim() : ''
    return {
      ...row,
      ...(title ? { actionTitle: title } : {}),
      badgeText: typeof state.badgeText === 'string' ? state.badgeText : '',
      badgeColor: typeof state.badgeColor === 'string' ? state.badgeColor : '',
      actionIconModified: Number(state.iconModified) || 0,
      ...(typeof state.popup === 'string' ? { hasPopup: Boolean(state.popup) } : {})
    }
  })
}

async function attachBrowserActionIcons(
  service: ExtensionServicePort | null,
  items: unknown[],
  tabId: number | undefined
): Promise<unknown[]> {
  if (!service || typeof service.getBrowserActionIconDataUrl !== 'function') return items
  const getIcon = service.getBrowserActionIconDataUrl
  return Promise.all(items.map(async (value) => {
    const row = asRecord(value)
    if (typeof row.id !== 'string' || !(Number(row.actionIconModified) > 0)) return value
    let iconDataUrl = ''
    try { iconDataUrl = await getIcon.call(service, row.id, tabId) } catch (_) { iconDataUrl = '' }
    return iconDataUrl ? { ...row, iconDataUrl } : value
  }))
}

interface SchemaPort { safeParse(value: unknown): { success: boolean; data?: unknown } }
interface ExtensionRelayOptions {
  emit?: (route: string, payload: unknown) => unknown
  eventChannel: string
  events?: Record<string, string>
  schema?: SchemaPort
  adblockerSchema?: SchemaPort
  listServices?: () => Array<ExtensionServicePort | null | undefined>
}
interface ExtensionRelayStop {
  (): void
  setService(service: ExtensionServicePort | null | undefined): void
  removeService(service: ExtensionServicePort | null | undefined): void
}

export function createExtensionEventRelay(
  extensionService: ExtensionServicePort | (() => ExtensionServicePort | null | undefined),
  { emit, eventChannel, events, schema, adblockerSchema, listServices }: ExtensionRelayOptions
): ExtensionRelayStop {
  // 订阅哪些生命周期事件：真源在 shared-types（契约的 type 枚举共用同一份）。
  const channels = EXTENSION_CHANGE_TYPES
  const bindings = new Map<ExtensionServicePort, {
    handlers: Map<string, (payload: unknown) => void>
    onAdblockerToggled: (payload: unknown) => void
  }>()

  const withProfile = (service: ExtensionServicePort, payload: unknown): Record<string, unknown> => {
    const row = asRecord(payload)
    return service.profileId && !row.profileId ? { ...row, profileId: service.profileId } : row
  }

  // 内容拦截状态变更单独转发：它的载荷是 `{ enabled }`，与扩展增删改的
  // `extension:changed` 形状不同，因此走自己的事件与校验 schema。
  // 必要性见 infra-extensions：blocker 的过滤列表是**后台异步**就绪的，
  // 渲染层「启动时读一次状态」必然读到未就绪的 false，图层会一直显示为关闭。
  const adblockerHandlerFor = (service: ExtensionServicePort) => (payload: unknown): void => {
    const enriched = withProfile(service, payload)
    const result = adblockerSchema?.safeParse ? adblockerSchema.safeParse(enriched) : { success: true, data: enriched }
    if (result.success && typeof emit === 'function' && events?.adblockerChanged) emit(events.adblockerChanged, result.data)
  }

  const bind = (service: ExtensionServicePort | null | undefined): void => {
    if (!service?.events || typeof service.events.on !== 'function' || bindings.has(service)) return
    const handlers = new Map<string, (payload: unknown) => void>()
    const onAdblockerToggled = adblockerHandlerFor(service)
    for (const channel of channels) {
      const handler = (payload: unknown): void => {
        const enriched = withProfile(service, payload)
        const result = schema?.safeParse ? schema.safeParse(enriched) : { success: true, data: enriched }
        if (result.success && typeof emit === 'function') emit(eventChannel, result.data)
      }
      handlers.set(channel, handler)
      service.events.on(channel, handler)
    }
    try { service.events.on('adblocker-toggled', onAdblockerToggled) } catch (_) {}
    bindings.set(service, { handlers, onAdblockerToggled })
  }

  const unbind = (service: ExtensionServicePort | null | undefined): void => {
    if (!service) return
    const binding = bindings.get(service)
    if (!binding) return
    if (service.events && typeof service.events.removeListener === 'function') {
      for (const [channel, handler] of binding.handlers) {
        try { service.events.removeListener(channel, handler) } catch (_) {}
      }
      try { service.events.removeListener('adblocker-toggled', binding.onAdblockerToggled) } catch (_) {}
    }
    bindings.delete(service)
  }

  const initialService = typeof extensionService === 'function' ? extensionService() : extensionService
  bind(initialService)
  if (typeof listServices === 'function') {
    let services: Array<ExtensionServicePort | null | undefined> = []
    try { services = listServices() || [] } catch (_) {}
    for (const service of services) bind(service)
  }

  const stop = (() => {
    for (const service of [...bindings.keys()]) unbind(service)
    bindings.clear()
  }) as ExtensionRelayStop
  // 新 profile 的 service 是增量加入，不摘掉其它仍在运行的 profile。
  stop.setService = bind
  stop.removeService = unbind
  return stop
}

/**
 * @param {string} [options.openTab] - 打开标签页端口（扩展选项页用新标签页承载）；
 *   由 app 层注入按发送方窗口解析的 tabManager，本注册器因此不依赖标签领域。
 * @param {object} [options.layoutCoordinator] - 按发送方窗口解析的布局协调器
 *   （scoped 代理）。只用来把渲染层上报的**视图内**锚点矩形换算成窗口内容区矩形 ——
 *   面板 / 浮层是独立 WebContentsView，两者差一个视图偏移（见 toWindowContentRect）。
 */
export function registerExtensionIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, extensionService, providerRegistry, openTab, layoutCoordinator, getActiveWebContents }: ExtensionIpcContext
): void {
  const getExtensionService = typeof extensionService === 'function'
    ? extensionService
    : () => extensionService
  const requireService = (): ExtensionServicePort => {
    const service = getExtensionService()
    if (!service) throw new Error('扩展服务尚未就绪')
    return service
  }

  const invoke = createProviderInvoker(providerRegistry)

  /**
   * 把渲染层上报的**视图内**锚点矩形换算成**窗口内容区**矩形。
   *
   * 为什么换算只放在这一跳：面板 / 浮层是独立的 WebContentsView，渲染层算出来的
   * `getBoundingClientRect()` 是视图内坐标，与弹窗定位所用的「父窗口内容区」差一个
   * 视图偏移（面板：rail / 顶栏等）。渲染层（含哑组件）对此一无所知，也不该知道 ——
   * 由主进程按**发送方 webContents** 反查它所属视图的落点，补上偏移即可。
   *
   * 整窗页面（例如扩展管理子窗口）的 wc 不属于任何 contentView 子视图 → 查不到偏移
   * → 原样透传（它的视图内坐标本就等于内容区坐标）。查不到 / 未布局 / 视图表有歧义
   * 时一律「不加偏移」：宁可让 extension-popup 退到默认锚点，也绝不抛错或错位。
   * @param {Electron.WebContents} sender
   * @param {{ x: number, y: number, width?: number, height?: number }|undefined} rect
   * @returns {typeof rect}
   */
  const toWindowContentRect = (sender: WebContents, rect: unknown): unknown => {
    const source = asRecord(rect)
    if (typeof source.x !== 'number' || typeof source.y !== 'number') return rect
    const offset = layoutCoordinator && typeof layoutCoordinator.getViewContentOffset === 'function'
      ? asRecord(layoutCoordinator.getViewContentOffset(sender))
      : null
    if (!offset) return rect
    return { ...source, x: source.x + Number(offset.x || 0), y: source.y + Number(offset.y || 0) }
  }

  /**
   * 读取 extensions.developer_mode 的**实时值**。
   *
   * 为什么经 provider 能力总线（settings.get）而不是直读 settings.json：
   *   - 拿到的就是 settingsService 的**内存值**（set 同步更新缓存），因此页面刚
   *     切换完立刻就能读到新值，不受落盘防抖（120ms）影响；
   *   - 不 require 设置服务，避免扩展域与设置域产生编译期耦合（插件化 / 解耦）。
   * 读不到时返回 undefined（安全降级，绝不抛错）。
   * @returns {Promise<true|false|undefined>}
   */
  const readDeveloperMode = async () => {
    try {
      const value = await invoke(SETTINGS_GET_CAPABILITY, () => undefined, { key: DEVELOPER_MODE_KEY })
      if (value === true) return true
      if (value === false) return false
      return undefined
    } catch (_) {
      return undefined
    }
  }

  /**
   * 开发者视图是否**明确关闭**。
   * 只有读到明确的 false 才收窄返回内容；true / undefined（设置服务不可读）时保持原样 ——
   * 这样「服务未就绪」是向后兼容的安全降级（不抛错、不误伤既有能力），而用户真正关掉
   * 开发者模式时，字段是从主进程侧**真正不返回**，而不是渲染层藏起来。
   */
  const isDeveloperViewOff = async () => (await readDeveloperMode()) === false

  typedMain.handle(routes.extensionList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => {
      const service = requireService()
      const items = await invoke('extensions.listExtensions', () => service.listExtensions(), null)
      const metas = await collectExtensionMeta(service)
      // 列表项补 buildExtensionMeta 展示字段（本地化名称/描述 / permissions（中文）/
      // source / storeUrl / isV3 / manifestVersion / path/...），渲染进程零 N+1 直接消费；
      // 取不到 meta 的项保持原样。这些字段**不再受开发者模式收窄** —— 名称、权限与
      // 来源是面向所有用户的展示信息。
      const enriched = !metas.size || !Array.isArray(items)
        ? items
        : items.map((value) => {
            const row = asRecord(value)
            return row.id && metas.has(String(row.id)) ? { ...row, ...metas.get(String(row.id)) } : value
          })
      // 「检查视图」是开发者视图专属，关闭时不下发（见 attachInspectViews）。
      const enrichedList = Array.isArray(enriched) ? enriched : []
      const withInspectViews = attachInspectViews(service, enrichedList, await isDeveloperViewOff())
      // 图标：主进程读盘内联为 data URL（读不到才退回协议地址），见 attachIconUrls。
      const withIcons = await attachIconUrls(service, withInspectViews)
      let activeTabId: number | undefined
      try {
        const active = typeof getActiveWebContents === 'function' ? getActiveWebContents() : null
        activeTabId = typeof active?.id === 'number' ? active.id : undefined
      } catch (_) {}
      const withActionState = attachBrowserActionStates(service, withIcons, activeTabId)
      const withActionIcons = await attachBrowserActionIcons(service, withActionState, activeTabId)
      // 目录大小：只在这一次调用明确点名要它时才算（见 attachExtensionSizes 的注释）。
      const includeSize = req && typeof req === 'object'
        ? (req as Record<string, unknown>).includeSize
        : false
      return attachExtensionSizes(service, withActionIcons, includeSize)
    }
  })

  typedMain.handle(routes.extensionInstall, {
    requestSchema: schemas.install.request,
    responseSchema: schemas.install.response,
    handler: async (_e, req) => {
      const isCrx = req.path.toLowerCase().endsWith('.crx')
      return isCrx
        ? invoke('extensions.installFromCrx', () => requireService().installFromCrx(req.path), req)
        : invoke('extensions.installFromPath', () => requireService().installFromPath(req.path), req)
    }
  })

  typedMain.handle(routes.extensionUninstall, {
    requestSchema: schemas.uninstall.request,
    responseSchema: schemas.uninstall.response,
    handler: async (_e, req) => ({ ok: await invoke('extensions.uninstall', () => requireService().uninstall(req.id), req) })
  })

  typedMain.handle(routes.extensionToggle, {
    requestSchema: schemas.toggle.request,
    responseSchema: schemas.toggle.response,
    handler: async (_e, req) => ({ ok: await invoke('extensions.toggle', () => requireService().toggle(req.id, req.enabled), req) })
  })

  // 「固定」：写安装记录的 pinned 位（随 profile 持久化），不碰运行时 ——
  // 与 toggle 是两条独立通道（见 contracts 的说明）。
  typedMain.handle(routes.extensionSetPinned, {
    requestSchema: schemas.setPinned.request,
    responseSchema: schemas.setPinned.response,
    handler: async (_e, req) => ({ ok: await invoke('extensions.setPinned', () => requireService().setPinned(req.id, req.pinned), req) })
  })

  typedMain.handle(routes.extensionImportFolder, {
    requestSchema: schemas.importFolder.request,
    responseSchema: schemas.importFolder.response,
    handler: async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      })
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true }
      }
      return invoke('extensions.installFromPath', () => requireService().installFromPath(result.filePaths[0]), { path: result.filePaths[0] })
    }
  })

  // 运行时状态是**粗粒度、面向普通用户**的展示（运行中 / 已停用 / 未加载），
  // 页面的状态徽标始终消费它 —— 因此不受开发者模式收窄（它不是诊断细节）。
  typedMain.handle(routes.extensionRuntimeStatus, {
    requestSchema: schemas.runtimeStatus.request,
    responseSchema: schemas.runtimeStatus.response,
    handler: async (_e, req) => invoke('extensions.runtimeStatus', () => requireService().getRuntimeStatus(req.id), req)
  })

  typedMain.handle(routes.extensionReload, {
    requestSchema: schemas.reload.request,
    responseSchema: schemas.reload.response,
    handler: async (_e, req) => ({ ok: await invoke('extensions.reload', () => requireService().reload(req.id), req) })
  })

  // 诊断细节：开发者视图专属。关闭时从主进程侧返回空数组（真的不下发）。
  typedMain.handle(routes.extensionDiagnostics, {
    requestSchema: schemas.diagnostics.request,
    responseSchema: schemas.diagnostics.response,
    handler: async (_e, req) => {
      if (await isDeveloperViewOff()) return []
      return invoke('extensions.diagnostics', () => requireService().getDiagnostics(req.id), req)
    }
  })

  // 权限明细（警告即权限）：同样只在开发者视图下下发。
  typedMain.handle(routes.extensionWarnings, {
    requestSchema: schemas.warnings.request,
    responseSchema: schemas.warnings.response,
    handler: async (_e, req) => {
      if (await isDeveloperViewOff()) return []
      return invoke('extensions.warnings', () => requireService().getWarnings(req.id), req)
    }
  })

  // ── 打开扩展自身的页面（对齐老 Hira openExtensionOptions / openExtensionPopup）──
  // 三条动作的分工：
  //   · options —— 扩展自己的设置/详情页，用**新标签页**承载（与老 Hira 一致，
  //     也与 Chrome「扩展详情 → 扩展选项」落到标签页的行为一致）；开标签这一步
  //     由 app 层注入的 openTab 端口完成（本注册器不持有标签领域，保持解耦）。
  //   · popup —— 工具栏图标点开的那个弹窗，交给 infra-extensions 走 ECE 的 popup
  //     管线（首选）或 NG 自己的扩展弹窗窗口（兜底），本层只做透传：
  //       1. anchorRect —— 渲染层从被点按钮现算的矩形（对齐 RT）。面板 / 浮层报的
  //          是**视图内**矩形，这里按发送方视图补上窗口内容区偏移后再下发
  //          （见 toWindowContentRect）；整窗页面的坐标本就同系，偏移查不到即原样透传。
  //       2. parentWindow —— **发送方窗口**，弹窗要挂在它上面、并让控制器的
  //          「失焦即关」在点到父窗口时生效。多窗口下必须按发送方解析，
  //          否则从窗口 B 点开的弹窗会挂到窗口 A 上。
  //   · store —— 扩展的商店详情页（homepage_url → 商店详情路由回落），同样走新标签页。
  // 「该扩展有没有设置页 / 弹窗」由列表项的 hasOptionsPage / hasPopup 表达（infra 侧从运行时
  // 清单派生并随 extension:list 下发），所以这里只需处理「真的点了」那一跳。
  typedMain.handle(routes.extensionOpenOptions, {
    requestSchema: schemas.openOptions.request,
    responseSchema: schemas.openOptions.response,
    handler: async (_e, req) => {
      const service = requireService()
      // 启动恢复是后台跑的（可能未完成 / 曾失败）：点按钮时补一次按需加载，
      // 否则 `chrome-extension://` 页面没有 session 里的扩展提供，打开就是加载失败。
      if (typeof service.ensureLoaded === 'function') await service.ensureLoaded(req.id)
      const url = await invoke('extensions.optionsUrl', () => service.getOptionsUrl(req.id), req)
      if (typeof url !== 'string' || !url || typeof openTab !== 'function') return { ok: false }
      try {
        await openTab(url)
        return { ok: true }
      } catch (error) {
        console.error('[ext] open options failed:', error instanceof Error ? error.message : String(error))
        return { ok: false }
      }
    }
  })

  typedMain.handle(routes.extensionOpenPopup, {
    requestSchema: schemas.openPopup.request,
    responseSchema: schemas.openPopup.response,
    handler: async (e, req) => {
      const service = requireService()
      const sender = e && typeof e === 'object' && 'sender' in e ? (e as { sender: WebContents }).sender : null
      const parentWindow = sender ? BrowserWindow.fromWebContents(sender) || undefined : undefined
      // 同 options：弹窗页面由扩展 session 提供，先确保扩展真的在运行时。
      if (typeof service.ensureLoaded === 'function') await service.ensureLoaded(req.id)
      // 换算放在**同步段**完成：注入的 layoutCoordinator 是按发送方窗口解析的代理
      // （AsyncLocalStorage 上下文），同步取用最稳妥，不必赌 await 之后上下文还在。
      const anchorRect = sender ? toWindowContentRect(sender, req.anchorRect) : req.anchorRect
      // 宿主依赖（换算后的矩形、发送方窗口）随 input 一起过 Provider 总线：
      // 能力表只做「参数 → 域方法」的映射，不反向依赖宿主。
      const input = { id: req.id, anchorRect, alignment: req.alignment, parentWindow }
      return {
        ok: Boolean(await invoke(
          'extensions.openPopup',
          () => service.openPopup(req.id, { anchorRect, alignment: req.alignment, parentWindow }),
          input
        ))
      }
    }
  })

  // 商店详情页：地址由**主进程**从扩展元数据里取（不信任渲染层传来的 URL），
  // 取不到（例如清单没有 homepage_url 且 id 为空）就如实 ok:false。
  typedMain.handle(routes.extensionOpenStore, {
    requestSchema: schemas.openStore.request,
    responseSchema: schemas.openStore.response,
    handler: async (_e, req) => {
      const metas = await collectExtensionMeta(requireService())
      const meta = metas.get(req.id)
      const url = meta && typeof meta.storeUrl === 'string' ? meta.storeUrl : ''
      if (!url || typeof openTab !== 'function') return { ok: false }
      try {
        await openTab(url)
        return { ok: true }
      } catch (error) {
        console.error('[ext] open store page failed:', error instanceof Error ? error.message : String(error))
        return { ok: false }
      }
    }
  })

  // ── 检查视图（对齐 Chrome / RT 扩展详情页的「检查视图」）──────────────────
  // 渲染层把列表项里 `inspectViews[].target` 原样回传，主进程据此打开对应后台上下文的
  // 开发者工具。不支持的 target / 上下文已经消失（后台页被销毁）一律如实 ok:false ——
  // UI 侧那一栏本来就只有 inspectable:true 的项可点，这个 false 是防御性的兜底。
  typedMain.handle(routes.extensionInspectView, {
    requestSchema: schemas.inspectView.request,
    responseSchema: schemas.inspectView.response,
    handler: async (_e, req) => ({
      ok: Boolean(await invoke(
        'extensions.inspectView',
        () => requireService().inspectView(req.id, req.target),
        req
      ))
    })
  })

  // 「更新」：立即检查并安装所有扩展的可用更新（对齐 RT 开发者模式工具条的「更新」）。
  typedMain.handle(routes.extensionUpdateAll, {
    requestSchema: schemas.updateAll.request,
    responseSchema: schemas.updateAll.response,
    handler: async () => ({
      ok: Boolean(await invoke('extensions.updateAll', () => requireService().updateAllExtensions(), null))
    })
  })

  // Adblocker
  typedMain.handle(routes.adblockerStatus, {
    requestSchema: schemas.adblockerStatus.request,
    responseSchema: schemas.adblockerStatus.response,
    handler: async () => {
      const svc = requireService()
      // 两问都走能力总线：`enabled` 是屏蔽「已装配」的粗粒度状态，
      // `level` 是当前意图级别（off / ads / ads+tracking），二者在列表下载期间会短暂不一致。
      return {
        enabled: Boolean(await invoke('extensions.adblockerStatus', () => svc.isAdblockerEnabled(), null)),
        level: await invoke('extensions.adblockerLevel', () => svc.getAdblockerLevel(), null)
      }
    }
  })

  typedMain.handle(routes.adblockerToggle, {
    requestSchema: schemas.adblockerToggle.request,
    responseSchema: schemas.adblockerToggle.response,
    handler: async (_e, req) => ({ ok: await invoke('extensions.adblockerToggle', () => requireService().setAdblockerEnabled(req.enabled), req) })
  })

  typedMain.handle(routes.adblockerBlockedCount, {
    requestSchema: schemas.adblockerBlockedCount.request,
    responseSchema: schemas.adblockerBlockedCount.response,
    handler: async () => invoke('extensions.adblockerBlockedCount', () => requireService().getBlockedCount(), null)
  })
}

