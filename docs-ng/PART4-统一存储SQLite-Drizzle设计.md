# STAR Hira NG 大换血重写规划 PART 4 - 统一存储设计 (SQLite + Drizzle 取代7种分散存储)

生成时间：2026-01-03

=========================================
4.1 存储总目标
=========================================

[消除项]
❌ 渲染进程 Dexie IndexedDB browsingData2 (places/bookmarkMeta/bookmarkFolders/thumbnails 4表)
❌ settings.json 扁平 200+ key + 嵌套 profileStore大对象 + 嵌套 profileExtensionMap
❌ 分散的 JsonStore 单文件 (downloadHistory.json sessionRestore.json ...)
❌ 密码4后端各自存储位置不统一

[保留项 不改动(内核层)]
✅ S6 chrome.storage API (扩展内部存储 保持原样)
✅ S7 Electron Session partition (Cookie/Cache/Chromium内部 保持原样)

[新增 统一中心]
⭐ 主进程 SQLite + Drizzle 单库 {userData}/hira.db

- 全部业务数据一个文件 方便备份/迁移/修复
- WAL模式 并发读安全
- 每 100 写操作 + 每 10min 自动 checkpoint
  ⭐ 数据库只允许 domain-* 和 infra-db 访问
  UI/APPS 层必须通过 domain 服务接口 绝对不能直接写SQL

=========================================
4.2 完整 Schema 设计 (20+ 表 全部分层 profile_id)
=========================================

所有可查询字段一律列存储 仅非查询的动态数组才用 JSON列
所有带 profile_id 的表天然支持 profile 隔离

=========================================
GROUP A: 配置 & 系统表 (取代 settings.json)
=========================================

--- A1. profiles 空间表 (取代 profileStore 嵌套 S2) ---
profiles:
profile_id TEXT PK 例: 'default' 'profile-a1b2' (normalize过)
name TEXT NOT NULL 例: '默认空间' '工作'
icon TEXT 例: 'carbon:home' (PROFILE_ICON_CHOICES内)
partition TEXT NOT NULL 例: 'persist:webcontent' 'persist:profile-xxx'
display_order INTEGER NOT NULL 排序
is_active INTEGER(0/1) NOT NULL 当前活动空间标记
created_at INTEGER(unix ms) NOT NULL
updated_at INTEGER(unix ms) NOT NULL

--- A2. profile_isolation_items 空间隔离项 (8项隔离配置 取代内联对象数组) ---
profile_isolation_items:
id INTEGER PK AUTO
profile_id TEXT FK -> profiles.profile_id ON DELETE CASCADE
item_key TEXT NOT NULL settings/cache/passwords/history/bookmarks/downloads/extensions/safeIntercept (8项)
is_isolated INTEGER(0/1) NOT NULL 是否独立存储
UNIQUE(profile_id, item_key)
-> INDEX on profile_id

--- A3. settings 系统设置表 (取代 settings.json 200+扁平键) ---
settings:
setting_id INTEGER PK AUTO
profile_id TEXT FK -> profiles NULLABLE (NULL=全局默认 非空=此profile覆盖)
key TEXT NOT NULL 命名空间: 例 'ui.darkMode' 'browser.ua.custom'
value_json TEXT NOT NULL JSON序列化值 (用JSON列 可按类型重建)
value_type TEXT NOT NULL 'boolean'|'number'|'string'|'object'|'array'
updated_at INTEGER(unix ms) NOT NULL
UNIQUE(profile_id, key)
-> INDEX on (profile_id, key) => 快速查某profile某key值
-> INDEX on key => 查所有profile对某key的覆盖

