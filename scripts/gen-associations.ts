#!/usr/bin/env node
/**
 * scripts/gen-associations.ts —— 把 `packages/shared-types/src/associations.ts`
 * 的注册表写入计划渲染成 NSIS 宏，写进 `build/installer.nsh` 的生成区。
 *
 * 为什么是「渲染进 installer.nsh 的标记区」而不是额外的 .nsh：
 *   electron-builder 的 `nsis.include` 只接受一个文件，而它把 installer.nsh 以
 *   **绝对路径** include 进临时脚本；再套一层相对路径的 `!include` 在不同 NSIS
 *   版本上解析基准不一致（工作目录 / 当前脚本目录），很容易在 CI 上炸。
 *   生成区留在同一个文件里，编译路径问题就不存在了。
 *
 * 由 scripts/pack-win.cjs 在打包前自动调用；单独跑也可以：
 *   node scripts/gen-associations.ts
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  APP_NAME,
  APP_DESCRIPTION,
  APP_PROGID_FILE,
  SILENT_ADOPT_EXTENSIONS,
  WEB_BROWSER_ASSOCIATION,
  buildRegistryPlan,
  buildUnregisterPlan
} = require('@hira-ng/shared-types/src/associations.mjs')

const INSTALLER_PATH = path.join(__dirname, '..', 'build', 'installer.nsh')
const BEGIN = '# <HIRA-ASSOCIATIONS:BEGIN>'
const END = '# <HIRA-ASSOCIATIONS:END>'

// 计划里的 exe 路径先占位：渲染时替换成 NSIS 表达式（安装期的真实安装目录）。
const EXE_TOKEN = '@@HIRA_EXE@@'
const EXE_NAME_TOKEN = '@@HIRA_EXE_NAME@@'
const EXE_DIR_TOKEN = '@@HIRA_EXE_DIR@@'
const TOKEN_RE = /(@@HIRA_EXE@@|@@HIRA_EXE_NAME@@|@@HIRA_EXE_DIR@@)/

/**
 * NSIS 字符串转义：`$` 是变量前缀、`"` 是字符串边界。
 * token 必须原样输出（它要变成 `$INSTDIR\${APP_EXECUTABLE_FILENAME}` 这类表达式）。
 * @param {string} text
 */
function nsisEscape(text: string) {
  return String(text)
    .split(TOKEN_RE)
    .map((part) => {
      if (part === EXE_TOKEN) return '$INSTDIR\\${APP_EXECUTABLE_FILENAME}'
      if (part === EXE_NAME_TOKEN) return '${APP_EXECUTABLE_FILENAME}'
      if (part === EXE_DIR_TOKEN) return '$INSTDIR'
      return part.split('$').join('$$').split('"').join('$\\"')
    })
    .join('')
}

/**
 * 一条写入计划 → 一行 NSIS。
 * @param {{ key: string, name: string, type: string, value: string|number }} entry
 */
function renderWrite(entry: { key: string, name: string, type: string, value: string|number, scope?: 'user'|'machine' }) {
  const key = nsisEscape(entry.key)
  const name = nsisEscape(entry.name)
  const hive = entry.scope === 'machine' ? 'HKLM' : 'HKCU'
  if (entry.type === 'REG_DWORD') {
    const value = Number(entry.value) || 0
    return `  WriteRegDWORD ${hive} "${key}" "${name}" 0x${value.toString(16).padStart(8, '0')}`
  }
  return `  WriteRegStr ${hive} "${key}" "${name}" "${nsisEscape(String(entry.value == null ? '' : entry.value))}"`
}

/**
 * 一条清理计划 → 一行 NSIS。
 * @param {{ type: 'deleteValue'|'deleteKey', key: string, name?: string }} op
 */
function renderDelete(op: { type: 'deleteValue'|'deleteKey', key: string, name?: string, scope?: 'user'|'machine' }) {
  const key = nsisEscape(op.key)
  const hive = op.scope === 'machine' ? 'HKLM' : 'HKCU'
  if (op.type === 'deleteValue') {
    return `  DeleteRegValue ${hive} "${key}" "${nsisEscape(op.name || '')}"`
  }
  return `  DeleteRegKey ${hive} "${key}"`
}

const CLASSES_KEY = 'Software\\Classes'

/** 用户级「这个扩展上次用谁打开」的缓存（同样参与默认处理器判定）。 */
const FILE_EXTS_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'

