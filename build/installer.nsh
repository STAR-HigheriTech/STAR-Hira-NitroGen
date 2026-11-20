# ─────────────────────────────────────────────────────────────────────
# STAR Hira NitroGen 安装器 · 快捷方式兜底 + AUMID 抢注清理
#
# 为什么需要这个文件
#   electron-builder 自身的 createDesktopShortcut 默认策略是 FRESH_INSTALL：
#   只有「全新安装」才创建桌面快捷方式。一旦注册表里 KeepShortcuts=true
#   且旧 exe 仍在（覆盖安装 / 自动更新），addDesktopLink / addStartMenuLink
#   只会把「旧名 → 新名」Rename 一次 —— 用户手工删过 .lnk 的话，装完依旧是空。
#   开始菜单侧更没有对应的补救开关。
#
#   所以这里在 electron-builder 自身逻辑跑完之后，做一次幂等的「拉平到目标态」：
#     · 快捷方式存在 → 覆盖（顺便修正指向 / 图标 / AUMID / 描述）；
#     · 不存在     → 创建。
#
#   创建完必须显式通知外壳按路径刷新（SHCNE_CREATE / SHCNE_UPDATEDIR），
#   否则资源管理器可能沿用旧的目录快照，表现为「装完了但桌面 / 开始菜单看不到」。
#
# 外加一件必须做的事：清理抢注本应用 AUMID 的陈旧快捷方式。
#   开发期用 `electron .` 启动过本工程时，外壳会按 electron.exe 的显示名在开始菜单
#   落一个 "Electron.lnk"，并把 AppUserModelID 写成我们的 ${APP_ID}。Windows 解析
#   任务栏 / 开始菜单显示名时按 AUMID 命中这条 lnk，于是**应用名与图标都变成 Electron**
#   （Get-StartApps 也会把 ${APP_ID} 显示成 Electron）。删掉它，AUMID 才会回落到
#   安装器创建的 STAR Hira NitroGen.lnk 上。
#
# 上下文（当前用户 / 所有用户）沿用安装器已经选定的 $installMode：
#   不要在这里写死 SetShellVarContext —— 那会把 /currentuser 与 /allusers
#   的语义搞混（快捷方式写到另一个用户的桌面）。
# ─────────────────────────────────────────────────────────────────────

# <HIRA-ASSOCIATIONS:BEGIN>
# 本区由 scripts/gen-associations.ts 从 shared-types/src/associations.ts 生成，
# 请改数据源后重新运行脚本（pack-win 会自动跑），不要手改这里。