迁移后 key 命名空间 (示例):
ui.darkMode -> 布尔 原 settings.darkMode
ui.titlebar.separate -> 原 useSeparateTitlebar
ui.layout.mode -> 原 tabbarMode / layoutMode
ui.zenMode.enabled -> 原 zenMode
browser.ua.custom -> 原 customUserAgent (全局默认)
browser.ua.fingerprint -> 原 fingerprint (JSON)
browser.filtering.blockingLevel-> 原 filtering.blockingLevel
browser.extensions.list -> 原 browserExtensions (JSON数组)
panel.favorites.order -> 原 sidebarFavoritesOrder
panel.favorites.pinned -> 原 sidebarPinnedFavorites
panel.downloads.order -> 原 sidebarDownloadsOrder
passwords.manager.current -> 原 passwordManager.name
passwords.neversave.domains -> 原 passwordsNeverSaveDomains
permissions.popup.allowed -> 原 popupPermissions.allowed
permissions.notif.blocked -> 原 notificationPermissions.blocked
search.engine.current -> 原 currentSearchEngine
... (全部 200+ key 有体系化 namespace 可迁移)

--- A4. settings_versions 迁移版本 (取代 无version的坟场) ---
settings_versions:
version INTEGER PK 例: 1 2 3
applied_at INTEGER(unix ms) NOT NULL
description TEXT NOT NULL 迁移脚本描述
schema_hash TEXT 防篡改
=> 每加设置字段 or 改默认值 bump version 记录一条 以后升级能精确执行哪个脚本

=========================================
GROUP B: 标签 & 窗口 & 空间会话表 (取代 profileStore.tabs + sessionRestore.json)
=========================================

--- B1. tabs 标签页 (参考RT tabs表 + 字段扩) ---
tabs:
unique_id TEXT PK 例: 'tab-a1b2c3d4' (全局唯一 永不复用)
profile_id TEXT FK -> profiles.profile_id NOT NULL
window_group_id TEXT NOT NULL 属于哪个窗口组
space_id TEXT NOT NULL 属于哪个tab空间 (profiles内可再分tab space)
tab_group_id TEXT FK -> tab_groups.group_id NULLABLE
position INTEGER NOT NULL 排序
title TEXT NOT NULL 页面标题 (空串=未加载)
url TEXT NOT NULL 当前URL
favicon_url TEXT favicon
is_pinned INTEGER(0/1) NOT NULL DEFAULT 0 是否固定标签
pinned_order INTEGER 固定标签的排序 NULL=未固定
muted INTEGER(0/1) NOT NULL DEFAULT 0
is_private INTEGER(0/1) NOT NULL DEFAULT 0
scroll_x INTEGER 页面滚动位置
scroll_y INTEGER
nav_history TEXT(JSON NavigationEntry[]) NOT NULL '[]' 空
nav_history_index INTEGER NOT NULL DEFAULT 0
created_at INTEGER(unix ms) NOT NULL
last_active_at INTEGER(unix ms) NOT NULL
-> INDEX on (profile_id, window_group_id) => 快速查某窗口全部tab
-> INDEX on (profile_id, space_id, is_pinned DESC, pinned_order, position) => 侧栏显示顺序
-> INDEX on last_active_at => 最近标签查询

--- B2. tab_groups 标签组 (支持 tab stack glance 模式) ---
tab_groups:
group_id TEXT PK
profile_id TEXT NOT NULL
space_id TEXT NOT NULL
mode TEXT NOT NULL 'stack'|'glance'|'workspace'
name TEXT 用户自定义组名
glance_front_tab TEXT FK -> tabs.unique_id
position INTEGER NOT NULL
created_at INTEGER(unix ms) NOT NULL

--- B3. window_states 窗口几何状态 (取代 windowManagement 的 localStorage) ---
window_states:
window_group_id TEXT PK
width INTEGER NOT NULL
height INTEGER NOT NULL
x INTEGER
y INTEGER
is_maximized INTEGER(0/1) DEFAULT 0
is_fullscreen INTEGER(0/1) DEFAULT 0
is_popup INTEGER(0/1) DEFAULT 0
layout_mode TEXT 'default'|'rail'|'zen'

