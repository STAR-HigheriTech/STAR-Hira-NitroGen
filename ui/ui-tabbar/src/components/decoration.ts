/**
 * 标签条上的**插件装饰层** —— 渲染侧插槽在 `ui-tabbar` 这一侧的落点。
 *
 * 两个宿主、同一套语义：
 *   · `tabbar.item-renderer` → 标签行（`.tab-item`，见 `Tab.js`）
 *   · `tabbar.tab-stack-renderer` → 标签组芯片（`.tab-stack-chip`，见 `TabStack.js`）
 *
 * 两者共用本文件的 append/refresh，只是类名不同（`tab-decoration` /
 * `tab-stack-decoration`）—— 类名是**给插件与宿主共同的定位锚点**，
 * 有它宿主才能在同一条基线里把"装饰到底挂上了没有"量出来。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么语义是「装饰」而不是「替换」
 * ══════════════════════════════════════════════════════════════════════
 * 官方表把 `tabbar.item-renderer` 描述为"单个标签的 DOM 渲染器"。但在这套实现里
 * **不能**做成"替换"：
 *
 *   · 标签行不是一次性画完的，它有一套完整的**状态机**：keyed 复用（`nodeRecords` 按
 *     `tab:<id>` 复用节点）、字段级 diff（只对变化字段调 `update`）、开合动效
 *     （`is-tab-entering` / `is-tab-closing` 两阶段删除）、FLIP 滑动让位。
 *     换掉行节点 = 这套机制全部失效 → "切个标签整条栏闪一下"、拖拽重排失效。
 *   · 标签条是整个界面**最热**的渲染路径（每次切标签、每次收标签都要走一遍）。
 *
 * 所以这里的契约是：**插件往行里追加一块自己的 DOM，宿主仍然掌握结构、状态与复用**。
 * 插件能做的：角标、额外图标、小段文字、进度指示……
 * 插件不能做的：换掉整行（那需要一个能以"整行替换"为前提重写状态机的插槽，
 * 现在没有，也不该为了一个插槽把最热路径的机制拆掉）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条硬约束
 * ══════════════════════════════════════════════════════════════════════
 * 1. **装饰层不可拦截指针**（`.tab-decoration { pointer-events: none }`）。
 *    标签条最不可让步的性质是"标签始终可点"。一个能吃掉点击的装饰层，
 *    会让"点了标签没反应"这种最难归因的问题变得可能。
 *    需要可交互装饰的场景应当走新的插槽语义（"行内按钮"），而不是放宽这一条。
 * 2. **插件抛错不能拖垮标签条**。装饰没了，标签还得在。
 */

/** 装饰层的样式（由宿主注入）。宿主只保证「不占位奇怪、不吃指针」，外观归插件。 */
export const DECORATION_CSS = `
  .tab-decoration {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    /* 见文件头硬约束 ①：装饰层永远不拦截指针 —— 标签必须始终可点。 */
    pointer-events: none;
  }
  .tab-stack-decoration {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    /* 同上：芯片也必须始终可点（点芯片 = 折叠/展开整组）。 */
    pointer-events: none;
  }
`

/**
 * 调用一次装饰器并把它返回的元素挂到标签行上。
 *
 * @param {HTMLElement} hostEl 承载装饰的宿主（`.tab-item` 或 `.tab-stack-chip`）
 * @param {Function|null} decorator 宿主注入的插槽调用器；缺省 = 没有插件参与
 * @param {object} payload 给插件的上下文（见 Tab.js / TabStack.js 的调用点）
 * @param {string} [className] 挂到装饰节点上的类名（两个宿主各用一个，见文件头）
 * @returns {HTMLElement|null} 挂上去的节点（宿主保存它，状态变化时用来重建）
 */
export function appendDecoration(
  hostEl: HTMLElement,
  decorator: TabDecorator | null | undefined,
  payload: UnknownRecord,
  className: string = 'tab-decoration'
): HTMLElement | null {
  if (!hostEl || typeof decorator !== 'function') return null
  let output: HTMLElement | null | void
  try {
    output = decorator(payload)
  } catch (e) {
    // 见文件头硬约束 ②
    console.warn('[tabbar] 插件装饰层执行失败（已跳过，不影响标签条）:', e instanceof Error ? e.message : String(e))
    return null
  }
  // 只接受元素节点：插件返回字符串 / Fragment / null 一律忽略（返回纯文本无法定位样式）
  if (!output || typeof output !== 'object' || output.nodeType !== 1) return null
  const node = output
  if (typeof node.classList?.add === 'function') node.classList.add(className)
  hostEl.appendChild(node)
  return node
}

/**
 * 状态变化后重建装饰层。
 *
 * 为什么是"重建"而不是"让插件自己更新"：SINGLE 插槽的契约刻意只留一个入参 ——
 * 多一个 `update` 回调就等于要求每个插件都写一份 diff 逻辑，而它们要显示的东西
 * （角标文字、图标）本来就是"重新算一次更简单"的量级。
 * 宿主侧的成本也只是"移除 + 再调一次函数"。
 *
 * @param {HTMLElement} hostEl
 * @param {HTMLElement|null} current 上一次挂的节点
 * @param {Function|null} decorator
 * @param {object} payload
 * @param {string} [className] 同 appendDecoration
 * @returns {HTMLElement|null}
 */
export function refreshDecoration(
  hostEl: HTMLElement,
  current: HTMLElement | null,
  decorator: TabDecorator | null | undefined,
  payload: UnknownRecord,
  className: string = 'tab-decoration'
): HTMLElement | null {
  if (current && current.parentNode === hostEl) hostEl.removeChild(current)
  return appendDecoration(hostEl, decorator, payload, className)
}
import type { TabDecorator, UnknownRecord } from '../types.js'

