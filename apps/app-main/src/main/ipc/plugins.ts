/**
 * IPC · Plugins 域 —— Harness 插件中心（PART7 §7.9）。
 *
 * 只做四件事：读注册中心 → 归一化快照 → 启停一个插件 → 广播变更。
 * 业务规则全部留在 PluginRegistryV2（依赖校验、provider 摘除、生命周期），
 * 这一层不复制任何注册中心内部逻辑。
 *
 * 关键时序：插件是**后台启动**的（main.js 里 fire-and-forget），而本注册器在
 * registerCoreIpc 时就装好了 —— 也就是说首次 `plugins:list` 很可能早于
 * enableAppPlugins 完成。此时返回空清单而不是抛错：插件中心会自动收到
 * plugins:changed 广播后补齐，用户不会看到「加载失败」。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  PluginDescriptor,
  PluginLoadResult,
  PluginManifest,
  PluginToggleResult
} from '@hira-ng/infra-plugin'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface PluginRuntimeState {
  installed?: boolean
  enabled?: boolean
  failed?: boolean
  blocked?: boolean
  error?: string
}

interface PluginRegistryPort {
  describe(): PluginDescriptor[]
  getManifests(): PluginManifest[]
  dependentIds(id: string): string[]
  setGrantedPermissions(id: string, scopes: string[]): unknown
  enableWithPrerequisites(id: string): Promise<PluginToggleResult>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  reload(id: string): Promise<PluginLoadResult>
  uninstall(id: string): Promise<void>
  discover(): unknown
  getState(id: string): PluginRuntimeState | null
  isUserDisabled(id: string): boolean
  setUserDisabled(id: string, disabled: boolean): boolean
  setAutoDisabled(id: string, disabled: boolean): boolean
}

interface PluginSignature {
  status: string
  keyId?: string
  reason?: string
}

interface PluginInstallResult {
  ok: boolean
  id?: string
  name?: string
  version?: string
  signature?: PluginSignature
  warnings?: string[]
  reason?: string
  canceled?: boolean
  verified?: boolean
}

type UserScriptInstallResult = PluginInstallResult

interface UserScriptInstallerPort {
  install(source: { text?: string; path?: string; overwrite?: boolean }): Promise<UserScriptInstallResult> | UserScriptInstallResult
}

interface PluginInstallerPort {
  installArchive(target: string, options: { overwrite: boolean }): Promise<PluginInstallResult>
  installDirectory(target: string, options: { overwrite: boolean }): Promise<PluginInstallResult>
  uninstall(id: string): Promise<PluginInstallResult>
  listTrustedKeys(): unknown
  addTrustedKey(target: string, options: { level: unknown; overwrite: boolean }): unknown
  removeTrustedKey(keyId: unknown, level: unknown): unknown
}

interface PluginMarketPort {
  query(options: { force: boolean }): Promise<unknown> | unknown
  setSources(sources: unknown): Promise<unknown> | unknown
  install(id: string, options: { overwrite: boolean; force: boolean }): Promise<PluginInstallResult>
}

interface PluginStoragePort {
  get(pluginId: string, key: string): Promise<unknown> | unknown
  set(pluginId: string, key: string, value: unknown): Promise<unknown> | unknown
  remove(pluginId: string, key: string): Promise<unknown> | unknown
  keys(pluginId: string, prefix: unknown): Promise<unknown> | unknown
  clear(pluginId: string): Promise<unknown> | unknown
}

interface PluginOverlayHostPort { closeFromRenderer(key: unknown, windowId: number): unknown }
interface PluginSurfacesPort {
  listUserScriptsSummary(): unknown[]
  listPages?(): unknown[]
}
interface UserScriptRuntimePort { handleRequest(senderUrl: string, details: unknown): Promise<unknown> | unknown }

interface PluginFeatureMap {
  resolveFeatureAvailability(registry: PluginRegistryPort | null): unknown
}

interface PanelUiSpec { entry: string; kind: 'html' | 'xaml' }
type PluginDescriptorRecord = PluginDescriptor & {
  contributes: Record<string, unknown>
  installed: boolean
  enabled: boolean
  blocked: boolean
  blockedBy: string[]
  awaitingConsent: boolean
}
type PluginInfoWire = PluginDescriptorRecord & {
  uiEntry: PanelUiSpec | null
  renderUrl: string | null
  pages: PluginPageWire[]
}
interface PluginPageWire {
  id: string
  pluginId: string
  title: string
  entry: string
  dir: string
  host: string
  url: string
  order: number
}

interface PluginIpcApi {
  notifyChanged(payload?: unknown): void
  installFromPath(target: string, options?: InstallFromPathOptions): Promise<PluginInstallResult>
  uninstallPlugin(id: string): Promise<{ ok: boolean; id: string; reason?: string }>
  installUserscript(request?: InstallUserscriptRequest, event?: unknown): Promise<UserScriptInstallResult>
  setPluginEnabled(request: PluginToggleRequest): Promise<PluginToggleResponse>
}

interface DependentTarget { id: string; name: string }
interface PluginToggleResponse {
  ok: boolean
  id: string
  enabled: boolean
  reason?: string
  requiresCascade?: boolean
  dependents?: DependentTarget[]
  restored?: Array<{ id: string; name: string }>
}

interface InstallFromPathOptions { source?: 'directory' | 'archive'; overwrite?: boolean }
interface InstallUserscriptRequest { text?: string; path?: string; overwrite?: boolean }
interface PluginToggleRequest { id: string; enabled: boolean; cascade?: boolean }

interface PluginIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['plugins']
  events: Record<string, string>
  getPluginRegistry?: () => PluginRegistryPort | null | undefined
  emit?: (route: string, payload: unknown) => unknown
  onPanelsChanged?: () => unknown
  onPluginDisabled?: (id: string, disabled: boolean) => unknown
  onPluginPermissionsChanged?: (id: string, scopes: string[]) => unknown
  onPluginsActivated?: (ids: string[]) => unknown
  onPluginUninstalled?: (id: string) => unknown
  getUserPluginDir?: () => string
  pluginInstaller?: PluginInstallerPort | null
  pluginMarket?: PluginMarketPort | null
  pluginStorage?: PluginStoragePort | null
  pluginOverlayHost?: PluginOverlayHostPort | null
  getPluginSurfaces?: (() => PluginSurfacesPort | null | undefined) | null
  setUserScriptDisabled?: (id: string, disabled: boolean) => unknown
  userscriptRuntime?: UserScriptRuntimePort | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function ownerWindow(event: unknown): BrowserWindow | null {
  const getOwner = asRecord(asRecord(event).sender).getOwnerBrowserWindow
  return typeof getOwner === 'function' ? (getOwner as () => BrowserWindow | null).call(asRecord(event).sender) : null
}

// 渲染入口 URL 的**唯一**拼装处（协议层的出口）—— 见下方 withRenderUrl 的说明。
const { buildPluginAssetUrl } = require('../plugin-protocol') as { buildPluginAssetUrl(id: string, entry: string, version?: unknown): string }
// UI 面声明的解析规则（纯层，零 IO）—— 见 packages/shared-types/src/plugin-ui.mjs。
const { panelUiFromContribution } = require('@hira-ng/shared-types/src/plugin-ui.mjs') as {
  panelUiFromContribution(panel: unknown): PanelUiSpec | null | undefined
}

/**
 * 「同时禁用会带走谁」—— 找出 targetId 的全部硬下游里**当前仍启用**的那些。
 *
 * 用注册中心的 `dependentIds()`（传递闭包 + 逆拓扑序）而不是自己扫 `dependsOn`：
 * ① 传递性 —— 关 A 会连带 A 的下游的下游，只扫一层会漏；② 逆拓扑序 ——
 * 真正执行禁用时必须"先关下游再关上游"，这个顺序由闭包直接给出，不在这里重排。
 *
 * ⚠ **只看硬依赖，不看 `optionalDependsOn`。** 这不是疏漏：
 * 软依赖的语义就是"存在就用、不存在也照装"（PART7 §7.4），拿它挡禁用等于把
 * 软依赖偷偷升级成硬约束，插件作者写下的降级意图当场失效。
 */
