/**
 * associations.mjs —— 「STAR Hira NitroGen 关联了哪些文件类型 / URL 协议」的**唯一事实源**。
 *
 * 这份清单被三处消费，任何一处都不许再抄一遍：
 *   1. 主进程运行时注册（apps/app-main/src/main/app/default-client.ts → HKCU）；
 *   2. 安装器注册（build/installer.nsh 的生成区 → HKCU + HKLM 候选）；
 *   3. 命令行入口判定（apps/app-main/src/main/app/urls.js：双击 .html 送进来的是本地路径）。
 *
 * ── schema 与三个参照实现对齐（不是自创）──────────────────────────────
 *   · 旧 Hira（`main.build.js#registryInstaller`）：`Software\Classes\<ProgId>` 下必须有
 *     `Application\{AppUserModelId,ApplicationName,ApplicationIcon}` —— 这是 Windows 把
 *     一个 ProgId 归属到「哪个已安装应用」的唯一凭据。缺了它，「默认应用」页只看到一个
 *     无名处理器：文件类型列不全、页首的「设为默认浏览器」点了也不会落到这些关联上。
 *   · Edge / Chrome / Vivaldi（本机实测的 HKCR）：同样有 `Application` 块，且把
 *     `.htm .html .mht .mhtml .shtml .xht .xhtml .svg .webp .pdf` 这一组登记进
 *     `Capabilities\FileAssociations`。
 *   · RT（`default-browser-controller/`）：`RegisteredApplications` +
 *     `Clients\StartMenuInternet\<Name>\Capabilities` 的落地方式。
 *
 * ── 两级关联（为什么不是一张平表）────────────────────────────────────
 * 「打开方式候选」和「可被一键设为默认」是两件事，混在一起会伤到用户：
 *   · document —— 浏览器本职的网页文档 / Web 图片：进 `Capabilities\FileAssociations`
 *     （= 用户点「设为默认浏览器」时会被一并接管），同时也进打开方式候选；
 *   · media    —— 浏览器能看、但不该抢系统默认播放器的类型（`.webm` 等）：**只**进
 *     打开方式候选。Chrome / Edge 同样不把视频类型写进 Capabilities。
 *
 * 纯数据 + 纯函数：不 require electron、不 require node:path，安装器生成脚本与
 * 主进程共用同一份，跑到渲染层/打包脚本里也不会炸。
 */

/** 应用显示名（写入 ApplicationName / DefaultIcon 描述 / 开始菜单客户端名）。 */
export const APP_NAME = 'STAR Hira NitroGen'

/** 发布者。Capabilities 与 ProgId 都写同一份，便于“默认应用”和旧式打开方式一致归类。 */
export const APP_COMPANY = 'STAR HigheriTech'

/** 默认应用列表里的一句话说明（Capabilities\ApplicationDescription）。 */
export const APP_DESCRIPTION = 'STAR Hira NitroGen — 快速、干净的现代浏览器'

/**
 * 应用身份（AppUserModelId）。
 *
 * 三处必须逐字一致，否则「默认应用」页认不出 ProgId 属于哪个应用、
 * 任务栏分组与通知归属也会分家：
 *   · 本文件写进 `Classes\<ProgId>\Application\AppUserModelId`；
 *   · 主进程 `app/setAppUserModelId`（app/preboot.js 直接引用这个常量）；
 *   · 安装器快捷方式的 AUMID（build/installer.nsh 用 electron-builder 的 ${APP_ID}）。
 * 取值 = package.json `build.appId`。
 */
export const APP_AUMID = 'com.starhigheritech.hira-ng'

/** 文件类型的 progid（RT 里的 `%APP_NAME_SHORT%File`）。 */
export const APP_PROGID_FILE = 'HiraNGFile'

/** URL 协议的 progid（RT 里的 `%APP_NAME_SHORT%URL`）。 */
export const APP_PROGID_URL = 'HiraNGURL'

/**
 * 一个关联能力贡献。
 *
 * 这是系统关联层的扩展接口：文件类型 / 协议由“能力贡献”声明，注册表计划只负责
 * 把快照翻译成键值。以后新增 Web 文档、阅读器或应用协议时，只增加一项贡献，
 * 不需要在运行时注册、安装器生成、入口判定三处各补一遍条件。
 *
 * - `document` 会进入默认可接管能力；`media` 只进入“打开方式”候选；
 * - `defaultBrowser` 为 true 的协议才参与“是否默认浏览器”的判定。
 */