# 清理旧开发运行时留下的快捷方式 / AUMID / 幽灵关联（只命中 electron.exe 目标）。
!macro hiraPurgeDevelopmentArtifacts
  StrCpy $R0 ""
  StrCpy $R0 "$R0JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQAgAD0AIAAiAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAIgANAAoAJABkAGUAdgBQAGEAdAB0AGUAcgBuACAAPQAgACIAKAA/AGkAKQBbAFwAXAAvAF0AbgBvAGQAZQBfAG0AbwBkAHUAbABlAHMAWwBcAFwALwBdAGUAbABlAGMAdAByAG8AbgBbAFwAXAAvAF0AZABpAHMAdABbAFwAXAAvAF0AZQBsAGUAYwB0AHIAbwBuAFwALgBlAHgAZQAiAA0ACgAkAHcAcwAgAD0AIABOAGUAdwAtAE8AYgBqAGUAYwB0ACAALQBDAG8AbQBPAGIAagBlAGMAdAAgAFcAUwBjAHIAaQBwAHQALgBTAGgAZQBsAGwADQAKAGYAdQBuAGMAdABpAG8AbgAgAFQAZQBzAHQALQBEAGUAdgBUAHIAZQBlACgAJABrAGUAeQApACAAewANAAoAIAAgAGYAbwByAGUAYQBjAGgAIAAoACQAbgBhAG0AZQAgAGkAbgAgACQAawBlAHkALgBHAGUAdABWAGEAbAB1AGUATgBhAG0AZQBzACgAKQApACAAewAgAGkAZgAgACgAIgAkACgAJABrAGUAeQAuAEcAZQB0AFYAYQBsAHUAZQAoACQAbgBhAG0AZQApACkAIgAgAC0AbQBhAHQAYwBoACAAJABkAGUAdgBQAGEAdAB0AGUAcgBuACkAIAB7ACAAcgBlAHQAdQByAG4AIAAkAHQAcgB1AGUAIAB9ACAAfQANAAoAIAAgAGYAbwByAGUAYQBjAGgAIAAoACQAbgBhAG0AZQAgAGkAbgAgACQAawBlAHkALgBH"
  StrCpy $R0 "$R0AGUAdABTAHUAYgBLAGUAeQBOAGEAbQBlAHMAKAApACkAIAB7AA0ACgAgACAAIAAgACQAYwBoAGkAbABkACAAPQAgACQAawBlAHkALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAJABuAGEAbQBlACkADQAKACAAIAAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAYwBoAGkAbABkACkAIAB7ACAAJABmAG8AdQBuAGQAIAA9ACAAVABlAHMAdAAtAEQAZQB2AFQAcgBlAGUAIAAkAGMAaABpAGwAZAA7ACAAJABjAGgAaQBsAGQALgBDAGwAbwBzAGUAKAApADsAIABpAGYAIAAoACQAZgBvAHUAbgBkACkAIAB7ACAAcgBlAHQAdQByAG4AIAAkAHQAcgB1AGUAIAB9ACAAfQANAAoAIAAgAH0ADQAKACAAIAByAGUAdAB1AHIAbgAgACQAZgBhAGwAcwBlAA0ACgB9AA0ACgAkAHIAbwBvAHQAcwAgAD0AIABAACgADQAKACAAIABbAEUAbgB2AGkAcgBvAG4AbQBlAG4AdABdADoAOgBHAGUAdABGAG8AbABkAGUAcgBQAGEAdABoACgAIgBEAGUAcwBrAHQAbwBwACIAKQAsAA0ACgAgACAAWwBFAG4AdgBpAHIAbwBuAG0AZQBuAHQAXQA6ADoARwBlAHQARgBvAGwAZABlAHIAUABhAHQAaAAoACIAQwBvAG0AbQBvAG4ARABlAHMAawB0AG8AcABEAGkAcgBlAGMAdABvAHIAeQAiACkALAANAAoAIAAgAFsARQBuAHYAaQByAG8AbgBtAGUAbgB0AF0AOgA6AEcAZQB0AEYAbwBsAGQAZQByAFAAYQB0AGgAKAAiAFAA"
  StrCpy $R0 "$R0cgBvAGcAcgBhAG0AcwAiACkALAANAAoAIAAgAFsARQBuAHYAaQByAG8AbgBtAGUAbgB0AF0AOgA6AEcAZQB0AEYAbwBsAGQAZQByAFAAYQB0AGgAKAAiAEMAbwBtAG0AbwBuAFAAcgBvAGcAcgBhAG0AcwAiACkALAANAAoAIAAgAFsARQBuAHYAaQByAG8AbgBtAGUAbgB0AF0AOgA6AEcAZQB0AEYAbwBsAGQAZQByAFAAYQB0AGgAKAAiAFMAdABhAHIAdAB1AHAAIgApACwADQAKACAAIABbAEUAbgB2AGkAcgBvAG4AbQBlAG4AdABdADoAOgBHAGUAdABGAG8AbABkAGUAcgBQAGEAdABoACgAIgBDAG8AbQBtAG8AbgBTAHQAYQByAHQAdQBwACIAKQAsAA0ACgAgACAAIgAkAGUAbgB2ADoAQQBQAFAARABBAFQAQQBcAE0AaQBjAHIAbwBzAG8AZgB0AFwASQBuAHQAZQByAG4AZQB0ACAARQB4AHAAbABvAHIAZQByAFwAUQB1AGkAYwBrACAATABhAHUAbgBjAGgAXABVAHMAZQByACAAUABpAG4AbgBlAGQAXABUAGEAcwBrAEIAYQByACIADQAKACkAIAB8ACAAVwBoAGUAcgBlAC0ATwBiAGoAZQBjAHQAIAB7ACAAJABfACAALQBhAG4AZAAgACgAVABlAHMAdAAtAFAAYQB0AGgAIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQAaAAgACQAXwApACAAfQAgAHwAIABTAGUAbABlAGMAdAAtAE8AYgBqAGUAYwB0ACAALQBVAG4AaQBxAHUAZQANAAoAZgBvAHIAZQBhAGMAaAAgACgAJAByAG8AbwB0ACAAaQBuACAAJABy"
  StrCpy $R0 "$R0AG8AbwB0AHMAKQAgAHsADQAKACAAIABHAGUAdAAtAEMAaABpAGwAZABJAHQAZQBtACAALQBMAGkAdABlAHIAYQBsAFAAYQB0AGgAIAAkAHIAbwBvAHQAIAAtAFIAZQBjAHUAcgBzAGUAIAAtAEYAaQBsAHQAZQByACAAKgAuAGwAbgBrACAALQBGAGkAbABlACAALQBFAHIAcgBvAHIAQQBjAHQAaQBvAG4AIABTAGkAbABlAG4AdABsAHkAQwBvAG4AdABpAG4AdQBlACAAfAAgAEYAbwByAEUAYQBjAGgALQBPAGIAagBlAGMAdAAgAHsADQAKACAAIAAgACAAdAByAHkAIAB7AA0ACgAgACAAIAAgACAAIAAkAHMAaABvAHIAdABjAHUAdAAgAD0AIAAkAHcAcwAuAEMAcgBlAGEAdABlAFMAaABvAHIAdABjAHUAdAAoACQAXwAuAEYAdQBsAGwATgBhAG0AZQApAA0ACgAgACAAIAAgACAAIAAkAGkAcwBEAGUAdgAgAD0AIAAiACQAKAAkAHMAaABvAHIAdABjAHUAdAAuAFQAYQByAGcAZQB0AFAAYQB0AGgAKQAiACAALQBtAGEAdABjAGgAIAAkAGQAZQB2AFAAYQB0AHQAZQByAG4ADQAKACAAIAAgACAAIAAgACQAaQBzAE8AdQByAHMAIAA9ACAAJABfAC4AQgBhAHMAZQBOAGEAbQBlACAALQBtAGEAdABjAGgAIAAiAF4AKABTAFQAQQBSACAASABpAHIAYQAgAE4AaQB0AHIAbwBHAGUAbgB8AFMAVABBAFIAIABIAGkAcgBhACAATgBpAHQAcgBvAEcAZQBuACAARABlAHYAZQBsAG8AcABtAGUAbgB0AHwASABpAHIA"
  StrCpy $R0 "$R0YQBOAEcAfABIAGkAcgBhAE4ARwAgAEQAZQB2AGUAbABvAHAAbQBlAG4AdAB8AEgAaQByAGEAIABOAEcAfABIAGkAcgBhAC0ATgBHAHwARQBsAGUAYwB0AHIAbwBuACkAJAAiACAALQBvAHIAIAAiACQAKAAkAHMAaABvAHIAdABjAHUAdAAuAEEAcgBnAHUAbQBlAG4AdABzACkAIgAgAC0AbQBhAHQAYwBoACAAIgAtAC0AcAB3AGEALQBhAHAAcAA9ACIADQAKACAAIAAgACAAIAAgAGkAZgAgACgAJABpAHMARABlAHYAIAAtAGEAbgBkACAAJABpAHMATwB1AHIAcwApACAAewANAAoAIAAgACAAIAAgACAAIAAgAFsASQBPAC4ARgBpAGwAZQBdADoAOgBTAGUAdABBAHQAdAByAGkAYgB1AHQAZQBzACgAJABfAC4ARgB1AGwAbABOAGEAbQBlACwAIABbAEkATwAuAEYAaQBsAGUAQQB0AHQAcgBpAGIAdQB0AGUAcwBdADoAOgBOAG8AcgBtAGEAbAApAA0ACgAgACAAIAAgACAAIAAgACAAUgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBMAGkAdABlAHIAYQBsAFAAYQB0AGgAIAAkAF8ALgBGAHUAbABsAE4AYQBtAGUAIAAtAEYAbwByAGMAZQANAAoAIAAgACAAIAAgACAAfQANAAoAIAAgACAAIAB9ACAAYwBhAHQAYwBoACAAewB9AA0ACgAgACAAfQANAAoAfQANAAoAJABoAGkAdgBlAHMAIAA9ACAAQAAoAFsATQBpAGMAcgBvAHMAbwBmAHQALgBXAGkAbgAzADIALgBSAGUAZwBpAHMAdAByAHkAXQA6ADoAQwB1"
  StrCpy $R0 "$R0AHIAcgBlAG4AdABVAHMAZQByACwAIABbAE0AaQBjAHIAbwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AF0AOgA6AEwAbwBjAGEAbABNAGEAYwBoAGkAbgBlACkADQAKACQAbwB3AG4AZQBkACAAPQAgAEAAKAANAAoAIAAgACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGEAcwBzAGUAcwBcAEgAaQByAGEATgBHAEYAaQBsAGUAIgAsAA0ACgAgACAAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAYQBzAHMAZQBzAFwASABpAHIAYQBOAEcAVQBSAEwAIgAsAA0ACgAgACAAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAaQBlAG4AdABzAFwAUwB0AGEAcgB0AE0AZQBuAHUASQBuAHQAZQByAG4AZQB0AFwAUwBUAEEAUgAgAEgAaQByAGEAIABOAGkAdAByAG8ARwBlAG4AIgAsAA0ACgAgACAAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAaQBlAG4AdABzAFwAUwB0AGEAcgB0AE0AZQBuAHUASQBuAHQAZQByAG4AZQB0AFwASABpAHIAYQBOAEcAIgAsAA0ACgAgACAAIgBTAG8AZgB0AHcAYQByAGUAXABNAGkAYwByAG8AcwBvAGYAdABcAFcAaQBuAGQAbwB3AHMAXABDAHUAcgByAGUAbgB0AFYAZQByAHMAaQBvAG4AXABBAHAAcAAgAFAAYQB0AGgAcwBcAFMAVABBAFIAIABIAGkAcgBhACAATgBpAHQAcgBvAEcAZQBuAC4AZQB4AGUAIgAsAA0ACgAgACAAIgBTAG8AZgB0AHcAYQByAGUAXABNAGkA"
  StrCpy $R0 "$R0YwByAG8AcwBvAGYAdABcAFcAaQBuAGQAbwB3AHMAXABDAHUAcgByAGUAbgB0AFYAZQByAHMAaQBvAG4AXABBAHAAcAAgAFAAYQB0AGgAcwBcAEgAaQByAGEATgBHAC4AZQB4AGUAIgANAAoAKQANAAoAZgBvAHIAZQBhAGMAaAAgACgAJABoAGkAdgBlACAAaQBuACAAJABoAGkAdgBlAHMAKQAgAHsADQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAHMAdQBiACAAaQBuACAAJABvAHcAbgBlAGQAKQAgAHsADQAKACAAIAAgACAAJABrAGUAeQAgAD0AIAAkAGgAaQB2AGUALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAJABzAHUAYgAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAGUAcQAgACQAawBlAHkAKQAgAHsAIABjAG8AbgB0AGkAbgB1AGUAIAB9AA0ACgAgACAAIAAgACQAaQBzAEQAZQB2ACAAPQAgAFQAZQBzAHQALQBEAGUAdgBUAHIAZQBlACAAJABrAGUAeQANAAoAIAAgACAAIAAkAGsAZQB5AC4AQwBsAG8AcwBlACgAKQANAAoAIAAgACAAIABpAGYAIAAoACQAaQBzAEQAZQB2ACkAIAB7ACAAJABoAGkAdgBlAC4ARABlAGwAZQB0AGUAUwB1AGIASwBlAHkAVAByAGUAZQAoACQAcwB1AGIALAAgACQAZgBhAGwAcwBlACkAIAB9AA0ACgAgACAAfQANAAoAIAAgACQAYwBsAGkAZQBuAHQAIAA9ACAAJABoAGkAdgBlAC4ATwBwAGUAbgBTAHUAYgBLAGUAeQAo"
  StrCpy $R0 "$R0ACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGkAZQBuAHQAcwBcAFMAdABhAHIAdABNAGUAbgB1AEkAbgB0AGUAcgBuAGUAdABcAFMAVABBAFIAIABIAGkAcgBhACAATgBpAHQAcgBvAEcAZQBuAFwAcwBoAGUAbABsAFwAbwBwAGUAbgBcAGMAbwBtAG0AYQBuAGQAIgAsACAAJABmAGEAbABzAGUAKQANAAoAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAGMAbABpAGUAbgB0ACkAIAB7AA0ACgAgACAAIAAgACQAaQBzAEQAZQB2AEMAbABpAGUAbgB0ACAAPQAgACIAJAAoACQAYwBsAGkAZQBuAHQALgBHAGUAdABWAGEAbAB1AGUAKABbAHMAdAByAGkAbgBnAF0AOgA6AEUAbQBwAHQAeQApACkAIgAgAC0AbQBhAHQAYwBoACAAJABkAGUAdgBQAGEAdAB0AGUAcgBuAA0ACgAgACAAIAAgACQAYwBsAGkAZQBuAHQALgBDAGwAbwBzAGUAKAApAA0ACgAgACAAIAAgAGkAZgAgACgAJABpAHMARABlAHYAQwBsAGkAZQBuAHQAKQAgAHsADQAKACAAIAAgACAAIAAgACQAcgBlAGcAaQBzAHQAZQByAGUAZAAgAD0AIAAkAGgAaQB2AGUALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBTAG8AZgB0AHcAYQByAGUAXABSAGUAZwBpAHMAdABlAHIAZQBkAEEAcABwAGwAaQBjAGEAdABpAG8AbgBzACIALAAgACQAdAByAHUAZQApAA0ACgAgACAAIAAgACAAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AbgBlACAA"
  StrCpy $R0 "$R0JAByAGUAZwBpAHMAdABlAHIAZQBkACkAIAB7ACAAJAByAGUAZwBpAHMAdABlAHIAZQBkAC4ARABlAGwAZQB0AGUAVgBhAGwAdQBlACgAIgBTAFQAQQBSACAASABpAHIAYQAgAE4AaQB0AHIAbwBHAGUAbgAiACwAIAAkAGYAYQBsAHMAZQApADsAIAAkAHIAZQBnAGkAcwB0AGUAcgBlAGQALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAiAEgAaQByAGEATgBHACIALAAgACQAZgBhAGwAcwBlACkAOwAgACQAcgBlAGcAaQBzAHQAZQByAGUAZAAuAEMAbABvAHMAZQAoACkAIAB9AA0ACgAgACAAIAAgAH0ADQAKACAAIAB9AA0ACgAgACAAZgBvAHIAZQBhAGMAaAAgACgAJABzAGMAaABlAG0AZQAgAGkAbgAgAEAAKAAiAGgAdAB0AHAAIgAsACAAIgBoAHQAdABwAHMAIgApACkAIAB7AA0ACgAgACAAIAAgACQAYwBvAG0AbQBhAG4AZAAgAD0AIAAkAGgAaQB2AGUALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAYQBzAHMAZQBzAFwAJABzAGMAaABlAG0AZQBcAHMAaABlAGwAbABcAG8AcABlAG4AXABjAG8AbQBtAGEAbgBkACIALAAgACQAdAByAHUAZQApAA0ACgAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAGMAbwBtAG0AYQBuAGQAKQAgAHsADQAKACAAIAAgACAAIAAgAGkAZgAgACgAIgAkACgAJABjAG8AbQBtAGEAbgBkAC4ARwBlAHQAVgBh"
  StrCpy $R0 "$R0AGwAdQBlACgAWwBzAHQAcgBpAG4AZwBdADoAOgBFAG0AcAB0AHkAKQApACIAIAAtAG0AYQB0AGMAaAAgACQAZABlAHYAUABhAHQAdABlAHIAbgApACAAewAgACQAYwBvAG0AbQBhAG4AZAAuAEQAZQBsAGUAdABlAFYAYQBsAHUAZQAoACIAIgAsACAAJABmAGEAbABzAGUAKQAgAH0ADQAKACAAIAAgACAAIAAgACQAYwBvAG0AbQBhAG4AZAAuAEMAbABvAHMAZQAoACkADQAKACAAIAAgACAAfQANAAoAIAAgAH0ADQAKACAAIAAkAHAAdwBhAFIAbwBvAHQAIAA9ACAAJABoAGkAdgBlAC4ATwBwAGUAbgBTAHUAYgBLAGUAeQAoACIAUwBvAGYAdAB3AGEAcgBlAFwASABpAHIAYQBOAEcAXABQAFcAQQAiACwAIAAkAHQAcgB1AGUAKQANAAoAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAHAAdwBhAFIAbwBvAHQAKQAgAHsADQAKACAAIAAgACAAZgBvAHIAZQBhAGMAaAAgACgAJABhAHAAcABJAGQAIABpAG4AIABAACgAJABwAHcAYQBSAG8AbwB0AC4ARwBlAHQAUwB1AGIASwBlAHkATgBhAG0AZQBzACgAKQApACkAIAB7AA0ACgAgACAAIAAgACAAIAAkAGEAcABwAEsAZQB5ACAAPQAgACQAcAB3AGEAUgBvAG8AdAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAkAGEAcABwAEkAZAAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBlAHEAIAAkAGEA"
  StrCpy $R0 "$R0cABwAEsAZQB5ACkAIAB7ACAAYwBvAG4AdABpAG4AdQBlACAAfQANAAoAIAAgACAAIAAgACAAJABpAHMARABlAHYAQQBwAHAAIAA9ACAAVABlAHMAdAAtAEQAZQB2AFQAcgBlAGUAIAAkAGEAcABwAEsAZQB5AA0ACgAgACAAIAAgACAAIABpAGYAIAAoAC0AbgBvAHQAIAAkAGkAcwBEAGUAdgBBAHAAcAApACAAewAgACQAYQBwAHAASwBlAHkALgBDAGwAbwBzAGUAKAApADsAIABjAG8AbgB0AGkAbgB1AGUAIAB9AA0ACgAgACAAIAAgACAAIAAkAGMAYQBwACAAPQAgACQAYQBwAHAASwBlAHkALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBDAGEAcABhAGIAaQBsAGkAdABpAGUAcwAiACwAIAAkAGYAYQBsAHMAZQApAA0ACgAgACAAIAAgACAAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AbgBlACAAJABjAGEAcAApACAAewANAAoAIAAgACAAIAAgACAAIAAgACQAZgBhACAAPQAgACQAYwBhAHAALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBGAGkAbABlAEEAcwBzAG8AYwBpAGEAdABpAG8AbgBzACIALAAgACQAZgBhAGwAcwBlACkADQAKACAAIAAgACAAIAAgACAAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AbgBlACAAJABmAGEAKQAgAHsAIABmAG8AcgBlAGEAYwBoACAAKAAkAGUAeAB0ACAAaQBuACAAJABmAGEALgBHAGUAdABWAGEAbAB1AGUATgBhAG0AZQBzACgAKQApACAAewAgAGYAbwByAGUAYQBj"
  StrCpy $R0 "$R0AGgAIAAoACQAdABhAHIAZwBlAHQAIABpAG4AIAAkAGgAaQB2AGUAcwApACAAewAgACQAbwBwAGUAbgAgAD0AIAAkAHQAYQByAGcAZQB0AC4ATwBwAGUAbgBTAHUAYgBLAGUAeQAoACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGEAcwBzAGUAcwBcACQAZQB4AHQAXABPAHAAZQBuAFcAaQB0AGgAUAByAG8AZwBpAGQAcwAiACwAIAAkAHQAcgB1AGUAKQA7ACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAbwBwAGUAbgApACAAewAgACQAbwBwAGUAbgAuAEQAZQBsAGUAdABlAFYAYQBsAHUAZQAoACIASABpAHIAYQBOAEcALgBQAFcAQQAuACQAYQBwAHAASQBkAC4ARgBpAGwAZQAiACwAIAAkAGYAYQBsAHMAZQApADsAIAAkAG8AcABlAG4ALgBDAGwAbwBzAGUAKAApACAAfQAgAH0AIAB9ADsAIAAkAGYAYQAuAEMAbABvAHMAZQAoACkAIAB9AA0ACgAgACAAIAAgACAAIAAgACAAJAB1AGEAIAA9ACAAJABjAGEAcAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFUAUgBMAEEAcwBzAG8AYwBpAGEAdABpAG8AbgBzACIALAAgACQAZgBhAGwAcwBlACkADQAKACAAIAAgACAAIAAgACAAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AbgBlACAAJAB1AGEAKQAgAHsAIABmAG8AcgBlAGEAYwBoACAAKAAkAHMAYwBoAGUAbQBlACAAaQBuACAAJAB1AGEALgBHAGUAdABWAGEAbAB1AGUATgBhAG0AZQBzACgA"
  StrCpy $R0 "$R0KQApACAAewAgAGYAbwByAGUAYQBjAGgAIAAoACQAdABhAHIAZwBlAHQAIABpAG4AIAAkAGgAaQB2AGUAcwApACAAewAgACQAbwBwAGUAbgAgAD0AIAAkAHQAYQByAGcAZQB0AC4ATwBwAGUAbgBTAHUAYgBLAGUAeQAoACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGEAcwBzAGUAcwBcACQAcwBjAGgAZQBtAGUAXABPAHAAZQBuAFcAaQB0AGgAUAByAG8AZwBpAGQAcwAiACwAIAAkAHQAcgB1AGUAKQA7ACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAbwBwAGUAbgApACAAewAgACQAbwBwAGUAbgAuAEQAZQBsAGUAdABlAFYAYQBsAHUAZQAoACIASABpAHIAYQBOAEcALgBQAFcAQQAuACQAYQBwAHAASQBkAC4AVQBSAEwAIgAsACAAJABmAGEAbABzAGUAKQA7ACAAJABvAHAAZQBuAC4AQwBsAG8AcwBlACgAKQAgAH0AIAB9ACAAfQA7ACAAJAB1AGEALgBDAGwAbwBzAGUAKAApACAAfQANAAoAIAAgACAAIAAgACAAIAAgACQAYwBhAHAALgBDAGwAbwBzAGUAKAApAA0ACgAgACAAIAAgACAAIAB9AA0ACgAgACAAIAAgACAAIAAkAGEAcABwAEsAZQB5AC4AQwBsAG8AcwBlACgAKQANAAoAIAAgACAAIAAgACAAJABwAHcAYQBSAG8AbwB0AC4ARABlAGwAZQB0AGUAUwB1AGIASwBlAHkAVAByAGUAZQAoACQAYQBwAHAASQBkACwAIAAkAGYAYQBsAHMAZQApAA0ACgAgACAAIAAgACAAIABmAG8AcgBl"
  StrCpy $R0 "$R0AGEAYwBoACAAKAAkAHQAYQByAGcAZQB0ACAAaQBuACAAJABoAGkAdgBlAHMAKQAgAHsADQAKACAAIAAgACAAIAAgACAAIAAkAHQAYQByAGcAZQB0AC4ARABlAGwAZQB0AGUAUwB1AGIASwBlAHkAVAByAGUAZQAoACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGEAcwBzAGUAcwBcAEgAaQByAGEATgBHAC4AUABXAEEALgAkAGEAcABwAEkAZAAuAEYAaQBsAGUAIgAsACAAJABmAGEAbABzAGUAKQANAAoAIAAgACAAIAAgACAAIAAgACQAdABhAHIAZwBlAHQALgBEAGUAbABlAHQAZQBTAHUAYgBLAGUAeQBUAHIAZQBlACgAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAYQBzAHMAZQBzAFwASABpAHIAYQBOAEcALgBQAFcAQQAuACQAYQBwAHAASQBkAC4AVQBSAEwAIgAsACAAJABmAGEAbABzAGUAKQANAAoAIAAgACAAIAAgACAAfQANAAoAIAAgACAAIAAgACAAJAByAGUAZwBpAHMAdABlAHIAZQBkACAAPQAgACQAaABpAHYAZQAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAFIAZQBnAGkAcwB0AGUAcgBlAGQAQQBwAHAAbABpAGMAYQB0AGkAbwBuAHMAIgAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAHIAZQBnAGkAcwB0AGUAcgBlAGQAKQAgAHsADQAKACAAIAAgACAAIAAgACAAIABmAG8AcgBlAGEAYwBoACAA"
  StrCpy $R0 "$R0KAAkAG4AYQBtAGUAIABpAG4AIABAACgAJAByAGUAZwBpAHMAdABlAHIAZQBkAC4ARwBlAHQAVgBhAGwAdQBlAE4AYQBtAGUAcwAoACkAKQApACAAewAgAGkAZgAgACgAIgAkACgAJAByAGUAZwBpAHMAdABlAHIAZQBkAC4ARwBlAHQAVgBhAGwAdQBlACgAJABuAGEAbQBlACkAKQAiACAALQBpAGUAcQAgACIAUwBvAGYAdAB3AGEAcgBlAFwASABpAHIAYQBOAEcAXABQAFcAQQBcACQAYQBwAHAASQBkAFwAQwBhAHAAYQBiAGkAbABpAHQAaQBlAHMAIgApACAAewAgACQAcgBlAGcAaQBzAHQAZQByAGUAZAAuAEQAZQBsAGUAdABlAFYAYQBsAHUAZQAoACQAbgBhAG0AZQAsACAAJABmAGEAbABzAGUAKQAgAH0AIAB9AA0ACgAgACAAIAAgACAAIAAgACAAJAByAGUAZwBpAHMAdABlAHIAZQBkAC4AQwBsAG8AcwBlACgAKQANAAoAIAAgACAAIAAgACAAfQANAAoAIAAgACAAIAB9AA0ACgAgACAAIAAgACQAcAB3AGEAUgBvAG8AdAAuAEMAbABvAHMAZQAoACkADQAKACAAIAB9AA0ACgB9AA0ACgAkAGUAbABlAGMAdAByAG8AbgBBAHAAcAAgAD0AIABbAE0AaQBjAHIAbwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AF0AOgA6AEMAdQByAHIAZQBuAHQAVQBzAGUAcgAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAEMAbABhAHMAcwBlAHMAXABBAHAAcABs"
  StrCpy $R0 "$R0AGkAYwBhAHQAaQBvAG4AcwBcAGUAbABlAGMAdAByAG8AbgAuAGUAeABlAFwAcwBoAGUAbABsAFwAbwBwAGUAbgBcAGMAbwBtAG0AYQBuAGQAIgAsACAAJABmAGEAbABzAGUAKQANAAoAaQBmACAAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAZQBsAGUAYwB0AHIAbwBuAEEAcABwACkAIAB7AA0ACgAgACAAJABpAHMARABlAHYAQQBwAHAAIAA9ACAAIgAkACgAJABlAGwAZQBjAHQAcgBvAG4AQQBwAHAALgBHAGUAdABWAGEAbAB1AGUAKABbAHMAdAByAGkAbgBnAF0AOgA6AEUAbQBwAHQAeQApACkAIgAgAC0AbQBhAHQAYwBoACAAJABkAGUAdgBQAGEAdAB0AGUAcgBuAA0ACgAgACAAJABlAGwAZQBjAHQAcgBvAG4AQQBwAHAALgBDAGwAbwBzAGUAKAApAA0ACgAgACAAaQBmACAAKAAkAGkAcwBEAGUAdgBBAHAAcAApACAAewAgAFsATQBpAGMAcgBvAHMAbwBmAHQALgBXAGkAbgAzADIALgBSAGUAZwBpAHMAdAByAHkAXQA6ADoAQwB1AHIAcgBlAG4AdABVAHMAZQByAC4ARABlAGwAZQB0AGUAUwB1AGIASwBlAHkAVAByAGUAZQAoACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBsAGEAcwBzAGUAcwBcAEEAcABwAGwAaQBjAGEAdABpAG8AbgBzAFwAZQBsAGUAYwB0AHIAbwBuAC4AZQB4AGUAIgAsACAAJABmAGEAbABzAGUAKQAgAH0ADQAKAH0ADQAKACQAYQBwAHAAUABhAHQAaAAgAD0AIABbAE0AaQBjAHIA"
  StrCpy $R0 "$R0bwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AF0AOgA6AEMAdQByAHIAZQBuAHQAVQBzAGUAcgAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAE0AaQBjAHIAbwBzAG8AZgB0AFwAVwBpAG4AZABvAHcAcwBcAEMAdQByAHIAZQBuAHQAVgBlAHIAcwBpAG8AbgBcAEEAcABwACAAUABhAHQAaABzAFwAZQBsAGUAYwB0AHIAbwBuAC4AZQB4AGUAIgAsACAAJAB0AHIAdQBlACkADQAKAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAGEAcABwAFAAYQB0AGgAKQAgAHsADQAKACAAIABpAGYAIAAoACIAJAAoACQAYQBwAHAAUABhAHQAaAAuAEcAZQB0AFYAYQBsAHUAZQAoAFsAcwB0AHIAaQBuAGcAXQA6ADoARQBtAHAAdAB5ACkAKQAiACAALQBtAGEAdABjAGgAIAAkAGQAZQB2AFAAYQB0AHQAZQByAG4AKQAgAHsAIAAkAGEAcABwAFAAYQB0AGgALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAiACIALAAgACQAZgBhAGwAcwBlACkAIAB9AA0ACgAgACAAJABhAHAAcABQAGEAdABoAC4AQwBsAG8AcwBlACgAKQANAAoAfQANAAoAJABmAGkAbABlAEUAeAB0AHMAIAA9ACAAWwBNAGkAYwByAG8AcwBvAGYAdAAuAFcAaQBuADMAMgAuAFIAZQBnAGkAcwB0AHIAeQBdADoAOgBDAHUAcgByAGUAbgB0AFUAcwBlAHIALgBPAHAAZQBuAFMAdQBiAEsAZQB5"
  StrCpy $R0 "$R0ACgAIgBTAG8AZgB0AHcAYQByAGUAXABNAGkAYwByAG8AcwBvAGYAdABcAFcAaQBuAGQAbwB3AHMAXABDAHUAcgByAGUAbgB0AFYAZQByAHMAaQBvAG4AXABFAHgAcABsAG8AcgBlAHIAXABGAGkAbABlAEUAeAB0AHMAIgAsACAAJABmAGEAbABzAGUAKQANAAoAaQBmACAAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAZgBpAGwAZQBFAHgAdABzACkAIAB7AA0ACgAgACAAZgBvAHIAZQBhAGMAaAAgACgAJABlAHgAdAAgAGkAbgAgACQAZgBpAGwAZQBFAHgAdABzAC4ARwBlAHQAUwB1AGIASwBlAHkATgBhAG0AZQBzACgAKQApACAAewANAAoAIAAgACAAIAAkAGwAaQBzAHQAIAA9ACAAWwBNAGkAYwByAG8AcwBvAGYAdAAuAFcAaQBuADMAMgAuAFIAZQBnAGkAcwB0AHIAeQBdADoAOgBDAHUAcgByAGUAbgB0AFUAcwBlAHIALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBTAG8AZgB0AHcAYQByAGUAXABNAGkAYwByAG8AcwBvAGYAdABcAFcAaQBuAGQAbwB3AHMAXABDAHUAcgByAGUAbgB0AFYAZQByAHMAaQBvAG4AXABFAHgAcABsAG8AcgBlAHIAXABGAGkAbABlAEUAeAB0AHMAXAAkAGUAeAB0AFwATwBwAGUAbgBXAGkAdABoAEwAaQBzAHQAIgAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAGUAcQAgACQAbABpAHMAdAApACAAewAgAGMAbwBuAHQAaQBuAHUA"
  StrCpy $R0 "$R0ZQAgAH0ADQAKACAAIAAgACAAJABtAHIAdQAgAD0AIAAiACQAKAAkAGwAaQBzAHQALgBHAGUAdABWAGEAbAB1AGUAKAAiAE0AUgBVAEwAaQBzAHQAIgApACkAIgANAAoAIAAgACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAG4AYQBtAGUAIABpAG4AIABAACgAJABsAGkAcwB0AC4ARwBlAHQAVgBhAGwAdQBlAE4AYQBtAGUAcwAoACkAKQApACAAewANAAoAIAAgACAAIAAgACAAaQBmACAAKAAkAG4AYQBtAGUAIAAtAG4AZQAgACIATQBSAFUATABpAHMAdAAiACAALQBhAG4AZAAgACIAJAAoACQAbABpAHMAdAAuAEcAZQB0AFYAYQBsAHUAZQAoACQAbgBhAG0AZQApACkAIgAgAC0AbQBhAHQAYwBoACAAIgBeACgAPwBpACkAZQBsAGUAYwB0AHIAbwBuAFwALgBlAHgAZQAkACIAKQAgAHsADQAKACAAIAAgACAAIAAgACAAIAAkAGwAaQBzAHQALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAkAG4AYQBtAGUALAAgACQAZgBhAGwAcwBlACkADQAKACAAIAAgACAAIAAgACAAIAAkAG0AcgB1ACAAPQAgACQAbQByAHUALgBSAGUAcABsAGEAYwBlACgAJABuAGEAbQBlACwAIAAiACIAKQANAAoAIAAgACAAIAAgACAAfQANAAoAIAAgACAAIAB9AA0ACgAgACAAIAAgAGkAZgAgACgAJABtAHIAdQApACAAewAgACQAbABpAHMAdAAuAFMAZQB0AFYAYQBsAHUAZQAoACIATQBSAFUATABpAHMAdAAiACwAIAAkAG0AcgB1"
  StrCpy $R0 "$R0ACkAIAB9AA0ACgAgACAAIAAgACQAbABpAHMAdAAuAEMAbABvAHMAZQAoACkADQAKACAAIAB9AA0ACgAgACAAJABmAGkAbABlAEUAeAB0AHMALgBDAGwAbwBzAGUAKAApAA0ACgB9AA0ACgBTAHQAYQByAHQALQBQAHIAbwBjAGUAcwBzACAALQBXAGkAbgBkAG8AdwBTAHQAeQBsAGUAIABIAGkAZABkAGUAbgAgAC0ARgBpAGwAZQBQAGEAdABoACAAIgAkAGUAbgB2ADoAUwB5AHMAdABlAG0AUgBvAG8AdABcAFMAeQBzAHQAZQBtADMAMgBcAGkAZQA0AHUAaQBuAGkAdAAuAGUAeABlACIAIAAtAEEAcgBnAHUAbQBlAG4AdABMAGkAcwB0ACAAIgAtAHMAaABvAHcAIgANAAoAVwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAiAGQAZQB2AGUAbABvAHAAbQBlAG4AdAAtAGEAcgB0AGkAZgBhAGMAdABzAHwAYwBsAGUAYQBuAGUAZAAiAA=="
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $R0'
  Pop $0
  StrCpy $R0 ""
