/**
 * ipc/theme.ts — 主题域路由（自包含，不在 ipc-routes.ts 里散布）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本注册器只做「转调 + 剪裁」，不含任何主题规则
 * ══════════════════════════════════════════════════════════════════════
 *   · 目录/当前主题/切换/调度/增删用户主题 → theme-service（唯一主题状态源）
 *   · 重新发布（换完要让界面变）           → theme-runtime.publish()
 *   · 调度到点后立即重判                   → theme-scheduler.refresh()
 * 规则（内置优先、撞 id、旧值迁移、装饰器流水线、用户主题 id 前缀）全在服务里 ——
 * 于是"从 IPC 换主题"与"从调度换主题"必然走同一条链，不会一个生效一个不生效。
 *
 * ── 为什么没有 zod schema ─────────────────────────────────────────────
 * 入参面极小（`{ id }` / `{ theme }` / `{ schedule }`），且合法性由业务判定兜住
 * （"主题不存在" / "内置主题不可编辑"都在 theme-service 里，不在契约里）。
 * 为它造几个只有单字段的 schema，只会增加一处要同步改的地方。
 *
 * ── 令牌表为什么要单独开一条通道 ──────────────────────────────────────
 * `theme:changed` 广播只解决"已经开着的页面"。内部页（`hira://` 下的设置/历史/下载…）
 * 没有 theme-controller，它们在**加载那一刻**就要一次当前配色，否则会先按出厂色画一帧。
 * 两条给的是同一份 `tokens`（都出自 `themeService.tokensFor`），不存在两套真源。
 *
 * ── 私密窗口为什么在**请求方向**也要区分 ──────────────────────────────
 * `theme:changed` 能定向推给私密窗口，但"新开的私密窗口在加载那一刻"没有历史广播可收 ——
 * 它只能主动问。所以 `theme:active` / `theme:tokens` 两条读口都按**发起窗口**是否私密
 * 解析主题（`ctx.isIncognito`），与广播链给出同一个答案。
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron'
import type { IpcRoutes, IpcTypedMain } from './types'

interface ThemeBackgroundSpec {
  kind?: string
  color?: unknown
  css?: unknown
  applyTo?: unknown
  opacity?: unknown
  blur?: unknown
  overlay?: unknown
  path?: string
  [key: string]: unknown
}

interface ThemeDefinition {
  id: string
  name?: string
  author?: string
  version?: string
  mode?: string
  source?: string
  pluginId?: string
  colors?: unknown
  style?: unknown
  background?: ThemeBackgroundSpec
  preview?: unknown
  [key: string]: unknown
}

interface ThemeMutationResult {
  ok: boolean
  reason?: string
  theme?: ThemeDefinition
}

interface ThemeServicePort {
  getActiveThemeFor(options: { incognito: boolean }): ThemeDefinition | null
  tokensFor(theme: unknown): unknown
  backgroundFor(theme: unknown): unknown
  list(): ThemeDefinition[]
  getActiveId(): string
  privateThemeId?(): string
  setActive(id: string, options?: Record<string, unknown>): Promise<ThemeMutationResult> | ThemeMutationResult
  refreshSources(): Promise<unknown> | unknown
  draftTheme(baseId: string, options: { asNew: boolean }): ThemeDefinition | null
  saveUserTheme(raw: unknown): Promise<ThemeMutationResult> | ThemeMutationResult
  deleteUserTheme(id: string): Promise<ThemeMutationResult> | ThemeMutationResult
  get(id: string): ThemeDefinition | null | undefined
}

interface ThemeRuntimePort {
  publish?(): Promise<unknown> | unknown
  describeSurface?(theme: unknown): unknown
}

interface ThemeSchedulerPort {
  refresh?(): Promise<unknown> | unknown
  schedule?(): unknown
}

interface SettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): Promise<unknown> | unknown
}

interface ThemeAssetImportResult {
  ok: boolean
  key?: string
  url?: string
  bytes?: number
  mediaKind?: 'image' | 'video'
  reason?: string
}

interface ThemeAssetStorePort {
  importFile?(sourcePath: string): Promise<ThemeAssetImportResult> | ThemeAssetImportResult
  read?(key: string): Promise<Buffer | null> | Buffer | null
}

interface ThemePackageAsset {
  name: string
  data: Buffer
}

type ThemePackageParseResult =
  | { ok: true; theme: unknown; assets?: ThemePackageAsset[]; warnings?: string[] }
  | { ok: false; reason: string }

interface ThemePackageFile { name: string; data: Buffer | string }
interface ThemePluginManifest {
  id: string
  name: Record<string, string>
  contributes: { themes: Array<{ id?: string }> }
  [key: string]: unknown
}

interface ThemePluginInstallResult {
  ok?: boolean
  reason?: unknown
  warnings?: unknown
  id?: string
  [key: string]: unknown
}

interface ThemeIpcContext {
  routes: IpcRoutes
  themeService: ThemeServicePort
  themeRuntime?: ThemeRuntimePort | null
  scheduler?: ThemeSchedulerPort | null
  settings?: SettingsPort | null
  isIncognito?(): boolean
  pluginAssets?: { read?(pluginId: string, rel: string): Buffer | null } | null
  themeAssets?: ThemeAssetStorePort | null
  runAsProfile?: <T>(profileId: string, task: () => T) => T
  installPluginFromPath?: (target: string, options?: Record<string, unknown>) => Promise<ThemePluginInstallResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const {
  THEME_SETTING_KEYS,
  isUserThemeId,
  BACKGROUND_ASSET_KINDS
} = require('@hira-ng/shared-types/src/theme.mjs') as {
  THEME_SETTING_KEYS: Record<string, string>
  isUserThemeId(id: unknown): boolean
  BACKGROUND_ASSET_KINDS: readonly string[]
}
const {
  packTheme,
  unpackTheme,
  buildImportPackage,
  suggestedFileName
} = require('../theme-package') as {
  packTheme(theme: unknown, assets?: readonly ThemePackageAsset[]): Buffer
  unpackTheme(buffer: Buffer): ThemePackageParseResult
  buildImportPackage(input: { theme: unknown; assets?: ThemePackageAsset[] }): {
    manifest: ThemePluginManifest
    files: ThemePackageFile[]
  }
  suggestedFileName(theme: unknown): string
}
// 媒体白名单**只有一份**（协议层决定"哪些能发出去"），对话框的过滤器直接引用它
const { IMAGE_EXT, VIDEO_EXT } = require('../theme-asset-protocol') as {
  IMAGE_EXT: ReadonlySet<string>
  VIDEO_EXT: ReadonlySet<string>
}

/** 导出包的文件过滤器（导入共用同一份，两处不一致会出现"导出的包导不回来"）。 */
const ZIP_FILTERS = [{ name: 'Hira 主题包', extensions: ['zip'] }]