export interface AssociationFileKind {
  ext: string
  tier: 'document' | 'media'
}

export interface AssociationProtocol {
  scheme: string
  defaultBrowser: boolean
}

export interface AssociationContribution {
  id: string
  files?: readonly AssociationFileKind[]
  protocols?: readonly AssociationProtocol[]
}

/**
 * STAR Hira NitroGen 自带的 Web 浏览器能力。
 *
 * 清单与 Edge / Chrome / Vivaldi 的公开 Capabilities 对齐。浏览器生态里的
 * ftp / mailto / tel / webcal 等旧协议也要作为候选出现在系统列表里，但它们
 * 不参与“是否默认浏览器”的判定，也不写用户级协议回退命令。清单是能力声明，
 * 不是平台逻辑；新增类型只扩展这里。
 */
export const WEB_BROWSER_ASSOCIATION = Object.freeze({
  id: 'web-browser',
  files: Object.freeze([
    { ext: '.htm', tier: 'document' },
    { ext: '.html', tier: 'document' },
    { ext: '.mht', tier: 'document' },
    { ext: '.mhtml', tier: 'document' },
    { ext: '.shtml', tier: 'document' },
    { ext: '.xht', tier: 'document' },
    { ext: '.xhtm', tier: 'document' },
    { ext: '.xhtml', tier: 'document' },
    { ext: '.svg', tier: 'document' },
    { ext: '.svgz', tier: 'document' },
    { ext: '.webp', tier: 'document' },
    { ext: '.avif', tier: 'document' },
    { ext: '.xml', tier: 'document' },
    { ext: '.pdf', tier: 'document' },
    // 视频只获得“打开方式”候选，不抢用户的默认播放器。
    { ext: '.webm', tier: 'media' }
  ] as const),
  protocols: Object.freeze([
    { scheme: 'http', defaultBrowser: true },
    { scheme: 'https', defaultBrowser: true },
    { scheme: 'ftp', defaultBrowser: false },
    { scheme: 'irc', defaultBrowser: false },
    { scheme: 'mailto', defaultBrowser: false },
    { scheme: 'mms', defaultBrowser: false },
    { scheme: 'news', defaultBrowser: false },
    { scheme: 'nntp', defaultBrowser: false },
    { scheme: 'read', defaultBrowser: false },
    { scheme: 'sms', defaultBrowser: false },
    { scheme: 'smsto', defaultBrowser: false },
    { scheme: 'snews', defaultBrowser: false },
    { scheme: 'tel', defaultBrowser: false },
    { scheme: 'urn', defaultBrowser: false },
    { scheme: 'webcal', defaultBrowser: false },
    { scheme: 'webcals', defaultBrowser: false }
  ] as const)
}) satisfies Readonly<AssociationContribution>

/** 当前允许发布的全部能力；插件 / 未来模块可在这里追加贡献。 */
export const ASSOCIATION_CONTRIBUTIONS: readonly Readonly<AssociationContribution>[] = Object.freeze([
  WEB_BROWSER_ASSOCIATION
])

const runtimeContributions: AssociationContribution[] = []
let runtimeVersion = 0
let cachedVersion = -1
let cachedSnapshot: ReturnType<typeof composeAssociations> | null = null

/**
 * 运行期追加一个关联贡献。返回注销函数，插件卸载时调用即可完整回退。
 * 注册表写入与双击文件入口共用这份快照，不会出现“系统里有、应用里不认”的分裂。
 */
export function registerAssociationContribution(
  contribution: AssociationContribution
): () => void {
  const id = String(contribution?.id || '').trim()
  if (!id) throw new Error('关联贡献必须有 id')
  if (ASSOCIATION_CONTRIBUTIONS.some((item) => item.id === id)) {
    throw new Error(`关联贡献 id 与内建能力重名：${id}`)
  }
  const previousIndex = runtimeContributions.findIndex((item) => item.id === id)
  if (previousIndex >= 0) runtimeContributions.splice(previousIndex, 1)
  const frozen = Object.freeze({
    id,
    files: Object.freeze([...(contribution.files || [])]),
    protocols: Object.freeze([...(contribution.protocols || [])])
  })
  runtimeContributions.push(frozen)
  runtimeVersion++

  return () => {
    const index = runtimeContributions.indexOf(frozen)
    if (index < 0) return
    runtimeContributions.splice(index, 1)
    runtimeVersion++
  }
}

