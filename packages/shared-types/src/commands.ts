/**
 * 地址栏**命令表**与 **bangs 表** —— 全项目唯一真源（纯数据 + 纯函数，零依赖）。
 *
 * ── 为什么必须只有一个真源 ────────────────────────────────────────────────
 * 命令在改造前散在**三处**：`ui/ui-searchbar/suggestors/pedals.ts`（建议）、
 * `infra/infra-window/TabManager.js#omniboxAction`（执行）、
 * `apps/app-main/src/main/main.js#keybindingActions`（快捷键）。
 * 于是「加一条命令」要改两三处，改漏一处就是"能搜到但点了没反应"。
 * bangs 同样是两份不一致的表（UI 30 条 / 主进程 10 条）。
 *
 * 本模块把它们收成一张表，两个消费方各取所需：
 *   · UI 侧（`pedals.js` / `bangs.js`）用 `matchCommands` / `resolveBangEngine` 出建议；
 *   · 主进程侧（`TabManager#omniboxAction`）用 `commandUrl` 把 id 翻成内部页地址。
 * 加一条命令 = **本文件一行**（内部页带 `page`，不需要再写映射）。
 *
 * ── 为什么放 shared-types ────────────────────────────────────────────────
 * 它是唯一同时被「ESM 的 ui 包」和「CJS 的 infra」引用的地方，且不依赖任何一个
 * —— `require('@hira-ng/shared-types/src/*.mjs')` 在本项目是既有范式
 * （见 `glance-layout.mjs` / `split-layout.mjs` / `clean-url.mjs` 等十余处）。
 */

import { buildSearchUrl } from './search-url.js'
// 搜索引擎类 bang 的名称 / 模板直接引用内置引擎真源 —— 同一个站不在两张表里各写一遍。
import { SEARCH_ENGINES } from './search-engines.js'
// 内部页地址拼法只认 pages.mjs#pageUrl —— 命令表不自己拼 `hira://` 前缀。
import { pageUrl } from './pages.js'

export interface Command {
  id: string
  title: string
  keywords: string[]
  page?: string
  query?: string
}