--- B4. workspaces Tab 空间表 (profiles 内部再分 tab workspace) ---
workspaces:
space_id TEXT PK
profile_id TEXT FK -> profiles NOT NULL
name TEXT NOT NULL
icon TEXT
display_order INTEGER NOT NULL
created_at INTEGER(unix ms) NOT NULL

=========================================
GROUP C: 历史 & 书签 & 搜索表 (取代 S1 Dexie browsingData2)
=========================================

--- C1. history_urls URL 去重表 (参考RT 完全同设计!) ---
history_urls:
id INTEGER PK AUTO
profile_id TEXT NOT NULL (profile隔离!)
url TEXT NOT NULL
host TEXT NOT NULL 预存 tld 解析后的 host 按host分组查询加速
title TEXT NOT NULL 最后一次访问的标题
color TEXT 页面主色 (原 places.color)
visit_count INTEGER NOT NULL DEFAULT 0
typed_count INTEGER NOT NULL DEFAULT 0
last_visit_time INTEGER(unix ms) NOT NULL
UNIQUE(profile_id, url)
-> INDEX on (profile_id, last_visit_time DESC) => 历史页面按时间倒序
-> INDEX on (profile_id, host) => 按域名筛选
-> INDEX on (profile_id, visit_count DESC) => 最常访问

--- C2. history_visits 访问事实 (参考RT) ---
history_visits:
id INTEGER PK AUTO
url_id INTEGER FK -> history_urls.id ON DELETE CASCADE
visit_time INTEGER(unix ms) NOT NULL
typed INTEGER(0/1) NOT NULL DEFAULT 0
transition_type TEXT 'link'|'typed'|'auto_bookmark'|...
-> INDEX on url_id
-> INDEX on visit_time DESC

--- C3. bookmarks 书签表 (取代 places.isBookmarked + bookmarkMeta 2表合一 + folder归属) ---
bookmarks:
bookmark_id TEXT PK 雪花 ID: 'bm-时间戳-随机' (不用自增 导入时冲突易处理)
profile_id TEXT NOT NULL
url TEXT NOT NULL (书签URL 可重复 不像历史 unique)
title TEXT NOT NULL 书签标题 (用户可编辑 不等于页面title!)
host TEXT NOT NULL 冗余 按域名过滤
folder_id TEXT FK -> folders.folder_id NOT NULL DEFAULT '0' (0=根目录)
order_in_folder REAL NOT NULL 同目录排序 用REAL 插入只需改相邻平均 (类似 fractional indexing)
is_pinned INTEGER(0/1) NOT NULL DEFAULT 0
pinned_order INTEGER 侧栏rail固定顺序 NULL=未固定
open_in_main_view INTEGER(0/1) NOT NULL DEFAULT 0
favicon_url TEXT
color TEXT
tags TEXT(JSON string[]) '[]'
note TEXT 用户备注
visit_count INTEGER NOT NULL DEFAULT 0 (书签自己的访问计数 独立历史)
last_visit_time INTEGER
created_at INTEGER(unix ms) NOT NULL
updated_at INTEGER(unix ms) NOT NULL
-> UNIQUE? 不要! 同一URL允许用户在多个文件夹收藏多个副本 (故意允许)
-> INDEX on (profile_id, folder_id, order_in_folder) => 文件夹列表 这是最高频查询
-> INDEX on (profile_id, is_pinned DESC, pinned_order) => 侧栏固定书签栏
-> INDEX on (profile_id, host) => 按域名搜索收藏
-> INDEX on (profile_id, url) => 从URL反查是否已收藏 (去重提示用)

