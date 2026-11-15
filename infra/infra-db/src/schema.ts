/**
 * SQLite Schema — Drizzle ORM 表结构定义
 *
 * C13: 存储必须走 infra-db SQLite + Drizzle 事务
 *
 * 表结构覆盖：
 *   - bookmarks: 书签 + 文件夹（parent_id 自引用）
 *   - history: 浏览历史
 *   - downloads: 下载记录
 *   - notes: 侧边栏笔记
 *   - tabs: 标签持久化（会话恢复）
 *   - favicons: favicon 缓存
 *   - kv: 通用键值存储（设置等）
 *   - passwords_meta: 密码条目元数据（PART4 D4，敏感字段走加密后端）
 *   - permissions: 站点权限表（PART4 D3，取代 filtering.js + permissionManager.js）
 *   - search_history: 搜索框历史输入（PART4 E2）
 */

import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

// ── Profile 作用域（Steam 式多用户）───────────────────
// 书签 / 历史 / 下载 / favicon 缓存都挂在某个 profile 下：同一张表用 profile_id 分区，
// 读写一律带当前 profile。RT 把这些落在 Profiles/<id>/ 下的独立文件里；NG 共用单库，
// 因此靠列分区达到同一语义（当前 profile 由 APPS 层的 currentProfileId 端口提供）。
// 缺省 'default' = 老库迁移过来的既有数据，保证升级不丢东西。

// ── 书签 ──────────────────────────────────────────────
export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),               // UUID
  profileId: text('profile_id').notNull().default('default'), // 所属 profile
  parentId: text('parent_id'),               // 父文件夹 ID，null=根级
  title: text('title').notNull(),
  url: text('url'),                          // null=文件夹
  favicon: text('favicon'),
  tags: text('tags'),                        // JSON 数组字符串（如 '["dev","tools"]'），null=无标签
  nickname: text('nickname'),                // 展示用短名（留空则回落到 title）—— 窄条上放不下长标题时用它
  pinned: integer('pinned').notNull().default(0),        // 1=固定到书签栏
  pinnedOrder: integer('pinned_order').notNull().default(0), // 书签栏内排序
  railPinned: integer('rail_pinned').notNull().default(0),   // 1=固定到 rail（侧栏图标栏）；与 pinned 是两个独立固定位
  railPinnedOrder: integer('rail_pinned_order').notNull().default(0), // rail 固定区内排序（拖拽重排写入；0=老库未排序行，按 created_at 兜底）
  openInSidebar: integer('open_in_sidebar').notNull().default(0), // 1=点击该书签时默认在独立侧栏打开
  summary: text('summary'),                  // AI 摘要（收藏即知识）；null=还没生成
  summaryAt: integer('summary_at'),          // 摘要生成时间（ms）；null=没生成过，用于"是否过期"判断
  sortOrder: integer('sort_order').notNull().default(0),     // 同父级内排序（拖拽重排写入；0=老库未排序行，按 created_at 兜底）
  createdAt: integer('created_at').notNull(), // Unix timestamp (ms)
  modifiedAt: integer('modified_at').notNull()
})

// ── 浏览历史 ──────────────────────────────────────────
export const history = sqliteTable('history', {
  id: text('id').primaryKey(),               // UUID
  profileId: text('profile_id').notNull().default('default'), // 所属 profile
  url: text('url').notNull(),
  title: text('title'),
  favicon: text('favicon'),
  visitCount: integer('visit_count').notNull().default(0),
  typedCount: integer('typed_count').notNull().default(0), // 手动输入地址栏访问的次数（E1：权重高于点击链接）
  lastVisitAt: integer('last_visit_at').notNull(), // 最近访问时间
  firstVisitAt: integer('first_visit_at').notNull() // 首次访问时间
})

// ── 逐次访问日志（E1 历史双表：history = url 聚合，history_visits = 每次访问）──
// 单一事实源仍是 history（既有消费者零改动）；本表是**追加日志**，只为"某站点
// 在那天/那时访问了几次"的细粒度视图与游标分页提供数据。随 history 的裁剪级联删。
export const historyVisits = sqliteTable('history_visits', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  historyId: text('history_id'),              // 指向 history 聚合行（可空：容错，非强 FK）
  url: text('url').notNull(),                 // 冗余存 url：删聚合行后日志仍可独立裁剪/展示
  title: text('title'),                       // 访问当时的标题快照
  transition: text('transition').default('link'), // link|typed|reload|auto（来源类型）
  visitedAt: integer('visited_at').notNull()
})

