import { z } from 'zod'

/**
 * 自动更新的 IPC 契约。
 *
 * 快照字段必须与 `main/update/service.js#getState()` 一一对应：
 * zod 的 object 默认会剥掉多余键、但缺键会直接判失败 —— 所以这里是那张表的**镜像**，
 * 服务加字段时这里必须同步（这是刻意保留的显式约束，避免渲染层拿到半截状态）。
 */
const updateStatus = z.enum([
  'unsupported',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'error'
])

const stateSnapshot = z.object({
  supported: z.boolean(),
  status: updateStatus,
  currentVersion: z.string(),
  channel: z.enum(['stable', 'preview']),
  availableVersion: z.string(),
  progress: z.number(),
  transferred: z.number(),
  total: z.number(),
  bytesPerSecond: z.number(),
  lastCheckAt: z.number(),
  message: z.string(),
  error: z.string()
})

const updateSchemas = Object.freeze({
  /** 读取当前快照（页面初次挂载用；之后靠 update:changed 事件，禁止轮询）。 */
  state: Object.freeze({ request: z.unknown().optional(), response: stateSnapshot }),
  /** 手动检查一次（返回检查后的快照）。 */
  check: Object.freeze({ request: z.unknown().optional(), response: stateSnapshot }),
  /** 下载更新包（返回下载后的快照；进度靠事件推）。 */
  download: Object.freeze({ request: z.unknown().optional(), response: stateSnapshot }),
  /** 重启并安装（ok=false 时 message 说明原因）。 */
  install: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean(), message: z.string().optional() })
  })
})

export { updateSchemas, updateStatus }

