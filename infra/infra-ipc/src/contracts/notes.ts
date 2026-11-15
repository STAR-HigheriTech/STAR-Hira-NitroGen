import { z } from 'zod'
// 集锦类型的唯一真源（domain 层与面板都从这里取，契约不再手抄一份枚举）。
const { NOTE_KINDS } = require('@hira-ng/shared-types/src/notes.mjs')

/**
 * 笔记域 IPC 契约。
 *
 * ⚠ `list` / `search` 的响应统一用 `z.array(z.unknown())`：笔记内容是任意字符串，
 * 逐字段建模只会把 domain 的出口形状复制一份到契约里，两边迟早漂移。
 * 契约在这里的职责是「拦住请求形状」，不是「描述笔记」。
 */
const notesSchemas = Object.freeze({
  /**
   * 列表。`folderId` 的**三种缺席语义**必须精确表达：
   *   · 省略    → 全部笔记
   *   · null    → 根级（未归档）
   *   · 字符串  → 该文件夹
   * 因此注册器侧用 `'folderId' in req` 判定，而不是 `req.folderId != null`。
   */
  list: Object.freeze({
    request: z.object({ folderId: z.string().nullable().optional() }).optional(),
    response: z.array(z.unknown())
  }),
  get: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.unknown().nullable() }),
  add: Object.freeze({
    request: z.object({
      title: z.string().optional(),
      content: z.string().optional(),
      folderId: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      color: z.string().nullable().optional(),
      // 集锦字段（kind 真源 = shared-types/notes.mjs#NOTE_KINDS）
      kind: z.enum(NOTE_KINDS).optional(),
      sourceTitle: z.string().nullable().optional(),
      assetPath: z.string().nullable().optional(),
      assetMime: z.string().nullable().optional(),
      assetWidth: z.number().optional(),
      assetHeight: z.number().optional(),
      thumbPath: z.string().nullable().optional(),
      refId: z.string().nullable().optional(),
      refMode: z.string().nullable().optional()
    }).optional(),
    response: z.unknown().nullable()
  }),
  update: Object.freeze({
    request: z.object({
      id: z.string().min(1),
      title: z.string().optional(),
      content: z.string().optional(),
      folderId: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      color: z.string().nullable().optional(),
      pinned: z.boolean().optional(),
      // 集锦字段：kind **刻意不在列**（卡片类型不可改，见 domain-notes#update）
      sourceTitle: z.string().nullable().optional(),
      assetPath: z.string().nullable().optional(),
      assetMime: z.string().nullable().optional(),
      assetWidth: z.number().optional(),
      assetHeight: z.number().optional(),
      thumbPath: z.string().nullable().optional(),
      refId: z.string().nullable().optional(),
      refMode: z.string().nullable().optional()
    }),
    response: z.unknown().nullable()
  }),
  remove: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.object({ ok: z.boolean() }) }),
  search: Object.freeze({ request: z.object({ query: z.string() }), response: z.array(z.unknown()) }),
  move: Object.freeze({
    request: z.object({ id: z.string().min(1), folderId: z.string().nullable() }),
    response: z.unknown().nullable()
  }),
  pinSet: Object.freeze({
    request: z.object({ id: z.string().min(1), pinned: z.boolean() }),
    response: z.unknown().nullable()
  }),
  reorder: Object.freeze({
    request: z.object({ folderId: z.string().nullable(), orderedIds: z.array(z.string()) }),
    response: z.object({ ok: z.boolean() })
  }),
  folderList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  folderAdd: Object.freeze({
    request: z.object({ name: z.string().optional(), parentId: z.string().nullable().optional() }).optional(),
    response: z.object({ id: z.string().nullable() })
  }),
  folderRename: Object.freeze({
    request: z.object({ id: z.string().min(1), name: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  folderRemove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  }),
  /** 拖拽：把文件夹移到另一父级（null = 根级） */
  folderMove: Object.freeze({
    request: z.object({ id: z.string().min(1), parentId: z.string().nullable() }),
    response: z.object({ ok: z.boolean() })
  }),
  /** 拖拽：同一父级下重排（回传该父级下全部子文件夹的新顺序） */
  folderReorder: Object.freeze({
    request: z.object({ parentId: z.string().nullable(), orderedIds: z.array(z.string()) }),
    response: z.object({ ok: z.boolean() })
  }),
  /** `{ [folderId]: number, __all: number, __unfiled: number, __trash: number }` */
  folderCounts: Object.freeze({ request: z.unknown().optional(), response: z.record(z.string(), z.number()) }),
  /**
   * 集锦抓取入口（= 域 addCaptured）。`url` 可选 —— 片段 / 图片抓取未必带来源 URL。
   * 去重规则（只对 page 生效）在 domain，这里只拦请求形状。
   *
   * `tabId`（可选）：**这是一个"针对某个具体标签"的收录**（标签右键「收进集锦…」）——
   * 主进程据此从**那个标签**取权威 url/title 与画面来源（缩略图），不再按 URL 反猜。
   * `kind:'page'` 且 `url`/`tabId` 都省略 = **收发送方窗口的活动标签**（面板「+ 添加当前页面」）
   * ——「活动标签只有主进程是权威」这条口径因此只出现在一处（见 ipc/notes.js#resolvePageSource）。
   */
  capture: Object.freeze({
    request: z.object({
      kind: z.enum(NOTE_KINDS).optional(),
      url: z.string().optional(),
      tabId: z.string().optional(),
      title: z.string().optional(),
      sourceTitle: z.string().optional(),
      content: z.string().optional(),
      folderId: z.string().nullable().optional(),
      assetPath: z.string().optional(),
      assetMime: z.string().optional(),
      assetWidth: z.number().optional(),
      assetHeight: z.number().optional(),
      thumbPath: z.string().optional(),
      tags: z.array(z.string()).optional()
    }).optional(),
    response: z.unknown().nullable()
  }),
  /** 从回收站恢复一张卡。 */
  restore: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.object({ ok: z.boolean() }) }),
  /** 从回收站真删一张卡（不可恢复）。 */
  purge: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.object({ ok: z.boolean() }) }),
  /** 回收站列表。 */
  trashList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  /** 清空回收站。 */
  trashEmpty: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) }),
  /** 反链：引用了该卡的卡片数组（被删来源卡带 missing:true）。 */
  backlinks: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.array(z.unknown()) }),
  /** 引用计数 `{ [targetNoteId]: number }`。 */
  refCounts: Object.freeze({ request: z.unknown().optional(), response: z.record(z.string(), z.number()) }),

  // ── 集锦图片资产（P2）────────────────────────────────────────────────
  // 响应一律 `z.unknown()`：资产的出口形状（ok / oversize / assetPath 可空 / reason）
  // 按"抓取失败也回结构化结果"设计，逐字段建模只会把 notes-assets.js 的返回复制一份到契约里。
  // 契约在这里只负责**拦住请求形状**（与 notes 域其余条目同一纪律）。
  /** 按 URL 抓图：`{ url, referer? }` → `{ ok, ...assetFields, oversize?, reason? }`。 */
  assetFetch: Object.freeze({
    request: z.object({
      url: z.string().min(1),
      referer: z.string().optional()
    }),
    response: z.unknown()
  }),
  /** 存一段图字节（渲染层从剪贴板 / 拖放拿到的 dataURL）→ 同上形状。 */
  assetSaveBuffer: Object.freeze({
    request: z.object({ dataUrl: z.string().min(1) }),
    response: z.unknown()
  }),
  /** 读缩略图 → `{ dataUrl }`（读不到回 `{ dataUrl: null }`，不抛）。 */
  assetThumb: Object.freeze({
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ dataUrl: z.string().nullable() })
  }),
  /** 用系统默认程序打开原图 → `{ ok, error? }`。 */
  assetOpen: Object.freeze({
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() })
  }),
  /**
   * 导出集锦到文件：主进程弹保存框 + 写文本。
   *
   * `format` 是**文件扩展名**：内建的三种取值来自共享真源 `NOTE_EXPORT_FORMATS`
   * （shared-types/src/notes.mjs）；`note.export-format` 插槽可以让面板传自己的扩展名
   * （如 `csv`），因此这里不锁枚举，只校验"是一个安全的扩展名"。
   * 原生保存框的 filters / 标题由主进程按扩展名现算（见 notes-export-file.js）。
   *
   * `encoding` 决定 `content` 的字节形态：`utf8`（默认，文本）或 `base64`
   * （二进制，如插件提供的 `.xlsx` / `.docx`）。主进程不解析二进制内容，
   * 只按声明解码后原样写盘 —— 这样插件格式全走同一条落盘通道。
   */
  exportFile: Object.freeze({
    request: z.object({
      format: z.string().regex(/^[a-z0-9]{1,12}$/i),
      filename: z.string().optional(),
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).optional()
    }),
    response: z.object({ ok: z.boolean(), canceled: z.boolean().optional(), path: z.string().optional(), error: z.string().optional() })
  }),
  /**
   * 拉取「上一次 open-view 意图」（面板挂载时调用一次，取完即清）。
   *
   * 响应是动作层原样留下的载荷：`{ folderId?, noteId?, section?, open? }`，没有则 null。
   * 形状刻意不逐字段建模 —— 它是**同一条事件**的补发，定义在 main/note-actions.js#revealInPanel，
   * 在这里再抄一份只会让两边漂移。
   */
  takeOpenView: Object.freeze({ request: z.unknown().optional(), response: z.unknown().nullable() })
})

export { notesSchemas }

