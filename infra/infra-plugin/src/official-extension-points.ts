/**
 * 官方第一层扩展点注册表 —— PART7 §7.3 那张表，一字不改地落成代码。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么把它单独放一个文件、而且全是纯数据
 * ══════════════════════════════════════════════════════════════════════
 * 这张表是**官方与社区之间的公开契约**：谁能挂、挂在哪、挂了以后以什么语义被调用。
 * 它必须满足三条：
 *   1. 一眼看全 —— 全部插槽在同一个文件里，新增插槽就是加一行；
 *   2. 零逻辑 —— 只有 id/mode/description/owner，没有任何执行代码，
 *      阅读者不会在这里遇到"顺手做了点什么"的意外；
 *   3. 可被 APPS 补充契约 —— 参数/返回的 Zod schema 由 APPS 侧注入
 *      （见 `registerOfficialExtensionPoints` 的 schemas 入参），
 *      于是 infra-plugin 不必背 zod 依赖（PART3 §3.5 分层：packages/infra 不引业务校验库）。
 *
 * `mode` 的含义与调用签名见 extension-points.js 头部说明。
 * `owner` 是 PART7 表里的「所属插件」—— 表示**应该由谁去调用它**，
 * 而不是「谁实现了它」：官方插槽表是公共财产，任何插件都能往里挂实现。
 */

import type { ExtensionMode, ExtensionPointRegistry } from './extension-points'

export interface OfficialExtensionPoint {
  id: string
  mode: ExtensionMode
  description: string
  owner: string
  initialValue?: unknown
}

export interface OfficialExtensionSchema {
  paramsSchema?: unknown
  resultSchema?: unknown
}

export interface RegisterOfficialOptions {
  schemas?: Record<string, OfficialExtensionSchema>
  owner?: string
}