/** @type {Command[]} */
export const COMMANDS: Command[] = [
  { id: 'open_settings', title: '打开设置', page: 'settings', keywords: ['settings', '设置', '偏好设置', 'preferences'] },
  { id: 'open_history', title: '打开历史记录', page: 'history', keywords: ['history', '历史', '浏览记录'] },
  { id: 'open_bookmarks', title: '打开书签', page: 'bookmarks', keywords: ['bookmarks', '书签', '收藏'] },
  { id: 'open_downloads', title: '打开下载', page: 'downloads', keywords: ['downloads', '下载'] },
  { id: 'open_extensions', title: '打开扩展程序', page: 'extensions', keywords: ['extensions', '扩展', '插件'] },
  { id: 'open_passwords', title: '打开密码管理', page: 'passwords', keywords: ['passwords', '密码'] },
  { id: 'open_passkeys', title: '打开 Passkey', page: 'passkeys', keywords: ['passkey', 'passkeys', '通行密钥', '生物识别', 'webauthn'] },
  { id: 'open_permissions', title: '站点权限', page: 'permissions', keywords: ['permissions', '权限', '站点权限'] },
  { id: 'open_clear_data', title: '清除浏览数据', page: 'clear-data', keywords: ['clear data', '清除数据', '清空数据', '清除浏览数据'] },
  { id: 'open_task_manager', title: '任务管理器', page: 'task-manager', keywords: ['task manager', '任务管理器', '进程'] },
  { id: 'open_import_data', title: '导入数据', page: 'import-data', keywords: ['import', '导入', '导入数据'] },
  // 软件更新不再是独立页面：它是「关于 Hira」页的第二个选项卡。
  // `query` 是同一 host 内的深链（`hira://about?tab=update`），由 `commandUrl` 拼出。
  { id: 'open_update', title: '检查更新', page: 'about', query: 'tab=update', keywords: ['update', '更新', '检查更新'] },
  { id: 'open_spaces', title: '管理空间', page: 'spaces', keywords: ['spaces', '空间', '工作空间'] },
  { id: 'open_profiles', title: '管理配置文件', page: 'profiles', keywords: ['profiles', '配置文件', '配置'] },
  { id: 'open_games', title: '打开游戏', page: 'games', keywords: ['games', '游戏'] },
  { id: 'open_about', title: '关于 Hira', page: 'about', keywords: ['about', '关于', '版本'] },
  { id: 'open_color_picker', title: '取色器', page: 'color-picker', keywords: ['color picker', '取色器', '取色'] },
  { id: 'open_crash_report', title: '崩溃报告', page: 'crash-report', keywords: ['crash', '崩溃', '崩溃报告'] },
  { id: 'open_automation', title: '自动化（命令链 / 鼠标手势）', page: 'automation', keywords: ['automation', '自动化', '命令链', '手势', 'macro'] },
  { id: 'open_sessions', title: '会话管理', page: 'sessions', keywords: ['sessions', '会话', '会话管理', '保存的标签'] },
  // ── 没有内部页的动作：执行侧走特殊分支（窗口 / 标签 / 截图）──
  { id: 'open_new_window', title: '新建窗口', keywords: ['new window', '新窗口', 'new win'] },
  { id: 'open_incognito_window', title: '新建隐身窗口', keywords: ['incognito window', '隐身窗口', '无痕窗口', 'private window', 'incognito', '隐身', '无痕', 'private'] },
  { id: 'open_incognito_tab', title: '新建隐身标签页', keywords: ['incognito tab', '隐身标签页', '无痕标签页'] },
  { id: 'capture_page', title: '截图并标注（整页）', keywords: ['screenshot', '截图', '截屏', 'capture', '标注'] },
  { id: 'open_capture_hub', title: '收集此页…', keywords: ['collect', 'collect page', '收集', '收集此页', '稍后读', '摘录'] },
  { id: 'archive_current', title: '归档此页到本地', keywords: ['archive', 'offline', '归档', '离线保存', '网页快照'] },
  // ── 浏览器操作（导航类）：执行侧是 `TabManager#omniboxAction` 的 switch 分支 ──
  // 它们既是 `!back` 这类**快捷 bang**，也是普普通通的命令候选（输入「后退」也能搜到）——
  // 一份表两用，不再为"地址栏快捷"另建一张表。
  { id: 'go_back', title: '后退', keywords: ['back', 'goback', '后退', '返回', '上一页'] },
  { id: 'go_forward', title: '前进', keywords: ['forward', 'goforward', '前进', '下一页'] },
  { id: 'reload_page', title: '重新加载', keywords: ['reload', 'refresh', '刷新', '重新加载'] },
  { id: 'focus_address_bar', title: '聚焦地址栏', keywords: ['focus address', 'address bar', '地址栏', '搜索栏', 'omnibox'] },
  // ── 集锦（WP1）：无内部页，执行侧走 `note:` 前缀 → TabManager 转交宿主 onNoteAction ──
  // 真正的实现在 `main/note-actions.js`（与快捷键 / 菜单 / 命令链 / 插件**同一份**）。
  // 关键词刻意避开裸「集锦」：面板条目本身已能被 `!集锦` 搜到，这里补的是**动作**。
  { id: 'note:save-page', title: '添加此页到集锦', keywords: ['collection this page', '添加此页到集锦', '收藏此页到集锦', 'save to collection'] },
  { id: 'note:save-tab', title: '添加此标签到集锦', keywords: ['save tab to collection', '添加标签到集锦'] },
  { id: 'note:save-text', title: '把选中文字收进集锦', keywords: ['save selection', '选中文字', '收进集锦', '剪藏'] },
  { id: 'note:add-note', title: '新建集锦笔记', keywords: ['new note', '新建笔记', '集锦笔记'] },
  { id: 'note:open-panel', title: '打开集锦', keywords: ['collections', '集锦面板', '打开集锦', '笔记面板'] },
  { id: 'note:open-all', title: '打开集锦里的全部网页', keywords: ['open all', '全部打开', '打开集锦全部'] },
  { id: 'note:copy-all', title: '复制集锦内容', keywords: ['copy collection', '复制集锦', '复制全部'] },
  { id: 'note:export', title: '导出集锦…', keywords: ['export collection', '导出集锦', '导出笔记'] }
]

/** id → 命令（执行侧查 host 用）。 */
const BY_ID = new Map(COMMANDS.map((c) => [String(c.id), c]))