--- C4. folders 书签文件夹表 (取代 bookmarkFolders Dexie表 + 层次结构) ---
folders:
folder_id TEXT PK '0' = 根目录 (预置不能删)
profile_id TEXT NOT NULL
name TEXT NOT NULL 文件夹名 同parent下name不能重复
parent_folder_id TEXT FK -> folders.folder_id NOT NULL DEFAULT '0'
order_in_parent REAL NOT NULL 兄弟排序
expanded INTEGER(0/1) NOT NULL DEFAULT 1 UI是否展开 (每个profile独立)
color TEXT 用户自定义颜色 NULL=默认
icon TEXT 自定义图标
description TEXT
created_at INTEGER(unix ms) NOT NULL
updated_at INTEGER(unix ms) NOT NULL
-> UNIQUE(profile_id, parent_folder_id, name) => 同文件夹内子文件夹不重名
-> INDEX on (profile_id, parent_folder_id, order_in_parent) => 按层遍历
-> INDEX on (profile_id) => 一次性取出某空间全部文件夹 内存建树 (常用!)

--- C5. bookmarks_fts 书签全文搜索虚拟表 (SQLite FTS5) ---
CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
title, url, host, note, tags,
content='bookmarks', content_rowid='rowid',
tokenize='trigram'
)
=> 比 Dexie 的 searchIndex 数组方式快 10~100倍 原生 SQLite

--- C6. history_fts 历史全文搜索虚拟表 (同理) ---
CREATE VIRTUAL TABLE history_fts USING fts5(
title, url, host,
content='history_urls', content_rowid='id',
tokenize='trigram'
)

--- C7. thumbnails 缩略图缓存表 (取代 Dexie thumbnails) ---
thumbnails:
url_hash TEXT PK MD5(url) 不直接存URL 省空间
profile_id TEXT NOT NULL
url TEXT NOT NULL 原始URL 调试用
thumbnail_data BLOB NOT NULL PNG 二进制
created_at INTEGER(unix ms) NOT NULL
access_count INTEGER NOT NULL DEFAULT 0
-> INDEX on (profile_id, access_count DESC) => LRU淘汰不常用的
=> TTL策略: 30天未访问 自动删除

=========================================
GROUP D: 下载 扩展 权限 密码 (取代 S4 S5 S8 + filtering.js)
=========================================

--- D1. downloads 下载记录表 (取代 downloadHistory.json) ---
downloads:
download_id TEXT PK 'dl-xxx'
profile_id TEXT NOT NULL
url TEXT NOT NULL
referrer TEXT
filename TEXT NOT NULL 最终文件名
save_path TEXT NOT NULL 完整保存路径
mime_type TEXT
total_bytes INTEGER NOT NULL DEFAULT -1 -1=未知大小
received_bytes INTEGER NOT NULL DEFAULT 0
state TEXT NOT NULL 'queued'|'downloading'|'paused'|'completed'|'interrupted'|'cancelled'|'danger'
danger_type TEXT P6检测: 'malware'|'uncommon'|'dangerous'|NULL
can_resume INTEGER(0/1) NOT NULL DEFAULT 0
connections_count INTEGER 多连接数
interrupt_reason TEXT
speed_bps INTEGER 最近一次速度 (bytes/s)
eta_ms INTEGER
time_started INTEGER(unix ms) NOT NULL
time_completed INTEGER(unix ms) NULL
panel_order REAL 侧栏下载面板排序
opened INTEGER(0/1) NOT NULL DEFAULT 0 是否已打开过
pinned INTEGER(0/1) NOT NULL DEFAULT 0 侧栏固定 (不清历史时保留)
-> INDEX on (profile_id, state, time_started DESC) => 下载面板列表 最高频查询
-> INDEX on (profile_id, time_completed DESC) => 已完成按时间
-> INDEX on (profile_id, pinned DESC, panel_order) => 侧栏固定项

