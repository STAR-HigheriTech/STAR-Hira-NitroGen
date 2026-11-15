/**
 * app/default-client.ts —— Windows「默认浏览器 / 文件关联」的**唯一写入点**。
 *
 * 对应 RT：
 *   · src/main/controllers/default-browser-controller/index.ts（对外两个动作）；
 *   · windows-handler.ts + assets/default-app/register_app_user_template.bat
 *     （真正的注册表 schema，已收口到 shared-types/src/associations.mjs）。
 *
 * ── 两件事，分两个函数 ─────────────────────────────────────────────
 *   1. `registerDefaultClient()` —— **登记为候选**：OpenWithProgids +
 *      RegisteredApplications + Capabilities，让系统认识这些 ProgId；
 *   2. `adoptFileAssociationsQuietly()` —— **静默接管**：给 `UserChoice` 写一个
 *      合法 `Hash`（算法见 `app/user-choice.ts`，用系统自己写下的 4 条 UserChoice
 *      回算逐字节吻合），系统照常认账，`.htm/.html/http/https` 实测 15 秒零回退。
 * 所以「登记成功」≠「已是默认」；状态一律以 UserChoice 的真实回读为准。
 * 打开「默认应用」设置页仍然保留：接管是静默做的，设置页只是给用户一个看得见
 * 的确认入口（也覆盖被组策略 / UCPD 拦住的机器）。
 *
 * ── 为什么要回读 UserChoice，而不是 app.isDefaultProtocolClient ──────
 * Electron 的 `isDefaultProtocolClient` 在 Windows 上看的是自己写的
 * `HKCU\Software\Classes\<scheme>`，那是**我们自己写的键**，恒为真 —— 等于自问自答。
 * 只有 `...\Shell\Associations\UrlAssociations\<scheme>\UserChoice\ProgId` 是系统认可
 * 的答案。RT 干脆恒返回 false（用户永远看到「未设置」），这里改成如实回读。
 *
 * ── 与安装器的关系 ────────────────────────────────────────────────
 * build/installer.nsh 在安装时写同一套键（生成区），保证「装完不启动也能在
 * 打开方式里看到 STAR Hira NitroGen」；启动后这里再幂等校正一次，覆盖「换目录覆盖安装 /
 * 绿色运行」导致 exe 路径变化的情况。
 *
 * ── 开发态一律不碰系统 ────────────────────────────────────────────
 * 本模块的**每一个**对外能力（查询状态 / 登记 / 静默接管 / 打开默认应用设置页）
 * 都先过 `isPackagedRuntime()`（唯一判据，见 app/runtime-mode.js）。
 * 开发态的 exe 是 electron.exe：写进去就是把「所有链接交给 Electron 空白窗」，
 * 而且清理成本极高。宁可整体关闭，也不做「开发态也登记一下试试」。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import { minuteStamp, userChoiceHash, userChoiceKeyPath, type UserChoiceTarget } from './user-choice'
import { isPackagedRuntime } from './runtime-mode'
import { getRuntimeIdentity } from './runtime-identity'

interface RegistryPlanEntry {
  key: string
  name: string
  type: string
  value: string | number
  scope?: 'user' | 'machine'
}

interface RegistryPlanOptions {
  exePath: string
  exeName: string
  exeDir?: string
  appName: string
  description: string
}

interface AdoptScriptItem {
  path: string
  progId: string
  hash: string
  toast: string
}

interface UserChoiceWriteItem extends AdoptScriptItem, UserChoiceTarget {}

interface AdoptResult { adopted: string[]; skipped: string[] }

interface RuntimeAssociationContribution {
  id: string
  files: Array<{ ext: string; tier: 'document' | 'media' }>
  protocols: Array<{ scheme: string; defaultBrowser: boolean }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
const {
  APP_NAME,
  APP_DESCRIPTION,
  APP_PROGID_FILE,
  APP_PROGID_URL,
  getDefaultBrowserSchemes,
  DEFAULT_APPS_SETTINGS_URI,
  defaultAppsSettingsUri,
  SCHEMA_MARKER_KEY,
  SCHEMA_MARKER_NAME,
  USER_CHOICE_TARGETS,
  buildRegistryPlan,
  registerAssociationContribution
} = require('@hira-ng/shared-types/src/associations.mjs') as {
  APP_NAME: string
  APP_DESCRIPTION: string
  APP_PROGID_FILE: string
  APP_PROGID_URL: string
  getDefaultBrowserSchemes(): readonly string[]
  DEFAULT_APPS_SETTINGS_URI: string
  defaultAppsSettingsUri(appName: string): string
  SCHEMA_MARKER_KEY: string
  SCHEMA_MARKER_NAME: string
  USER_CHOICE_TARGETS: readonly UserChoiceTarget[]
  buildRegistryPlan(options: RegistryPlanOptions): RegistryPlanEntry[]
  registerAssociationContribution(contribution: RuntimeAssociationContribution): () => void
}
const {
  createAssociationSurface,
  parseBrowserAssociationSurface,
  associationContributionFromSurface
} = require('@hira-ng/shared-types/src/association-discovery.mjs') as {
  createAssociationSurface(): { files: Set<string>; protocols: Set<string> }
  parseBrowserAssociationSurface(
    output: string,
    surface: { files: Set<string>; protocols: Set<string> },
    excludedApp: string
  ): { files: Set<string>; protocols: Set<string> }
  associationContributionFromSurface(
    surface: { files: Set<string>; protocols: Set<string> },
    id?: string
  ): RuntimeAssociationContribution
}

/** 文件类型 UserChoice 所在的树（`...\FileExts\<ext>\UserChoice`）。 */
const FILE_EXTS_ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'