/**
 * 动作 id → 内部页完整地址（`hira://<host>?<query>`）；不是内部页命令时返回 `null`。
 * 执行侧（`TabManager#omniboxAction`）拿到即导航，**不再自己维护一张 host 映射表**，
 * 也不自己拼 `hira://` 前缀 —— 拼法唯一在 `pages.mjs#pageUrl`。
 *
 * 为什么返回完整地址（带 query）而不是只返回 host：有的命令要落到**同一页的另一个
 * 选项卡**（软件更新 = `about?tab=update`）。若只给 host，执行侧就得再塞一张
 * "哪个命令要带什么参数"的表 —— 那是第二处真源。
 * @param {string} action
 * @returns {string|null}
 */
export function commandUrl(action: string) : string|null {
  const c = BY_ID.get(String(action || ''))
  if (!c || !c.page) return null
  return pageUrl(c.page, c.query)
}

/**
 * 关键词模糊匹配命令（纯函数）。
 *
 * 三档打分与改造前逐字一致（实测手感调整过，别顺手改）：
 * 完全相同 = 700 > 前缀命中 = 650 > 子串/被包含 = 400。
 * 每条命令只取**最先命中的关键词**，命中即 break（同一条命令不重复出现）。
 *
 * @param {string} query
 * @param {number} [limit=3]
 * @returns {Array<{ id:string, title:string, relevance:number }>}
 */
export function matchCommands(query: string, limit: number = 3) : Array<{ id:string, title:string, relevance:number }> {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  /** @type {Array<{ id:string, title:string, relevance:number }>} */
  const out: Array<{ id:string, title:string, relevance:number }> = []
  for (const cmd of COMMANDS) {
    for (const kw of cmd.keywords) {
      const k = String(kw).toLowerCase()
      if (!(k.includes(q) || q.includes(k))) continue
      out.push({ id: cmd.id, title: cmd.title, relevance: k === q ? 700 : k.startsWith(q) ? 650 : 400 })
      break
    }
  }
  return out.sort((a, b) => b.relevance - a.relevance).slice(0, limit)
}

// ─────────────────────────────────────────────────────────────────────────────
// Bangs（DuckDuckGo 风格 `!xx 关键词`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内置 bang 表：短名与全名并列，同一个站可以有两个键。
 * @type {Record<string, { name:string, url:string }>}
 */