!macroend

!macro hiraRegisterAssociations
  WriteRegStr HKCU "Software\Classes\HiraNGFile" "" "STAR Hira NitroGen Document"
  WriteRegStr HKCU "Software\Classes\HiraNGFile" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\Application" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\Application" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\Application" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\Application" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\Application" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\HiraNGFile\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKCU "Software\Classes\HiraNGURL" "" "STAR Hira NitroGen Protocol"
  WriteRegStr HKCU "Software\Classes\HiraNGURL" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\Application" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\Application" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\Application" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\Application" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\Application" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\HiraNGURL\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKCU "Software\Classes\HiraNGURL" "FriendlyTypeName" "STAR Hira NitroGen Protocol"
  WriteRegStr HKCU "Software\Classes\HiraNGURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\.htm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.mht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.xht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.svg\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.svgz\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.webp\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.avif\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.xml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\.webm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKCU "Software\Classes\http\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\https\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\ftp\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\irc\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\mailto\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\mms\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\news\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\nntp\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\read\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\sms\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\smsto\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\snews\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\tel\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\urn\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\webcal\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\Classes\webcals\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKCU "Software\RegisteredApplications" "STAR Hira NitroGen" "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen" "" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\""
  WriteRegDWORD HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\InstallInfo" "IconsVisible" 0x00000001
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\StartMenu" "StartMenuInternet" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".htm" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".html" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".mht" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".mhtml" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".shtml" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xht" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xhtm" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xhtml" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".svg" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".svgz" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".webp" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".avif" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xml" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".pdf" "HiraNGFile"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "http" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "https" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "ftp" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "irc" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "mailto" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "mms" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "news" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "nntp" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "read" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "sms" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "smsto" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "snews" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "tel" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "urn" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "webcal" "HiraNGURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "webcals" "HiraNGURL"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "STAR Hira NitroGen"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".htm" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".html" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".mht" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".mhtml" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".shtml" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xht" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xhtm" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xhtml" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".svg" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".svgz" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".webp" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".avif" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xml" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".webm" ""
  WriteRegStr HKCU "Software\Classes\http\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKCU "Software\Classes\https\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "DefaultIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}\SupportedProtocols" "http" ""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}\SupportedProtocols" "https" ""
  WriteRegStr HKCU "Software\HiraNG\Associations" "SchemaFingerprint" "fbc91361"