/**
 * 安装期的候选收敛段（**兜底**，不是接管主路径）：把 HTML 文档族的候选列表收敛到自己。
 *
 * 为什么还需要安装器（提权上下文）做这一步：
 *   `HKLM\Software\Classes\<ext>\OpenWithProgids` 里只要还剩**另一个真实存在**的
 *   ProgId（Edge 的 `MSEdgeMHT` 就在这），系统在「没有 UserChoice」的机器上会判定
 *   「多候选」并把处理器换成 `OpenWith.exe`。运行时是普通权限，删不掉 HKLM 的子键，
 *   所以这一步只能在安装期做。
 *
 * 安装器**不**碰 UserChoice：算 Hash 需要当前用户 SID 与写入时刻，NSIS 做不了。
 * 接管由运行时在用户点「设为默认浏览器」时执行（写合法 Hash，见
 * apps/app-main/src/main/app/user-choice.js）。
 */
function renderSilentAdopt() {
  /** @type {string[]} */
  const lines: string[] = []
  for (const ext of SILENT_ADOPT_EXTENSIONS) {
    const cls = `${CLASSES_KEY}\\${ext}`
    lines.push(
      `  # ${ext}`,
      `  DeleteRegKey HKLM "${cls}\\OpenWithProgids"`,
      `  WriteRegStr HKLM "${cls}\\OpenWithProgids" "${APP_PROGID_FILE}" ""`,
      `  DeleteRegKey HKCU "${cls}\\OpenWithProgids"`,
      `  WriteRegStr HKCU "${cls}\\OpenWithProgids" "${APP_PROGID_FILE}" ""`,
      `  WriteRegStr HKLM "${cls}" "" "${APP_PROGID_FILE}"`,
      `  WriteRegStr HKCU "${cls}" "" "${APP_PROGID_FILE}"`,
      `  DeleteRegKey HKCU "${FILE_EXTS_KEY}\\${ext}\\OpenWithProgids"`
    )
  }
  return lines
}

/**
 * 静默接管的撤销段。
 *
 * 只撤销「值仍然是我们写的」那部分：用户在装完之后可能又把默认程序改成了别的
 * （比如新装的编辑器抢走 `.xhtml`），无脑 DeleteRegValue 会把别人的默认值一起删。
 */
function renderSilentRestore() {
  /** @type {string[]} */
  const lines: string[] = []
  for (const ext of SILENT_ADOPT_EXTENSIONS) {
    const cls = `${CLASSES_KEY}\\${ext}`
    for (const root of ['HKLM', 'HKCU']) {
      lines.push(
        `  ReadRegStr $0 ${root} "${cls}" ""`,
        `  \${If} $0 == "${APP_PROGID_FILE}"`,
        `    DeleteRegValue ${root} "${cls}" ""`,
        `  \${EndIf}`,
        `  DeleteRegValue ${root} "${cls}\\OpenWithProgids" "${APP_PROGID_FILE}"`,
        `  DeleteRegKey /ifempty ${root} "${cls}\\OpenWithProgids"`
      )
    }
  }
  return lines
}

/**
 * 安装时把本机其他浏览器 Capabilities 里的未知协议 / 文件类型也并集到 STAR Hira NitroGen。
 *
 * 生成期在开发机上枚举没有意义；这段必须在目标机器安装时执行。脚本是纯声明式
 * 并集：只复制 peers 已公开的候选，不写 http/https 之外的回退命令，也不改默认。
 */
/** NSIS 单行有长度上限：PowerShell EncodedCommand 必须分块拼进 $R0。 */
function renderEncodedPowerShellMacro(macro: string, script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const chunks = encoded.match(/.{1,900}/g) || ['']
  return [
    `!macro ${macro}`,
    '  StrCpy $R0 ""',
    ...chunks.map((chunk) => `  StrCpy $R0 "$R0${chunk}"`),
    `  nsExec::ExecToLog '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $R0'`,
    '  Pop $0',
    '  StrCpy $R0 ""',
    '!macroend'
  ]
}

