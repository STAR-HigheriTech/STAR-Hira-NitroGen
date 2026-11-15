/**
 * 集锦内容视图 —— 内部装配模块（**不是**插件 renderer）。
 *
 * 文件名刻意不用 `*.renderer.js`：`plugin-renderer.js` 只 glob 那个后缀，
 * 本文件是「集锦面板」renderer 的私有依赖，不应被当成独立面板模块加载。
 *
 * 本文件只做「装配 + 样式」两件事，三块实现各自独立：
 *   · `panel-notes.model.js`    状态与数据来源（IPC 客户端的语义化封装）
 *   · `panel-notes.view.js`     DOM 渲染与用户意图转译
 *   · `panel-notes.markdown.js` Markdown → HTML（纯函数）
 *
 * 数据由 `ctx.clients.notes`（APPS 层端口）提供，最终落到 domain-notes →
 * infra-db 的 `notes` / `note_folders` / `note_refs` 表 —— 面板自己不再碰 localStorage，
 * 因此笔记随 profile 隔离、可被备份、与其余九个域同一套存储纪律。
 *
 * 消费方：`panel-notes.renderer.js`（集锦面板的 renderer：装配 + open-view 投递 + 生命周期收口）。
 * 对外两个导出：`injectNotesPanelStyles`（样式）与 `createNotesPanelContent`（内容实例）。
 */

import { injectPanelStyles } from '@hira-ng/ui-common'
import type { PanelContext } from '@hira-ng/ui-common'
import { createArchiveView, injectArchiveViewStyles } from '@hira-ng/ui-panel-opentabs'
// 预览区高度是**共享真源**（与主进程的口径同一份）——面板只消费，不自己再写一个 96。
import { NOTES_PREVIEW_HEIGHT } from '@hira-ng/shared-types/src/notes.mjs'
import { createNotesModel, type NotesPanelClient } from './panel-notes.model.js'
import { createNotesView } from './panel-notes.view.js'

const STYLE_ID = 'hira-panel-notes-styles'

type NotesViewPorts = NonNullable<Parameters<typeof createNotesView>[0]['ports']>

export interface NotesPanelContentContext {
  clients: {
    notes: NotesPanelClient
    tabs?: { newTab?: (arg: { url?: string }) => unknown } | null
    settings?: {
      get(key: string): Promise<unknown>
      set(key: string, value: unknown): unknown
    } | null
  }
  menu?: NotesViewPorts['menu']
  confirm?: NotesViewPorts['confirm']
  slots?: NotesViewPorts['slots']
  bridge?: { provider: { invoke(route: string, payload?: unknown): Promise<unknown> } }
  events?: Record<string, string>
  on?: (route: string, handler: (payload: unknown) => void) => (() => void) | void
}

export interface NotesPanelContent {
  element: HTMLElement
  setSection(section: string): void
  setQuery(query: string): void
  focusSearch(): boolean
  refresh(): Promise<unknown>
  applyOpenView(payload: unknown): void
  dispose(): void
}