/** 当前内建 + 运行期贡献（内建始终在前，运行期按注册顺序）。 */
export function listAssociationContributions(): readonly Readonly<AssociationContribution>[] {
  return Object.freeze([...ASSOCIATION_CONTRIBUTIONS, ...runtimeContributions])
}

/**
 * 把多个关联贡献合成去重后的能力快照。
 * 同扩展名出现多次时 document 优先；同协议出现多次时 defaultBrowser 取并集。
 */
export function composeAssociations(
  contributions: readonly Readonly<AssociationContribution>[] = ASSOCIATION_CONTRIBUTIONS
): { files: ReadonlyArray<AssociationFileKind>; protocols: ReadonlyArray<AssociationProtocol> } {
  const files = new Map<string, AssociationFileKind>()
  const protocols = new Map<string, AssociationProtocol>()

  for (const contribution of contributions) {
    for (const item of contribution.files || []) {
      const ext = String(item.ext || '').trim().toLowerCase()
      if (!ext.startsWith('.')) continue
      const previous = files.get(ext)
      files.set(ext, {
        ext,
        tier: previous?.tier === 'document' || item.tier === 'document' ? 'document' : 'media'
      })
    }
    for (const item of contribution.protocols || []) {
      const scheme = String(item.scheme || '').trim().toLowerCase().replace(/:+$/, '')
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) continue
      protocols.set(scheme, {
        scheme,
        defaultBrowser: Boolean(protocols.get(scheme)?.defaultBrowser || item.defaultBrowser)
      })
    }
  }

  return Object.freeze({
    files: Object.freeze(Array.from(files.values())),
    protocols: Object.freeze(Array.from(protocols.values()))
  })
}

/** 当前生效的能力快照；注册 / 注销贡献后自动失效重算。 */
export function getAssociationSnapshot(): ReturnType<typeof composeAssociations> {
  if (cachedSnapshot && cachedVersion === runtimeVersion) return cachedSnapshot
  cachedVersion = runtimeVersion
  cachedSnapshot = composeAssociations(listAssociationContributions())
  return cachedSnapshot
}

const ASSOCIATION_SNAPSHOT = getAssociationSnapshot()

/** 默认浏览器要接管的协议。 */
export const URL_SCHEMES = Object.freeze(
  ASSOCIATION_SNAPSHOT.protocols.filter((item) => item.defaultBrowser).map((item) => item.scheme)
)

/** 当前快照中参与“默认浏览器”判定的协议（运行期贡献会即时反映）。 */
export function getDefaultBrowserSchemes(): readonly string[] {
  return Object.freeze(
    getAssociationSnapshot().protocols.filter((item) => item.defaultBrowser).map((item) => item.scheme)
  )
}

/** 当前快照中可交给本应用打开的全部扩展名。 */
export function getAssociatedExtensions(): readonly string[] {
  return Object.freeze(getAssociationSnapshot().files.map((item) => item.ext))
}

/** 不带参数的「默认应用」总览页（深链打不开时的兜底）。 */
export const DEFAULT_APPS_SETTINGS_URI = 'ms-settings:defaultapps'

/**
 * 关联 schema 指纹的落地位置（HKCU）。
 *
 * 为什么要一个指纹：运行时的「已登记过」自检只能覆盖几个关键路径（exe 路径、
 * 几条 open 命令），**感知不到清单或 schema 本身变了**。上一版就吃在这里：
 * 清单从 7 个扩展名扩到 14 个、ProgId 补了 `Application` 身份块之后，老机器
 * 因为自检短路而永远不重写，界面里看不到新增的 .svg / .webp / .webm。
 *
 * 指纹只对「键名 + 值名 + 值类型」做散列（**不含**值内容）：
 *   · 扩展名 / ProgId / Application 块任何一处变动 → 指纹变 → 下次启动整体重写；
 *   · exe 路径变动不参与指纹（由自检里的命令行比对负责），否则安装器写的指纹
 *     （`$INSTDIR\...` 表达式）与运行时真实路径永远对不上。
 */
export const SCHEMA_MARKER_KEY = 'Software\\HiraNG\\Associations'

/** 指纹值名。 */
export const SCHEMA_MARKER_NAME = 'SchemaFingerprint'

/**
 * FNV-1a 32 位散列 → 8 位十六进制。
 * 纯 JS、无 node:crypto：本模块要被渲染层 / NSIS 生成脚本共用，不能引入平台依赖。
 * @param {string} text
 * @returns {string}
 */
