import { z } from 'zod'

/**
 * 自动化（D2 命令链 + D3 鼠标手势）契约。
 *
 * 形状都放得比较宽（`z.unknown()` 的数组 / 记录）：真正的合法性判定在**纯规则层**
 * （`shared-types/automation.mjs`：过滤未知命令 id、去重、封顶），契约这层只保证
 * "是数组 / 是对象"，免得把一份规则表抄进 Zod 再漂移一次。
 */
const automationSchemas = Object.freeze({
  get: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      chains: z.array(z.unknown()),
      gestures: z.record(z.string(), z.string()),
      gesturesEnabled: z.boolean(),
      rules: z.array(z.unknown()),
      rulesEnabled: z.boolean(),
      ruleTriggers: z.array(z.object({ id: z.string(), label: z.string() })),
      actions: z.array(z.unknown()),
      directions: z.array(z.unknown())
    })
  }),
  save: Object.freeze({
    request: z.object({
      chains: z.array(z.unknown()).optional(),
      gestures: z.record(z.string(), z.string()).optional(),
      gesturesEnabled: z.boolean().optional(),
      rules: z.array(z.unknown()).optional(),
      rulesEnabled: z.boolean().optional()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  run: Object.freeze({
    request: z.object({
      chainId: z.string().min(1).max(120).optional(),
      action: z.string().min(1).max(120).optional()
    }).refine((v: { chainId?: string; action?: string }) => Boolean(v.chainId || v.action)),
    response: z.object({ ok: z.boolean(), ran: z.number().int().nonnegative() })
  }),
  gesture: Object.freeze({
    request: z.object({ gesture: z.string().min(1).max(8) }),
    response: z.object({ ok: z.boolean(), handled: z.boolean() })
  }),
  /**
   * 方向序列 → 命令（页面引擎取一次并缓存）。
   * 值带 `label`：提示 UI 要显示的是**中文命令名**，而"id → 中文名"的表在纯层
   * （`shared-types/automation.mjs`）—— 由主进程查好再给页面，页面不必自己再抄一张。
   */
  gestureMap: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      map: z.record(z.string(), z.object({ action: z.string(), label: z.string() })),
      // 手势总开关：页面引擎据此决定"要不要开始识别"（关掉时连轨迹都不该画）
      enabled: z.boolean().optional()
    })
  })
})

export { automationSchemas }

