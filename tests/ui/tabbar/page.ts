/**
 * 标签栏视觉基线的**页面侧 harness**（在真实 Chromium 里跑）。
 *
 * 它只做四件事：注入组件样式 → 建 tabbar → 按 case 数据渲染 → 置 `window.__ready`。
 * 所有判定都在 node 侧（`run.cjs` 截图后与基线比像素）—— 页面里不做任何断言，
 * 免得"页面自己说自己对"。
 *
 * ⚠ 用真实 Chromium 而不是 jsdom：这份基线的全部价值就是**像素**。
 * jsdom 不做布局、不做层叠、算不了 `getBoundingClientRect`，
 * 拿它跑出来的"视觉基线"是自欺欺人（它测的是桩，不是渲染）。
 */
import { injectTabbarStyles, createTabbar } from './tabbar.mjs'

const caseDef: TabbarCaseDefinition = window.__CASE || { tabs: [], theme: 'light', width: 900, height: 44 }

// 主题变量：tokens 的深色规则挂在 `html[data-theme='dark']` 与 `body.dark` 上，
// 两处要一起设（与 theme-controller 的行为一致）。
document.documentElement.setAttribute('data-theme', caseDef.theme)
document.body.classList.toggle('dark', caseDef.theme === 'dark')

injectTabbarStyles(document)

const root = document.getElementById('root')
if (!root) throw new Error('tabbar harness root is missing')
root.style.width = `${caseDef.width}px`
root.style.height = `${caseDef.height}px`

// handlers 一律给空实现：基线只看**画出来的东西**，不看交互。
// 给真实现反而会让 `showMenu` 之类去开原生菜单，污染截图。
//
// `decorations: true` 的 case 会注入一对**测试装饰器**（模拟插件）—— 它们走的是
// 与真实插件**完全相同**的那条路（宿主端口 → `appendDecoration`），
// 因此这一条基线钉的是"装饰层的落点与占位"，而不是某种测试专用的渲染分支。
const slots = caseDef.decorations
  ? {
      itemDecorator: (payload: { tabId?: string }) => makeBadge(`T${payload.tabId || ''}`),
      stackDecorator: (payload: { stackId?: string }) => makeBadge(`S${payload.stackId || ''}`)
    }
  : undefined
const tabbar = createTabbar(document, { slots })
root.appendChild(tabbar.element)

/** 极简的测试角标：固定文案 + 固定尺寸，保证基线可复现（不依赖字体度量之外的东西）。 */
function makeBadge(text: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.textContent = text
  el.style.cssText = 'font-size:10px;line-height:14px;padding:0 4px;border-radius:7px;background:rgba(26,115,232,.18);color:#1a73e8;'
  return el
}

tabbar.renderTabs(caseDef.tabs)

// 等两帧：一帧让 DOM 落地，一帧让布局与 CSS 变量生效。
// （组件内部有入场动效的兜底计时器，但首帧渲染刻意不播 —— 见 renderTabs 的 firstRenderDone）
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    // 把"渲染完成"以及一组**可供诊断的度量**交出去：
    // 像素对不上时，node 侧能立刻看出是"标签数变了"还是"宽度变了"，不必人肉开图。
    const tabs = root.querySelector<HTMLElement>('#tabs')
    if (!tabs) throw new Error('tabbar #tabs element is missing')
    window.__metrics = {
      tabCount: root.querySelectorAll('.tab-item').length,
      stackCount: root.querySelectorAll('.tab-stack-chip').length,
      // 装饰层计数：'007' 那条基线靠它自证"装饰真的挂上去了" ——
      // 只比像素的话，"装饰没挂上"和"挂了但被裁掉了"长得一模一样。
      decorationCount: root.querySelectorAll('.tab-decoration, .tab-stack-decoration').length,
      tabsWidth: Math.round(tabs.getBoundingClientRect().width),
      tabsHeight: Math.round(tabs.getBoundingClientRect().height),
      // 诊断用：像素对不上时，第一件要回答的事是"DOM 变了没有"。
      // 只看图是分不出来的（1px 位移和"少画一个元素"在 900×44 里长得差不多）。
      dom: tabs.outerHTML.slice(0, 6000)
    }
    window.__ready = true
  })
})
