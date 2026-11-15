import { z } from 'zod'

/**
 * Tab Snapshot 契约（对齐 RT hirax-internal://tab-snapshot）。
 *
 * 只交换「读取地址」，不交换字节 —— 位图由主进程 hira://tab-snapshot 协议直吐，
 * 渲染层零位图驻留（低内存目标）。无可用帧时 url 为 null，消费方回退 favicon。
 */
/**
 * ⚠ 必须包成 `z.object(...)`：typed IPC 路由内部调的是 `schema.parse(payload)`
 * （infra-ipc/src/index.js），裸对象没有 parse 方法 → 每次调用都抛
 * `TypeError: requestSchema.parse is not a function`，标签 hover 预览永远拿不到缩略图。
 * 全仓其余契约都是 z.object，这里只是曾经的例外。
 */
const snapshotSchemas = Object.freeze({
  request: z.object({ tabId: z.string().min(1) }),
  response: z.object({ url: z.string().nullable() })
})

export { snapshotSchemas }

