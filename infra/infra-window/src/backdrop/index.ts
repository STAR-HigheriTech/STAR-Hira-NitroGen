'use strict'

/**
 * 窗口材质门面（Acrylic / Mica 等系统级模糊材质）。
 *
 * 职责边界：
 *   - 本模块只管「某个 BrowserWindow 的 DWM 材质开/关」，不关心主题、颜色、透明度。
 *   - 上层（LayoutCoordinator / theme-runtime）负责把主题里的 `style.material`
 *     翻译成这里的参数，并把结果透传给渲染层。
 *
 * 注意（这是「没有不透明垃圾层」的关键前提）：
 *   原生材质是**窗口级**效果 —— DWM 把窗口背后的桌面模糊后画进窗口透明区域。
 *   因此窗口里的每一层（shell 的 html/body、rail、panels、WebContentsView 的占位底色）
 *   都必须保持透明，渲染层才能真的透出模糊。渲染层那侧的开关由 theme-controller 负责。
 */

import type { BrowserWindow } from 'electron'
import { getBackdropCapabilities } from './capabilities'

export { getBackdropCapabilities } from './capabilities'

type BackdropReason = '' | 'no-window' | 'unsupported-platform' | 'unsupported-build' | 'no-api' | 'call-failed'
type NativeBackdropMaterial = 'none' | 'auto' | 'acrylic' | 'mica' | 'tabbed'
interface BackdropResult {
  material: string
  applied: boolean
  supported: boolean
  reason: BackdropReason
  message: string
}

/**
 * 主题里的材质 id → Electron 原生材质名。
 *
 * 保留这层映射（而不是拿 id 直接调）是为了让"主题里的词汇"与"Electron 的词汇"
 * 解耦：将来想加 `tabbed`、或者某个 id 要落成别的原生值时，只改这张表。
 */
const MATERIAL_TO_NATIVE: Readonly<Record<string, NativeBackdropMaterial>> = Object.freeze({
  acrylic: 'acrylic',
  mica: 'mica'
})

/** 失败/降级原因的中文文案（暴露给 UI，避免 UI 自己判断系统版本）。 */
const REASONS: Readonly<Record<BackdropReason, string>> = Object.freeze({
  '': '',
  'no-window': '窗口不可用',
  'unsupported-platform': '当前系统不支持窗口材质（仅 Windows 11 22H2 及以上）',
  'unsupported-build': '当前系统版本过低，需要 Windows 11 22H2 及以上',
  'no-api': '当前 Electron 版本不支持窗口材质',
  'call-failed': '窗口材质应用失败，已回退为染色玻璃'
})

/** 每个窗口的实际材质状态：WeakMap 不阻止窗口回收。 */
const states = new WeakMap<BrowserWindow, { material: string; applied: boolean }>()

/**
 * 组装统一结果结构，保证调用方拿到的字段永远齐全。
 * @param {string} material
 * @param {boolean} applied
 * @param {boolean} supported
 * @param {string} reason
 */
const result = (material: string, applied: boolean, supported: boolean, reason: BackdropReason): BackdropResult => Object.freeze({
  material,
  applied,
  supported,
  reason,
  message: REASONS[reason] || ''
})

/**
 * 关闭窗口材质并恢复 Electron 内部记录的底色。
 * @param {Electron.BrowserWindow|null|undefined} win
 * @returns {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }}
 */
export const releaseWindowBackdrop = (win: BrowserWindow | null | undefined): BackdropResult => {
  const caps = getBackdropCapabilities()
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    if (win) states.delete(win)
    return result('none', false, caps.nativeMaterial, '')
  }
  const state = states.get(win)
  // 幂等：本来就没开过材质 → 什么都不做。每次主题发布都调一遍 'none' 会让 DWM
  // 无缘无故重置窗口底色（在无材质模式下表现为闪一下）。
  if (state && (state.applied || state.material !== 'none') && typeof win.setBackgroundMaterial === 'function') {
    try {
      win.setBackgroundMaterial('none')
    } catch {
      /* 关闭失败无害：上层会显式 setBackgroundColor 兜底 */
    }
  }
  states.delete(win)
  return result('none', false, caps.nativeMaterial, '')
}

/**
 * 应用窗口材质。
 * @param {Electron.BrowserWindow|null|undefined} win
 * @param {{ material?: string }} [opts]
 */
export const applyWindowBackdrop = (win: BrowserWindow | null | undefined, opts?: { material?: string }): BackdropResult => {
  const caps = getBackdropCapabilities()
  const desired = (opts && opts.material) || 'none'
  if (desired === 'none') return releaseWindowBackdrop(win)

  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    return result(desired, false, caps.nativeMaterial, 'no-window')
  }
  if (!caps.nativeMaterial) {
    const reason = caps.platform !== 'win32' ? 'unsupported-platform' : 'unsupported-build'
    return result(desired, false, false, reason)
  }
  if (typeof win.setBackgroundMaterial !== 'function') {
    return result(desired, false, false, 'no-api')
  }
  const state = states.get(win)
  // 幂等：同一材质已经生效时不再重复调用，避免每次发布主题都触发一次全窗重绘。
  if (state && state.material === desired && state.applied) {
    return result(desired, true, true, '')
  }
  const native: NativeBackdropMaterial = MATERIAL_TO_NATIVE[desired]
    || (desired === 'auto' || desired === 'tabbed' ? desired : 'none')
  try {
    win.setBackgroundMaterial(native)
  } catch {
    states.set(win, { material: desired, applied: false })
    return result(desired, false, true, 'call-failed')
  }
  states.set(win, { material: desired, applied: true })
  return result(desired, true, true, '')
}

/**
 * 读取窗口当前材质状态（未应用过则视为 none）。
 * @param {Electron.BrowserWindow|null|undefined} win
 */
export const getWindowBackdrop = (win: BrowserWindow | null | undefined): { material: string; applied: boolean } => {
  const state = win && states.get(win)
  return state ? { material: state.material, applied: !!state.applied } : { material: 'none', applied: false }
}