function fnv1a(text: string) : string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 计算一组写入计划的 schema 指纹（结构，不含值内容 —— 理由见 SCHEMA_MARKER_KEY）。
 *
 * `exeName` 会在参与散列前被归一成占位符：安装器生成时 exe 名是 NSIS 表达式
 * （`${APP_EXECUTABLE_FILENAME}`），运行时是真名（`STAR Hira NitroGen.exe`），不归一的话
 * 同一份 schema 会算出两个指纹 —— 安装完每次启动都会白白重写 73 条注册表。
 *
 * @param {Array<{ key: string, name: string, type: string }>} entries
 * @param {string} [exeName] 归一用：出现在键名里的 exe 文件名
 * @returns {string}
 */
export function registryPlanFingerprint(entries: Array<{ key: string, name: string, type: string }>, exeName: string = '') : string {
  const shape = entries
    .map((entry) => {
      const key = exeName ? entry.key.split(exeName).join('$EXE') : entry.key
      return `${key}|${entry.name}|${entry.type}`
    })
    .join('\n')
  return fnv1a(shape)
}

/**
 * 「默认应用」里**本应用专属**的那个页面（Win10 1903+ / Win11）。
 *
 * 为什么不用总览页：`ms-settings:defaultapps` 在 Win11 上只有一张应用列表，
 * 用户还得自己搜到 STAR Hira NitroGen、点进详情、再逐个把 http/https 改成 STAR Hira NitroGen —— 三步。
 * 带上 `registeredAppUser` 后直接落到 STAR Hira NitroGen 自己的页面：页首就是
 * 「将 STAR Hira NitroGen 设置为默认浏览器」，一次点选搞定全部（Chrome / Firefox 同款做法）。
 *
 * 参数必须与 `Software\RegisteredApplications` 下的**值名逐字一致**（这里就是 APP_NAME）；
 * 旧系统不认识这个参数时会忽略它、退回总览页，所以不需要按版本分支。
 *
 * @param {string} [appName] RegisteredApplications 里的值名
 * @returns {string}
 */
export function defaultAppsSettingsUri(appName: string = APP_NAME) : string {
  return `${DEFAULT_APPS_SETTINGS_URI}?registeredAppUser=${encodeURIComponent(appName)}`
}

/**
 * 「设为默认浏览器」这个动作的**展示契约**（按钮文案 / 回读节奏 / 提示语）。
 *
 * 两个入口必须逐字一致：设置页的 `app.default_browser`（schema 的 action 字段）
 * 与 OOBE 阶段 4。它们调的是同一对 IPC 路由，若文案 / 回读间隔各写一套，
 * 用户看到的就是「同一颗按钮，两个页面说法不一样」。
 *
 * 路由不在这里 —— 那是 IPC 契约（ipc-channels.mjs），两边各自从那里取，
 * 本对象只管「怎么呈现」。
 *
 * @type {Readonly<{
 *   runLabel: string, doneLabel: string, poll: number,
 *   toastPending: string, toastDone: string
 * }>}
 */
export const DEFAULT_BROWSER_ACTION: Readonly<{
  runLabel: string, doneLabel: string, poll: number,
  toastPending: string, toastDone: string
}> = Object.freeze({
  runLabel: '设为默认浏览器',
  doneLabel: '已是默认浏览器',
  /** 点击后状态还没翻转时的回读间隔（ms）—— 确认发生在系统设置，本进程收不到通知。 */
  poll: 2000,
  /** 回执仍未变成「默认」时的说明：接管是静默做的，这里只是「万一没生效怎么办」。 */
  toastPending: '文件类型与 http/https 已静默接管；若状态仍未刷新，可在「默认应用」页确认一次',
  /** 回执确认已成为默认时的提示。 */
  toastDone: '已设为默认浏览器'
})

/**
 * 登记的文件类型（带点、小写）。`tier` 决定它属于上面说的哪一级，见文件头。
 * 清单口径 = Edge / Chrome / Vivaldi 在 HKCR 里声明的那一组（不含它们的私有协议）。
 */
export const FILE_ASSOCIATIONS = ASSOCIATION_SNAPSHOT.files

/** 全部登记过的扩展名（打开方式候选 / 命令行入口判定用）。 */
export const ASSOCIATED_EXTENSIONS = Object.freeze(FILE_ASSOCIATIONS.map((item) => item.ext))