// ── 页面正文索引（E3 正文全文检索）─────────────────────
// 每个 URL 存一份**可搜索的正文纯文本**（由 tab preload 抽取后上报），供历史按
// "页面上出现过的话"检索。与 history 分开建表，因为两者是不同生命周期的东西：
// history 是**访问事实**（一定会写），page_texts 是**内容快照**（抽取成功才写、体积大）。
// 按 profile 分区；不变式 = 「只保留仍存在于 history 的 URL」（裁剪历史时一并清）。
export const pageTexts = sqliteTable('page_texts', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  url: text('url').notNull(),
  title: text('title'),
  text: text('page_text').notNull().default(''),
  updatedAt: integer('updated_at').notNull()
})

// ── 下载记录 ──────────────────────────────────────────
export const downloads = sqliteTable('downloads', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'), // 所属 profile
  url: text('url').notNull(),
  filename: text('filename').notNull(),
  filePath: text('file_path'),
  totalBytes: integer('total_bytes'),
  receivedBytes: integer('received_bytes').default(0),
  state: text('state').notNull(),            // pending|in_progress|paused|completed|cancelled|interrupted
  mimeType: text('mime_type'),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  danger: text('danger'),                    // safe|suspicious|dangerous
  referrerUrl: text('referrer_url'),         // 来源页 URL（用于 MotW + 安全审计）
  multiThreaded: integer('multi_threaded').default(0), // 0=单线程 1=多线程
  connections: integer('connections').default(1)       // 多线程连接数
})

// ── 侧边栏笔记 ────────────────────────────────────────
// 与书签/历史/下载同构：按 profile 分区（否则切用户会看到上一个用户的笔记）。
// folderId 自引用到 note_folders（null = 未归档/根级）；url 记录创建来源页；
// tags 存 JSON 数组字符串；pinned/sortOrder 承载置顶与手动排序。
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  folderId: text('folder_id'),               // 所属文件夹，null=根级
  title: text('title').notNull(),
  content: text('content').default(''),
  url: text('url'),                          // 来源页面 URL
  tags: text('tags'),                        // JSON 数组字符串
  color: text('color'),                      // 颜色标签（色板 key），null=默认
  pinned: integer('pinned').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  // ── 集锦（经典 Edge Collections 完全体）字段 ──────────────
  // kind: 卡片**身份**，取值 note|page|image|snippet|ref（真源见 domain-notes#NOTE_KINDS）。
  //   一旦创建不再改 —— 改它等于把一种东西换成另一种，要换请新建。
  // asset_*: 图片卡片（kind='image'）的资产落盘路径 / 类型 / 原始尺寸。
  // thumb_path: 图片卡片的缩略图路径（列表画小图，免每次解码大图）。
  // ref_id / ref_mode: 引用卡片（kind='ref'）指向的目标卡 id 与展示形态（chip/link/inline）。
  // deleted_at: 回收站**软删**时间戳（NULL=在册）—— 删除先入回收站，purge 才是真删。
  kind: text('kind').notNull().default('note'),
  sourceTitle: text('source_title'),
  assetPath: text('asset_path'),
  assetMime: text('asset_mime'),
  assetWidth: integer('asset_width').default(0),
  assetHeight: integer('asset_height').default(0),
  thumbPath: text('thumb_path'),
  refId: text('ref_id'),
  refMode: text('ref_mode').default('chip'),
  deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(),
  modifiedAt: integer('modified_at').notNull()
})