!macroend

# 机器级身份：Windows 的“默认应用”浏览器列表主要枚举这一层。
# 这里只发布候选与能力，不写 http/https 回退命令，避免替任何用户抢默认。
!macro hiraRegisterMachineAssociations
  WriteRegStr HKLM "Software\Classes\HiraNGFile" "" "STAR Hira NitroGen Document"
  WriteRegStr HKLM "Software\Classes\HiraNGFile" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\Application" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\Application" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\Application" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\Application" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\Application" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Classes\HiraNGFile\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKLM "Software\Classes\HiraNGURL" "" "STAR Hira NitroGen Protocol"
  WriteRegStr HKLM "Software\Classes\HiraNGURL" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\Application" "AppUserModelId" "com.starhigheritech.hira-ng"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\Application" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\Application" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\Application" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\Application" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Classes\HiraNGURL\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKLM "Software\Classes\HiraNGURL" "FriendlyTypeName" "STAR Hira NitroGen Protocol"
  WriteRegStr HKLM "Software\Classes\HiraNGURL" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\.htm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.html\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.mht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.svg\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.svgz\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.webp\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.avif\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.pdf\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.webm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\http\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\https\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\ftp\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\irc\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\mailto\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\mms\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\news\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\nntp\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\read\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\sms\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\smsto\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\snews\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\tel\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\urn\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\webcal\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\Classes\webcals\OpenWithProgids" "HiraNGURL" ""
  WriteRegStr HKLM "Software\RegisteredApplications" "STAR Hira NitroGen" "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen" "" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\""
  WriteRegDWORD HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\InstallInfo" "IconsVisible" 0x00000001
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationName" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationCompany" "STAR HigheriTech"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities" "ApplicationDescription" "STAR Hira NitroGen — 快速、干净的现代浏览器"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\StartMenu" "StartMenuInternet" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".htm" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".html" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".mht" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".mhtml" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".shtml" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xht" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xhtm" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xhtml" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".svg" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".svgz" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".webp" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".avif" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".xml" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\FileAssociations" ".pdf" "HiraNGFile"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "http" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "https" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "ftp" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "irc" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "mailto" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "mms" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "news" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "nntp" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "read" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "sms" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "smsto" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "snews" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "tel" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "urn" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "webcal" "HiraNGURL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen\Capabilities\URLAssociations" "webcals" "HiraNGURL"
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "STAR Hira NitroGen"
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-associated $\"%1$\""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".htm" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".html" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".mht" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".mhtml" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".shtml" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xht" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xhtm" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xhtml" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".svg" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".svgz" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".webp" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".avif" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".xml" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".webm" ""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "DefaultIcon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}\SupportedProtocols" "http" ""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}\SupportedProtocols" "https" ""
  WriteRegStr HKLM "Software\HiraNG\Associations" "SchemaFingerprint" "b734a546"
