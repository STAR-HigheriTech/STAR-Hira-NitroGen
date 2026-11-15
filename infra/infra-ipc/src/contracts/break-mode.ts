import { z } from 'zod'

/**
 * Break Mode（D5 番茄钟 / 专注）契约。
 *
 * 只有一条路由：整窗浮层（out/renderer/break-overlay）上的按钮 / Esc 把"用户点了什么"
 * 回传主进程。状态机（25 分钟专注 / 5 分钟休息 / 暂停 / 跳过 / 暂停态微调）**只在主进程**
 * （`main/break-mode.js`）—— 浮层不认识时长与阶段，于是同一份逻辑不会被抄进渲染页
 * 再漂移一次。
 *
 * `adjust` 是"暂停时把剩余时间挪一档"（`deltaMs` 带符号）：只有暂停态接受它，
 * 运行态改剩余时间会被下一秒的 tick 覆盖，用户会以为按钮坏了（见 break-mode.js）。
 *
 * 响应刻意只回 `{ ok }`：真实状态由主进程随后的 `break-overlay:*` 推送覆盖，
 * 不在这里回传一份可能过期的快照（两处状态必然漂移）。
 */
const breakSchemas = Object.freeze({
  control: Object.freeze({
    request: z.object({
      action: z.enum(['skip', 'pause', 'resume', 'stop', 'adjust']),
      /** 仅 `adjust` 使用：带符号毫秒。上限一小时，够手滑也够不到离谱。 */
      deltaMs: z.number().int().min(-3600000).max(3600000).optional()
    }),
    response: z.object({ ok: z.boolean() })
  })
})

export { breakSchemas }