// ── 集锦引用边（note_refs）────────────────────────────
// 引用是一张**边表**而不是卡片上的字段：一张卡可被多张卡引用，反链（谁引用了我）与
// 引用计数（↩N 徽标）都从这张表读。复合主键天然去重同一对 (from, to)。
// profileId：档案导出/导入与拆库迁移都按 `WHERE profile_id = ?` 逐表取数据，缺它会
// 让引用边静默搬不过去；卡片 id 全局唯一，故主键**不**并入 profile。
// origin：边的来源（'card' = 引用卡的 ref_id 决定 / 'inline' = 正文里的 hira-note:// 决定）。
// 两条生命周期不同 —— 正文改动只重建 'inline' 那份，引用卡的边不受影响。
export const noteRefs = sqliteTable('note_refs', {
  profileId: text('profile_id').notNull().default('default'),
  fromNoteId: text('from_note_id').notNull(),  // 发起引用的卡片
  toNoteId: text('to_note_id').notNull(),      // 被引用的目标卡片
  origin: text('origin').notNull().default('card'), // 'card' | 'inline'
  createdAt: integer('created_at').notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.fromNoteId, table.toNoteId] })
}))

// ── 笔记文件夹（可嵌套） ──────────────────────────────
// parent_id 自引用：null=顶层。删除文件夹时其下笔记回到根级（不级联删笔记）。
export const noteFolders = sqliteTable('note_folders', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull()
})

// ── TOTP 2FA 条目（验证器插件） ───────────────────────
// `secret_cipher` 是 **safeStorage 加密后**的 base32 密钥（base64 密文），不是明文 ——
// 与 passwords_meta.encrypted_password 同一条纪律：**明文密钥绝不落盘**。
// 解密只在主进程内、算码那一刻发生，且从不出主进程（见 domain-totp 的说明）。
// 算法参数逐条存：它们是每个条目的属性（Google 的迁移导出里就带着），
// 不能当成全局默认 —— 一条 8 位/60 秒的条目混进来就会算错。
export const totpEntries = sqliteTable('totp_entries', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  issuer: text('issuer').notNull().default(''),      // 服务名（"GitHub"）
  account: text('account').notNull().default(''),    // 账号（"alice@example.com"）
  secretCipher: text('secret_cipher').notNull(),     // safeStorage 加密后的密钥
  algorithm: text('algorithm').notNull().default('SHA1'),  // SHA1 / SHA256 / SHA512
  digits: integer('digits').notNull().default(6),    // 6 / 8
  period: integer('period').notNull().default(30),   // TOTP 时间步长（秒）
  type: text('type').notNull().default('TOTP'),      // TOTP / HOTP
  counter: integer('counter').notNull().default(0),  // HOTP 用；TOTP 恒 0
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

// ── 标签持久化（会话恢复） ────────────────────────────
// @deprecated 2026-09-13 —— D4「单一数据源」收口后已无写入方。
//   会话的唯一真相源是 `session.json`（@hira-ng/domain-session）。
//   本表定义暂时保留仅为兼容既有用户数据库（删表无收益、有风险），**不得再写入**。
export const tabs = sqliteTable('tabs', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  title: text('title'),
  favicon: text('favicon'),
  position: integer('position').notNull(),    // 在标签栏中的顺序
  pinned: integer('pinned').notNull().default(0), // 0=未固定, 1=固定
  active: integer('active').notNull().default(0),  // 0=非活动, 1=活动标签
  createdAt: integer('created_at').notNull()
})

// ── Favicon 缓存 ──────────────────────────────────────
// 主键是 (profileId, pageUrl)：缓存键里带页面 URL，等于记录了「这个 profile 访问过
// 哪些页」，因此必须按 profile 分区，不能跨 profile 共享（否则 URL 会互相泄漏）。
export const favicons = sqliteTable('favicons', {
  url: text('page_url').notNull(),             // 页面 URL
  profileId: text('profile_id').notNull().default('default'),
  faviconUrl: text('favicon_url'),            // favicon 文件 URL
  data: text('data'),                          // base64 编码的图片数据
  updatedAt: integer('updated_at').notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.profileId, table.url] })
}))

// ── 通用键值存储 ──────────────────────────────────────
export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

// ── 密码条目元数据 (PART4 D4) ────────────────────────
// 实际密码敏感字段不存本地，走 backend 解密；
// 本表只存 UI 列表所需元数据 + backend 内部引用
// Builtin 后端用 encryptedPassword 字段存 safeStorage 加密后的密码
export const passwordsMeta = sqliteTable('passwords_meta', {
  id: text('id').primaryKey(),                 // UUID
  profileId: text('profile_id').notNull(),     // 所属 profile
  backend: text('backend').notNull(),          // 'builtin'|'bitwarden'|'1password'|'keychain'
  domain: text('domain').notNull(),            // 登录页域名（已规范化）
  username: text('username').notNull(),
  backendRef: text('backend_ref'),             // 后端内部 ID（实际密码在后端）
  encryptedPassword: text('encrypted_password'), // safeStorage 加密后的密码（仅 Builtin 后端使用）
  lastUsedAt: integer('last_used_at'),         // 最近使用时间
  createdAt: integer('created_at').notNull()
})

