/**
 * panel-entry.mjs —— `PanelEntry` 的**唯一形状真源**（跨进程纯函数）。
 *
 * 消费方：面板目录（apps/main）、rail / navbar / 按钮编辑浮层 / 面板渲染页（渲染层）。
 *
 * ── 面板只有一种种类 ────────────────────────────────────────────────
 * 面板 = 我们自己的**本地渲染页**（`out/renderer/panels/`），由插件 manifest 的
 * `contributes.panels` 贡献。曾经的 `kind:'web'`（远程网页当面板）已经**整体移除**：
 * 远程网页侧栏是一个**独立子系统**（不进目录、不占面板槽、有自己的存储与布局区域），
 * 见 `docs/web-sidebar-design.md`。于是这里不再有 `kind` / `web` 两个字段 ——
 * 「两种东西共用一种形状」正是当时把两个板块耦合在一起、最终无法维护的根源。
 *
 * 契约侧（zod）在 `infra/infra-ipc/src/contracts/layout.js#panelEntrySchema`，
 * **字段名必须与本文件逐字一致**（这是唯一一处"两处写同一形状"的例外：zod 要可序列化
 * 校验、本文件要纯函数回落，两者不可合并；改动时两边一起改）。
 *
 * 纯函数：零依赖、零 IO、不 require electron。
 */

/**
 * 归一化一条面板条目：缺省与非法全部回落，消费方不必再判 `undefined`。
 *
 * `opensWindow` / `opensPage` 是本文件里**两个**"这条目其实不是面板"的字段，见下。
 *   · `opensWindow` → 打开**独立子窗口**（如书签编辑器）
 *   · `opensPage`   → 在标签页里打开**内部页** `hira://<host>`（如插件中心）
 * 两者都是「声明式重定向」：条目的 id / 图标 / 可编辑按钮位照旧，只是"从外壳点进去"
 * 这条路被声明成去别处。于是"把某个面板搬去内部页"是 manifest 里一行的事，
 * 任何入口（rail / navbar / 命令面板）拿到的答案都一致。
 *
 * `bangs` —— 面板的**可搜索别名**（字符串数组）。面板标题会改（笔记 → 集锦），
 * 但用户的肌肉记忆与旧文档里是「笔记」—— 别名保证两边都能搜到。默认空数组
 * （没有别名 = 只按 id / 标题命中，与改造前一字不差）。
 *
 * `presentation` —— 面板**能在哪儿被看见**：
 *   · `'dock'`（默认）= 只能住侧栏（与改造前一字不差）
 *   · `'both'`       = 侧栏与独立窗口都行，宿主会渲染「弹出 / 停靠」切换按钮
 * 这是**面板自己的属性**（形状真源在这里），不是宿主写死的 id 白名单 ——
 * 于是"哪些面板可拆成窗口"由插件 manifest 一行声明，加面板不必改任何核心代码。
 * 单实例语义（同一 panelId 同时只住一处）由主进程 `PanelPresentationService` 保证。
 *
 * `hostPage` —— 这个面板**另有一份内部页形态**时的页面 host（如 AI 助手的 `'ai'`）。
 * 与 `opensPage` 是两件事：
 *   · `opensPage` = 入口**改道**，点它不开面板、只开页（插件中心是这一类）；
 *   · `hostPage`  = 面板照旧能开，只是**额外**提供一个「在页面中打开」按钮。
 * 于是"侧栏 ↔ 窗口 ↔ 页面"三种形态由 manifest 一行声明，宿主统一画按钮，面板零实现。
 *
 * @param {any} raw
 * @returns {{ id: string, title: string, icon: string, order: number, segment: string, pluginId: string|null, opensWindow: string|null, opensPage: string|null, hostPage: string|null, bangs: string[], presentation: 'dock'|'both' }}
 */
export interface PanelEntry {
  id: string
  title: string
  icon: string
  order: number
  segment: string
  pluginId: string | null
  opensWindow: string | null
  opensPage: string | null
  hostPage: string | null
  bangs: string[]
  presentation: 'dock' | 'both'
}

