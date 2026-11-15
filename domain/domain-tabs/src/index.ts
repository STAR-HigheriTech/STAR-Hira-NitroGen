// @ts-check
/**
 * Domain: Tabs — 标签领域规则
 *
 * 提供「标签该怎么处理」的判定与算法，全部是纯函数，零依赖、零 IO。
 *
 * ── D4 收口（原「单一数据源」违规已消除）────────────────────────
 * 本包曾用 `infra-db` 的 SQLite `tabs` 表做会话持久化（saveSession/loadSession…），
 * 与 `apps/app-main/src/main/session-restore.js` 写 `session.json` **构成双写路径**，
 * 给同一个「会话」概念留下两个真相源。
 *
 * 现已收口：
 *   - **唯一真相源 = `session.json`**，由 `@hira-ng/domain-session` 负责读写；
 *   - 本包不再持有任何存储职责，只保留**规则**（正是这个文件）；
 *   - 原 SQLite 实现为**全库零引用的死代码**（仅在 app-main/package.json 声明了依赖），
 *     已随本次下沉删除，备份见 `_backup-ng-step2-20260913/domain-tabs-index.js`。
 *
 * `infra-db` 的 `tabs` 表定义暂时保留：删表对已存在的用户数据库无收益、有风险，
 * 但已标注废弃，不得再写入。
 *
 * ── 依赖倒置说明 ────────────────────────────────────────────
 * 分层规则 R1 里 `infra` 只能依赖 `infra`，**不能依赖 domain**。
 * 所以 `infra-window#TabManager` 不 require 本包，而是由 APPS 层
 * （`main.js` / `snapshot-bootstrap.js`）把下面导出的 `tabRules` 注入进去。
 * infra 侧只声明「我需要这些能力」，不知道自己拿到的是 domain 实现 —— 这就是端口倒置。
 */

import * as TabAdjust from './TabAdjust'
import * as TabGroups from './TabGroups'
import * as TabRules from './TabRules'
import * as TabSplits from './TabSplits'
import * as TabStacks from './TabStacks'
import * as TabUtil from './tabUtil'

export * from './TabAdjust'
export * from './TabGroups'
export * from './TabRules'
export * from './TabSplits'
export * from './TabStacks'
export * from './tabUtil'
export * from './types'

/** 纯函数，可单独引用；其余导出保持同一入口。 */
const api = {
  ...TabRules,
  ...TabUtil,
  ...TabAdjust,
  ...TabStacks,
  /**
   * 分屏组规则（与标签栈**正交**：栈是收纳、分屏是并列，见 TabSplits.ts 文件头）。
   * 单独一组导出名，不与栈的同名操作混在一起（`createSplit` vs `createStack`）。
   */
  ...TabSplits,
  /**
   * 速览组规则（Glance，A1）。三条分组维度**正交**：栈是收纳、分屏是并列、速览是叠放
   * （恰好两张、一个压一个）。单独一组导出名，见 TabGroups.ts 文件头。
   */
  ...TabGroups,
  /**
   * 端口对象：形状即 `infra-window#TabManager` 期望的 `tabRules`。
   * 由 APPS 在构造 TabManager 时整体注入。
   */
  tabRules: TabRules,
  /**
   * 端口对象：标签「调整视图」组合方法（tabStats / partitionTabs /
   * focusOrderIds / cleanActive / visibleAfter），与 `tabRules` 同构，
   * 同样经 APPS 注入 `infra-window#TabManager`。`tabAdjust` 为可选端口，
   * 不注入时 TabManager 回退到本地遍历计算。
   */
  tabAdjust: TabAdjust,
  tabStacks: TabStacks,
  /**
   * 端口对象：分屏组规则（形状与 `tabStacks` 同构，经 APPS 注入 `infra-window#TabManager`）。
   * 与 `tabStacks` 一样是**可选端口** —— 不注入时 TabManager 回退到本地实现。
   */
  tabSplits: TabSplits,
  /**
   * 端口对象：速览组规则（形状与 `tabStacks` / `tabSplits` 同构，经 APPS 注入
   * `infra-window#TabManager`）。与它们一样是**可选端口** —— 不注入时速览操作明确抛错。
   */
  tabGroups: TabGroups
}

export const tabRules = TabRules
export const tabAdjust = TabAdjust
export const tabStacks = TabStacks
export const tabSplits = TabSplits
export const tabGroups = TabGroups
export default api