/** 协议 UserChoice 所在的树（`...\UrlAssociations\<scheme>\UserChoice`）。 */
const URL_ASSOC_ROOT = 'Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations'

const REG_EXE = path.join(
  process.env.SystemRoot || process.env.windir || 'C:\\Windows',
  'System32',
  'reg.exe'
)

/** 用户级（HKCU）注册表根 —— 全部写入都限定在当前用户，不需要管理员权限。 */
const HKCU = 'HKCU'

/** 浏览器 peers 的标准客户端入口；未知能力也从这里动态并集。 */
const BROWSER_CLIENTS_ROOT = 'Software\\Clients\\StartMenuInternet'

/**
 * 异步执行一次 reg.exe。
 * 失败（键不存在 / 无权限 / 被策略拦）一律返回 null：关联是「锦上添花」，
 * 绝不能因为一次注册表操作把启动路径或设置页打断。
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
function runReg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(REG_EXE, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024
      }, (error, stdout) => resolve(error ? null : String(stdout || '')))
    } catch (_) {
      resolve(null)
    }
  })
}

/**
 * 写一个注册表值。
 * @param {{ key: string, name: string, type: string, value: string|number }} entry
 * @returns {boolean}
 */
async function writeEntry(entry: RegistryPlanEntry): Promise<boolean> {
  const args = ['add', `${HKCU}\\${entry.key}`]
  // name 为空串 = 写「(默认)」值
  if (entry.name) args.push('/v', entry.name)
  else args.push('/ve')
  args.push('/t', entry.type, '/d', String(entry.value == null ? '' : entry.value), '/f')
  return await runReg(args) !== null
}

/**
 * 读一个注册表值（读不到返回 null）。
 * `reg query` 的输出形如：`    ProgId    REG_SZ    HiraNGURL`
 * 默认值的名字在不同 Windows 版本上可能是 `(Default)` 或 `<NO NAME>`；
 * 而 `/ve` 只会返回唯一一条值，所以空名字时直接取第一条即可。
 * @param {string} key
 * @param {string} name 空串 = 默认值
 * @returns {string|null}
 */
async function readEntry(key: string, name: string): Promise<string | null> {
  const out = await runReg(['query', `${HKCU}\\${key}`, ...(name ? ['/v', name] : ['/ve'])])
  if (!out) return null
  const wanted = name.toLowerCase()
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line)
    if (!match) continue
    if (wanted && match[1].trim().toLowerCase() !== wanted) continue
    return match[3]?.trim() || ''
  }
  return null
}

/**
 * 通知外壳「关联列表变了」（SHCNE_ASSOCCHANGED）。
 *
 * 安装器已经广播过一次；这里补的是**装完之后才发生的写入**：首次启动、
 * 换目录覆盖安装、用户点「设为默认」。不广播的话，Win11 的「打开方式」
 * 与「默认应用」可能长时间沿用缓存，表现就是「明明注册了却看不到 STAR Hira NitroGen」。
 *
 * 走 PowerShell P/Invoke 是因为 Node 没有直接暴露 shell32 的导出；
 * 只在真正发生写入时触发一次，且完全异步 —— 注册表写入不等它，启动也不等它。
 */
let shellNotified = false
/**
 * @param {{ force?: boolean }} [options] force = 即使本轮已通知过也再发一次
 *   （点击「设为默认」时的静默接管必须让外壳立刻重新解析，不能因为启动时
 *    已经广播过一次就被吞掉）
 */
function notifyShellAssociationChanged({ force = false }: { force?: boolean } = {}): void {
  if (shellNotified && !force) return
  shellNotified = true
  const ps = path.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script =
    "Add-Type -Namespace HiraNG -Name Shell32 -MemberDefinition " +
    "'[System.Runtime.InteropServices.DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int a, int b, System.IntPtr c, System.IntPtr d);'; " +
    '[HiraNG.Shell32]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)'
  try {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true },
      () => {}
    )
  } catch (_) {
    /* 通知失败不影响已写入的注册表 */
  }
}

/**
 * 一次性读出某个分支下所有 `UserChoice\ProgId`（一条 `reg query ... /s /v ProgId`）。
 *
 * 为什么要合并：设置页在「等待确认」时每 2s 回读一次，逐个键查就是每次起一二十个
 * reg.exe 进程，而 `execFileSync` 是**阻塞主进程**的 —— 每 2 秒卡几十毫秒，
 * 正是「跟不上手」的来源。一条命令拿回整棵树。
 *
 * @param {string} root 不含 HKCU 前缀的分支（FILE_EXTS_ROOT / URL_ASSOC_ROOT）
 * @returns {Record<string, string>|null} UserChoice 所在的键名(小写) -> ProgId
 *   （文件类型是扩展名 `.html`，协议是 `http`；两个分支各查各的，不会互相覆盖）
 */
