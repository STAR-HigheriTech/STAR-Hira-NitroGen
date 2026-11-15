import type {
  BrowserWindow as BrowserWindowType,
  MessageBoxOptions,
  MessageBoxReturnValue,
  NativeImage,
  WebContents as WebContentsType
} from 'electron'
/**
 * infra-extensions — Chrome 扩展系统核心模块
 *
 * C10: 使用 electron-chrome-extensions@4.9.x 原库 + electron-chrome-web-store 原库
 * CONTRACT-01: A 档 npm 库锁版本不重写
 *
 * 本模块只负责：
 *   1. 创建 ElectronChromeExtensions 实例
 *   2. 安装 electron-chrome-web-store
 *   3. 注册 CRX 协议
 *   4. 管理 tab 生命周期回调（由 app 层注入）
 *   5. 提供扩展 CRUD API
 *
 * 不依赖：
 *   - Hira 的 tabManager / tabsService
 *   - Hira 的 window 管理
 *   - 任何 UI 组件
 *
 * L1 功能映射:
 *   F-0401 安装扩展    F-0402 卸载扩展    F-0403 列出已安装
 *   F-0404 启用/禁用   F-0405 工具栏图标   F-0406 手动导入
 *   F-0407 打开扩展选项页 / 弹出窗口（getOptionsUrl / openPopup，见「打开扩展自身的页面」）
 */

const { app, session, net, dialog, webContents } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const AdmZip = require('adm-zip')
const EventEmitter = require('events')
// chrome.identity：ECE 4.9.x 完全没有这个命名空间（dist 内搜不到），
// 由我们自己的主进程服务 + 会话级 preload 补齐。见 identity.js 文件头。
const { createIdentityService } = require('./identity')
// cosmetic preload 接管：把库那份「每 frame 9KB + DOMContentLoaded 同步全文档扫描」
// 换成 app 层注入的极小版本。见 cosmetic-preload.js 文件头。
const { createCosmeticPreloadSwap } = require('./cosmetic-preload')
// 内容拦截级别的唯一真源（off / ads / ads+tracking）。
// 与 https-only.mjs 同口径：跨 infra / apps / 渲染层共用的纯规则必须下沉 shared-types。
const {
  DEFAULT_ADBLOCKER_LEVEL,
  normalizeAdblockerLevel,
  adblockerLevelFromSettings,
  isAdblockerLevelActive
} = require('@hira-ng/shared-types/src/adblocker.mjs')
// 图片扩展名与 MIME 的唯一真源（见 shared-types/media-extensions.mjs）。
const {
  IMAGE_FILE_EXTENSIONS,
  EXT_MIME_TYPES
} = require('@hira-ng/shared-types/src/media-extensions.mjs')
// 清单里三个声明权限的字段（permissions / optional_permissions / host_permissions）同一真源。
const { MANIFEST_PERMISSION_KEYS } = require('@hira-ng/shared-types/src/permission-labels.mjs')

interface ExtensionActionManifest {
  default_popup?: string
  default_icon?: string | Record<string, string>
  default_title?: string
}

interface ExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  description?: string
  action?: ExtensionActionManifest
  browser_action?: ExtensionActionManifest
  page_action?: ExtensionActionManifest
  icons?: Record<string, string>
  options_ui?: { page?: string; open_in_tab?: boolean }
  options_page?: string
  background?: { service_worker?: string; page?: string; scripts?: string[] }
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  oauth2?: { client_id?: string; scopes?: string[] }
  [key: string]: unknown
}

interface RuntimeExtension {
  id: string
  disabled?: boolean
  path?: string
  name?: string
  version?: string
  iconPath?: string
  manifest?: ExtensionManifest | null
}

interface InstalledExtensionRecord {
  path: string
  enabled: boolean
  pinned: boolean
  order: number
  name: string
  version: string
  description: string
  iconPath: string
  manifest: ExtensionManifest | null
  announced: boolean
}

type ExtensionSnapshot = Omit<InstalledExtensionRecord, 'order' | 'announced'>
type StoredExtension = InstalledExtensionRecord & { id: string }

interface InstallStore {
  load(): void
  file: string
  record(extension: RuntimeExtension, enabled?: boolean): void
  markAnnounced(id: string): void
  setEnabled(id: string, enabled: boolean): void
  setPinned(id: string, pinned: boolean): void
  remove(id: string): void
  list(): StoredExtension[]
  get(id: string): StoredExtension | null
  flush(): Promise<void>
}

interface ExtensionInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  pinned?: boolean
  description?: string
  iconPath?: string
  isUnpacked: boolean
  hasOptionsPage: boolean
  hasPopup: boolean
  optionsUrl: string
  popupUrl: string
  path?: string
  runtimeStatus?: 'disabled' | 'loaded' | 'error' | 'missing'
  loadError?: string
}

interface ExtensionCallbacks {
  createTab(details: Record<string, unknown>): Promise<[WebContentsType, BrowserWindowType]>
  selectTab(webContents: WebContentsType): void
  removeTab(webContents: WebContentsType): void
  createWindow(details: Record<string, unknown>): Promise<BrowserWindowType>
  removeWindow(window: BrowserWindowType): void
  assignTabDetails(tab: WebContentsType, activeTab: WebContentsType): void
}

interface ExtensionServiceOptions {
  profileId?: string
  partition?: string
  session?: import('electron').Session
  callbacks?: ExtensionCallbacks
  extensionsPath?: string
  enableWebStore?: boolean
  autoUpdate?: boolean
  allowUnpacked?: boolean
  enableAdblocker?: boolean
  blockTrackers?: boolean
  extensionPreloadPath?: string
  cosmeticPreloadPath?: string
}

interface ExtensionService {
  [key: string]: unknown
  destroy(): void
}

interface WebStoreInstallDetails {
  id?: string
  localizedName?: string
  manifest?: ExtensionManifest
  icon?: string | NativeImage
  browserWindow?: BrowserWindowType
}

interface RuntimeRegistryEntry {
  id: string
  path: string
  manifest: ExtensionManifest | null
  extension: ExtensionInfo
  enabled: boolean
}

interface LoadFailure {
  message: string
  at: number
}

interface DerivedInfo {
  localeKey?: string
  locales?: Record<string, Record<string, { message?: string }>>
  size?: number | null
}

interface CachedIconData {
  key: string
  dataUrl: string
}

interface PopupSupport {
  track?(popup: unknown): void
  open?(options: Record<string, unknown>): unknown
  close?(): void
}

interface PopupAnchorOptions {
  anchorRect?: { x: number; y: number; width?: number; height?: number } | null
  alignment?: string
  parentWindow?: BrowserWindowType | null
}

interface PopupCreated {
  browserWindow?: BrowserWindowType
  extensionId?: string
}

interface ExtensionDiagnostic {
  code: string
  severity: 'error' | 'warning'
  message: string
}

type AdblockerLevel = 'off' | 'ads' | 'ads+tracking'
type ActiveAdblockerLevel = Exclude<AdblockerLevel, 'off'>

const MAX_CRX_BYTES = 512 * 1024 * 1024
const MAX_CRX_ENTRIES = 20_000
const MAX_CRX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_EXTENSION_ICON_BYTES = 8 * 1024 * 1024
const MAX_EXTENSION_ICON_CACHE_BYTES = 16 * 1024 * 1024
const MAX_EXTENSION_ICON_CACHE_ENTRIES = 128
const MAX_EXTENSION_JSON_BYTES = 4 * 1024 * 1024
const MAX_INSTALL_RECORD_BYTES = 32 * 1024 * 1024

interface AdblockerEngine {
  config?: { enableMutationObserver?: boolean }
  getCosmeticsFilters(options: Record<string, unknown>): unknown
  on(event: string, callback: (request?: Record<string, unknown>) => void): void
  serialize(): Uint8Array
  updateResources(resources: string, checksum: string): void
  enableBlockingInSession(session: import('electron').Session): void
  disableBlockingInSession(session: import('electron').Session): void
}

interface CachedAdblockerEngine {
  buffer: Uint8Array
  ageMs: number
}

interface LifecyclePayload extends Partial<RuntimeExtension> {
  extension?: RuntimeExtension
  type?: string
  message?: string
  enabled?: boolean
  pinned?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从 .crx 容器里切出内嵌的 ZIP 段。
 *
 * 必须先剥壳的原因：.crx 不是 ZIP，而是「Cr24 头 + ZIP」的容器；Electron 的
 * `loadExtension()` 只接受**已解压目录**，Windows 自带的 tar 按 ZIP 识别又要求
 * 文件以 `PK` 开头 —— 两者面对真实 .crx 都必然失败。
 *
 * 格式（Chrome 官方）：
 *   CRX3: `Cr24` + uint32 version=3 + uint32 headerLen + header + ZIP
 *   CRX2: `Cr24` + uint32 version=2 + uint32 pubKeyLen + uint32 sigLen + pubKey + sig + ZIP
 * @param {Buffer} buffer
 * @returns {Buffer} ZIP 段
 */
function extractCrxZip(buffer: Buffer) : Buffer {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'Cr24') {
    throw new Error('不是有效的 CRX 文件（缺少 Cr24 头）')
  }
  const version = buffer.readUInt32LE(4)
  let offset
  if (version === 3) {
    offset = 12 + buffer.readUInt32LE(8)
  } else if (version === 2) {
    offset = 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12)
  } else {
    throw new Error(`不支持的 CRX 版本: ${version}`)
  }
  if (offset <= 0 || offset >= buffer.length) throw new Error('CRX 头部长度异常')
  const zip = buffer.subarray(offset)
  if (zip.toString('latin1', 0, 2) !== 'PK') throw new Error('CRX 内未找到 ZIP 数据')
  return zip
}

// ── 安装记录（启用状态 + 启动恢复）──────────────────────────────────────
/**
 * 安装记录文件名（落在该 profile 的扩展目录下，随 profile 天然隔离）。
 *
 * 为什么必须有它：ECE 的 `extensionsPath` 在本 fork 里**完全未被消费**（库内搜不到
 * 任何读取处），也就是说 ECE 自己不会把磁盘上的扩展加载回来；electron-chrome-web-store
 * 也按 RT 的口径配成 `loadExtensions:false`（见「安装 electron-chrome-web-store」一节：
 * 加载权必须**只**归本处，否则同一扩展会被加载两遍、已停用的扩展也会被它重新拉回来）。
 * 若没有一份自己的安装记录，「启用 / 停用」只在本次运行的内存里有效 —— 重启后扩展全没了，
 * 开关更是无从谈起。这里对齐 RT 的做法（RT 把 {type, disabled, pinned} 存进
 * per-profile DataStore，重启后按 disabled 决定 load / unload），但记录的是
 * **原始目录路径**而不是「拷贝到 profile 目录下的副本」：Chrome 的
 * 「加载已解压的扩展程序」本来就是引用原目录，拷贝会让开发者改一次代码要重装一遍。
 *
 * 记录内容：`{ path, enabled, pinned, order, name, version, description, iconPath, manifest }`。
 * 带上清单快照的原因是**已停用的扩展不进运行时**，管理页仍要能显示它的名称 /
 * 版本 / 权限 / 是否有设置页与弹窗 —— 这些全都从清单派生，没有快照就得再去读盘。
 * `pinned` 是用户对「固定」的意图（对齐 RT 的 per-profile pinned），与运行状态无关：
 * 停用 / 加载失败的扩展同样可以被固定，重启后照旧。
 *
 * `order` 是**列表顺序位**：安装时分配、此后永不改写。它存在的唯一理由是让
 * 「启用 / 停用」与「列表排序」彻底解耦 —— 扩展一旦停用就离开运行时数组，
 * 若顺序靠运行时数组的加载顺序决定，开关一次列表就会跳位（见 listExtensions）。
 * @param {string} extDir
 */
function createInstallStore(extDir: string): InstallStore {
  const file = path.join(extDir, 'installed.json')
  /** @type {{ version: number, extensions: Record<string, InstalledExtensionRecord> }} */
  let state: { version: number; extensions: Record<string, InstalledExtensionRecord> } = {
    version: 2,
    extensions: Object.create(null) as Record<string, InstalledExtensionRecord>
  }
  // 串行化写入：并发 toggle / install 若各自 writeFileSync，后写者会把先写者的
  // 结果整段覆盖（记录是整个对象落盘的）。用一条 promise 链保证写序 = 调用序。
  let writeChain = Promise.resolve()

  /** 下一个顺序位：现有最大值 + 1（只增不改，删掉的扩展不会让别人的位置前移）。 */
  function nextOrder(): number {
    let max = -1
    for (const rec of Object.values(state.extensions)) {
      if (rec && typeof rec.order === 'number' && rec.order > max) max = rec.order
    }
    return max + 1
  }

  /** 记录的顺序位；异常 / 老数据兜底到末尾（绝不让 NaN 把整张列表的排序打乱）。 */
  function orderOf(rec: { order?: unknown } | null | undefined): number {
    return rec && typeof rec.order === 'number' ? rec.order : Number.MAX_SAFE_INTEGER
  }

  function load(): void {
    try {
      const dir = path.dirname(file)
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('installed.json.') && name.endsWith('.tmp')) {
          try { fs.unlinkSync(path.join(dir, name)) } catch (_) {}
        }
      }
    } catch (_) { /* 首次运行 / 目录尚不存在 */ }
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_INSTALL_RECORD_BYTES) throw new Error('installed.json 体积异常')
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (isRecord(parsed) && isRecord(parsed.extensions)) {
        const sanitized = Object.create(null) as Record<string, InstalledExtensionRecord>
        for (const [id, value] of Object.entries(parsed.extensions)) {
          if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype' || !isRecord(value)) continue
          const extra = value as Record<string, unknown>
          sanitized[id] = {
            path: typeof extra.path === 'string' ? extra.path : '',
            enabled: extra.enabled !== false,
            pinned: extra.pinned === true,
            order: typeof extra.order === 'number' && Number.isFinite(extra.order) ? extra.order : -1,
            name: typeof extra.name === 'string' ? extra.name : '',
            version: typeof extra.version === 'string' ? extra.version : '',
            description: typeof extra.description === 'string' ? extra.description : '',
            iconPath: typeof extra.iconPath === 'string' ? extra.iconPath : '',
            manifest: isRecord(extra.manifest) ? extra.manifest as ExtensionManifest : null,
            announced: extra.announced === true
          }
        }
        state = { version: 2, extensions: sanitized }
        // 老记录没有顺序位：按 installed.json 的键序（= 历史安装顺序）补一份，
        // 并与当前展示顺序保持一致。补完即固定，之后开关扩展不再改动它。
        let max = -1
        for (const rec of Object.values(state.extensions)) {
          if (rec && typeof rec.order === 'number' && rec.order > max) max = rec.order
        }
        for (const rec of Object.values(state.extensions)) {
          if (rec && (!Number.isFinite(rec.order) || rec.order < 0)) rec.order = ++max
        }
      }
    } catch (e) {
      // 首次运行没有文件是正常路径；真正存在却解析失败时保留现场，避免静默丢安装列表。
      if (fs.existsSync(file)) {
        const backup = `${file}.corrupt.${Date.now()}`
        try { fs.renameSync(file, backup) } catch (_) {}
        console.warn('[infra-extensions] installed.json 读取失败，已从空记录启动:', errorMessage(e), backup)
      }
    }
  }

  function persist(): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2)
    writeChain = writeChain.catch(() => {}).then(async () => {
      const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        await fs.promises.writeFile(temp, snapshot, 'utf8')
        await fs.promises.rename(temp, file)
      } catch (e) {
        try { await fs.promises.unlink(temp) } catch (_) {}
        console.warn('[infra-extensions] persist install record failed:', errorMessage(e))
      }
    })
    return writeChain
  }

  /** 扩展运行时对象 → 可离线渲染的记录快照。 */
  function snapshotOf(ext: RuntimeExtension | null | undefined): ExtensionSnapshot | null {
    if (!ext || !ext.id) return null
    const manifest = ext.manifest || null
    return {
      path: ext.path || '',
      enabled: !ext.disabled,
      pinned: false,
      name: ext.name || (manifest && manifest.name) || '',
      version: ext.version || (manifest && manifest.version) || '',
      description: (manifest && manifest.description) || '',
      iconPath: ext.iconPath || resolveIconPath(manifest) || '',
      manifest
    }
  }

  return {
    load,
    file,
    /** 记录一次安装 / 重载后的最新快照（enabled / pinned 由调用方指定，未指定则沿用原值）。 */
    record(ext: RuntimeExtension, enabled = true): void {
      const snap = snapshotOf(ext)
      if (!snap) return
      const prev = state.extensions[ext.id]
      state.extensions[ext.id] = {
        ...snap,
        enabled: enabled !== false,
        // 重装 / 重载不该抹掉用户此前固定的意图 —— 只有显式 setPinned 才改它。
        pinned: prev ? prev.pinned === true : false,
        // 顺序位同理：只有首次登记时分配，重装 / 重载 / 启停都保持原位。
        order: prev && typeof prev.order === 'number' ? prev.order : nextOrder(),
        // runtime.onInstalled 是否已成功派发过。老记录没有该字段 = 从未派发，
        // 启动恢复时补一次（把「历史上装了但没装配」的扩展自愈回来）。
        announced: prev ? prev.announced === true : false
      }
      persist()
    },
    /** 标记 runtime.onInstalled 已成功派发（之后只有版本变化才再派发）。 */
    markAnnounced(id: string): void {
      const rec = state.extensions[id]
      if (!rec || rec.announced === true) return
      rec.announced = true
      persist()
    },
    /** 只更新启用位；没有既有记录时不新建（避免出现指向空路径的幽灵条目）。 */
    setEnabled(id: string, enabled: boolean): void {
      const rec = state.extensions[id]
      if (!rec) return
      rec.enabled = enabled !== false
      persist()
    },
    /** 只更新固定位；没有既有记录时不新建（固定的是「已安装的扩展」这一身份）。 */
    setPinned(id: string, pinned: boolean): void {
      const rec = state.extensions[id]
      if (!rec) return
      rec.pinned = pinned === true
      persist()
    },
    remove(id: string): void {
      if (!state.extensions[id]) return
      delete state.extensions[id]
      persist()
    },
    /** 全量记录（含已停用），供启动恢复与管理页补全展示字段；按顺序位升序 = 稳定列表序。 */
    list(): StoredExtension[] {
      return Object.entries(state.extensions)
        .map(([id, rec]) => ({ id, ...rec }))
        .sort((a, b) => orderOf(a) - orderOf(b))
    },
    get(id: string): StoredExtension | null {
      const rec = state.extensions[id]
      return rec ? { id, ...rec } : null
    },
    flush() { return writeChain }
  }
}

/**
 * ECE 回调契约（对齐 @iamevan/electron-chrome-extensions@4.9.4 实际行为）：
 *   - createTab(details) → Promise<[webContents, window]>
 *   - selectTab(webContents) → void
 *   - removeTab(webContents) → void
 *   - createWindow(details) → window
 *   - removeWindow(window) → void
 * @typedef {Object} ExtensionCallbacks
 * @property {(details: Record<string, unknown>) => Promise<[Electron.WebContents, Electron.BrowserWindow]>} createTab
 * @property {(webContents: Electron.WebContents) => void} selectTab
 * @property {(webContents: Electron.WebContents) => void} removeTab
 * @property {(details: Record<string, unknown>) => Electron.BrowserWindow} createWindow
 * @property {(window: Electron.BrowserWindow) => void} removeWindow
 * @property {(tab: Electron.WebContents, activeTab: Electron.WebContents) => void} assignTabDetails
 */



/**
 * @typedef {Object} ExtensionInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {boolean} enabled
 * @property {boolean} [pinned] 用户固定意图（来自安装记录，持久化）
 * @property {string} [description]
 * @property {string} [iconPath]
 * @property {boolean} isUnpacked
 * @property {boolean} hasOptionsPage
 * @property {boolean} hasPopup
 * @property {string} optionsUrl
 * @property {string} popupUrl
 */



// ── 扩展「自身页面」解析（选项页 / 弹出窗口）────────────────────────────
// 为什么读**运行时扩展对象**的 manifest 而不是磁盘上的 manifest.json：
//   ECE 加载扩展时已把清单解析并挂在 `ext.manifest` 上，再读一次磁盘既慢，
//   也可能与运行时不一致（热更/被改过的目录）。老 Hira 之所以读盘，是因为它
//   自己的存储只存了 `{ id, path }`，拿不到运行时对象 —— NG 有 ECE，不必退回去。

/**
 * 扩展的浏览器动作条目：MV3 `action` / MV2 `browser_action`，再兜底 MV2 `page_action`。
 * 三种写法在真实扩展里都存在（老 Hira 的 openExtensionPopup 同时兼容三者）。
 * @param {ExtensionManifest|null|undefined} manifest
 * @returns {ExtensionActionManifest|null}
 */
function browserActionOf(manifest: ExtensionManifest | null | undefined): ExtensionActionManifest | null {
  if (!manifest) return null
  for (const candidate of [manifest.action, manifest.browser_action, manifest.page_action]) {
    if (candidate && typeof candidate === 'object') return candidate
  }
  return null
}

/**
 * 从「图标尺寸表」里挑一档：128 优先，其次数值最大的一档，最后退到任意一项。
 *
 * 尺寸表可能是 `manifest.icons`，也可能是 `default_icon` 的对象写法
 * （`{ "16": "a.png", "32": "b.png" }`）—— 两者语义相同，共用这一个选取规则。
 * @param {unknown} source
 * @returns {string} 相对路径；挑不出返回空串
 */
function pickIconFromSizeMap(source: unknown) : string {
  if (!source) return ''
  // Chrome 允许把 default_icon 直接写成字符串（icons 同理，虽然少见）—— 直接就是路径。
  if (typeof source === 'string') return source.trim()
  if (!isRecord(source)) return ''
  const pick = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')
  const preferred = pick(source['128'])
  if (preferred) return preferred
  const sizes = Object.keys(source)
    .map((key) => Number(key))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => b - a)
  for (const size of sizes) {
    const candidate = pick(source[String(size)])
    if (candidate) return candidate
  }
  for (const value of Object.values(source)) {
    const candidate = pick(value)
    if (candidate) return candidate
  }
  return ''
}