export const passwordsNeverSave = sqliteTable('passwords_never_save', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  domain: text('domain').notNull(),
  createdAt: integer('created_at').notNull()
})

// ── 站点权限 (PART4 D3) ──────────────────────────────
// 取代旧版 filtering.js + permissionManager.js 双写
export const permissions = sqliteTable('permissions', {
  id: text('id').primaryKey(),                 // UUID
  profileId: text('profile_id').notNull(),
  domain: text('domain').notNull(),            // 规范化域 (含端口)
  permissionType: text('permission_type').notNull(), // popup|notification|location|camera|microphone|...
  setting: text('setting').notNull(),          // 'allow'|'block'|'ask'
  updatedAt: integer('updated_at').notNull()
})

// ── 搜索框历史输入 (PART4 E2) ─────────────────────────
export const searchHistory = sqliteTable('search_history', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  queryText: text('query_text').notNull(),
  hitCount: integer('hit_count').notNull().default(1),
  lastUsedAt: integer('last_used_at').notNull()
})

// ── 自定义 Bang（F-0761~F-0764）──────────────────────
// 用户自定义的 `!触发词` 快捷搜索/跳转。与内置表（shared-types/commands.mjs）分开存：
// 内置是"代码里的事实"，自定义是"用户数据"，两者的生命周期与备份语义都不同。
// trigger 归一化后（去 `!` / 小写 / 去空白）在**同一 profile 内唯一**。
export const customBangs = sqliteTable('custom_bangs', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  trigger: text('trigger').notNull(),                  // 归一化后的触发词（不含 `!`）
  title: text('title').notNull(),                      // 建议列表里展示的名字
  url: text('url').notNull(),                          // URL 模板（buildSearchUrl 同一套规则）
  showSuggestions: integer('show_suggestions').notNull().default(1), // 0=不在下拉里出现，只认回车直搜
  hitCount: integer('hit_count').notNull().default(0), // 使用次数（F-0764）
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

// ── 自定义搜索引擎（用户数据）─────────────────────────
// 与 `custom_bangs` **同构但不同表**，共享同一套存储实现（domain-search/custom-store.ts），
// 但语义不同：引擎是「默认搜索引擎」下拉里的候选 —— 没有触发词、不进 `!` 列表。
// `trigger` 列沿用同构设计，由存储层从名称 / 主机名**内部推导**（非空 + 唯一约束的落点），
// UI 与地址栏都不消费它。
// 内置引擎是**代码事实**（`shared-types/src/search-engines.mjs`），不落库、不可改；
// 这里只存用户自己新建的。
export const customEngines = sqliteTable('custom_engines', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().default('default'),
  trigger: text('trigger').notNull(),                  // 归一化后的触发词（不含 `!`）
  title: text('title').notNull(),                      // 默认引擎下拉里展示的名字
  url: text('url').notNull(),                          // URL 模板（search-url.mjs 同一套规则）
  showSuggestions: integer('show_suggestions').notNull().default(1),
  hitCount: integer('hit_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

// ── Profile 空间 (W21) ────────────────────────────────
// internal: 内部 profile（如无痕），其空间列表不外露给 UI（RT 同语义）
// ephemeral: 临时 profile（退出即弃），lastUsed 等写操作直接跳过
export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),                 // 'default' 或 UUID
  name: text('name').notNull(),                // 显示名称
  icon: text('icon').notNull().default('carbon:home'),
  color: text('color'),                        // 主题色
  createdAt: integer('created_at').notNull(),
  lastActiveAt: integer('last_active_at'),
  isActive: integer('is_active').notNull().default(0), // 0/1
  internal: integer('internal').notNull().default(0),  // 0/1 内部 profile
  ephemeral: integer('ephemeral').notNull().default(0) // 0/1 临时 profile
})

