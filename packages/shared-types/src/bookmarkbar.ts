/**
 * bookmarkbar.mjs —— 书签栏显示策略的**唯一真源**
 *
 * 设置键 `app.bookmarkbar_visible` 历史上是布尔（显示 / 隐藏）。为了支持
 * 「仅新标签页显示」，它升级为三态字符串；但老 profile 里存的仍是 `true`/`false`，
 * 因此**任何**读写点都必须过这里的 normalizeBookmarkbarMode()，禁止各处自行比较 ——
 * 主进程（设置项 options / 菜单勾选 / 快捷键切换）与渲染层（书签栏控制器）共用同一份，
 * 保证「同一次设置变更在两侧得到同一个结论」。
 *
 * 为什么放在 shared-types 而不是某一层：
 *   真源必须同时被 apps 的主进程（CJS require）与渲染层（ESM import）读到。
 *   本文件是 `.mjs`；Electron 43 运行时为 Node 24，`require()` 可直接加载 ESM
 *   （已实测通过），故主进程侧无需再抄一份常量表。
 *
 * 职责边界：本模块只回答「这个值是什么模式」「当前该不该显示」，
 * **不做**可见性以外的任何决策（不查库、不碰 DOM、不认识活动标签从哪来）。
 */

export type BookmarkbarMode = 'always' | 'newtab' | 'never'

/**
 * 设置键名真源 —— 主进程（菜单 / 快捷键 / applier）、渲染层（书签栏控制器）与
 * 设置作用域（settings-scope）共用同一份，杜绝手抄拼错。
 */
export const BOOKMARKBAR_SETTING_KEY = 'app.bookmarkbar_visible'

/** 设置页下拉的 [值, 中文名]；顺序即设置页展示顺序，也是「默认项在最前」的顺序。 */
const BOOKMARKBAR_MODE_OPTIONS = Object.freeze([
  ['always', '始终显示'],
  ['newtab', '仅新标签页显示'],
  ['never', '从不显示']
])

/** 缺省模式（等同于旧版本的「显示书签栏 = 开」）。 */
const DEFAULT_BOOKMARKBAR_MODE = 'always'

/** 合法三态取值 —— 由上面那张选项表派生，不再手抄第二份 id 列表。 */
const BOOKMARKBAR_MODES = Object.freeze(BOOKMARKBAR_MODE_OPTIONS.map(([value]) => value))

/**
 * 归一化任意历史/异常取值到三态。
 *
 * 向后兼容是**必须**的：老用户的 settings.json 里存的是布尔，若不迁移，
 * 他们会看到「设置项空白 + 书签栏凭空消失」。故 `true → always`、`false → never`。
 * 其余无法识别的值一律回落缺省（设置文件是用户可手改的 JSON，不能假设干净）。
 * @param {unknown} value
 * @returns {BookmarkbarMode}
 */
function normalizeBookmarkbarMode(value: unknown) : BookmarkbarMode {
  if (value === true) return DEFAULT_BOOKMARKBAR_MODE
  if (value === false) return 'never'
  return typeof value === 'string' && (BOOKMARKBAR_MODES as readonly string[]).includes(value)
    ? value as BookmarkbarMode
    : DEFAULT_BOOKMARKBAR_MODE
}

/**
 * 「书签栏是否处于启用状态」—— 菜单勾选 / 快捷键切换的判据。
 * 注意它**不等于**「此刻看得见」：`newtab` 模式在普通网页上也是启用的，只是不显示。
 * @param {unknown} value
 */
function isBookmarkbarEnabled(value: unknown) {
  return normalizeBookmarkbarMode(value) !== 'never'
}

/**
 * Ctrl+Shift+B / 菜单开关的下一档取值：关着就开（always），开着就关（never）。
 * 与 Edge/Chrome 的同名快捷键一致 —— 这类「一键开关」不做三态循环
 * （循环会让用户按两下才回到原状，反而不可预期）。三态选择只留在设置页。
 * @param {unknown} value
 * @returns {BookmarkbarMode}
 */
function toggleBookmarkbarMode(value: unknown) : BookmarkbarMode {
  return isBookmarkbarEnabled(value) ? 'never' : 'always'
}

/**
 * 「这个节点可以被固定到书签栏吗」—— 书签栏固定位的**唯一判据**。
 *
 * 为什么文件夹也放行（此前只有 http(s) 书签能固定）：书签与文件夹在库里是
 * **同一张 bookmarks 表**（`url` 为空即文件夹，见 domain-bookmark 的实体约定与
 * ui-panel-favorites 的树形态说明）——「固定到书签栏」是一个**快捷入口**的选择，
 * 与被固定的节点是网页还是文件夹**无关**。若在这条判据上按 URL 过滤，用户就无法把
 * 常去的文件夹挂到栏上。
 *
 * 真正要排除的只有"指不到任何一行"的空节点（没有 id）。
 * ⚠ 固定与取消固定走**同一条** `bookmark:pinned-*` 通道、同一张存储，
 *   本判据只负责"许不许固定"，不复制一份数据。
 * @param {{ id?: string }|null|undefined} node
 * @returns {boolean}
 */
function isPinnableToBookmarkbar(node: { id?: string }|null|undefined) : boolean {
  return !!(node && node.id)
}

/**
 * 最终可见性判定 —— **渲染层唯一调用点**。
 *
 * 为什么主进程不判：只有渲染层知道「当前活动标签的地址」，而地址 → 是否新标签页的
 * 判定还依赖 home:url（由主进程解析后回填）。所以主进程只持有模式，可见性交给持有
 * 活动标签上下文的那一层算，避免两处各判一次而漂移。
 * @param {unknown} value            设置值（可能是老布尔）
 * @param {boolean} isNewTabPage     当前活动标签是否为新标签页（由调用方判定）
 */
function isBookmarkbarVisible(value: unknown, isNewTabPage: boolean) {
  const mode = normalizeBookmarkbarMode(value)
  if (mode === 'never') return false
  if (mode === 'newtab') return isNewTabPage === true
  return true
}

export {
  BOOKMARKBAR_MODE_OPTIONS,
  DEFAULT_BOOKMARKBAR_MODE,
  normalizeBookmarkbarMode,
  isBookmarkbarEnabled,
  toggleBookmarkbarMode,
  isBookmarkbarVisible,
  isPinnableToBookmarkbar
}