/** 可被「设为默认浏览器」一并接管的扩展名（Capabilities\FileAssociations）。 */
export const DEFAULT_CAPABLE_EXTENSIONS = Object.freeze(
  FILE_ASSOCIATIONS.filter((item) => item.tier === 'document').map((item) => item.ext)
)

/**
 * 静默接管（**运行期**）：点「设为默认浏览器」时直接改写 UserChoice 的那一组。
 *
 * ── 机制（本机实测，Windows 11 22631）────────────────────────────
 * 默认程序的最终答案在
 *   `HKCU\...\Explorer\FileExts\<ext>\UserChoice`（文件类型）
 *   `HKCU\...\Shell\Associations\UrlAssociations\<scheme>\UserChoice`（协议）
 * 里，`ProgId` 旁边那个 `Hash` 是系统算的校验值。它**能算**（算法见
 * `main/app/user-choice.js`，用系统自己写下的四条 UserChoice 回算逐字节吻合）：
 * 写出合法 Hash 之后系统照常认账，也不会像「删掉 UserChoice」那样被守护进程
 * 几秒内抢回（`.htm/.html` 实测 15 秒零回退）。
 *
 * 键上那条 `Deny(SetValue)` ACE 挡的是「当前用户写值」，但它允许
 * `ChangePermissions`，所以「先摘 Deny、再删键、重建」普通权限即可完成，无需提权。
 * 接管只改「默认交给谁」，**不动**任何应用在「打开方式」里的候选条目。
 *
 * ── 为什么是这 10 个 ──────────────────────────────────────────
 * 8 个 HTML 文档族 + http/https：只有浏览器会碰，接管符合用户预期。
 * `.svg` / `.webp` / `.pdf` 这类多用途类型不在列内 —— 抢它们等于连用户的
 * 看图 / 阅读默认程序一起改掉。
 *
 * @type {ReadonlyArray<{ kind: 'file'|'url', key: string }>}
 */
export const USER_CHOICE_TARGETS: ReadonlyArray<{ kind: 'file'|'url', key: string }> = Object.freeze([
  { kind: 'file', key: '.htm' },
  { kind: 'file', key: '.html' },
  { kind: 'file', key: '.mht' },
  { kind: 'file', key: '.mhtml' },
  { kind: 'file', key: '.shtml' },
  { kind: 'file', key: '.xht' },
  { kind: 'file', key: '.xhtm' },
  { kind: 'file', key: '.xhtml' },
  { kind: 'url', key: 'http' },
  { kind: 'url', key: 'https' }
])

/**
 * 安装期的候选收敛清单（**兜底**，不是接管主路径）。
 *
 * 安装器（NSIS）跑在提权上下文里，算不了 Hash，只能做旧的「删 UserChoice +
 * 清候选 + 写 `HKCR\.ext` 默认值」这一套。它对**还没有 UserChoice 的机器**有效；
 * 已经有 UserChoice 的机器由运行期的 `USER_CHOICE_TARGETS` 精确改写。
 * 这里只放 HTML 文档族：清候选会削掉别的应用在「打开方式」里的条目，
 * 对 `.htm` / `.html` 这种候选很挤的类型代价太大 —— 它们交给运行期接管。
 */
export const SILENT_ADOPT_EXTENSIONS = Object.freeze([
  '.mht',
  '.mhtml',
  '.shtml',
  '.xht',
  '.xhtm',
  '.xhtml'
])


/**
 * 是否是我们登记过的文件类型。
 * @param {unknown} ext 带不带点都行（`.html` / `html` / `HTML`）
 * @returns {boolean}
 */
export function isAssociatedExtension(ext: unknown) : boolean {
  const raw = String(ext == null ? '' : ext).trim().toLowerCase()
  if (!raw) return false
  const normalized = raw.startsWith('.') ? raw : `.${raw}`
  return getAssociationSnapshot().files.some((item) => item.ext === normalized)
}

/**
 * 这个路径是不是我们登记过的文件类型（只看扩展名，不碰磁盘）。
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isAssociatedFilePath(filePath: unknown) : boolean {
  const text = String(filePath == null ? '' : filePath)
  const dot = text.lastIndexOf('.')
  if (dot < 0) return false
  const tail = text.slice(dot)
  // 路径分隔符出现在点之后 → 说明这个点属于目录名，不是文件扩展名。
  if (/[\\/]/.test(tail)) return false
  return isAssociatedExtension(tail)
}

export interface RegistryPlanEntry {
  key: string
  name: string
  type: 'REG_SZ' | 'REG_DWORD'
  value: string | number
  /** 写入位置。运行期只写用户级；安装器会额外发布一份机器级候选。 */
  scope: 'user' | 'machine'
}