async function readProgIdsUnder(root: string): Promise<Record<string, string> | null> {
  const out = await runReg(['query', `${HKCU}\\${root}`, '/s', '/v', 'ProgId'])
  if (!out) return null
  /** @type {Record<string, string>} */
  const map: Record<string, string> = {}
  let current = ''
  for (const line of out.split(/\r?\n/)) {
    const keyMatch = /^\s*(HKEY_[A-Z_]+\\[^\r\n]+)$/i.exec(line)
    if (keyMatch) { current = keyMatch[1] || ''; continue }
    const valueMatch = /^\s+ProgId\s+REG_[A-Z_]+\s*(.*)$/i.exec(line)
    if (!valueMatch || !current) continue
    const parts = current.split('\\')
    if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== 'userchoice') continue
    const targetKey = parts[parts.length - 2]
    if (targetKey) map[targetKey.toLowerCase()] = valueMatch[1]?.trim() || ''
  }
  return map
}

let browserSurfacePromise: Promise<void> | null = null

/**
 * 把本机主流浏览器的关联面并集进当前关联快照。
 *
 * 这里只影响“作为候选出现在列表”和“是否认这个文件类型”，不会把未知协议设成
 * 默认浏览器判定项，也不会写 `Software\Classes\<scheme>` 回退命令。
 */
function prepareDiscoveredBrowserAssociations(): Promise<void> {
  if (browserSurfacePromise) return browserSurfacePromise
  browserSurfacePromise = (async () => {
    const surface = createAssociationSurface()
    const outputs = await Promise.all([
      runReg(['query', `${HKCU}\\${BROWSER_CLIENTS_ROOT}`, '/s']),
      runReg(['query', `HKLM\\${BROWSER_CLIENTS_ROOT}`, '/s'])
    ])
    for (const output of outputs) {
      if (output) parseBrowserAssociationSurface(output, surface, APP_NAME)
    }
    registerAssociationContribution(associationContributionFromSurface(surface))
  })().catch((error: unknown) => {
    browserSurfacePromise = null
    console.warn('[default-client] 浏览器关联面发现失败:', errorMessage(error))
  })
  return browserSurfacePromise
}

/**
 * 当前是否已是系统默认浏览器。
 * Windows：http、https **都**指向我们的 URL progid 才算（与 RT 的判定口径一致）。
 * @returns {Promise<boolean>}
 */
export async function isDefaultBrowser(): Promise<boolean> {
  // 开发态恒为 false：此时系统里的 UserChoice 指向的是**已安装的正式版**，
  // 与眼前这个 electron.exe 没有关系，回读它只会给设置页一个错误结论。
  if (!isPackagedRuntime()) return false
  if (process.platform === 'win32') {
    const schemes = getDefaultBrowserSchemes()
    const progId = APP_PROGID_URL.toLowerCase()
    const pick = async (scheme: string): Promise<boolean> => {
      const id = await readEntry(userChoiceKeyPath({ kind: 'url', key: scheme }), 'ProgId')
      return id !== null && id.toLowerCase() === progId
    }
    const map = await readProgIdsUnder(URL_ASSOC_ROOT)
    // 合并查询被策略拦 / 输出变了 -> 退回逐个键读，宁可慢一点也要答对
    if (!map) return (await Promise.all(schemes.map(pick))).every(Boolean)
    return schemes.every((scheme) => {
      const id = map[scheme]
      return Boolean(id) && id.toLowerCase() === progId
    })
  }
  // 其它平台：Electron 的实现确实读系统状态（Linux 走 xdg-settings）。
  try {
    return getDefaultBrowserSchemes().every((scheme) => app.isDefaultProtocolClient(scheme))
  } catch (_) {
    return false
  }
}

/**
 * 命令归一化：去引号、压空格、转小写。
 * 注册表里的命令行可能是 `"E:\x\STAR Hira NitroGen.exe" "%1"` / `E:\x\STAR Hira NitroGen.exe %1` 等不同引号风格，
 * 直接字符串相等会误判成「没注册」，每次启动都白写一遍注册表。
 * @param {unknown} text
 * @returns {string}
 */
