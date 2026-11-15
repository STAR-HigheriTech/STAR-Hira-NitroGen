import { z } from 'zod'

/**
 * OpenExternal 契约 —— 网页打开外部协议（mailto: / 自定义协议）的授权记录。
 *
 * 为什么单开一条通道：记录不落在渲染层能读到的地方（它存在 domain-settings 的
 * 独立前缀里，主进程在权限请求那一刻才读写）。设置页要展示「哪些网站被允许打开
 * 哪些协议」，只能由主进程现读现解后透传 —— 渲染层既拿不到原始键，也不该知道
 * 记录是怎么编码的。
 *
 * 字段名沿用 RT（requestingURL / openingProtocol），便于两边互相迁移。
 */
const openExternalSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.object({ requestingURL: z.string(), openingProtocol: z.string() }))
  }),
  unset: Object.freeze({
    request: z.object({ requestingURL: z.string(), openingProtocol: z.string() }),
    // 返回「是否确实撤销了一条」，供设置页区分「撤销成功」与「记录已不存在」
    response: z.boolean()
  })
})

export { openExternalSchemas }

