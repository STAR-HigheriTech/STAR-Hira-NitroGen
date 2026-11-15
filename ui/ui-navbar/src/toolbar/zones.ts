/**
 * 投放区几何 —— 「按钮编辑浮层」的尺子：把账本里的按钮**量成窗口坐标的矩形**。
 *
 * 与 `ledger.ts` 的分界：账本管「谁可见、什么顺序」（状态），本模块管「它们在屏幕上
 * 占到哪一块」（几何）。纯读取 —— 一次几何都不改状态，因此浮层每次落点都重新请一次也不心疼。
 *
 * 为什么每段必须给**最小跨度**：按钮并集在「只剩一个按钮」时就是那 32×32，
 * 想再加一个回来就得把指针精确按进这一小块里（用户原话：没有空隙、没有预留，
 * 要一点点精细蹭）。给每段一个最小跨度（3 格），多出来的部分就是看得见的预留区。
 *
 * 空段为什么必须**顺着父级往上找**参照：宿主容器在按钮被全部收走时会塌成 0×0 ——
 * 那时量不到任何矩形，这一段就彻底没有投放区，按钮再也放不回来。
 */

/** 量不到按钮时的单格尺寸（与 --ng-navbar-action-btn-size 同档）。 */
const ZONE_SLOT = 32
/** 单格间距的缺省值（量得到相邻两格时以实量为准）。 */
const ZONE_GAP = 4
/** 投放区最小跨度：3 格。 */
const ZONE_MIN_SLOTS = 3
/** 投放区在按钮上下各留的余量 —— 「差几个像素没对上」的手也有活路。 */
const ZONE_PAD_Y = 2
/**
 * 各段生长方向：nav 在左端、按钮从左往右排；panel 的按钮都靠在右侧。
 * 预留区因此开在**另一侧**，与真按钮出现的位置一致。
 * （地址栏整块是固定装饰区，不是可编辑段 —— 因此这里没有 omnibox。）
 */
import type { ToolbarZone, ToolbarZoneItem } from '../types'
import type { createToolbarLedger } from './ledger'

const SEGMENT_GROW: Record<string, 'left' | 'right'> = { nav: 'right', panel: 'left' }

/** 元素矩形；0×0（塌掉、被 display:none）一律视为「量不到」。 */
interface MeasuredRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function rectOf(el: Element | null | undefined): MeasuredRect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return null
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

/**
 * @param {{
 *   ledger: ReturnType<import('./ledger.ts').createToolbarLedger>,
 *   refs?: Record<string, HTMLElement>
 * }} options
 *   refs —— 段名 → 该段「空无一物时」用来量投放区的参照物（panel: 菜单按钮）
 * @returns {{ zones: () => Array<object> }}
 */
export function createToolbarZones(options: {
  ledger: ReturnType<typeof createToolbarLedger>
  refs?: Record<string, HTMLElement>
}): { zones: () => ToolbarZone[] } {
  const { ledger, refs = {} } = options

  /**
   * 空段（一个可见按钮都没有）的参照矩形。
   */
  function zoneRefFor(segName: string): Pick<MeasuredRect, 'left' | 'right' | 'top' | 'height'> | null {
    if (segName === 'panel' && refs.panel) {
      // 面板按钮紧挨在菜单按钮左侧；菜单按钮不是可编辑项、永远在 —— 这一段最稳的参照。
      const m = rectOf(refs.panel)
      if (m) return { left: m.left - 6, right: m.left - 6, top: m.top, height: m.height }
    }
    let el: HTMLElement | null = ledger.hostOf(segName) || null
    while (el) {
      const r = rectOf(el)
      if (r) return r
      el = el.parentElement
    }
    return null
  }

  /**
   * 某一段的投放区（**窗口坐标** —— 外壳即窗口本体，client 坐标就是窗口坐标）。
   *
   * 一次给齐三样东西：
   *   · rect  —— 投放区矩形（浮层画的虚线框就是它）。**不等于按钮并集**（见文件头）。
   *   · items —— 当前可见按钮的真实几何（浮层按它克隆按钮，逐像素重合）。
   *   · grow  —— 段内新增按钮往哪边生长，决定预留区开在哪一侧、克隆按钮靠哪边。
   * @param {string} segName
   * @returns {{ key: string, grow: string, rect: object, items: Array<object> }|null}
   */
  function segmentZone(segName: string): ToolbarZone | null {
    const grow = SEGMENT_GROW[segName] || 'left'
    const measured: ToolbarZoneItem[] = []
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const id of ledger.order()) {
      if (ledger.segmentOf(id) !== segName) continue
      const el = ledger.itemOf(id)
      if (!el || el.classList.contains('hira-toolbar-hidden')) continue
      const r = rectOf(el)
      if (!r) continue
      measured.push({
        id,
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
      left = Math.min(left, r.left)
      top = Math.min(top, r.top)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
    }

    // 空段：按参照物造一个最小投放区（没有它，按钮被拖走后这一段就再也放不回来）。
    if (measured.length === 0) {
      const ref = zoneRefFor(segName)
      if (!ref) return null
      const span = ZONE_SLOT * ZONE_MIN_SLOTS + ZONE_GAP * (ZONE_MIN_SLOTS - 1)
      const height = ZONE_SLOT + ZONE_PAD_Y * 2
      const x = grow === 'right' ? ref.left + 8 : ref.right - span - 8
      return {
        key: segName,
        grow,
        rect: {
          x: Math.round(x),
          y: Math.round(ref.top + (ref.height - height) / 2),
          width: span,
          height
        },
        items: measured
      }
    }

    // 有按钮：并集 + 最小跨度（并集已经更宽时最小跨度自然不起作用）。
    const slot = measured[0].width || ZONE_SLOT
    let gap = ZONE_GAP
    if (measured.length > 1) {
      const step = measured[1].x - measured[0].x
      if (step > 0) gap = Math.max(0, step - slot)
    }
    const minWidth = slot * ZONE_MIN_SLOTS + gap * (ZONE_MIN_SLOTS - 1)
    const width = Math.max(Math.round(right - left), minWidth)
    const height = Math.max(Math.round(bottom - top), ZONE_SLOT) + ZONE_PAD_Y * 2
    return {
      key: segName,
      grow,
      rect: {
        x: Math.round(grow === 'right' ? left : right - width),
        y: Math.round((top + bottom) / 2 - height / 2),
        width,
        height
      },
      items: measured
    }
  }

  return {
    /** 各段的投放区（编辑浮层每次落点后都会重新请一次，故这里不缓存任何东西）。 */
    zones() {
      const out: NonNullable<ReturnType<typeof segmentZone>>[] = []
      for (const segName of ledger.segments()) {
        const zone = segmentZone(segName)
        if (zone) out.push(zone)
      }
      return out
    }
  }
}