function renderPeerAssociationScript(mode: 'register' | 'uninstall'): string {
  const shared = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$ours = "STAR Hira NitroGen"',
    '$fileProgId = "HiraNGFile"',
    '$urlProgId = "HiraNGURL"',
    '$roots = @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)'
  ]
  const cleanup = [
    'foreach ($root in $roots) {',
    `  $caps = $root.OpenSubKey("Software\\Clients\\StartMenuInternet\\$ours\\Capabilities\\FileAssociations")`,
    '  if ($null -eq $caps) { continue }',
    '  foreach ($ext in $caps.GetValueNames()) {',
    '    foreach ($target in $roots) {',
    '      $open = $target.OpenSubKey("Software\\Classes\\$ext\\OpenWithProgids", $true)',
    '      if ($null -ne $open) { $open.DeleteValue($fileProgId, $false); $open.Close() }',
    '    }',
    '  }',
    '  $caps.Close()',
    '}'
  ]

  if (mode === 'uninstall') return [...shared, ...cleanup].join('\r\n')

  const baseFiles = WEB_BROWSER_ASSOCIATION.files.map((item: { ext: string }) => item.ext)
  const baseCapableFiles = WEB_BROWSER_ASSOCIATION.files.filter((item: { tier: string }) => item.tier === 'document').map((item: { ext: string }) => item.ext)
  const baseProtocols = WEB_BROWSER_ASSOCIATION.protocols.map((item: { scheme: string }) => item.scheme)
  const psArray = (values: string[]) => values.map((value) => JSON.stringify(value)).join(',')
  const script = [
    ...shared,
    '$blocked = @(".exe", ".com", ".bat", ".cmd", ".ps1", ".msi", ".scr", ".cpl", ".dll", ".sys")',
    `$baseFiles = @(${psArray(baseFiles)})`,
    `$baseCapableFiles = @(${psArray(baseCapableFiles)})`,
    `$baseProtocols = @(${psArray(baseProtocols)})`,
    '$files = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    '$capableFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    '$protocols = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    'foreach ($value in $baseFiles) { [void]$files.Add($value) }',
    'foreach ($value in $baseCapableFiles) { [void]$capableFiles.Add($value) }',
    'foreach ($value in $baseProtocols) { [void]$protocols.Add($value) }',
    'foreach ($root in $roots) {',
    '  $clients = $root.OpenSubKey("Software\\Clients\\StartMenuInternet")',
    '  if ($null -eq $clients) { continue }',
    '  foreach ($name in $clients.GetSubKeyNames()) {',
    '    if ($name -ieq $ours) { continue }',
    '    $cap = $clients.OpenSubKey("$name\\Capabilities")',
    '    if ($null -eq $cap) { continue }',
    '    $fa = $cap.OpenSubKey("FileAssociations")',
    '    if ($null -ne $fa) {',
    '      foreach ($value in $fa.GetValueNames()) {',
    '        $ext = "$value".Trim().ToLowerInvariant()',
    '        if (-not $ext.StartsWith(".")) { $ext = "." + $ext }',
    '        if ($ext -match "^\\.[a-z0-9][a-z0-9._+-]*$" -and -not $blocked.Contains($ext)) { [void]$files.Add($ext); [void]$capableFiles.Add($ext) }',
    '      }',
    '      $fa.Close()',
    '    }',
    '    $ua = $cap.OpenSubKey("URLAssociations")',
    '    if ($null -ne $ua) {',
    '      foreach ($value in $ua.GetValueNames()) {',
    '        $scheme = "$value".Trim().ToLowerInvariant()',
    '        if ($scheme -match "^[a-z][a-z0-9+.-]*$") { [void]$protocols.Add($scheme) }',
    '      }',
    '      $ua.Close()',
    '    }',
    '    $cap.Close()',
    '  }',
    '  $clients.Close()',
    '}',
    'foreach ($root in $roots) {',
    '  $fileKey = $root.CreateSubKey("Software\\Clients\\StartMenuInternet\\$ours\\Capabilities\\FileAssociations")',
    '  foreach ($old in @($fileKey.GetValueNames())) {',
    '    if (-not $capableFiles.Contains($old)) { $fileKey.DeleteValue($old, $false) }',
    '    if ($files.Contains($old)) { continue }',
    '    foreach ($target in $roots) {',
    '      $open = $target.OpenSubKey("Software\\Classes\\$old\\OpenWithProgids", $true)',
    '      if ($null -ne $open) { $open.DeleteValue($fileProgId, $false); $open.Close() }',
    '    }',
    '  }',
    '  foreach ($ext in $capableFiles) {',
    '    $fileKey.SetValue($ext, $fileProgId, [Microsoft.Win32.RegistryValueKind]::String)',
    '  }',
    '  foreach ($ext in $files) {',
    '    $open = $root.CreateSubKey("Software\\Classes\\$ext\\OpenWithProgids")',
    '    $open.SetValue($fileProgId, "", [Microsoft.Win32.RegistryValueKind]::String)',
    '    $open.Close()',
    '  }',
    '  $fileKey.Close()',
    '  $urlKey = $root.CreateSubKey("Software\\Clients\\StartMenuInternet\\$ours\\Capabilities\\URLAssociations")',
    '  foreach ($old in @($urlKey.GetValueNames())) { if (-not $protocols.Contains($old)) { $urlKey.DeleteValue($old, $false) } }',
    '  foreach ($scheme in $protocols) {',
    '    $urlKey.SetValue($scheme, $urlProgId, [Microsoft.Win32.RegistryValueKind]::String)',
    '  }',
    '  $urlKey.Close()',
    '}',
    'Write-Output ("peers|" + $files.Count + "|" + $protocols.Count)'
  ]
  return script.join('\r\n')
}

