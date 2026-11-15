/**
 * 中键自动滚动守卫 —— 让一块区域彻底不再出现「中键按下 → 四向箭头 + 页面跟着鼠标滚」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * Chromium（Windows）把「中键按下」当**默认行为**：起一个自动滚动光标，跟着鼠标滚，
 * 再按一下才退出。这套交互在浏览器**外壳**里（标签条 / 标签列 / 面板）从来没有意义，
 * 更要命的是它会跟「中键关闭标签」抢同一拍 —— 用户看到的就是
 * **中键关标签会卡一下**（关是关了，但先闪出一个自动滚动光标）。
 *
 * ── 一条规则，两种挂载粒度（都必需）────────────────────────────────────
 * 规则只有一份：下面的 `suppressMiddleClickAutoscroll`。挂载点却必须有两个粒度，
 * 少任何一个都会漏：
 *
 *   ① **区域根**（`guardMiddleClickAutoscroll`，如 `#tabs` / `#navbar-tabbar` /
 *      `.tabrow-wrap`）—— 行与行之间、行与容器边缘之间都是**背景**，而背景同样是
 *      这块区域的一部分。只挂行的话，背景上按中键照样起自动滚动
 *      （用户原话："无论如何包括这个 tabbar 底部的背景图层，都不要中键开滚动"）。
 *   ② **单个可复用行**（`attachTabGestures`）—— 行是最小件，会被别的宿主拿到一棵
 *      没有守卫的树里去用（例如把标签行装进自绘的浮层）。它得自己成立。
 *
 * 两层嵌套安装（`#navbar-tabbar` 里套着 `#tabs`）不是重复：**每个组件只为自己这一层
 * 负责**，谁都不该假定外层/内层替自己装过 —— 与 CSS 里各组件自己声明外观同一个道理。
 *
 * ── 为什么用**捕获**阶段 ───────────────────────────────────────────────
 * 默认行为在事件**派发结束后**才执行，所以任何阶段 `preventDefault()` 都成立；
 * 选捕获是为了让守卫保的是"整块区域"，将来某个后代组件在 `mousedown` 上
 * `stopPropagation` 也不会把守卫拆掉。
 *
 * ── 只认中键 ───────────────────────────────────────────────────────────
 * `button === 1` 才动手：左键拖拽、左键聚焦、右键菜单一概不受影响。
 * 中键的 `auxclick`（关闭标签等）**不受影响** —— `preventDefault` 只取消默认行为，
 * 不取消事件派发（`attachTabGestures` 早已实测过这一点）。
 */

export function suppressMiddleClickAutoscroll(e: MouseEvent): void {
  if (e && e.button === 1) e.preventDefault()
}

/**
 * 给一块区域（含整个子树与背景）装上守卫。
 *
 * 监听器挂在元素自身，随元素被丢弃一并回收 —— 不需要显式卸载，
 * 与其余挂件（stripScroller / 手势）同一口径。
 */
export function guardMiddleClickAutoscroll(
  root: HTMLElement | null | undefined
): HTMLElement | null {
  if (!root || typeof root.addEventListener !== 'function') return null
  root.addEventListener('mousedown', suppressMiddleClickAutoscroll, true)
  return root
}
