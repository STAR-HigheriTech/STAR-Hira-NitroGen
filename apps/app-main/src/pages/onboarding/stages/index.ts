/**
 * 引导阶段注册表 + 流程编排 —— 唯一需要改的「排序 / 增删 / 分叉」文件。
 *
 * 一个 stage 就是一个普通对象（默认导出）：
 *
 *   {
 *     id:        string            必填，阶段标识（调试用，也用作 label 缺省值）
 *     label:     string            进度点上显示的字（短，2–4 字）
 *     hint:      string?           页脚左侧提示（如「按 Enter 继续」）
 *     nextLabel: string?           本阶段主按钮文案（缺省「继续 / 完成」）
 *     mount(ctx): HTMLElement | { el, destroy?, beforeNext? }
 *                                 返回 DOM，或返回带生命周期钩子的视图
 *     destroy(): void?            由视图对象提供；清理监听 / 定时器 / 迟到写入
 *     beforeNext(): void?         离开前等待当前阶段在途写入
 *     onNext(ctx): boolean|void|Promise<boolean|void>
 *                                  点主按钮时先执行；返回 false = 停在原地
 *   }
 *
 * ctx 由 onboarding.ts 提供：
 *   { rpc, IPC_ROUTES, el, draft, sources, enterFlow, next, back, close,
 *     setBusy, toast, focusPrimary, complete, runExclusive }
 *
 * 纪律：stage 之间不互相 import，共享的只有 ctx.draft；
 * 任何一步出错都不能让用户卡死（要么降级、要么允许跳过）。
 *
 * ── 流程分叉 ────────────────────────────────────────────────────────
 * 流程 = **来源 → stage id 列表**（ORDER 表）。壳只认 resolveFlow() 的返回值，
 * 因此「给某类用户多加一步」= 在 ORDER 对应那一行插一个 id，
 * 既不用改壳，也不会影响另一条流程。
 *
 * ⚠ 所有流程的第一个 stage 都必须是 welcome（它承载来源选择本身）。
 */

import welcome from './welcome.js'
import migrate from './migrate/index.js'
import appearance from './appearance.js'
import layout from './layout.js'
import startup from './startup.js'
import defaultBrowser from './default-browser.js'
import finish from './finish.js'
import { USER_SOURCES, DEFAULT_USER_SOURCE } from './user-source.js'
import type { OnboardingStage, UserSource } from './types.js'

/** id → stage 模块。新增一步只在这里登记一次。 */
const REGISTRY: Readonly<Record<string, OnboardingStage>> = Object.freeze({
  welcome,
  migrate,
  appearance,
  layout,
  startup,
  'default-browser': defaultBrowser,
  finish
})

/**
 * 每条流程的阶段顺序。
 *
 * ⚠ 写成 `[来源]: [...]` 而不是数组里塞对象：顺序是**编排**，模块是**实现**，
 * 两者分开后，「同一步出现在两条流程里」只是表里出现两次，不会复制实现。
 */
const ORDER: Readonly<Record<UserSource, readonly string[]>> = Object.freeze({
  [USER_SOURCES.OTHER]: Object.freeze([
    'welcome',
    'appearance',
    'layout',
    'startup',
    'default-browser',
    // 与 Min 流程共用同一个导入页，只是位置不同：完成之前先把旧浏览器的书签/密码带过来。
    // 两条流程共用同一份实现，差异只有 migrate 内部按来源换的文案。
    'migrate',
    'finish'
  ]),
  [USER_SOURCES.MIN]: Object.freeze([
    'welcome',
    'migrate',
    'appearance',
    'layout',
    'startup',
    'default-browser',
    'finish'
  ])
})

/**
 * 来源 → 该走的那一串 stage。
 * 未知来源回落缺省流程（不抛错）；表里写了但没登记的 id 被静默跳过（宁可少一步，不能白屏）。
 *
 * @param {string} source
 * @param {{ includeDefaultBrowser?: boolean }} [options]
 *   includeDefaultBrowser=false 时整步剔除 `default-browser`。
 *   开发态用它（exe 是 electron.exe，关联能力已由主进程整块关闭）——
 *   此时该步点了也不会有任何效果，不如根本不出现。
 * @returns {Array<object>}
 */
export function resolveFlow (source?: string, { includeDefaultBrowser = true } = {}) : OnboardingStage[] {
  const key: UserSource = source === USER_SOURCES.MIN ? USER_SOURCES.MIN : DEFAULT_USER_SOURCE
  const ids = ORDER[key]
  return ids
    .filter((id?) => includeDefaultBrowser || id !== 'default-browser')
    .map((id) => REGISTRY[id])
    .filter((stage): stage is OnboardingStage => Boolean(stage))
}

export { USER_SOURCES }
