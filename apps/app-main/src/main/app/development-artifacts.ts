/**
 * app/development-artifacts.ts —— 开发态一次性自清理。
 *
 * 只删除“目标就是本次开发用 electron.exe”的 STAR Hira NitroGen / Electron / PWA 快捷方式，
 * 以及仍指向该 exe 的当前用户关联键。它不写任何东西，也绝不碰正式安装版。
 */

import { execFile } from 'node:child_process'
import path from 'node:path'

interface CleanupOptions {
  executablePath?: string
  delayMs?: number
  logger?: Pick<Console, 'warn'>
}

function powershellExe(): string {
  return path.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function psSingleQuoted(value: string): string {
  return `'${String(value || '').replace(/'/g, "''")}'`
}

export function buildDevelopmentArtifactCleanupScript(executablePath: string): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$dev = ${psSingleQuoted(executablePath)}`,
    '$ws = New-Object -ComObject WScript.Shell',
    'function Test-DevTree($key) {',
    '  foreach ($name in $key.GetValueNames()) {',
    '    $value = "$($key.GetValue($name))"',
    '    if ($value -and $value.IndexOf($dev, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }',
    '  }',
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
    '      $sameExe = [string]::Equals([IO.Path]::GetFullPath($shortcut.TargetPath), [IO.Path]::GetFullPath($dev), [System.StringComparison]::OrdinalIgnoreCase)',
    '      $ours = $_.BaseName -match "^(STAR Hira NitroGen|STAR Hira NitroGen Development|HiraNG|HiraNG Development|Hira NG|Hira-NG|Electron)$" -or "$($shortcut.Arguments)" -match "--pwa-app="',
    '      if ($sameExe -and $ours) {',
    '        [IO.File]::SetAttributes($_.FullName, [IO.FileAttributes]::Normal)',
    '        Remove-Item -LiteralPath $_.FullName -Force',
    '      }',
    '    } catch {}',
    '  }',
    '}',
    '$hive = [Microsoft.Win32.Registry]::CurrentUser',
    '$owned = @(',
    '  "Software\\Classes\\HiraNGFile",',
    '  "Software\\Classes\\HiraNGURL",',
    '  "Software\\Clients\\StartMenuInternet\\STAR Hira NitroGen",',
    '  "Software\\Clients\\StartMenuInternet\\HiraNG",',
    '  "Software\\Classes\\Applications\\electron.exe",',
    '  "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\STAR Hira NitroGen.exe",',
    '  "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\HiraNG.exe",',
    '  "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\electron.exe"',
    ')',
    'foreach ($sub in $owned) {',
    '  $key = $hive.OpenSubKey($sub, $true)',
    '  if ($null -eq $key) { continue }',
    '  $isDev = Test-DevTree $key',
    '  $key.Close()',
    '  if ($isDev) { $hive.DeleteSubKeyTree($sub, $false) }',
    '}',
    'foreach ($scheme in @("http", "https")) {',
    '  $key = $hive.OpenSubKey("Software\\Classes\\$scheme\\shell\\open\\command", $true)',
    '  if ($null -ne $key) {',
    '    $value = "$($key.GetValue([string]::Empty))"',
    '    if ($value -and $value.IndexOf($dev, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $key.DeleteValue("", $false) }',
    '    $key.Close()',
    '  }',
    '}',
    '$pwaRoot = $hive.OpenSubKey("Software\\HiraNG\\PWA", $true)',
    'if ($null -ne $pwaRoot) {',
    '  foreach ($appId in @($pwaRoot.GetSubKeyNames())) {',
    '    $appKey = $pwaRoot.OpenSubKey($appId, $true)',
    '    if ($null -eq $appKey) { continue }',
    '    $isDevApp = Test-DevTree $appKey',
    '    if (-not $isDevApp) { $appKey.Close(); continue }',
    '    $cap = $appKey.OpenSubKey("Capabilities", $false)',
    '    if ($null -ne $cap) {',
    '      $fa = $cap.OpenSubKey("FileAssociations", $false)',
    '      if ($null -ne $fa) { foreach ($ext in $fa.GetValueNames()) { $open = $hive.OpenSubKey("Software\\Classes\\$ext\\OpenWithProgids", $true); if ($null -ne $open) { $open.DeleteValue("HiraNG.PWA.$appId.File", $false); $open.Close() } }; $fa.Close() }',
    '      $ua = $cap.OpenSubKey("URLAssociations", $false)',
    '      if ($null -ne $ua) { foreach ($scheme in $ua.GetValueNames()) { $open = $hive.OpenSubKey("Software\\Classes\\$scheme\\OpenWithProgids", $true); if ($null -ne $open) { $open.DeleteValue("HiraNG.PWA.$appId.URL", $false); $open.Close() } }; $ua.Close() }',
    '      $cap.Close()',
    '    }',
    '    $appKey.Close()',
    '    $pwaRoot.DeleteSubKeyTree($appId, $false)',
    '    $hive.DeleteSubKeyTree("Software\\Classes\\HiraNG.PWA.$appId.File", $false)',
    '    $hive.DeleteSubKeyTree("Software\\Classes\\HiraNG.PWA.$appId.URL", $false)',
    '    $registered = $hive.OpenSubKey("Software\\RegisteredApplications", $true)',
    '    if ($null -ne $registered) {',
    '      foreach ($name in @($registered.GetValueNames())) { if ("$($registered.GetValue($name))" -ieq "Software\\HiraNG\\PWA\\$appId\\Capabilities") { $registered.DeleteValue($name, $false) } }',
    '      $registered.Close()',
    '    }',
    '  }',
    '  $pwaRoot.Close()',
    '}',
    '$registered = $hive.OpenSubKey("Software\\RegisteredApplications", $true)',
    'if ($null -ne $registered) { $registered.DeleteValue("STAR Hira NitroGen", $false); $registered.DeleteValue("HiraNG", $false); $registered.Close() }',
    '$fileExts = $hive.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts", $false)',
    'if ($null -ne $fileExts) {',
    '  foreach ($ext in $fileExts.GetSubKeyNames()) {',
    '    $list = $hive.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\OpenWithList", $true)',
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
    'Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\ie4uinit.exe" -ArgumentList "-show"'
  ].join('\r\n')
}

export function scheduleDevelopmentArtifactCleanup({
  executablePath = process.execPath,
  delayMs = 2500,
  logger = console
}: CleanupOptions = {}): { dispose(): void } | null {
  if (process.platform !== 'win32') return null
  const target = String(executablePath || '')
  if (!target) return null
  const script = buildDevelopmentArtifactCleanupScript(target)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const timer = setTimeout(() => {
    try {
      execFile(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true },
        (error) => {
          if (error) logger.warn?.('[dev-cleanup] 清理开发态系统残留失败:', error.message)
        }
      )
    } catch (error) {
      logger.warn?.('[dev-cleanup] 无法启动清理进程:', error instanceof Error ? error.message : error)
    }
  }, Math.max(0, delayMs))
  timer.unref?.()
  return { dispose: () => clearTimeout(timer) }
}
