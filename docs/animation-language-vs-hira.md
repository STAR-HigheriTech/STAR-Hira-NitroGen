# 标签动效：Hira / HiraRT 对照与 NG 落地

> 用途：先看清参考项目的**动效语言**，再决定 NG 该怎么写。
> 结论先行：Hira 没有「标签开合动画」，但有一条贯穿全库的**动效基线**；NG 沿用这条基线的
> 时长/缓动/取舍哲学，把 Hira 缺的开合补上。

## 1. Hira 的动效语言（证据）

| 位置                                            | 事实                                                                                                        | 说明                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `css/base.css#L1-L9`                            | `* { transition: 200ms !important; }`                                                                       | **全库唯一的动效基线**：所有状态变化（hover、宽度、背景、边框）都自己滑过去 |
| `scripts/stripTransitions.js`                   | 批量把 `transition` → `none`、删掉全部 `@keyframes` 的一次性脚本                                            | 说明 Hira 一度为了性能**整库去动画**，后来又只把关键处放回来                |
| `css/taskOverlay/railModule.css`、`zenMode.css` | 多处显式 `transition: none`                                                                                 | 基线之上再做「退出」：拖拽中的元素、滚动条滑块等不参与过渡                  |
| `js/taskOverlay/panels/railModule.js#L1284`     | `dragula(..., { animation: 180 })`                                                                          | 拖拽重排的让位动画 = 180ms                                                  |
| `css/modal.css#L43`                             | `@keyframes modal-appear`，`animation: modal-appear 0.2s`                                                   | 弹窗入场 200ms（全库极少数关键帧之一）                                      |
| `css/tabBar.css#L16-L23, L267-L272`             | `#navbar { transition: height/padding 200ms linear }`；`#tab-bar-bottom { transition: padding .3s linear }` | 结构性重排（紧凑模式、任务栏推挤）走 200–300ms                              |
| `css/tabBar.css`（`.tab-item` 段）              | **没有** width/transform 过渡；`createTab`/`setActiveTab` 只切 class                                        | 关键结论：**Hira 的标签开/关/切换是瞬时的**，没有动画                       |

一句话总结 Hira：**「短、线性、全局同速；只动该动的，别的一律关掉」**。
`HiraRT` 的快照（`1A-STAR_Hira_RT/src`）只含 `main / preload / shared`，渲染层不在其中，
因此动效参照以 Hira 为准。

## 2. NG 的落地（沿用同一套语言）

新增三个 token（`packages/shared-ui-tokens/tokens-base.css`），让全端速度同源：

```
--ng-anim-fast: 120ms   /* hover / 颜色 / 透明度：即时反馈 */
--ng-anim-base: 180ms   /* 宽度 / 高度：结构性重排（开合、塌陷） */
--ng-anim-ease: ease    /* 与 Hira 的 `transition: 200ms`（默认 ease）一致 */
```

| 操作                  | 落点                   | 实现                                                                                                                                | 时长 |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 标签栏：切换          | `ui-tabbar`            | `.tab-item` 过渡 `width`（选中 160 / 普通 140）→ 宽度滑过去带动整条重排                                                             | base |
| 标签栏：打开          | `ui-tabbar`            | `runEnter`：入 DOM 后挂 `.is-tab-entering`，`@keyframes ng-tab-enter` 从 0 宽展开（只写 `from`，结束值取自身宽度，故选中/普通都对） | base |
| 标签栏：关闭          | `ui-tabbar`            | `runExit`：挂 `.is-tab-closing` 塌宽淡出，**过渡结束才 remove()**（两阶段删除）；期间后续标签逐帧重排 → 连续滑动                    | base |
| 面板：行打开          | `ui-common/tabRowList` | 量自然高度 h → 钉成 h → 强制 reflow → 钉成 0，`transitionend` 后清 inline（纵向列表结束高度是 auto，关键帧表达不了）                | base |
| 面板：行关闭          | `ui-common/tabRowList` | 同上反向，过渡结束才 remove()；行留在流里，下面的行逐帧上移                                                                         | base |
| 静音按钮首次出现      | `ui-common/tabRowList` | `@keyframes tabrow-pop`（scale .5 + 透明）——`hidden` 切的是 display，只能靠关键帧入场                                               | base |
| 拖拽落点指示线        | tabbar / tabRowList    | 由 `display` 切换改为 `opacity` 过渡 → 出现消失不再硬切                                                                             | fast |
| 标签 hover / 选中底色 | 两处                   | 统一到 `--ng-anim-fast`                                                                                                             | fast |

## 3. 必须守住的取舍（照搬 Hira 的「该关就关」）

- **拖拽期间不参与**：关闭动效中的节点已摘掉 `data-tab-id`，不再作为拖拽落点；落点判定查询
  `[data-row]:not(.tabrow-row--closing)`。
- **排序锚点跳过正在消失的节点**（`skipClosing` / `nextSiblingSkippingClosing`）：否则
  「关掉最后一个标签」时，正在塌宽的节点会被当成参照，把其余项推来推去。
- **首次填充不播入场**：启动恢复一次冒出十几个标签一起展开太吵（`firstRenderDone` /
  `rowsPrimed`）。
- **两阶段删除**：节点先从 keyed 表里出表，DOM 延后到动画结束再摘 —— 同 id 立刻恢复
  （撤销关闭）时不会复用一个正在消失的节点。
- **兜底计时器 400ms**：窗口隐藏/元素已被移除时 `transitionend` 不会来，必须自己收尾，
  否则节点或 inline 高度会永久残留。
- **不用 `*` 通配**：Hira 的全局 `* { transition: 200ms }` 在 NG 不合适 —— NG 的标签/面板位置
  由主进程原生 view 的 bounds 驱动，通配会把不该动的东西一起拖进过渡。