!macroend

# 目标机器上的浏览器 peers 动态并集（未知协议 / 文件类型）。
!macro hiraRegisterDiscoveredAssociations
  StrCpy $R0 ""
  StrCpy $R0 "$R0JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQAgAD0AIAAiAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAIgANAAoAJABvAHUAcgBzACAAPQAgACIAUwBUAEEAUgAgAEgAaQByAGEAIABOAGkAdAByAG8ARwBlAG4AIgANAAoAJABmAGkAbABlAFAAcgBvAGcASQBkACAAPQAgACIASABpAHIAYQBOAEcARgBpAGwAZQAiAA0ACgAkAHUAcgBsAFAAcgBvAGcASQBkACAAPQAgACIASABpAHIAYQBOAEcAVQBSAEwAIgANAAoAJAByAG8AbwB0AHMAIAA9ACAAQAAoAFsATQBpAGMAcgBvAHMAbwBmAHQALgBXAGkAbgAzADIALgBSAGUAZwBpAHMAdAByAHkAXQA6ADoAQwB1AHIAcgBlAG4AdABVAHMAZQByACwAIABbAE0AaQBjAHIAbwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AF0AOgA6AEwAbwBjAGEAbABNAGEAYwBoAGkAbgBlACkADQAKACQAYgBsAG8AYwBrAGUAZAAgAD0AIABAACgAIgAuAGUAeABlACIALAAgACIALgBjAG8AbQAiACwAIAAiAC4AYgBhAHQAIgAsACAAIgAuAGMAbQBkACIALAAgACIALgBwAHMAMQAiACwAIAAiAC4AbQBzAGkAIgAsACAAIgAuAHMAYwByACIALAAgACIALgBjAHAAbAAiACwAIAAiAC4AZABsAGwAIgAsACAAIgAuAHMAeQBzACIAKQANAAoAJABiAGEAcwBlAEYAaQBsAGUAcwAgAD0AIABAACgAIgAuAGgAdABt"
  StrCpy $R0 "$R0ACIALAAiAC4AaAB0AG0AbAAiACwAIgAuAG0AaAB0ACIALAAiAC4AbQBoAHQAbQBsACIALAAiAC4AcwBoAHQAbQBsACIALAAiAC4AeABoAHQAIgAsACIALgB4AGgAdABtACIALAAiAC4AeABoAHQAbQBsACIALAAiAC4AcwB2AGcAIgAsACIALgBzAHYAZwB6ACIALAAiAC4AdwBlAGIAcAAiACwAIgAuAGEAdgBpAGYAIgAsACIALgB4AG0AbAAiACwAIgAuAHAAZABmACIALAAiAC4AdwBlAGIAbQAiACkADQAKACQAYgBhAHMAZQBDAGEAcABhAGIAbABlAEYAaQBsAGUAcwAgAD0AIABAACgAIgAuAGgAdABtACIALAAiAC4AaAB0AG0AbAAiACwAIgAuAG0AaAB0ACIALAAiAC4AbQBoAHQAbQBsACIALAAiAC4AcwBoAHQAbQBsACIALAAiAC4AeABoAHQAIgAsACIALgB4AGgAdABtACIALAAiAC4AeABoAHQAbQBsACIALAAiAC4AcwB2AGcAIgAsACIALgBzAHYAZwB6ACIALAAiAC4AdwBlAGIAcAAiACwAIgAuAGEAdgBpAGYAIgAsACIALgB4AG0AbAAiACwAIgAuAHAAZABmACIAKQANAAoAJABiAGEAcwBlAFAAcgBvAHQAbwBjAG8AbABzACAAPQAgAEAAKAAiAGgAdAB0AHAAIgAsACIAaAB0AHQAcABzACIALAAiAGYAdABwACIALAAiAGkAcgBjACIALAAiAG0AYQBpAGwAdABvACIALAAiAG0AbQBzACIALAAiAG4AZQB3AHMAIgAsACIAbgBuAHQAcAAiACwAIgByAGUAYQBkACIALAAiAHMAbQBzACIALAAiAHMA"
  StrCpy $R0 "$R0bQBzAHQAbwAiACwAIgBzAG4AZQB3AHMAIgAsACIAdABlAGwAIgAsACIAdQByAG4AIgAsACIAdwBlAGIAYwBhAGwAIgAsACIAdwBlAGIAYwBhAGwAcwAiACkADQAKACQAZgBpAGwAZQBzACAAPQAgAFsAUwB5AHMAdABlAG0ALgBDAG8AbABsAGUAYwB0AGkAbwBuAHMALgBHAGUAbgBlAHIAaQBjAC4ASABhAHMAaABTAGUAdABbAHMAdAByAGkAbgBnAF0AXQA6ADoAbgBlAHcAKABbAFMAdAByAGkAbgBnAEMAbwBtAHAAYQByAGUAcgBdADoAOgBPAHIAZABpAG4AYQBsAEkAZwBuAG8AcgBlAEMAYQBzAGUAKQANAAoAJABjAGEAcABhAGIAbABlAEYAaQBsAGUAcwAgAD0AIABbAFMAeQBzAHQAZQBtAC4AQwBvAGwAbABlAGMAdABpAG8AbgBzAC4ARwBlAG4AZQByAGkAYwAuAEgAYQBzAGgAUwBlAHQAWwBzAHQAcgBpAG4AZwBdAF0AOgA6AG4AZQB3ACgAWwBTAHQAcgBpAG4AZwBDAG8AbQBwAGEAcgBlAHIAXQA6ADoATwByAGQAaQBuAGEAbABJAGcAbgBvAHIAZQBDAGEAcwBlACkADQAKACQAcAByAG8AdABvAGMAbwBsAHMAIAA9ACAAWwBTAHkAcwB0AGUAbQAuAEMAbwBsAGwAZQBjAHQAaQBvAG4AcwAuAEcAZQBuAGUAcgBpAGMALgBIAGEAcwBoAFMAZQB0AFsAcwB0AHIAaQBuAGcAXQBdADoAOgBuAGUAdwAoAFsAUwB0AHIAaQBuAGcAQwBvAG0AcABhAHIAZQByAF0AOgA6AE8AcgBkAGkAbgBhAGwASQBn"
  StrCpy $R0 "$R0AG4AbwByAGUAQwBhAHMAZQApAA0ACgBmAG8AcgBlAGEAYwBoACAAKAAkAHYAYQBsAHUAZQAgAGkAbgAgACQAYgBhAHMAZQBGAGkAbABlAHMAKQAgAHsAIABbAHYAbwBpAGQAXQAkAGYAaQBsAGUAcwAuAEEAZABkACgAJAB2AGEAbAB1AGUAKQAgAH0ADQAKAGYAbwByAGUAYQBjAGgAIAAoACQAdgBhAGwAdQBlACAAaQBuACAAJABiAGEAcwBlAEMAYQBwAGEAYgBsAGUARgBpAGwAZQBzACkAIAB7ACAAWwB2AG8AaQBkAF0AJABjAGEAcABhAGIAbABlAEYAaQBsAGUAcwAuAEEAZABkACgAJAB2AGEAbAB1AGUAKQAgAH0ADQAKAGYAbwByAGUAYQBjAGgAIAAoACQAdgBhAGwAdQBlACAAaQBuACAAJABiAGEAcwBlAFAAcgBvAHQAbwBjAG8AbABzACkAIAB7ACAAWwB2AG8AaQBkAF0AJABwAHIAbwB0AG8AYwBvAGwAcwAuAEEAZABkACgAJAB2AGEAbAB1AGUAKQAgAH0ADQAKAGYAbwByAGUAYQBjAGgAIAAoACQAcgBvAG8AdAAgAGkAbgAgACQAcgBvAG8AdABzACkAIAB7AA0ACgAgACAAJABjAGwAaQBlAG4AdABzACAAPQAgACQAcgBvAG8AdAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAEMAbABpAGUAbgB0AHMAXABTAHQAYQByAHQATQBlAG4AdQBJAG4AdABlAHIAbgBlAHQAIgApAA0ACgAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAGUAcQAgACQAYwBsAGkAZQBuAHQA"
  StrCpy $R0 "$R0cwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ADQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAG4AYQBtAGUAIABpAG4AIAAkAGMAbABpAGUAbgB0AHMALgBHAGUAdABTAHUAYgBLAGUAeQBOAGEAbQBlAHMAKAApACkAIAB7AA0ACgAgACAAIAAgAGkAZgAgACgAJABuAGEAbQBlACAALQBpAGUAcQAgACQAbwB1AHIAcwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ADQAKACAAIAAgACAAJABjAGEAcAAgAD0AIAAkAGMAbABpAGUAbgB0AHMALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgAkAG4AYQBtAGUAXABDAGEAcABhAGIAaQBsAGkAdABpAGUAcwAiACkADQAKACAAIAAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAGUAcQAgACQAYwBhAHAAKQAgAHsAIABjAG8AbgB0AGkAbgB1AGUAIAB9AA0ACgAgACAAIAAgACQAZgBhACAAPQAgACQAYwBhAHAALgBPAHAAZQBuAFMAdQBiAEsAZQB5ACgAIgBGAGkAbABlAEEAcwBzAG8AYwBpAGEAdABpAG8AbgBzACIAKQANAAoAIAAgACAAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AbgBlACAAJABmAGEAKQAgAHsADQAKACAAIAAgACAAIAAgAGYAbwByAGUAYQBjAGgAIAAoACQAdgBhAGwAdQBlACAAaQBuACAAJABmAGEALgBHAGUAdABWAGEAbAB1AGUATgBhAG0AZQBzACgAKQApACAAewANAAoAIAAgACAAIAAgACAAIAAgACQAZQB4AHQAIAA9ACAAIgAk"
  StrCpy $R0 "$R0AHYAYQBsAHUAZQAiAC4AVAByAGkAbQAoACkALgBUAG8ATABvAHcAZQByAEkAbgB2AGEAcgBpAGEAbgB0ACgAKQANAAoAIAAgACAAIAAgACAAIAAgAGkAZgAgACgALQBuAG8AdAAgACQAZQB4AHQALgBTAHQAYQByAHQAcwBXAGkAdABoACgAIgAuACIAKQApACAAewAgACQAZQB4AHQAIAA9ACAAIgAuACIAIAArACAAJABlAHgAdAAgAH0ADQAKACAAIAAgACAAIAAgACAAIABpAGYAIAAoACQAZQB4AHQAIAAtAG0AYQB0AGMAaAAgACIAXgBcAC4AWwBhAC0AegAwAC0AOQBdAFsAYQAtAHoAMAAtADkALgBfACsALQBdACoAJAAiACAALQBhAG4AZAAgAC0AbgBvAHQAIAAkAGIAbABvAGMAawBlAGQALgBDAG8AbgB0AGEAaQBuAHMAKAAkAGUAeAB0ACkAKQAgAHsAIABbAHYAbwBpAGQAXQAkAGYAaQBsAGUAcwAuAEEAZABkACgAJABlAHgAdAApADsAIABbAHYAbwBpAGQAXQAkAGMAYQBwAGEAYgBsAGUARgBpAGwAZQBzAC4AQQBkAGQAKAAkAGUAeAB0ACkAIAB9AA0ACgAgACAAIAAgACAAIAB9AA0ACgAgACAAIAAgACAAIAAkAGYAYQAuAEMAbABvAHMAZQAoACkADQAKACAAIAAgACAAfQANAAoAIAAgACAAIAAkAHUAYQAgAD0AIAAkAGMAYQBwAC4ATwBwAGUAbgBTAHUAYgBLAGUAeQAoACIAVQBSAEwAQQBzAHMAbwBjAGkAYQB0AGkAbwBuAHMAIgApAA0ACgAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAA"
  StrCpy $R0 "$R0LQBuAGUAIAAkAHUAYQApACAAewANAAoAIAAgACAAIAAgACAAZgBvAHIAZQBhAGMAaAAgACgAJAB2AGEAbAB1AGUAIABpAG4AIAAkAHUAYQAuAEcAZQB0AFYAYQBsAHUAZQBOAGEAbQBlAHMAKAApACkAIAB7AA0ACgAgACAAIAAgACAAIAAgACAAJABzAGMAaABlAG0AZQAgAD0AIAAiACQAdgBhAGwAdQBlACIALgBUAHIAaQBtACgAKQAuAFQAbwBMAG8AdwBlAHIASQBuAHYAYQByAGkAYQBuAHQAKAApAA0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAHMAYwBoAGUAbQBlACAALQBtAGEAdABjAGgAIAAiAF4AWwBhAC0AegBdAFsAYQAtAHoAMAAtADkAKwAuAC0AXQAqACQAIgApACAAewAgAFsAdgBvAGkAZABdACQAcAByAG8AdABvAGMAbwBsAHMALgBBAGQAZAAoACQAcwBjAGgAZQBtAGUAKQAgAH0ADQAKACAAIAAgACAAIAAgAH0ADQAKACAAIAAgACAAIAAgACQAdQBhAC4AQwBsAG8AcwBlACgAKQANAAoAIAAgACAAIAB9AA0ACgAgACAAIAAgACQAYwBhAHAALgBDAGwAbwBzAGUAKAApAA0ACgAgACAAfQANAAoAIAAgACQAYwBsAGkAZQBuAHQAcwAuAEMAbABvAHMAZQAoACkADQAKAH0ADQAKAGYAbwByAGUAYQBjAGgAIAAoACQAcgBvAG8AdAAgAGkAbgAgACQAcgBvAG8AdABzACkAIAB7AA0ACgAgACAAJABmAGkAbABlAEsAZQB5ACAAPQAgACQAcgBvAG8AdAAuAEMAcgBlAGEAdABlAFMAdQBi"
  StrCpy $R0 "$R0AEsAZQB5ACgAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAaQBlAG4AdABzAFwAUwB0AGEAcgB0AE0AZQBuAHUASQBuAHQAZQByAG4AZQB0AFwAJABvAHUAcgBzAFwAQwBhAHAAYQBiAGkAbABpAHQAaQBlAHMAXABGAGkAbABlAEEAcwBzAG8AYwBpAGEAdABpAG8AbgBzACIAKQANAAoAIAAgAGYAbwByAGUAYQBjAGgAIAAoACQAbwBsAGQAIABpAG4AIABAACgAJABmAGkAbABlAEsAZQB5AC4ARwBlAHQAVgBhAGwAdQBlAE4AYQBtAGUAcwAoACkAKQApACAAewANAAoAIAAgACAAIABpAGYAIAAoAC0AbgBvAHQAIAAkAGMAYQBwAGEAYgBsAGUARgBpAGwAZQBzAC4AQwBvAG4AdABhAGkAbgBzACgAJABvAGwAZAApACkAIAB7ACAAJABmAGkAbABlAEsAZQB5AC4ARABlAGwAZQB0AGUAVgBhAGwAdQBlACgAJABvAGwAZAAsACAAJABmAGEAbABzAGUAKQAgAH0ADQAKACAAIAAgACAAaQBmACAAKAAkAGYAaQBsAGUAcwAuAEMAbwBuAHQAYQBpAG4AcwAoACQAbwBsAGQAKQApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ADQAKACAAIAAgACAAZgBvAHIAZQBhAGMAaAAgACgAJAB0AGEAcgBnAGUAdAAgAGkAbgAgACQAcgBvAG8AdABzACkAIAB7AA0ACgAgACAAIAAgACAAIAAkAG8AcABlAG4AIAA9ACAAJAB0AGEAcgBnAGUAdAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAEMA"
  StrCpy $R0 "$R0bABhAHMAcwBlAHMAXAAkAG8AbABkAFwATwBwAGUAbgBXAGkAdABoAFAAcgBvAGcAaQBkAHMAIgAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAG8AcABlAG4AKQAgAHsAIAAkAG8AcABlAG4ALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAkAGYAaQBsAGUAUAByAG8AZwBJAGQALAAgACQAZgBhAGwAcwBlACkAOwAgACQAbwBwAGUAbgAuAEMAbABvAHMAZQAoACkAIAB9AA0ACgAgACAAIAAgAH0ADQAKACAAIAB9AA0ACgAgACAAZgBvAHIAZQBhAGMAaAAgACgAJABlAHgAdAAgAGkAbgAgACQAYwBhAHAAYQBiAGwAZQBGAGkAbABlAHMAKQAgAHsADQAKACAAIAAgACAAJABmAGkAbABlAEsAZQB5AC4AUwBlAHQAVgBhAGwAdQBlACgAJABlAHgAdAAsACAAJABmAGkAbABlAFAAcgBvAGcASQBkACwAIABbAE0AaQBjAHIAbwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AFYAYQBsAHUAZQBLAGkAbgBkAF0AOgA6AFMAdAByAGkAbgBnACkADQAKACAAIAB9AA0ACgAgACAAZgBvAHIAZQBhAGMAaAAgACgAJABlAHgAdAAgAGkAbgAgACQAZgBpAGwAZQBzACkAIAB7AA0ACgAgACAAIAAgACQAbwBwAGUAbgAgAD0AIAAkAHIAbwBvAHQALgBDAHIAZQBhAHQAZQBTAHUAYgBLAGUAeQAoACIAUwBvAGYAdAB3AGEAcgBlAFwAQwBs"
  StrCpy $R0 "$R0AGEAcwBzAGUAcwBcACQAZQB4AHQAXABPAHAAZQBuAFcAaQB0AGgAUAByAG8AZwBpAGQAcwAiACkADQAKACAAIAAgACAAJABvAHAAZQBuAC4AUwBlAHQAVgBhAGwAdQBlACgAJABmAGkAbABlAFAAcgBvAGcASQBkACwAIAAiACIALAAgAFsATQBpAGMAcgBvAHMAbwBmAHQALgBXAGkAbgAzADIALgBSAGUAZwBpAHMAdAByAHkAVgBhAGwAdQBlAEsAaQBuAGQAXQA6ADoAUwB0AHIAaQBuAGcAKQANAAoAIAAgACAAIAAkAG8AcABlAG4ALgBDAGwAbwBzAGUAKAApAA0ACgAgACAAfQANAAoAIAAgACQAZgBpAGwAZQBLAGUAeQAuAEMAbABvAHMAZQAoACkADQAKACAAIAAkAHUAcgBsAEsAZQB5ACAAPQAgACQAcgBvAG8AdAAuAEMAcgBlAGEAdABlAFMAdQBiAEsAZQB5ACgAIgBTAG8AZgB0AHcAYQByAGUAXABDAGwAaQBlAG4AdABzAFwAUwB0AGEAcgB0AE0AZQBuAHUASQBuAHQAZQByAG4AZQB0AFwAJABvAHUAcgBzAFwAQwBhAHAAYQBiAGkAbABpAHQAaQBlAHMAXABVAFIATABBAHMAcwBvAGMAaQBhAHQAaQBvAG4AcwAiACkADQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAG8AbABkACAAaQBuACAAQAAoACQAdQByAGwASwBlAHkALgBHAGUAdABWAGEAbAB1AGUATgBhAG0AZQBzACgAKQApACkAIAB7ACAAaQBmACAAKAAtAG4AbwB0ACAAJABwAHIAbwB0AG8AYwBvAGwAcwAuAEMAbwBuAHQAYQBpAG4A"
  StrCpy $R0 "$R0cwAoACQAbwBsAGQAKQApACAAewAgACQAdQByAGwASwBlAHkALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAkAG8AbABkACwAIAAkAGYAYQBsAHMAZQApACAAfQAgAH0ADQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAHMAYwBoAGUAbQBlACAAaQBuACAAJABwAHIAbwB0AG8AYwBvAGwAcwApACAAewANAAoAIAAgACAAIAAkAHUAcgBsAEsAZQB5AC4AUwBlAHQAVgBhAGwAdQBlACgAJABzAGMAaABlAG0AZQAsACAAJAB1AHIAbABQAHIAbwBnAEkAZAAsACAAWwBNAGkAYwByAG8AcwBvAGYAdAAuAFcAaQBuADMAMgAuAFIAZQBnAGkAcwB0AHIAeQBWAGEAbAB1AGUASwBpAG4AZABdADoAOgBTAHQAcgBpAG4AZwApAA0ACgAgACAAfQANAAoAIAAgACQAdQByAGwASwBlAHkALgBDAGwAbwBzAGUAKAApAA0ACgB9AA0ACgBXAHIAaQB0AGUALQBPAHUAdABwAHUAdAAgACgAIgBwAGUAZQByAHMAfAAiACAAKwAgACQAZgBpAGwAZQBzAC4AQwBvAHUAbgB0ACAAKwAgACIAfAAiACAAKwAgACQAcAByAG8AdABvAGMAbwBsAHMALgBDAG8AdQBuAHQAKQA="
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $R0'
  Pop $0
  StrCpy $R0 ""