/** Windows 路径的父目录；只用于生成 App Paths\Path，不依赖 node:path。 */
function parentOfWindowsPath(value: string): string {
  const text = String(value || '')
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return cut > 0 ? text.slice(0, cut) : ''
}

/**
 * 生成「把本应用登记到当前用户」所需的注册表写入计划。
 *
 * 计划是**平台无关的数据**（scope / key / name / type / value），由调用方决定怎么落地：
 *   · 主进程 → `reg.exe add`；
 *   · 安装器 → 生成 NSIS `WriteRegStr`（见 scripts/gen-associations.cjs）。
 *
 * 「登记」与「接管默认」是两件事，这里**只做前者**：`Software\Classes\.ext` 的
 * 默认值不在本计划里（那会变成装完即抢默认）。接管交给运行期的
 * `USER_CHOICE_TARGETS`（写合法 Hash，见 apps/app-main/src/main/app/user-choice.js），
 * 安装期只做 HTML 文档族的候选收敛兜底（`SILENT_ADOPT_EXTENSIONS`）。
 * 这里只做三件正确的事：
 *   · `OpenWithProgids` / `SupportedTypes` → 「打开方式」列表里出现 STAR Hira NitroGen；
 *   · `RegisteredApplications` + Capabilities → 「默认应用」里出现 STAR Hira NitroGen；
 *   · ProgId 的 `Application` 身份块 → 系统知道这些 ProgId 属于哪个应用。
 *
 * @param {{
 *   exePath: string,
 *   exeName: string,
 *   appName?: string,
 *   description?: string,
 *   aumid?: string,
 *   scope?: 'user'|'machine',
 *   associations?: readonly AssociationContribution[]
 * }} opts
 * @returns {RegistryPlanEntry[]}
 */