/**
 * 「选择背景图片 / 视频」的文件过滤器 —— 与 `theme-asset-protocol` 的白名单**同源**
 * （`IMAGE_EXT` / `VIDEO_EXT` 是那一条的导出）。对话框里能选到的格式，协议就一定要
 * 发得出去；两处各写一份的话，漏一个扩展名的表现是"选得中、却永远加载不出来"。
 */
const extList = (set: ReadonlySet<string>): string[] => [...set].map((extension: string) => extension.replace(/^\./, ''))
const IMAGE_FILTERS = [{ name: '图片', extensions: extList(IMAGE_EXT) }]
const VIDEO_FILTERS = [{ name: '视频', extensions: extList(VIDEO_EXT) }]

/**
 * 「选择背景媒体」的对话框参数（按 `kind` 给标题与过滤器）。
 *
 * ⚠ 过滤器只是**提示**：用户可以在对话框里切到"所有文件"选到任何东西。
 * 所以真正写进 `background.kind` 的值取自 `importFile` 返回的 `mediaKind`
 * （按扩展名判定），而不是这里的 `kind` —— 见 theme-assets.js#importFile 的说明。
 */
function pickDialogSpec(kind: string): { title: string; filters: Array<{ name: string; extensions: string[] }> } {
  return kind === 'video'
    ? { title: '选择背景视频', filters: VIDEO_FILTERS }
    : { title: '选择背景图片', filters: IMAGE_FILTERS }
}