!macroend

!macro hiraUnregisterAssociations
  DeleteRegValue HKCU "Software\RegisteredApplications" "STAR Hira NitroGen"
  DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.mht\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.xht\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.svg\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.svgz\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.webp\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.avif\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.xml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\.webm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKCU "Software\Classes\http\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\https\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\ftp\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\irc\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\mailto\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\mms\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\news\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\nntp\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\read\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\sms\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\smsto\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\snews\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\tel\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\urn\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\webcal\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\webcals\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKCU "Software\Classes\http\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\https\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\ftp\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\irc\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\mailto\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\mms\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\news\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\nntp\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\read\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\sms\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\smsto\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\snews\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\tel\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\urn\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\webcal\shell\open\command" ""
  DeleteRegValue HKCU "Software\Classes\webcals\shell\open\command" ""
  DeleteRegKey HKCU "Software\Classes\HiraNGFile"
  DeleteRegKey HKCU "Software\Classes\HiraNGURL"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\STAR Hira NitroGen"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\HiraNG\Associations"
  DeleteRegValue HKLM "Software\RegisteredApplications" "STAR Hira NitroGen"
  DeleteRegValue HKLM "Software\Classes\.htm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.html\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.mht\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.xht\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.svg\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.svgz\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.webp\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.avif\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.xml\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.pdf\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\.webm\OpenWithProgids" "HiraNGFile"
  DeleteRegValue HKLM "Software\Classes\http\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\https\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\ftp\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\irc\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\mailto\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\mms\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\news\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\nntp\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\read\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\sms\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\smsto\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\snews\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\tel\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\urn\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\webcal\OpenWithProgids" "HiraNGURL"
  DeleteRegValue HKLM "Software\Classes\webcals\OpenWithProgids" "HiraNGURL"
  DeleteRegKey HKLM "Software\Classes\HiraNGFile"
  DeleteRegKey HKLM "Software\Classes\HiraNGURL"
  DeleteRegKey HKLM "Software\Clients\StartMenuInternet\STAR Hira NitroGen"
  DeleteRegKey HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKLM "Software\HiraNG\Associations"
