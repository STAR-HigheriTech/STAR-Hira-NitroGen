import { z } from 'zod'

/**
 * OOBE 首次启动引导的 IPC 契约。
 *
 * 字段与 `main/onboarding/index.js#getState()` 一一对应：zod object 会剥掉多余键、
 * 但缺键直接判失败 —— 这是刻意保留的显式约束，服务加字段时这里必须同步。
 *
 * 三条都是**主进程单点判定**：「是否需要引导」「完成后做什么」不许在渲染层复算。
 */
const onboardingSchemas = Object.freeze({
  /** 读当前引导状态（页面挂载时取一次；不是轮询接口）。 */
  state: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      needsOnboarding: z.boolean(),
      version: z.string(),
      requiredVersion: z.string(),
      open: z.boolean()
    })
  }),
  /**
   * 完成引导（= 记下版本号 + 放出主窗 + 销毁引导窗）。
   * 无参数：导入是引导流程里的一屏（stages/migrate），不在这里附带任何数据。
   * 重复完成是幂等的：主窗 mount 幂等、窗口已销毁则跳过。
   */
  complete: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  }),
  /** 重新运行引导（设置页入口）：版本号清空后立刻开窗，不销毁主窗。 */
  reset: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  })
})

export { onboardingSchemas }