/**
 * 弹窗时的宿主窗口。
 * `getOwnerBrowserWindow` 拿不到时传 null —— 那是"没有父窗口"的合法情形，
 * Electron 会把它当成应用级对话框，而不是失败。
 */
function ownerWindow(event: unknown): BrowserWindow | null {
  try {
    const sender = asRecord(asRecord(event).sender)
    return typeof sender.getOwnerBrowserWindow === 'function'
      ? (sender.getOwnerBrowserWindow as () => BrowserWindow | null).call(sender)
      : null
  } catch (_) {
    return null
  }
}

/** 主题摘要 —— 只吐出渲染层画卡片需要的东西（不含内部字段，也不含整张令牌表）。 */
function summarize(themeValue: unknown): Record<string, unknown> {
  const theme = asRecord(themeValue)
  const colors = asRecord(theme.colors)
  const background = asRecord(theme.background)
  return {
    id: theme.id,
    name: theme.name,
    author: theme.author,
    version: theme.version,
    mode: theme.mode,
    source: theme.source,
    /** 能不能编辑 / 删除 —— 判据只有 id 前缀（见 shared-types#isUserThemeId）。 */
    editable: isUserThemeId(theme.id),
    /** 配色条用：取四档最直观的色（少了画不出预览）。 */
    swatch: {
      bg: colors.bg || '',
      surface: colors.surface || colors.solid || '',
      accent: colors.accent || '',
      fg: colors.fg || ''
    },
    style: theme.style,
    background: {
      kind: background.kind,
      color: background.color,
      css: background.css,
      applyTo: background.applyTo,
      opacity: background.opacity,
      blur: background.blur,
      overlay: background.overlay
    },
    preview: theme.preview
  }
}

/**
 * @param {{ handle: Function }} typedMain
 * @param {{
 *   routes: any,
 *   themeService?: object,
 *   themeRuntime?: { publish?: Function },
 *   scheduler?: { refresh?: Function, schedule?: Function },
 *   settings?: { get: Function, set: Function },
 *   isIncognito?: () => boolean,
 *   pluginAssets?: { read?: (pluginId: string, rel: string) => Buffer|null },
 *   themeAssets?: { importFile?: Function, read?: Function },
 *   installPluginFromPath?: (target: string, opts?: object) => Promise<object>
 * }} ctx
 */
