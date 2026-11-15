// @ts-check
/**
 * 画板（D4）两形态共用的**存取内核**。
 *
 * 面板形态与独立窗口形态各画各的界面，但"画板存在哪、怎么读怎么写"只能有一份 ——
 * 否则两边的保存时机、去重、上限会各自漂移，出现"面板里删了、窗口里还在"这类怪事。
 *
 * 端口注入（不认识 IPC / 设置服务）：
 *   port.get(key)        → Promise<unknown>   已解包的值
 *   port.set(key, value) → Promise<unknown>
 */

import { EASEL_SETTING_KEY, parseBoards, serializeBoards, normalizeBoards, createBoard } from '@hira-ng/shared-types/src/easel.mjs'
import type { EaselBoard } from '@hira-ng/shared-types/src/easel.mjs'

/** 保存防抖：拖动 / 改文字会连续触发，120ms 收敛成一次写。 */
const SAVE_DEBOUNCE_MS = 120

/**
 * @param {{ get: (key: string) => Promise<unknown>, set: (key: string, value: unknown) => Promise<unknown> }} port
 */
export function createEaselStore(port: {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<unknown>
}) {
  let boards: EaselBoard[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  async function load() {
    let raw = null
    try { raw = await port.get(EASEL_SETTING_KEY) } catch (_) { raw = null }
    boards = parseBoards(raw)
    // 第一次打开：给一块空画板，用户不必先"新建"再画（空列表会让人以为坏了）。
    if (boards.length === 0) {
      boards = [createBoard('我的画板')]
      scheduleSave()
    }
    return boards
  }

  /** 立即写盘（离开页面 / 窗口关闭前调用）。 */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    try { await port.set(EASEL_SETTING_KEY, serializeBoards(boards)) } catch (_) {}
  }

  /** 防抖写盘：任何改动只需调它。 */
  function scheduleSave() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; flush() }, SAVE_DEBOUNCE_MS)
  }

  return {
    get boards() { return boards },
    load,
    flush,
    scheduleSave,
    /** 整体替换（导入 / 删除后）。 */
    replace(list: unknown) {
      boards = normalizeBoards(list)
      scheduleSave()
    },
    getBoard(id: string) {
      return boards.find((board) => board.id === id) || null
    }
  }
}