export function normalizePanelEntry(raw: unknown): PanelEntry {
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const order = Number(src.order)
  return {
    id: String(src.id == null ? '' : src.id),
    title: String(src.title == null || src.title === '' ? src.id : src.title),
    icon: String(src.icon == null ? '' : src.icon),
    order: Number.isFinite(order) ? order : 0,
    segment: String(src.segment == null || src.segment === '' ? 'panel' : src.segment),
    pluginId: src.pluginId ? String(src.pluginId) : null,
    opensWindow: src.opensWindow ? String(src.opensWindow) : null,
    opensPage: src.opensPage ? String(src.opensPage) : null,
    // 额外形态：同一块面板的内部页 host（开面板不受影响，只是多一颗「在页面中打开」）。
    hostPage: src.hostPage ? String(src.hostPage) : null,
    // 别名：只留非空字符串（脏数据不该让 bangs 搜出乱码候选）。缺省 = 空数组。
    bangs: Array.isArray(src.bangs) ? src.bangs.filter((b) => typeof b === 'string' && b !== '') : [],
    // 呈现形态：只认 'both'，其余（含脏值/缺省）一律 'dock' —— 不认识的值绝不放开新形态。
    presentation: src.presentation === 'both' ? 'both' : 'dock'
  }
}

/**
 * 这条目是**动作**还是**面板**？—— 是动作时返回要打开的子窗口类型，否则空串。
 *
 * 为什么要有这个字段：有些工具**天生不适合放进窄侧栏**（要横向空间、要在多个标签页
 * 之间对照着看）。它们仍然需要一个图标、一个可编辑的按钮位、一个稳定 id —— 也就是
 * 仍然是目录里的一条，但点下去该开的是**独立窗口**而不是侧栏面板。
 *
 * 判据放在这里（纯层、唯一形状真源）而不是各处点击处理器里：
 * 「这一条是动作」是**条目自己的属性**，rail / navbar / 以后的任何入口都该得到
 * 同一个答案。三个入口各写一遍 `id === 'xxx'` 是必然会漂移的写法。
 *
 * 注意它**不改变 id 的唯一性**：面板 id 仍然是面板 id（渲染页 `?panelId=` 照旧可用），
 * 只是"从外壳点进去"这条路被声明为重定向。这样"暂时收起侧栏形态、只留窗口形态"
 * 可以在 manifest 里一行完成，将来要放回来同样一行。
 *
 * @param {any} entry
 * @returns {string} 子窗口类型名（如 'add-bookmark'）；空串 = 普通面板
 */
export function panelEntryWindowType(entry: unknown) : string {
  const type = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).opensWindow : null
  return type ? String(type) : ''
}

/**
 * 这条目是不是「动作 → 打开内部页」？—— 是时返回内部页 host（如 'plugins'），否则空串。
 *
 * 与 `panelEntryWindowType` 完全对称：一个是开子窗口，一个是在标签页里开 `hira://<host>`。
 * 两者都必须在**纯层**判定，理由同 `panelEntryWindowType`：这是条目自己的属性，
 * 三个入口各写一遍 `id === 'plugins-panel'` 是必然会漂移的写法。
 *
 * host 的合法集合由 `pages.mjs#PAGE_DEFS` 定义（本文件不复制那张表）——
 * 传进来一个没登记的 host 时页面层会落到兜底，绝不静默打开一个空面板。
 *
 * @param {any} entry
 * @returns {string} 内部页 host（如 'plugins'）；空串 = 普通面板
 */
export function panelEntryPageHost(entry: unknown) : string {
  const host = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).opensPage : null
  return host ? String(host) : ''
}

/**
 * 这个面板**另有一份内部页形态**时返回页面 host（如 'ai'），否则空串。
 *
 * 与 `panelEntryPageHost` 的区别：那个是"入口改道到页面"，这个是"面板照旧能开，
 * 再多一颗在页面中打开的按钮"。宿主据此决定标题栏要不要画这颗按钮 ——
 * 面板作者不必自己写按钮（写一遍就会和别处漂移一次）。
 *
 * @param {any} entry
 * @returns {string} 内部页 host；空串 = 没有页面形态
 */
export function panelEntryHostPage(entry: unknown) : string {
  const host = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).hostPage : null
  return host ? String(host) : ''
}

/**
 * 批量归一化并丢掉**没有 id** 的废条目。
 * 目录 / 运行时条目都走这里 —— 于是"废条目"不可能出现在 rail 上。
 * @param {any} list
 */
export function normalizePanelEntries(list: unknown) {
  return (Array.isArray(list) ? list : [])
    .map(normalizePanelEntry)
    .filter((entry) => !!entry.id)
}
