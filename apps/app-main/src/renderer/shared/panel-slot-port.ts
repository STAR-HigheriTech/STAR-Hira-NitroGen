/**
 * panel-slot-port.js —— 「渲染侧插槽端口」的**唯一实现**。
 *
 * ── 为什么从 panel-context.js 拆出来 ──────────────────────────────────
 * `createPanelContext()` 是三种宿主（侧栏面板 / 独立窗口 / 内部页 `hira://ai`）
 * 共用的**端口工厂**，它只该依赖「路由 + 常量」，不该顺带把整条插件插槽系统
 * （`plugin-slots.js` → `plugin-renderer.js` → 插件清单与动态模块加载）拉进依赖图：
 *   · 不是所有面板宿主都需要插件插槽，静态依赖会无谓拉长冷启动；
 *   · 拆开后，只有真正传 `slots` 的宿主才加载注册表，端口语义仍只有一份。
 *
 * 于是拆成两层：
 *   · 本文件 = 会调插槽的宿主（侧栏面板 / 独立窗口）注入的端口；
 *   · `createPanelContext({ slots })` 只管把传进来的端口挂到 `ctx.slots`。
 * 插槽语义仍只有一份（下面三个调用器逐字转发 `plugin-slots.js`），没有第二套规则。
 */

import { callRendererSlot, callRendererSlotMulti, reduceRendererSlot } from './plugin-slots.js'

/** 注入给面板的通用插槽端口（语义与 plugin-slots.js 的三个调用器逐字对应）。 */
export const slotPort = {
  call: <T = unknown>(slotId: string, payload: unknown, fallback: T | null = null) => callRendererSlot(slotId, payload, fallback),
  callMulti: (slotId: string, payload: unknown) => callRendererSlotMulti(slotId, payload),
  reduce: <T>(slotId: string, payload: T) => reduceRendererSlot(slotId, payload)
}