!macroend

# 卸载前先按我们自己 Capabilities 的完整清单清掉动态 OpenWithProgids 值。
!macro hiraUnregisterDiscoveredAssociations
  StrCpy $R0 ""
  StrCpy $R0 "$R0JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQAgAD0AIAAiAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAIgANAAoAJABvAHUAcgBzACAAPQAgACIAUwBUAEEAUgAgAEgAaQByAGEAIABOAGkAdAByAG8ARwBlAG4AIgANAAoAJABmAGkAbABlAFAAcgBvAGcASQBkACAAPQAgACIASABpAHIAYQBOAEcARgBpAGwAZQAiAA0ACgAkAHUAcgBsAFAAcgBvAGcASQBkACAAPQAgACIASABpAHIAYQBOAEcAVQBSAEwAIgANAAoAJAByAG8AbwB0AHMAIAA9ACAAQAAoAFsATQBpAGMAcgBvAHMAbwBmAHQALgBXAGkAbgAzADIALgBSAGUAZwBpAHMAdAByAHkAXQA6ADoAQwB1AHIAcgBlAG4AdABVAHMAZQByACwAIABbAE0AaQBjAHIAbwBzAG8AZgB0AC4AVwBpAG4AMwAyAC4AUgBlAGcAaQBzAHQAcgB5AF0AOgA6AEwAbwBjAGEAbABNAGEAYwBoAGkAbgBlACkADQAKAGYAbwByAGUAYQBjAGgAIAAoACQAcgBvAG8AdAAgAGkAbgAgACQAcgBvAG8AdABzACkAIAB7AA0ACgAgACAAJABjAGEAcABzACAAPQAgACQAcgBvAG8AdAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAEMAbABpAGUAbgB0AHMAXABTAHQAYQByAHQATQBlAG4AdQBJAG4AdABlAHIAbgBlAHQAXAAkAG8AdQByAHMAXABDAGEAcABhAGIAaQBsAGkAdABpAGUAcwBcAEYAaQBs"
  StrCpy $R0 "$R0AGUAQQBzAHMAbwBjAGkAYQB0AGkAbwBuAHMAIgApAA0ACgAgACAAaQBmACAAKAAkAG4AdQBsAGwAIAAtAGUAcQAgACQAYwBhAHAAcwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ADQAKACAAIABmAG8AcgBlAGEAYwBoACAAKAAkAGUAeAB0ACAAaQBuACAAJABjAGEAcABzAC4ARwBlAHQAVgBhAGwAdQBlAE4AYQBtAGUAcwAoACkAKQAgAHsADQAKACAAIAAgACAAZgBvAHIAZQBhAGMAaAAgACgAJAB0AGEAcgBnAGUAdAAgAGkAbgAgACQAcgBvAG8AdABzACkAIAB7AA0ACgAgACAAIAAgACAAIAAkAG8AcABlAG4AIAA9ACAAJAB0AGEAcgBnAGUAdAAuAE8AcABlAG4AUwB1AGIASwBlAHkAKAAiAFMAbwBmAHQAdwBhAHIAZQBcAEMAbABhAHMAcwBlAHMAXAAkAGUAeAB0AFwATwBwAGUAbgBXAGkAdABoAFAAcgBvAGcAaQBkAHMAIgAsACAAJAB0AHIAdQBlACkADQAKACAAIAAgACAAIAAgAGkAZgAgACgAJABuAHUAbABsACAALQBuAGUAIAAkAG8AcABlAG4AKQAgAHsAIAAkAG8AcABlAG4ALgBEAGUAbABlAHQAZQBWAGEAbAB1AGUAKAAkAGYAaQBsAGUAUAByAG8AZwBJAGQALAAgACQAZgBhAGwAcwBlACkAOwAgACQAbwBwAGUAbgAuAEMAbABvAHMAZQAoACkAIAB9AA0ACgAgACAAIAAgAH0ADQAKACAAIAB9AA0ACgAgACAAJABjAGEAcABzAC4AQwBsAG8AcwBlACgAKQANAAoAfQA="
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $R0'
  Pop $0
  StrCpy $R0 ""
