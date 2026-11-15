/**
 * IPC 契约 · Space 域（工作空间）
 *
 * 对齐 RT `spaces-controller` 的字段语义：name/icon/bgStartColor/bgEndColor/order/lastUsed。
 * 响应一律宽松（z.unknown()/z.array(z.unknown())）：渲染层只需要一个可渲染的 POJO，
 * 严格校验放在 domain-space 的纯规则里，不在这里重复定义一遍结构。
 */
import { z } from 'zod'

const spaceSchemas = Object.freeze({
  // 某个 profile 下的空间列表（按 order 排序）
  list: Object.freeze({
    request: z.object({ profileId: z.string() }),
    response: z.array(z.unknown())
  }),
  // 全量空间（跨 profile），供设置页一次性拉取
  listAll: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  // 单空间查询（空间 id 仅在 profile 内唯一，故必须带 profileId）
  get: Object.freeze({
    request: z.object({ profileId: z.string(), spaceId: z.string() }),
    response: z.unknown().nullable()
  }),
  create: Object.freeze({
    request: z.object({
      profileId: z.string(),
      name: z.string(),
      id: z.string().optional(),
      icon: z.string().optional(),
      bgStartColor: z.string().optional(),
      bgEndColor: z.string().optional()
    }),
    response: z.object({ ok: z.boolean(), space: z.unknown().optional(), reason: z.string().optional() })
  }),
  update: Object.freeze({
    request: z.object({
      profileId: z.string(),
      spaceId: z.string(),
      patch: z.record(z.string(), z.unknown())
    }),
    response: z.unknown().nullable()
  }),
  move: Object.freeze({
    request: z.object({ profileId: z.string(), spaceId: z.string(), targetProfileId: z.string() }),
    response: z.unknown()
  }),
  remove: Object.freeze({
    request: z.object({ profileId: z.string(), spaceId: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  reorder: Object.freeze({
    request: z.object({
      entries: z.array(z.object({
        profileId: z.string(),
        spaceId: z.string(),
        order: z.number()
      }))
    }),
    response: z.object({ ok: z.boolean() })
  }),
  // 设为当前窗口使用中的空间（RT `spaces:set-using`）
  setUsing: Object.freeze({
    request: z.object({ profileId: z.string(), spaceId: z.string() }),
    response: z.object({ ok: z.boolean(), space: z.unknown().nullable().optional() })
  }),
  // 当前窗口正在使用的空间（RT `spaces:get-using`）
  getUsing: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown().nullable()
  }),
  // 某 profile 最近使用的空间（RT `spaces:get-last-used`）
  getLastUsed: Object.freeze({
    request: z.object({ profileId: z.string() }),
    response: z.unknown().nullable()
  }),
  // 空间导出 / 导入（动作型）。与 profile 归档同口径：**必须回话** ——
  // 导出去了哪、导进来成了哪个空间、或者为什么失败（包损坏 / 用户取消）。
  exportSpace: Object.freeze({
    request: z.object({ profileId: z.string(), spaceId: z.string() }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      /** 成功/失败给用户看的一句话（页面直接渲染它） */
      message: z.string().optional(),
      error: z.string().optional(),
      path: z.string().optional()
    })
  }),
  importSpace: Object.freeze({
    request: z.object({ profileId: z.string() }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      message: z.string().optional(),
      error: z.string().optional(),
      /** 导入成功后新建的空间 id / 名称（页面可据此高亮或提示） */
      spaceId: z.string().optional(),
      name: z.string().optional()
    })
  })
})

export { spaceSchemas }