export function injectNotesPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* ══════════════════════════════════════════════════════════════════
       密度 token —— **唯一收口**。以后调密度（字号 / 行距 / 预览区高 / 卡片内边距）只改这一段。
       面板窄，这些值必须集中，否则同一个数值会散落在十几条规则里各写一遍，改一处漏三处。
       本次口径（现代 Web3 桌面端 · 无框）：卡片内边距 10/12、段间距 8、卡片间距 8、
      圆角一律引用 --hira-radius-*（10）、卡片最小高 48、标题 13px/600/行高 1.4、次级文字 11px、
      注释便签 5px 9px、预览区高 96px（窄档压矮 / 宽档加高，见文件末尾容器查询）、缩进 16px、
      控件高度统一 --hira-control-height（30）、行高统一 --hira-row-height（36）。
      内距一律走"正常档"：规则里不再另加一次性大数，空气由令牌统一给。
       **项间分割 = 一条隐约的短分割线**（卡与集锦项都不铺底色、不描边）：从内容左缘起、
       右侧留白收住，落在两项之间空隙的正中 —— 既分得开，又不会被切成"一根根横条"。
       卡片**内部**不画任何装饰性描边 / 胶囊 999px。
       （缩略图尺寸已随卡片三段式改版移除：图片/网页缩略图现在住在"预览区"，尺寸由
        --notes-preview-h 与容器宽度决定，不再是一个固定方形。）
       ══════════════════════════════════════════════════════════════════ */
    .notes-panel {
      --notes-fs-title: 13px;
      --notes-fs-meta: 11px;
      /* 卡片文字内边距 —— **"字不贴边"的唯一边距来源**（无预览时全靠它把文字垫开） */
      --notes-card-pad-y: 10px;
      --notes-card-pad-x: 12px;
      /* 段间距：预览区↔正文↔注释便签，三者之间一律 8px（卡片 flex gap） */
      --notes-seg-gap: 8px;
      --notes-row-gap: 8px;         /* 项与项之间：留白由分割线（+ 规则）承担 */
      /* 卡片圆角与面板原子层同一档 —— 这里只引用令牌，不再自带一套 8/10/7。 */
      --notes-radius: var(--hira-radius-md, 10px);
      --notes-card-min-h: 48px;     /* 无预览时也像"一张卡"而不是"一条线" */
      --notes-title-lh: 1.4;        /* 标题行高：一眼扫得到 */
      --notes-meta-gap: 4px;        /* 两行元信息之间 */
      --notes-note-pad: 5px 9px;    /* 注释便签内边距 */
      /* 图片预览的中性底：图片未加载 / 半透明 PNG 露底时，深浅两套主题下都不与文字打架 */
      --notes-preview-bg: var(--hira-surface-soft, rgba(0,0,0,0.04));
      --notes-preview-h: ${NOTES_PREVIEW_HEIGHT}px;
      --notes-indent: 16px;
      --notes-hit: var(--hira-control-height, 30px);
      display: flex; flex-direction: column; height: 100%; position: relative;
      /* 容器查询而不是 @media：面板宽度与窗口宽度无关（侧栏可 200~600px 任意拖），
         @media 在这里从根上量不准。三档见文件末尾。 */
      container-type: inline-size;
    }

    /* ── 工具栏（无描边：横向内边距归 0，交给面板外壳统一给）── */
    .notes-panel__toolbar {
      display: flex; flex-direction: column; align-items: stretch; gap: 8px;
      padding: 0 0 8px; flex-shrink: 0;
    }
    /* 第二行：搜索框独占一行（与历史 / 收藏 / 扩展面板同一口径）。 */
    .notes-panel__search {
      flex: 0 0 auto; min-width: 0;
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px);
      padding: 0 12px; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    /* 聚焦只加一圈发丝光环 —— 不再改描边色（避免"双层聚焦框"）。 */
    .notes-panel__search:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
    }
    .notes-panel__search-icon { display: flex; flex-shrink: 0; color: var(--hira-text-tertiary, #9ca3af); }
    .notes-panel__search-input {
      flex: 1; min-width: 0; padding: 0;
      border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; font-family: inherit;
    }
    .notes-panel__search-input::placeholder { color: var(--hira-text-tertiary, #9ca3af); }
    .notes-panel__actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .notes-panel__icon-btn {
      width: var(--notes-hit); height: var(--notes-hit); flex-shrink: 0; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: none; background: transparent; border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    /* 「正在搜索」轻指示：只呼吸搜索框，**不重画列表**（不白屏、不丢焦点）。 */
    .notes-panel__toolbar.is-searching .notes-panel__search {
      animation: notes-searching-pulse 0.9s ease-in-out infinite;
    }
    @keyframes notes-searching-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
      50% { box-shadow: 0 0 0 3px var(--hira-accent-soft, rgba(59,130,246,0.28)); }
    }
    .notes-panel__icon-btn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .notes-panel__icon-btn.is-active {
      color: var(--hira-accent, #3b82f6);
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }

    /* ── 视图分段（软底胶囊行，无分隔线）── */
    .notes-panel__viewswitch {
      display: flex; gap: 4px; padding: 0; flex-shrink: 0;
    }
    .notes-panel__tab {
      flex: 1; min-width: 0;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      border: none; background: transparent; border-radius: var(--hira-radius-sm, 8px); cursor: pointer;
      height: var(--hira-control-height, 32px); padding: 0 10px; font-family: inherit;
      font-size: var(--notes-fs-meta); font-weight: 400;
      color: var(--hira-text-secondary, #6b7280); white-space: nowrap;
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__tab:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.05));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 选中态 = 软底 + accent 字（不再画 2px 下划线，也不实心反白）。
       字重只在**选中那一项**加一档：四个分段全是 500 时，整条工具栏都在"喊"。 */
    .notes-panel__tab[aria-selected="true"] {
      color: var(--hira-accent, #3b82f6);
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      font-weight: 500;
    }
    /* 分段计数（只有回收站用）：空时整块收起，不留空位。 */
    .notes-panel__tab-count {
      padding: 0 7px; border-radius: var(--hira-radius-xs, 6px);
      font-size: 10px; font-weight: 400; line-height: 16px;
      background: var(--hira-hover-bg, rgba(0,0,0,0.06)); color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__tab-count:empty { display: none; }

    /* ── 内容区（横向内边距归 0，外壳已给）── */
    .notes-panel__body {
      flex: 1; min-height: 0; display: flex; flex-direction: column;
      overflow-y: auto; padding: 2px 0 8px;
    }
    .notes-panel__chip {
      display: inline-flex; align-items: center; gap: 4px;
      min-height: 28px;
      padding: 0 10px; font-size: var(--notes-fs-meta); font-family: inherit; font-weight: 400;
      border: 0;
      background: transparent; border-radius: var(--hira-radius-xs, 6px); cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__chip:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 「未归档」小标题：集锦卡片墙之下那块卡片的分组名（兼收起开关）。 */
    .notes-panel__sectionlabel {
      display: inline-flex; align-items: center; gap: 3px;
      align-self: flex-start;
      margin: 12px 2px 6px; padding: 2px 6px 2px 2px;
      font-size: 12px; font-weight: 500; font-family: inherit;
      color: var(--hira-text-tertiary, #9ca3af); letter-spacing: 0.02em;
      border: 0; background: transparent; border-radius: var(--hira-radius-xs, 6px);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__sectionlabel:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__sectionlabel svg { flex: none; }
    /* 筛选态：纯标签（分组恒定展开，不提供收起）。 */
    .notes-panel__sectionlabel.is-static { cursor: default; padding-left: 2px; }
    .notes-panel__sectionlabel.is-static:hover { background: transparent; color: var(--hira-text-tertiary, #9ca3af); }

    /* ── 头部（单栏两态的标题条 + 卡片态主动作行）── */
    .notes-panel__headerblock { display: flex; flex-direction: column; margin: 2px 2px 10px; }
    .notes-panel__header { display: flex; align-items: center; gap: 8px; margin: 0; }
    .notes-panel__title {
      flex: 1; min-width: 0; font-size: 13px; font-weight: 500;
      color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .notes-panel__header-spacer { flex: 1; }
    /* 卡片态主动作行：**「+ 添加当前页面」用 is-primary 拿最高视觉权重**（集锦的主动作），
       「+ 笔记」是次级按钮 —— 笔记是添花，不能抢集锦的戏（见 docs-new/9 §"集锦是大头"）。 */
    .notes-panel__actions { display: flex; gap: 8px; margin-top: 10px; }
    .notes-panel__actionbtn {
      display: inline-flex; align-items: center; gap: 5px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      font-size: 12px; font-weight: 400; font-family: inherit;
      border: 0;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04)); cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__actionbtn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 主动作：accent 软底 + accent 字（不再实心反白，重量靠颜色而不是大色块）。 */
    .notes-panel__actionbtn.is-primary {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
      font-weight: 500;
    }
    .notes-panel__actionbtn.is-primary:hover {
      background: var(--hira-accent-soft-strong, rgba(59,130,246,0.22));
      color: var(--hira-accent, #3b82f6);
    }

    /* ── 标签筛选条（无分隔线，只靠留白）── */
    .notes-panel__tagbar {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin: 0 2px 10px; padding-bottom: 0;
    }
    .notes-panel__tagchip {
      min-height: 28px; padding: 0 10px;
      font-size: var(--notes-fs-meta); font-family: inherit; font-weight: 400;
      border: 0;
      background: transparent; border-radius: var(--hira-radius-xs, 6px); cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__tagchip:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .notes-panel__tagchip.is-active {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }

    /* ── 集锦（文件夹）—— 无底色的一列，项间靠一条隐约短分割线分层 ── */
    .notes-panel__wall { display: flex; flex-direction: column; gap: var(--notes-row-gap); margin-bottom: 12px; }
    .notes-panel__section { display: flex; flex-direction: column; margin-bottom: 8px; }
    /* 相对定位只为让相邻项的分割线贴在本项上缘（见下面的 + 规则）。 */
    .notes-panel__collection-box { display: flex; flex-direction: column; position: relative; }
    /* 行内不再留"展开三角槽"：那个 18px 的空槽会把每个文件夹整体右移一格，
       与下面的卡片对不齐（用户原话"为什么文件夹前面有缩进"）。展开按钮改到行尾。 */
    .notes-panel__collection {
      position: relative; display: flex; align-items: center; gap: 10px;
      padding: 8px 8px 8px 12px; border-radius: var(--notes-radius); cursor: pointer;
      min-height: 40px; contain: layout style;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    /* 集锦项：**不铺底色、不描边** —— 一屏里十几块浅色卡会互相打架，
       层级交给 hover 软底 + 项间的隐约短分割线（下一条规则）。 */
    .notes-panel__collection.is-card {
      padding: 10px 8px 10px 12px;
      min-height: 48px;
      background: transparent;
      border: 0;
    }
    .notes-panel__collection.is-card:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.045)); }
    /* 非 tile 的集锦行（集锦内部平铺的子集锦）本来就是"行"不是"卡"，保持无框只做 hover 提亮。 */
    .notes-panel__collection:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    /* 项间分割：**短、淡、不通栏** —— 从封面左缘起（与卡片的 12px 内容左缘同一条线）、
       右侧留白收住；落在两个项之间那段 8px 空隙的正中（top: -4px）。
       只画在根墙的相邻项之间，嵌套的子集锦不画（那里靠缩进分层）。 */
    .notes-panel__wall > .notes-panel__collection-box + .notes-panel__collection-box::before {
      content: '';
      position: absolute; left: 12px; right: 24px; top: -4px;
      height: 1px; border-radius: 1px;
      background: color-mix(in srgb, var(--hira-text-primary, #1a1a1a) 9%, transparent);
    }
    /* 展开 / 折叠：**行尾的小键**（只在真有子集锦时渲染）。行首不再占槽，
       文件夹的封面因此和卡片的内容左缘对齐，不再整体缩进一格。 */
    .notes-panel__twisty {
      width: 22px; height: 22px; flex-shrink: 0; padding: 0; margin-left: auto;
      display: flex; align-items: center; justify-content: center;
      border: none; background: transparent; cursor: pointer;
      color: var(--hira-text-secondary, #6b7280); border-radius: var(--hira-radius-xs, 6px);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__twisty:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .notes-panel__cover {
      width: 36px; height: 36px; flex-shrink: 0; overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px); background: var(--hira-surface-soft, rgba(0,0,0,0.06));
      color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__cover img { width: 100%; height: 100%; object-fit: cover; }
    /* 封面拼贴：2~3 张缩略图并排成一条（每张各占一份宽，纵向都拉满）——比"只放第一张"更能
       看出这个集锦里有什么，也不容易在"第一张恰好没图"时落空（见 model#folderCoverPaths）。 */
    .notes-panel__cover.is-grid { display: flex; align-items: stretch; }
    .notes-panel__cover.is-grid img { flex: 1 1 0; min-width: 0; width: auto; height: 100%; }
    .notes-panel__collection-main { flex: 1; min-width: 0; }
    .notes-panel__collection-name {
      font-size: 13px; line-height: 19px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .notes-panel__collection-meta {
      font-size: var(--notes-fs-meta); line-height: 16px; margin-top: 2px;
      color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__rename {
      flex: 1; min-width: 0; font-size: 12px; font-family: inherit;
      height: var(--hira-control-height, 32px); padding: 0 12px; border-radius: var(--hira-radius-sm, 8px); outline: none;
      border: 0;
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
      color: var(--hira-text-primary, #1a1a1a);
    }

    /* ── 卡片（四态的唯一出口 · Edge 三段式：预览区 / 元信息两行 / 注释便签）── */
    .notes-panel__list { display: flex; flex-direction: column; gap: var(--notes-row-gap); }
    /* 长列表尾部「显示全部」：超过 NOTES_LIST_RENDER_LIMIT 张时才出现（见 view#buildCardList）。 */
    .notes-panel__more { display: flex; justify-content: center; padding: 8px 0 4px; }
    .notes-panel__more-btn {
      min-height: var(--hira-control-height, 32px); padding: 0 14px;
      border: 0;
      background: transparent; border-radius: var(--hira-radius-xs, 6px); cursor: pointer;
      font: inherit; font-size: var(--notes-fs-meta); font-weight: 400;
      color: var(--hira-accent, #3b82f6);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__more-btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .notes-panel__card {
      position: relative; display: flex; flex-direction: column;
      /* 段间距一律 8px（预览↔正文↔注释）；「字不贴边」全靠 --notes-card-pad-* */
      gap: var(--notes-seg-gap);
      padding: var(--notes-card-pad-y) var(--notes-card-pad-x);
      min-height: var(--notes-card-min-h);
      border-radius: var(--notes-radius);
      /* 卡本身**不铺底色、不描边** —— 一屏十几张浅底卡 + 发丝环就是"乱"的来源。
         项间分层只靠一条隐约短分割线（见下面的 + 规则），hover 才给软底。 */
      background: transparent;
      border: 0;
      cursor: pointer; contain: layout style;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__card:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.045));
    }
    /* 颜色标记：左侧 2px 色条（JS 打背景色）。无色时不画 —— 与旧色球同一份配色，只是呈现更省宽。 */
    .notes-panel__cardbar {
      position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px;
      border-radius: 2px; background: transparent;
    }
    /* 项间分割：**短、淡、不通栏** —— 从卡片内距起、右侧留白收住，
       落在列表 8px 间隙的正中（top: -4px）。只画在相邻卡之间，最后一张下面不画。 */
    .notes-panel__list > .notes-panel__card + .notes-panel__card::before {
      content: '';
      position: absolute; left: var(--notes-card-pad-x); right: 24px; top: -4px;
      height: 1px; border-radius: 1px;
      background: color-mix(in srgb, var(--hira-text-primary, #1a1a1a) 9%, transparent);
    }

    /* 第 1 段 · 预览区（有内容才出现，无内容整段不占位、不留空框）。
       图片预览**顶部通栏**：用负外边距抵消卡片内边距（文字才需要左右留白，图片不需要）。 */
    .notes-panel__card-preview {
      margin: calc(-1 * var(--notes-card-pad-y)) calc(-1 * var(--notes-card-pad-x)) 0;
      height: var(--notes-preview-h);
      border-radius: var(--notes-radius) var(--notes-radius) 0 0;
      overflow: hidden;
      background: var(--notes-preview-bg);
    }
    .notes-panel__preview-img { width: 100%; height: 100%; object-fit: cover; display: block; }
    /* 划词卡 / 备注卡的文字预览与正文同级：**不**抵消内边距（文字必须留白）。 */
    .notes-panel__card-preview.is-quote,
    .notes-panel__card-preview.is-note { margin: 0; height: auto; background: transparent; border-radius: 0; }
    /* 划词卡：摘到的那段文字**显眼地摊在卡里**（浅底 + 左侧引用竖条），最多 5 行。 */
    .notes-panel__card-preview.is-quote {
      border-left: 2px solid var(--hira-border-subtle, rgba(0,0,0,0.2));
      padding: 1px 0 1px 9px;
    }
    .notes-panel__preview-quote {
      font-size: 12px; line-height: 1.5; color: var(--hira-text-primary, #1a1a1a);
      display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
      overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }
    /* 备注卡：正文预览（最多 4 行）。 */
    .notes-panel__preview-text {
      font-size: 12px; line-height: 1.5; color: var(--hira-text-secondary, #6b7280);
      display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
      overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }

    /* 第 2 段 · 元信息两行（16px 图标 + 标题 / 域名）。 */
    .notes-panel__card-body { display: flex; flex-direction: column; gap: var(--notes-meta-gap); min-width: 0; }
    /* 回收站等"紧凑一行"复用 body 时恢复横向（见 view 的 is-row）。 */
    .notes-panel__card-body.is-row { flex-direction: row; align-items: center; gap: 10px; }
    .notes-panel__lead {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; flex-shrink: 0; color: var(--hira-text-secondary, #6b7280);
    }
    /* 行 1：**只有 favicon(16px) + 标题**，单行省略 —— 一眼扫得到（Edge 的干净感）。 */
    .notes-panel__card-line1 {
      display: flex; align-items: center; gap: 8px;
      font-size: var(--notes-fs-title); font-weight: 500; line-height: var(--notes-title-lh);
      color: var(--hira-text-primary, #1a1a1a);
    }
    .notes-panel__card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* 置顶图钉：**宽档才现身**（窄/标准档收进 ⋯ 菜单的「置顶 / 取消置顶」）。 */
    .notes-panel__card-pin { display: none; color: var(--hira-accent, #3b82f6); flex-shrink: 0; }
    /* 行 2：**只放域名**（单行省略）。日期 / 标签 / 图钉 / 尺寸全部让位到宽档（见 meta--wide）。
       为什么只留域名：上一版把「域名 · 日期 · 标签 · ↩N」全塞在这一行，每张卡都在抢注意力、扫不动。 */
    .notes-panel__card-meta {
      display: flex; align-items: center; gap: 6px; min-width: 0;
      font-size: var(--notes-fs-meta); line-height: 1.35; color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__card-meta.is-missing { font-style: italic; opacity: 0.75; }
    .notes-panel__card-domain {
      flex-shrink: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 第二行的**可点来源链接**（favicon + 域名）：hover 提亮 + 下划线 = "这里能点"的视觉反馈，
       与卡片本身的 hover 背景区分开（来源链接是卡内一个独立的动作，不触发卡片主动作）。 */
    .notes-panel__card-source {
      display: inline-flex; align-items: center; gap: 4px;
      min-width: 0; max-width: 100%;
      color: inherit; text-decoration: none; cursor: pointer;
    }
    .notes-panel__card-source:hover { color: var(--hira-accent, #3b82f6); text-decoration: underline; }
    .notes-panel__card-source-favicon { display: block; }
    /* page 卡第二行不画来源 favicon（第一行已是）—— 补一段左内边距（13px 图标 + 4px gap），
       让域名文字与其它 kind 的域名对齐、不左移。 */
    .notes-panel__card-source.is-no-favicon { padding-left: 17px; }
    /* 宽档专属的第三行（日期 · 标签 · 图片尺寸）—— 窄/标准档整块 display:none，
       于是"没有域名的备注卡"在窄档不会多出一条空行（display:none 的不是 flex 项、不吃 gap）。 */
    .notes-panel__card-meta--wide { display: none; }
    .notes-panel__card-dot, .notes-panel__card-date { flex-shrink: 0; }
    .notes-panel__noteloc {
      flex-shrink: 0; max-width: 84px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0.85;
    }
    .notes-panel__card-tags { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
    .notes-panel__notetag {
      flex-shrink: 0; font-size: 10.5px; line-height: 17px;
      padding: 0 7px; border-radius: var(--hira-radius-xs, 6px);
      color: var(--hira-text-secondary, #6b7280);
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .notes-panel__notetag.is-more { background: transparent; color: var(--hira-text-tertiary, #9ca3af); padding: 0; }
    /* 定位高亮 / 键盘导航：卡片本身没有描边了，状态环改用 **inset 阴影** ——
       不占布局、不参与圆角计算，也不会和预览图通栏打架。 */
    .notes-panel__card.is-highlight { box-shadow: inset 0 0 0 1px var(--hira-accent, #3b82f6); }
    /* 键盘导航项：软底 + inset 强调环（与"多选高亮"区分开，但不再外发光）。 */
    .notes-panel__card.is-keynav {
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      box-shadow: inset 0 0 0 1px var(--hira-accent, #3b82f6);
    }
    .notes-panel__card.is-trash { cursor: default; }
    .notes-panel__trash-main { flex: 1; min-width: 0; }
    .notes-panel__trash-actions { display: flex; gap: 4px; flex-shrink: 0; }

    /* 第 3 段 · 注释便签（卡片底部一条小横条；空则不显示 —— 见 view#buildCardNoteStrip）。
       比正文更弱：次级底色 + 更弱的文字色，绝不抢标题。 */
    .notes-panel__card-note {
      display: flex; align-items: center; gap: 8px;
      padding: var(--notes-note-pad); border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      font-size: var(--notes-fs-meta); color: var(--hira-text-tertiary, #9ca3af); cursor: text;
    }
    .notes-panel__card-note.is-editing { padding: 0; background: transparent; }
    .notes-panel__card-note-icon { flex-shrink: 0; font-size: var(--notes-fs-meta); line-height: 1; }
    .notes-panel__card-note-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notes-panel__card-note-input {
      width: 100%; resize: none; font: inherit; font-size: 11.5px; line-height: 1.5;
      padding: 8px 10px; border-radius: var(--hira-radius-xs, 6px); outline: none;
      border: 0;
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
      color: var(--hira-text-primary, #1a1a1a);
    }

    /* ── 卡片右上角动作位（⋯ + 多选复选框）——平时透明不占视觉，hover / 已选中时显形 ──
       带一层半透明底：预览区若是图片，纯图标会糊在图上认不出来（Edge 也是给控件垫底的）。 */
    .notes-panel__card-actions { display: flex; align-items: center; gap: 4px; }
    .notes-panel__card > .notes-panel__card-actions {
      position: absolute; top: 6px; right: 6px; opacity: 0;
      padding: 4px; border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-bg-elevated, rgba(255,255,255,0.92));
      box-shadow: 0 2px 8px rgba(0,0,0,0.14);
      transition: opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__card:hover > .notes-panel__card-actions,
    .notes-panel__card.is-selected > .notes-panel__card-actions { opacity: 1; }
    .notes-panel__card.is-selected { background: var(--hira-accent-soft, rgba(59,130,246,0.12)); }
    /* ⋯：打开该卡的上下文菜单（与右键同一份菜单）。 */
    .notes-panel__card-more {
      width: 24px; height: 24px; flex-shrink: 0; padding: 0; border-radius: var(--hira-radius-xs, 6px);
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__card-more:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.1)); color: var(--hira-text-primary, #1a1a1a); }
    /* 多选复选框：点击即切换（不需要按 Ctrl）。 */
    .notes-panel__select {
      width: 18px; height: 18px; flex-shrink: 0; padding: 0; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1.5px solid var(--hira-border-subtle, rgba(0,0,0,0.28));
      background: transparent; color: #fff; cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  border-color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__select.is-on {
      background: var(--hira-accent, #3b82f6);
      border-color: var(--hira-accent, #3b82f6);
    }

    /* ── 正文里的引用 chip（hira-note://<id> 渲染出来的可点小胶囊）──
       （引用卡的内联嵌入档已随「集锦是暂存、不是长文笔记」的定位移除，见 view 的说明。） */
    .notes-panel__ref-chip {
      display: inline-block; max-width: 100%; vertical-align: baseline;
      padding: 0 7px; margin: 0 1px; border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      color: var(--hira-accent, #3b82f6);
      font-size: 0.92em; line-height: 1.5; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .notes-panel__ref-chip.is-missing {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-secondary, #6b7280); cursor: default;
    }

    /* 空态：大留白 + 弱文字（不画框、不给插图，安静即可）。 */
    .notes-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #9ca3af); font-size: 12px; line-height: 19px;
    }

    /* ── 拖拽落点（与收藏面板同一套视觉语言）── */
    .notes-panel__collection.drop-into,
    .notes-panel__card.drop-into {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      outline: 2px solid var(--hira-accent, #3b82f6); outline-offset: -2px;
    }
    .notes-panel__collection.drop-before, .notes-panel__card.drop-before { box-shadow: inset 0 2px 0 var(--hira-accent, #3b82f6); }
    .notes-panel__collection.drop-after, .notes-panel__card.drop-after { box-shadow: inset 0 -2px 0 var(--hira-accent, #3b82f6); }
    .notes-panel__collection.is-dragging, .notes-panel__card.is-dragging { opacity: 0.45; }
    .notes-panel__body.drop-root { outline: 2px dashed var(--hira-accent, #3b82f6); outline-offset: -4px; border-radius: 8px; }

    /* ── 类型筛选下拉（自绘，支持真正的多选勾选）──
       浮层 = 大圆角 + 无描边 + 一层柔和投影（靠阴影浮起来，不靠边框）。 */
    .notes-panel__popover {
      position: fixed; z-index: var(--hira-z-popover, 1000);
      min-width: 160px; padding: 6px;
      display: flex; flex-direction: column; gap: 2px;
      border-radius: var(--hira-radius-lg, 14px);
      background: var(--hira-bg-elevated, #fff);
      border: 0;
      box-shadow: 0 12px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
    }
    .notes-panel__popover-row {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 10px; border: none; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      font: inherit; font-size: 12px; text-align: left; cursor: pointer;
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__popover-row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .notes-panel__checkbox {
      width: 16px; height: 16px; flex-shrink: 0; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1.5px solid var(--hira-border-subtle, rgba(0,0,0,0.25));
      color: #fff;
    }
    .notes-panel__popover-row.is-active .notes-panel__checkbox {
      background: var(--hira-accent, #3b82f6);
      border-color: var(--hira-accent, #3b82f6);
    }
    /* 「清除筛选」：只用留白与上一组分开，不画分隔线。 */
    .notes-panel__popover-clear {
      margin-top: 6px; height: var(--hira-control-height, 32px); padding: 0 10px; border: none; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-accent, #3b82f6); font: inherit; font-size: 11.5px;
      text-align: left; cursor: pointer;
    }
    .notes-panel__popover-clear:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }

    /* ── 轻提示（片段卡复制等一次的反馈）——常驻节点，只切显隐 ── */
    .notes-panel__toast {
      position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%) translateY(6px);
      z-index: var(--hira-z-popover, 1000);
      max-width: calc(100% - 24px); padding: 8px 14px;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-bg-elevated, #fff);
      border: 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      font-size: 11.5px; color: var(--hira-text-primary, #1a1a1a);
      opacity: 0; pointer-events: none;
      transition: opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ── 面板内大图预览（"仅缩略图"的图片卡点开时用）── */
    .notes-panel__lightbox {
      position: fixed; inset: 0; z-index: var(--hira-z-popover, 1000);
      display: flex; align-items: center; justify-content: center;
      padding: 16px; cursor: zoom-out;
      background: rgba(0,0,0,0.55);
    }
    .notes-panel__lightbox img {
      max-width: 100%; max-height: 100%; object-fit: contain;
      border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.4);
    }

    /* ── 多选批量栏（底部浮出一条；无分隔线，靠浮层阴影分层）── */
    .notes-panel__batchbar {
      display: none; align-items: center; gap: 6px; flex-shrink: 0;
      padding: 8px 0 4px;
      background: transparent;
    }
    .notes-panel__batchbar.is-visible { display: flex; }
    .notes-panel__batch-count { flex-shrink: 0; font-size: 11.5px; font-weight: 400; color: var(--hira-text-primary, #1a1a1a); }
    .notes-panel__batch-spacer { flex: 1; }
    .notes-panel__batch-btn {
      border: none; background: transparent; padding: 0 12px;
      height: var(--hira-control-height, 32px); border-radius: var(--hira-radius-xs, 6px);
      font: inherit; font-size: 11.5px; font-weight: 400;
      color: var(--hira-accent, #3b82f6); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__batch-btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .notes-panel__batch-btn.is-danger { color: var(--hira-danger, #ef4444); }

    /* ── 编辑器 ── */
    .notes-panel__editor { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
    .notes-panel__editor-head { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .notes-panel__kindtag {
      flex-shrink: 0; font-size: var(--notes-fs-meta); line-height: 22px; padding: 0 10px;
      border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.06)); color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__editor-title {
      flex: 1; min-width: 0; font-size: 13px; font-weight: 500; font-family: inherit;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px); outline: none;
      border: 0; background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__editor-title:hover { background: var(--hira-field-bg, rgba(0,0,0,0.04)); }
    .notes-panel__editor-title:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
    }
    /* 正文：行长上限 46em（≈34 个中文字），面板拉宽时不把一行拉成 600px 的长句。 */
    .notes-panel__editor-content {
      flex: 1; min-height: 140px; resize: none; outline: none;
      width: 100%; max-width: 46em; align-self: center;
      padding: 14px; font-size: 13px; line-height: 1.65; font-family: inherit;
      border: 0;
      border-radius: var(--hira-radius-lg, 14px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__editor-content:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
    }
    .notes-panel__preview {
      display: none; flex: 1; min-height: 140px; overflow-y: auto;
      width: 100%; max-width: 46em; align-self: center;
      padding: 14px 16px; font-size: 13px; line-height: 1.65;
      border: 0;
      border-radius: var(--hira-radius-lg, 14px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      word-break: break-word;
    }
    .notes-panel__editor.is-preview .notes-panel__editor-content { display: none; }
    .notes-panel__editor.is-preview .notes-panel__preview { display: block; }
    /* Markdown 排版抽成 .notes-panel__md —— 目前只给 note 卡的预览用
       （引用卡的内联嵌入档已移除，见上）。以后再有别处要渲染 Markdown，共用这一份。 */
    .notes-panel__md h1, .notes-panel__md h2, .notes-panel__md h3 { margin: 0.5em 0 0.25em; line-height: 1.3; }
    .notes-panel__md h1 { font-size: 17px; }
    .notes-panel__md h2 { font-size: 15px; }
    .notes-panel__md h3 { font-size: 13.5px; }
    .notes-panel__md p { margin: 0.5em 0; }
    .notes-panel__md ul, .notes-panel__md ol { margin: 0.5em 0; padding-left: 1.4em; }
    .notes-panel__md a { color: var(--hira-accent, #3b82f6); text-decoration: none; }
    .notes-panel__md a:hover { text-decoration: underline; }
    .notes-panel__md code {
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 11.5px; padding: 1px 5px; border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-hover-bg, rgba(0,0,0,0.07));
    }
    .notes-panel__md pre {
      padding: 10px 12px; border-radius: var(--hira-radius-md, 10px); overflow-x: auto;
      background: var(--hira-hover-bg, rgba(0,0,0,0.07));
    }
    .notes-panel__md pre code { background: transparent; padding: 0; }
    .notes-panel__md blockquote {
      margin: 0.5em 0; padding: 2px 12px;
      border-left: 2px solid var(--hira-border-subtle, rgba(0,0,0,0.2));
      color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__md hr { border: none; border-top: 1px solid var(--hira-hairline, rgba(0,0,0,0.08)); margin: 1em 0; }
    .notes-panel__md img { max-width: 100%; border-radius: var(--hira-radius-sm, 8px); }
    /* ── 图片卡编辑器：大缩略图 + 打开原图 ── */
    .notes-panel__editor-image {
      display: flex; flex-direction: column; align-items: center; gap: 6px; flex-shrink: 0;
    }
    .notes-panel__editor-thumb {
      max-width: 100%; max-height: 240px; object-fit: contain;
      border-radius: var(--hira-radius-md, 10px); border: 0;
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
    }
    .notes-panel__editor-image-actions {
      display: flex; align-items: center; gap: 8px;
      font-size: var(--notes-fs-meta); color: var(--hira-text-secondary, #6b7280);
    }
    .notes-panel__editor-image-note { color: var(--hira-text-tertiary, #9ca3af); }
    .notes-panel__editor-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
    .notes-panel__dots { display: flex; align-items: center; gap: 5px; }
    /* 色点：无描边，靠 ring 表达"可选 / 已选"（不再叠白色高光）。 */
    .notes-panel__dot-btn {
      width: 16px; height: 16px; padding: 0; border-radius: 50%;
      border: 0;
      background: transparent; cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12);
      transition: box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__dot-btn:hover { transform: scale(1.08); }
    .notes-panel__dot-btn.is-active {
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12), 0 0 0 2px var(--hira-bg-elevated, #fff), 0 0 0 3.5px var(--hira-accent, #3b82f6);
    }
    .notes-panel__dot-btn.is-none { background: linear-gradient(135deg, transparent 44%, #f87171 44%, #f87171 56%, transparent 56%); }
    .notes-panel__tags-input {
      flex-shrink: 0; font-size: 11.5px; font-family: inherit;
      height: var(--hira-control-height, 32px); padding: 0 10px; border-radius: var(--hira-radius-sm, 8px); outline: none;
      border: 0;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .notes-panel__tags-input:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
    }
    .notes-panel__folder-select {
      font-size: var(--notes-fs-meta); font-family: inherit; max-width: 45%;
      height: var(--hira-control-height, 32px); padding: 0 12px; border-radius: var(--hira-radius-sm, 8px);
      border: 0;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer;
    }
    .notes-panel__editor-meta {
      flex: 1; min-width: 0; text-align: right; font-size: var(--notes-fs-meta);
      color: var(--hira-text-tertiary, #9ca3af);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .notes-panel__editor-meta a { color: var(--hira-accent, #3b82f6); text-decoration: none; cursor: pointer; }
    .notes-panel__linkbtn {
      border: none; background: transparent; padding: 0; cursor: pointer;
      color: var(--hira-accent, #3b82f6); font: inherit;
    }

    /* ══════════════════════════════════════════════════════════════════
       容器查询三档（用 container-type，不用 @media —— 面板宽度与窗口无关）
       紧凑 <280：卡片内边距收到 10px、预览区压矮到 72（窄面板纵向寸土寸金）
       标准 280–420：默认版式（卡片内边距 10/12、预览区 96）
       宽松 >420：预览区加高到 116；**日期 / 标签 / 图钉在这里才现身**
                 （窄/标准档它们收进 ⋯ 菜单：图钉→「置顶/取消置顶」、引用→「被引用 N 次…」）
       ══════════════════════════════════════════════════════════════════ */
    @container (max-width: 279px) {
      .notes-panel__body { --notes-preview-h: 72px; --notes-card-pad-x: 10px; }
      /* 最小宽度：**文字优先**——收起图标、收紧内边距，四项标签仍能一行显示。 */
      .notes-panel__tab { padding: 0 3px; gap: 0; font-size: 10.5px; }
      .notes-panel__tab svg { display: none; }
      .notes-panel__tab-count { padding: 0 3px; }
    }
    @container (min-width: 421px) {
      .notes-panel__body { --notes-preview-h: 116px; }
      .notes-panel__card-pin { display: inline-flex; }
      .notes-panel__card-meta--wide { display: flex; }
    }
  `
  doc.head.appendChild(style)
}

/**
 * 集锦内容视图 —— 模型 + 视图 + open-view 落地的完整装配。
 *
 * 生命周期（桥订阅 / 计时器 / 观察器）**由调用方收口**：这里只返回 `dispose`，
 * 不自己监听 window 事件 —— 挂载它的 renderer 才知道自己何时消失。
 *
 * @param {Document} doc
 * @param {{ clients: { notes: any, tabs?: any }, menu?: any, confirm?: any, slots?: any }} ctx 面板宿主端口。
 * @returns {{ element: HTMLElement, setSection: (s: string) => void, setQuery: (q: string) => void, focusSearch: () => boolean, refresh: () => Promise<any>, applyOpenView: (payload: object) => void, dispose: () => void }}
 */
export function createNotesPanelContent(doc: Document, ctx: NotesPanelContentContext): NotesPanelContent {
  const client = ctx.clients.notes

  const model = createNotesModel(client, {
    onChange: () => view.render(),
    // 非致命错误（刷新失败但仍有上一份数据）→ 走既有 toast 轻提示，**不清空列表、不变错误页**。
    // 这里用「view 稍后赋值」的写法与 onChange 同构：两者都只在模型 init 之后才被调用。
    onError: (message) => view.toast(message),
    // 集锦级「全部打开」/「打开来源」走标签客户端（面板里比 window.open 可靠）。
    //
    // ⚠ **面板不再自己去问"当前活动标签"**。
    // 这里以前挂过一个 `getCurrentPage`：读 `ctx.clients.tabs.list()` 找 `active` 那一条，
    // 把它的 url/title 当参数交给主进程。那是**两处各自猜**——「哪个标签是活动标签」只有
    // 主进程是权威（见 TabManager 里那句"活动标签只有这里是权威"），而面板拿到的是这份权威
    // 经过一次投影（`list()` 还按窗口当前**空间**过滤）之后的副本：两次读取之间用户切了标签，
    // 或者两份投影的过滤条件不同，收进来的就是"面板以为的那一页"——不报错，只是收错。
    // 现在「+ 添加当前页面」只发一个**意图**（`kind:'page'` 且不带 url），
    // 由主进程按 IPC 发送方解析到本窗口的活动标签（见 ipc/notes.js#resolvePageSource）。
    tabs: ctx.clients.tabs || null,
    // 视图偏好（「未归档」折叠态这类小状态）走设置域持久化 —— 与笔记数据分开。
    prefs: ctx.clients.settings || null
  })
  injectArchiveViewStyles(doc)
  const archiveView = createArchiveView(doc, ctx as unknown as PanelContext)
  const view = createNotesView({
    doc,
    model,
    // `slots` = 宿主的通用插槽端口（apps/app-main/src/renderer/panels/main.js#slotPort）。
    // 面板只拿到「按 id 调用」的函数，对"谁实现、怎么注册"零知识；没有宿主时整块静默降级。
    ports: { menu: ctx.menu, confirm: ctx.confirm, slots: ctx.slots, archiveView }
  })

  /**
   * 把一份 open-view 载荷落到模型上。
   *
   * 事件与「挂载补发」共用这一处 —— 两条投递路径的语义必须完全一致，否则会各自漂移
   * （见 note-actions.js#revealInPanel：面板本次才打开时事件会丢，主进程留了 pending 槽）。
   */
  function applyOpenView(payload: unknown): void {
    const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    if (!p) return
    const noteId = p.noteId ? String(p.noteId) : ''
    const folderId = p.folderId ? String(p.folderId) : ''
    const apply = () => {
      // 定位到某条卡时**不动分段**：卡片可能不在当前段（比如从阅读段跳到收件箱里的卡），
      // 但 `revealNote` 自己会按需展开文件夹；强行切段反而会把用户当前浏览位置打乱。
      if (p.section && !noteId) model.setSection(p.section)
      if (folderId) model.openFolder(folderId)
      if (!noteId) return
      if (p.open === true) model.openNote(noteId)
      else model.revealNote(noteId)
    }
    // 竞态：`note:changed`（卡片刚被写入）与本事件几乎同时到达，列表里可能还没有这张卡。
    // 先刷一次再落载荷，刷新后仍取不到就作罢（不重试、不等待 —— 定位失败不该拖住面板）。
    if (noteId && typeof model.getNote === 'function' && !model.getNote(noteId)) {
      apply()
      Promise.resolve(model.reload('note:open-view'))
        .then(() => { if (model.getNote(noteId)) apply() })
        .catch(() => {})
      return
    }
    apply()
  }

  view.render()
  model.init()

  // `note:open-view` 通道**归 renderer 所有**：renderer 订阅事件 + 消费主进程的 pending 槽，
  // 把载荷从这里送进来。视图自己不再订阅，避免同一条投递路径出现两份实现。

  let disposed = false
  /** 幂等释放：模型计时器、视图观察器与浮层。 */
  function dispose() {
    if (disposed) return
    disposed = true
    view.dispose()
    model.dispose()
  }

  return {
    element: view.element,
    setSection: (section) => view.setSection(section),
    setQuery: (query) => view.setQuery(query),
    focusSearch: () => view.focusSearch(),
    refresh: () => model.reload(),
    applyOpenView,
    dispose
  }
}