export function registerThemeIpc(typedMain: IpcTypedMain, ctx: ThemeIpcContext): void {
  const { routes, themeService, themeRuntime, scheduler, settings } = ctx
  if (!typedMain || !themeService) return

  /** 发起这次调用的窗口是不是私密窗口（决定读哪一份主题）。 */
  const incognito = () => {
    try {
      return typeof ctx.isIncognito === 'function' ? !!ctx.isIncognito() : false
    } catch (_) {
      return false
    }
  }

  /**
   * 读插件目录里的一个资产文件（导出主题包时把背景图一起带走）。
   * 读不到返回 null —— 调用方据此把"包里没有图"作为**警告**报出去，
   * 而不是让导出静默产出一个缺图的包。
   */
  const readPluginAsset = (pluginId: string, rel: string): Buffer | null => {
    const read = ctx.pluginAssets && ctx.pluginAssets.read
    if (typeof read !== 'function' || !pluginId || !rel) return null
    try {
      return read(pluginId, rel) || null
    } catch (e) {
      console.warn('[theme] 读取主题资产失败：', errorMessage(e))
      return null
    }
  }

  /**
   * 导出时把主题的背景图读出来 —— **按来源选通道**（与 `assetUrlFor` 同一套判据）：
   *   插件主题 → 插件目录；用户主题 → app 的主题资产库。
   * 少了后半条，用户自己选的图会在导出的包里静默消失（包里只有配色）。
   */
  const readThemeAsset = async (themeValue: unknown, relValue: unknown): Promise<Buffer | null> => {
    const rel = String(relValue || '')
    if (!rel) return null
    const theme = asRecord(themeValue)
    if (theme.pluginId) return readPluginAsset(String(theme.pluginId), rel)
    const read = ctx.themeAssets && ctx.themeAssets.read
    if (typeof read !== 'function') return null
    try {
      return (await read(rel)) || null
    } catch (e) {
      console.warn('[theme] 读取用户主题资产失败：', errorMessage(e))
      return null
    }
  }

  const activePayload = () => {
    const theme = themeService.getActiveThemeFor({ incognito: incognito() })
    return {
      id: theme ? theme.id : '',
      theme: theme ? summarize(theme) : null,
      tokens: themeService.tokensFor(theme)
    }
  }

  const catalogPayload = () => ({
    themes: themeService.list().map(summarize),
    activeId: themeService.getActiveId(),
    privateId: typeof themeService.privateThemeId === 'function' ? themeService.privateThemeId() : ''
  })

  const publishNow = async () => {
    if (themeRuntime && typeof themeRuntime.publish === 'function') await themeRuntime.publish()
  }

  /**
   * 这份主题对应的**窗口材质状态**（原生窗口是否真的透出系统模糊）。
   *
   * 为什么不能只靠 `theme:changed` 广播里那份：`theme:tokens` 是"晚加载的页面主动补取"
   * 的那条口，它拿到的必须是**和广播同一口径**的 surface —— 少给这一格，外壳就会以为
   * "窗口没开材质"而给 chrome 铺一层不透明底，亚克力被自己盖住（材质等于白设）。
   * 判定口径（能力探测、applied 能否为真）全在 theme-runtime，本层不重算。
   */
  const surfaceFor = (theme: unknown): unknown => {
    if (!themeRuntime || typeof themeRuntime.describeSurface !== 'function') return null
    try {
      return themeRuntime.describeSurface(theme)
    } catch (_) {
      return null
    }
  }

  typedMain.handle(routes.themeList, {
    handler: async (_e, req) => {
      const profileId = req && typeof req === 'object' && typeof (req as Record<string, unknown>).profileId === 'string'
        ? String((req as Record<string, unknown>).profileId)
        : ''
      const run = () => catalogPayload()
      return profileId && typeof ctx.runAsProfile === 'function' ? ctx.runAsProfile(profileId, run) : run()
    }
  })

  typedMain.handle(routes.themeActive, { handler: () => activePayload() })

  typedMain.handle(routes.themeTokens, {
    handler: () => {
      const theme = themeService.getActiveThemeFor({ incognito: incognito() })
      return {
        id: theme ? theme.id : '',
        mode: theme ? theme.mode : 'light',
        tokens: themeService.tokensFor(theme),
        background: themeService.backgroundFor(theme),
        /** 窗口材质状态（与 `theme:changed` 广播同一口径）—— 外壳据此决定 chrome 要不要让出透明底。 */
        surface: surfaceFor(theme)
      }
    }
  })

  typedMain.handle(routes.themeSet, {
    handler: async (_event, req) => {
      const request = asRecord(req)
      const id = request.id != null ? String(request.id) : ''
      const result = await themeService.setActive(id)
      if (!result.ok) return { ok: false, reason: result.reason || '切换失败' }
      // 显式补一次发布：`setActive` 在"目标与当前相同"时不发 active 事件，
      // 而调用方（主题页点了一下）期望的是"点了就有反馈"。
      await publishNow()
      return { ok: true, id: themeService.getActiveId() }
    }
  })

  typedMain.handle(routes.themeScheduleGet, {
    handler: () => ({ schedule: scheduler && typeof scheduler.schedule === 'function' ? scheduler.schedule() : null })
  })

  typedMain.handle(routes.themeScheduleSet, {
    handler: async (_event, req) => {
      if (!settings || typeof settings.set !== 'function') return { ok: false, reason: '设置服务不可用' }
      const next = asRecord(req).schedule ?? { mode: 'none' }
      await settings.set(THEME_SETTING_KEYS.schedule, next)
      // 立刻按新调度判一次：不让用户等下一个 10 秒 tick。
      if (scheduler && typeof scheduler.refresh === 'function') await scheduler.refresh()
      return { ok: true, schedule: scheduler && typeof scheduler.schedule === 'function' ? scheduler.schedule() : next }
    }
  })

  typedMain.handle(routes.themeRefresh, {
    handler: async () => {
      await themeService.refreshSources()
      await publishNow()
      return { ok: true, ...catalogPayload() }
    }
  })

  // ── 编辑器（用户主题）────────────────────────────────────────────────
  typedMain.handle(routes.themeDraft, {
    handler: (_event, req) => {
      const request = asRecord(req)
      const baseId = request.id ? String(request.id) : ''
      // `asNew` = 「新建主题」：无论起点是不是自建主题，都另起一份 id 为空的草稿
      const draft = themeService.draftTheme(baseId, { asNew: Boolean(request.asNew) })
      return { ok: !!draft, theme: draft ? summarize(draft) : null, draft }
    }
  })

  typedMain.handle(routes.themeSave, {
    handler: async (_event, req) => {
      const result = await themeService.saveUserTheme(asRecord(req).theme ?? {})
      if (!result.ok) return { ok: false, reason: result.reason || '保存失败' }
      const theme = result.theme
      if (!theme) return { ok: false, reason: '保存失败' }
      // 保存的若是当前主题（原地编辑），界面必须立刻跟着变 —— `publish()` 自带
      // 指纹去重，当前主题没被改到时它立即返回，零重绘。
      await publishNow()
      // ⚠ `theme` 给的是**完整归一化定义**（不是摘要）：编辑器要拿它回填表单，
      //   摘要里只有四格配色条，回填后颜色会丢。目录那一份仍是摘要（体积小得多）。
      return { ok: true, id: theme.id, theme, ...catalogPayload() }
    }
  })

  typedMain.handle(routes.themeDelete, {
    handler: async (_event, req) => {
      const request = asRecord(req)
      const id = request.id != null ? String(request.id) : ''
      const result = await themeService.deleteUserTheme(id)
      if (!result.ok) return { ok: false, reason: result.reason || '删除失败' }
      // 删掉的正是当前主题时服务会顺手回落内置主题 → 必须重发一次。
      await publishNow()
      return { ok: true, ...catalogPayload() }
    }
  })

  typedMain.handle(routes.themePreview, {
    handler: (_event, req) => {
      // 草稿预览：只换算，不落盘、不改任何状态（编辑器每动一个滑杆都会调一次，
      // 因此这里必须是纯函数路径 —— 不写设置、不发布、不触发插件插槽）。
      const theme = asRecord(req).theme ?? null
      return {
        ok: true,
        tokens: themeService.tokensFor(theme),
        background: themeService.backgroundFor(theme),
        /**
         * 草稿的窗口材质状态：编辑器据此提示"当前系统不支持、会回退成染色玻璃"。
         * ⚠ `applied` 对草稿恒为假（草稿并没有被应用到窗口上）—— 编辑器**只看 `supported`**，
         *   别拿 `applied` 去判"生效了没有"，那会永远显示没生效。
         */
        surface: surfaceFor(theme)
      }
    }
  })

  /**
   * 「选择背景图片 / 视频」—— 开系统文件对话框，把选中的**媒体**拷进主题资产库。
   *
   * 为什么拷而不存路径：见 theme-assets.js 文件头（挪动/换机会让主题裂掉，
   * 而渲染层也读不到任意本地路径）。回给编辑器的 `key` 就是 `background.path`
   * 要写的值，`mediaKind` 才是 `background.kind` 要写的值（图片 / 视频），
   * `url` 只用于即时预览。
   *
   * 失败一律回 `{ ok:false, reason }` 让编辑器**说出来**：选了文件却没反应，
   * 比"报一句不支持这个格式"难查得多。
   */
  typedMain.handle(routes.themeAssetPick, {
    handler: async (event, req) => {
      const store = ctx.themeAssets
      const importFile = store && store.importFile
      if (!store || typeof importFile !== 'function') return { ok: false, reason: '主题资产库不可用' }
      const { dialog } = require('electron') as typeof import('electron')
      const spec = pickDialogSpec(String(asRecord(req).kind || ''))
      let picked = ''
      try {
        const options: OpenDialogOptions = {
          title: spec.title,
          properties: ['openFile'],
          filters: spec.filters
        }
        const parent = ownerWindow(event)
        const r = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true }
        picked = r.filePaths[0]
      } catch (e) {
        return { ok: false, reason: `打开文件对话框失败：${errorMessage(e)}` }
      }
      return importFile.call(store, picked)
    }
  })

  // ── 私密窗口主题 ─────────────────────────────────────────────────────
  // 只有写口：读走 `theme:list`（载荷里带 privateId），不为一个字段单开一条读口。
  typedMain.handle(routes.themePrivateSet, {
    handler: async (_event, req) => {
      if (!settings || typeof settings.set !== 'function') return { ok: false, reason: '设置服务不可用' }
      const request = asRecord(req)
      const id = request.id != null ? String(request.id) : ''
      // 允许空串（= 与普通窗口相同）与"目录里存在的主题 id"；其余一律拒绝 ——
      // 一个不存在的 id 会在每次开私密窗口时静默回落，用户只会觉得"这个设置没用"。
      if (id && !themeService.get(id)) return { ok: false, reason: '主题不存在' }
      await settings.set(THEME_SETTING_KEYS.privateTheme, id)
      await publishNow()
      return { ok: true, id, ...catalogPayload() }
    }
  })

  // ── 主题包：导出 / 导入（P4）──────────────────────────────────────────
  /**
   * 导出：主题 → zip。
   *
   * 包内三样（见 theme-package.js 的说明）：`theme.json`（我们）+ `vivaldi.json`
   * （同一主题的 Vivaldi 字段名）+ 背景图。于是**同一个文件**既能导回来，
   * 也能丢给 Vivaldi 试 —— 不需要维护两套导出格式。
   *
   * 默认导出的是**当前主题**（`req.id` 缺省时），因为"把我现在用的这套发给别人"
   * 是这条功能最常见的诉求。
   */
  typedMain.handle(routes.themeExport, {
    handler: async (event, req) => {
      const request = asRecord(req)
      const id = request.id ? String(request.id) : themeService.getActiveId()
      const theme = themeService.get(id)
      if (!theme) return { ok: false, reason: '主题不存在' }

      const warnings: string[] = []
      const assets: ThemePackageAsset[] = []
      const bg: ThemeBackgroundSpec = theme.background || {}
      // 「引用本地资产」的背景（图片 / 视频）都把那个文件一起带走 —— 判据取自共享层，
      // 加新的资产型背景种类时不会漏（见 BACKGROUND_ASSET_KINDS）。
      if (typeof bg.kind === 'string' && BACKGROUND_ASSET_KINDS.includes(bg.kind) && bg.path) {
        const isVideo = bg.kind === 'video'
        const what = isVideo ? '视频' : '图片'
        const data = await readThemeAsset(theme, bg.path)
        if (data) assets.push({ name: bg.path, data })
        else warnings.push(theme.pluginId
          ? `背景${what}读不到（插件可能已停用），导出的包里不含它`
          : `背景${what}读不到（资产文件已丢失），导出的包里不含它`)
      }
      if (bg.kind === 'daily' || bg.kind === 'desktop') {
        warnings.push('该背景来自网络 / 系统，导出时只带走配色')
      }

      let buffer: Buffer
      try {
        buffer = packTheme(theme, assets)
      } catch (e) {
        return { ok: false, reason: `打包失败：${errorMessage(e)}` }
      }

      const { dialog } = require('electron') as typeof import('electron')
      let target = ''
      try {
        const options: SaveDialogOptions = {
          title: '导出主题',
          defaultPath: suggestedFileName(theme),
          filters: ZIP_FILTERS
        }
        const parent = ownerWindow(event)
        const r = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        if (r.canceled || !r.filePath) return { ok: false, canceled: true }
        target = r.filePath
      } catch (e) {
        return { ok: false, reason: `打开保存对话框失败：${errorMessage(e)}` }
      }

      try {
        await fsp.writeFile(target, buffer)
      } catch (e) {
        return { ok: false, reason: `写入失败：${errorMessage(e)}` }
      }
      return { ok: true, path: target, bytes: buffer.length, warnings }
    }
  })

  /**
   * 导入：zip → 主题插件。
   *
   * 三步，缺一不可：
   *   ① `unpackTheme` 解析（认三种包：主题插件包 / 我们的 theme.json / Vivaldi 包），
   *      **顺带做路径守卫**（条目名是压缩包内容 = 攻击者可控输入）；
   *   ② `buildImportPackage` 组一个**全新生成的**主题插件目录内容 ——
   *      绝不照抄包里的 manifest（否则第三方包的 `main` / 权限声明会被一起带进来，
   *      而用户预期的只是"换套颜色"）；
   *   ③ 交给**插件体系**安装（`installPluginFromPath` → 安装器 + discover + enable）。
   *
   * 最后再刷一次主题目录：新插件启用后它的 `contributes.themes` 才会进目录，
   * 而"导入完立刻能看到并选中它"正是这条功能的验收点。
   */
  typedMain.handle(routes.themeImport, {
    handler: async (event) => {
      const install = ctx.installPluginFromPath
      if (typeof install !== 'function') return { ok: false, reason: '插件安装服务不可用' }

      const { dialog } = require('electron') as typeof import('electron')
      let source = ''
      try {
        const options: OpenDialogOptions = {
          title: '导入主题包',
          properties: ['openFile'],
          filters: ZIP_FILTERS
        }
        const parent = ownerWindow(event)
        const r = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true }
        source = r.filePaths[0]
      } catch (e) {
        return { ok: false, reason: `打开选择对话框失败：${errorMessage(e)}` }
      }

      let raw: Buffer
      try {
        raw = await fsp.readFile(source)
      } catch (e) {
        return { ok: false, reason: `读取文件失败：${errorMessage(e)}` }
      }

      const parsed = unpackTheme(raw)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }

      const { manifest, files } = buildImportPackage({ theme: parsed.theme, assets: parsed.assets })
      const warnings = [...(parsed.warnings || [])]

      let staging = ''
      try {
        staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'hira-theme-'))
        for (const file of files) {
          // 名字是我们自己生成的，但仍然逐个过一遍"留在 staging 内"——
          // 这条守卫的成本近乎为零，而漏掉它的代价是任意路径写入。
          const target = path.resolve(staging, file.name)
          if (target !== staging && !target.startsWith(staging + path.sep)) {
            return { ok: false, reason: `条目路径非法：${file.name}` }
          }
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.writeFile(target, file.data)
        }
      } catch (e) {
        return { ok: false, reason: `准备安装包失败：${errorMessage(e)}` }
      }

      let installed: ThemePluginInstallResult
      try {
        installed = await install(staging, { source: 'directory' })
      } finally {
        // 临时目录是"我们已经读进内存"的产物，装完/失败都该清掉 ——
        // 留在系统临时目录里只会随每次导入累积。
        try { await fsp.rm(staging, { recursive: true, force: true }) } catch (_) {}
      }

      if (!installed || installed.ok === false) {
        return { ok: false, reason: (installed && installed.reason) || '安装失败' }
      }
      if (Array.isArray(installed.warnings) && installed.warnings.length) warnings.push(...installed.warnings)

      // 插件体系的收尾会广播 plugins:changed，但**主题目录**要自己再对一次账：
      // 插件启停订阅只在 main.js 的组合根上，这里补一次保证"导入完就能选中"。
      try {
        await themeService.refreshSources()
        await publishNow()
      } catch (e) {
        warnings.push(`主题目录刷新失败：${errorMessage(e)}`)
      }

      return {
        ok: true,
        pluginId: installed.id || '',
        themeId: (manifest.contributes.themes[0] || {}).id || installed.id,
        name: manifest.name['zh-CN'],
        warnings
      }
    }
  })
}