export function buildRegistryPlan({
  exePath,
  exeName,
  exeDir,
  appName = APP_NAME,
  description = APP_DESCRIPTION,
  aumid = APP_AUMID,
  scope = 'user',
  associations
}: {
  exePath?: string
  exeName?: string
  exeDir?: string
  appName?: string
  description?: string
  aumid?: string
  scope?: 'user' | 'machine'
  associations?: readonly AssociationContribution[]
} = {}): RegistryPlanEntry[] {
  if (!exePath || !exeName) throw new Error('buildRegistryPlan 需要 exePath / exeName')

  const snapshot = composeAssociations(associations || listAssociationContributions())
  const associatedExtensions = snapshot.files.map((item) => item.ext)
  const defaultCapableExtensions = snapshot.files
    .filter((item) => item.tier === 'document')
    .map((item) => item.ext)
  const urlSchemes = snapshot.protocols.map((item) => item.scheme)
  const defaultBrowserSchemes = snapshot.protocols
    .filter((item) => item.defaultBrowser)
    .map((item) => item.scheme)
  const entries: RegistryPlanEntry[] = []
  /** 写一个值：name 为空串 = 写键的默认值。 */
  const put = (key: string, name: string, value: string | number, type: RegistryPlanEntry['type'] = 'REG_SZ'): number =>
    entries.push({ key, name, value, type, scope })

  const classes = 'Software\\Classes'
  const icon = `"${exePath}",0`
  // 显式标记外部关联启动：允许运行期把 peers 动态发现的新扩展名交给本地文件入口，
  // 同时普通命令行仍维持原来的严格路径白名单，避免任意 argv 被当成文件打开。
  const command = `"${exePath}" --open-associated "%1"`
  // 开始菜单的 Internet 客户端入口「只是启动应用」，不带 %1（Edge / Chrome / Vivaldi 同款）。
  const launchCommand = `"${exePath}"`

  /**
   * 一个 ProgId 的完整骨架 —— 文件 / URL 两类共用，唯一的差别由调用方补。
   * `Application` 块缺一不可，理由见文件头。
   */
  const defineProgId = (progId: string, label: string): void => {
    put(`${classes}\\${progId}`, '', label)
    // 根上这一格 Edge / Vivaldi 也写：部分外壳（跳转列表、旧控制面板）只读这里。
    put(`${classes}\\${progId}`, 'AppUserModelId', aumid)
    put(`${classes}\\${progId}\\Application`, 'AppUserModelId', aumid)
    put(`${classes}\\${progId}\\Application`, 'ApplicationName', appName)
    put(`${classes}\\${progId}\\Application`, 'ApplicationCompany', APP_COMPANY)
    put(`${classes}\\${progId}\\Application`, 'ApplicationIcon', icon)
    put(`${classes}\\${progId}\\Application`, 'ApplicationDescription', description)
    put(`${classes}\\${progId}\\DefaultIcon`, '', icon)
    put(`${classes}\\${progId}\\shell\\open\\command`, '', command)
  }

  // ── ① 文件 progid：双击 .html 时系统实际执行的那条命令 ──────────────
  defineProgId(APP_PROGID_FILE, `${appName} Document`)

  // ── ② URL progid：http/https 被选为默认后系统调用的命令 ─────────────
  defineProgId(APP_PROGID_URL, `${appName} Protocol`)
  // `URL Protocol`（空值）是「这个 ProgId 是协议处理器」的标记；FriendlyTypeName 是它的显示名。
  put(`${classes}\\${APP_PROGID_URL}`, 'FriendlyTypeName', `${appName} Protocol`)
  put(`${classes}\\${APP_PROGID_URL}`, 'URL Protocol', '')

  // ── ③ 扩展与协议都登记到「打开方式」（只加候选，不改默认）─────────
  for (const ext of associatedExtensions) {
    put(`${classes}\\${ext}\\OpenWithProgids`, APP_PROGID_FILE, '')
  }
  for (const scheme of urlSchemes) {
    put(`${classes}\\${scheme}\\OpenWithProgids`, APP_PROGID_URL, '')
  }

  // ── ④ 默认应用列表入口 ─────────────────────────────────────────────
  put('Software\\RegisteredApplications', appName, `Software\\Clients\\StartMenuInternet\\${appName}\\Capabilities`)

  // ── ⑤ StartMenuInternet 客户端（RT bat 的同款 schema）────────────────
  const client = `Software\\Clients\\StartMenuInternet\\${appName}`
  put(client, '', appName)
  put(`${client}\\DefaultIcon`, '', icon)
  put(`${client}\\shell\\open\\command`, '', launchCommand)
  put(`${client}\\InstallInfo`, 'IconsVisible', 1, 'REG_DWORD')
  put(`${client}\\Capabilities`, 'ApplicationIcon', icon)
  put(`${client}\\Capabilities`, 'ApplicationName', appName)
  put(`${client}\\Capabilities`, 'ApplicationCompany', APP_COMPANY)
  put(`${client}\\Capabilities`, 'ApplicationDescription', description)
  put(`${client}\\Capabilities\\StartMenu`, 'StartMenuInternet', appName)
  // 只有 document 档进这里：Capabilities 的每一项都会被「设为默认浏览器」一键接管。
  for (const ext of defaultCapableExtensions) {
    put(`${client}\\Capabilities\\FileAssociations`, ext, APP_PROGID_FILE)
  }
  for (const scheme of urlSchemes) {
    put(`${client}\\Capabilities\\URLAssociations`, scheme, APP_PROGID_URL)
  }

  // ── ⑥ 「打开方式」里的独立条目（不依赖扩展名也能列出本应用）─────────
  put(`${classes}\\Applications\\${exeName}`, 'FriendlyAppName', appName)
  put(`${classes}\\Applications\\${exeName}\\shell\\open\\command`, '', command)
  // Win11 的「打开方式 → 选择其他应用」在部分版本上优先枚举 SupportedTypes：
  // 即便某个 `.ext\OpenWithProgids` 被别的安装器洗掉，这里仍能让 STAR Hira NitroGen 出现在候选里。
  for (const ext of associatedExtensions) {
    put(`${classes}\\Applications\\${exeName}\\SupportedTypes`, ext, '')
  }

  // ── ⑦ 协议回退键（旧式浏览器注册，UserChoice 缺失 / 失效时系统回落到这里）──
  // 为什么必须写：开发态跑 Electron 时 `app.setAsDefaultProtocolClient('http')` 会把
  // 这两条写成 `...\node_modules\electron\dist\electron.exe "%1"`。打包后若不管它们，
  // 一旦 UserChoice 被系统重置（重装 / 被别的应用改写），点链接就落到开发态
  // electron.exe —— 那是个没有 app 路径的启动，于是弹出「Electron」空白窗口。
  // 写回真实 exe 后，无论走 UserChoice 还是回退键，落到都是 STAR Hira NitroGen。
  // 机器级清单只负责“让系统在默认应用里看见 STAR Hira NitroGen”。绝不能把回退命令也写成
  // 机器级：那会在没有 UserChoice 的账户上直接替所有用户接管链接。真正的默认
  // 选择仍由用户级 UserChoice（或用户点击系统设置）决定。
  if (scope === 'user') {
    for (const scheme of defaultBrowserSchemes) {
      put(`${classes}\\${scheme}\\shell\\open\\command`, '', command)
    }
  }

  // ── ⑧ App Paths：Win+R / 快速打开 / 旧式“运行”对话框直接输入 STAR Hira NitroGen ─────
  // 这不改变文件默认项，只把“STAR Hira NitroGen.exe 在哪里”告诉外壳。开发态永远不写。
  const appPathKey = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
  const resolvedExeDir = String(exeDir || parentOfWindowsPath(exePath))
  put(appPathKey, '', exePath)
  if (resolvedExeDir) put(appPathKey, 'Path', resolvedExeDir)
  put(appPathKey, 'DefaultIcon', icon)
  for (const scheme of defaultBrowserSchemes) {
    put(`${appPathKey}\\SupportedProtocols`, scheme, '')
  }

  // ── ⑨ 幂等自检指纹（必须在其它条目全部就位之后算）────────────────────
  const fingerprint = registryPlanFingerprint(entries, exeName)
  put(SCHEMA_MARKER_KEY, SCHEMA_MARKER_NAME, fingerprint)

  return entries
}