--- D2. extensions 扩展表 (取代 S4 profileExtensionMap + browserExtensions) ---
extensions:
extension_id TEXT PK Chrome Web Store ID
profile_id TEXT NOT NULL (profile隔离!)
name TEXT NOT NULL
description TEXT
version TEXT
type TEXT NOT NULL 'unpacked'|'crx' 存储路径区分
path TEXT NOT NULL 扩展目录或crx路径
disabled INTEGER(0/1) NOT NULL DEFAULT 0
pinned INTEGER(0/1) NOT NULL DEFAULT 0
pinned_order INTEGER
icon_path TEXT
icon_data_url TEXT base64 侧栏显示
manifest_json TEXT 完整 manifest JSON (调试用)
install_time INTEGER(unix ms) NOT NULL
update_time INTEGER(unix ms)
permissions_json TEXT 权限列表 JSON数组 (权限警告展示)
UNIQUE(profile_id, extension_id)
-> INDEX on (profile_id, disabled, pinned DESC, pinned_order) => 侧栏/管理页列表

--- D3. permissions 站点权限表 (取代 filtering.js + permissionManager.js 双写) ---
permissions:
id INTEGER PK AUTO
profile_id TEXT NOT NULL
domain TEXT NOT NULL 规范化域 (含端口)
permission_type TEXT NOT NULL 'popup'|'notification'|'location'|'camera'|'microphone'|...
setting TEXT NOT NULL 'allow'|'block'|'ask'
updated_at INTEGER(unix ms) NOT NULL
UNIQUE(profile_id, domain, permission_type)
-> INDEX on (profile_id, permission_type) => 查所有域名的某类权限
-> 完全取代 popupPermissions allowed[]/blocked[] / notificationPermissions / sitePermission.*

--- D4. passwords 密码条目元数据表 (实际敏感字段走加密后端) ---
passwords_meta:
id INTEGER PK AUTO
profile_id TEXT NOT NULL
backend TEXT NOT NULL 'builtin'|'bitwarden'|'1password'|'keychain'
domain TEXT NOT NULL 登录页域名
username TEXT NOT NULL 用户名
backend_ref TEXT 后端内部ID 实际密码在后端
last_used_at INTEGER(unix ms)
created_at INTEGER(unix ms) NOT NULL
-> 密码管理器 UI 展示列表只读这个表 点详情才走后端解密
-> 不再依赖 settings.json passwordsNeverSaveDomains -> 移到 settings 表 key: passwords.neversave.domains

=========================================
GROUP E: UI状态与缓存表 (可重建 崩溃自动清理)
=========================================

--- E1. ui_state 每个窗口 UI 持久化状态 (替代 localStorage 散写) ---
ui_state:
id INTEGER PK AUTO
profile_id TEXT
window_group_id TEXT
key TEXT NOT NULL 例 'sidebar.width' 'zen-mode.enabled'
value_json TEXT NOT NULL
value_type TEXT NOT NULL
UNIQUE(profile_id, window_group_id, key) NULL=全局

--- E2. search_history 搜索框历史输入 (搜索栏建议用) ---
search_history:
id INTEGER PK AUTO
profile_id TEXT NOT NULL
query_text TEXT NOT NULL
hit_count INTEGER NOT NULL DEFAULT 1
last_hit_at INTEGER(unix ms) NOT NULL
UNIQUE(profile_id, query_text)

--- E3. custom_bangs 自定义 !bang 指令 (取代 customBangs.js JSON) ---
custom_bangs:
id INTEGER PK AUTO
profile_id TEXT NOT NULL
trigger TEXT NOT NULL 例: 'g' 'gh' 'imdb'
url_template TEXT NOT NULL 例: 'https://www.google.com/search?q={}'
name TEXT
UNIQUE(profile_id, trigger)

=========================================
4.3 事务 & 一致性保证 (解决 P0 TOP3)
=========================================

跨域写操作统一走 DomainService.transaction<T>(fn) 封装:

例子: "创建书签 + 加入 folder + 侧栏固定" = bookmarks.insert + folder 的 updated_at + (若固定) 更新 pinned_order
→ 单个 SQLite 事务内全部完成
→ 中间任何一步 throw = 全部回滚 不会有孤儿数据
→ 事务完成后 emit 'bookmarks:changed:xxx' 事件 UI 细粒度重绘

