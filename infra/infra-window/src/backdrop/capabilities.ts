'use strict'

/**
 * 窗口材质能力探测（纯函数，不 import electron，可独立单测）。
 *
 * 背景：
 *   Electron 的 `BrowserWindow#setBackgroundMaterial` 只在 **Win11 22H2（Build 22621）及以上**
 *   真正生效（内部走 DWM 的 Mica/Acrylic），更低的版本里它直接 return —— 不报错、不告警。
 *   Win10 没有官方 API（只能靠 user32 的 SetWindowCompositionAttribute 非公开导出 + 透明窗，
 *   副作用大且必须 `transparent: true`，本项目主窗不透明建窗，因此不实现）。
 *
 * 因此能力探测是「唯一真源」：上层据此决定是否尝试原生材质、以及是否提示降级。
 */

/** Win11 22H2 的系统 Build 号：`setBackgroundMaterial` 的最低门槛。 */
const WIN11_22H2_BUILD = 22621

/**
 * 从 `os.release()` 的版本串里取 Build 号。
 * Windows 上形如 `10.0.22631`（第三段才是 Build），其它平台可能返回 `6.8.0-45-generic`。
 * @param {string} release
 * @returns {number} 解析失败返回 0
 */
interface BackdropCapabilities {
  readonly platform: string
  readonly build: number
  readonly nativeMaterial: boolean
  readonly minBuild: number
}

const parseBuild = (release: unknown): number => {
  const matched = /^\d+\.\d+\.(\d+)/.exec(String(release || ''))
  return matched ? Number(matched[1]) : 0
}

/** 模块级缓存：系统版本在进程生命周期内不会变，没必要反复解析。 */
let cached: BackdropCapabilities | null = null

/**
 * 读取当前机器的窗口材质能力。
 * @returns {{ platform: string, build: number, nativeMaterial: boolean, minBuild: number }}
 *   - `nativeMaterial`：是否可用 Electron 原生窗口材质（Win11 22H2+）
 *   - `minBuild`：门槛 Build 号，供 UI 提示文案使用
 */
export const getBackdropCapabilities = (): BackdropCapabilities => {
  if (cached) return cached
  // electron 主进程里 os 一定可用；这里延迟 require，保持本文件在纯 node 单测下也能加载。
  const os = require('os')
  const platform = process.platform
  const build = platform === 'win32' ? parseBuild(os.release()) : 0
  cached = Object.freeze({
    platform,
    build,
    nativeMaterial: platform === 'win32' && build >= WIN11_22H2_BUILD,
    minBuild: WIN11_22H2_BUILD
  })
  return cached
}