export const BANGS: Readonly<Record<string, { name: string; url: string }>> = {
  // ── 三大通用引擎：名称与模板引用 `search-engines.mjs`（不在这里再抄 URL）──
  g: { name: SEARCH_ENGINES.google.label, url: SEARCH_ENGINES.google.template },
  google: { name: SEARCH_ENGINES.google.label, url: SEARCH_ENGINES.google.template },
  yt: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=' },
  gh: { name: 'GitHub', url: 'https://github.com/search?q=' },
  github: { name: 'GitHub', url: 'https://github.com/search?q=' },
  so: { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=' },
  stackoverflow: { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=' },
  mdn: { name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q=' },
  npm: { name: 'npm', url: 'https://www.npmjs.com/search?q=' },
  tw: { name: 'Twitter', url: 'https://twitter.com/search?q=' },
  twitter: { name: 'Twitter', url: 'https://twitter.com/search?q=' },
  r: { name: 'Reddit', url: 'https://www.reddit.com/search/?q=' },
  reddit: { name: 'Reddit', url: 'https://www.reddit.com/search/?q=' },
  w: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=' },
  wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=' },
  bing: { name: SEARCH_ENGINES.bing.label, url: SEARCH_ENGINES.bing.template },
  bd: { name: SEARCH_ENGINES.baidu.label, url: SEARCH_ENGINES.baidu.template },
  ddg: { name: SEARCH_ENGINES.duckduckgo.label, url: SEARCH_ENGINES.duckduckgo.template },
  duckduckgo: { name: SEARCH_ENGINES.duckduckgo.label, url: SEARCH_ENGINES.duckduckgo.template },
  map: { name: 'Google Maps', url: 'https://www.google.com/maps/search/' },
  maps: { name: 'Google Maps', url: 'https://www.google.com/maps/search/' },
  am: { name: 'Amazon', url: 'https://www.amazon.com/s?k=' },
  amazon: { name: 'Amazon', url: 'https://www.amazon.com/s?k=' },
  imdb: { name: 'IMDb', url: 'https://www.imdb.com/find?q=' },
  wa: { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/input?i=' },
  wolfram: { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/input?i=' },
  pinterest: { name: 'Pinterest', url: 'https://www.pinterest.com/search/pins/?q=' },
  p: { name: 'Pinterest', url: 'https://www.pinterest.com/search/pins/?q=' },
  // ── 中文站点（对齐 Hira / RT 的口径：中文用户最常用的几个）──
  bl: { name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword=' },
  bilibili: { name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword=' },
  zh: { name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=' },
  zhihu: { name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=' },
  wb: { name: '微博', url: 'https://s.weibo.com/weibo?q=' },
  weibo: { name: '微博', url: 'https://s.weibo.com/weibo?q=' },
  tb: { name: '淘宝', url: 'https://s.taobao.com/search?q=' },
  taobao: { name: '淘宝', url: 'https://s.taobao.com/search?q=' },
  jd: { name: '京东', url: 'https://search.jd.com/Search?keyword=' },
  dy: { name: '抖音', url: 'https://www.douyin.com/search/' },
  xhs: { name: '小红书', url: 'https://www.xiaohongshu.com/search_result?keyword=' },
  douban: { name: '豆瓣', url: 'https://www.douban.com/search?q=' },
  csdn: { name: 'CSDN', url: 'https://so.csdn.net/so/search?q=' },
  juejin: { name: '掘金', url: 'https://juejin.cn/search?query=' },
  gitee: { name: 'Gitee', url: 'https://search.gitee.com/?q=' },
  yd: { name: '有道词典', url: 'https://dict.youdao.com/search?q=' },
  // ── 开发者 / 通用站点（补齐常用的一批）──
  npmjs: { name: 'npm', url: 'https://www.npmjs.com/search?q=' },
  dc: { name: 'Docker Hub', url: 'https://hub.docker.com/search?q=' },
  pypi: { name: 'PyPI', url: 'https://pypi.org/search/?q=' },
  crates: { name: 'crates.io', url: 'https://crates.io/search?q=' },
  ms: { name: 'Microsoft Learn', url: 'https://learn.microsoft.com/search/?q=' },
  gs: { name: 'Google 学术', url: 'https://scholar.google.com/scholar?q=' },
  tr: { name: 'Google 翻译', url: 'https://translate.google.com/?sl=auto&tl=zh-CN&text={query}&op=translate' },
  steam: { name: 'Steam', url: 'https://store.steampowered.com/search/?term=' },
  twitch: { name: 'Twitch', url: 'https://www.twitch.tv/search?term=' },
  netflix: { name: 'Netflix', url: 'https://www.netflix.com/search?q=' },
  spotify: { name: 'Spotify', url: 'https://open.spotify.com/search/' },
  fb: { name: 'Facebook', url: 'https://www.facebook.com/search/top?q=' },
  li: { name: 'LinkedIn', url: 'https://www.linkedin.com/search/results/all/?keywords=' }
}

/**
 * 内置 bang 表的**列表形态**（`{ t, title, url }`）—— 给主进程 `search:bangs` 出口用，
 * 与上面的映射同源，不再各维护一份（此前是 UI 30 条 / 主进程 10 条两张不一致的表）。
 * 同一站点有多个键时只保留**第一个**（短名优先，正是字典序里的第一条）。
 * @returns {Array<{ t:string, title:string, url:string }>}
 */
export function listBangs(): Array<{ t: string; title: string; url: string }> {
  const seen = new Set<string>()
  const out: Array<{ t: string; title: string; url: string }> = []
  for (const [t, v] of Object.entries(BANGS)) {
    if (seen.has(v.name)) continue
    seen.add(v.name)
    out.push({ t, title: v.name, url: v.url })
  }
  return out
}

/**
 * 按**站点**聚合的 bang 条目（同站多个键合并成一个条目，`keys` 短名在前）。
 *
 * 与 `listBangs()` 的差别：那个给主进程 `search:bangs` 出口用（一站点一条、短名优先），
 * 「丢掉的别名」正好是这里要留的东西 —— 地址栏输 `!bil` 也该认出哔哩哔哩（别名 `bilibili`），
 * 只留短名 `bl` 就认不出。两处各自留一份必然漂移，故共用同一张 `BANGS`。
 *
 * @returns {Array<{ keys:string[], title:string, url:string }>}
 */
export function allBangEntries(): Array<{ keys: string[]; title: string; url: string }> {
  /** @type {Map<string, { keys: string[], title: string, url: string }>} */
  const byName: Map<string, { keys: string[], title: string, url: string }> = new Map<string, { keys: string[]; title: string; url: string }>()
  for (const [k, v] of Object.entries(BANGS)) {
    let entry = byName.get(v.name)
    if (!entry) {
      entry = { keys: [], title: v.name, url: v.url }
      byName.set(v.name, entry)
    }
    entry.keys.push(k)
  }
  for (const entry of byName.values()) {
    // 短名在前（`bl` 先于 `bilibili`）—— 「显示所有 bangs」时的代表键就用 keys[0]。
    entry.keys.sort((a, b) => a.length - b.length || a.localeCompare(b))
  }
  return [...byName.values()]
}

/**
 * 按片段筛选 bang 条目（`!` 后面的那一段）。
 *
 * 判据（宽进，两档都算命中）：
 *   · 任一别名以片段为前缀（`!bil` → `bilibili` 前缀命中）；
 *   · 站点展示名包含片段（`!哔` → 哔哩哔哩）—— 中文用户直接打站名也认。
 * 片段为空 = 列出**全部**（正是「只输入 `!` 就显示所有 bangs」要求的那条路）。
 *
 * @param {string} fragment
 * @param {number} [limit]
 * @returns {Array<{ keys:string[], t:string, title:string, url:string }>}
 */
export function matchBangs(fragment: string, limit: number = 12): Array<{ keys: string[]; t: string; title: string; url: string }> {
  const f = String(fragment || '').trim().toLowerCase()
  const out: Array<{ keys: string[]; t: string; title: string; url: string }> = []
  for (const entry of allBangEntries()) {
    if (f) {
      const hit = entry.keys.find((k) => k.startsWith(f))
      if (!hit && !entry.title.toLowerCase().includes(f)) continue
      out.push({ keys: entry.keys, t: hit || entry.keys[0], title: entry.title, url: entry.url })
    } else {
      out.push({ keys: entry.keys, t: entry.keys[0], title: entry.title, url: entry.url })
    }
    if (out.length >= limit) break
  }
  return out
}

/**
 * 引擎名归一：小写 + 去掉空白 —— 于是 `!my engine`、`!MyEngine` 都能命中名为 "My Engine" 的引擎。
 * @param {string} name
 */
function normalizeEngineName(name: string) {
  return String(name || '').toLowerCase().replace(/\s+/g, '')
}

/**
 * 按片段筛选**自定义** bang 条目（用户数据，来自 domain-search）。
 *
 * 与 `matchBangs` 同口径：触发词前缀命中，或展示名包含片段；片段为空 = 全部。
 * 额外两条自定义规则：
 *   · `showSuggestions === false` 的条目**不进下拉**（用户只想让回车直搜生效）；
 *   · 命中项按使用次数降序 —— 用户常用的 `!xxx` 应该先露头。
 *
 * @param {string} fragment
 * @param {Array<{ id?:string, trigger:string, title?:string, url:string, showSuggestions?:boolean, hitCount?:number }>} customBangs
 * @param {number} [limit]
 * @returns {Array<{ keys:string[], t:string, title:string, url:string, id?:string, custom:true }>}
 */
export function matchCustomBangs(fragment: string, customBangs: Array<{ id?:string, trigger:string, title?:string, url:string, showSuggestions?:boolean, hitCount?:number }>, limit: number = 12) : Array<{ keys:string[], t:string, title:string, url:string, id?:string, custom:true }> {
  const f = String(fragment || '').trim().toLowerCase()
  const list = Array.isArray(customBangs) ? customBangs : []
  /** @type {Array<{ keys:string[], t:string, title:string, url:string, id?:string, custom:true, hitCount:number }>} */
  const out: Array<{ keys:string[], t:string, title:string, url:string, id?:string, custom:true, hitCount:number }> = []
  for (const entry of list) {
    if (!entry || entry.showSuggestions === false) continue
    const trigger = normalizeEngineName(entry.trigger)
    if (!trigger) continue
    const title = String(entry.title || trigger)
    if (f && !trigger.startsWith(f) && !title.toLowerCase().includes(f)) continue
    out.push({
      keys: [trigger],
      t: trigger,
      title,
      url: entry.url,
      id: entry.id,
      custom: true,
      hitCount: Number(entry.hitCount) || 0
    })
  }
  out.sort((a, b) => b.hitCount - a.hitCount || a.t.localeCompare(b.t))
  return out.slice(0, limit)
}

/**
 * 解析一个 bang 片段：先查**内置 bang 表**，再查**内置引擎表**，最后查**自定义 bang**
 *（优先级最高的语义最稳定：内置 > 内置引擎 > 自定义；自定义同名不会顶掉前两者）。
 * 自定义搜索引擎不参与解析 —— 引擎不是 bang，只服务「默认搜索引擎」下拉。
 * @param {string} bang 已归一为小写的 bang 片段
 * @param {Record<string,string>} [engines] 内置引擎表（名字 → 模板）
 * @param {Array<{ id?:string, trigger:string, title?:string, url:string }>} [customBangs]
 * @returns {{ name: string, template: string, custom?: boolean, id?: string }|null}
 */
export function resolveBangEngine(bang: string, engines: Record<string,string>, customBangs: Array<{ id?:string, trigger:string, title?:string, url:string }>) : { name: string, template: string, custom?: boolean, id?: string }|null {
  const builtin = BANGS[bang]
  if (builtin) return { name: builtin.name, template: builtin.url }
  const wanted = normalizeEngineName(bang)
  if (!wanted) return null
  if (engines && typeof engines === 'object') {
    for (const [name, template] of Object.entries(engines)) {
      if (typeof template !== 'string' || !template) continue
      if (normalizeEngineName(name) === wanted) return { name, template }
    }
  }
  if (Array.isArray(customBangs)) {
    for (const entry of customBangs) {
      if (!entry || typeof entry.url !== 'string' || !entry.url) continue
      if (normalizeEngineName(entry.trigger) !== wanted) continue
      return {
        name: String(entry.title || entry.trigger),
        template: entry.url,
        custom: true,
        id: entry.id
      }
    }
  }
  return null
}

/**
 * 解析 "!bang query" 输入，返回**结构化结果**（URL + 是否自定义 + 自定义条目 id）。
 * 地址栏需要 id 来记使用次数（F-0764），所以不能只返回字符串。
 *
 * @param {string} input
 * @param {Record<string,string>} [engines]
 * @param {Array<{ id?:string, trigger:string, title?:string, url:string }>} [customBangs]
 * @returns {{ url:string, name:string, trigger:string, custom:boolean, id:string }|null}
 */
export function parseBangQueryEntry(input: string, engines: Record<string,string>, customBangs: Array<{ id?:string, trigger:string, title?:string, url:string }>) : { url:string, name:string, trigger:string, custom:boolean, id:string }|null {
  const q = String(input || '').trim()
  if (!q.startsWith('!')) return null
  const parts = q.slice(1).split(/\s+/)
  const trigger = parts[0].toLowerCase()
  const engine = resolveBangEngine(trigger, engines, customBangs)
  if (!engine) return null
  return {
    url: buildSearchUrl(engine.template, parts.slice(1).join(' ')),
    name: engine.name,
    trigger,
    custom: !!engine.custom,
    id: engine.id || ''
  }
}

/**
 * 解析 "!bang query" 输入：返回对应搜索引擎 URL，未匹配返回 null。
 * 用于地址栏 Enter 的直接兜底（建议还没加载完时 `!gh x` 也要能用）。
 * @param {string} input
 * @param {Record<string,string>} [engines]
 * @param {Array<{ id?:string, trigger:string, title?:string, url:string }>} [customBangs]
 * @returns {string|null}
 */
export function parseBangQuery(input: string, engines: Record<string,string>, customBangs: Array<{ id?:string, trigger:string, title?:string, url:string }>) : string|null {
  const entry = parseBangQueryEntry(input, engines, customBangs)
  return entry ? entry.url : null
}