function normalizeCommand(text: unknown): string {
  return String(text == null ? '' : text).replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 注册表是否已**完整**指向当前这个 exe（幂等自检）。
 *
 * 与旧 Hira 的 `registryInstaller.ensureInstalled()` 同口径：不只看一处，而是把
 * 「默认应用」入口（RegisteredApplications）→ 开始菜单客户端 → 两个 progid 的
 * open 命令全部对一遍。任何一处缺失或还指向旧目录都算没登记，触发一次完整重写。
 * 覆盖「换目录覆盖安装 / 绿色运行 / 用户手工清理过注册表」这几种情况。
 *
 * ── 为什么还要比对 schema 指纹 ────────────────────────────────────
 * 上面四条只回答「指向的还是这个 exe 吗」，回答不了「清单/schema 变过吗」。
 * 扩展名从 7 个扩到 14 个、ProgId 补上 `Application` 身份块这类升级，
 * 老机器会因四条全绿而短路 → 新关联永远写不进去（用户看到的就是
 * 「点了设为默认，.svg/.webp/.webm 里还是没有 STAR Hira NitroGen」）。
 * 指纹来自 `buildRegistryPlan()` 自身，结构一变就变，因此升级必然触发一次重写。
 *
 * @param {string} exePath
 * @param {ReadonlyArray<{ key: string, name: string, type: string, value: string|number }>} plan 本次要写的计划
 * @returns {Promise<boolean>}
 */
async function isRegisteredFor(exePath: string, plan: readonly RegistryPlanEntry[]): Promise<boolean> {
  const expectedLaunch = normalizeCommand(exePath)          // StartMenuInternet 只启动应用，不带 %1
  const expectedOpen = normalizeCommand(`${exePath} --open-associated %1`)
  const iconKey = `Software\\Classes\\${APP_PROGID_FILE}\\Application`
  const iconEntry = plan.find((entry) => entry.key === iconKey && entry.name === 'ApplicationIcon')
  const marker = plan.find((entry) => entry.key === SCHEMA_MARKER_KEY && entry.name === SCHEMA_MARKER_NAME)
  if (!iconEntry || !marker) return false

  /** @type {Array<[string, string, string]>} [key, valueName, expected] */
  const checks: Array<[string, string, string]> = [
    ['Software\\RegisteredApplications', APP_NAME, `Software\\Clients\\StartMenuInternet\\${APP_NAME}\\Capabilities`],
    [`Software\\Clients\\StartMenuInternet\\${APP_NAME}\\shell\\open\\command`, '', expectedLaunch],
    [`Software\\Classes\\${APP_PROGID_URL}\\shell\\open\\command`, '', expectedOpen],
    [`Software\\Classes\\${APP_PROGID_FILE}\\shell\\open\\command`, '', expectedOpen],
    // 协议回退键：UserChoice 失效时系统会回落到这里。开发态曾留下
    // `node_modules\electron\dist\electron.exe "%1"`，不比对它就永远发现不了
    // 「点链接弹 Electron 空白窗」的污染（详见 buildRegistryPlan ⑦ 注释）。
    ['Software\\Classes\\http\\shell\\open\\command', '', expectedOpen],
    ['Software\\Classes\\https\\shell\\open\\command', '', expectedOpen],
    // Win+R / 快速打开：App Paths 丢了也要能自愈，而不是等下一次安装。
    [`Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exePath)}`, '', normalizeCommand(exePath)],
    [`Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exePath)}`, 'Path', normalizeCommand(path.dirname(exePath))],
    [`Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exePath)}\\SupportedProtocols`, 'http', ''],
    [`Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exePath)}\\SupportedProtocols`, 'https', ''],
    // 图标也必须一起比：只比命令行的话，「命令已修好、图标还停在开发态 electron.exe」
    // 这种半污染状态会被判成「已登记」而永远不自愈（正是用户看到 Electron 图标的成因）。
    [iconEntry.key, iconEntry.name, String(iconEntry.value)]
  ]
  const [results, markerValue] = await Promise.all([
    Promise.all(checks.map(async ([key, name, expected]) => (
      normalizeCommand(await readEntry(key, name)) === normalizeCommand(expected)
    ))),
    readEntry(SCHEMA_MARKER_KEY, SCHEMA_MARKER_NAME)
  ])
  return results.every(Boolean) && markerValue === String(marker.value)
}

/**
 * 本进程是否已经跑过一次开发态残留清理。
 * 每次启动最多一次：清理是「历史迁移」，不是每次开机都要扫的巡检。
 */
let devPollutionCleaned = false

/**
 * 一次性清理**开发态残留**（只动命令里带 `node_modules\electron\dist\electron.exe`
 * 的那一份，不碰任何真实安装的应用）。
 *
 * 早期开发态（还没有 `app.isPackaged` 守卫）运行时写下了三类东西：
 *   · `Software\Classes\http|https\shell\open\command` → dev electron
 *     （已由写入计划 ⑦ 覆盖成正式 exe，这里不再处理）；
 *   · `Software\Classes\Applications\electron.exe` → 「打开方式」里多出一个
 *     叫 Electron 的幽灵应用（它的图标就是 Electron 图标）；
 *   · `FileExts\<ext>\OpenWithList` 里的 `electron.exe` MRU 项。
 * 后两项会一直留在「打开方式」里，只能删键 / 删值，不能靠覆盖自愈。
 */
function cleanupDevPollution(): void {
  if (devPollutionCleaned) return
  devPollutionCleaned = true
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$dev = "(?i)[\\\\/]node_modules[\\\\/]electron[\\\\/]dist[\\\\/]electron\\.exe"',
    '$appKey = "HKCU:\\Software\\Classes\\Applications\\electron.exe"',
    '$cmd = (Get-ItemProperty "$appKey\\shell\\open\\command")."(default)"',
    'if ($cmd -match $dev) { Remove-Item $appKey -Recurse -Force }',
    '$root = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts"',
    'Get-ChildItem $root | ForEach-Object {',
    '  $list = Join-Path $_.PSPath "OpenWithList"',
    '  if (-not (Test-Path $list)) { return }',
    '  $item = Get-Item $list',
    '  $mru = $item.GetValue("MRUList", $null)',
    '  $removed = @()',
    '  foreach ($name in $item.GetValueNames()) {',
    '    if ($name -eq "MRUList") { continue }',
    '    if ("$($item.GetValue($name))" -match "(?i)^electron\\.exe$") {',
    '      Remove-ItemProperty -Path $list -Name $name',
    '      $removed += $name',
    '    }',
    '  }',
    '  if ($null -ne $mru -and $removed.Count -gt 0) {',
    '    $next = $mru',
    '    foreach ($n in $removed) { $next = $next.Replace($n, "") }',
    '    Set-ItemProperty -Path $list -Name "MRUList" -Value $next',
    '  }',
    '}'
  ].join('\r\n')
  try {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true },
      () => {}
    )
  } catch (_) {
    /* 清理失败不影响登记：下一次启动还会再试 */
  }
}