export const OFFICIAL_EXTENSION_POINTS = Object.freeze([
  // ── 标签栏（owner: tabbar-management F01）──────────────────────────
  { id: 'tabbar.item-renderer', mode: 'SINGLE', description: '单个标签的 DOM 渲染器', owner: 'tabbar-management' },
  { id: 'tabbar.context-menu-item', mode: 'MULTI', description: '标签右键菜单添加项', owner: 'tabbar-management' },
  { id: 'tabbar.drop-target', mode: 'MULTI', description: '标签拖放目标处理器', owner: 'tabbar-management' },
  { id: 'tabbar.tab-stack-renderer', mode: 'SINGLE', description: '标签栈渲染器', owner: 'tabbar-management' },

  // ── 书签（owner: bookmark-core F02）───────────────────────────────
  { id: 'bookmark.tree-renderer-item', mode: 'REDUCE', description: '书签树节点渲染（逐层包裹）', owner: 'bookmark-core' },
  { id: 'bookmark.context-menu', mode: 'MULTI', description: '书签右键菜单项', owner: 'bookmark-core' },
  { id: 'bookmark.import-format', mode: 'MULTI', description: '自定义导入格式解析器', owner: 'bookmark-core' },

  // ── 历史 / 下载 ──────────────────────────────────────────────────
  { id: 'history.search-filter', mode: 'REDUCE', description: '历史搜索过滤器（串行过滤结果集）', owner: 'history-core' },
  { id: 'history.context-menu', mode: 'MULTI', description: '历史条目右键菜单项', owner: 'history-core' },
  { id: 'download.state-badge-renderer', mode: 'SINGLE', description: '下载列表状态角标渲染器', owner: 'download-core' },
  { id: 'download.context-menu', mode: 'MULTI', description: '下载项右键菜单项', owner: 'download-core' },

  // ── 笔记 / 集锦（owner: notes-core）──────────────────────────────
  { id: 'note.context-menu', mode: 'MULTI', description: '卡片 / 集锦右键菜单项', owner: 'notes-core' },
  // 下面三个是**渲染侧**插槽：实现写在插件的 `.renderer.js`，由笔记面板直接调用
  // （DOM / 函数过不了 IPC，见 renderer/shared/plugin-slots.js 头部说明）。
  { id: 'note.card-renderer', mode: 'SINGLE', description: '卡片渲染器（返回元素则替换默认卡片主体）', owner: 'notes-core' },
  { id: 'note.capture-provider', mode: 'MULTI', description: '抓取源提供者（返回 { id, label, capture }）', owner: 'notes-core' },
  { id: 'note.export-format', mode: 'MULTI', description: '集锦导出格式提供者（返回 { id, label, extension, serialize(cards, name), encoding? }；encoding 为 base64 时表示二进制容器）', owner: 'notes-core' },

  // ── 其它列表型面板（右键菜单扩展面）────────────────────────────
  // 与 bookmark.context-menu 同形：宿主只上报 `context.kind`，主进程按白名单映射到这里。
  { id: 'easel.context-menu', mode: 'MULTI', description: '画板元素右键菜单项', owner: 'easel' },
  { id: 'archive.context-menu', mode: 'MULTI', description: '归档条目右键菜单项', owner: 'archive' },
  { id: 'open-tab.context-menu', mode: 'MULTI', description: '已开标签列表右键菜单项', owner: 'open-tabs' },
  { id: 'media.context-menu', mode: 'MULTI', description: '媒体条目右键菜单项', owner: 'media' },
  { id: 'session.context-menu', mode: 'MULTI', description: '会话 / 标签组右键菜单项', owner: 'session' },

  // ── 侧栏（owner: side-panel-skeleton P01）★ 面板体系的主插槽 ────────
  { id: 'side-panel.rail-icon-slot', mode: 'MULTI', description: '侧栏 rail 注册图标', owner: 'side-panel-skeleton' },
  { id: 'side-panel.panel-render-slot', mode: 'MULTI', description: '侧栏展开区注册面板', owner: 'side-panel-skeleton' },
  { id: 'side-panel.toolbar-action-slot', mode: 'MULTI', description: '面板顶部工具栏加按钮', owner: 'side-panel-skeleton' },
  { id: 'side-panel.panel-header-renderer', mode: 'REDUCE', description: '面板头部自定义渲染', owner: 'side-panel-skeleton' },

  // ── 快捷键 / 主题 / 本地化 ────────────────────────────────────────
  { id: 'shortcut.binding', mode: 'MULTI', description: '快捷键注册', owner: 'shortcut-engine' },
  /*
   * 网页翻译引擎（C3）：`(payload) => Promise<string[]>`。
   *   payload = { texts: string[], to: string }
   * 返回与 texts **等长、同序**的译文。没有插件实现时，宿主用内置的在线引擎兜底
   * （见 apps/app-main/src/main/translate.ts）——「离线模型」（如 bergamot）正是一条
   * 插件实现：装上它，页面内容就不出本机。
   */
  { id: 'translate.provider', mode: 'SINGLE', description: '网页翻译引擎提供者', owner: 'translate' },
  // 主题变量提供者：流水线初值必须是空串（而不是 payload），
  // 每个实现返回「要追加的一段 CSS」—— 所以这里显式声明 initialValue。
  { id: 'theme.token-provider', mode: 'REDUCE', description: '主题 CSS 变量提供者', owner: 'infra-theme', initialValue: '' },
  /*
   * 主题来源：每个**主题插件**（type: theme-plugin）贡献一条主题定义。
   * 主题目录 = 内置主题（代码里写死，见 theme-builtins.js）+ 本插槽的全部返回值。
   * 于是"装一个主题"与"装一个插件"是同一条链路（安装/启停/卸载/市场全部复用），
   * 而主题本身是纯数据 —— 社区主题作者不需要写任何代码。
   */
  { id: 'theme.source', mode: 'MULTI', description: '主题来源（贡献一个主题定义）', owner: 'infra-theme' },
  /*
   * 主题后处理：`(主题) => 主题`，逐级改写最终配色。
   * 与 theme.token-provider 的分工：本插槽改的是**主题数据**（降饱和、夜间压暗、
   * 色盲适配），后者改的是**最终 CSS 文本**（更细，能改任何变量甚至选择器）。
   * 不声明 initialValue → REDUCE 以传入的主题为初值（见 extension-points.js 的签名说明）。
   */
  { id: 'theme.decorator', mode: 'REDUCE', description: '主题令牌后处理（可整体改写配色）', owner: 'infra-theme' },
  { id: 'l10n.bundle-provider', mode: 'MULTI', description: '语言包提供者', owner: 'infra-l10n' },

  // ── 网页生命周期 / 页面右键菜单（owner: webview-core C8）───────────
  { id: 'webview.lifecycle.will-navigate', mode: 'REDUCE', description: '页面跳转前钩子（可改写 / 可取消）', owner: 'webview-core' },
  { id: 'webview.lifecycle.did-navigate', mode: 'EVENT', description: '页面跳转后钩子', owner: 'webview-core' },
  { id: 'webview.lifecycle.did-finish-load', mode: 'EVENT', description: '页面加载完成钩子', owner: 'webview-core' },
  { id: 'webview.context-menu.item', mode: 'MULTI', description: '页面右键菜单项', owner: 'webview-core' },

  // ── 搜索 / 地址栏 ────────────────────────────────────────────────
  { id: 'search.suggestion-provider', mode: 'REDUCE', description: '搜索建议提供者（结果合并排序）', owner: 'search-aggregator' },
  { id: 'search.local-provider', mode: 'MULTI', description: '统一本地搜索提供者（返回与地址栏建议同形的条目）', owner: 'search-aggregator' },
  /*
   * 动态 bang 提供者：`(payload) => bang[] | Promise<bang[]>`。
   *   payload = { query: string }
   *   bang    = { id?, trigger, title, url, showSuggestions? }
   * 与 manifest 的 `contributes.bangs`（静态声明）走同一条消费链：两者都并进
   * `search:config` 的 `pluginBangs`。静态够用时不要动这个插槽 —— 它只在
   * 「bang 列表要按查询/账号/网络实时算」时才需要。
   */
  { id: 'search.bang-provider', mode: 'MULTI', description: '动态 bang 提供者（返回 { trigger, title, url }）', owner: 'search-aggregator' },
  /*
   * 新标签页搜索框旁的**动作按钮**：`() => SearchAction[]`。
   *   SearchAction = { id, label, icon?, title?, template }
   *   template 里用 `{query}` 占位（如 `hira://ai?ask={query}`），宿主只做一次替换。
   *
   * 为什么要这个插槽：搜索框旁多一枚按钮，本质是"对**当前输入**再做一件事"，
   * 而这正是插件才能决定的事（AI 问一句 / 翻译一下 / 存进笔记…）。写死在新标签页里，
   * 每加一个能力就要改一次页面；声明成插槽后，页面**只渲染宿主收到的动作清单**，
   * 不认识 AI、也不认识任何具体动作 —— 插件停用，按钮跟着消失。
   */
  { id: 'newtab.search-action', mode: 'MULTI', description: '新标签页搜索框旁的动作按钮（返回 { id, label, icon, template }）', owner: 'newtab' },
  { id: 'omnibar.input-transformer', mode: 'REDUCE', description: '地址栏输入文字转换器', owner: 'omnibar-logic' },
  { id: 'omnibar.result-item-renderer', mode: 'SINGLE', description: '地址栏结果项渲染器', owner: 'omnibar-logic' },

  // ── 菜单（owner: menu-shell）──────────────────────────────────────
  /*
   * 主菜单项：`(payload) => menuItem[]`。
   *   payload = { state }（当前菜单状态快照，见 app-menu.js#getState）
   *   menuItem = { label, where, action, order?, enabled?, accelerator?, type?, submenu?, when? }
   * 与 manifest 的 `contributes.menus` 同形、同一条合并链（见 main/plugin-surfaces.js）。
   * `where` 支持 `app.file|app.edit|app.view|app.tabs|app.history|app.bookmarks|app.tools|app.help|app.root`
   * 以及各列表的 `*.context`；也支持 `slot:<扩展点id>` 直连任意 MULTI 插槽。
   */
  { id: 'app-menu.item', mode: 'MULTI', description: '主菜单项（返回 { label, where, action }）', owner: 'menu-shell' },
  /*
   * 通用右键菜单项：`(payload) => menuItem[]`。
   * 与 `webview.context-menu.item` 的区别：后者只服务网页区域，本插槽服务**所有**宿主
   * （标签、书签、历史、下载、笔记…）。宿主仍按 `MENU_SLOT_BY_KIND` 调各自的专用插槽，
   * 本插槽在合并阶段额外追加一次 —— 于是「加一条到处都有的菜单项」不必逐插槽实现。
   */
  { id: 'context-menu.item', mode: 'MULTI', description: '通用右键菜单项（返回 { label, action }）', owner: 'menu-shell' },

  // ── 数据 / 布局 ──────────────────────────────────────────────────
  { id: 'db.schema.migration', mode: 'MULTI', description: '自定义表迁移', owner: 'infra-db' },
  { id: 'layout.root-slot', mode: 'MULTI', description: '主窗口布局根插槽', owner: 'layout-core' },

  // ── 开放世界·外壳自定义（PART18）──────────────────────────────────
  // 下面这一组是"任何功能死角都能改"的落点：工具栏按钮、标签动作、浮层、
  // 面板覆盖、内部页补丁、浏览器指令。全部由 APPS 侧的 plugin-surfaces 消费，
  // infra 只负责声明契约（零逻辑）。
  //
  //   navbar.button-slot  → { id, label, icon?, order?, tooltip?, onSelect(ctx) }
  //   tab.action-slot     → { id, label, icon?, order?, tooltip?, onSelect(ctx) }
  //   overlay.slot        → { id, title?, page, anchor?, width?, height?, modal?, resizable?, order? }
  //     **纯数据描述符**（page 指向插件内部页 URL）。渲染侧拿它开一个 iframe 浮层，
  //     不给 render(host) 这类函数 —— 函数过不了 IPC，且浮层内容本来就该是插件自己的页面。
  //   panel.override      → { id?, hide?, title?, icon?, order?, segment?, navbar?, rail? }
  //   page.patch          → { match: string|RegExp, css?, js?, runAt? }
  //   browser.command     → { id, label, run(ctx) }（可被菜单 / 快捷键 / AI / 自动化调用）
  { id: 'navbar.button-slot', mode: 'MULTI', description: '导航栏 / 工具栏插件按钮（返回 { id, label, onSelect }）', owner: 'ui-shell' },
  { id: 'tab.action-slot', mode: 'MULTI', description: '标签动作按钮（返回 { id, label, onSelect }）', owner: 'tabbar-management' },
  { id: 'overlay.slot', mode: 'MULTI', description: '自定义浮层宿主（纯数据描述符 { id, title, page, anchor, width, height, modal }）', owner: 'layout-core' },
  // 面板覆盖：`(panel) => panel|null`。返回 null = 删除该面板（做减法）；
  // 返回改写后的对象 = 改标题 / 图标 / 排序 / 分段 / 是否出现在 navbar、rail。
  // 走 REDUCE（逐级改写），初值 = 归一化后的面板条目。
  { id: 'panel.override', mode: 'REDUCE', description: '改写或删除任意面板条目（做加法 / 做减法）', owner: 'panel-catalog' },
  /*
   * 面板数据面：`() => { panelIds: string[], kind?: string, read(args, ctx) }` 或数组。
   *
   * 面板分两种：一种的数据本就躺在主进程（书签 / 笔记 / 历史 / 下载…），另一种是纯视图
   * （画板、文件树、二维码扫描器）数据只在渲染进程。后者对 AI 是黑箱 —— 本插槽就是
   * 让插件把**自己那份面板数据**补上来，统一经 `panel_read` / `panel_list` 消费。
   * 内置 provider 见 apps/app-main/src/main/panel-data.js；插件声明优先于内置。
   */
  { id: 'panel.data.provider', mode: 'MULTI', description: '面板数据提供者（把面板的数据面暴露给 AI / 其它消费者）', owner: 'panel-data' },
  // 内部页补丁：`{ match, css?, js?, runAt? }`，与用户脚本同一条注入管线。
  { id: 'page.patch', mode: 'MULTI', description: '内部页 / 网页后置补丁（CSS / JS 注入）', owner: 'webview-core' },
  // 插件命令：可被菜单 command 动作、快捷键、AI 工具、自动化脚本统一调用。
  { id: 'browser.command', mode: 'MULTI', description: '可被菜单 / 快捷键 / AI / 自动化调用的浏览器指令', owner: 'harness-core' },
  { id: 'workspace.rule-trigger', mode: 'MULTI', description: '工作区规则触发器（返回 { id, label, resolve(event) }）', owner: 'automation' },
  { id: 'download.rule-action', mode: 'MULTI', description: '下载规则后置动作（返回 { id, label, run(download) }）', owner: 'download-core' },
  { id: 'page.archive-provider', mode: 'MULTI', description: '页面归档提供者（返回 { id, label, capture(context) }）', owner: 'page-library' },
  /*
   * AI 桥接（PART18）：主进程本身没有 AI 引擎，插件的 `browser.ai.*` 门面必须
   * 落到「谁实现了 AI 谁提供服务」上，而不是在主进程里另造一套模型客户端。
   *
   *   ai.invoke (SINGLE)  `(payload) => Promise<{ text, meta? }>`
   *     payload = { prompt, system?, model?, sessionId?, tools?, context? }
   *     由 AI 引擎插件（如 ai-engine）实现；没有实现时门面抛 `EP_AI_UNAVAILABLE`。
   *   ai.tool.provider (MULTI) `() => AiToolDefinition | AiToolDefinition[]`
   *     AiToolDefinition = { name, description, parameters, risk?, scope?, execute(args, ctx) }
   *     插件把自己的浏览器能力（标签 / 面板 / 自动化）注册成 AI 可调用工具。
   *     **只有这一个工具扩展点**：注册与消费都在 `ai.tool.provider`
   *     （消费方见 plugins/ai/core/tools.cjs），不要再造第二个同名入口。
   */
  { id: 'ai.invoke', mode: 'SINGLE', description: 'AI 推理入口（由 AI 引擎插件实现）', owner: 'ai-engine' },

  // ── 空间切换（owner: profile-core F05）───────────────────────────
  { id: 'profile.on-before-switch', mode: 'REDUCE', description: '空间切换前（可拦截）', owner: 'profile-core' },
  { id: 'profile.on-after-switch', mode: 'EVENT', description: '空间切换后钩子', owner: 'profile-core' },

  // ── 设置界面 ─────────────────────────────────────────────────────
  // 分区描述符：{ id, label, group?, icon?, blurb?, entry?, fields }。
  // group 只接受 shared-types/src/settings-groups.mjs 里的 id（见 SETTINGS_GROUP_ORDER），
  // 未知值会被归入「其他」并打警告 —— 不要自己造新组名。
  { id: 'settings.section-renderer', mode: 'MULTI', description: '设置窗口 section 注册（group 取共享分组表 id）', owner: 'settings-ui' },
  { id: 'settings.custom-widget', mode: 'MULTI', description: '设置自定义控件', owner: 'settings-ui' },

  // ── AI 助手（owner: ai-engine，PART15 §5）──────────────────────────
  // 全部由 `ai-engine` 与其它插件**调用**，实现可来自任何插件。
  // 引擎不认识任何具体 provider / 工具 / 上下文源 —— 它只认识这组插槽。
  //   ai.provider.adapter   (input: { protocol }) → { createAdapter(provider) }
  //   ai.provider.catalog   → { providerId, models:[...] }（连接测试 / 模型探测）
  //   ai.context.provider   (input: { item }) → snapshot（页面 / 选区 / 收藏 …）
  //   ai.tool.provider      → AiToolDefinition（name/description/parameters/risk/scope/execute）
  //   ai.system-prompt.section → string（拼到系统提示词末尾的一段）
  //   ai.message.renderer   → (block, ctx) => Node|null（替换默认消息块渲染）
  //   ai.chat.node          → (node, ctx) => Node|null（消息流之外的卡片：审批 / 错误 / 工具）
  //   ai.skill.kind         → { kind, label, icon, tone?, run(ctx) }
  //     `run(ctx)` 的 ctx = { skill, args, getTabManager, logger }，可返回字符串或
  //     { text, title?, autoSend? }；`run` 只活在主进程（不进 IPC），tone 取 accent/success/muted。
  //   ai.usage.observer     (EVENT: { sessionId, model, usage }) → void
  //   ai.turn.stopping      (EVENT: { sessionId, reason }) → void
  //   ai.tool.pre-execute   (REDUCE: (call, next) => decision) 可拦截 / 改写 / 拒绝
  //   ai.engine.runtime     (SINGLE) → 受限引擎端口；只给第一方能力插件提供
  //   ai.background-browser (SINGLE) → 后台浏览器服务；CLI / 研究等能力插件共用一个实例
  //   settings.ai-card      → { id, label, order?, render(root, ctx) }（设置页 AI 子页的卡片）
  //
  // 为什么 `ai.tool.pre-execute` 是 REDUCE 而不是 EVENT：审批与策略拦截需要**返回裁决**
  // （allow / deny / rewrite），EVENT 无返回值；这与 `webview.lifecycle.will-navigate` 同形。
  { id: 'ai.provider.adapter', mode: 'SINGLE', description: 'AI 协议适配器（按 protocol 创建）', owner: 'ai-engine' },
  { id: 'ai.provider.catalog', mode: 'MULTI', description: 'AI 模型目录 / 连接探测', owner: 'ai-engine' },
  { id: 'ai.context.provider', mode: 'MULTI', description: 'AI 上下文源（页面 / 选区 / 收藏 …）', owner: 'ai-engine' },
  { id: 'ai.tool.provider', mode: 'MULTI', description: 'AI 工具提供者', owner: 'ai-engine' },
  { id: 'ai.system-prompt.section', mode: 'MULTI', description: '系统提示词片段', owner: 'ai-engine' },
  { id: 'ai.message.renderer', mode: 'SINGLE', description: 'AI 消息块渲染器', owner: 'ai-engine' },
  { id: 'ai.chat.node', mode: 'MULTI', description: 'AI 消息流自定义节点（审批 / 工具 / 错误）', owner: 'ai-engine' },
  { id: 'ai.skill.kind', mode: 'MULTI', description: 'AI 技能类型', owner: 'ai-engine' },
  { id: 'ai.usage.observer', mode: 'EVENT', description: 'AI 用量观察者', owner: 'ai-engine' },
  { id: 'ai.turn.stopping', mode: 'EVENT', description: 'AI 回合中止钩子', owner: 'ai-engine' },
  { id: 'ai.engine.runtime', mode: 'SINGLE', description: 'AI 引擎受限运行时端口', owner: 'ai-engine' },
  { id: 'ai.background-browser', mode: 'SINGLE', description: '共享登录态的后台浏览器服务', owner: 'ai-agent-browser' },
  // 必须带初值 `null`：REDUCE 的首个实现拿到的初值若不是 null，
  // 裁决链的语义就变成"默认放行/默认拒绝"由初值决定 —— 那是隐式规则。显式给 null，
  // 无实现时调用方按"未裁决 = 放行"处理（见 plugins/ai/main/turn-runner.cjs）。
  { id: 'ai.tool.pre-execute', mode: 'REDUCE', description: 'AI 工具执行前拦截（返回裁决）', owner: 'ai-engine', initialValue: null },
  { id: 'settings.ai-card', mode: 'MULTI', description: '设置页 AI 子页卡片', owner: 'ai-engine' }
] as const satisfies readonly OfficialExtensionPoint[])

