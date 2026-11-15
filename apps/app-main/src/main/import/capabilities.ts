/**
 * 浏览器一键迁移 · 能力位与数据集词表（唯一真源）
 *
 * 为什么用位掩码而不是按浏览器名写 if/else：
 *   浏览器之间的差别是「能搬什么数据」，不是「它是谁」。源 adapter 只需声明
 *   自己的能力位，主进程与页面都按位判断 —— 以后新增 Firefox / Brave 只加一个
 *   adapter，UI 与导入管线一行都不用改。
 *
 * 位值一经发布不得改动（会写进 IPC 响应，渲染层按位解析）。
 */
export const CAPABILITY_BOOKMARKS = 1 << 0
export const CAPABILITY_HISTORY = 1 << 1
export const CAPABILITY_EXTENSIONS = 1 << 2
export const CAPABILITY_ALL = CAPABILITY_BOOKMARKS | CAPABILITY_HISTORY | CAPABILITY_EXTENSIONS

/** 数据集名 → 能力位（IPC 请求里的 datasets 用这些字符串）。 */
export const DATASET_CAPABILITY = Object.freeze({
  bookmarks: CAPABILITY_BOOKMARKS,
  history: CAPABILITY_HISTORY,
  extensions: CAPABILITY_EXTENSIONS
})

export type DatasetName = keyof typeof DATASET_CAPABILITY
export const DATASETS = Object.freeze(Object.keys(DATASET_CAPABILITY) as DatasetName[])

/**
 * 把 IPC 请求里的 datasets 归一成「该源确实支持的数据集」。
 *
 * 语义：
 *   · 缺省 / 空数组 → 该源支持的全部数据集（页面不勾选 = 全要）；
 *   · 未知字符串直接丢弃（不让一个拼错的名字变成静默全量导入）；
 *   · 结果按 DATASETS 的固定顺序，保证多 profile 聚合时输出稳定。
 *
 * @param {unknown} input
 * @param {number} capabilities 该源的能力位
 * @returns {string[]}
 */
export function normalizeDatasets(input: unknown, capabilities: number): DatasetName[] {
  const allowed = DATASETS.filter((name) => (Number(capabilities) & DATASET_CAPABILITY[name]) !== 0)
  if (!Array.isArray(input) || input.length === 0) return allowed
  const wanted = new Set(input.map((v) => String(v || '').trim().toLowerCase()))
  return allowed.filter((name) => wanted.has(name))
}