function findEnabledDependents(registry: PluginRegistryPort | null, targetId: string, snapshot: PluginDescriptorRecord[]): DependentTarget[] {
  if (!registry) return []
  const byId = new Map(snapshot.map((plugin) => [String(plugin.id), plugin]))
  const enabled = new Set(snapshot.filter((plugin) => Boolean(plugin.enabled)).map((plugin) => String(plugin.id)))
  let ids: string[] = []
  try {
    ids = typeof registry.dependentIds === 'function' ? registry.dependentIds(targetId) : []
  } catch (_) {
    ids = []
  }
  // 已启用的下游才算"会被带走"。未启用的下游本来就没在跑，不该拦着用户关前置。
  return ids
    .filter((id) => enabled.has(id))
    .map((id) => ({ id, name: String(byId.get(id)?.name || id) }))
}

export function registerPluginsIpc (typedMain: IpcTypedMain, ctx: PluginIpcContext): PluginIpcApi {
  const { routes, schemas, events, getPluginRegistry, emit, onPanelsChanged, onPluginDisabled, onPluginPermissionsChanged, onPluginsActivated, onPluginUninstalled, getUserPluginDir, pluginInstaller, pluginMarket, pluginStorage, pluginOverlayHost, getPluginSurfaces, setUserScriptDisabled, userscriptRuntime } = ctx
  // 功能面 → 引擎插件 的映射表（APPS 层的产品决定，不在 infra）。见 feature-map.js。
  const featureMap = require('../feature-map.js') as PluginFeatureMap
  if (!typedMain || !routes || !routes.pluginsList) {
    const unavailable = async () => ({ ok: false, reason: '插件服务不可用' })
    return {
      notifyChanged: () => {},
      installFromPath: unavailable,
      uninstallPlugin: async (id) => ({ ok: false, id, reason: '插件服务不可用' }),
      installUserscript: unavailable,
      setPluginEnabled: async (request) => ({ ok: false, id: request.id, enabled: false, reason: '插件服务不可用' })
    }
  }
  type PluginListWire = ReturnType<typeof schemas.list.response.parse>['plugins'][number]

  /**
   * 用户脚本安装器 —— 在函数作用域内**只建一份**。
   *
   * 两条入口必须共用同一个实例：
   *   · 界面导入（`plugins:install-userscript` 路由）；
   *   · AI 工作室（`studio_create kind=userscript`）。
   * 各建一份的后果是"体检口径迟早只有一边被改"，用户脚本因此变成一条旁路。
   */
  let userScriptInstaller: UserScriptInstallerPort | null = null
  if (pluginInstaller) {
    const { createUserScriptInstaller } = require('../userscript-installer') as {
      createUserScriptInstaller(options: unknown): UserScriptInstallerPort
    }
    userScriptInstaller = createUserScriptInstaller({
      getUserPluginDir,
      pluginInstaller,
      log: (...args: unknown[]) => console.log(...args)
    })
  }

  /** 插件集合发生变化（启停成功 / 后台启动完成）→ 广播一次，让所有插件中心对账。 */
  const notifyChanged = (payload?: unknown): void => {
    if (typeof emit === 'function' && events && events.pluginsChanged) {
      emit(events.pluginsChanged, payload || {})
    }
  }

  /**
   * 给快照补上**渲染入口的可加载 URL**。
   *
   * 为什么在 IPC 层补、而不是让注册中心算（describe 里）：
   * URL 的形状（scheme 名、host 放插件 id、`?v=<mtime>`）是**协议层与消费方之间的契约**，
   * 而协议是 APPS 注册的（`hira-plugin://` 见 main/plugin-protocol.js）——
   * 把它塞进 infra 等于让 infra 认识 APPS 的协议。
   *
   * 为什么不让渲染层自己拼：那样 URL 形状就有了**两份实现**，改动时必然漂移；
   * 漂移的表现是"作者改了代码但页面还是旧的"或"插件 UI 整个加载不出来"，都极难查。
   * 这里算一次、随清单一起下发，渲染层只管 `import(item.renderUrl)`。
   */
  function withRenderUrl(plugin: PluginDescriptorRecord, pages: PluginPageWire[] = []): PluginInfoWire {
    const uiEntry = panelUiFromContribution(plugin.uiEntry) || null
    return {
      ...plugin,
      uiEntry,
      // Executable renderer code is first-party-only until community modules can run
      // in an opaque-origin renderer with a capability broker.
      render: plugin.isFirstParty ? plugin.render : null,
      renderUrl: plugin.isFirstParty && plugin.render
        ? buildPluginAssetUrl(plugin.id, plugin.render, plugin.renderVersion)
        : null,
      pages
    }
  }

  /** 插件贡献的内部页由表面层解析；协议、URL 与启停同步只认这一份结果。 */
  function snapshotPluginPages(): PluginPageWire[] {
    if (typeof getPluginSurfaces !== 'function') return []
    const surfaces = getPluginSurfaces()
    if (!surfaces || typeof surfaces.listPages !== 'function') return []
    try {
      return surfaces.listPages().map((value) => {
        const page = asRecord(value)
        return {
          id: String(page.id || ''),
          pluginId: String(page.pluginId || ''),
          title: String(page.title || page.id || ''),
          entry: String(page.entry || ''),
          dir: String(page.dir || ''),
          host: String(page.host || ''),
          url: String(page.url || ''),
          order: Number(page.order) || 0
        }
      }).filter((page) => page.id && page.pluginId && page.url)
    } catch (e) {
      console.warn('[plugins] 读取插件页面失败：', errorMessage(e))
      return []
    }
  }

  /**
   * 把 `contributes.panels[].ui` 解析成**可直接 fetch 的 URL 清单**（HTML / XAML 面板）。
   *
   * 三个关键点：
   *   · 只认 `ui` / `uiEntry` 且扩展名在白名单内（`panelUiFromContribution` 决定），
   *     非法声明直接跳过 —— 宁可不给这块面板，也不给一个必然白屏的入口；
   *   · `?v=<mtime>` 只能在这里算：`describe()` 不含 `originPath`，而
   *     `getManifests()` 是**唯一**带 originPath 的出口（插件目录的事实源）；
   *   · 算不出 mtime（文件缺失 / 注册中心未就绪）时 `version = null`，URL 仍给出 ——
   *     面板那边会明确报「入口文件不存在」，比静默不渲染更好查。
   *
   * @param {any} plugin    `describe()` 的一条
   * @param {any} manifest  `getManifests()` 里的同 id 条目（含 originPath）
   */
  function resolvePanelUi(plugin: PluginDescriptorRecord, manifest?: PluginManifest): Array<{
    panelId: string
    entry: string
    kind: 'html' | 'xaml'
    url: string
    title: string
    version: number | null
  }> {
    if (!plugin) return []
    const panelsValue = asRecord(plugin.contributes).panels
    const panels = Array.isArray(panelsValue)
      ? panelsValue
      : []
    if (!panels.length) return []
    const root = manifest?.originPath ? path.dirname(manifest.originPath) : null
    // 顶层声明（`html` / `view` / `entry` / `render` 指向 .html/.xaml）可被面板继承：
    // 作者常把唯一那块面板的入口写在 manifest 顶层，面板项里只留 id。
    const inheritedUi = manifest?.uiEntry ? panelUiFromContribution(manifest.uiEntry) : null
    const out: Array<{ panelId: string; entry: string; kind: 'html' | 'xaml'; url: string; title: string; version: number | null }> = []
    for (const panel of panels) {
      const ui = panelUiFromContribution(panel) || inheritedUi
      if (!ui) continue
      let version: number | null = null
      if (root) {
        try {
          version = fs.statSync(path.resolve(root, ui.entry)).mtimeMs
        } catch (_) {
          version = null
        }
      }
      out.push({
        panelId: String(asRecord(panel).id || ''),
        entry: ui.entry,
        kind: ui.kind,
        url: buildPluginAssetUrl(plugin.id, ui.entry, version),
        title: String(asRecord(panel).title || plugin.name || plugin.id || ''),
        version
      })
    }
    return out
  }

  /** id → manifest（含 `originPath`）。注册中心未就绪时给空表。 */
  function manifestIndex(): Map<string, PluginManifest> {
    const reg = registry()
    const map = new Map<string, PluginManifest>()
    if (!reg || typeof reg.getManifests !== 'function') return map
    try {
      for (const m of reg.getManifests()) {
        if (m && m.id) map.set(String(m.id).toLowerCase(), m)
      }
    } catch (_) {
      // 注册中心正在重载 —— 本次快照只是缺 panelUi，不阻断列表。
    }
    return map
  }

  /** 注册中心可能尚未就绪（见文件头时序说明）——统一在这里取，拿不到就返回 null。 */
  const registry = (): PluginRegistryPort | null => {
    try {
      return (typeof getPluginRegistry === 'function' ? getPluginRegistry() : null) ?? null
    } catch (_) {
      return null
    }
  }

  const snapshot = (): PluginDescriptorRecord[] => {
    const reg = registry()
    if (!reg || typeof reg.describe !== 'function') return []
    return reg.describe() as PluginDescriptorRecord[]
  }

  /**
   * 「某些插件刚刚（重新）跑起来了」→ 通知宿主。
   *
   * 目前唯一用途是执行它们贡献的 schema 迁移（`db.schema.migration`）：插件一上线
   * 就该有它自己的表，等到下次重启才建等于它的第一条查询必炸。
   *
   * 为什么做成端口而不是在这里直接跑迁移：**迁移要 sqlite 句柄，而那是 APPS 层的事实**
   * （infra 与 IPC 层都不该知道数据库长什么样）。这里只报"谁上线了"，怎么用是宿主的事。
   *
   * 失败绝不影响开关结果 —— 迁移出问题的是那个插件的表，不是"能不能启用"。
   */
  function notifyActivated(ids: string[]): void {
    if (typeof onPluginsActivated !== 'function') return
    try {
      onPluginsActivated(ids)
    } catch (e) {
      console.warn('[plugins] onPluginsActivated failed:', errorMessage(e))
    }
  }

  typedMain.handle(routes.pluginsList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => {
      const manifests = manifestIndex()
      const pagesByPlugin = new Map<string, PluginPageWire[]>()
      for (const page of snapshotPluginPages()) {
        const list = pagesByPlugin.get(page.pluginId) || []
        list.push(page)
        pagesByPlugin.set(page.pluginId, list)
      }
      return {
        plugins: snapshot().map((plugin): PluginListWire => ({
          ...withRenderUrl(plugin, pagesByPlugin.get(String(plugin.id || '')) || []),
          panelUi: resolvePanelUi(plugin, manifests.get(String(plugin.id || '').toLowerCase()))
        }))
      }
    }
  })


  /**
   * 功能面可用性（§10.4 的**唯一**查询端口）。
   *
   * 为什么"收口成一个端口"而不是让每个 UI 去解析 plugins:list：
   * 约二十个入口都想知道"书签引擎在不在"，各查各的必然漂移（有人看 enabled、
   * 有人看 failed、有人忘了 autoDisabled），而且插件每次启停要逐个通知、漏一个就是
   * "那个按钮永远不回来"。这里一次算清，UI 只做"渲染 / 不渲染"。
   *
   * 判定规则与逐条理由见 feature-map.js 文件头 —— 关键点是 **fail-open**：
   * 插件不存在、启用失败、启动中，都算"可用"（那时功能由域服务兜底、或马上就会好）。
   * 只有"被**显式关掉**"才让 UI 消失。
   */
  if (routes.featuresAvailability) {
    typedMain.handle(routes.featuresAvailability, {
      requestSchema: schemas.features && schemas.features.request,
      responseSchema: schemas.features && schemas.features.response,
      handler: async () => ({ available: featureMap.resolveFeatureAvailability(registry()) })
    })
  }

  /**
   * 授权第三方插件声明的权限（PART7 §7.5）—— 授权后立即尝试启用它。
   *
   * 两条安全边界：
   *   · **scopes 只能是插件自己声明过的那些**（取交集），不接受 UI 塞额外权限；
   *   · 第一方插件不走这里（它们不需要授权，也没有"待授权"态）。
   *
   * 为什么授权后顺手 enable：用户的意图就是"同意并让它开始工作"，
   * 让他再点一次开关纯属多余（§10.3 的 `enableWithPrerequisites` 已经负责拓扑序）。
   */
  if (routes.pluginsGrantPermissions) {
    typedMain.handle(routes.pluginsGrantPermissions, {
      requestSchema: schemas.grantPermissions && schemas.grantPermissions.request,
      responseSchema: schemas.grantPermissions && schemas.grantPermissions.response,
      handler: async (_e, req) => {
        const { id } = req
        const reg = registry()
        if (!reg) return { ok: false, id, enabled: false, reason: '插件注册中心尚未就绪，请稍后重试' }
        const target = reg.getManifests().find((m) => m.id === id)
        if (!target) return { ok: false, id, enabled: false, reason: `未找到插件：${id}` }

        const declared = new Set(target.requestedPermissions || [])
        const requested = Array.isArray(req.scopes) ? req.scopes : []
        const granted = requested.filter((s) => declared.has(s))
        if (requested.some((s) => !declared.has(s))) {
          // 有请求越界：**不报错但也绝不授权**，只记一条告警。
          // 报错会让正常路径因为渲染层的脏数据而失败；静默扩大权限则更糟。
          console.warn(`[plugins] ${id} 的授权请求包含未声明的 scope，已忽略越界项：`,
            requested.filter((s) => !declared.has(s)).join(', '))
        }

        try {
          if (typeof reg.setGrantedPermissions === 'function') reg.setGrantedPermissions(id, granted)
          if (typeof onPluginPermissionsChanged === 'function') onPluginPermissionsChanged(id, granted)
        } catch (e) {
          console.warn('[plugins] persist granted permissions failed:', errorMessage(e))
        }

        if (granted.length) {
          try { await reg.enableWithPrerequisites(id) } catch (e) {
            return { ok: false, id, enabled: false, reason: errorMessage(e) }
          }
        } else {
          // 撤销授权 → 立刻停用（否则它会带着刚被收回的权限继续跑）
          try { await reg.disable(id) } catch (e) {
            console.warn('[plugins] revoke 后停用失败:', errorMessage(e))
          }
        }

        const state = reg.getState(id) || { enabled: false }
        if (typeof onPanelsChanged === 'function') {
          try { onPanelsChanged() } catch (_) {}
        }
        // 授权后确实跑起来了 → 让宿主补跑它贡献的 schema 迁移（幂等，重复调用安全）。
        if (state.enabled) notifyActivated([id])
        notifyChanged({ id, enabled: !!state.enabled })
        return { ok: true, id, enabled: !!state.enabled }
      }
    })
  }

  /**
   * 热重载一个插件（重读 manifest + 重新编译模块代码，原本在跑的重启）。
   *
   * 分工：注册中心做全部脏活（停干净 → 丢缓存 → 重读 → 重新编译 → 重启），
   * 这一层只负责「把结果与失败原因按统一形状回给 UI」+ 收尾对账。
   *
   * 为什么失败也要走 `ok: false + reason` 而不是抛：IPC 抛错到渲染层只是一个
   * 看不出所以然的 rejected promise；作者需要看到"模块无法加载：xxx"才知道改哪儿。
   */
  if (routes.pluginsReload) {
    typedMain.handle(routes.pluginsReload, {
      requestSchema: schemas.reload.request,
      responseSchema: schemas.reload.response,
      handler: async (_e, req) => {
        const { id } = req
        const reg = registry()
        if (!reg) return { ok: false, id, enabled: false, reason: '插件注册中心尚未就绪，请稍后重试' }
        if (typeof reg.reload !== 'function') return { ok: false, id, enabled: false, reason: '当前版本不支持热重载' }
        let result
        try {
          result = await reg.reload(id)
        } catch (e) {
          return { ok: false, id, enabled: false, reason: errorMessage(e) }
        }
        // 重载会摘掉再挂回声明式贡献与插槽实现 → 面板目录可能变了，走与启停同一套对账。
        if (typeof onPanelsChanged === 'function') {
          try { onPanelsChanged() } catch (_) {}
        }
        notifyChanged({ id, reloaded: true })
        return { ok: true, id, enabled: !!(result && result.enabled) }
      }
    })
  }

  if (routes.pluginsOpenDir) {
    typedMain.handle(routes.pluginsOpenDir, {
      requestSchema: schemas.openDir.request,
      responseSchema: schemas.openDir.response,
      handler: async () => {
        const dir = typeof getUserPluginDir === 'function' ? getUserPluginDir() : ''
        if (!dir) return { ok: false, path: null }
        try {
          // 先建目录：未装过任何第三方插件时它不存在，而 Windows 上打开一个
          // 不存在的路径是**静默失败**（没有报错、也没有窗口）—— 用户会以为按钮坏了。
          require('fs').mkdirSync(dir, { recursive: true })
        } catch (_) { /* 建不出来也让 openPath 试一次，它自己会给出结果 */ }
        try {
          await require('electron').shell.openPath(dir)
          return { ok: true, path: dir }
        } catch (e) {
          console.warn('[plugins] 打开用户插件目录失败：', errorMessage(e))
          return { ok: false, path: dir }
        }
      }
    })
  }

  /**
   * 让用户挑一个「安装来源」。**选择框在主进程弹**，渲染层不碰任何本地路径 API。
   * @returns {Promise<string|null>} 选中的路径；取消 → null（不是失败）
   */
  async function pickInstallSource(event: unknown, source: 'userscript' | 'archive' | 'directory'): Promise<string | null> {
    const dialog = require('electron').dialog
    const win = ownerWindow(event)
    let options
    if (source === 'userscript') {
      options = {
        title: '选择用户脚本',
        properties: ['openFile'],
        // 有些站点导出的扩展名是 `.js`（社区脚本常见），两条都放行 ——
        // 是不是用户脚本由元数据头判定，不由扩展名判定。
        filters: [{ name: '用户脚本', extensions: ['user.js', 'js'] }]
      }
    } else if (source === 'archive') {
      options = {
        title: '选择插件压缩包',
        properties: ['openFile'],
        filters: [{ name: '插件压缩包', extensions: ['zip'] }]
      }
    } else {
      options = { title: '选择插件文件夹', properties: ['openDirectory'] }
    }
    try {
      const r = await dialog.showOpenDialog(win, options)
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return null
      return r.filePaths[0]
    } catch (e) {
      console.warn('[plugins] 选择安装来源失败：', errorMessage(e))
      return null
    }
  }

  /**
   * 安装成功后的**统一收尾**（"从文件安装"与"从市场安装"共用这一份）。
   *
   * 为什么要抽出来：这里五步（重新发现 → 启用 → 面板对账 → 广播 → 补跑迁移）
   * 只要少一步就会出现一类"装完了但界面不对"的现象，而两条安装路径各写一份时
   * 必然有一天只改了一条。**收尾只有一处**，加一步就两条路一起加。
   *
   * 顺序也是刻意的：
   *   · `discover()` 必须在 `enable()` 之前（注册中心只扫目录，不认识"安装"）；
   *   · 面板对账在广播之前（先收拾干净再让渲染层重建，反了会有一帧"按钮没了面板还开着"）；
   *   · 迁移在广播之后（它可能建表改数据，属于"启用已成功"的后续，不该挡着 UI 更新）。
   *
   * @param {string} id
   */
  async function afterInstallHook(id: string): Promise<void> {
    const reg = registry()
    /**
     * **先取证、再动手** —— 这三个观测必须在任何状态变更之前取。
     *
     * 尤其是 `wasEnabled`：它决定了"更新一个正在跑的插件"到底该走 `reload()` 还是 `enable()`，
     * 而这两者**只有前者会真正换掉代码**：
     *   · `enable()` 对已启用的插件是空操作（状态已 enabled）→ 新代码永远不会被加载，
     *     表现就是**"更新成功了，但插件还是旧行为"**——最坏的一类静默错误
     *     （用户以为更新生效了，然后在错误的方向上排查）；
     *   · `reload()` 才是"停干净 → 丢模块缓存 → 重读 manifest → 重新编译 → 重挂"。
     */
    const wasKnown = !!(reg && typeof reg.getManifests === 'function'
      && reg.getManifests().some((m) => m && m.id === id))
    const wasEnabled = !!(reg && typeof reg.getState === 'function'
      && (reg.getState(id) || {}).enabled)
    /**
     * 用户**主动关掉**的插件，更新之后不该被顺手打开。
     *
     * 与"安装 ≠ 替用户开东西"是同一条原则：更新是替换代码，不是替用户改开关状态。
     * 插件中心会显示"已是最新版本，但你把它关着"，用户想开自己会开。
     */
    const wasUserDisabled = !!(reg && typeof reg.isUserDisabled === 'function' && reg.isUserDisabled(id))

    if (reg && typeof reg.discover === 'function') {
      try { reg.discover() } catch (err) {
        console.warn('[plugins] 安装后重新发现失败：', errorMessage(err))
      }
    }

    let enabled = false
    if (reg && id) {
      try {
        if (wasKnown && wasEnabled) {
          // 覆盖安装（更新）→ 必须重载，否则新代码进不来（见上面 wasEnabled 的说明）
          const r = await reg.reload(id)
          enabled = !!(r && r.enabled)
        } else if (!wasUserDisabled) {
          await reg.enable(id)
          enabled = !!((reg.getState(id) || {}).enabled)
        }
      } catch (err) {
        // 重载/启用失败**不算安装失败**：资产已经好好躺在那儿了，用户在插件中心
        // 点一下还能再试。把它当成"装失败"会让用户去重装一个已经装好的插件。
        console.warn(`[plugins] 已安装 ${id} 但启用/重载失败：`, errorMessage(err))
      }
    }
    if (typeof onPanelsChanged === 'function') {
      try { onPanelsChanged() } catch (_) {}
    }
    if (enabled) notifyActivated([id])
    notifyChanged({ id, installed: true })
  }

  /**
   * 从一个**已经在本地落地的路径**安装（目录或 zip），并跑完安装后的收尾。
   *
   * 分工：**安装器只管文件**（体检 / 复制 / 解压 / 撞名 / 签名），**注册中心只管运行**；
   * 本函数是两者之间的粘合 —— `afterInstallHook` 负责 `discover()` 重新扫目录、
   * `enable()` 把它拉起来、广播、补跑迁移。
   *
   * 抽成具名函数而不是只写在路由里：主题导入（`theme:import`）要把"解出来的主题
   * 插件目录"交给**同一条**安装链路 —— 若它自己另写一份 `installDirectory()` +
   * `discover()` + `enable()`，两边迟早只有一边被修（最典型的是漏掉 `discover()`：
   * 表现在"装成功了，但插件列表里没有它"）。
   *
   * @param {string} target 目录路径或 zip 路径
   * @param {{ source?: 'directory'|'archive', overwrite?: boolean }} [opts]
   */
  async function installFromPath(target: string, opts: InstallFromPathOptions = {}): Promise<PluginInstallResult> {
    if (!pluginInstaller) return { ok: false, reason: '插件安装器不可用' }
    const source = opts.source === 'archive' ? 'archive' : 'directory'
    const overwrite = !!opts.overwrite
    const result = source === 'archive'
      ? await pluginInstaller.installArchive(target, { overwrite })
      : await pluginInstaller.installDirectory(target, { overwrite })
    if (!result.ok) return { ok: false, id: result.id, reason: result.reason }
    if (!result.id) return { ok: false, reason: '插件安装器未返回插件 ID' }

    await afterInstallHook(result.id)
    return {
      ok: true,
      id: result.id,
      name: result.name,
      version: result.version,
      signature: result.signature,
      warnings: result.warnings
    }
  }

  if (routes.pluginsInstall && pluginInstaller) {
    typedMain.handle(routes.pluginsInstall, {
      requestSchema: schemas.install.request,
      responseSchema: schemas.install.response,
      handler: async (e, req) => {
        const source = req && req.source === 'archive' ? 'archive' : 'directory'
        const overwrite = !!(req && req.overwrite)
        let target = req && req.path ? String(req.path) : ''
        if (!target) {
          const picked = await pickInstallSource(e, source)
          if (!picked) return { ok: false, canceled: true }
          target = picked
        }
        return installFromPath(target, { source, overwrite })
      }
    })
  }

  /**
   * 安装一个**用户脚本**（`.user.js`）—— 它是插件的一种（`type: "userscript-plugin"`）。
   *
   * 落盘走的是**同一条** `installDirectory`（体检 / 撞名 / 安全边界一个不少），
   * 收尾也走**同一个** `afterInstallHook`：于是"装完要重新发现 → 启用 → 对账 →
   * 广播"这套顺序不需要在这里复制第二份。用户脚本因此天然获得插件中心的一切
   * （启停开关、卸载、权限提示、失败原因），不会变成一条旁路。
   *
   * 抽成具名函数，是因为它有**两个**调用方：界面导入路由与 AI 工作室。
   * `path` 省略且没有 `text` 时由主进程弹选择框（渲染层永远不碰本地路径 API）。
   * `text` 是给"粘贴脚本 / AI 生成脚本"用的：内容与文件读出来的走完全一样的体检。
   *
   * @param {{ text?: string, path?: string, overwrite?: boolean }} req
   * @param {any} [event] IPC 事件（决定选择框的父窗口；AI 调用时没有）
   */
  async function installUserscript(req: InstallUserscriptRequest = {}, event?: unknown): Promise<UserScriptInstallResult> {
    if (!userScriptInstaller) return { ok: false, reason: '插件安装器不可用' }
    const overwrite = !!(req && req.overwrite)
    const text = req && typeof req.text === 'string' ? req.text : ''
    let target = req && req.path ? String(req.path) : ''
    if (!text && !target) {
      const picked = await pickInstallSource(event, 'userscript')
      if (!picked) return { ok: false, canceled: true }
      target = picked
    }
    const result = await userScriptInstaller.install({ text, path: target, overwrite })
    if (!result.ok) return result
    if (!result.id) return { ok: false, reason: '用户脚本安装器未返回插件 ID' }
    await afterInstallHook(result.id)
    return result
  }

  if (routes.pluginsInstallUserscript && pluginInstaller) {
    typedMain.handle(routes.pluginsInstallUserscript, {
      requestSchema: schemas.installUserscript.request,
      responseSchema: schemas.installUserscript.response,
      handler: async (e, req) => installUserscript(req, e)
    })
  }

  /** 用户脚本清单（面板 / 插件中心的展示面）。表面层没就绪时返回空表而不是报错。 */
  function snapshotUserScripts(): unknown[] {
    const surfaces = typeof getPluginSurfaces === 'function' ? getPluginSurfaces() : null
    if (!surfaces || typeof surfaces.listUserScriptsSummary !== 'function') return []
    try {
      return surfaces.listUserScriptsSummary()
    } catch (e) {
      console.warn('[plugins] 读取用户脚本清单失败：', errorMessage(e))
      return []
    }
  }

  /**
   * 列出全部用户脚本（含被单脚本开关关掉的那些）。
   *
   * 与 `plugins:list` 分开：粒度在**脚本**而不是插件（一个插件可贡献多条），
   * 而且这里回的是脚本元数据（`@match` / `@grant` / 所属插件），插件中心那一份没有。
   */
  if (routes.pluginsListUserscripts && typeof getPluginSurfaces === 'function') {
    typedMain.handle(routes.pluginsListUserscripts, {
      requestSchema: schemas.listUserScripts.request,
      responseSchema: schemas.listUserScripts.response,
      handler: async () => ({ scripts: snapshotUserScripts() })
    })
  }

  /**
   * 单条用户脚本的启停。
   *
   * 只关**这一条**，插件本身继续启用（与插件开关是两维）。落盘走
   * `plugins.userscripts.disabled`（全局键），下一次页面加载即生效。
   */
  if (routes.pluginsSetUserscriptEnabled && typeof setUserScriptDisabled === 'function') {
    typedMain.handle(routes.pluginsSetUserscriptEnabled, {
      requestSchema: schemas.setUserscriptEnabled.request,
      responseSchema: schemas.setUserscriptEnabled.response,
      handler: async (_e, req) => {
        const key = String((req && req.key) || '').trim()
        const enabled = !!(req && req.enabled)
        if (!key) return { ok: false, key, enabled, reason: '缺少脚本键' }
        const next = setUserScriptDisabled(key, !enabled)
        if (!next) return { ok: false, key, enabled, reason: '写入脚本启停状态失败' }
        // 广播：其它窗口的面板 / 插件中心据此重拉清单（脚本集合变了）。
        notifyChanged({ userscriptsChanged: key })
        return { ok: true, key, enabled }
      }
    })
  }

  /**
   * `GM_xmlhttpRequest` 代理 —— 页面 preload 桥的唯一后端。
   *
   * **授权判定不在页面侧**：页面能伪造 `details` 里的任何字段（包括自称是谁），
   * 唯一可信的输入是 IPC 发送方的页面 URL（`event.senderFrame.url`，Electron 给出）。
   * 判定链（`@grant` + `@connect`）全在 `userscript-runtime.js#handleRequest`。
   */
  if (routes.userscriptGmRequest && userscriptRuntime) {
    typedMain.handle(routes.userscriptGmRequest, {
      handler: async (e, req) => {
        let senderUrl = ''
        try {
          const frame = asRecord(asRecord(e).senderFrame)
          senderUrl = frame.url ? String(frame.url) : ''
        } catch (_) {
          senderUrl = ''
        }
        return userscriptRuntime.handleRequest(senderUrl, req || {})
      }
    })
  }

  /**
   * 卸载一个**运行时安装**的插件。
   *
   * 顺序是硬的：**先停用，再删文件**。反过来会出现一段"代码没了但插件还启用着"的
   * 窗口 —— 它的定时器 / 事件回调还在跑，任何相对路径 `require` 都会炸。
   * 连带下游也要一起停（与手动禁用同一套语义，避免留下 `blocked` 的下游）。
   *
   * 内置插件一律拒绝：它们住在应用安装目录里（打包后只读），删掉等于自毁。
   * 判据用 `describe().runtime`（"资产是否来自用户目录"）而不是"id 在不在内置名单里" ——
   * 后者在插件新增/改名时必然漏。
   *
   * 抽成具名函数：界面卸载与 AI 工作室卸载必须走同一条（含级联停用、持久化清理、对账）。
   *
   * @param {string} rawId
   * @returns {Promise<{ ok: boolean, id: string, reason?: string }>}
   */
  async function uninstallPlugin(rawId: string): Promise<{ ok: boolean; id: string; reason?: string }> {
    const id = String(rawId || '')
    if (!pluginInstaller) return { ok: false, id, reason: '插件安装器不可用' }
    const info = snapshot().find((p) => p.id === id)
    if (!info) return { ok: false, id, reason: `未找到插件：${id}` }
    if (!info.runtime) {
      return { ok: false, id, reason: `${info.name || id} 是内置插件（在应用安装目录里），不能卸载` }
    }
    const reg = registry()
    if (reg) {
      try {
        for (const dep of findEnabledDependents(reg, id, snapshot())) await reg.disable(dep.id)
        // 走注册中心的 uninstall（= disable + 生命周期钩子），而不是只 disable：
        // 插件自己可能需要收尾（清缓存、注销外部注册）。
        await reg.uninstall(id)
      } catch (err) {
        console.warn(`[plugins] 卸载前停用 ${id} 失败（继续删文件）：`, errorMessage(err))
      }
      // 忘掉它的三份持久化痕迹 —— 不清的话，同一个 id 被**重新安装**时会立刻
      // 沿用上一次的禁用/停用/授权状态，表现为"刚装好就是关着的"。
      try {
        if (typeof reg.setUserDisabled === 'function') reg.setUserDisabled(id, false)
        if (typeof reg.setAutoDisabled === 'function') reg.setAutoDisabled(id, false)
        if (typeof reg.setGrantedPermissions === 'function') reg.setGrantedPermissions(id, [])
      } catch (_) {}
    }
    const result = await pluginInstaller.uninstall(id)
    if (!result.ok) return { ok: false, id, reason: errorMessage(result.reason) }
    if (typeof onPluginUninstalled === 'function') {
      try { onPluginUninstalled(id) } catch (_) {}
    }
    if (reg && typeof reg.discover === 'function') {
      try { reg.discover() } catch (_) {}
    }
    if (typeof onPanelsChanged === 'function') {
      try { onPanelsChanged() } catch (_) {}
    }
    notifyChanged({ id, uninstalled: true })
    return { ok: true, id }
  }

  if (routes.pluginsUninstall && pluginInstaller) {
    typedMain.handle(routes.pluginsUninstall, {
      requestSchema: schemas.uninstall.request,
      responseSchema: schemas.uninstall.response,
      handler: async (_e, req) => uninstallPlugin(req.id)
    })
  }

  /**
   * 受信任的签名公钥（验签的**另一半**）。
   *
   * 三条都不碰注册中心：公钥是**安装器**的事实（它就在 `plugin-trust` 目录里），
   * 生效时机是下一次安装/体检。所以这里不需要 `discover()`、不需要广播 ——
   * 加一条"改了就重扫插件"只会让一次导入公钥顺带重启一遍插件链。
   *
   * 导入的 `.pem` **由主进程弹选择框**挑（与安装同一个理由：渲染层不碰本地路径 API）。
   */
  if (routes.pluginsTrustList && pluginInstaller) {
    typedMain.handle(routes.pluginsTrustList, {
      requestSchema: schemas.trustList.request,
      responseSchema: schemas.trustList.response,
      handler: async () => ({ keys: pluginInstaller.listTrustedKeys() })
    })

    typedMain.handle(routes.pluginsTrustAdd, {
      requestSchema: schemas.trustAdd.request,
      responseSchema: schemas.trustAdd.response,
      handler: async (e, req) => {
        let target = req && req.path ? String(req.path) : ''
        if (!target) {
          const dialog = require('electron').dialog
          const win = ownerWindow(e)
          try {
            const r = await dialog.showOpenDialog(win, {
              title: '选择公钥文件',
              properties: ['openFile'],
              filters: [{ name: '公钥（PEM）', extensions: ['pem', 'crt', 'pub'] }, { name: '全部文件', extensions: ['*'] }]
            })
            if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true }
            target = r.filePaths[0]
          } catch (err) {
            return { ok: false, reason: `无法打开文件选择框：${errorMessage(err)}` }
          }
        }
        // 级别由渲染层指定（社区 / 本地）；`official` 会被安装器直接拒掉
        return pluginInstaller.addTrustedKey(target, {
          level: req && req.level,
          overwrite: !!(req && req.overwrite)
        })
      }
    })

    typedMain.handle(routes.pluginsTrustRemove, {
      requestSchema: schemas.trustRemove.request,
      responseSchema: schemas.trustRemove.response,
      // 级别必须带上：不同级别允许同名公钥，只给 keyId 无法确定删哪一个
      handler: async (_e, req) => pluginInstaller.removeTrustedKey(req.keyId, req.level)
    })
  }

  /**
   * 插件源（社区市场的**索引那一半**）：查 / 设地址 / 一键装。
   *
   * 与"从文件安装"共用同一条落盘路径（`pluginInstaller.installArchive`）——
   * 市场不是一种更可信的来源，只是更省事的来源：体检、撞名、zip-slip、扩展名白名单、
   * 签名校验一个都不少（外加索引声明的 sha256 校验，那是市场**多**出来的一道）。
   */
  if (routes.pluginsMarketList && pluginMarket) {
    typedMain.handle(routes.pluginsMarketList, {
      requestSchema: schemas.marketList.request,
      responseSchema: schemas.marketList.response,
      handler: async (_e, req) => pluginMarket.query({ force: !!(req && req.force) })
    })

    typedMain.handle(routes.pluginsMarketSetSources, {
      requestSchema: schemas.marketSetSources.request,
      responseSchema: schemas.marketSetSources.response,
      // 整表提交（增 / 删 / 排序都是它）—— 见契约里的说明
      handler: async (_e, req) => pluginMarket.setSources(req && req.sources)
    })

    typedMain.handle(routes.pluginsMarketInstall, {
      requestSchema: schemas.marketInstall.request,
      responseSchema: schemas.marketInstall.response,
      handler: async (_e, req) => {
        const result = await pluginMarket.install(req.id, {
          overwrite: req.overwrite !== false,
          force: !!req.force
        })
        if (!result.ok) {
          return {
            ok: false,
            id: result.id || req.id,
            version: result.version,
            name: result.name,
            verified: result.verified,
            signature: result.signature,
            warnings: result.warnings,
            reason: result.reason
          }
        }
        if (!result.id) return { ok: false, id: req.id, reason: '插件市场未返回插件 ID' }
        // 与"从文件安装"完全同一条收尾：重新发现 → 启用 → 面板对账 → 广播 → 迁移。
        // 复制一份出来的话，两条安装路径迟早会在某一步分叉（差一个 notifyChanged
        // 的表现就是"装完了但列表里看不到"）。
        await afterInstallHook(result.id)
        return {
          ok: true,
          id: result.id,
          version: result.version,
          name: result.name,
          verified: result.verified,
          signature: result.signature,
          warnings: result.warnings
        }
      }
    })
  }

  /**
   * 插件键值存储（开放 API 的持久化面）。
   *
   * 这里是**第二道闸门**（第一道在渲染侧 `panel-ui-bridge.js`：它用自己的 pluginId
   * 覆写请求参数，并按 scope 放行）。为什么还要一道：
   *   · 这条 IPC 对**所有**渲染进程可见，不止沙箱 iframe 那一条路；
   *   · 桥的判定发生在渲染进程里，而渲染进程不是可信边界 —— 真正的授权事实
   *     （`grantedPermissions`）只在主进程的注册中心里。
   *
   * 判定规则：
   *   · 第一方插件（随应用分发）→ 直接放行（它们的代码与核心同等可信）；
   *   · 第三方插件 → 必须持有 `storage:read` / `storage:write`；
   *   · 注册中心尚未就绪 → **放行但记一条告警**（此时快照为空，拒绝会误伤启动早期的
   *     第一方面板；而真正危险的是"已知插件的越权"，那一条仍然拦得住）。
   *
   * @param {string} id
   * @param {boolean} write
   * @returns {string|null} 拒绝原因；null = 放行
   */
  function storageDeniedReason(id: string, write: boolean): string | null {
    const reg = registry()
    if (!reg) return null
    const info = snapshot().find((p) => p.id === id)
    if (!info) return `未找到插件：${id}`
    if (info.isFirstParty) return null
    const scope = write ? 'storage:write' : 'storage:read'
    const granted = Array.isArray(info.grantedPermissions) ? info.grantedPermissions : []
    if (!granted.includes(scope)) return `插件「${info.name || id}」未获得 ${scope} 授权`
    return null
  }

  if (routes.pluginsStorageGet && pluginStorage) {
    typedMain.handle(routes.pluginsStorageGet, {
      requestSchema: schemas.storageGet.request,
      responseSchema: schemas.storageGet.response,
      handler: async (_e, req) => {
        const denied = storageDeniedReason(req.pluginId, false)
        if (denied) return { ok: false, value: null, updatedAt: null, reason: denied }
        return pluginStorage.get(req.pluginId, req.key)
      }
    })

    typedMain.handle(routes.pluginsStorageSet, {
      requestSchema: schemas.storageSet.request,
      responseSchema: schemas.storageSet.response,
      handler: async (_e, req) => {
        const denied = storageDeniedReason(req.pluginId, true)
        if (denied) return { ok: false, reason: denied }
        return pluginStorage.set(req.pluginId, req.key, req.value)
      }
    })

    typedMain.handle(routes.pluginsStorageRemove, {
      requestSchema: schemas.storageRemove.request,
      responseSchema: schemas.storageRemove.response,
      handler: async (_e, req) => {
        const denied = storageDeniedReason(req.pluginId, true)
        if (denied) return { ok: false, removed: 0, reason: denied }
        return pluginStorage.remove(req.pluginId, req.key)
      }
    })

    typedMain.handle(routes.pluginsStorageKeys, {
      requestSchema: schemas.storageKeys.request,
      responseSchema: schemas.storageKeys.response,
      handler: async (_e, req) => {
        const denied = storageDeniedReason(req.pluginId, false)
        if (denied) return { ok: false, keys: [], reason: denied }
        return pluginStorage.keys(req.pluginId, req.prefix)
      }
    })

    typedMain.handle(routes.pluginsStorageClear, {
      requestSchema: schemas.storageClear.request,
      responseSchema: schemas.storageClear.response,
      handler: async (_e, req) => {
        const denied = storageDeniedReason(req.pluginId, true)
        if (denied) return { ok: false, removed: 0, reason: denied }
        return pluginStorage.clear(req.pluginId)
      }
    })
  }

  /**
   * 插件浮层关闭（PART18）：渲染侧点了浮层右上角的 ×。
   *
   * 归属按**发送方窗口**解析（`BrowserWindow.fromWebContents`），而不是"当前窗口"——
   * 同一浮层可能在两个窗口里各开一份，关掉 A 窗口的那份不能顺手关掉 B 的。
   * 主进程找不到记录也照样广播 hide：渲染侧是"请求关闭"，幂等收尾比报错有用。
   */
  if (routes.pluginsOverlayClose && pluginOverlayHost && schemas.overlayClose) {
    typedMain.handle(routes.pluginsOverlayClose, {
      requestSchema: schemas.overlayClose.request,
      responseSchema: schemas.overlayClose.response,
      handler: async (e, req) => {
        let windowId = 0
        try {
          const win = ownerWindow(e)
          if (win && !win.isDestroyed()) windowId = win.id
        } catch (_) {}
        try {
          pluginOverlayHost.closeFromRenderer(req.key, windowId)
          return { ok: true }
        } catch (err) {
          return { ok: false, reason: errorMessage(err) || '浮层关闭失败' }
        }
      }
    })
  }

  typedMain.handle(routes.pluginsSetEnabled, {
    requestSchema: schemas.setEnabled.request,
    responseSchema: schemas.setEnabled.response,
    handler: async (_e, req) => setPluginEnabled(req)
  })

  /**
   * 插件启停的**唯一实现** —— IPC handler 与 AI 工具（`plugin_toggle`）共用这一份。
   *
   * 为什么不给 AI 另写一套：这里每一步都有顺序与语义（闸门 1/2 → 拓扑启停 →
   * 落盘 userDisabled → 面板对账 → 广播 → 迁移），复制一份必然漂移，最终表现为
   * 「页面能关、AI 关掉后重启又自己回来了」这种只在一条路径上出现的幽灵问题。
   *
   * @param {{ id: string, enabled: boolean, cascade?: boolean }} req
   */
  async function setPluginEnabled(req: PluginToggleRequest): Promise<PluginToggleResponse> {
    const { id, enabled, cascade } = req
    const reg = registry()
    if (!reg) {
      return { ok: false, id, enabled: false, reason: '插件注册中心尚未就绪，请稍后重试' }
    }
    let target = reg.getManifests().find((m) => m.id === id)
    if (!target && typeof reg.discover === 'function') {
      /**
       * 插件可能是**刚刚才落到磁盘**的（AI 工作室生成、外部工具写入用户插件目录）。
       * 注册中心只扫目录、不监听文件系统，所以这里补一次 discover 再找 ——
       * 否则 AI「写文件 → 打开插件」这条路只能等重启，表现就是"做完装不上"。
       */
      try {
        reg.discover()
        target = reg.getManifests().find((m) => m.id === id)
      } catch (err) {
        console.warn(`[plugins] 启停前重新扫描插件目录失败：`, errorMessage(err))
      }
    }
    if (!target) {
      return { ok: false, id, enabled: false, reason: `未找到插件：${id}` }
    }

    // ── 禁用的两道闸门（§10.3 point 3：静态判定 + 被依赖动态判定，两者都要拦）──
    // 两道闸门的**提示语必须不同**：一个是"这东西不能关"（静态、永远为真），
    // 一个是"现在关会带走别人"（动态、可以绕过）。合并成一句会让用户无法判断该怎么办。
    let cascadeTargets: DependentTarget[] = []
    if (!enabled) {
      // 快照一次算清，下面三处都用它（闸门 1 的判定字段、连带范围、连带里有没有不可禁用的）——
      // 同一次请求里不该把 manifest 表算三遍。
      const snapshot = reg.describe() as PluginDescriptorRecord[]
      /**
       * 闸门 1（静态）：**不可禁用**的插件只允许看，不允许关。
       *
       * ⚠ 判定字段必须取自**快照**（`describe().nonDisableable`），不是 `target`。
       * `target` 是 `normalizeManifest` 的产物，它的 `nonDisableable` 是**原始声明**
       * （只反映 `manifest.nonDisableable`）—— 对 `trustLevel: "core"` 的插件是 `false`。
       * 照着 `target` 判会让 core 插件**绕过闸门 1**，一路走到 `disable()` 真的被卸载，
       * 只在底层留一行告警。统一判定只有一处（注册中心的 `isNonDisableable`），
       * 这里必须用它算出来的那个值。
       *
       * 两个来源的提示语也不同（一个说"它是核心"，一个说"关掉就没了"）：
       *   · `core`      —— 浏览器最小可运行集合（tabs / settings），关掉浏览器就残了；
       *   · 唯一出口类  —— 如**插件中心自己**（内部页 `hira://plugins`）：按下开关的那一刻就把
       *                    "管理插件的唯一入口"关掉了，之后**再也找不到地方把它打开**。
       *                    这不是"功能坏了"，是"按一下就永久锁死"。
       */
      const targetInfo = snapshot.find((x) => x.id === id) || target
      if (targetInfo.nonDisableable === true) {
        const name = targetInfo.name || id
        return {
          ok: false,
          id,
          enabled: true,
          reason: targetInfo.trustLevel === 'core'
            ? `${name} 是核心插件，不可禁用`
            : `${name} 不可禁用：关掉它之后再没有任何界面入口能把它打开`
        }
      }
      // 闸门 2（动态）：连带范围。先算出来 —— 因为它既用于"要不要拦"，也用于"拦谁"。
      cascadeTargets = findEnabledDependents(reg, id, snapshot)
      /**
       * 闸门 1 的延伸：连带集合里若含**不可禁用**的插件 → **硬拒**，
       * 且必须排在"要不要确认"之前。
       *
       * 两条边界都容易做错，记下来：
       *  · 为什么需要它：闸门 1 是**静态**判定（"这东西不能关"）。但不可禁用的插件
       *    常常是**被依赖方**（所有面板都依赖侧栏骨架）。只查它自己拦不住 ——
       *    从依赖方向一样能把它关掉（关掉它的前置 → 它落 blocked → 界面上它没了）。
       *  · 为什么顺序要在这里：若放在 `requiresCascade` 之后，带 `cascade: true` 的调用
       *    会绕过它（用户"确认"了一个本来就不允许的操作）。**权限判定必须早于确认流程**，
       *    否则确认框会变成绕过闸门的入口。
       */
      const lockedInCascade = cascadeTargets.find((d) => {
        const m = snapshot.find((x) => x.id === d.id)
        return m && m.nonDisableable === true
      })
      if (lockedInCascade) {
        return { ok: false, id, enabled: true, reason: `连带范围包含不可禁用的插件「${lockedInCascade.name}」，不可一起禁用` }
      }
      if (cascadeTargets.length && cascade !== true) {
        // 两段式（方案 b）：**不直接照做**，把连带范围回给 UI 去确认。
        return {
          ok: false,
          id,
          enabled: true,
          requiresCascade: true,
          dependents: cascadeTargets,
          reason: `以下已启用插件依赖它，将一并禁用：${cascadeTargets.map((d) => d.name).join('、')}`
        }
      }
    }

    // 为达成这次操作而**顺带改动**的其它插件（连带禁用 / 顺带恢复的前置）——
    // 它们与目标插件同属"用户这次操作的结果"，落盘与广播都要覆盖到。
    let restored: string[] = []
    try {
      if (enabled) {
        // §10.3 point 1：**启用必须按拓扑序恢复** —— 由 enableWithPrerequisites 走同一条路径。
        // 顺序反了的话前置还没起来依赖方就先失败，会被误记成 failed。
        const r = await reg.enableWithPrerequisites(id)
        restored = (r && r.restored) || []
      } else {
        // §10.3 point 4 与 point 1 同源：**禁用走同一条拓扑路径**（逆序），
        // 不在这里另写一份循环 —— 否则两条路径迟早分叉。
        for (const dep of cascadeTargets) await reg.disable(dep.id)
        await reg.disable(id)
      }
    } catch (e) {
      return { ok: false, id, enabled: !enabled, reason: errorMessage(e) }
    }

    const state: PluginRuntimeState = reg.getState(id) || { enabled }
    // 启用请求发出去了，但结果是"没启用" → 一定是前置未就绪（第 5 态 blocked）。
    // 必须回 ok:false + 原因，否则用户只看到开关自己弹回去，不知道为什么。
    if (enabled && state.enabled !== true) {
      return { ok: false, id, enabled: false, reason: state.error || '前置未启用，无法启用该插件' }
    }
    const result: PluginToggleResponse = { ok: true, id, enabled: !!state.enabled }
    // 顺带恢复的前置一并回传：UI 需要"告知"用户（他没点名要开它们，但这次启用隐含了）。
    if (restored.length) {
      const manifests = reg.getManifests()
      result.restored = restored.map((rid) => {
        const m = manifests.find((x) => x.id === rid)
        return { id: rid, name: (m && m.name) || rid }
      })
    }
    /**
     * ① 落盘"用户主动禁用"意图。
     *
     * **必须在真正的 enable/disable 成功之后**才写：先写后做的话，
     * 一旦 disable 抛错，磁盘上就留下了一个"已禁用"而内存里还启用着的分裂状态，
     * 重启后才暴露（表现为"我没关过它，怎么关着"）。
     *
     * 另外：这里只写 `userDisabled`。启用失败（failed）不落盘 —— 那由
     * plugin-state-store.js 的说明负责（落盘 = 一次偶发失败变永久故障）。
     */
    if (typeof onPluginDisabled === 'function' || typeof reg.setUserDisabled === 'function') {
      /**
       * 落盘的**范围** = 本次操作真实改动过的每一个插件，不只是目标本身：
       *
       *  · 禁用时 → 目标 + 连带禁用的下游。它们是用户在同一句话里确认过的
       *    （"将一并禁用 X、Y"），同属"用户意图"。不记的话重启后它们会回到"未禁用"，
       *    用户会发现"我确认关掉的那些又变成开着的样子了"，只能再关一遍。
       *  · 启用时 → 目标 + 为它**顺带恢复**的前置（`restored`）。那一侧的 `userDisabled`
       *    已在注册中心被清掉，磁盘也必须同步清 —— 否则重启后前置又被当成"用户禁用"，
       *    下游立刻回到 `blocked`，用户看到的是"我刚打开的东西自己又关了"。
       *
       * ⚠ 注册中心侧的 `setUserDisabled` 也必须在这里复核：`restored` 是注册中心自己改的，
       * 但 `cascadeTargets` 只在**主进程这层**才知道 —— 两处都得写，漏一处就是半持久化。
       */
      const targets = result.enabled === true
        ? [id, ...restored]
        : [id, ...cascadeTargets.map((d) => d.id)]
      const userDisabled = result.enabled !== true
      try {
        for (const targetId of targets) {
          // ①a 注册中心记住"这是用户意图"（describe().userDisabled 靠它；也让本会话内
          //     后续的 enableAll/对账看到同一份意图）。
          //     ⚠ 只有**用户操作**能写它 —— 这正是 userDisabled 与 failed 的分界线。
          if (typeof reg.setUserDisabled === 'function') reg.setUserDisabled(targetId, userDisabled)
          // ①b 同步到磁盘（存储细节全在 plugin-state-store.js；这里不碰存储）
          if (typeof onPluginDisabled === 'function') onPluginDisabled(targetId, userDisabled)
        }
      } catch (e) {
        console.warn('[plugins] persist plugin state failed:', errorMessage(e))
      }
    }
    // ② 布局层对账：面板插件被启停后，已打开的面板视图必须关掉并销毁（释放渲染进程）。
    //    放在广播之前 —— 先把窗口收拾干净，渲染层再按新目录重建按钮，顺序反过来会
    //    出现「按钮没了但面板还开着」的一帧。
    if (typeof onPanelsChanged === 'function') {
      try { onPanelsChanged() } catch (e) { console.warn('[plugins] panel reconcile failed:', errorMessage(e)) }
    }
    // ③ 变更广播：所有窗口的插件中心 + 其它关心插件集合的渲染层据此对账。
    notifyChanged({ id, enabled: result.enabled })
    // ④ 真的跑起来了 → 让宿主补跑这批插件贡献的 schema 迁移（含顺带恢复的前置）。
    //    放在广播之后：迁移可能建表/改数据，属于"启用已经成功"的后续，不该挡着 UI 更新。
    if (result.enabled === true) notifyActivated([id, ...restored])
  return result
}

  /**
   * 对外的四个端口（其余是内部实现）：
   *   · `installFromPath`   —— 界面安装 / 主题导入 / **AI 工作室**共用
   *   · `uninstallPlugin`   —— 界面卸载 / **AI 工作室**共用
   *   · `installUserscript` —— 界面导入 / **AI 工作室**共用
   *   · `setPluginEnabled`  —— 界面开关 / AI `plugin_toggle` 共用
   * 全部收敛到这里，是为了让"AI 能做的事"与"用户点得到的事"永远同源。
   */
  return { notifyChanged, installFromPath, uninstallPlugin, installUserscript, setPluginEnabled }
}

module.exports = { registerPluginsIpc }