function renderPeerAssociationMacro(macro: string, mode: 'register' | 'uninstall'): string[] {
  return renderEncodedPowerShellMacro(macro, renderPeerAssociationScript(mode))
}

/**
 * 清理历史开发态泄漏到系统的入口。
 *
 * 只处理“目标/命令仍指向 node_modules\electron\dist\electron.exe”的项：
 *   · 桌面 / 开始菜单 / 启动目录 / 任务栏固定项里的 STAR Hira NitroGen、Electron、PWA 快捷方式；
 *   · Open With 里的 electron.exe 幽灵应用；
 *   · 被 electron.exe 抢注的 ProgId / StartMenuInternet / App Paths / http(s) 回退命令。
 *
 * 自动化安装必须能自我修复，不能假设用户先手工清注册表再重装。
 */
function renderDevelopmentArtifactCleanupMacro(): string[] {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$devPattern = "(?i)[\\\\/]node_modules[\\\\/]electron[\\\\/]dist[\\\\/]electron\\.exe"',
    '$ws = New-Object -ComObject WScript.Shell',
    'function Test-DevTree($key) {',
    '  foreach ($name in $key.GetValueNames()) { if ("$($key.GetValue($name))" -match $devPattern) { return $true } }',
    '  foreach ($name in $key.GetSubKeyNames()) {',
    '    $child = $key.OpenSubKey($name)',
    '    if ($null -ne $child) { $found = Test-DevTree $child; $child.Close(); if ($found) { return $true } }',
    '  }',
    '  return $false',
    '}',
    '$roots = @(',
    '  [Environment]::GetFolderPath("Desktop"),',
    '  [Environment]::GetFolderPath("CommonDesktopDirectory"),',
    '  [Environment]::GetFolderPath("Programs"),',
    '  [Environment]::GetFolderPath("CommonPrograms"),',
    '  [Environment]::GetFolderPath("Startup"),',
    '  [Environment]::GetFolderPath("CommonStartup"),',
    '  "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"',
    ') | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique',
    'foreach ($root in $roots) {',
    '  Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object {',
    '    try {',
    '      $shortcut = $ws.CreateShortcut($_.FullName)',
    '      $isDev = "$($shortcut.TargetPath)" -match $devPattern',
    '      $isOurs = $_.BaseName -match "^(STAR Hira NitroGen|STAR Hira NitroGen Development|HiraNG|HiraNG Development|Hira NG|Hira-NG|Electron)$" -or "$($shortcut.Arguments)" -match "--pwa-app="',
    '      if ($isDev -and $isOurs) {',
    '        [IO.File]::SetAttributes($_.FullName, [IO.FileAttributes]::Normal)',
    '        Remove-Item -LiteralPath $_.FullName -Force',
    '      }',
    '    } catch {}',
    '  }',
    '}',
    '$hives = @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)',
    '$owned = @(',
    '  "Software\\Classes\\HiraNGFile",',
    '  "Software\\Classes\\HiraNGURL",',
    '  "Software\\Clients\\StartMenuInternet\\STAR Hira NitroGen",',
    '  "Software\\Clients\\StartMenuInternet\\HiraNG",',
    '  "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\STAR Hira NitroGen.exe",',
    '  "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\HiraNG.exe"',
    ')',
    'foreach ($hive in $hives) {',
    '  foreach ($sub in $owned) {',
    '    $key = $hive.OpenSubKey($sub, $true)',
    '    if ($null -eq $key) { continue }',
    '    $isDev = Test-DevTree $key',
    '    $key.Close()',
    '    if ($isDev) { $hive.DeleteSubKeyTree($sub, $false) }',
    '  }',
    '  $client = $hive.OpenSubKey("Software\\Clients\\StartMenuInternet\\STAR Hira NitroGen\\shell\\open\\command", $false)',
    '  if ($null -ne $client) {',
    '    $isDevClient = "$($client.GetValue([string]::Empty))" -match $devPattern',
    '    $client.Close()',
    '    if ($isDevClient) {',
    '      $registered = $hive.OpenSubKey("Software\\RegisteredApplications", $true)',
    '      if ($null -ne $registered) { $registered.DeleteValue("STAR Hira NitroGen", $false); $registered.DeleteValue("HiraNG", $false); $registered.Close() }',
    '    }',
    '  }',
    '  foreach ($scheme in @("http", "https")) {',
    '    $command = $hive.OpenSubKey("Software\\Classes\\$scheme\\shell\\open\\command", $true)',
    '    if ($null -ne $command) {',
    '      if ("$($command.GetValue([string]::Empty))" -match $devPattern) { $command.DeleteValue("", $false) }',
    '      $command.Close()',
    '    }',
    '  }',
    '  $pwaRoot = $hive.OpenSubKey("Software\\HiraNG\\PWA", $true)',
    '  if ($null -ne $pwaRoot) {',
    '    foreach ($appId in @($pwaRoot.GetSubKeyNames())) {',
    '      $appKey = $pwaRoot.OpenSubKey($appId, $true)',
    '      if ($null -eq $appKey) { continue }',
    '      $isDevApp = Test-DevTree $appKey',
    '      if (-not $isDevApp) { $appKey.Close(); continue }',
    '      $cap = $appKey.OpenSubKey("Capabilities", $false)',
    '      if ($null -ne $cap) {',
    '        $fa = $cap.OpenSubKey("FileAssociations", $false)',
    '        if ($null -ne $fa) { foreach ($ext in $fa.GetValueNames()) { foreach ($target in $hives) { $open = $target.OpenSubKey("Software\\Classes\\$ext\\OpenWithProgids", $true); if ($null -ne $open) { $open.DeleteValue("HiraNG.PWA.$appId.File", $false); $open.Close() } } }; $fa.Close() }',
    '        $ua = $cap.OpenSubKey("URLAssociations", $false)',
    '        if ($null -ne $ua) { foreach ($scheme in $ua.GetValueNames()) { foreach ($target in $hives) { $open = $target.OpenSubKey("Software\\Classes\\$scheme\\OpenWithProgids", $true); if ($null -ne $open) { $open.DeleteValue("HiraNG.PWA.$appId.URL", $false); $open.Close() } } }; $ua.Close() }',
    '        $cap.Close()',
    '      }',
    '      $appKey.Close()',
    '      $pwaRoot.DeleteSubKeyTree($appId, $false)',
    '      foreach ($target in $hives) {',
    '        $target.DeleteSubKeyTree("Software\\Classes\\HiraNG.PWA.$appId.File", $false)',
    '        $target.DeleteSubKeyTree("Software\\Classes\\HiraNG.PWA.$appId.URL", $false)',
    '      }',
    '      $registered = $hive.OpenSubKey("Software\\RegisteredApplications", $true)',
    '      if ($null -ne $registered) {',
    '        foreach ($name in @($registered.GetValueNames())) { if ("$($registered.GetValue($name))" -ieq "Software\\HiraNG\\PWA\\$appId\\Capabilities") { $registered.DeleteValue($name, $false) } }',
    '        $registered.Close()',
    '      }',
    '    }',
    '    $pwaRoot.Close()',
    '  }',
    '}',
    '$electronApp = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Classes\\Applications\\electron.exe\\shell\\open\\command", $false)',
    'if ($null -ne $electronApp) {',
    '  $isDevApp = "$($electronApp.GetValue([string]::Empty))" -match $devPattern',
    '  $electronApp.Close()',
    '  if ($isDevApp) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree("Software\\Classes\\Applications\\electron.exe", $false) }',
    '}',
    '$appPath = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\electron.exe", $true)',
    'if ($null -ne $appPath) {',
    '  if ("$($appPath.GetValue([string]::Empty))" -match $devPattern) { $appPath.DeleteValue("", $false) }',
    '  $appPath.Close()',
    '}',
    '$fileExts = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts", $false)',
    'if ($null -ne $fileExts) {',
    '  foreach ($ext in $fileExts.GetSubKeyNames()) {',
    '    $list = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\OpenWithList", $true)',
    '    if ($null -eq $list) { continue }',
    '    $mru = "$($list.GetValue("MRUList"))"',
    '    foreach ($name in @($list.GetValueNames())) {',
    '      if ($name -ne "MRUList" -and "$($list.GetValue($name))" -match "^(?i)electron\\.exe$") {',
    '        $list.DeleteValue($name, $false)',
    '        $mru = $mru.Replace($name, "")',
    '      }',
    '    }',
    '    if ($mru) { $list.SetValue("MRUList", $mru) }',
    '    $list.Close()',
    '  }',
    '  $fileExts.Close()',
    '}',
    'Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\ie4uinit.exe" -ArgumentList "-show"',
    'Write-Output "development-artifacts|cleaned"'
  ].join('\r\n')
  return [...renderEncodedPowerShellMacro('hiraPurgeDevelopmentArtifacts', script), '']
}

