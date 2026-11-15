import { z } from 'zod'

/**
 * 渲染侧插槽宿主契约（PART7 §7.3 的跨进程那一半）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么渲染侧需要一对专门的通道
 * ══════════════════════════════════════════════════════════════════════
 * 插槽实现（含闭包）永远住在**主进程**；而 `side-panel.toolbar-action-slot`
 * 这类插槽的产出面在**渲染层**。两边只能这样分工：
 *
 *   render   —— 渲染层说「我要画这个插槽」，主进程执行实现，回**可序列化描述符**
 *               （函数在过 IPC 前被剥掉）。渲染层只画，不做判断。
 *   dispatch —— 用户点了某一项，渲染层把该项的 **key** 送回，主进程按 key 找到
 *               那个实现并调用它的 `onSelect`。
 *
 * `key` 是实现的稳定标识（注册时的 `meta.key || pluginId`）—— 这是跨进程
 * 「点回来找谁」的唯一凭据，因此契约里它是必填且非空。
 *
 * ⚠ 渲染层**不能**自由指定插槽 id：主进程侧有白名单
 * （`apps/app-main/src/main/slot-render.js#RENDERER_HOSTED_SLOTS`），
 * 否则内部页可以借这条通道触发任意插槽。
 */
const slotsSchemas = Object.freeze({
  // 取「这个插槽该画些什么」——纯数据，不含函数
  render: Object.freeze({
    request: z.object({
      slotId: z.string().min(1),
      payload: z.unknown().optional()
    }),
    response: z.object({
      items: z.array(z.object({
        // 实现键：dispatch 时原样送回
        key: z.string().min(1),
        // 哪个插件贡献的（供 UI 标注 / 调试）
        pluginId: z.string().nullable(),
        // 实现返回的描述符（已剥掉函数）
        descriptor: z.unknown()
      }))
    })
  }),
  // 按 key 派发某个实现的 onSelect
  dispatch: Object.freeze({
    request: z.object({
      slotId: z.string().min(1),
      key: z.string().min(1),
      payload: z.unknown().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      // 失败原因（实现不存在 / 没给 onSelect / onSelect 抛错）—— 回给 UI 便于定位
      reason: z.string().optional()
    })
  })
})

export { slotsSchemas }