setting 变更广播雪崩的解决方案:
domain-settings.watch(pattern, callback) // pattern 通配符匹配 key namespace
例:
settings.watch('ui.tabbar._', cb) 只监听 tabbar 相关设置变更
settings.watch('profile:{currentProfileId}.passwords._', cb)
→ 不再全局广播 settingChanged 触发231回调
→ 每个UI组件只订阅自己关心的 namespace pattern

=========================================
4.4 迁移系统 (从 Hira v7.5.0 升级到 NG 1.0)
=========================================

目录: 1A-STAR_Hira_NG/migrations/from-hira-v7.5.0/

8 个适配器 顺序执行 (幂等! 重复执行不破坏):

1. SettingsAdapter: 读 settings.json → 插入 settings 表 A3
   → namespace 转换表 (完整 200+ 键映射文件 settings-keys-map.json)
   → profileStore 大对象拆解: 写 profiles A1 + profile_isolation_items A2
   → profileExtensionMap 拆解: 写 extensions D2

2. DexiePlacesAdapter: 渲染进程 Dexie browsingData2 导出 JSON → 主进程导入
   → places.url/isBookmarked/visitCount/lastVisit/title/color → history_urls C1
   → places 中 isBookmarked=true 的行 → bookmarks C3
   → 每次访问从 places.metadata 解析重建 history_visits C2 (尽力而为)
   → bookmarkMeta 表 → bookmarks C3 的 pinned_order/open_in_main_view 字段
   → bookmarkFolders 表 → folders C4

3. DexieThumbnailsAdapter: thumbnails表 → thumbnails C7 (url_hash重建)

4. DownloadHistoryAdapter: JsonStore downloadHistory.json → downloads D1
   → 状态枚举映射: 旧 state 字符串 → 新标准枚举

5. SessionRestoreAdapter: sessionRestore.json → tabs B1 + tab_groups B2 + workspaces B4
   → 旧 profileTabsMap[id] 分配给对应 profile_id

6. CustomBangsAdapter: customBangs JSON → custom_bangs E3

7. PasswordsAdapter: 每个后端导出条目 metadata → passwords_meta D4
   → 敏感数据不迁移 仍留原后端 只建立索引

8. DataIntegrityVerifier: 最后运行 100+ 校验 SQL:
   ✓ bookmarks.folder_id 全部指向存在的 folders 行
   ✓ history_visits.url_id 都在 history_urls 里
   ✓ profile_isolation_items 每个 profile 都有 8 行 (补全缺失项)
   ✓ tabs.profile_id 都存在 profiles
   ✓ settings.key 都符合命名空间规范 (防脏键漏网)
   ✓ bookmarks UNIQUE(parent,name) 无重复 (修复重复项)

→ 迁移成功: 旧文件重命名 .bak.7.5.0 不删 出问题可回滚
→ 迁移失败: 自动 .revert SQL 恢复备份 + 日志 + 弹窗让用户选重试/跳过/用备份

=========================================
4.5 备份 & 恢复 & 崩溃安全
=========================================

- SQLite 每次启动自动:
  1. PRAGMA integrity_check; // 完整性检查
  2. 若损坏: 自动用上一份 hourly backup 还原 + 尝试导出未损坏部分
- 备份策略:
  - 每 1 小时增量备份 {userData}/backups/hourly/hira-YYYYMMDD-HH.db
  - 每 1 天完整备份 {userData}/backups/daily/hira-YYYYMMDD.db.gz
  - 保留 7 天每日 + 24 小时每小时
  - 用户点击"备份我的数据": 导出 hira-backup-YYYYMMDD.zip (db.json + 扩展目录打包)
- 冷启动恢复:
  启动顺序: PRAGMA检查 → 版本不符则迁移 → Adapter校验 → 健康检查SQL → 才让 Domain层打开
  → 任何一步不过 → 进入安全模式 (仅核心模块 可选恢复备份)