/**
 * 运行时收敛用户级 Capabilities 的动态项。
 *
 * buildRegistryPlan 只“写当前并集”，不会主动删除上一轮 peer 留下、但这台机器
 * 已不存在的扩展名；括号脚本在安装器里做了同样的事，这里覆盖“免安装替换产物”
 * 和浏览器被卸载后的自愈路径。HKLM 需要提权，交给安装器处理。
 */
async function pruneStaleCapabilityValues(plan: readonly RegistryPlanEntry[]): Promise<void> {
  const fileKey = `Software\\Clients\\StartMenuInternet\\${APP_NAME}\\Capabilities\\FileAssociations`
  const urlKey = `Software\\Clients\\StartMenuInternet\\${APP_NAME}\\Capabilities\\URLAssociations`
  const allowedFiles = plan.filter((entry) => entry.key === fileKey).map((entry) => entry.name)
  const allowedUrls = plan.filter((entry) => entry.key === urlKey).map((entry) => entry.name)
  const allowedOpenFiles = plan
    .filter((entry) => entry.key.endsWith('\\SupportedTypes'))
    .map((entry) => entry.name)
  if (!allowedFiles.length && !allowedUrls.length) return

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$allowedFiles = @(${allowedFiles.map((value) => JSON.stringify(value)).join(',')})`,
    `$allowedOpenFiles = @(${allowedOpenFiles.map((value) => JSON.stringify(value)).join(',')})`,
    `$allowedUrls = @(${allowedUrls.map((value) => JSON.stringify(value)).join(',')})`,
    `$fileKeyPath = ${JSON.stringify(fileKey)}`,
    `$urlKeyPath = ${JSON.stringify(urlKey)}`,
    '$hive = [Microsoft.Win32.Registry]::CurrentUser',
    '$allowedFileSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    '$allowedOpenSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    '$allowedUrlSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    'foreach ($name in $allowedFiles) { [void]$allowedFileSet.Add($name) }',
    'foreach ($name in $allowedOpenFiles) { [void]$allowedOpenSet.Add($name) }',
    'foreach ($name in $allowedUrls) { [void]$allowedUrlSet.Add($name) }',
    '$fileKey = $hive.OpenSubKey($fileKeyPath, $true)',
    'if ($null -ne $fileKey) {',
    '  foreach ($ext in @($fileKey.GetValueNames())) {',
    '    if ($allowedFileSet.Contains($ext)) { continue }',
    '    $fileKey.DeleteValue($ext, $false)',
    '    if (-not $allowedOpenSet.Contains($ext)) {',
    '      $open = $hive.OpenSubKey("Software\\Classes\\$ext\\OpenWithProgids", $true)',
    '      if ($null -ne $open) { $open.DeleteValue("HiraNGFile", $false); $open.Close() }',
    '    }',
    '  }',
    '  $fileKey.Close()',
    '}',
    '$urlKey = $hive.OpenSubKey($urlKeyPath, $true)',
    'if ($null -ne $urlKey) {',
    '  foreach ($scheme in @($urlKey.GetValueNames())) { if (-not $allowedUrlSet.Contains($scheme)) { $urlKey.DeleteValue($scheme, $false) } }',
    '  $urlKey.Close()',
    '}'
  ].join('\r\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await new Promise<void>((resolve) => {
    try {
      execFile(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true },
        () => resolve()
      )
    } catch (_) {
      resolve()
    }
  })
}

/**
 * 把当前可执行文件登记为文件关联 / 默认浏览器候选（幂等）。
 *
 * @param {{ force?: boolean }} [options] force = 跳过「路径没变就不写」的短路
 * @returns {Promise<boolean>} 注册动作是否成功（**不代表**已成为系统默认浏览器）
 */
export async function registerDefaultClient({ force = false }: { force?: boolean } = {}): Promise<boolean> {
  // 开发态 exe 是 node_modules 里的 electron.exe：登记它只会污染系统，
  // 把「打开方式」指向一个临时的开发运行时。打包态才做（所有平台一致）。
  if (!isPackagedRuntime()) {
    console.warn('[default-client] 开发态跳过关联注册（exe 不是 STAR Hira NitroGen）')
    return false
  }

  if (process.platform !== 'win32') {
    try {
      for (const scheme of getDefaultBrowserSchemes()) app.setAsDefaultProtocolClient(scheme)
      return true
    } catch (e) {
      console.warn('[default-client] 登记协议处理器失败:', errorMessage(e))
      return false
    }
  }

  const exePath = getRuntimeIdentity().executablePath
  // 即使下面幂等短路直接返回，也要先把历史残留清掉（一次/进程）。
  cleanupDevPollution()
  // 先并集本机浏览器 peers 的能力，再生成写入计划；新 scheme / 新扩展名无需改代码。
  await prepareDiscoveredBrowserAssociations()
  // 计划先生成出来：它同时是「要写什么」和「该不该重写」的判据（schema 指纹在里面）。
  const plan = buildRegistryPlan({
    exePath,
    exeName: path.basename(exePath),
    exeDir: path.dirname(exePath),
    appName: APP_NAME,
    description: APP_DESCRIPTION
  })
  if (!force && await isRegisteredFor(exePath, plan)) return true

  let ok = true
  let cursor = 0
  const workers = Array.from({ length: Math.min(4, plan.length) }, async () => {
    for (;;) {
      const index = cursor++
      const entry = plan[index]
      if (!entry) return
      if (!await writeEntry(entry)) ok = false
    }
  })
  await Promise.all(workers)
  // 动态并集要收敛，不能只加不减。失败不影响主流程。
  await pruneStaleCapabilityValues(plan).catch(() => {})

  // RT 同款：让 Electron 再补一份 `HKCU\Software\Classes\<scheme>` 的命令行，
  // 覆盖「UserChoice 缺失」的机器（系统会回落到这个键）。
  try {
    for (const scheme of getDefaultBrowserSchemes()) app.setAsDefaultProtocolClient(scheme)
  } catch (e) {
    console.warn('[default-client] setAsDefaultProtocolClient 失败:', errorMessage(e))
  }

  if (!ok) console.warn('[default-client] 部分关联键写入失败（不影响应用使用）')
  // 真的写过注册表才广播：幂等短路（路径没变）时什么都不做，避免每次启动都起 PowerShell。
  notifyShellAssociationChanged()
  return ok
}

/**
 * Windows PowerShell 的绝对路径（绕过 PATH 里可能存在的 PowerShell 7 / 被劫持的 alias）。
 * @returns {string}
 */
function powershellExe(): string {
  return path.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

/**
 * 生成「静默接管」的一次性 PowerShell 脚本。
 *
 * ── 为什么要自己写 Hash ──────────────────────────────────────────
 * `UserChoice` 键上的 `Hash` 是系统算的校验值，对不上就判定「被第三方篡改」、
 * 直接把这条选择丢掉。算法收在 `app/user-choice.js`（全项目唯一实现），
 * 这里只负责把它写进去。写对了系统就当作用户亲手选的 —— 不像「只删 UserChoice」
 * 那样会被守护进程几秒内抢回（`.htm/.html` 实测 15 秒零回退）。
 *
 * ── 为什么必须走 PowerShell，而不是一串 reg.exe ──────────────────────
 * 1. **UserChoice 删不掉的原因不是权限不够，而是 ACL**：该键上有一条针对
 *    当前用户的 Deny(SetValue) ACE。同一个键的 DACL 又允许 ChangePermissions，
 *    所以「先摘掉 Deny、再删键、重建」普通权限就能完成 —— 不用提权，也不用 SYSTEM。
 *    Node 没有注册表 ACL API，只能借 .NET。
 * 2. 10 个目标 × 6 个动作 = 60+ 次 `reg.exe`，每次 20~40ms 且 `execFileSync`
 *    会卡住主进程（按钮点下去要顿一秒）。一个脚本一次跑完，全程异步。
 *
 * ── 落地顺序（每一步都有实测依据）───────────────────────────────
 *   ① 摘 Deny → ② 删 UserChoice（否则用户之前的选择永远赢）
 *   → ③ 重建并写 `Hash`（先）→ ④ 写 `ProgId`（后），顺序与系统的写入一致
 *   → ⑤ 关掉「默认应用被更改」提示气泡（ApplicationAssociationToasts = 0）
 *   → ⑥ 回读该键的 LastWriteTime 并原样打印（`STAMP|路径|十六进制`）。
 * 第 ⑥ 步是必须的：Hash 的时间戳截断到整分钟，写入若恰好跨过分钟边界，
 * 实际 LastWriteTime 会比我们用的时间戳晚一分钟、Hash 立刻作废 ——
 * 调用方据此换新时间戳重算重写（见 writeUserChoice）。
 *
 * @param {Array<{ path: string, progId: string, hash: string, toast: string }>} items
 * @returns {string}
 */
function buildAdoptScript(items: readonly AdoptScriptItem[]): string {
  const rows = items
    .map((item) => `  @{ path = '${item.path}'; progId = '${item.progId}'; hash = '${item.hash}'; toast = '${item.toast}' }`)
    .join(',\r\n')
  const source = [
    '[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]',
    'public static extern int RegOpenKeyEx(System.IntPtr hKey, string lpSubKey, int ulOptions, int samDesired, out System.IntPtr phkResult);',
    '[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]',
    'public static extern int RegQueryInfoKey(System.IntPtr hKey, System.IntPtr lpClass, System.IntPtr lpcchClass, System.IntPtr lpReserved, System.IntPtr lpcSubKeys, System.IntPtr lpcbMaxSubKeyLen, System.IntPtr lpcbMaxClassLen, System.IntPtr lpcValues, System.IntPtr lpcbMaxValueNameLen, System.IntPtr lpcbMaxValueLen, System.IntPtr lpcbSecurityDescriptor, out long lpftLastWriteTime);',
    '[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]',
    'public static extern int RegCloseKey(System.IntPtr hKey);',
    'public static long LastWrite(string subKey) {',
    '  System.IntPtr h;',
    '  int rc = RegOpenKeyEx(new System.IntPtr(-2147483647), subKey, 0, 0x20019, out h);',
    '  if (rc != 0) return -1;',
    '  long ft;',
    '  rc = RegQueryInfoKey(h, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, System.IntPtr.Zero, out ft);',
    '  RegCloseKey(h);',
    '  return (rc == 0 && ft > 0) ? ft : -1;',
    '}'
  ].join('\r\n')
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$CU = [Microsoft.Win32.Registry]::CurrentUser',
    '$rights = [System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions',
    '$nt = [System.Security.Principal.NTAccount]',
    '$kind = [Microsoft.Win32.RegistryValueKind]::String',
    '$dword = [Microsoft.Win32.RegistryValueKind]::DWord',
    '$mode = [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree',
    "$src = @'",
    source,
    "'@",
    'try { Add-Type -Namespace HiraNG -Name Reg -MemberDefinition $src } catch { }',
    '$items = @(',
    rows,
    ')',
    'foreach ($it in $items) {',
    '  $p = $it.path',
    '  try {',
    '    $k = $CU.OpenSubKey($p, $mode, $rights)',
    '    if ($null -ne $k) {',
    '      $sec = $k.GetAccessControl()',
    '      foreach ($r in @($sec.GetAccessRules($true, $true, $nt))) {',
    '        if ($r.AccessControlType -eq "Deny") { [void]$sec.RemoveAccessRule($r) }',
    '      }',
    '      try { $k.SetAccessControl($sec) } catch { }',
    '      $k.Close()',
    '    }',
    '  } catch { }',
    '  try { $CU.DeleteSubKeyTree($p, $false) } catch { }',
    '  try {',
    '    $w = $CU.CreateSubKey($p)',
    '    if ($null -ne $w) {',
    '      $w.SetValue("Hash", $it.hash, $kind)',
    '      $w.SetValue("ProgId", $it.progId, $kind)',
    '      $w.Close()',
    '    }',
    '  } catch { }',
    '  try {',
    '    $t = $CU.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\ApplicationAssociationToasts")',
    '    if ($null -ne $t) { $t.SetValue($it.toast, 0, $dword); $t.Close() }',
    '  } catch { }',
    '  try {',
    '    $ft = [HiraNG.Reg]::LastWrite($p)',
    '    if ($ft -gt 0) { Write-Output ("STAMP|" + $p + "|" + ("{0:x16}" -f $ft)) }',
    '  } catch { }',
    '}'
  ].join('\r\n')
}

/**
 * FILETIME（100ns，16 位十六进制）→ 截断到整分钟的同格式串。
 *
 * 系统校验 Hash 时用的是「该键自身的 LastWriteTime，截断到分钟」，
 * 所以回读值也要按同一口径截断才能和写入时用的时间戳比较。
 * @param {string} hex
 * @returns {string|null}
 */
function truncateFileTime(hex: string): string | null {
  try {
    const value = BigInt(`0x${hex}`)
    // 1 分钟 = 60 × 10^7 个 100ns
    return ((value / 600000000n) * 600000000n).toString(16).padStart(16, '0')
  } catch (_) {
    return null
  }
}

/**
 * 跑一次接管脚本，返回「路径(小写) -> 该键写入后的 LastWriteTime」。
 * 拿不到任何 STAMP（Add-Type 被拦 / 脚本没跑起来）时返回空 Map，调用方跳过校正。
 * @param {Array<{ path: string, progId: string, hash: string, toast: string }>} items
 * @returns {Promise<Map<string, string>>}
 */
function runUserChoiceScript(items: readonly AdoptScriptItem[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const scriptPath = path.join(app.getPath('temp'), `hirang-userchoice-${process.pid}-${Date.now()}.ps1`)
    try {
      fs.writeFileSync(scriptPath, buildAdoptScript(items), 'ascii')
    } catch (e) {
      console.warn('[default-client] 写入接管脚本失败:', errorMessage(e))
      resolve(new Map())
      return
    }
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { windowsHide: true, timeout: 20000 },
      (error, stdout) => {
        try { fs.unlinkSync(scriptPath) } catch (_) { /* 临时文件删不掉不影响结果 */ }
        if (error) console.warn('[default-client] 接管脚本执行异常:', errorMessage(error))
        const stamps = new Map<string, string>()
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const match = /^STAMP\|(.+)\|([0-9a-fA-F]{16})$/.exec(line.trim())
          if (match && match[1] && match[2]) stamps.set(match[1].toLowerCase(), match[2].toLowerCase())
        }
        resolve(stamps)
      }
    )
  })
}

/**
 * 把一批目标的 `UserChoice` 改成 STAR Hira NitroGen（递归两轮，最多）。
 *
 * Hash 的时间戳是「整分钟」，跨分钟边界的写入会作废 —— 脚本回读每个键的
 * LastWriteTime，发现比写入前的时间戳晚一分钟，就按现在重算 Hash 再写一遍。
 * 重写本身会刷新 LastWriteTime，所以重试天然幂等；上限两轮避免死循环。
 *
 * @param {ReadonlyArray<{ kind: 'file'|'url', key: string }>} targets
 * @param {number} attempt 已重试次数
 * @returns {Promise<void>}
 */
function writeUserChoice(targets: readonly UserChoiceTarget[], attempt: number): Promise<void> {
  const stamp = minuteStamp()
  const items = targets
    .map((target) => {
      const progId = target.kind === 'url' ? APP_PROGID_URL : APP_PROGID_FILE
      const hash = userChoiceHash({ kind: target.kind, key: target.key, progId, stamp })
      if (!hash) return null
      return {
        kind: target.kind,
        key: target.key,
        path: userChoiceKeyPath(target),
        progId,
        hash,
        toast: `${progId}_${target.key}`
      }
    })
    .filter((item): item is UserChoiceWriteItem => item !== null)
  if (!items.length) return Promise.resolve()

  return runUserChoiceScript(items).then((stamps) => {
    if (!stamps.size) return
    const retry: UserChoiceTarget[] = []
    for (const item of items) {
      const actual = stamps.get(item.path.toLowerCase())
      if (!actual) continue
      const fixed = truncateFileTime(actual)
      if (!fixed || fixed === stamp) continue
      retry.push({ kind: item.kind, key: item.key })
    }
    if (!retry.length || attempt >= 2) return
    return writeUserChoice(retry, attempt + 1)
  })
}

/**
 * 静默接管 `USER_CHOICE_TARGETS`（8 个 HTML 文档族 + http/https）。
 *
 * 用户点「设为默认浏览器」时**不需要**再去系统设置里逐个点确认 —— 这些类型
 * 只有浏览器会碰，接管符合预期；`.svg` / `.webp` / `.pdf` 等多用途类型不在列内
 * （抢它们等于把用户的看图 / 阅读默认程序一起改掉）。
 *
 * 全程异步：一个 PowerShell 脚本改完 10 个键，然后一条 `reg query` 回读判定。
 * 绝不阻塞调用方 —— 设置页该弹就立刻弹。
 *
 * @returns {Promise<{ adopted: string[], skipped: string[] }>}
 *   adopted / skipped 都是扩展名或协议名，以**回读到的真实 ProgId** 为准
 */
export async function adoptFileAssociationsQuietly(): Promise<AdoptResult> {
  const empty: AdoptResult = { adopted: [], skipped: [] }
  if (process.platform !== 'win32') return Promise.resolve(empty)
  // 开发态的 exe 是 electron.exe；把默认程序指到它只会污染系统（与注册同理）。
  if (!isPackagedRuntime()) return Promise.resolve(empty)

  await writeUserChoice(USER_CHOICE_TARGETS, 0)
  const [fileMap, urlMap] = await Promise.all([
    readProgIdsUnder(FILE_EXTS_ROOT),
    readProgIdsUnder(URL_ASSOC_ROOT)
  ])
  if (!fileMap && !urlMap) return empty
  const merged = Object.assign({}, fileMap || {}, urlMap || {})
  const result: AdoptResult = { adopted: [], skipped: [] }
  for (const target of USER_CHOICE_TARGETS) {
    const progId = (target.kind === 'url' ? APP_PROGID_URL : APP_PROGID_FILE).toLowerCase()
    const got = merged[target.key.toLowerCase()] || ''
    if (Boolean(got) && got.toLowerCase() === progId) result.adopted.push(target.key)
    else result.skipped.push(target.key)
  }
  if (result.adopted.length) notifyShellAssociationChanged({ force: true })
  return result
}

/**
 * 打开系统的「默认应用」设置页 —— 直接落到 **STAR Hira NitroGen 自己的那一页**。
 *
 * 接管是静默做的（见 `adoptFileAssociationsQuietly`），设置页在这里不再是
 * 「唯一能生效的地方」，而是**用户看得见的确认入口** + 被组策略 / UCPD 拦住时的
 * 手工兜底。即便如此，「送到哪一页」仍决定它有没有用：
 *   · 裸 `ms-settings:defaultapps` = 一张应用总览列表，用户还得搜到 STAR Hira NitroGen、
 *     点进详情、再逐个把 http / https / 7 种扩展名改掉 —— 等于把活儿全丢回给用户；
 *   · `?registeredAppUser=STAR Hira NitroGen` = STAR Hira NitroGen 专属页面，页首就是
 *     「将 STAR Hira NitroGen 设置为默认浏览器」，一次点选接管全部（Chrome / Firefox 同款）。
 * 旧系统不认识这个参数会忽略它、自己退回总览页，所以先试深链、失败再退回总览页。
 *
 * @returns {Promise<boolean>} 设置页是否成功唤起（不代表用户已经确认）
 */
export async function openDefaultAppsSettings(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  // 开发态连这个页面都不打开：此时系统里能登记的候选是 electron.exe，
  // 把用户送到设置页只会让他手动把默认应用改成开发运行时（最坏的污染路径）。
  if (!isPackagedRuntime()) return false
  for (const uri of [defaultAppsSettingsUri(APP_NAME), DEFAULT_APPS_SETTINGS_URI]) {
    try {
      await shell.openExternal(uri)
      return true
    } catch (e) {
      console.warn('[default-client] 打开默认应用设置失败:', uri, errorMessage(e))
    }
  }
  return false
}