/**
 * 扩展图标相对路径 —— **全系统唯一口径**。
 *
 * 对齐老 Hira 的 `main/extensions/extensionIcons.js`：
 *   1. `manifest.icons` 存在 → 按 128 → 最大档 → 任意项挑一档；
 *   2. 只有 `icons` 完全缺失时才回退 `action / browser_action / page_action`
 *      的 `default_icon`（string 直用；对象当尺寸表）。
 *
 * 为什么必须收口：安装记录快照、列表项、图标协议读取三处曾经的写法各不相同
 * （只认 128/48、或完全不看 default_icon），结果「有的扩展列表里有图、协议却 404」。
 * 现在三处都调用本函数，口径不可能再漂移。
 * @param {ExtensionManifest|null|undefined} manifest
 * @returns {string}
 */
function resolveIconPath(manifest: ExtensionManifest | null | undefined): string {
  if (!manifest) return ''
  const fromIcons = pickIconFromSizeMap(manifest.icons)
  if (fromIcons) return fromIcons
  const action = browserActionOf(manifest)
  return action ? pickIconFromSizeMap(action.default_icon) : ''
}

/**
 * 选项页相对路径。两种清单写法：`options_ui.page`（推荐）优先，其次 `options_page`（MV2）。
 * @param {ExtensionManifest|null|undefined} manifest
 * @returns {string} 无选项页返回空串
 */
function optionsPagePathOf(manifest: ExtensionManifest | null | undefined): string {
  if (!manifest) return ''
  const page = manifest.options_ui && manifest.options_ui.page
  if (typeof page === 'string' && page.trim()) return page.trim()
  const legacy = manifest.options_page
  if (typeof legacy === 'string' && legacy.trim()) return legacy.trim()
  return ''
}

/**
 * 弹出窗口相对路径（`default_popup`）。无弹窗返回空串。
 * @param {ExtensionManifest|null|undefined} manifest
 * @returns {string}
 */
function popupPagePathOf(manifest: ExtensionManifest | null | undefined): string {
  const action = browserActionOf(manifest)
  const popup = action && action.default_popup
  return typeof popup === 'string' && popup.trim() ? popup.trim() : ''
}

/**
 * 相对页 → `chrome-extension://` 绝对地址。
 * 用 URL 解析而不是字符串拼接：清单里既可能写相对路径（`options.html`），
 * 也可能写前导斜杠（`/options.html`）甚至绝对地址，拼接会得到
 * `chrome-extension://<id>//options.html` 这类坏地址。
 * @param {string} extensionId
 * @param {string} relativePath
 * @returns {string} 解析失败返回空串
 */
function extensionPageUrl(extensionId: string, relativePath: string) : string {
  if (!extensionId || !relativePath) return ''
  try {
    const url = new URL(relativePath, `chrome-extension://${extensionId}/`)
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId ? url.href : ''
  } catch (_) {
    return ''
  }
}

/**
 * 解析扩展的「可打开页面」能力（选项页 / 弹出窗口）。
 * @param {RuntimeExtension|null|undefined} ext 运行时扩展对象
 * @returns {{hasOptionsPage: boolean, hasPopup: boolean, optionsUrl: string, popupUrl: string}}
 */
function capabilitiesOf(ext: RuntimeExtension | null | undefined): {hasOptionsPage: boolean, hasPopup: boolean, optionsUrl: string, popupUrl: string} {
  const manifest = ext?.manifest
  const id = ext?.id || ''
  const optionsPath = optionsPagePathOf(manifest)
  const popupPath = popupPagePathOf(manifest)
  const optionsUrl = extensionPageUrl(id, optionsPath)
  const popupUrl = extensionPageUrl(id, popupPath)
  return {
    hasOptionsPage: Boolean(optionsUrl),
    hasPopup: Boolean(popupUrl),
    optionsUrl,
    popupUrl
  }
}

// ── 本地化消息读取（`_locales/<locale>/messages.json`）────────────────────
/**
 * 读取扩展的本地化消息表。
 *
 * 为什么在 infra 而不是 domain：这是**读盘**。域层（@hira-ng/domain-extension）
 * 只负责「消息名提取 / 回退链排布 / 用消息表展开」的纯规则（零 IO 才能零成本单测），
 * 读盘这一步由 infra 做完再把纯数据交出去——分层上也禁止 infra 反向 require domain。
 *
 * 容错语义（对齐 RT modules/extensions/locales.ts 的 hasLocales / getLocaleData /
 * translateString 三层 try/catch）：`_locales` 目录不存在、该语言没有目录、
 * messages.json 读不动或不是合法 JSON —— 一律**跳过这一级**，由调用方继续往下一级
 * 回退；候选语言一个都读不到就返回 `{}`，调用方最终回退清单原文。绝不抛错：
 * 这些内容本就属于「扩展自带、作者可能删掉或写坏」的部分。
 *
 * 不先 readdir 列目录（RT 会列）：候选语言最多四五级，直接按单子去读文件，
 * 读不到就跳过，效果与「先列目录再判断存在」等价，还少一次目录遍历。
 *
 * @param {string} extensionPath
 * @param {string[]} locales 候选语言（调用方已按优先级排好，含 default_locale）
 * @returns {Promise<Record<string, Record<string, { message?: string }>>>}
 */
async function readLocaleMessages(extensionPath: string, locales: string[]) : Promise<Record<string, Record<string, { message?: string }>>> {
  const result: Record<string, Record<string, { message?: string }>> = {}
  if (!extensionPath || !Array.isArray(locales)) return result
  for (const locale of locales) {
    if (typeof locale !== 'string' || !locale) continue
    if (!/^[a-zA-Z0-9_-]+$/.test(locale)) continue
    try {
      const localesRoot = path.resolve(extensionPath, '_locales')
      const file = path.resolve(localesRoot, locale, 'messages.json')
      const relative = path.relative(localesRoot, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const [realRoot, realFile] = await Promise.all([
        fs.promises.realpath(extensionPath),
        fs.promises.realpath(file)
      ])
      const realRelative = path.relative(realRoot, realFile)
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) continue
      const stat = await fs.promises.stat(realFile)
      if (!stat.isFile() || stat.size > MAX_EXTENSION_JSON_BYTES) continue
      const parsed: unknown = JSON.parse(await fs.promises.readFile(realFile, 'utf8'))
      if (isRecord(parsed)) result[locale] = parsed as Record<string, { message?: string }>
    } catch (_) { /* 该语言缺失 / 文件损坏：交给下一级回退，不是错误 */ }
  }
  return result
}

// ── 目录真实占用（递归字节数）──────────────────────────────────────────────
/**
 * 递归统计文件 / 目录的字节数（对齐 RT modules/utils.ts#getActualSize：文件取
 * `size`、目录递归求和、其它类型按 0）。
 *
 * 与 RT 的两处差异，都是为了「绝不抛错 / 不误导」：
 *   · RT 的 `readdir` 没有 try/catch，遇到无权限目录会 reject；这里吞掉并返回已累计部分；
 *   · 顶层取不到 stat（目录不存在 / 无权限）时返回 **null** = 无法测量，而不是 0 ——
 *     「空目录 0 B」与「目录已经没了（例如扩展已停用且原目录被删）」是两回事，
 *     UI 不该把后者显示成 0 B。递归到子项时 null 按 0 计入（那项确实没什么可加的）。
 * @param {string} target
 * @returns {Promise<number|null>}
 */
async function directorySize(target: string) : Promise<number|null> {
  let stat: import('node:fs').Stats
  try { stat = await fs.promises.lstat(target) } catch (_) { return null }
  // 扩展目录里的符号链接可以指向用户磁盘任意位置，也可能互相成环。
  // 体积统计只计算扩展**自身包含**的字节，链接按 0 处理。
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  // 符号链接指向的目标已由 stat 解析；设备 / socket 之类按 0，不展开
  if (!stat.isDirectory()) return 0
  let entries: string[]
  try { entries = await fs.promises.readdir(target) } catch (_) { return 0 }
  let total = 0
  for (const entry of entries) {
    const size = await directorySize(path.join(target, entry))
    if (size !== null) total += size
  }
  return total
}

/**
 * 清单里**安装时即生效**的权限名（`permissions` + `host_permissions`，去重、保持清单顺序）。
 *
 * 刻意不含 `optional_permissions`：那些是运行期按需申请的，摊进安装确认框等于
 * 把一个用户还没做的决定提前算成"这个扩展现在就能做什么"。
 *
 * 为什么只做这一件事：安装确认框要把「这个扩展能做什么」摊开给用户看（对齐 Hira
 * extensionInit.js#getPermissionWarnings / RT 的 Permissions 行），而清单里的权限名
 * 就是最可信的原文。这里**不翻译**（翻译成中文是 domain-extension 的职责，走
 * extension:list 下发给管理页 / 面板）—— infra 不反向依赖 domain，确认框里给原文即可。
 * 取不到（清单缺失 / 字段不是数组）时返回空数组，调用方显示「无」而不是编造。
 * @param {ExtensionManifest|null|undefined} manifest
 * @returns {string[]}
 */