// ── 工作空间 Space ────────────────────────────────────
// 物理嵌套语义：space 归属于 profile（profileId），会话数据落
// `userData/profiles/<profileId>/spaces/<spaceId>/session.json`。
// order/lastUsed 承载排序与「上次使用」，与 RT spaces-controller 对齐。
// 主键是 (profileId, id) 复合键 —— 「default」这个 id 在每个 profile 下各自存在一份。
export const spaces = sqliteTable('spaces', {
  id: text('id').notNull(),                    // 'default' 或 slug/UUID（profile 内唯一）
  profileId: text('profile_id').notNull(),     // 所属 profile
  name: text('name').notNull(),
  icon: text('icon').notNull().default(''),
  bgStartColor: text('bg_start_color').notNull().default(''),
  bgEndColor: text('bg_end_color').notNull().default(''),
  order: integer('order').notNull().default(999),
  lastUsed: integer('last_used').notNull().default(0),
  createdAt: integer('created_at').notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.profileId, table.id] })
}))

// ── PWA 应用（安装到本地的站点应用）──────────────────
// 与 Edge/Chrome 的「安装为应用」同语义，但**不是**浏览器扩展：
// 一条记录 = 一个独立应用窗的身份 + 它的资产目录/快捷方式状态。
//
// 唯一键 (profile_id, start_url)：同一 profile 下同一站点只允许装一次；
// appId 由 makeAppId(profileId, startUrl) 确定性生成，因此重装不会换身份
// （换身份 = 任务栏固定项失效、快捷方式指向旧 id）。
//
// 资产（manifest 快照 / PNG / ICO）落在 userData/profiles/<pid>/pwa/<appId>/，
// 表里只存**相对文件名**，绝对路径永远不回给渲染层（图标走 hira-pwa:// 协议）。
export const pwaApps = sqliteTable('pwa_apps', {
  id: text('id').primaryKey(),                        // 'pwa-<sha256 前16位>'
  profileId: text('profile_id').notNull().default('default'),
  name: text('name').notNull(),                       // 展示名（short_name 优先）
  shortName: text('short_name'),
  startUrl: text('start_url').notNull(),
  scope: text('scope'),                               // 站内导航边界；null=按 start_url 目录推导
  manifestUrl: text('manifest_url'),
  manifestJson: text('manifest_json'),                // 安装时快照，供更新 diff
  display: text('display').notNull().default('standalone'),
  themeColor: text('theme_color'),
  backgroundColor: text('background_color'),
  iconPath: text('icon_path'),                        // 相对资产目录
  iconSmallPath: text('icon_small_path'),
  iconIcoPath: text('icon_ico_path'),
  installKind: text('install_kind').notNull().default('full'), // full|shortcut
  source: text('source').notNull().default('manifest'),        // manifest|favicon|fallback
  sessionPartition: text('session_partition'),        // 预留：本期恒 null（共用默认 session）
  startMenuShortcut: text('start_menu_shortcut'),     // 快捷方式绝对路径（仅主进程用）
  desktopShortcut: text('desktop_shortcut'),
  runOnStartup: integer('run_on_startup').notNull().default(0),
  windowState: text('window_state'),                  // JSON: { x,y,width,height,maximized }
  updateState: text('update_state').notNull().default('idle'), // idle|available|error
  lastCheckedAt: integer('last_checked_at'),
  lastLaunchedAt: integer('last_launched_at'),
  launchCount: integer('launch_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const layoutDocuments = sqliteTable('layout_documents', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  spaceId: text('space_id').notNull().default(''),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('custom'),
  schemaVersion: integer('schema_version').notNull(),
  revision: integer('revision').notNull().default(1),
  documentJson: text('document_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const layoutRevisions = sqliteTable('layout_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  layoutId: text('layout_id').notNull(),
  revision: integer('revision').notNull(),
  action: text('action').notNull(),
  documentJson: text('document_json').notNull(),
  createdAt: integer('created_at').notNull()
})

export const layoutBindings = sqliteTable('layout_bindings', {
  profileId: text('profile_id').notNull(),
  spaceId: text('space_id').notNull().default(''),
  context: text('context').notNull().default('default'),
  layoutId: text('layout_id').notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.profileId, table.spaceId, table.context] })
}))

