/**
 * 用户来源 —— 引导流程的**分叉判据**（唯一一份）。
 *
 * 为什么要单独一个文件：来源同时被「壳」（决定流程）与「各阶段」（决定文案）需要，
 * 放进 index.js 会让 stage ↔ index 互相 import 成环。这里是第三个模块，
 * 双方都只单向依赖它，词汇表只有一份。
 *
 * 扩展方式：新增一种来源 = 这里加一个 id + index.js 的 ORDER 加一条流程；
 * 任何 stage 都不用改（它们只读 ctx.draft.source）。
 */

export const USER_SOURCES = Object.freeze({
  /** 从其它浏览器（Chrome / Edge / Firefox…）第一次来到 Hira：直接走设置流程。 */
  OTHER: 'other',
  /** 从 Hira Min 升级过来：先走一步迁移向导，再继续设置。 */
  MIN: 'min'
})

export const DEFAULT_USER_SOURCE = USER_SOURCES.OTHER

/**
 * 把任意输入收敛成合法来源。
 * 设置文件 / URL 参数都是用户可改的，无法识别的值一律回落缺省（不抛错、不卡流程）。
 *
 * @param {unknown} value
 * @returns {'other'|'min'}
 */
export function normalizeUserSource (value?: unknown) : 'other'|'min' {
  return value === USER_SOURCES.MIN ? USER_SOURCES.MIN : DEFAULT_USER_SOURCE
}