function collectPermissionNames(manifest: ExtensionManifest | null | undefined): string[] {
  if (!manifest) return []
  const names: string[] = []
  // 字段清单取自同一真源，只滤掉"可选"这一类（理由见上面文档）。
  const permissionKeys = MANIFEST_PERMISSION_KEYS as string[]
  for (const key of permissionKeys.filter((candidate) => candidate !== 'optional_permissions')) {
    const list = Array.isArray(manifest[key]) ? manifest[key] : []
    for (const name of list) {
      if (typeof name === 'string' && name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * @param {Object} options
 * @param {string} [options.partition] - session partition, 默认 'persist:webcontent'
 * @param {ExtensionCallbacks} options.callbacks - tab/window 管理回调（app 层注入）
 * @param {string} [options.extensionsPath] - 扩展存储目录
 * @param {boolean} [options.enableWebStore] - 是否启用 Chrome 网上应用店安装链路，默认 true
 *   （开启时装配 `beforeInstall` 中文确认框与 `afterInstall` 落记录 / 起 SW / 广播；见下）
 * @param {boolean} [options.autoUpdate] - 扩展自动更新，默认 true
 * @param {boolean} [options.allowUnpacked] - 允许未打包扩展，默认 true
 * @param {boolean} [options.enableAdblocker] - 启用内容拦截，默认 true
 * @param {boolean} [options.blockTrackers] - 拦截追踪器，默认 true
 * @param {string} [options.extensionPreloadPath] - 扩展会话的会话级 preload 绝对路径。
 *   一份脚本同时承担两件事（均为「扩展页才需要」的能力）：
 *     1. chrome.identity 桥（ECE 4.9.x 无此命名空间，见 identity.js）；
 *     2. chrome://favicon 兼容层（把 `img[src^="chrome://favicon"]` 改写成 hira 协议，
 *        解析规则在 shared-types/favicon-compat.mjs，供应端在 hira 协议）。
 *   为什么由 app 层注入而不是 infra 自己拼：infra 不该认识 `out/` 布局（打包后路径会变），
 *   app 层用 `__dirname` 拼好传进来即可。**仅在确有已启用扩展时才注册**（见下方的
 *   会话级 preload 状态机）—— 没有扩展的用户不该为它付每个 frame 的解析成本。
 *   未传则不注入，identity 主进程服务仍可被诊断调用。
 * @param {string} [options.cosmeticPreloadPath] - 替换广告拦截 cosmetic preload 的绝对路径。
 *   库自带的版本在每个 frame 都要解析 9KB，并在 `DOMContentLoaded` 同步全文档扫描；
 *   这里传入的版本只保留「document-start 发首轮请求」+「空闲时补扫一次」，
 *   见 `apps/app-main/src/main/preload/adblock-cosmetic-preload.js`。
 *   未传 / 接管失败时一律回滚成库的原件（功能优先于体积）。
 * @returns {Promise<ExtensionService>}
 */
async function createExtensionService(options: ExtensionServiceOptions = {}): Promise<ExtensionService> {
  const {
    profileId,
    partition = 'persist:webcontent',
    session: injectedSession,
    callbacks,
    extensionsPath,
    enableWebStore = true,
    autoUpdate = true,
    allowUnpacked = true,
    enableAdblocker = true,
    blockTrackers = true,
    extensionPreloadPath,
    cosmeticPreloadPath
  } = options

  if (!callbacks || typeof callbacks.createTab !== 'function') {
    throw new Error('[infra-extensions] callbacks.createTab is required')
  }

  // 优先使用上层注入的会话（= 该 profile 的 fromPath 会话），
  // 使扩展与标签页**共用同一个 Session 对象** —— 扩展才能真正作用于标签页，
  // 且无需 setSessionPartitionResolver 做二次路由。未注入时回退到 partition。
  const extSession = injectedSession || session.fromPartition(partition)
  const extDir = extensionsPath || path.join(app.getPath('userData'), 'extensions')
  /**
   * 「商店安装 / .crx 导入」的扩展代码目录（`<extDir>/crx`）。
   *
   * 为什么是 extDir 下的一个子树而不是另开一个根目录：扩展只该有一个存储根
   * （`extDir`，安装记录 `installed.json` 也在它下面），crx 与「用户自己指路径的
   * 未打包扩展」在同一个根里各占一个子树 —— 卸载 / 统计 / 备份都只需认这一个根。
   * 布局也对齐 RT（`<profilePath>/Extensions/crx/<id>/<version>_0`），
   * 而 NG 手动导入 .crx 的解压目录本来就在这儿（见 installFromCrx）。
   */
  const crxDir = path.join(extDir, 'crx')

  /**
   * 目标路径是否落在 crx 子树里 —— 卸载时据此决定「要不要连磁盘一起清掉」。
   * 用 path.relative 判包含关系而不是 startsWith 拼字符串：`…/extensions/crx2`
   * 这类同前缀的兄弟目录不该被误判成 crx 子树；`crxDir` 自身也不算（rel === ''）。
   * @param {string} target
   * @returns {boolean}
   */
  function isCrxManagedPath(target: string) : boolean {
    if (!target || typeof target !== 'string') return false
    const rel = path.relative(crxDir, target)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /**
   * 目录段名净化：只留字母数字与 `_-`（点号也去掉，杜绝 `..` 穿越），限长防超长路径。
   * @param {unknown} value
   * @returns {string}
   */
  function sanitizeSegment(value: unknown) : string {
    const cleaned = String(value == null ? '' : value).replace(/[^\w-]/g, '_').slice(0, 120)
    return cleaned || 'extension'
  }

  // 安装记录（启用位 + 启动恢复）—— 与 `extensionsPath` 同目录，随 profile 隔离。
  const installStore = createInstallStore(extDir)
  installStore.load()

  /**
   * 没有安装记录、却出现在运行时的扩展 id → 会话内顺序位（首次出现时分配）。
   *
   * 正常情况下扩展都经本模块 record() 入库、顺序位来自 installed.json；这里只是兜底：
   * 万一有扩展经其它通道直接进了运行时，也要保证它在本次运行内的列表位置不随启停漂移。
   */
  const untrackedOrder = new Map<string, number>()
  let untrackedOrderSeq = 0

  /** 列表排序位：安装记录的顺序位优先，没有记录的用会话内首次出现序兜底。 */
  function listOrderOf(id: string): number {
    const record = installStore.get(id)
    if (record && typeof record.order === 'number') return record.order
    if (!untrackedOrder.has(id)) untrackedOrder.set(id, 1_000_000 + untrackedOrderSeq++)
    return untrackedOrder.get(id) ?? 0
  }

  const events = new EventEmitter()
  function emitEventSafely(type: string, payload: unknown): void {
    try {
      events.emit(type, payload)
    } catch (e) {
      console.warn('[infra-extensions] event listener failed:', type, errorMessage(e))
    }
  }
  const runtimeRegistry = new Map<string, RuntimeRegistryEntry>()
  /**
   * 加载失败注册表：`id → { message, at }`。
   *
   * 启动恢复 / 重试加载失败时写入，成功加载时清除。它是列表项
   * `runtimeStatus: 'error'` 与 `loadError` 的唯一真源 —— 失败的扩展不在运行时、
   * 也不在 runtimeRegistry（那是「已停用」的播种位），不登记就会从列表里**整行蒸发**，
   * 用户根本无从知道扩展坏了、更不知道为什么。
   */
  const loadErrors = new Map<string, LoadFailure>()
  /** 同一扩展的启动恢复 / 按需加载 / 重试共用一个原生 load 调用。 */
  const loadInFlight = new Map<string, Promise<RuntimeExtension>>()
  let destroyed = false
  /**
   * 扩展的「磁盘派生信息」缓存：`id → { localeKey, locales, size }`。
   *
   * 为什么必须有缓存：目录大小是**递归扫盘**、本地化消息是若干次小文件读，而管理页 /
   * 侧栏每次刷新列表都会把每个扩展问一遍 —— 不缓存就退化成「每次刷新把所有扩展目录
   * 重扫一遍」。失效规则见 emitLifecycle：任何一次扩展变更都按 id 作废，覆盖
   * 「重载换了代码目录」「停用 / 卸载后目录不在了」这些会让旧值失真的情况。
   *
   * 注意 `size` 用 `'size' in entry` 判存在（而不是真值判断）：null 是**有效缓存值**
   * （= 目录不存在 / 无权限，无法测量），否则每次问都会重新去 stat 一个不存在的路径。
   */
  const derivedCache = new Map<string, DerivedInfo>()
  const sizeInFlight = new Map<string, { path: string; promise: Promise<number | null> }>()
  const iconInFlight = new Map<string, { key: string; promise: Promise<string> }>()
  /**
   * 扩展图标 data URL 缓存：`id → { key, dataUrl }`，key = `path|version`。
   *
   * 为什么主进程直接给 data URL（对齐参考实现 Hira main/extensions/extensionIcons.js）：
   * 图标最终渲染在 `file://` 的 chrome 页面里，自定义协议子资源在生产环境并不可靠；
   * data URL 是 `<img src>` 天然可用的形式，与协议、会话、CSP 全部解耦。
   * 图标字节很小（一张 128px PNG），内联代价远低于一次「协议 → 端口 → 读盘」往返。
   */
  const iconDataCache = new Map<string, CachedIconData>()
  let iconCacheBytes = 0
  function cacheIconData(extensionId: string, entry: CachedIconData) {
    const previous = iconDataCache.get(extensionId)
    if (previous) iconCacheBytes -= previous.dataUrl.length
    iconDataCache.set(extensionId, entry)
    iconCacheBytes += entry.dataUrl.length
    while (
      iconCacheBytes > MAX_EXTENSION_ICON_CACHE_BYTES ||
      iconDataCache.size > MAX_EXTENSION_ICON_CACHE_ENTRIES
    ) {
      const oldest = iconDataCache.entries().next().value as [string, CachedIconData] | undefined
      if (!oldest) break
      iconDataCache.delete(oldest[0])
      iconCacheBytes -= oldest[1].dataUrl.length
    }
  }
  /** NG 侧「扩展弹窗窗口」的宿主（由 app 层注入，见 setPopupSupport）。 */
  let popupSupport: PopupSupport | null = null

  function emitLifecycle(type: string, extension: LifecyclePayload | RuntimeExtension | null | undefined): void {
    const item: LifecyclePayload = extension || {}
    // 扩展变了 → 该 id 的派生信息作废：重载会换代码目录，停用 / 卸载可能连目录都没了，
    // 继续用旧值会让用户看到过期的大小与名称。
    const changedId = item.id || item.extension?.id || ''
    if (changedId) {
      derivedCache.delete(changedId)
      // 图标同样可能随重载 / 更新变化（换了新图标文件），必须一起失效。
      const cachedIcon = iconDataCache.get(changedId)
      if (cachedIcon) {
        iconDataCache.delete(changedId)
        iconCacheBytes -= cachedIcon.dataUrl.length
      }
    }
    const payload = item.extension
      ? { ...item, type, id: item.id || item.extension?.id || '' }
      : { type, id: item.id || '', extension: item }
    emitEventSafely(type, payload)
  }

  function rememberExtension(ext: RuntimeExtension, enabled = true): void {
    if (!ext || !ext.id) return
    runtimeRegistry.set(ext.id, {
      id: ext.id,
      path: ext.path || runtimeRegistry.get(ext.id)?.path || '',
      manifest: ext.manifest || runtimeRegistry.get(ext.id)?.manifest || null,
      extension: normalizeExtension(ext),
      enabled
    })
  }

  // 完全对齐 Hira extensionInit.js 的构造参数：
  //   - license: 'GPL-3.0'         （@iamevan fork 要求的许可证标识）
  //   - assignTabDetails: true      （boolean，不是 callback）
  //   - extensionsPath + profilePath（扩展存储与 profile 数据目录）
  const { ElectronChromeExtensions, setSessionPartitionResolver } = require('@iamevan/electron-chrome-extensions')

  // setSessionPartitionResolver: 用于多 profile 隔离场景下，
  // 让 ECE 库能根据 webContents 的 partition 路由扩展事件到对应 session。
  // Hira 在 loadExtensionDependencies() 中加载但未显式调用；
  // 这里在创建实例前注册，确保库内部能正确解析 partition。
  if (typeof setSessionPartitionResolver === 'function') {
    try {
      // ECE 4.9.4 的 resolver 入参是 **partition 字符串**（见其 dist/cjs/index.js
      // `resolvePartitionImpl = (partition) => session.fromPartition(partition)`，
      // 调用点 `partition === '_self' ? ... : resolvePartition(partition)`），
      // 不是 webContents —— 曾经按 `webContents.session` 解，永远取到 undefined，
      // 只是碰巧回落到 extSession 才没炸。这里改成显式语义：`_self` / 空 →
      // 当前 profile 的扩展会话；其它 partition 交给 Electron 解析，失败仍回 extSession。
      setSessionPartitionResolver(function (partition: string) {
        try {
          if (!partition || partition === '_self') return extSession
          return session.fromPartition(partition) || extSession
        } catch (_) {
          return extSession
        }
      })
    } catch (e) {
      console.warn('[infra-extensions] setSessionPartitionResolver failed:', errorMessage(e))
    }
  }

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: extSession,
    // assignTabDetails 是**回调**（`(details, tab) => void`，见 fork 的
    // dist/types/browser/impl.d.ts:11），不是开关：fork 内部按
    // `typeof impl.assignTabDetails === 'function'` 判断（其 index.js:955），
    // 传 `true` 等于「没有这个回调」，那一步会被整段跳过。
    // RT 正是用它补 favIconUrl / discarded / autoDiscardable
    // （loaded-profiles-controller/index.ts:127-136），因此这里**透传** app 层注入的回调；
    // 未注入（undefined）时行为与本库默认一致。
    assignTabDetails: callbacks.assignTabDetails,
    createTab: callbacks.createTab,
    selectTab: callbacks.selectTab,
    removeTab: callbacks.removeTab,
    createWindow: callbacks.createWindow,
    removeWindow: callbacks.removeWindow,
    extensionsPath: extDir,
    profilePath: extDir
  })

  // ── 扩展动作动态状态（徽标 / 标题 / 动态弹窗）────────────────────────────
  // ECE 自己维护 browserAction 状态，但默认只推给它的 <browser-action> preload。
  // NG 使用自绘工具栏，必须把同一份状态转成 extension:changed。
  let browserActionUpdateTimer: ReturnType<typeof setTimeout> | null = null
  const browserActionIconCache = new Map<string, CachedIconData>()
  let browserActionIconCacheBytes = 0
  function cacheBrowserActionIcon(extensionId: string, entry: CachedIconData) {
    const previous = browserActionIconCache.get(extensionId)
    if (previous) browserActionIconCacheBytes -= previous.dataUrl.length
    browserActionIconCache.set(extensionId, entry)
    browserActionIconCacheBytes += entry.dataUrl.length
    while (
      browserActionIconCacheBytes > MAX_EXTENSION_ICON_CACHE_BYTES ||
      browserActionIconCache.size > MAX_EXTENSION_ICON_CACHE_ENTRIES
    ) {
      const oldest = browserActionIconCache.entries().next().value as [string, CachedIconData] | undefined
      if (!oldest) break
      browserActionIconCache.delete(oldest[0])
      browserActionIconCacheBytes -= oldest[1].dataUrl.length
    }
  }

  function normalizeBadgeColor(value: unknown): string {
    if (typeof value === 'string') {
      const color = value.trim()
      return /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(color) ? color : ''
    }
    if (!Array.isArray(value) || value.length < 3) return ''
    const [r, g, b, a = 255] = value.map(Number)
    if (![r, g, b, a].every(Number.isFinite)) return ''
    const alpha = Math.max(0, Math.min(255, a)) / 255
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`
  }

  function getBrowserActionStates(tabId?: number): Array<Record<string, unknown>> {
    const actionApi = extensions.api && extensions.api.browserAction
    if (!actionApi || typeof actionApi.getState !== 'function') return []
    let state: unknown
    try { state = actionApi.getState() } catch (_) { return [] }
    const actions = state && typeof state === 'object'
      ? (state as { actions?: unknown }).actions
      : null
    if (!Array.isArray(actions)) return []
    return actions.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const action = value as Record<string, unknown>
      const id = typeof action.id === 'string' ? action.id : ''
      if (!id) return []
      const tabs = action.tabs && typeof action.tabs === 'object'
        ? action.tabs as Record<string, Record<string, unknown>>
        : {}
      const perTab = Number.isFinite(tabId) ? tabs[String(tabId)] || null : null
      const merged = { ...action, ...(perTab || {}) }
      return [{
        id,
        title: typeof merged.title === 'string' ? merged.title : '',
        badgeText: typeof merged.text === 'string' ? merged.text : '',
        badgeColor: normalizeBadgeColor(merged.color),
        popup: typeof merged.popup === 'string' ? extensionPageUrl(id, merged.popup) : null,
        iconModified: Number.isFinite(Number(merged.iconModified)) ? Number(merged.iconModified) : 0
      }]
    })
  }

  async function getBrowserActionIconDataUrl(extensionId: string, tabId?: number): Promise<string> {
    const state = getBrowserActionStates(tabId).find((entry) => entry.id === extensionId)
    const modified = Number(state && state.iconModified)
    if (!state || !Number.isFinite(modified) || modified <= 0) return ''
    const cacheKey = `${tabId == null ? -1 : tabId}|${modified}`
    const cached = browserActionIconCache.get(extensionId)
    if (cached && cached.key === cacheKey) return cached.dataUrl
    try {
      const actionApi = extensions.api && extensions.api.browserAction
      if (!actionApi || typeof actionApi.handleCRXRequest !== 'function') return ''
      const iconUrl = `crx://extension-icon/${encodeURIComponent(extensionId)}/32/1?tabId=${tabId == null ? -1 : tabId}`
      const response = await actionApi.handleCRXRequest({ url: iconUrl })
      if (!response || response.status !== 200) return ''
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_EXTENSION_ICON_BYTES) return ''
      const contentType = response.headers?.get?.('Content-Type') || 'image/png'
      const dataUrl = `data:${contentType};base64,${bytes.toString('base64')}`
      if (!destroyed) cacheBrowserActionIcon(extensionId, { key: cacheKey, dataUrl })
      return dataUrl
    } catch (_) {
      return ''
    }
  }

  function scheduleBrowserActionUpdate(): void {
    if (browserActionUpdateTimer || destroyed) return
    browserActionUpdateTimer = setTimeout(() => {
      browserActionUpdateTimer = null
      if (destroyed) return
      emitEventSafely('action-updated', {
        type: 'action-updated',
        id: '*'
      })
    }, 16)
    browserActionUpdateTimer.unref?.()
  }

  try {
    const actionApi = extensions.api && extensions.api.browserAction
    if (actionApi && typeof actionApi.onUpdate === 'function') {
      const originalOnUpdate = actionApi.onUpdate.bind(actionApi)
      actionApi.onUpdate = (...args: unknown[]) => {
        const result = originalOnUpdate(...args)
        scheduleBrowserActionUpdate()
        return result
      }
    }
  } catch (e) {
    console.warn('[infra-extensions] browser action observer hook failed:', errorMessage(e))
  }

  // ── chrome.identity（ECE 无此能力，见 identity.js）────────────────────
  /**
   * 清单的唯一取数口：运行时优先，停用 / 加载失败的扩展回退安装记录快照。
   * `getAuthToken` 只需要 `manifest.oauth2`，与扩展当前是否运行无关 ——
   * 用户可以先禁用扩展、再由扩展页 / 诊断触发一次授权。
   * @param {string} extensionId
   * @returns {ExtensionManifest|null}
   */
  function getManifest(extensionId: string): ExtensionManifest | null {
    if (!extensionId) return null
    try {
      const ext = extSession.extensions && extSession.extensions.getExtension(extensionId)
      if (ext && ext.manifest) return ext.manifest
    } catch (_) { /* 未加载 / session 不支持：走记录 */ }
    const record = installStore.get(extensionId)
    return record && record.manifest ? record.manifest : null
  }

  const identity = createIdentityService({ session: extSession, getManifest })

  // ── 会话级 preload 状态机（有扩展才付税）──────────────────────────────
  /**
   * 为什么需要状态机：`registerPreloadScript({ type: 'frame' })` 是**每个 frame
   * （含所有 iframe）的固定税** —— 注册了就必然解析、执行，与「用户到底装没装扩展」
   * 毫无关系。参与的四份脚本合计 ≈52.7KB/frame，零扩展用户全在为空转。
   *
   * 参与的两组：
   *   · ECE 自己的两份（`crx-mv2-preload` frame / `crx-mv3-preload` service-worker）：
   *     库在构造函数里**无条件**注册（dist/cjs/index.js:3180 `this.prependPreload(...)`），
   *     且 `resolvePreloadPath` 在 require 成功时忽略 modulePath —— 换不了路径，
   *     只能构造后从 `session.getPreloadScripts()` 捕获真实 filePath 再自行注销 /
   *     按需按原 id、原类型重注册（`setPreloads` 已弃用）。
   *   · hira 自己的一份 `extension-preload.js`（identity 桥 + chrome://favicon 兼容层，
   *     已合并为同一份；路径由 app 层注入），frame 与 service-worker 各注册一次。
   *
   * 时序约束（踩了会静默坏扩展）：凡是要 `loadExtension` 的路径，都必须在调用**之前**
   * 挂好 —— background page / service worker 本身就是普通 frame，没挂就没有 `chrome.*`。
   * 见各调用点前置的 attachExtensionPreloads()。
   */
  const ECE_PRELOAD_IDS = ['crx-mv2-preload', 'crx-mv3-preload'] as const
  const HIRA_PRELOAD_IDS = ['hira-extension-frame', 'hira-extension-service-worker']
  /** ECE 原始 preload：`id → { type, filePath }`（构造后立即捕获）。 */
  const ecePreloadScripts = new Map<string, { type: 'frame' | 'service-worker'; filePath?: string }>()
  /** 幂等闸门：已挂 / 已摘，避免重复 register 抛「already registered」。 */
  let extensionPreloadsAttached = false

  /**
   * 去掉 ECE preload 里的调试输出。
   *
   * 三处 `if (true) { console.log(...) }` 让**每一次** chrome API 调用都要组装一遍
   * 日志参数（rest 数组 + 字符串格式化），隔离世界扫描还有 3 条每 frame 必打的
   * module 级日志。它们对用户没有价值，却摊在每张网页上。
   *
   * 只做两件**语法安全**的变换，绝不改写逻辑：
   *   1. `if (true) {` → `if (0) {`（调试块整段失活，结构原样保留）
   *   2. 删掉 module 级的三行 `console.log("isolated worlds"/"injecting ...")`
   * 变换后用 vm.Script **只编译不执行**做语法校验；任何一步不合预期就返回 ''（= 用原文件）。
   * 宁可多花那点日志开销，也不能让扩展加载不起来。
   * @param {string} source
   * @returns {string} 清洗后的源码；'' = 不做这层优化
   */
  function sanitizeEcePreload(source: string) : string {
    const original = String(source || '')
    if (!original.includes('if (true) {')) return ''
    const next = original
      .replace(/if \(true\) \{/g, 'if (0) {')
      .split('\n')
      .filter((line) => {
        const text = line.trim()
        return !text.startsWith('console.log("isolated worlds"') &&
          !text.startsWith('console.log("injecting into isolated world')
      })
      .join('\n')
    if (!next.includes('if (0) {')) return ''
    try {
      new vm.Script(next, { filename: 'ece-preload.sanitized.js' })
    } catch (_) {
      return ''
    }
    return next
  }

  const ECE_PRELOAD_CACHE_DIR = path.join(app.getPath('userData'), 'ece-preload')

  /**
   * 生成清洗后的 ECE preload 副本，返回应当注册的 filePath。
   * 按内容 sha1 前 16 位命名：上游升级（内容变）自然换文件，旧副本在下次写入时清掉。
   * 失败一律回退原路径 —— 这层只是省日志开销，不许影响扩展能否加载。
   * @param {string} filePath
   * @returns {string}
   */
  function prepareEcePreloadFile(filePath: string) : string {
    try {
      if (!filePath || typeof filePath !== 'string') return filePath
      const sanitized = sanitizeEcePreload(fs.readFileSync(filePath, 'utf8'))
      if (!sanitized) return filePath
      const name = `${crypto.createHash('sha1').update(sanitized).digest('hex').slice(0, 16)}.js`
      const target = path.join(ECE_PRELOAD_CACHE_DIR, name)
      if (!fs.existsSync(target)) {
        fs.mkdirSync(ECE_PRELOAD_CACHE_DIR, { recursive: true })
        fs.writeFileSync(target, sanitized)
      }
      // 清掉不再被引用的旧副本（只保留当前这一代内容；仍被引用的那份不删）。
      try {
        const keep = new Set([name])
        for (const entry of ecePreloadScripts.values()) {
          if (entry && entry.filePath) keep.add(path.basename(entry.filePath))
        }
        for (const existing of fs.readdirSync(ECE_PRELOAD_CACHE_DIR)) {
          if (existing.endsWith('.js') && !keep.has(existing)) {
            try { fs.unlinkSync(path.join(ECE_PRELOAD_CACHE_DIR, existing)) } catch (_) {}
          }
        }
      } catch (_) {}
      return target
    } catch (e) {
      console.warn('[infra-extensions] ECE preload sanitize skipped:', errorMessage(e))
      return filePath
    }
  }

  /** ECE 两份 preload 的注册类型（库构造期就是这么注册的，见状态机头注释）。 */
  const ECE_PRELOAD_TYPES = { 'crx-mv2-preload': 'frame', 'crx-mv3-preload': 'service-worker' } as const

  /**
   * ECE preload 的**真实**文件路径。
   *
   * 为什么不采用库自己算的路径：`resolvePreloadPath()`（dist/cjs/index.js:3098）先
   * `createRequire(__dirname).resolve('electron-chrome-extensions/preload')` —— 少了
   * 作用域前缀，只有当 node_modules 里**恰好**还躺着一个顶层同名包时才成立；解析失败时
   * 它兜底到 `join(__dirname, 'chrome-extension-api.preload.js')`，比真实位置（上一级
   * `dist/`）多了一层 `cjs`，指向一个根本不存在的文件。打包后 asar 里没有那个顶层同名包
   * → 必然落到错误兜底 → preload 从未被加载 → 扩展「装得上、图标也在，但完全没反应」
   * （`chrome.*` 根本没注入，content script 与 background 全成孤儿）。
   *
   * 这里按**带作用域的真实包名**解析，源码运行与打包运行都指向存在的文件。
   * @returns {string} 绝对路径；解析不到返回 ''
   */
  function resolveEcePreloadPath() : string {
    const resolvers = [
      () => require.resolve('@iamevan/electron-chrome-extensions/preload'),
      () => path.join(path.dirname(require.resolve('@iamevan/electron-chrome-extensions')), '..', 'chrome-extension-api.preload.js')
    ]
    for (const resolveTarget of resolvers) {
      try {
        const filePath = resolveTarget()
        if (filePath && fs.existsSync(filePath)) return filePath
      } catch (_) { /* 换下一条解析方式 */ }
    }
    return ''
  }

  /**
   * 捕获 ECE 在构造函数里注册的那两份 preload，并统一换成我们解析出的真实路径。
   *
   * 不能沿用库注册的 filePath：那个路径本身可能就是错的（见 resolveEcePreloadPath），
   * 照着它重注册等于把「本来就没生效」的注册再抄一遍。id / 类型是固定的，所以即使
   * `getPreloadScripts()` 读不到（库那次注册整个失败，打包态就是），也照样能补挂。
   */
  function captureEcePreloadScripts() {
    const filePath = prepareEcePreloadFile(resolveEcePreloadPath())
    if (!filePath) {
      // 连文件都找不到：保留库自己的注册（说不定它的路径碰巧可用），绝不注销。
      console.error('[infra-extensions] ECE preload file not found; extensions will not work')
      ecePreloadScripts.clear()
      return
    }
    let captured: Array<{ id?: string; type?: 'frame' | 'service-worker' }> = []
    if (typeof extSession.getPreloadScripts === 'function') {
      try { captured = extSession.getPreloadScripts() || [] } catch (e) {
        console.warn('[infra-extensions] capture ECE preload scripts failed:', errorMessage(e))
      }
    }
    for (const script of captured) {
      const id = script?.id
      if (!id || !ECE_PRELOAD_IDS.includes(id as (typeof ECE_PRELOAD_IDS)[number])) continue
      ecePreloadScripts.set(id, { type: script.type || ECE_PRELOAD_TYPES[id as keyof typeof ECE_PRELOAD_TYPES] })
    }
    for (const id of ECE_PRELOAD_IDS) {
      const prev = ecePreloadScripts.get(id)
      ecePreloadScripts.set(id, { type: (prev && prev.type) || ECE_PRELOAD_TYPES[id], filePath })
    }
  }

  function registerEcePreloads() {
    const present = registeredPreloadIds()
    for (const [id, script] of ecePreloadScripts) {
      if (present && present.has(id)) continue
      try {
        extSession.registerPreloadScript({ id, type: script.type, filePath: script.filePath })
      } catch (e) {
        console.warn(`[infra-extensions] register ECE preload (${id}) failed:`, errorMessage(e))
      }
    }
  }

  function unregisterEcePreloads() {
    for (const id of ecePreloadScripts.keys()) {
      try { extSession.unregisterPreloadScript(id) } catch (_) {}
    }
  }

  function registerHiraPreloads() {
    if (!extensionPreloadPath) return
    const present = registeredPreloadIds()
    for (const [id, type] of [
      [HIRA_PRELOAD_IDS[0], 'frame'],
      [HIRA_PRELOAD_IDS[1], 'service-worker']
    ]) {
      if (present && present.has(id)) continue
      try {
        extSession.registerPreloadScript({ id, type, filePath: extensionPreloadPath })
      } catch (e) {
        console.warn(`[infra-extensions] register extension preload (${type}) failed:`, errorMessage(e))
      }
    }
  }

  function unregisterHiraPreloads() {
    for (const id of HIRA_PRELOAD_IDS) {
      try { extSession.unregisterPreloadScript(id) } catch (_) {}
    }
  }

  /**
   * 安装记录里是否存在「应当进运行时」的扩展（启用位未置 false 且有路径）。
   * 用记录而不是 `session.extensions.getAllExtensions()`：要覆盖「记录里有、但
   * restore() 还没跑完」的窗口期（attach 必须早于任何 loadExtension）。
   * 读取异常时保守返回 true —— 挂上最多是多花解析开销，漏挂则是扩展直接坏掉。
   * @returns {boolean}
   */
  function hasEnabledExtensionRecord() : boolean {
    try {
      return installStore.list().some((rec) => rec && rec.path && rec.enabled !== false)
    } catch (_) {
      return true
    }
  }

  /**
   * 会话里当前真正注册着的 preload id。
   * 读不到 → null（跳过校验：宁可少校验一次，也不能因为拿不到列表就把闸门永远关着）。
   * @returns {Set<string>|null}
   */
  function registeredPreloadIds() : Set<string>|null {
    if (typeof extSession.getPreloadScripts !== 'function') return null
    try {
      const ids = new Set<string>()
      for (const script of extSession.getPreloadScripts()) {
        if (script && script.id) ids.add(script.id)
      }
      return ids
    } catch (_) {
      return null
    }
  }

  /**
   * 挂载：先 ECE（建 `chrome.*`），再 hira（identity / favicon 要在其后）。幂等。
   *
   * ⚠️ 闸门**必须按注册结果置位**，不能先置再注册：registerPreloadScript 一旦抛错
   * （会话正在销毁 / id 冲突 / 路径暂缺），先置位就等于「本会话永不重试」，
   * 之后每一次导入都会「扩展加载成功、却没有 chrome.*」——看起来就是装了不工作。
   * 这里注册完回读一次真实列表：必需的那几份不全就保持 false，
   * 让下一次 syncExtensionPreloads()（install / toggle / restore 都会调）自愈。
   */
  function attachExtensionPreloads() {
    if (extensionPreloadsAttached) return
    registerEcePreloads()
    registerHiraPreloads()
    const ids = registeredPreloadIds()
    if (!ids) {
      extensionPreloadsAttached = true
      return
    }
    // 只有「我们确实握着定义」的那几份才算必需：
    //   · ECE 两份若被成功捕获，就必定要重注册回来（已被 unregister 掉）；
    //   · hira 两份只在注入了 extensionPreloadPath 时才存在。
    const required = [...ecePreloadScripts.keys()]
    if (extensionPreloadPath) required.push(...HIRA_PRELOAD_IDS)
    extensionPreloadsAttached = required.every((id) => ids.has(id))
    if (!extensionPreloadsAttached) {
      console.error(
        '[infra-extensions] preload attach incomplete, will retry on next sync:',
        required.filter((id) => !ids.has(id)).join(', ')
      )
    }
  }

  /** 摘除：与挂载顺序相反（先摘依赖方，再摘被依赖方）。幂等。 */
  function detachExtensionPreloads() {
    if (!extensionPreloadsAttached) return
    extensionPreloadsAttached = false
    unregisterHiraPreloads()
    unregisterEcePreloads()
  }

  /** 按安装记录把挂载状态对齐到「现在到底有没有扩展」。 */
  function syncExtensionPreloads() {
    if (hasEnabledExtensionRecord()) attachExtensionPreloads()
    else detachExtensionPreloads()
  }

  // 启动序列：构造 ECE（它在构造函数里注册了 preload）→ 捕获真实路径 → 立即注销。
  // 此刻还没有任何 frame，注销零影响；随后只按安装记录决定要不要挂回去。
  captureEcePreloadScripts()
  if (ecePreloadScripts.size > 0) unregisterEcePreloads()
  if (hasEnabledExtensionRecord()) attachExtensionPreloads()

  // ── 2. 注册 CRX 协议 ────────────────────────────────
  // 对齐 Hira：在 defaultSession 和 extSession 均注册
  try { ElectronChromeExtensions.handleCRXProtocol(session.defaultSession) } catch (e) {}
  ElectronChromeExtensions.handleCRXProtocol(extSession)

  // ── 3. 安装 electron-chrome-web-store ───────────────
  // 配置口径逐项对齐 RT loaded-profiles-controller#installChromeWebStore（:228-355），
  // 每一项都有理由，别改：
  //   · extensionsPath = crxDir（`<extDir>/crx`）—— 与安装记录**同一个扩展根目录**，
  //     不另开第二个目录。库会把扩展解到 `<crxDir>/<id>/<version>_0`，卸载时按同一
  //     路径清理（见 uninstall），三处（安装 / 记录 / 卸载）认的是同一个路径。
  //   · loadExtensions: false —— **必须**。为 true 时库会在启动路径上把 extensionsPath
  //     下所有扩展 load 一遍，而 NG 的 restore() 已经按安装记录加载过一遍：两者同时跑
  //     就是同一扩展被加载两次（ECE 抛重复加载），而且**已停用**的扩展会被库重新拉回
  //     运行时（停用形同虚设）。关掉后「加载权」只归 restore()。
  //   · minimumManifestVersion 不传 —— 库默认 3（仅 MV3）。RT 只有在设置项
  //     enableMv2Extensions 打开时才降到 2；NG 没有这个设置项，就按 RT 的**默认口径**
  //     实现，不为此自创设置项。
  //   · allowUnpackedExtensions 只在 loadExtensions 为 true 时才被消费（库内
  //     loadAllExtensions 的入参），这里是 false，因此它不参与决策；仍原样透传，
  //     以便将来把 loadExtensions 打开时语义不丢。
  if (enableWebStore) {
    const { installChromeWebStore, ExtensionInstallStatus } = require('@iamevan/electron-chrome-web-store')
    /**
     * Web Store 预加载脚本所属的包根（库的 `modulePath` 选项）。
     *
     * 为什么非给不可：库内部用 `createRequire(__dirname).resolve('electron-chrome-web-store/preload')`
     * 定位 preload —— 那是**未加 scope 的包名**，而本工程装的 fork 叫
     * `@iamevan/electron-chrome-web-store`，解析必然失败；失败后它回退到
     * `dist/cjs/browser/chrome-web-store.preload.js`，那个文件**并不存在**
     * （真实位置是 `dist/chrome-web-store.preload.js`）。结果就是：preload 没注入
     * → 商店页里的 `chrome.webstorePrivate` 是 undefined → 「添加至 Chrome」点了没反应。
     * 这里按库的 modulePath 约定把包根显式指过去，安装按钮才真的能兑现。
     * 解析不到（包缺失 / 打包裁剪）时留空 —— 退回库自身行为，绝不因此让扩展系统起不来。
     * @type {string|undefined}
     */
    let webStoreModulePath: string|undefined
    try {
      const preloadFile = require.resolve('@iamevan/electron-chrome-web-store/preload')
      const candidate = path.resolve(path.dirname(preloadFile), '..')
      if (fs.existsSync(path.join(candidate, 'dist', 'chrome-web-store.preload.js'))) {
        webStoreModulePath = candidate
      } else {
        console.warn('[infra-extensions] web store preload not found at expected dist path:', candidate)
      }
    } catch (e) {
      console.warn('[infra-extensions] web store preload path unresolved:', errorMessage(e))
    }

    try {
      await installChromeWebStore({
        session: extSession,
        extensionsPath: crxDir,
        modulePath: webStoreModulePath,
        autoUpdate,
        loadExtensions: false,
        allowUnpackedExtensions: allowUnpacked,
        /**
         * 商店页里的「启用 / 停用」开关（`chrome.management.setEnabled`）→ NG 自己的 toggle。
         *
         * 对齐 RT loaded-profiles-controller/index.ts:289-291 的 `setExtensionEnabled`。
         * 走同一个 toggle 的理由：停用 = 从运行时卸载 + 落记录（见 toggle 的注释），
         * 商店页的开关与 NG 管理页的开关必须是**同一个副作用**，否则两边状态会各自漂移。
         * 库把这个回调原样 await（其 index.js:1409-1414），失败会冒回商店页——因此
         * toggle 内部已经把异常收敛成 false，这里不再抛。
         */
        setExtensionEnabled: async (extensionId: string, _details: unknown, enabled: boolean) => {
          await toggle(extensionId, enabled)
        },
        /**
         * 商店页问「这个扩展现在是什么状态」。
         *
         * 对齐 RT loaded-profiles-controller/index.ts:292-299。**只有一种状态是默认实现
         * 答不出来的**：装了但被用户停用的扩展 —— NG 的「停用」是 removeExtension（它
         * 不在运行时），于是库的默认实现（查 `session.extensions`）找不到它 → 报
         * INSTALLABLE → 商店页显示「添加至 Chrome」，用户一点就重复安装一遍。
         * 所以这里只补这一种：有安装记录且 enabled === false → DISABLED。
         * 其余（已启用 / 未安装 / 受策略限制）一律返回 undefined，交回库的默认实现。
         */
        getExtensionInstallStatus: (extensionId: string) => {
          const record = installStore.get(extensionId)
          if (record && record.enabled === false) return ExtensionInstallStatus.DISABLED
          return undefined
        },
        /**
         * 装之前先问用户（对齐 RT：原生 dialog，**异步**）。
         *
         * 为什么用 `dialog.showMessageBox` 而不是同步版：它在 CRX 下载流程的回调里被
         * await，同步版会把主进程事件循环整个卡住（窗口无响应、右键菜单那类嵌套消息循环
         * 风险同源）。异步版只挂一个 promise，主进程照常跑。
         *
         * 拿不到发起窗口时**退成无父窗口的对话框**（RT 在这时直接 deny）：
         * 少一层任务模态 ≠ 静默中断安装；用户仍然是被问过的，只是没归属到某个窗口。
         * 任何异常一律 deny（fail-closed）—— 宁可这次装不上，也不能绕过确认直接装。
         */
        beforeInstall: async (details: WebStoreInstallDetails) => {
          try {
            const manifest = (details && details.manifest) || {}
            const name = (details && details.localizedName) || manifest.name || '未知扩展'
            const permissions = collectPermissionNames(manifest)
            const lines: string[] = []
            if (details && details.id) lines.push(`扩展 ID：${details.id}`)
            if (manifest.version) lines.push(`版本：${manifest.version}`)
            if (manifest.description) lines.push(`说明：${manifest.description}`)
            lines.push(`权限：${permissions.length ? permissions.join('、') : '无'}`)
            const options: MessageBoxOptions & { icon?: string | NativeImage } = {
              type: permissions.length ? 'question' : 'info',
              title: 'Hira 扩展安装确认',
              message: `是否添加扩展“${name}”？`,
              detail: lines.join('\n'),
              buttons: ['取消', '添加扩展'],
              // 不设 defaultId：Windows / macOS 的默认按钮因此是「取消」（对齐 RT 与老 Hira，
              // 它们也都不设）。扩展会改浏览器行为，回车默认装上去不合适。
              cancelId: 0,
              noLink: true
            }
            if (details && details.icon) options.icon = details.icon
            const parent = details && details.browserWindow
            const usableParent = parent && !(typeof parent.isDestroyed === 'function' && parent.isDestroyed())
            const result: MessageBoxReturnValue = usableParent
              ? await dialog.showMessageBox(parent, options)
              : await dialog.showMessageBox(options)
            // 放行即意味着库马上要 loadExtension：preload 必须在那之前挂好（见状态机头注释）。
            if (result && result.response === 1) attachExtensionPreloads()
            return { action: result && result.response === 1 ? 'allow' : 'deny' }
          } catch (e) {
            console.warn('[infra-extensions] beforeInstall failed, denying:', errorMessage(e))
            return { action: 'deny' }
          }
        },
        /**
         * 装完之后必须**落进 NG 自己的安装记录**并把 MV3 的 service worker 拉起来。
         *
         * 库只做了「下载 + loadExtension」，它不知道 NG 的启用位与启动恢复机制：
         * 不落记录 → 重启后 restore() 看不到这个扩展 → 「装了、能用，一重启就没了」
         * （上一轮刚修掉的那类问题会原样回来）。与 installFromPath 用的是**同一份**
         * installStore，不另建记录（否则又会出现两个真源）。
         *
         * ⚠️ 库**不 await** 这个回调（`state.afterInstall({...})`，见其 index.js:1282），
         * 所以这里必须自己兜住所有异常：抛出去就是未处理的 rejection，主进程会弹
         * 「A JavaScript error occurred」并把用户已有的窗口打断。
         */
        afterInstall: (details: WebStoreInstallDetails) => {
          Promise.resolve()
            .then(() => {
              const ext = extSession.extensions.getExtension(details.id)
              if (!ext) {
                const id = String(details && details.id || '')
                const message = '商店报告安装完成，但扩展未进入运行时'
                if (id) {
                  loadErrors.set(id, { message, at: Date.now() })
                  emitLifecycle('load-failed', { id, message })
                }
                console.warn('[infra-extensions] afterInstall: extension missing in session:', id)
                return
              }
              // 与手动导入共用**同一套装配**（settleLoadedExtension）：落记录、广播、起 SW、
              // 派发 runtime.onInstalled 全在一处，两条安装路径不会再各自漂移。
              // 刻意先发事件再后台起 SW：SW 最坏要等满 10s 超时，不能拖住列表刷新。
              emitLifecycle('installed', settleLoadedExtension(ext, { dispatch: 'install' }))
            })
            .catch((e) => {
              const id = String(details && details.id || '')
              const message = errorMessage(e) || '商店扩展装配失败'
              if (id) {
                loadErrors.set(id, { message, at: Date.now() })
                emitLifecycle('load-failed', { id, message })
              }
              console.warn(
                '[infra-extensions] afterInstall handling failed:',
                id, message
              )
            })
        }
      })
    } catch (e) {
      // 商店装不上（库缺失 / 预加载注册失败 / 网络环境）不能让整个扩展系统废掉：
      // 手动导入（installFromPath / installFromCrx）与已有扩展照常可用。
      console.error('[infra-extensions] installChromeWebStore failed:', errorMessage(e))
    }
  }

  // ── 4. 内容拦截 (adblocker-electron) ─────────────────
  /**
   * 拦截级别（唯一真源：`packages/shared-types/src/adblocker.mjs`）：
   *   off           不拦截
   *   ads           只装广告预置列表（`fromPrebuiltAdsOnly`）
   *   ads+tracking  广告 + 追踪预置列表（`fromPrebuiltAdsAndTracking`，**广告列表的超集**）
   *
   * 为什么是级别而不是两个布尔：库里没有「只拦追踪」的预置列表，两把设置开关
   * 必须收敛成一个有序级别；热切换时按级别**重建** blocker（列表内容不同，不能原地换）。
   */
  let blocker: AdblockerEngine | null = null
  /** blocker **实际装载**的列表级别：null = 尚未就绪。 */
  let blockerLevel: ActiveAdblockerLevel | null = null
  let adblockerEnabled = false
  let blockedCount = 0
  /**
   * **目标状态**：用户/设置希望 blocker 处于的级别。
   * 与 `adblockerEnabled`（**已生效**状态）分开的原因：blocker 就绪是异步的
   * （过滤列表要从远端下载）。若只用一个布尔，用户在列表还没下完时点盾牌按钮，
   * 这次意图会被永久丢弃 —— 于是出现「点了没反应，重启后又是同一幕」。
   * 拆成两个状态后，就绪时会自动把实际状态对齐到用户意图。
   */
  let adblockerLevel: AdblockerLevel = enableAdblocker === false
    ? 'off'
    : adblockerLevelFromSettings(true, blockTrackers)
  /** 关闭前最后一次的开启级别：盾牌重新打开时回到它，而不是硬编码全量。 */
  let adblockerLastActiveLevel = isAdblockerLevelActive(adblockerLevel)
    ? adblockerLevel
    : DEFAULT_ADBLOCKER_LEVEL
  /** blocker 就绪后的通知（IPC/UI 据此刷新盾牌状态）。 */
  let adblockerReadyPromise: Promise<void> | null = null
  /** 串行链：级别切换 / 重建 / 挂载必须按调用序执行，避免新旧 blocker 争用同一 session。 */
  let adblockerChain = Promise.resolve()

  /**
   * 正在后台刷新的级别：`null` = 没有刷新在跑。
   * 用途：同一级别只允许一条刷新任务（多次 apply 不重复下载），且刷新失败后保留旧引擎。
   */
  let engineRefreshLevel: ActiveAdblockerLevel | null = null

  /** 任务串行化：失败只记日志，绝不让它变成未处理的 rejection。 */
  function queueAdblockerTask(task: () => unknown | Promise<unknown>): Promise<void> {
    adblockerChain = adblockerChain
      .then(async () => { await task() })
      .catch((e) => {
        console.error('[infra-extensions] adblocker task failed:', errorMessage(e))
      })
    return adblockerChain
  }

  /**
   * cosmetic preload 接管（只在本进程内生效）。
   * 与 `blocker` 的 enable/disable 严格成对：enable 之后 takeOver、disable 之后 release。
   * 不传 `cosmeticPreloadPath` 时是个空壳，所有方法立即返回 —— 上层无需分支判断。
   */
  const cosmeticSwap = createCosmeticPreloadSwap({ preloadPath: cosmeticPreloadPath })

  /** enable 之后统一走这里：接管失败也只是退回库的原件，不影响拦截。 */
  function enableBlocking(): void {
    if (!blocker) return
    blocker.enableBlockingInSession(extSession)
    cosmeticSwap.takeOver(extSession, blocker)
  }

  /** disable 之后统一走这里：库已按 `ctx.preloadScriptId` 注销，这里只兜底。 */
  function disableBlocking(): void {
    try { blocker?.disableBlockingInSession(extSession) } catch (_) {}
    cosmeticSwap.release(extSession)
  }

  // ── 引擎缓存（磁盘持久化）────────────────────────────
  /**
   * 为什么必须落盘：`ElectronBlocker.fromPrebuiltAdsOnly/AdsAndTracking` 在本版本里
   * 等价于 `fromLists` —— 它没有任何预构建包可用，直接**并发**拉 12 / 14 条
   * raw.githubusercontent.com 列表（库内 `fetchLists` 用的是 `Promise.all`），
   * 每条失败还要重试 3 次（`fetchWithRetry`）。网络不通时一次启动就是几十次
   * TLS 握手，Chromium 侧刷满 `handshake failed ... net_error -101`，而且没有缓存
   * 意味着**每次重启都重演**。
   *
   * 现在的策略（stale-while-revalidate）：
   *   · 命中缓存 → `deserialize` 毫秒级恢复，**零联网**，首屏不再被网络拖住；
   *   · 缓存超过 TTL → 先用旧的顶上，后台串行刷新，成功后原地换挂；
   *   · 无缓存 / 缓存损坏 → 走自控下载：有界并发（2），**传输层首个失败即中止**，
   *     断网时最多只有 3 个请求在飞（2 条列表 + resources），不再有 56 次握手。
   *
   * 缓存文件放在 `extDir` 下，随 profile 天然隔离（与 installed.json 同一根目录）。
   */
  const ENGINE_CACHE_DIR = path.join(extDir, 'adblocker')
  const ENGINE_TTL_MS = 7 * 24 * 60 * 60 * 1000
  /** 单条列表请求超时：列表是后台构建，不挡首屏，8s 足够区分「慢」与「死」。 */
  const LIST_TIMEOUT_MS = 8000
  const MAX_LIST_BYTES = 32 * 1024 * 1024
  /** 有界并发：2 是「不拖慢构建」与「断网时握手次数可忽略」之间的折中。 */
  const LIST_CONCURRENCY = 2

  /**
   * 列表前缀（与库内 `fetch.js` 的 `PREFIX` 同源）。
   * 为什么自己拼：库的 `fetchLists/fetchResources` 把 URL 写死且内部会重试，
   * 我们要的是「只试一次 + 可镜像 + 可中止」，所以只借它的列表数组与引擎实现。
   */
  const LIST_PREFIX = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets'
  const RESOURCES_LIST_URL = `${LIST_PREFIX}/ublock-origin/resources.json`

  /** 缓存文件路径：级别与文件一一对应，切换级别不会互相覆盖。 */
  function engineCacheFile(level: ActiveAdblockerLevel): string {
    return path.join(ENGINE_CACHE_DIR, level === 'ads' ? 'engine-ads.bin' : 'engine-ads-tracking.bin')
  }

  /** 可选镜像：`HIRA_ADBLOCKER_MIRROR` 指向与 assets 同结构的镜像根。 */
  function rewriteListUrl(url: string): string {
    const mirror = process.env.HIRA_ADBLOCKER_MIRROR
    if (!mirror || !url.startsWith(LIST_PREFIX)) return url
    return `${mirror.replace(/\/+$/, '')}${url.slice(LIST_PREFIX.length)}`
  }

  /**
   * 拉一条文本资源。**只尝试一次**（不重试）：断网时立刻失败，由上层整体中止，
   * 把「每次启动几十次握手」压到「断网时最多 3 次」。
   * HTTP 错误带上 `httpStatus`，供上层区分「这条列表没了（跳过）」与「网络整体不可用（中止）」。
   */
  async function fetchText(url: string, signal: AbortSignal): Promise<string> {
    const response = await net.fetch(rewriteListUrl(url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)])
    })
    if (!response.ok) {
      const error = Object.assign(new Error(`HTTP ${response.status} ${url}`), { httpStatus: response.status })
      throw error
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > MAX_LIST_BYTES) throw new Error(`列表超过 ${MAX_LIST_BYTES} 字节上限`)
    const reader = response.body?.getReader()
    if (!reader) {
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_LIST_BYTES) throw new Error(`列表超过 ${MAX_LIST_BYTES} 字节上限`)
      return text
    }
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_LIST_BYTES) {
          try { await reader.cancel() } catch (_) {}
          throw new Error(`列表超过 ${MAX_LIST_BYTES} 字节上限`)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      try { await reader.cancel() } catch (_) {}
      throw error
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  /**
   * 有界并发 + 首个**致命**失败即中止。
   * 与 `Promise.all` 的区别：后者会把**所有** URL 同时发出去（库的行为，正是握手风暴来源）；
   * 这里最多 `limit` 个在途，`isFatal` 判为致命后不再调度新请求，配合 `AbortController`
   * 把在途请求一起掐掉。
   *
   * 为什么不是「任何失败都中止」：单条列表返回 4xx（上游删了某个列表文件）属于局部故障，
   * 中止会让整个 adblocker 永久不可用；把它跳过、其余照常构建才是对的。
   * 而传输层失败（握手失败 / 超时 / 断网）一定是整体性的，必须立刻停手。
   * @template T
   * @param {string[]} items
   * @param {number} limit
   * @param {(item: string, signal: AbortSignal) => Promise<T>} worker
   * @param {AbortSignal} signal
   * @param {(error: unknown) => boolean} [isFatal]
   * @returns {Promise<T[]>}
   */
  async function mapLimitFailFast<T>(items: string[], limit: number, worker: (item: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal, isFatal: (error: unknown) => boolean = () => true): Promise<T[]> {
    /** @type {T[]} */
    const results: T[] = new Array<T>(items.length)
    let cursor = 0
    /** @type {unknown} */
    let firstError: unknown = null
    const runners = []
    for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i += 1) {
      runners.push((async () => {
        while (cursor < items.length && !firstError) {
          const index = cursor
          cursor += 1
          try {
            results[index] = await worker(items[index], signal)
          } catch (e) {
            if (isFatal(e)) {
              if (!firstError) firstError = e
            } else {
              console.warn('[infra-extensions] adblocker list skipped:', errorMessage(e))
            }
          }
        }
      })())
    }
    await Promise.all(runners)
    if (firstError) throw firstError
    return results
  }

  /**
   * 读缓存。返回 `null` 表示「没有可用缓存」，调用方应走网络。
   * `mtime` 即构建时间：比额外写一个 meta 文件少一次 IO，也不会出现「meta 与 bin 不一致」。
   */
  async function readEngineCache(level: ActiveAdblockerLevel): Promise<CachedAdblockerEngine | null> {
    const file = engineCacheFile(level)
    try {
      const [stat, buffer] = await Promise.all([
        fs.promises.stat(file),
        fs.promises.readFile(file)
      ])
      if (buffer.length === 0) return null
      // 引擎反序列化会用 `new Uint32Array(buffer.buffer, pos + buffer.byteOffset)` 按 4 字节直读，
      // 要求 byteOffset 4 字节对齐；Node 的小 Buffer 可能来自共享内存池，未对齐时先拷一份。
      const bytes = buffer.byteOffset % 4 === 0 ? buffer : new Uint8Array(buffer)
      return { buffer: bytes, ageMs: Date.now() - stat.mtimeMs }
    } catch (_) {
      // ENOENT / 权限 / 半截文件 —— 都按「没有缓存」处理，下次成功构建会重写。
      return null
    }
  }

  /** 原子写：先写同目录 tmp 再 rename，避免进程中途退出留下半截缓存被当成有效引擎。 */
  async function writeEngineCache(level: ActiveAdblockerLevel, engine: AdblockerEngine): Promise<void> {
    const file = engineCacheFile(level)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.promises.mkdir(ENGINE_CACHE_DIR, { recursive: true })
      await fs.promises.writeFile(tmp, engine.serialize())
      await fs.promises.rename(tmp, file)
      console.log('[infra-extensions] adblocker engine cached (level=%s)', level)
    } catch (e) {
      console.warn('[infra-extensions] adblocker cache write failed:', errorMessage(e))
      try { await fs.promises.unlink(tmp) } catch (_) {}
    }
  }

  /**
   * 从网络构建引擎（自控）：只借库的列表数组与 `parse`，下载节奏完全由我们掌控。
   * @param {'ads'|'ads+tracking'} level
   */
  async function buildEngineFromNetwork(level: ActiveAdblockerLevel): Promise<AdblockerEngine> {
    const { ElectronBlocker, adsLists, adsAndTrackingLists } = require('@ghostery/adblocker-electron')
    const urls = level === 'ads' ? adsLists : adsAndTrackingLists
    const controller = new AbortController()
    /** 传输层失败才算致命；HTTP 4xx/5xx 只是某条列表没了，跳过即可。 */
    const isTransportError = (error: unknown): boolean => !isRecord(error) || typeof error.httpStatus !== 'number'
    let lists: string[]
    let resources: string
    try {
      ;[lists, resources] = await Promise.all([
        mapLimitFailFast(urls, LIST_CONCURRENCY, fetchText, controller.signal, isTransportError),
        fetchText(RESOURCES_LIST_URL, controller.signal)
      ])
    } catch (e) {
      // 传输层失败 → 掐掉在途请求；剩下的 URL 不再调度（见 mapLimitFailFast 的 firstError）。
      controller.abort()
      throw e
    }
    const usable = lists.filter((text) => typeof text === 'string' && text.length > 0)
    if (usable.length === 0) throw new Error('no adblocker list available')
    /**
     * `enableMutationObserver: false` —— 不要为每张页面挂一个全文档 subtree observer。
     *
     * preload 侧的 cosmetic 注入用 MutationObserver 追踪「后插入的节点」再补隐藏规则；
     * 对浏览器本体来说这是每帧都在跑的成本（动态页 CPU 明显更高）。关掉后：
     *   · 网络拦截：完全不受影响（那是 webRequest 层）；
     *   · 静态元素隐藏：不受影响（首屏 CSS 一次到位）；
     *   · 唯一损失：**页面加载后**才异步插入的广告节点不会自动被隐藏。
     * 这个配置会随 `engine.serialize()` 落盘，因此旧缓存要额外校验（见 buildBlocker）。
     */
    const engine = ElectronBlocker.parse(usable.join('\n'), { enableMutationObserver: false })
    engine.updateResources(resources, `${resources.length}`)
    return engine
  }

  /**
   * 给引擎补上本项目的约定：关闭 scriptlet 注入 + 拦截计数。
   * 缓存恢复与网络新建**必须**共用这一处，否则两条路径行为会漂移。
   * @param {AdblockerEngine} engine
   */
  function decorateBlocker(engine: AdblockerEngine): AdblockerEngine {
    /**
     * 关闭 **scriptlet 注入**（留在页面主世界执行的那类 uBO 脚本），只保留
     * 网络拦截 + 元素隐藏（CSS）。
     *
     * 原因（实测，非猜测）：过滤列表给同一页面命中多条 scriptlet 时，
     * `@ghostery/adblocker` 会把「工具函数 prelude」随每个 scriptlet 各注入一次。
     * 该 prelude 会用 Proxy 改写 `Function.prototype.toString`，第二次安装时
     * `nativeToString` 指向的已是上一轮的代理 —— 调用即自递归，页面里稳定抛出
     * `RangeError: Maximum call stack size exceeded`（栈顶为
     * `Object.apply (<anonymous>:1:8653)`）。
     *
     * 这个异常发生在 Bing 的脚本加载回调里（`onreadystatechange` →
     * `processCallback threw error for script:A:rms:...`），会中断其后续模块处理：
     * 搜索结果图标的 `rms` 延迟实例化因此不执行，DOM 里只剩
     * `<div class="rms_iac" data-src="…">` 占位 —— 也就是「搜索结果图标显示不出来」。
     *
     * scriptlet 是可选增强（主要给反 adblock 站点用），代价却是往任意站点主世界
     * 注入 monkey-patch；对浏览器本体来说风险远大于收益。网络拦截与元素隐藏不受影响。
     */
    const getCosmeticsFilters = engine.getCosmeticsFilters.bind(engine)
    engine.getCosmeticsFilters = (options: Record<string, unknown>) =>
      getCosmeticsFilters({ ...(options || {}), getInjectionRules: false })

    // 监听拦截事件，用于统计和验证
    engine.on('request-blocked', (request?: Record<string, unknown>) => {
      blockedCount++
      if (blockedCount <= 20) {
        console.log('[adblocker] blocked:', request?.url)
      }
    })
    engine.on('request-redirected', () => { blockedCount++ })
    return engine
  }

  /**
   * 按级别装配 blocker（**不挂 session**，挂载统一由 applyAdblockerIntent 负责）。
   * @param {'ads'|'ads+tracking'} level
   * @param {{ forceNetwork?: boolean }} [options]
   */
  async function buildBlocker(level: ActiveAdblockerLevel, { forceNetwork = false }: { forceNetwork?: boolean } = {}): Promise<AdblockerEngine> {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron')

    if (!forceNetwork) {
      const cached = await readEngineCache(level)
      if (cached) {
        try {
          const engine = ElectronBlocker.deserialize(cached.buffer)
          // 配置随引擎一起序列化：升级前写下的缓存里 enableMutationObserver 仍是 true，
          // 直接用它等于优化没生效（而且要拖到 7 天 TTL 才自然过期）。这里把它当作
          // 「缓存不可用」——下面的 catch 会删缓存并走一次网络重建，重建后即自愈。
          if (engine.config && engine.config.enableMutationObserver !== false) {
            throw new Error('cached engine predates mutation observer opt-out')
          }
          console.log(
            '[infra-extensions] adblocker engine from cache (level=%s, %dKB, age=%dh)',
            level,
            Math.round(cached.buffer.length / 1024),
            Math.round(cached.ageMs / 3600000)
          )
          // 过期不阻塞：先用旧的顶上，后台刷新成功后再换（见 scheduleEngineRefresh）。
          if (cached.ageMs > ENGINE_TTL_MS) scheduleEngineRefresh(level)
          return decorateBlocker(engine)
        } catch (e) {
          console.warn('[infra-extensions] adblocker cache unusable, rebuilding:', errorMessage(e))
          // 版本升级 / 文件损坏：删掉旧缓存，避免每次启动都白读一遍再失败。
          try { await fs.promises.unlink(engineCacheFile(level)) } catch (_) {}
        }
      }
    }

    const engine = await buildEngineFromNetwork(level)
    await writeEngineCache(level, engine)
    return decorateBlocker(engine)
  }

  /**
   * 后台刷新（stale-while-revalidate 的 revalidate 半边）。
   *
   * 关键约束：**绝不能 await**。本函数是从 `buildBlocker`（运行在串行链上）里调用的，
   * 若在此等待 `queueAdblockerTask` 返回的 promise，就会等「当前任务结束后才开始的任务」，
   * 形成自等待死锁。挂在链尾、失败只记日志即可。
   * @param {'ads'|'ads+tracking'} level
   */
  function scheduleEngineRefresh(level: ActiveAdblockerLevel): void {
    if (engineRefreshLevel === level) return
    engineRefreshLevel = level
    void queueAdblockerTask(async () => {
      try {
        const refreshed = await buildBlocker(level, { forceNetwork: true })
        // 期间用户可能切了级别 / 关了盾牌：缓存已写盘，但不要动内存里的引擎。
        if (adblockerLevel !== level) return
        const wasEnabled = adblockerEnabled
        if (blocker && wasEnabled) {
          disableBlocking()
        }
        blocker = refreshed
        blockerLevel = level
        adblockerEnabled = false
        if (wasEnabled) {
          enableBlocking()
          adblockerEnabled = true
        }
        console.log('[infra-extensions] adblocker engine refreshed (level=%s)', level)
      } finally {
        if (engineRefreshLevel === level) engineRefreshLevel = null
      }
    })
  }

  /**
   * 把**意图**（adblockerLevel）对齐到实际：需要时重建列表、按意图挂载 / 摘除。
   * 串行执行（见 queueAdblockerTask），因此这里读到的 `adblockerLevel` 永远是最新意图。
   */
  async function applyAdblockerIntent(): Promise<void> {
    const desired = adblockerLevel

    // 1) 先摘掉旧 blocker 的 session 钩子。Electron 对同一 Session 的同一事件只保留
    //    一个监听器，新旧两份同时挂载会互相顶掉；重建期间也必须先摘，避免旧列表继续拦。
    if (blocker && adblockerEnabled) {
      disableBlocking()
      adblockerEnabled = false
    }
    if (desired === 'off') {
      emitEventSafely('adblocker-toggled', { enabled: false, level: 'off' })
      return
    }

    // 2) 列表级别相同直接复用；不同则重建（下载在后台完成，不阻塞任何调用方）。
    if (!blocker || blockerLevel !== desired) {
      blocker = await buildBlocker(desired)
      blockerLevel = desired
    }

    // 3) 挂载。`adblockerLevel` 可能在本轮 await 期间又被改掉 —— 此时让后续排队任务
    //    收敛到最新值即可，本轮先不挂载，避免「刚挂上又被摘」的抖动。
    if (adblockerLevel !== desired) return
    if (!adblockerEnabled) {
      enableBlocking()
      adblockerEnabled = true
    }
    console.log('[infra-extensions] adblocker ready (level=%s)', desired)
    emitEventSafely('adblocker-toggled', { enabled: true, level: desired })
  }

  if (enableAdblocker !== false) {
    // 关键：**不 await**。即便有缓存（毫秒级反序列化），也不该把引擎装配塞进启动路径：
    // 无缓存时首次构建仍要走网络（见 buildEngineFromNetwork）。改为后台初始化：
    // createExtensionService 立刻返回可用服务，引擎就绪后再自动接上拦截。
    // queueAdblockerTask 已吞掉 rejection，不会产生未处理的 rejection。
    adblockerReadyPromise = queueAdblockerTask(applyAdblockerIntent)
  }

  // ── 5. 监听扩展加载/卸载事件 ─────────────────────────
  /**
   * 已（重新）加载的扩展 → 把**已有**安装记录对齐到运行时真实路径。
   *
   * 为什么必须有：商店扩展的 autoUpdate 会在后台静默升级，而升级换的是**带版本号
   * 的目录**（`<crxDir>/<id>/<旧版本>_0` → `<crxDir>/<id>/<新版本>_0`，
   * 见 electron-chrome-web-store 的 updateExtension：加载新目录后它会**删掉旧目录**）。
   * NG 的安装记录存的是绝对路径，升级一发生它就指向一个已经不存在的目录 ——
   * 下次启动 restore() 在那儿找不到 manifest.json，扩展就此「消失」。
   * 这里只更新**已有记录**（enabled 保持记录原值，不新建记录：没有记录的扩展本来也不归
   * restore() 管），路径没变就跳过，避免每次加载都白写一次盘。
   * @param {RuntimeExtension} ext
   */
  function syncInstalledRecord(ext: RuntimeExtension): void {
    const record = installStore.get(ext.id)
    if (!record) return
    if (record.path === ext.path) return
    installStore.record(ext, record.enabled !== false)
  }

  extSession.extensions.addListener('extension-loaded', (_event: unknown, ext: RuntimeExtension) => {
    loadErrors.delete(ext.id)
    rememberExtension(ext, true)
    syncInstalledRecord(ext)
    emitLifecycle('loaded', normalizeExtension(ext))
  })

  /**
   * 尽力启动 MV3 扩展的 service worker（对齐 RT modules/extensions/helpers.ts）。
   *
   * 为什么需要：Electron 的 `loadExtension` **不会**主动运行 MV3 的 service worker，
   * 而扩展的事件监听（runtime.onInstalled / alarms / webRequest / contextMenus…）
   * 全都在 SW 里注册 —— SW 不起来，扩展就是「装了但没反应」。
   * `session.serviceWorkers.startWorkerForScope` 在 worker 尚未就绪时会 reject，
   * 因此按 RT 的口径轮询重试到超时。
   *
   * 失败**不抛错**：SW 也可能在首个事件到来时被 Electron 惰性拉起，扩展仍然可用；
   * 这里只留一条可定位的日志。
   * @param {RuntimeExtension} ext 运行时扩展对象
   * @returns {Promise<boolean>}
   */
  function startServiceWorker(ext: RuntimeExtension, { timeoutMs = 10000, intervalMs = 16 }: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const manifest = ext && ext.manifest
    if (!manifest || manifest.manifest_version !== 3) return Promise.resolve(true)
    if (!manifest.background || !manifest.background.service_worker) return Promise.resolve(true)
    // scope 必须带尾斜杠 —— 这就是 ECE 自己派发事件时用的写法
    // （dist/cjs/index.js:2561 `chrome-extension://${extensionId}/`）。
    // 少了它 startWorkerForScope 永远 reject，SW 起不来也就派发不出 onInstalled。
    const scope = `chrome-extension://${ext.id}/`
    const deadline = Date.now() + timeoutMs
    return (async function tick() {
      let delayMs = Math.max(16, intervalMs)
      while (Date.now() < deadline) {
        try {
          await extSession.serviceWorkers.startWorkerForScope(scope)
          return true
        } catch (_) { /* worker 还没就绪：等一下再试 */ }
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(1, deadline - Date.now()))))
        delayMs = Math.min(500, Math.ceil(delayMs * 1.75))
      }
      console.warn('[infra-extensions] service worker start timed out:', ext.id)
      return false
    })()
  }

  /** 触发一次 SW 启动，失败只记日志（绝不制造未处理的 rejection）。 */
  function kickServiceWorker(ext: RuntimeExtension): void {
    try {
      startServiceWorker(ext).catch((e) => {
        console.warn('[infra-extensions] startServiceWorker failed:', ext && ext.id, errorMessage(e))
      })
    } catch (_) {}
  }

  /**
   * 「扩展已进入运行时」之后的一切收尾 —— **全库唯一装配入口**。
   *
   * 之前六条加载路径（installFromPath / installFromCrx / reload ×2 / ensureLoaded /
   * toggle 启用 / restore）各抄一份 `remember + record + kick + emit`，抄到最后细节
   * 已经漂移：只有商店 afterInstall 会等 SW 起来再派发 `runtime.onInstalled`，
   * 手动导入的两条完全没派发 —— 而 contextMenus / alarms / 动态 content script /
   * 默认设置这些初始化全写在 `runtime.onInstalled` 里，于是「装了但一点反应没有」。
   *
   * 语义统一成 Chrome 口径：`dispatch` 非空才派发 onInstalled（首次安装 = install，
   * 版本变化 = update）；重载 / 重新启用 / 启动恢复（版本未变）都不派发。
   * SW 启动 + 派发**后台跑**（最坏等满 10s 超时）：导入回包与列表刷新不能被它拖住，
   * 这正是商店 afterInstall 已有的处理方式。
   *
   * @param {RuntimeExtension} ext 已 loadExtension 成功的运行时扩展对象
   * @param {{ dispatch?: 'install'|'update'|null }} [options]
   * @returns {Object} normalizeExtension 后的信息（调用方据此发 lifecycle 事件）
   */
  function settleLoadedExtension(ext: RuntimeExtension, options: { dispatch?: 'install' | 'update' | null } = {}): ExtensionInfo {
    const dispatch = options.dispatch || null
    rememberExtension(ext, true)
    loadErrors.delete(ext.id)
    // 快照只在「首次登记」或「路径 / 版本变了」时落盘：启动恢复时每条扩展都无条件
    // 写一遍 installed.json 纯属白烧（N 个扩展 = N 次串行整文件写），而路径漂移
    // 已由 extension-loaded → syncInstalledRecord 兜住。
    const prev = installStore.get(ext.id)
    if (!prev || prev.path !== (ext.path || '') || prev.version !== (ext.version || '')) {
      installStore.record(ext, true)
    }
    // 自愈：若早前那次 attach 因注册失败而没置位，这里补挂（已挂则是空转）。
    // 只挂不摘 —— 「摘」是 uninstall / 停用尾部 syncExtensionPreloads() 的职责，
    // 刚加载完成的扩展绝不能在这个缝隙里被摘掉 preload。
    attachExtensionPreloads()
    if (dispatch) {
      startServiceWorker(ext)
        .then((swReady) => extensions.dispatchRuntimeInstalled(ext.id, { reason: dispatch })
          .then((delivered: boolean) => {
            // SW 起来了（或本来就不需要）= 事件确实派发过了，标记掉；
            // delivered 为 false 通常只是「扩展没写 onInstalled 监听」，不必每次启动重试。
            // SW 没起来（超时）则**不**标记，留给下次启动 / 下次导入补派。
            if (swReady) installStore.markAnnounced(ext.id)
            if (!delivered) console.warn('[infra-extensions] runtime.onInstalled not delivered:', ext.id)
          }))
        .catch((e) => {
          console.warn('[infra-extensions] dispatch runtime.onInstalled failed:', ext.id, errorMessage(e))
        })
    } else {
      kickServiceWorker(ext)
    }
    return normalizeExtension(ext)
  }

  extSession.extensions.addListener('unloaded', (_event: unknown, ext: RuntimeExtension) => {
    const record = runtimeRegistry.get(ext.id)
    if (record) record.enabled = false
    emitLifecycle('unloaded', { id: ext.id, name: ext.name })
  })

  // ECE 自己建的扩展弹窗（PopupView）也要让 app 层知道 —— 对齐 RT：
  //   extensions.on("browser-action-popup-created", (popup) => windowsController.extensionPopup.new(popup.browserWindow))
  // 它的窗口已经由 ECE 建好（按内容自适应尺寸、失焦自关、关窗 destroy），
  // app 层只需要把它登记进窗口注册表的 extension-popup 类型维度，别的什么都不用做。
  try {
    extensions.on('browser-action-popup-created', (popup: PopupCreated) => {
      try {
        if (popupSupport && typeof popupSupport.track === 'function') popupSupport.track(popup)
        emitEventSafely('popup-created', {
          extensionId: (popup && popup.extensionId) || '',
          browserWindow: popup && popup.browserWindow,
          popup
        })
      } catch (_) {}
    })
  } catch (_) {}

  /**
   * 规范化扩展信息。
   *
   * hasOptionsPage / hasPopup / optionsUrl / popupUrl 是**面向所有用户的能力字段**
   * （不是开发者视图专属），随列表项一并下发，页面据此决定「打开设置页 / 弹出窗口」
   * 两个按钮是可用还是置灰 —— 老 Hira 是点了之后才弹「该扩展未提供弹窗」，
   * 这里把同一判断提前到渲染前，按钮就不会白点。
   * @param {unknown} ext
   * @returns {ExtensionInfo}
   */
  function normalizeExtension(ext: unknown) : ExtensionInfo {
    const runtime = ext as RuntimeExtension
    return {
      id: runtime.id || '',
      name: runtime.name || runtime.manifest?.name || 'Unknown',
      version: runtime.version || runtime.manifest?.version || '',
      enabled: true,
      description: runtime.manifest?.description || '',
      iconPath: runtime.iconPath || resolveIconPath(runtime.manifest) || '',
      isUnpacked: runtime.manifest?._unpacked === true || !!runtime.path,
      // 安装路径：详情视图要展示（「已解压」的扩展尤其需要）。拿不到就是空串，
      // 绝不编造 —— 已停用的扩展会走安装记录里的路径。
      path: runtime.path || '',
      ...capabilitiesOf(runtime)
    }
  }

  function findExtension(extensionId: string): RuntimeExtension | null {
    try {
      return extSession.extensions.getAllExtensions().find((extension: RuntimeExtension) => extension.id === extensionId) || null
    } catch (_) {
      return null
    }
  }

  /**
   * 从运行时卸载某个扩展（**只卸载，不碰磁盘**）。
   *
   * 传的是**扩展 id 字符串**，不是运行时扩展对象 —— Electron 43 的签名是
   * `session.extensions.removeExtension(extensionId: string)`（RT 的
   * `unloadExtensionWithId` 与老 Hira 的 `removeExtension(loadedExtension.id)`
   * 也都是传 id）。传对象会被 ToString 成 "[object Object]" 后查找不到任何扩展，
   * 变成**静默 no-op**（症状：停用 / 重载 / 卸载点了没反应）。
   * 失败只记日志不抛：调用方（toggle / uninstall）已经各自有中文可定位的失败语义。
   * @param {string} extensionId
   * @returns {boolean}
   */
  function unloadFromRuntime(extensionId: string) : boolean {
    try {
      extSession.extensions.removeExtension(extensionId)
      return true
    } catch (e) {
      console.warn('[infra-extensions] removeExtension failed:', extensionId, errorMessage(e))
      return false
    }
  }

  /**
   * 同一扩展只允许一个原生 loadExtension 在途。
   *
   * 启动恢复在后台跑，用户此时点「打开选项页 / 弹窗」会触发 ensureLoaded；
   * 两条链若同时进入 Electron，后到的一条会以「already loaded」失败，并被误记成
   * 扩展加载失败。这里按 id 合并调用，并把竞态下已由其它路径加载成功的扩展视为成功。
   */
  function loadExtensionOnce(extensionId: string, extensionPath: string): Promise<RuntimeExtension> {
    const existing = findExtension(extensionId)
    if (existing) return Promise.resolve(existing)
    const pending = loadInFlight.get(extensionId)
    if (pending) return pending

    const task = (async () => {
      if (destroyed) throw new Error('扩展服务已释放')
      try {
        return await extSession.extensions.loadExtension(extensionPath, { allowFileAccess: true })
      } catch (error) {
        const raced = findExtension(extensionId)
        if (raced && !destroyed) return raced
        throw error
      }
    })()
    loadInFlight.set(extensionId, task)
    task.then(
      (loaded) => {
        if (!destroyed) return
        try { extSession.extensions.removeExtension(loaded.id) } catch (_) {}
      },
      () => {}
    ).finally(() => {
      if (loadInFlight.get(extensionId) === task) loadInFlight.delete(extensionId)
    }).catch(() => {})
    return task
  }

  /**
   * 扩展描述符 —— 「按 id 拿 id / manifest / path」的**唯一入口**。
   *
   * 数据源按可信度排序：运行时扩展对象 → 内存注册表（含已停用）→ 安装记录
   * （含已停用 / 加载失败）→ 磁盘 `manifest.json`。
   *
   * 为什么要跨到安装记录：停用 / 加载失败的扩展不在运行时，但它「有选项页 /
   * 有弹窗」这件事仍写在清单里。只查运行时会让能力字段与安装记录派生的按钮
   * 状态打架（按钮可点、点了返回 ok:false）。打开动作能否真的成功由 enabled
   * 决定（Chrome 语义），地址解析本身必须与是否在运行时解耦。
   * @param {string} extensionId
   * @returns {{id: string, manifest: ExtensionManifest|null, path: string}|null}
   */
  function describeExtension(extensionId: string): {id: string; manifest: ExtensionManifest | null; path: string} | null {
    if (!extensionId || typeof extensionId !== 'string') return null
    const ext = findExtension(extensionId)
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    const extPath = (ext && typeof ext.path === 'string' && ext.path) ||
      (record && typeof record.path === 'string' && record.path) || ''
    let manifest = (ext && ext.manifest) || (record && record.manifest) || null
    if (!manifest && extPath) {
      // 极老的记录 / 手写 installed.json 没有清单快照：从磁盘补读一份，失败即 null。
      try {
        const manifestPath = path.join(extPath, 'manifest.json')
        const stat = fs.statSync(manifestPath)
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_EXTENSION_JSON_BYTES) {
          const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
          manifest = isRecord(parsed) ? parsed as ExtensionManifest : null
        }
      } catch (_) {
        manifest = null
      }
    }
    if (!ext && !record && !manifest) return null
    return { id: (ext && ext.id) || extensionId, manifest, path: extPath }
  }

  /** 扩展 id → 磁盘路径（运行时对象优先，已停用的走安装记录）。 */
  function pathOfExtension(extensionId: string): string {
    const descriptor = describeExtension(extensionId)
    return descriptor ? descriptor.path : ''
  }

  /** 取（必要时创建）某个扩展的派生信息缓存槽。 */
  function cacheEntryOf(extensionId: string): DerivedInfo {
    let entry = derivedCache.get(extensionId)
    if (!entry) {
      entry = {}
      derivedCache.set(extensionId, entry)
    }
    return entry
  }

  /**
   * 读取某个扩展的本地化消息表（**端口**：IO 留在 infra，纯数据交给上层）。
   *
   * 候选语言由调用方（app 层，经 domain 的 localeChainOf）按「界面语言优先级 →
   * `default_locale`」算好传进来 —— 域层排回退链、infra 按单子读盘，两边都不越界。
   * 结果按 `id + 候选语言`缓存：同一份候选语言只读一次盘。
   * @param {string} extensionId
   * @param {string[]} locales
   * @returns {Promise<Record<string, Record<string, { message?: string }>>>} 一级都读不到时返回 `{}`（调用方回退清单原文）
   */
  async function getLocaleMessages(extensionId: string, locales: string[]): Promise<Record<string, Record<string, { message?: string }>>> {
    const list = Array.isArray(locales) ? locales : []
    const key = list.join(',')
    const entry = cacheEntryOf(extensionId)
    if (entry.localeKey === key && entry.locales) return entry.locales
    const messages = await readLocaleMessages(pathOfExtension(extensionId), list)
    entry.localeKey = key
    entry.locales = messages
    return messages
  }

  /**
   * 扩展目录的字节数（**端口**：按需计算 + 缓存）。
   *
   * 为什么按需而不是随列表下发：这是**递归扫盘**，扩展目录可能有上万个小文件，
   * 每次列表刷新都算一遍会直接拖慢首屏与每次开关后的刷新。调用方（app 层）只在
   * 用户真的打开详情时问一次，算完进缓存，反复展开不会重复扫盘。
   * @param {string} extensionId
   * @returns {Promise<number|null>} null = 无法测量（目录不存在 / 无权限）
   */
  async function getExtensionSize(extensionId: string) : Promise<number|null> {
    const entry = cacheEntryOf(extensionId)
    if ('size' in entry) return entry.size ?? null
    const extensionPath = pathOfExtension(extensionId)
    const pending = sizeInFlight.get(extensionId)
    if (pending && pending.path === extensionPath) return pending.promise
    let task: Promise<number | null>
    task = directorySize(extensionPath)
      .then((size) => {
        if (!destroyed && pathOfExtension(extensionId) === extensionPath) {
          cacheEntryOf(extensionId).size = size
        }
        return size
      })
      .finally(() => {
        if (sizeInFlight.get(extensionId)?.promise === task) sizeInFlight.delete(extensionId)
      })
    sizeInFlight.set(extensionId, { path: extensionPath, promise: task })
    return task
  }

  // ── 扩展图标（管理页 / 面板显示用）───────────────────────────────────────────
  /** 图标文件的 MIME 映射（只覆盖扩展清单 icons 里实际会出现的图片格式）。 */
  const ICON_CONTENT_TYPES = Object.fromEntries(
    IMAGE_FILE_EXTENSIONS.map((ext: string) => [ext, EXT_MIME_TYPES[ext]])
  )

  /** 扩展清单：运行时对象优先，已停用的走安装记录快照，最后才回落到读盘。 */
  function manifestOfExtension(extensionId: string): ExtensionManifest | null {
    const descriptor = describeExtension(extensionId)
    return descriptor ? descriptor.manifest : null
  }

  /**
   * 取某个扩展的图标文件内容（**端口**：读盘在 infra，交付物是纯字节 + MIME）。
   *
   * 为什么必须有它：Electron 的 `Extension` 对象**没有** iconPath 字段
   * （见 electron.d.ts 的 `interface Extension`：只有 id / manifest / name / path /
   * url / version），所以清单里的 `icons` 只是**扩展目录内的相对路径**
   * （如 `icons/128.png`）。那个字符串直接塞进 `<img src>` 会相对当前页面解析
   * （`hira://extensions/icons/128.png`）—— 必然 404，图标永远出不来。
   * RT 的解法是 `hx://extension-icon?id=…`（ipc/app/extensions.ts:41-43 拼地址 +
   * sessions-controller 的 extension-icon 路由读取），NG 同样需要一条「按 id 读到
   * 真实文件」的端口，由 hira:// 协议层包成 Response 交给 `<img>`。
   *
   * 选取口径对齐 RT：优先 128px，其次最大的一档；都没有 → null（UI 用首字母徽标
   * 降级，绝不出现破图）。
   * 安全：清单由扩展作者书写，图标路径可能带 `../`。这里 path.resolve + relative
   * 双重判定必须落在扩展目录内（意图对齐 RT assets.ts#isPathInsideRoot），越界即当
   * 「没有图标」，绝不读到扩展目录之外的文件。
   * @param {string} extensionId
   * @returns {Promise<{ buffer: Buffer, contentType: string }|null>}
   */
  async function getExtensionIconAsset(extensionId: string) : Promise<{ buffer: Buffer, contentType: string }|null> {
    const extPath = pathOfExtension(extensionId)
    if (!extPath) return null
    const manifest = manifestOfExtension(extensionId)
    const iconPath = resolveIconPath(manifest)
    if (!iconPath) return null

    // 前导斜杠在 Chrome 里同样表示「相对扩展根」，去掉后交给 path.resolve 统一处理。
    const resolved = path.resolve(extPath, iconPath.replace(/^[/\\]+/, ''))
    const relative = path.relative(extPath, resolved)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null

    try {
      const stat = await fs.promises.stat(resolved)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EXTENSION_ICON_BYTES) return null
      const [realRoot, realFile] = await Promise.all([
        fs.promises.realpath(extPath),
        fs.promises.realpath(resolved)
      ])
      const realRelative = path.relative(realRoot, realFile)
      if (realRelative === '' || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null
      const buffer = await fs.promises.readFile(realFile)
      return {
        buffer,
        contentType: ICON_CONTENT_TYPES[path.extname(realFile).toLowerCase()] || 'application/octet-stream'
      }
    } catch (_) {
      return null
    }
  }

  /**
   * 扩展图标 → `data:<mime>;base64,…`（**UI 直接可用的最终形式**）。
   *
   * 对齐参考实现（Hira main/extensions/extensionIcons.js#getExtensionIcon）：
   * 图标由主进程读盘后直接内联，不经过任何自定义协议 —— 管理页 / 侧栏在
   * 生产环境跑在 `file://` 上，跨协议子资源不可靠，`data:` 才是确定可用的。
   *
   * 缓存键带 `path|version`：同一 id 重载换了目录或版本时自动重读，
   * 其余情况（面板每次刷新都问一遍）直接命中内存，零磁盘 IO。
   * @param {string} extensionId
   * @returns {Promise<string>} 空串 = 没有可用图标（UI 降级为首字母徽标）
   */
  async function getExtensionIconDataUrl(extensionId: string) : Promise<string> {
    const descriptor = describeExtension(extensionId)
    if (!descriptor || !descriptor.manifest) return ''
    const cacheKey = `${descriptor.path}|${descriptor.manifest.version || ''}`
    const cached = iconDataCache.get(extensionId)
    if (cached && cached.key === cacheKey) return cached.dataUrl

    const pending = iconInFlight.get(extensionId)
    if (pending && pending.key === cacheKey) return pending.promise
    let task: Promise<string>
    task = (async () => {
      const asset = await getExtensionIconAsset(extensionId)
      if (!asset || !asset.buffer || asset.buffer.length === 0) return ''
      const dataUrl = `data:${asset.contentType || 'image/png'};base64,${asset.buffer.toString('base64')}`
      const current = describeExtension(extensionId)
      const currentKey = current ? `${current.path}|${current.manifest?.version || ''}` : ''
      if (!destroyed && currentKey === cacheKey) cacheIconData(extensionId, { key: cacheKey, dataUrl })
      return dataUrl
    })().finally(() => {
      if (iconInFlight.get(extensionId)?.promise === task) iconInFlight.delete(extensionId)
    })
    iconInFlight.set(extensionId, { key: cacheKey, promise: task })
    return task
  }

  function getRuntimeStatus(extensionId: string): 'disabled' | 'loaded' | 'error' | 'missing' {
    const ext = findExtension(extensionId)
    const record = runtimeRegistry.get(extensionId)
    if (ext) return ext.disabled ? 'disabled' : 'loaded'
    // 不在运行时但有失败登记 → error（记录仍在安装存储里，原因随列表项下发）
    if (loadErrors.has(extensionId)) return 'error'
    if (record && record.enabled === false) return 'disabled'
    if (!record) return 'missing'
    return 'loaded'
  }

  function getDiagnostics(extensionId: string): ExtensionDiagnostic[] {
    const ext = findExtension(extensionId)
    if (!ext) {
      // 加载失败优先如实上报原因 —— 这是用户唯一能定位故障的入口
      const loadError = loadErrors.get(extensionId)
      if (loadError) {
        return [{ code: 'load-failed', severity: 'error', message: `扩展加载失败：${loadError.message}` }]
      }
      // 已停用 ≠ 缺失：停用是我们自己按用户意图卸载的（记录还在），
      // 报「未加载」但不说「错误」，否则开发者视图会把用户的正常操作显示成故障。
      const record = runtimeRegistry.get(extensionId)
      return record
        ? [{ code: 'disabled', severity: 'warning', message: '扩展已停用，未在当前运行时加载' }]
        : [{ code: 'missing', severity: 'error', message: '扩展未在当前运行时加载' }]
    }
    const diagnostics: ExtensionDiagnostic[] = []
    if (!ext.manifest || !ext.manifest.name || (ext.manifest.manifest_version !== 2 && ext.manifest.manifest_version !== 3)) {
      diagnostics.push({ code: 'invalid-manifest', severity: 'error', message: '扩展清单无效或不受支持' })
    }
    if (!ext.path) diagnostics.push({ code: 'runtime-path-unavailable', severity: 'warning', message: '运行时未提供扩展路径，无法执行路径级重载' })
    return diagnostics
  }

  function getWarnings(extensionId: string): ExtensionDiagnostic[] {
    const ext = findExtension(extensionId)
    if (!ext || !ext.manifest) return []
    const permissions: string[] = []
    for (const key of MANIFEST_PERMISSION_KEYS) {
      for (const permission of Array.isArray(ext.manifest[key]) ? ext.manifest[key] : []) {
        if (typeof permission === 'string' && !permissions.includes(permission)) permissions.push(permission)
      }
    }
    return permissions.map((permission) => ({ code: permission, severity: 'warning', message: permission }))
  }

  /**
   * 重新加载扩展（从磁盘重读清单与代码）。
   *
   * 只对**运行中**的扩展有意义：已停用的扩展本来就没进运行时，重载它只会把它
   * 悄悄变成「已启用」——那不是用户要的。唯一的例外是**加载失败**的扩展：
   * 记录与路径仍在安装存储里，重载即「重试加载」（失败原因随 loadErrors 更新）。
   * @param {string} extensionId
   * @returns {Promise<boolean>}
   */
  async function reload(extensionId: string) : Promise<boolean> {
    const ext = findExtension(extensionId)
    if (!ext) {
      // 加载失败的扩展走「重试」：记录与路径仍在安装存储里，用户点重试不该无解。
      // 停用（enabled === false）不允许走这条路 —— 那会绕过 toggle 把停用悄悄变启用。
      const rec = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
      const retryingFailure = loadErrors.has(extensionId)
      if (!rec || (!retryingFailure && rec.enabled === false) || !rec.path) return false
      attachExtensionPreloads()
      try {
        const loaded = await loadExtensionOnce(extensionId, rec.path)
        emitLifecycle('reloaded', { id: extensionId, extension: settleLoadedExtension(loaded) })
        return true
      } catch (e) {
        const message = errorMessage(e) || '未知错误'
        loadErrors.set(extensionId, { message, at: Date.now() })
        emitLifecycle('load-failed', { id: extensionId, message })
        return false
      }
    }
    loadErrors.delete(extensionId)
    const record = runtimeRegistry.get(extensionId)
    const extPath = ext.path || record?.path
    if (!extPath) return false
    attachExtensionPreloads()
    if (!unloadFromRuntime(extensionId) && findExtension(extensionId)) {
      const message = '无法卸载现有扩展实例，重载未执行'
      loadErrors.set(extensionId, { message, at: Date.now() })
      emitLifecycle('load-failed', { id: extensionId, message })
      return false
    }
    try {
      const loaded = await loadExtensionOnce(extensionId, extPath)
      // 重载可能换了清单（改了版本 / 权限）：settle 会同步刷新记录快照，
      // 否则重启后恢复用的是旧清单。
      emitLifecycle('reloaded', { id: extensionId, extension: settleLoadedExtension(loaded) })
      return true
    } catch (e) {
      const message = errorMessage(e) || '未知错误'
      loadErrors.set(extensionId, { message, at: Date.now() })
      emitLifecycle('load-failed', { id: extensionId, message })
      return false
    }
  }

  /**
   * 确保扩展已进入运行时（按需加载）。
   *
   * 为什么需要它：启动恢复是后台跑的 —— 可能还没完成、可能失败过、也可能用户在
   * 失败后没手动重试。而打开设置页 / 弹窗依赖扩展**真的加载进了 session**
   * （`chrome-extension://` 页面由 Electron 的扩展支持提供）。点击时补一次加载，
   * 用户不必先理解「要先重试再打开」。
   *
   * 只对安装记录里 `enabled !== false` 且有磁盘路径的扩展生效；失败如实登记
   * loadErrors（与 reload 同一语义），但**不向外抛错**。
   * @param {string} extensionId
   * @returns {Promise<boolean>} 当前是否处于运行时
   */
  async function ensureLoaded(extensionId: string) : Promise<boolean> {
    if (!extensionId || typeof extensionId !== 'string') return false
    if (findExtension(extensionId)) return true
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    if (!record || record.enabled === false || !record.path) return false
    attachExtensionPreloads()
    try {
      const loaded = await loadExtensionOnce(extensionId, record.path)
      emitLifecycle('reloaded', { id: extensionId, extension: settleLoadedExtension(loaded) })
      return true
    } catch (e) {
      const message = errorMessage(e) || '未知错误'
      loadErrors.set(extensionId, { message, at: Date.now() })
      emitLifecycle('load-failed', { id: extensionId, message })
      return false
    }
  }

  // ── 打开扩展自身的页面（选项页 / 弹出窗口）──────────────────────────────

  /**
   * 注入 NG 的扩展弹窗能力（app 层实现，infra 只做编排与降级）。
   *
   * 为什么不在这里自己 `new BrowserWindow`：弹窗窗口的特性（无边框、锚到按钮下方、
   * 失焦即关、随父窗口移动重定位、关闭用 destroy 释放内存）、以及它要登记进窗口
   * 注册表的类型维度，全都属于 **app 层的窗口编排**（window-config 的类型表 +
   * WindowRegistry）。infra-extensions 只该知道「这个扩展的 popup 地址是什么、
   * 要开在谁旁边」，不该自己养一份窗口表。
   *
   * 对齐 RT：那边也是由 `loaded-profiles-controller` 监听 ECE 的
   * `browser-action-popup-created` 事件后把窗口交给 `windowsController.extensionPopup`
   * 登记 —— 弹窗窗口的归属在 app 层，infra 只负责把「窗口已创建」这件事传上去。
   *
   * @param {{ open?: Function, close?: Function, track?: Function }|null} support
   */
  function setPopupSupport(support: PopupSupport | null): void {
    popupSupport = support
  }

  /**
   * 扩展自身页面（options / popup）地址 —— **统一解析 + 启用位闸门**。
   *
   * 地址来源走 `describeExtension`（运行时 → 注册表 → 安装记录 → 读盘），
   * 因此停用 / 加载失败的扩展也能解析出「它本来该打开哪个页面」，与列表里
   * 由安装记录派生的 `hasOptionsPage` / `hasPopup` 完全同源，不会再出现
   * 「按钮可点、点了没反应」。
   *
   * 启用位是**打开语义**的闸门（Chrome：停用的扩展不能打开自身页面）：
   * 任何一处明确 `enabled === false` → 返回空串，由调用方如实返回 ok:false。
   * 运行时存在但无记录 = 刚安装 / 热加载，视为启用。
   * @param {string} extensionId
   * @param {'optionsUrl'|'popupUrl'} key
   * @returns {string}
   */
  function extensionPageUrlOf(extensionId: string, key: 'optionsUrl'|'popupUrl') : string {
    const descriptor = describeExtension(extensionId)
    if (!descriptor || !descriptor.manifest) return ''
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    if (record && record.enabled === false) return ''
    return capabilitiesOf(descriptor)[key] || ''
  }

  /** 选项页绝对地址（已停用返回空串）。 */
  function getOptionsUrl(extensionId: string): string {
    return extensionPageUrlOf(extensionId, 'optionsUrl')
  }

  /**
   * 弹出窗口绝对地址（已停用返回空串）。
   * 与 getOptionsUrl 同一解析口径：弹窗地址属于清单事实，与是否在运行时解耦。
   * @param {string} extensionId
   * @returns {string}
   */
  function getPopupUrl(extensionId: string) : string {
    const descriptor = describeExtension(extensionId)
    if (!descriptor || !descriptor.manifest) return ''
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    if (record && record.enabled === false) return ''
    try {
      const actionApi = extensions.api && extensions.api.browserAction
      const state = actionApi && typeof actionApi.getState === 'function' ? actionApi.getState() : null
      const action = state && Array.isArray(state.actions)
        ? state.actions.find((item: Record<string, unknown>) => item && item.id === extensionId)
        : null
      if (action && Object.prototype.hasOwnProperty.call(action, 'popup')) {
        const dynamic = actionApi && typeof actionApi.getPopupUrl === 'function'
          ? actionApi.getPopupUrl(extensionId, -1)
          : ''
        if (typeof dynamic !== 'string' || !dynamic) return ''
        const url = new URL(dynamic)
        return url.protocol === 'chrome-extension:' && url.hostname === extensionId ? url.href : ''
      }
    } catch (_) {
      // 动态状态不可读时仍可退回清单里的 default_popup。
    }
    return capabilitiesOf(descriptor).popupUrl
  }

  /**
   * 调用方给的 anchorRect 是否可用作 ECE 弹窗的锚点。
   *
   * ECE 的 PopupView 以「活动标签所属的那个浏览器窗口」为父窗口、按**该窗口的内容区**
   * 定位，锚点坐标因此必须与那个窗口同系。侧栏面板本身就在主窗口里 → 坐标成立；
   * 扩展管理页是**独立窗口**，它的 rect 落在另一个坐标系里，直接拿来用会让弹窗
   * 飞到窗口外。这种情况退回「锚点窗口右上角」——宁可位置略偏，也不错位。
   * @returns {boolean}
   */
  function isUsableAnchor(anchorRect: PopupAnchorOptions['anchorRect'], parentWindow: BrowserWindowType | null | undefined, anchorWin: BrowserWindowType | null | undefined): boolean {
    if (!anchorRect || typeof anchorRect.x !== 'number' || typeof anchorRect.y !== 'number') return false
    if (!anchorWin || (typeof anchorWin.isDestroyed === 'function' && anchorWin.isDestroyed())) return false
    if (!parentWindow || (typeof parentWindow.isDestroyed === 'function' && parentWindow.isDestroyed())) return false
    // 比 id 而不是对象引用：BrowserWindow 在同一进程内 id 唯一且稳定。
    return parentWindow.id === anchorWin.id
  }

  /**
   * 首选路径：ECE 自己的 popup 管线（`api.browserAction.activateClick`）。
   *
   * 与「点工具栏图标」走的是同一条路 —— 同一个 PopupView（按内容自适应尺寸、
   * 失焦自动关闭、父子窗口绑定、并派发 `browser-action-popup-created`），
   * 所以「从管理页打开」与「点图标打开」表现完全一致，不会出现两套弹窗样式。
   *
   * 为什么可以直接取 `api`：v4.9.4 里 `ElectronChromeExtensions#api` / `#ctx` 只是
   * TS 层面的 private（编译后是普通属性，库内自己标注 "TODO: Make private for
   * v4 major release"），而这也是本库对外提供 popup 能力的**唯一**入口（公开 API
   * 面只有 addTab / getContextMenuItems 等，没有任何 openPopup）。因此这里做
   * **能力探测 + 兜底**，且所有调用点都包在 try 里：拿不到内部 API、库版本变化、
   * 或当前窗口没有可锚定的标签页时一律返回 false，由 openPopup 走 NG 弹窗窗口。
   *
   * @param {string} extensionId
   * @param {PopupAnchorOptions} opts
   * @returns {boolean} 是否成功发起打开
   */
  function openPopupViaEce(extensionId: string, { anchorRect, alignment, parentWindow }: PopupAnchorOptions = {}): boolean {
    const actionApi = extensions.api && extensions.api.browserAction
    if (!actionApi || typeof actionApi.activateClick !== 'function' || typeof actionApi.getPopupUrl !== 'function') {
      return false
    }
    // 先问 ECE 自己认不认这个弹窗地址：它认才会真的开（否则 activateClick 会改派
    // browserAction.onClicked —— 那种「返回成功却什么都没出现」比直接兜底更糟）。
    let eceKnowsPopup = ''
    try { eceKnowsPopup = actionApi.getPopupUrl(extensionId, -1) || '' } catch (_) { return false }
    if (!eceKnowsPopup) return false

    const anchorWin = extensions.ctx && extensions.ctx.store && extensions.ctx.store.getCurrentWindow()
    let resolvedAnchor = anchorRect
    if (!isUsableAnchor(anchorRect, parentWindow, anchorWin)) {
      // 锚点取窗口右上角，与 ECE 自己实现 chrome.action.openPopup 时的默认锚点一致。
      const anchorSize = 64
      const width = anchorWin && typeof anchorWin.getContentBounds === 'function'
        ? anchorWin.getContentBounds().width
        : 0
      resolvedAnchor = { x: Math.max(0, width - anchorSize), y: 0, width: anchorSize, height: anchorSize }
    }
    try {
      // tabId: -1 = 交给 ECE 用「当前窗口的活动标签」（弹窗落点由 anchorRect 决定）。
      actionApi.activateClick({ eventType: 'click', extensionId, tabId: -1, anchorRect: resolvedAnchor, alignment })
      return true
    } catch (e) {
      console.warn('[infra-extensions] openPopup via ECE failed, falling back:', errorMessage(e))
      return false
    }
  }

  /**
   * 打开扩展的弹出窗口（工具栏图标点开的那个 popup）。
   *
   * 两级策略（对齐参考实现 Hira main/extensions/ipc/extensions.js#openExtensionPopup）：
   *   1. **NG 扩展弹窗窗口**（app 层注入）—— 参考项目本身就是这么做的：读清单拿到
   *      `default_popup` → 用绑定了扩展 session 的 BrowserWindow 打开
   *      `chrome-extension://<id>/<page>`。它不依赖 ECE 的标签登记状态，
   *      从管理页 / 侧栏 / 任意窗口发起都能出窗，行为稳定可预期；
   *   2. ECE popup 管线兜底 —— 与点工具栏图标同源（尺寸自适应、失焦即关由 ECE 管）。
   *
   * 顺序与旧实现相反：以前「ECE 优先」会在 `activateClick` 找不到已登记标签 /
   * 窗口映射时**返回成功却什么都没出现**（它内部改派了 onClicked），用户看到的是
   * 「点了没反应」。窗口优先把确定性放在第一位。
   *
   * @param {string} extensionId
   * @param {PopupAnchorOptions} [opts]
   * @returns {boolean} 是否成功发起打开（两条路都不通时如实 false）
   */
  function openPopup(extensionId: string, opts: PopupAnchorOptions = {}): boolean {
    const popupUrl = getPopupUrl(extensionId)
    if (!popupUrl) return false

    if (popupSupport && typeof popupSupport.open === 'function') {
      try {
        const opened = popupSupport.open({
          url: popupUrl,
          extensionId,
          anchorRect: opts.anchorRect,
          alignment: opts.alignment,
          parentWindow: opts.parentWindow,
          session: extSession
        })
        if (opened) return true
      } catch (e) {
        console.warn('[infra-extensions] openPopup via popup support failed:', errorMessage(e))
      }
    }

    return openPopupViaEce(extensionId, opts)
  }

  /** 关掉当前任何来源的扩展弹窗（profile 切换 / 服务销毁时收口，避免残留窗口引用）。 */
  function closePopup() {
    try {
      if (popupSupport && typeof popupSupport.close === 'function') popupSupport.close()
    } catch (_) {}
    try {
      const actionApi = extensions.api && extensions.api.browserAction
      if (actionApi && actionApi.popup && typeof actionApi.popup.destroy === 'function') actionApi.popup.destroy()
    } catch (_) {}
  }

  // ── 可检查视图（Chrome / Edge 扩展详情页的「检查视图」）──────────────────

  /**
   * 收集某个扩展当前**真实存在**的后台上下文（原始数据，不含命名与文案）。
   *
   * 为什么要走 Electron 公开 API 而不是 ECE 的内部字段：
   *   · 背景页 —— `webContents.getAllWebContents()` 中 `getType() === 'backgroundPage'`
   *     的 WebContents（ECE 自己也正是用这个判据收集 extension hosts，见其
   *     index.js:2386-2391），这是文档化 API，不随库版本变化；
   *   · Service Worker —— `session.serviceWorkers.getAllRunning()`
   *     （electron.d.ts:12371，返回 `Record<versionId, ServiceWorkerInfo>`）。
   *
   * 命名与「能不能真调试」的判断**不在本层**：那是纯规则，归 domain 的
   * buildInspectViews（分层：infra 只读运行时，domain 只做纯推导）。
   *
   * 拿不到任何上下文时两个数组都为空 —— 上层据此**整段不渲染**，绝不生成死链。
   * 任何异常一律吞掉并当「没有」：这是锦上添花的展示信息，不该让管理页开不出来。
   * @param {string} extensionId
   * @returns {{ backgrounds: { url: string }[], serviceWorkers: { scope: string, scriptUrl: string }[] }}
   */
  function getInspectViewSources(extensionId: string) : { backgrounds: { url: string }[], serviceWorkers: { scope: string, scriptUrl: string }[] } {
    const empty: { backgrounds: { url: string }[]; serviceWorkers: { scope: string; scriptUrl: string }[] } = { backgrounds: [], serviceWorkers: [] }
    const id = typeof extensionId === 'string' ? extensionId.trim() : ''
    if (!id) return empty
    const prefix = `chrome-extension://${id}/`

    const backgrounds: { url: string }[] = []
    try {
      for (const wc of webContents.getAllWebContents()) {
        try {
          if (!wc || wc.isDestroyed()) continue
          // 只认本扩展系统的 session：别的 profile / 无痕会话里的同名扩展不是同一个。
          if (wc.session !== extSession) continue
          if (wc.getType() !== 'backgroundPage') continue
          if (!String(wc.getURL() || '').startsWith(prefix)) continue
          backgrounds.push({ url: wc.getURL() })
        } catch (_) { /* 单个 WebContents 状态取不到：跳过，不影响其它 */ }
      }
    } catch (_) { /* 枚举失败：当作没有背景页 */ }

    const serviceWorkers: { scope: string; scriptUrl: string }[] = []
    try {
      const running = (extSession.serviceWorkers.getAllRunning() || {}) as Record<string, { scope?: unknown; scriptUrl?: unknown }>
      for (const info of Object.values(running)) {
        if (!info || typeof info !== 'object') continue
        const scope = typeof info.scope === 'string' ? info.scope : ''
        const scriptUrl = typeof info.scriptUrl === 'string' ? info.scriptUrl : ''
        if (!scope.startsWith(prefix) && !scriptUrl.startsWith(prefix)) continue
        serviceWorkers.push({ scope, scriptUrl })
      }
    } catch (_) { /* 同上：SW 列表拿不到就不显示这一栏 */ }

    return { backgrounds, serviceWorkers }
  }

  /** 找某个扩展的背景页 WebContents（没有 / 已销毁 → null）。 */
  function backgroundHostOf(extensionId: string): WebContentsType | null {
    const prefix = `chrome-extension://${extensionId}/`
    try {
      for (const wc of webContents.getAllWebContents()) {
        try {
          if (!wc || wc.isDestroyed()) continue
          if (wc.session !== extSession) continue
          if (wc.getType() !== 'backgroundPage') continue
          if (!String(wc.getURL() || '').startsWith(prefix)) continue
          return wc
        } catch (_) {}
      }
    } catch (_) {}
    return null
  }

  /**
   * 打开某个扩展后台上下文的开发者工具（「检查视图」那一栏的点击）。
   *
   * 只支持 `background-page`：背景页是 WebContents，`openDevTools({ mode: 'detach' })`
   * 就是 Chrome 里点「背景页」看到的那套 DevTools（独立窗口，不挤占浏览器布局）。
   * `service-worker` 一律 false —— Electron 没有扩展后台 SW 的开发者工具入口
   * （见 domain-extension/extensionUtil.ts 的能力边界说明），UI 那一栏本来就会置灰；
   * 这里再兜一层，防止有人绕过 UI 直接调。
   * @param {string} extensionId
   * @param {string} target 视图类型（domain 的 buildInspectViews 产出的 target）
   * @returns {boolean} 是否真的打开了
   */
  function inspectView(extensionId: string, target: string) : boolean {
    if (target !== 'background-page') return false
    const host = backgroundHostOf(extensionId)
    if (!host) return false
    try {
      host.openDevTools({ mode: 'detach' })
      return true
    } catch (e) {
      console.warn('[infra-extensions] openDevTools for background page failed:', extensionId, errorMessage(e))
      return false
    }
  }

  /**
   * 立即检查并安装所有扩展的可用更新（对齐 RT 开发者模式工具条的「更新」）。
   * 库的 `updateExtensions(session)` 只认本次会话里由商店安装的扩展（清单带 update_url），
   * 本地未打包扩展本来就没有更新源，因此这里不需要额外过滤。
   * @returns {Promise<boolean>}
   */
  async function updateAllExtensions() : Promise<boolean> {
    try {
      const { updateExtensions } = require('@iamevan/electron-chrome-web-store')
      await updateExtensions(extSession)
      return true
    } catch (e) {
      console.warn('[infra-extensions] updateExtensions failed:', errorMessage(e))
      return false
    }
  }

  /**
   * 扩展声明的新标签页覆盖地址（`chrome_url_overrides.newtab`）；没有则空串。
   *
   * 为什么不读 ECE 的 `store.urlOverrides`：那张表只**累加**、卸载时不清（其
   * readUrlOverrides 仅在值变化时写入），扩展卸掉后仍会留着一个指向死目录的地址。
   * 这里改成**当场问运行时**：只认当前真正加载中、且清单里声明了 newtab 覆盖的扩展，
   * 算出来的地址一定是活的；扩展被停用 / 卸载后这一项自动消失，新标签页立刻回到
   * NG 自己的快速拨号页。
   *
   * 仍按 URL 解析（`new URL(相对路径, chrome-extension://<id>/)`）而不是字符串拼接：
   * 清单里可能写 `newtab.html` / `/newtab.html` 甚至带 query，拼接会拼出坏地址。
   * @returns {string}
   */
  function getNewTabOverrideUrl() : string {
    let all = []
    try { all = extSession.extensions.getAllExtensions() || [] } catch (_) { return '' }
    for (const ext of all) {
      const overrides = ext && ext.manifest && ext.manifest.chrome_url_overrides
      const page = overrides && typeof overrides === 'object' ? overrides.newtab : ''
      if (typeof page !== 'string' || !page.trim() || !ext.id) continue
      try {
        const url = new URL(page.trim(), `chrome-extension://${ext.id}/`)
        if (url.protocol === 'chrome-extension:' && url.hostname === ext.id) return url.href
      } catch (_) { /* 该扩展的覆盖地址写坏了：跳过，不因它拖垮新标签页 */ }
    }
    return ''
  }


  // ── 5. 公共 API ─────────────────────────────────────

  /**
   * 列出所有已安装扩展。
   *
   * 每项都带 `runtimeStatus`（运行中 / 已停用 / 未加载）：列表本来就在主进程手里，
   * 状态也算在这里是**零成本**的；否则管理页/侧栏要为每一行各发一次
   * `extension:runtime-status`（N 个扩展 = N 次 IPC 往返 + N 次列表重排）。
   *
   * 返回顺序**只由安装顺序位决定**（`installed.json` 的 `order`），与启用 / 停用、
   * 加载成功与否无关 —— 这是 UI 可以「开关一行只变状态、不变位置」的前提。
   * @returns {ExtensionInfo[]}
   */
  function listExtensions() : ExtensionInfo[] {
    let all: RuntimeExtension[] = []
    try { all = extSession.extensions.getAllExtensions() as RuntimeExtension[] } catch (_) {}
    const result: ExtensionInfo[] = all.map((extension) => normalizeExtension(extension))
    const seen = new Set<string>(result.map((item) => item.id))
    for (const record of runtimeRegistry.values()) {
      if (!seen.has(record.id)) {
        const loadError = loadErrors.get(record.id)
        result.push({
          ...record.extension,
          enabled: record.enabled,
          runtimeStatus: loadError ? 'error' : (record.enabled ? 'loaded' : 'disabled'),
          ...(loadError ? { loadError: loadError.message } : {})
        })
        seen.add(record.id)
      }
    }
    // 加载失败的扩展也要出现在列表里（带原因）：它们不在运行时、不在停用播种位，
    // 不补就会整行消失 —— 用户连「它坏了、为什么坏、在哪重试」都无从得知。
    for (const rec of installStore.list()) {
      if (rec.enabled === false || seen.has(rec.id)) continue
      const err = loadErrors.get(rec.id)
      if (!err) continue
      result.push({
        ...normalizeExtension({
          id: rec.id,
          name: rec.name,
          version: rec.version,
          description: rec.description,
          iconPath: rec.iconPath,
          manifest: rec.manifest || null,
          path: rec.path
        }),
        enabled: true,
        loadError: err.message
      })
      seen.add(rec.id)
    }
    // pinned 是**安装记录**里的用户意图（不是运行时对象的属性）：无论扩展是否
    // 在运行时（停用 / 加载失败），列表项都要如实带上，固定态才不会随启停漂移。
    //
    // 排序必须与运行状态**彻底解耦**：上面的三段是按「运行时 / 已停用 / 加载失败」
    // 拼出来的（那是取数方式，不是顺序契约），直接下发会让用户开关一次扩展就看到
    // 整行跳位 —— 停用的掉到末尾、重新启用的又从末尾冒回来。这里统一按安装记录里
    // 的永久顺序位排序，因此启用 / 停用只改行内状态，永远不改行间次序。
    // 先按当前拼接序把兜底顺序位一次性定下来（比较器里边比边分配会让顺序随比较
    // 次序漂移，首屏就可能跳一次），再统一排序。
    for (const item of result) listOrderOf(item.id)
    result.sort((a, b) => listOrderOf(a.id) - listOrderOf(b.id))
    return result.map((item) => ({
      ...item,
      pinned: Boolean(installStore.get(item.id)?.pinned),
      runtimeStatus: getRuntimeStatus(item.id)
    }))
  }

  /**
   * 摘掉「正从这个目录加载着」的扩展实例（没有则无操作）。
   *
   * Electron 不允许同一个扩展 id 加载两次，重复导入 / 覆盖升级前必须先摘。
   * 只按**完全相同的路径**判定：换路径时 id 未必相同，宁可让 loadExtension 照常报错，
   * 也不误摘一个无关的扩展。
   * @param {string} dirPath
   */
  function unloadExtensionAtPath(dirPath: string) {
    const api = extSession.extensions
    if (!api || typeof api.getAllExtensions !== 'function' || typeof api.removeExtension !== 'function') return
    const samePath = (api.getAllExtensions() as RuntimeExtension[]).find(
      (extension: RuntimeExtension) => typeof extension.path === 'string' && path.resolve(extension.path) === path.resolve(dirPath)
    )
    if (!samePath) return
    try { extSession.extensions.removeExtension(samePath.id) } catch (_) { /* 已不在运行时 */ }
  }

  /**
   * 从文件夹路径安装扩展。
   * @param {string} dirPath
   * @returns {Promise<ExtensionInfo>}
   */
  async function installFromPath(dirPath: string) : Promise<ExtensionInfo> {
    attachExtensionPreloads()
    // 同一目录重复导入 = 覆盖升级（见 unloadExtensionAtPath）。
    unloadExtensionAtPath(dirPath)
    const loaded = await extSession.extensions.loadExtension(dirPath, {
      allowFileAccess: true
    })
    // 手动导入必须和商店安装同一套装配语义（含 runtime.onInstalled 派发），
    // 否则依赖 onInstalled 做初始化的扩展就是「装上了但没反应」。
    // 覆盖安装同一 id 的新版本按 Chrome 口径派 update 而不是 install。
    const prior = installStore.get(loaded.id)
    const info = settleLoadedExtension(loaded, {
      dispatch: prior && prior.version && prior.version !== (loaded.version || '') ? 'update' : 'install'
    })
    // 同一个磁盘路径被不同 id 覆盖（典型：同名 CRX 换成了另一个扩展）时，旧记录
    // 会继续指向已经换内容的目录：重启后它要么加载失败，要么把新扩展算到旧身份上。
    // 路径复用成功装配后，把同路径的旧 id 记录一起摘掉。
    for (const stale of installStore.list()) {
      if (stale.id === loaded.id || !stale.path || path.resolve(stale.path) !== path.resolve(dirPath)) continue
      runtimeRegistry.delete(stale.id)
      loadErrors.delete(stale.id)
      installStore.remove(stale.id)
      try { identity.cleanup(stale.id) } catch (_) {}
      emitLifecycle('uninstalled', { id: stale.id, name: stale.name || stale.id })
    }
    emitLifecycle('installed', info)
    return info
  }

  /**
   * 从 .crx 文件安装扩展。
   * @param {string} crxPath
   * @returns {Promise<ExtensionInfo>}
   */
  async function installFromCrx(crxPath: string) : Promise<ExtensionInfo> {
    // 必须先剥壳再解压：`loadExtension(crxPath)` 对 .crx 必然抛错（它只吃已解压目录），
    // 而 `tar -xf` 按 ZIP 识别要求文件以 PK 开头 —— 之前那条降级链对真实 .crx 是必失败的。
    const stat = await fs.promises.stat(crxPath)
    if (!stat.isFile() || stat.size <= 0) throw new Error('CRX 文件不存在或为空')
    if (stat.size > MAX_CRX_BYTES) throw new Error('CRX 文件过大，已拒绝加载')
    const zip = extractCrxZip(await fs.promises.readFile(crxPath))
    // 落在 `crx/manual/<文件名>`：不能直接放 `crx/<文件名>` —— 商店安装的目录名是
    // 扩展 id，用户把 .crx 命名成某个 id 时，下面那句 rmSync 就会删掉别人的扩展。
    // 单独一层 manual 子树把「手动导入」与「商店 / 迁移安装」彻底分区。
    const targetDir = path.join(crxDir, 'manual', sanitizeSegment(path.basename(crxPath, path.extname(crxPath))))
    try {
      // 先摘掉旧实例再清目录：目录删了而实例还活着，会让运行中的扩展读到消失的文件。
      // 重复导入同一文件 = 覆盖升级：清干净，避免旧版本残留文件混进新版本。
      unloadExtensionAtPath(targetDir)
      fs.rmSync(targetDir, { recursive: true, force: true })
      const archive = new AdmZip(zip)
      const entries = archive.getEntries()
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('CRX 内没有可安装文件')
      if (entries.length > MAX_CRX_ENTRIES) throw new Error('CRX 文件条目过多，已拒绝加载')

      const root = path.resolve(targetDir)
      let uncompressedBytes = 0
      for (const entry of entries) {
        const entryName = String(entry && entry.entryName || '')
        if (!entryName || entryName.includes('\0')) throw new Error('CRX 包含非法路径')
        const normalizedEntry = entryName.replace(/\\/g, '/')
        const segments = normalizedEntry.split('/').filter(Boolean)
        if (segments.some((segment) => (
          segment.includes(':') ||
          /[. ]$/.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
        ))) throw new Error('CRX 包含 Windows 保留路径')
        const destination = path.resolve(root, normalizedEntry)
        const relative = path.relative(root, destination)
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CRX 包含越界路径')
        const unixMode = Number(entry && entry.attr) >>> 16
        if ((unixMode & 0o170000) === 0o120000) throw new Error('CRX 包含符号链接，已拒绝加载')
        const size = Number(entry && entry.header && entry.header.size)
        if (Number.isFinite(size) && size > 0) uncompressedBytes += size
        if (uncompressedBytes > MAX_CRX_UNCOMPRESSED_BYTES) throw new Error('CRX 解压体积过大，已拒绝加载')
      }
      archive.extractAllTo(root, true)
      const extractedBytes = await directorySize(root)
      if (extractedBytes === null || extractedBytes > MAX_CRX_UNCOMPRESSED_BYTES) {
        throw new Error('CRX 解压结果异常，已拒绝加载')
      }
      if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) {
        throw new Error('包内缺少 manifest.json')
      }
      // 解压后的装配统一走 installFromPath（记录 / 顺序位 / onInstalled 派发 / 生命周期事件）。
      return await installFromPath(targetDir)
    } catch (err) {
      // 失败不留半成品目录，否则重试时会带着残缺内容继续加载。
      fs.rmSync(targetDir, { recursive: true, force: true })
      throw new Error(`Failed to load CRX: ${errorMessage(err)}`)
    }
  }

  /**
   * 从**外部目录**安装扩展（浏览器一键迁移等「现成文件夹」来源）。
   *
   * 与 installFromPath 的唯一差别：先把目录**复制进本应用的扩展存储**
   * （`<crxDir>/imported/<slot>/<version>`）再加载。为什么必须复制：
   * 安装记录会把 path 持久化、重启时按它加载；直接指向源浏览器目录，
   * 浏览器升级 / 清理后就成了死链，卸载时还会去删别人的文件。
   *
   * 目标路径由「稳定槽位」推导（同一扩展重复导入 = 同一路径），
   * 因此重复导入会命中「已安装」而不是给同一扩展再加载一份。
   *
   * @param {string} srcDir 源扩展目录（含 manifest.json）
   * @param {{ slot?: string, version?: string }} [options]
   * @returns {Promise<{ ok: boolean, already?: boolean, info?: object, error?: string }>}
   */
  async function installFromExternalDirectory(srcDir: string, options: { slot?: string, version?: string } = {}) : Promise<{ ok: boolean, already?: boolean, info?: object, error?: string }> {
    const src = typeof srcDir === 'string' ? srcDir : ''
    if (!src) return { ok: false, error: '缺少扩展目录' }
    const slot = sanitizeSegment(options.slot || path.basename(path.dirname(src)))
    const version = sanitizeSegment(options.version || '0')
    const dest = path.join(crxDir, 'imported', slot, version)
    const srcResolved = path.resolve(src)
    const destResolved = path.resolve(dest)
    const destInsideSource = path.relative(srcResolved, destResolved)
    const sourceInsideDest = path.relative(destResolved, srcResolved)
    if (
      srcResolved === destResolved ||
      (!destInsideSource.startsWith('..') && !path.isAbsolute(destInsideSource)) ||
      (!sourceInsideDest.startsWith('..') && !path.isAbsolute(sourceInsideDest))
    ) {
      return { ok: false, error: '源目录与扩展存储目录重叠，已拒绝复制' }
    }
    const installed = installStore.list().some(
      (rec) => rec && rec.path && path.resolve(rec.path) === path.resolve(dest)
    )
    if (installed) return { ok: true, already: true }
    try {
      await fs.promises.rm(dest, { recursive: true, force: true })
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.cp(src, dest, {
        recursive: true,
        dereference: false,
        filter: async (entry: string) => {
          try { return !(await fs.promises.lstat(entry)).isSymbolicLink() } catch (_) { return false }
        }
      })
      const info = await installFromPath(dest)
      return { ok: true, info }
    } catch (e) {
      // 复制成功但加载失败 → 清掉半成品，避免下次导入误判「已安装」。
      try { fs.rmSync(dest, { recursive: true, force: true }) } catch (_) {}
      return { ok: false, error: errorMessage(e) }
    }
  }

  /**
   * 卸载扩展。
   *
   * 已停用的扩展**不在运行时**（这正是停用的含义），所以不能只从 ECE 里找 ——
   * 那样「停用后再卸载」会直接失败，用户只能先启用再卸载。这里把安装记录一起看：
   * 只要有记录就允许卸载（运行时对象存在时顺带从运行时移除）。
   *
   * ── 磁盘怎么处理（crx 与未打包是两回事）───────────────────────────────
   * · **商店安装 / .crx 导入**（代码落在 `crxDir` 子树里）：必须连磁盘一起清掉。
   *   不清的后果是实打实的：残留文件白占空间，而且同一个 id 再装一次会在旧目录上
   *   叠加（库按 `<crxDir>/<id>/<version>_0` 解包，旧版本目录会留在那儿）。
   *   对齐 RT `management.ts#uninstallExtension` 的 crx 分支：走库的
   *   `uninstallExtension(id, { extensionsPath, session })`（它负责 removeExtension
   *   与删 `<crxDir>/<id>`），再兜底清掉**实际安装目录**（手动导 .crx 时目录名是
   *   crx 文件名，未必等于扩展 id，库那一下删不到）。
   * · **未打包扩展**（用户自己指的那个目录）：只从运行时移除，**绝不动原目录** ——
   *   那是用户的项目源码，删掉不可逆。
   * @param {string} extensionId
   * @returns {Promise<boolean>}
   */
  async function uninstall(extensionId: string) : Promise<boolean> {
    const ext = findExtension(extensionId)
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    const storedRecord = installStore.get(extensionId)
    if (!ext && !record) return false
    const extPath = (ext && typeof ext.path === 'string' && ext.path) || (record && record.path) || ''

    if (isCrxManagedPath(extPath)) {
      let handled = false
      try {
        const { uninstallExtension } = require('@iamevan/electron-chrome-web-store')
        await uninstallExtension(extensionId, { extensionsPath: crxDir, session: extSession })
        handled = true
      } catch (e) {
        console.warn('[infra-extensions] web store uninstall failed, falling back:', errorMessage(e))
      }
      if (!handled) unloadFromRuntime(extensionId)
      // 兜底 1：库只删 `<crxDir>/<id>`，而手动导入的目录名来自 crx 文件名 —— 删实际目录。
      try { fs.rmSync(extPath, { recursive: true, force: true }) } catch (_) {}
      // 兜底 2：安装路径都是 `<容器>/<扩展槽>/<版本>` 两级结构（商店是
      // `<crxDir>/<id>/<version>_0`，迁移导入是 `<crxDir>/imported/<slot>/<version>`），
      // 父目录 = 该扩展的版本容器，里面可能留着旧版本 —— 一并收掉（库删过的再删一次幂等）。
      // 但**只认这两种容器层级**：手动导入落在 `crx/manual/<名>`，父目录是共享的
      // `crx/manual`，整层删掉会连带清掉别人的扩展。
      const parent = path.dirname(extPath)
      const grandParent = path.resolve(path.dirname(parent))
      const parentIsVersionBucket = isCrxManagedPath(parent) && (
        grandParent === path.resolve(crxDir) ||
        grandParent === path.resolve(crxDir, 'imported')
      )
      if (parentIsVersionBucket) { try { fs.rmSync(parent, { recursive: true, force: true }) } catch (_) {} }
    } else {
      unloadFromRuntime(extensionId)
    }

    runtimeRegistry.delete(extensionId)
    loadErrors.delete(extensionId)
    installStore.remove(extensionId)
    // 记录已删 → 若这是最后一个扩展，preload 一并摘掉。
    syncExtensionPreloads()
    // 卸载 = 身份凭据一并作废：token 缓存 + 该扩展尚未完成的认证窗口。
    // 不做的话，重装同名 id 的扩展会直接继承上一份 token（跨"安装身份"的泄漏）。
    try { identity.cleanup(extensionId) } catch (_) {}
    emitLifecycle('uninstalled', { id: extensionId, name: ext?.name || storedRecord?.name || '' })
    return true
  }

  /**
   * 启用 / 停用扩展。
   *
   * ── 底层到底支持到什么程度（诚实说明）──────────────────────────────────
   * Chromium / Electron **没有**「禁用但保留已加载实例」的原生 API：
   * `session.extensions` 只有 loadExtension / removeExtension，没有 disable。
   * 因此本实现与 RT 完全一致地采用「**卸载式停用**」——
   *   停用 = removeExtension（从运行时真正卸载，省内存、API 立刻失效）
   *        + 在安装记录里把 enabled 置 false（**意图持久化**，重启后不再加载）；
   *   启用 = 按记录里的原始路径 loadExtension 回来。
   * 用户可见的差别只有一处：停用后扩展的 background / service worker 真的停了
   * （这正是停用该有的效果），重新启用会重建实例。
   *
   * @param {string} extensionId
   * @param {boolean} enabled
   * @returns {Promise<boolean>}
   */
  async function toggle(extensionId: string, enabled: boolean) : Promise<boolean> {
    const ext = findExtension(extensionId)
    const record = runtimeRegistry.get(extensionId) || installStore.get(extensionId)
    const extPath = ext?.path || record?.path
    if (!ext && !record) return false

    try {
      if (enabled) {
        if (!ext || ext.disabled || record?.enabled === false) {
          if (ext) unloadFromRuntime(extensionId)
          if (!extPath) return false
          attachExtensionPreloads()
          const loaded = await loadExtensionOnce(extensionId, extPath)
          // 重新启用 = 重新加载；只有「从未派发过 onInstalled」的记录才补一次
          // （历史安装 / 上次导入时 SW 没起来），正常启停不伪造 onInstalled。
          const installed = installStore.get(extensionId)
          settleLoadedExtension(loaded, {
            dispatch: installed && installed.announced === true ? null : 'install'
          })
        } else {
          rememberExtension(ext, true)
        }
      } else if (ext && !ext.disabled) {
        rememberExtension(ext, false)
        unloadFromRuntime(extensionId)
      } else if (record) {
        record.enabled = false
      }
    } catch (e) {
      // 原生调用（loadExtension / removeExtension）失败不能冒成未处理的 handler 错误：
      // 面板侧只会看到「IPC 调用失败」而完全不知道要修什么。收敛成 false + 可定位的日志。
      console.error(
        '[infra-extensions] toggle failed: id=%s enabled=%s extPath=%s (%s) %s',
        extensionId, enabled, typeof extPath === 'string' ? extPath : String(extPath),
        extPath && typeof extPath === 'object' ? 'PATH_NOT_STRING' : typeof extPath,
        errorMessage(e)
      )
      // 启用失败的语义等同「加载失败」：登记原因，列表行随即显示「加载失败」而非假正常。
      if (enabled) {
        loadErrors.set(extensionId, { message: errorMessage(e) || '未知错误', at: Date.now() })
        emitLifecycle('load-failed', { id: extensionId, message: loadErrors.get(extensionId)?.message || '未知错误' })
      }
      return false
    }

    // 成功改了运行状态才落盘：上面的 catch 分支已经 return false，不会把失败写成记录。
    installStore.setEnabled(extensionId, enabled)
    if (!enabled) loadErrors.delete(extensionId)
    // 停用后若一个扩展都不剩，把 preload 摘掉（零扩展用户不付每 frame 的解析税）。
    syncExtensionPreloads()

    emitLifecycle('toggled', {
      id: extensionId,
      enabled: Boolean(enabled),
      extension: runtimeRegistry.get(extensionId)?.extension || (ext ? normalizeExtension(ext) : { id: extensionId })
    })
    return true
  }

  /**
   * 固定 / 取消固定扩展（持久化到安装记录，随 profile 隔离）。
   *
   * 与 toggle 的区别：**完全不碰运行时** —— 固定只是用户对「常用扩展」的标记，
   * 与启停、加载都没有关系。因此停用 / 加载失败的扩展同样可以固定，重启后照旧。
   * 不在安装记录里的 id（没装过）一律 false：固定必须落在一个真实安装身份上。
   * @param {string} extensionId
   * @param {boolean} pinned
   * @returns {boolean}
   */
  function setPinned(extensionId: string, pinned: boolean) : boolean {
    if (!extensionId || !installStore.get(extensionId)) return false
    installStore.setPinned(extensionId, pinned === true)
    // 事件让所有已打开的管理页 / 面板立即对账（与 toggle 同一条 extension:changed 管道），
    // 不需要任何页面轮询。
    emitLifecycle('pinned', {
      id: extensionId,
      pinned: pinned === true,
      extension: (() => {
        const ext = findExtension(extensionId)
        return ext ? normalizeExtension(ext) : { id: extensionId }
      })()
    })
    return true
  }

  /**
   * 启动恢复：按安装记录把扩展加载回运行时（并对已停用的记录补齐可展示信息）。
   *
   * 为什么放在 createExtensionService 里**后台跑**（不 await）：加载扩展要读盘、
   * 起 background / service worker，放到启动路径上会拖慢首屏 —— 与 adblocker
   * 同一处理方式。加载完每个扩展都会派发一条 lifecycle 事件，管理页 / 侧栏
   * 因此会自动刷新，不需要页面主动轮询。
   * @returns {Promise<{loaded: number, disabled: number, failed: number}>}
   */
  async function restore() : Promise<{loaded: number, disabled: number, failed: number}> {
    const stats = { loaded: 0, disabled: 0, failed: 0 }
    // 进入循环前先对齐一次：下面每一个 loadExtension 都要求 preload 已在位
    // （启动序列已按记录挂过，这里是幂等的第二道保险）。
    syncExtensionPreloads()
    for (const rec of installStore.list()) {
      if (destroyed) break
      // 已停用：不进运行时，但仍要在列表里出现（带名称 / 版本 / 权限 / 能力位），
      // 否则用户会以为扩展被删了，连「重新启用」的入口都找不到。
      if (rec.enabled === false) {
        const seeded = {
          id: rec.id,
          name: rec.name,
          version: rec.version,
          description: rec.description,
          iconPath: rec.iconPath,
          manifest: rec.manifest || null,
          path: rec.path
        }
        runtimeRegistry.set(rec.id, {
          id: rec.id,
          path: rec.path,
          manifest: rec.manifest || null,
          extension: normalizeExtension(seeded),
          enabled: false
        })
        stats.disabled++
        emitLifecycle('toggled', { id: rec.id, enabled: false, extension: normalizeExtension(seeded) })
        continue
      }
      if (typeof rec.path !== 'string' || !rec.path) {
        stats.failed++
        const message = '安装记录缺少扩展目录，无法加载'
        loadErrors.set(rec.id, { message, at: Date.now() })
        emitLifecycle('load-failed', { id: rec.id, message })
        continue
      }
      // 原目录可能已被移动 / 删除：跳过并保持记录（用户可能只是临时拔了盘），
      // 不删记录 —— 静默删除等于替用户做了不可逆的决定。
      try {
        if (!fs.existsSync(path.join(rec.path, 'manifest.json'))) {
          console.warn('[infra-extensions] restore skipped, manifest missing:', rec.path)
          stats.failed++
          loadErrors.set(rec.id, { message: '扩展目录缺失或 manifest.json 不存在（目录可能已被移动或删除）', at: Date.now() })
          emitLifecycle('load-failed', { id: rec.id, message: loadErrors.get(rec.id)?.message || '未知错误' })
          continue
        }
        const loaded = await loadExtensionOnce(rec.id, rec.path)
        // 装配语义与安装路径统一：从未派发过 onInstalled（历史安装 / 上次 SW 没起来）
        // 就补一次 install，版本变了派 update；否则启动恢复不派发（Chrome 语义）。
        const dispatch = rec.announced !== true
          ? 'install'
          : (rec.version && rec.version !== (loaded.version || '') ? 'update' : null)
        stats.loaded++
        emitLifecycle('loaded', settleLoadedExtension(loaded, { dispatch }))
      } catch (e) {
        console.warn('[infra-extensions] restore failed:', rec.id, errorMessage(e))
        stats.failed++
        loadErrors.set(rec.id, { message: errorMessage(e) || '未知错误', at: Date.now() })
        emitLifecycle('load-failed', { id: rec.id, message: loadErrors.get(rec.id)?.message || '未知错误' })
      }
    }
    if (stats.loaded || stats.disabled || stats.failed) {
      console.log(
        '[infra-extensions] restored extensions: loaded=%d disabled=%d failed=%d',
        stats.loaded, stats.disabled, stats.failed
      )
    }
    return stats
  }

  /**
   * 为新创建的 tab 注册到扩展系统。
   * @param {Electron.WebContents} tab
   * @param {Electron.BaseWindow} [window]
   */
  function addTab(tab: Electron.WebContents, window?: Electron.BaseWindow) {
    extensions.addTab(tab, window)
  }

  /**
   * 从扩展系统取消注册 tab。
   * @param {Electron.WebContents} tab
   */
  function removeTab(tab: Electron.WebContents) {
    extensions.removeTab(tab)
  }

  /**
   * 通知扩展系统活动 tab 已变更。
   * @param {Electron.WebContents} tab
   */
  function selectTab(tab: Electron.WebContents) {
    extensions.selectTab(tab)
  }

  /**
   * 获取上下文菜单项（由 chrome.contextMenus API 注册）。
   * @param {Electron.WebContents} webContents
   * @param {Electron.ContextMenuParams} params
   */
  function getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams) {
    return extensions.getContextMenuItems(webContents, params)
  }

  /**
   * 查询内容拦截是否**已生效**。
   */
  function isAdblockerEnabled() {
    return adblockerEnabled
  }

  /**
   * 查询**生效中**的拦截级别（未生效统一回 'off'）。
   * @returns {'off'|'ads'|'ads+tracking'}
   */
  function getAdblockerLevel() : 'off'|'ads'|'ads+tracking' {
    return adblockerEnabled && blockerLevel ? blockerLevel : 'off'
  }

  /**
   * 运行时热切换拦截**级别**（off / ads / ads+tracking）。
   *
   * 记的是**用户意图**：blocker 尚未就绪时（过滤列表还在后台下载）只更新意图并返回
   * 「已受理」，就绪时自动对齐 —— 这样「启动后立刻点盾牌」不会丢。级别变化需要
   * 重建过滤列表（下载在后台、按调用序串行执行），本方法**不等待**它完成。
   * @param {string} level
   * @returns {boolean} 是否受理（无法识别的级别 → false）
   */
  function setAdblockerLevel(level: string) : boolean {
    const normalized = normalizeAdblockerLevel(level)
    if (!normalized) return false
    const unchanged = normalized === adblockerLevel
    if (!unchanged) {
      adblockerLevel = normalized
      if (normalized !== 'off') adblockerLastActiveLevel = normalized
    }
    // 意图未变但尚未生效（例如上次列表下载失败）：本次调用即重试，而不是静默吞掉。
    if (unchanged && (normalized === 'off' || (blocker && adblockerEnabled))) return true
    const pending = queueAdblockerTask(applyAdblockerIntent)
    // 构造期就是 off（从未装配过 blocker）时，本次调用即首次初始化。
    if (adblockerReadyPromise === null) adblockerReadyPromise = pending
    return true
  }

  /**
   * 启用/禁用内容拦截（盾牌按钮的布尔口径）。
   *
   * 薄包装：`false` → `off`；`true` → 回到关闭前的级别（没有则用缺省全量）。
   * 需要级别能力请直接用 `setAdblockerLevel` —— 不在这里复制一套级别规则。
   * @param {boolean} enabled
   */
  function setAdblockerEnabled(enabled: boolean) {
    if (!enabled) return setAdblockerLevel('off')
    return setAdblockerLevel(adblockerLastActiveLevel || DEFAULT_ADBLOCKER_LEVEL)
  }

  // ── 启动恢复（后台跑，不阻塞 createExtensionService 返回）──────────────
  // 与 adblocker 同一处理方式：失败只记日志，绝不让它变成未处理的 rejection。
  const restorePromise = restore().catch((e) => {
    console.error('[infra-extensions] restore failed:', errorMessage(e))
    return { loaded: 0, disabled: 0, failed: 0 }
  })

  return {
    profileId: String(profileId || ''),
    session: extSession,
    extensionsPath: extDir,
    events,
    listExtensions,
    installFromPath,
    installFromCrx,
    installFromExternalDirectory,
    uninstall,
    toggle,
    setPinned,
    addTab,
    removeTab,
    selectTab,
    getContextMenuItems,
    isAdblockerEnabled,
    /** 生效中的拦截级别（off / ads / ads+tracking）。 */
    getAdblockerLevel,
    /** 运行时热切换拦截级别（按级别重建过滤列表，后台串行执行）。 */
    setAdblockerLevel,
    setAdblockerEnabled,
    getBlockedCount: () => blockedCount,
    getRuntimeStatus,
    getDiagnostics,
    getWarnings,
    getBrowserActionStates,
    getBrowserActionIconDataUrl,
    reload,
    /** 本地化消息（读盘）端口：app 层据 domain 排好的语言链取回消息表。 */
    getLocaleMessages,
    /** 目录大小（按需 + 缓存）端口：null = 无法测量（目录不存在 / 无权限）。 */
    getExtensionSize,
    /** 扩展图标字节（按 id 读清单 icons 里那一档文件）：null = 没有可用图标。 */
    getExtensionIconAsset,
    /** 扩展图标 data URL（主进程内联，UI 直接塞 `<img src>`）：'' = 无图标。 */
    getExtensionIconDataUrl,
    /** 按需确保扩展已加载（打开设置页 / 弹窗前的兜底）。 */
    ensureLoaded,
    getOptionsUrl,
    getPopupUrl,
    openPopup,
    closePopup,
    setPopupSupport,
    /** 可检查视图：收集实时后台上下文（原始数据；命名与可调试性由 domain 纯函数推导）。 */
    getInspectViewSources,
    /** 打开背景页的开发者工具（对齐 Chrome 扩展详情页的「检查视图」）。 */
    inspectView,
    /** 立即检查并安装所有扩展的可用更新（开发者模式工具条的「更新」）。 */
    updateAllExtensions,
    /** 扩展声明的新标签页覆盖地址（chrome_url_overrides.newtab），没有则空串。 */
    getNewTabOverrideUrl,
    /** 安装记录（含已停用）：管理页据此补全不在运行时的扩展的展示字段。 */
    listInstallRecords: () => installStore.list(),
    /**
     * 扩展清单（运行时优先 / 停用扩展回退安装快照）。
     * 暴露它是为了让 identity IPC 这类「按扩展 id 取能力配置」的调用方不必再走一遍
     * 运行时对象探测；清单是扩展能力的唯一真源。
     */
    getManifest,
    /**
     * `chrome.identity` 主进程服务（token 缓存 / Web Auth Flow / 登录态事件）。
     * 生命周期 = 本 profile 的 extensionService；preload 的 IPC 处理体只通过它取数。
     */
    identity,
    /** 启动恢复的进度（app 层可 await，用于日志 / 诊断）。 */
    whenReady: () => restorePromise,
    /** 等待安装记录写完；退出流程必须调用，避免最后一次启停状态丢在内存队列里。 */
    flush: () => installStore.flush(),
    destroy() {
      destroyed = true
      if (browserActionUpdateTimer) {
        clearTimeout(browserActionUpdateTimer)
        browserActionUpdateTimer = null
      }
      try { closePopup() } catch (_) {}
      try {
        for (const ext of extSession.extensions.getAllExtensions() as RuntimeExtension[]) {
          if (ext?.id) extSession.extensions.removeExtension(ext.id)
        }
      } catch (_) {}
      try { blocker?.disableBlockingInSession(extSession) } catch (_) {}
      blocker = null
      try { extensions.removeAllListeners() } catch (_) {}
      try { detachExtensionPreloads() } catch (_) {}
      try { identity.destroy() } catch (_) {}
      try { extSession.removeAllListeners() } catch (_) {}
      try { if (extSession.extensions) extSession.extensions.removeAllListeners() } catch (_) {}
      try { events.removeAllListeners() } catch (_) {}
      loadInFlight.clear()
      sizeInFlight.clear()
      iconInFlight.clear()
      browserActionIconCache.clear()
      browserActionIconCacheBytes = 0
    }
  }
}

module.exports = { createExtensionService }

export type ExtensionServiceInstance = Awaited<ReturnType<typeof createExtensionService>>