/**
 * 把官方插槽表灌进调度器。
 *
 * @param {ExtensionPointRegistry} registry
 * @param {{ schemas?: Record<string, { paramsSchema?: object, resultSchema?: object }>, owner?: string }} [options]
 *   `schemas` 由 APPS 侧注入（那里才有 zod）—— 键为扩展点 id。
 *   同一个 id 若已在别处声明过同模式，`define` 会返回既有 spec（不覆盖），
 *   因此这里重复调用是幂等的。
 * @returns {number} 实际声明的插槽数
 */
export function registerOfficialExtensionPoints (registry: ExtensionPointRegistry, options: RegisterOfficialOptions = {}): number {
  const schemas = options.schemas || {}
  const owner = options.owner ? String(options.owner) : 'com.hira.official.harness-core'
  let count = 0
  for (const spec of OFFICIAL_EXTENSION_POINTS) {
    const extra = schemas[spec.id] || {}
    registry.define(
      {
        id: spec.id,
        mode: spec.mode,
        description: spec.description,
        owner: `${spec.owner} (${owner})`,
        paramsSchema: extra.paramsSchema || null,
        resultSchema: extra.resultSchema || null,
        ...('initialValue' in spec ? { initialValue: spec.initialValue } : {})
      },
      { pluginId: owner }
    )
    count += 1
  }
  return count
}
