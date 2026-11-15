/**
 * 中文星期名 —— **唯一真源**。
 *
 * 原先三处页面各抄一份：历史页分组标题、新标签页「日期」小组件用长表，同一张
 * 新标签页上的「时间」小组件用短表。长表抄两遍已经是隐患（改一处忘另一处），
 * 短表再手抄一遍更没理由 —— 短表就是长表把「星期」换成「周」。
 *
 * 纯数据、零依赖、不碰 DOM：内部页经 `SHARED_PAGES_MODULES` 复制到
 * `out/pages/_shared/` 后按 `hira://shared/weekday.mjs` import。
 *
 * 索引口径与 `Date#getDay()` 一致：0 = 星期日 … 6 = 星期六。
 */

/** 长表：星期日 / 星期一 …（历史分组标题、日期小组件） */
export const WEEKDAY_NAMES = Object.freeze([
  '星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'
])

/** 短表：周日 / 周一 …（空间紧凑处，如时间小组件的星期行） */
export const WEEKDAY_NAMES_SHORT = Object.freeze(
  WEEKDAY_NAMES.map((name) => name.replace('星期', '周'))
)