!macroend

# HTML 文档族（SILENT_ADOPT_EXTENSIONS）：装完即把候选收敛到 STAR Hira NitroGen（兜底），
# 真正的默认接管由运行时给 UserChoice 写合法 Hash 来完成。
!macro hiraAdoptFileAssociations
  # .mht
  DeleteRegKey HKLM "Software\Classes\.mht\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.mht\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.mht\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.mht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.mht" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.mht" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mht\OpenWithProgids"
  # .mhtml
  DeleteRegKey HKLM "Software\Classes\.mhtml\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.mhtml\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.mhtml" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.mhtml" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mhtml\OpenWithProgids"
  # .shtml
  DeleteRegKey HKLM "Software\Classes\.shtml\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.shtml\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.shtml" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.shtml" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.shtml\OpenWithProgids"
  # .xht
  DeleteRegKey HKLM "Software\Classes\.xht\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.xht\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.xht\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.xht\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xht" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.xht" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.xht\OpenWithProgids"
  # .xhtm
  DeleteRegKey HKLM "Software\Classes\.xhtm\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.xhtm\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xhtm" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.xhtm" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.xhtm\OpenWithProgids"
  # .xhtml
  DeleteRegKey HKLM "Software\Classes\.xhtml\OpenWithProgids"
  WriteRegStr HKLM "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile" ""
  DeleteRegKey HKCU "Software\Classes\.xhtml\OpenWithProgids"
  WriteRegStr HKCU "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile" ""
  WriteRegStr HKLM "Software\Classes\.xhtml" "" "HiraNGFile"
  WriteRegStr HKCU "Software\Classes\.xhtml" "" "HiraNGFile"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.xhtml\OpenWithProgids"
!macroend

!macro hiraRestoreFileAssociations
  ReadRegStr $0 HKLM "Software\Classes\.mht" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.mht" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.mht\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.mht\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.mht" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.mht" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.mht\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.mht\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\.mhtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.mhtml" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.mhtml\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.mhtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.mhtml" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.mhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.mhtml\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\.shtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.shtml" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.shtml\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.shtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.shtml" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.shtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.shtml\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\.xht" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.xht" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.xht\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.xht\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.xht" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.xht" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.xht\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.xht\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\.xhtm" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.xhtm" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.xhtm\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.xhtm" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.xhtm" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.xhtm\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.xhtm\OpenWithProgids"
  ReadRegStr $0 HKLM "Software\Classes\.xhtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKLM "Software\Classes\.xhtml" ""
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKLM "Software\Classes\.xhtml\OpenWithProgids"
  ReadRegStr $0 HKCU "Software\Classes\.xhtml" ""
  ${If} $0 == "HiraNGFile"
    DeleteRegValue HKCU "Software\Classes\.xhtml" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.xhtml\OpenWithProgids" "HiraNGFile"
  DeleteRegKey /ifempty HKCU "Software\Classes\.xhtml\OpenWithProgids"
!macroend
# <HIRA-ASSOCIATIONS:END>

# 宏参数展开时外层引号不会保留；文件名含空格时必须在宏内部重新加引号，
# 否则 SetFileAttributes / Delete 会把路径拆成多个参数。
!macro hiraWriteShortcut shortcutPath
  # 上一版可能是只读文件 / 指向已删除的旧路径，先抹掉属性再删，避免覆盖失败后留下旧 lnk。
  SetFileAttributes "${shortcutPath}" NORMAL
  Delete "${shortcutPath}"
  ClearErrors

  # CreateShortCut 参数：目标 / 参数 / 图标 / 图标索引 / 显示方式 / 热键 / 描述
  CreateShortCut "${shortcutPath}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  # 目标已存在时 CreateShortCut 会置 error，清掉以免污染后续步骤的错误标志。
  ClearErrors

  # AUMID：任务栏固定、通知归属都靠它，必须与主进程 identity.toAumid 的 appId 前缀一致。
  WinShell::SetLnkAUMI "${shortcutPath}" "${APP_ID}"
  ClearErrors
!macroend

# 按路径通知外壳：新建 .lnk（SHCNE_CREATE）+ 让父目录重新枚举（SHCNE_UPDATEDIR）。
# 0x2    = SHCNE_CREATE
# 0x1000 = SHCNE_UPDATEDIR
# 0x3005 = SHCNF_PATHW(0x5) | SHCNF_FLUSHNOWAIT(0x3000)
!macro hiraNotifyShortcut shortcutPath shortcutDir
  System::Call 'shell32::SHChangeNotify(i 0x00000002, i 0x3005, w "${shortcutPath}", i 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00001000, i 0x3005, w "${shortcutDir}", i 0)'
!macroend

# 删除抢注 AUMID 的陈旧快捷方式。
# 0x4 = SHCNE_DELETE；删完通知外壳，开始菜单里那条 "Electron" 立刻消失。
!macro hiraPurgeShortcut shortcutPath
  ${If} ${FileExists} "${shortcutPath}"
    SetFileAttributes "${shortcutPath}" NORMAL
    Delete "${shortcutPath}"
    System::Call 'shell32::SHChangeNotify(i 0x00000004, i 0x3005, w "${shortcutPath}", i 0)'
  ${EndIf}
  ClearErrors
!macroend

# ── 完成页：显式提供「运行 STAR Hira NitroGen」勾选项 ───────────────────────────────
# 为什么不沿用 electron-builder 的默认分支（assistedInstaller.nsh）：
#   默认分支只在「runAfterFinish !== false」时才注册 MUI_FINISHPAGE_RUN，属于
#   隐式契约——任何人往打包配置里补一个 runAfterFinish:false（或框架模板调整
#   默认值），完成页就会静默失去勾选项，且没有任何编译期提示。
#   这里把「完成页必须有运行勾选项」写成安装器自身的契约，与构建参数无关。
#
# 行为与默认分支保持一致：
#   · 覆盖安装（/updated）时给新进程传 --updated（主进程会忽略未知开关，安全）；
#   · 用 ${StdUtils.ExecShellAsUser} 以**当前登录用户**身份启动，避免提升后的
#     安装器把浏览器以管理员身份拉起，导致用户配置落进管理员会话。
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    # 直接启动安装目录里的 exe，不依赖开始菜单 .lnk 是否创建成功，也绝不跟随历史开发快捷方式。
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  # ── 0. 清除历史开发态泄漏（仅命中 node_modules\electron\dist\electron.exe）──
  #    必须先于下面所有写入：覆盖安装也要先把 Electron 幽灵快捷方式 / 关联清掉。
  !insertmacro hiraPurgeDevelopmentArtifacts

  # ── 1. 两上下文各扫一遍：清掉 AUMID 抢注项 + 旧版本遗留的空开始菜单目录 ──
  #    RMDir 不带 /r：只会删空目录，目录里还有东西时自动失败，绝不误删。
  #    无权限写 all-users 时会静默失败，无害。
  Push $0
  StrCpy $0 $installMode

  SetShellVarContext all
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\Electron.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\electron.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\HiraNG Development.lnk"
  !insertmacro hiraPurgeShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  !insertmacro hiraPurgeShortcut "$DESKTOP\HiraNG Development.lnk"
  RMDir "$SMPROGRAMS\hira-ng"
  RMDir "$SMPROGRAMS\Hira NG"
  RMDir "$SMPROGRAMS\Hira-NG"
  ClearErrors

  SetShellVarContext current
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\Electron.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\electron.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !insertmacro hiraPurgeShortcut "$SMPROGRAMS\HiraNG Development.lnk"
  !insertmacro hiraPurgeShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  !insertmacro hiraPurgeShortcut "$DESKTOP\HiraNG Development.lnk"
  RMDir "$SMPROGRAMS\hira-ng"
  RMDir "$SMPROGRAMS\Hira NG"
  RMDir "$SMPROGRAMS\Hira-NG"
  ClearErrors

  ${If} $0 == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  Pop $0

  # ── 2. 幂等写桌面 / 开始菜单快捷方式 ──
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      !insertmacro hiraWriteShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
      !insertmacro hiraNotifyShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$DESKTOP"
    ${endIf}
  !endif

  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    !ifdef MENU_FILENAME
      CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
      !insertmacro hiraWriteShortcut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
      !insertmacro hiraNotifyShortcut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk" "$SMPROGRAMS\${MENU_FILENAME}"
    !else
      !insertmacro hiraWriteShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      !insertmacro hiraNotifyShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$SMPROGRAMS"
    !endif
  !endif

  # ── 3. 关联登记（默认应用 / 打开方式 / 文件类型）──
  #    schema 与主进程运行时注册同源于 shared-types/src/associations.mjs，
  #    保证「装完还没启动过」时系统里就已经能看到 STAR Hira NitroGen。
  !insertmacro hiraRegisterAssociations
  # Windows 的浏览器 / 默认应用列表还会枚举机器级 RegisteredApplications；
  # 只发布身份与 Capabilities，不写协议回退命令，不替用户做默认选择。
  !insertmacro hiraRegisterMachineAssociations
  # 并集目标机器上其他浏览器已公开的未知协议与文件类型。
  !insertmacro hiraRegisterDiscoveredAssociations

  # ── 4. HTML 文档族静默接管的前置条件（需要提权才能做的那一半）──
  #    清掉 HKLM\Software\Classes\<ext>\OpenWithProgids 里别的应用留下的候选，
  #    否则运行时删掉 UserChoice 后外壳会判定「多候选」而落到 OpenWith.exe。
  #    UserChoice 由运行时在用户点「设为默认浏览器」时删除，安装器不替用户做选择。
  !insertmacro hiraAdoptFileAssociations

  # 兜底广播一次关联变更，覆盖部分外壳版本对上面几条路径通知不响应的场景。
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

# 卸载：只删自己写过的键 / 值（progid、Capabilities、RegisteredApplications 项、
# 各扩展 OpenWithProgids 里属于我们的候选），绝不整键删 .ext。
!macro customUnInstall
  !insertmacro hiraPurgeDevelopmentArtifacts
  !insertmacro hiraUnregisterDiscoveredAssociations
  !insertmacro hiraUnregisterAssociations
  !insertmacro hiraRestoreFileAssociations
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
