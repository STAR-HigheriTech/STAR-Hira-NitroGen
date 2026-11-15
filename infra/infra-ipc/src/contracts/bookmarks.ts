import { z } from 'zod'

/**
 * 标签视图的公共部分：`tag` 是**筛选条件**（null/缺省即不筛选），与关键词检索正交 ——
 * 用户可以在「固定到书签栏」这个标签里继续搜。
 */
const tagFilter = z.string().nullable().optional()

const bookmarksSchemas = Object.freeze({
  list: Object.freeze({ request: z.object({ parentId: z.string().nullable().optional() }).optional(), response: z.array(z.unknown()) }),
  add: Object.freeze({ request: z.object({ parentId: z.string().nullable().optional(), title: z.string(), nickname: z.string().optional(), url: z.string().nullable().optional(), favicon: z.string().optional(), tags: z.array(z.string()).optional(), summary: z.string().max(4000).nullable().optional() }), response: z.unknown() }),
  remove: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  update: Object.freeze({ request: z.object({ id: z.string(), title: z.string().optional(), nickname: z.string().optional(), url: z.string().optional(), favicon: z.string().optional(), tags: z.array(z.string()).optional(), summary: z.string().max(4000).nullable().optional() }), response: z.unknown() }),
  search: Object.freeze({ request: z.object({ query: z.string(), tag: tagFilter }), response: z.array(z.unknown()) }),
  move: Object.freeze({ request: z.object({ id: z.string(), parentId: z.string().nullable() }), response: z.unknown() }),
  // orderedIds = 该 parentId 下**全部**子节点的新顺序（拖拽落点回传）
  reorder: Object.freeze({ request: z.object({ parentId: z.string().nullable(), orderedIds: z.array(z.string()) }), response: z.object({ ok: z.boolean() }) }),
  export: Object.freeze({ request: z.unknown().optional(), response: z.string() }),
  /**
   * 书签导入。两种形态：
   *   · `{ html }`                     —— 内建 Netscape Bookmark HTML（默认路径，行为不变）
   *   · `{ format, content }`          —— 插件贡献的格式；`format` 是插件声明的 id，
   *     由扩展点 `bookmark.import-format` 的实现把 `content` 解析成 Netscape HTML 再入库。
   *
   * `error`：格式未知 / 解析器抛错时的**可读原因**。不放进 `imported/skipped` 里蒙混 ——
   * 导入页需要区分"解析出 0 条"（格式对但内容空）与"格式根本不认识"。
   */
  import: Object.freeze({
    request: z.object({
      html: z.string().optional(),
      format: z.string().optional(),
      content: z.string().optional()
    }),
    response: z.object({ imported: z.number(), skipped: z.number(), error: z.string().optional() })
  }),
  /** 可用导入格式清单（插件声明侧）。`{ formats: [{ id, label }] }` */
  importFormats: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ formats: z.array(z.object({ id: z.string(), label: z.string() })) })
  }),
  getByUrl: Object.freeze({ request: z.object({ url: z.string().min(1) }), response: z.unknown().nullable() }),
  removeByUrl: Object.freeze({ request: z.object({ url: z.string().min(1) }), response: z.object({ ok: z.boolean(), removed: z.number() }) }),
  tree: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  /**
   * 面板聚合快照 —— 一次 IPC 返回首屏所需的全部视图：
   * `{ parentId, tag, items, pinned, pinnedOrder, folders, tags }`。
   * `items` 是当前文件夹（或当前标签，跨文件夹）下的节点；`folders` 是带 children 的完整树；
   * `tags` 是标签分类栏的数据（系统标签 + 用户标签，带计数）。
   */
  snapshot: Object.freeze({
    request: z.object({
      parentId: z.string().nullable().optional(),
      tag: tagFilter,
      query: z.string().max(300).optional()
    }).optional(),
    response: z.object({
      parentId: z.string().nullable(),
      tag: z.string().nullable().optional(),
      query: z.string().nullable().optional(),
      items: z.array(z.unknown()),
      pinned: z.array(z.unknown()),
      pinnedOrder: z.array(z.string()),
      folders: z.array(z.unknown()),
      tags: z.array(z.object({
        tag: z.string(),
        count: z.number(),
        system: z.boolean().optional(),
        label: z.string().optional()
      })).optional()
    })
  }),
  pinnedList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  pinnedSet: Object.freeze({ request: z.object({ id: z.string(), pinned: z.boolean() }), response: z.unknown().nullable() }),
  pinnedReorder: Object.freeze({ request: z.object({ orderedIds: z.array(z.string()) }), response: z.object({ ok: z.boolean() }) }),
  // rail（侧栏图标栏）固定位：与书签栏 pinned 是**两个独立固定位**（见 domain-bookmark#setRailPinned）
  railPinnedList: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  railPinnedSet: Object.freeze({ request: z.object({ id: z.string(), pinned: z.boolean() }), response: z.unknown().nullable() }),
  /** rail 固定区整体重排（拖拽落点回传完整顺序）；与书签栏 pinnedReorder 互不影响 */
  railPinnedReorder: Object.freeze({ request: z.object({ orderedIds: z.array(z.string()) }), response: z.object({ ok: z.boolean() }) }),
  /**
   * 批量打标签 / 移除标签 —— 面板与内部页**共用**的唯一批量写路径。
   *
   * 系统标签（`system:pinned` / `system:rail`）在这里被解释为固定开关：
   * 批量弹层只需勾选标签，不必再区分"这是标签还是固定按钮"。
   */
  tagBulk: Object.freeze({
    request: z.object({
      ids: z.array(z.string()).min(1),
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional()
    }),
    response: z.object({ ok: z.boolean(), changed: z.number() })
  }),
  /** 批量固定 / 取消固定到书签栏（system:pinned 的语义化快捷方式） */
  pinnedBulk: Object.freeze({
    request: z.object({ ids: z.array(z.string()).min(1), pinned: z.boolean() }),
    response: z.object({ ok: z.boolean(), changed: z.number() })
  }),
  /** 批量固定 / 取消固定到 rail（system:rail） */
  railPinnedBulk: Object.freeze({
    request: z.object({ ids: z.array(z.string()).min(1), pinned: z.boolean() }),
    response: z.object({ ok: z.boolean(), changed: z.number() })
  }),
  /**
   * 删除一个用户标签（全库摘除该标签，行本身不动）。
   * `system:` 前缀被 domain 拒绝 —— 系统标签是 pinned / railPinned 的派生态。
   */
  tagDelete: Object.freeze({
    request: z.object({ tag: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), changed: z.number() })
  }),
  /** 打开偏好：点击该书签时默认在独立侧栏打开（书签自己的属性，逐个各异） */
  openInSidebarSet: Object.freeze({ request: z.object({ id: z.string(), value: z.boolean() }), response: z.unknown().nullable() }),
  // 标签分类栏数据：系统标签（始终出现）+ 用户标签（按热度降序），均带计数。
  tags: Object.freeze({ request: z.unknown().optional(), response: z.array(z.object({ tag: z.string(), count: z.number(), system: z.boolean().optional(), label: z.string().optional() })) }),
  /**
   * 按页面推荐标签（标签索引的 tf-idf 打分，F-0756~F-0760）。
   * `tags` 传当前已选标签：已有的不再推荐。返回纯标签名数组（顺序即推荐优先级）。
   */
  tagSuggestions: Object.freeze({
    request: z.object({
      url: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(20).optional()
    }).optional(),
    response: z.array(z.string())
  }),
  /** 已选标签 → 后续标签补全（共现 × 时间衰减）。 */
  tagAutocomplete: Object.freeze({
    request: z.object({ tags: z.array(z.string()), limit: z.number().int().positive().max(50).optional() }),
    response: z.array(z.string())
  })
})

export { bookmarksSchemas }