/**
 * 生成卸载清理计划（安装器卸载时执行；运行时不调用）。
 *
 * 只删自己写过的东西：progid 键、Capabilities、RegisteredApplications 的值、
 * 每个扩展 OpenWithProgids 里属于我们的那一项。
 * 绝不整键删除 `.ext`（那会连带删掉别的应用的候选）。
 *
 * @param {{
 *   exeName: string,
 *   appName?: string,
 *   scope?: 'user'|'machine',
 *   associations?: readonly AssociationContribution[]
 * }} opts
 * @returns {Array<{ type: 'deleteValue', key: string, name: string } | { type: 'deleteKey', key: string }>}
 */
export function buildUnregisterPlan({
  exeName,
  appName = APP_NAME,
  scope = 'user',
  associations
}: {
  exeName?: string
  appName?: string
  scope?: 'user' | 'machine'
  associations?: readonly AssociationContribution[]
} = {}) : Array<
  { type: 'deleteValue'; key: string; name: string; scope: 'user'|'machine' }
  | { type: 'deleteKey'; key: string; scope: 'user'|'machine' }
> {
  if (!exeName) throw new Error('buildUnregisterPlan 需要 exeName')

  const snapshot = composeAssociations(associations || listAssociationContributions())
  const associatedExtensions = snapshot.files.map((item) => item.ext)
  const urlSchemes = snapshot.protocols.map((item) => item.scheme)
  /** @type {Array<{ type: 'deleteValue', key: string, name: string } | { type: 'deleteKey', key: string }>} */
  const ops: Array<
    { type: 'deleteValue'; key: string; name: string; scope: 'user'|'machine' }
    | { type: 'deleteKey'; key: string; scope: 'user'|'machine' }
  > = []

  ops.push({ type: 'deleteValue', key: 'Software\\RegisteredApplications', name: appName, scope })
  for (const ext of associatedExtensions) {
    ops.push({ type: 'deleteValue', key: `Software\\Classes\\${ext}\\OpenWithProgids`, name: APP_PROGID_FILE, scope })
  }
  for (const scheme of urlSchemes) {
    ops.push({ type: 'deleteValue', key: `Software\\Classes\\${scheme}\\OpenWithProgids`, name: APP_PROGID_URL, scope })
  }
  if (scope === 'user') {
    // 协议回退键只删自己写的值（键本身可能还被别的应用使用）。
    for (const scheme of urlSchemes) {
      ops.push({ type: 'deleteValue', key: `Software\\Classes\\${scheme}\\shell\\open\\command`, name: '', scope })
    }
  }
  for (const key of [
    `Software\\Classes\\${APP_PROGID_FILE}`,
    `Software\\Classes\\${APP_PROGID_URL}`,
    `Software\\Clients\\StartMenuInternet\\${appName}`,
    `Software\\Classes\\Applications\\${exeName}`,
    `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    SCHEMA_MARKER_KEY
  ]) {
    ops.push({ type: 'deleteKey', key, scope })
  }

  return ops
}