function buildBlock() {
  const userWrites = buildRegistryPlan({
    exePath: EXE_TOKEN,
    exeName: EXE_NAME_TOKEN,
    exeDir: EXE_DIR_TOKEN,
    appName: APP_NAME,
    description: APP_DESCRIPTION,
    scope: 'user'
  }).map(renderWrite)
  const machineWrites = buildRegistryPlan({
    exePath: EXE_TOKEN,
    exeName: EXE_NAME_TOKEN,
    exeDir: EXE_DIR_TOKEN,
    appName: APP_NAME,
    description: APP_DESCRIPTION,
    scope: 'machine'
  }).map(renderWrite)

  const userDeletes = buildUnregisterPlan({
    exeName: EXE_NAME_TOKEN,
    appName: APP_NAME,
    scope: 'user'
  }).map(renderDelete)
  const machineDeletes = buildUnregisterPlan({
    exeName: EXE_NAME_TOKEN,
    appName: APP_NAME,
    scope: 'machine'
  }).map(renderDelete)

  return [
    BEGIN,
    '# 本区由 scripts/gen-associations.ts 从 shared-types/src/associations.ts 生成，',
    '# 请改数据源后重新运行脚本（pack-win 会自动跑），不要手改这里。',
    '',
    '# 清理旧开发运行时留下的快捷方式 / AUMID / 幽灵关联（只命中 electron.exe 目标）。',
    ...renderDevelopmentArtifactCleanupMacro(),
    '!macro hiraRegisterAssociations',
    ...userWrites,
    '!macroend',
    '',
    '# 机器级身份：Windows 的“默认应用”浏览器列表主要枚举这一层。',
    '# 这里只发布候选与能力，不写 http/https 回退命令，避免替任何用户抢默认。',
    '!macro hiraRegisterMachineAssociations',
    ...machineWrites,
    '!macroend',
    '',
    '# 目标机器上的浏览器 peers 动态并集（未知协议 / 文件类型）。',
    ...renderPeerAssociationMacro('hiraRegisterDiscoveredAssociations', 'register'),
    '',
    '!macro hiraUnregisterAssociations',
    ...userDeletes,
    ...machineDeletes,
    '!macroend',
    '',
    '# 卸载前先按我们自己 Capabilities 的完整清单清掉动态 OpenWithProgids 值。',
    ...renderPeerAssociationMacro('hiraUnregisterDiscoveredAssociations', 'uninstall'),
    '',
    '# HTML 文档族（SILENT_ADOPT_EXTENSIONS）：装完即把候选收敛到 STAR Hira NitroGen（兜底），',
    '# 真正的默认接管由运行时给 UserChoice 写合法 Hash 来完成。',
    '!macro hiraAdoptFileAssociations',
    ...renderSilentAdopt(),
    '!macroend',
    '',
    '!macro hiraRestoreFileAssociations',
    ...renderSilentRestore(),
    '!macroend',
    END
  ].join('\n')
}

function main() {
  const source = fs.readFileSync(INSTALLER_PATH, 'utf8')
  const beginAt = source.indexOf(BEGIN)
  const endAt = source.indexOf(END)
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    throw new Error(`installer.nsh 缺少生成区标记：${BEGIN} / ${END}`)
  }

  const before = source.slice(0, beginAt)
  const after = source.slice(endAt + END.length)
  const next = `${before}${buildBlock()}${after}`

  if (next === source) {
    console.log('[gen-associations] 已是最新，无需重写')
    return
  }
  fs.writeFileSync(INSTALLER_PATH, next, 'utf8')
  console.log(`[gen-associations] 已更新 ${path.relative(process.cwd(), INSTALLER_PATH)}`)
}

main()
