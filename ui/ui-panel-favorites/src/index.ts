// @ts-check
/**
 * @hira-ng/ui-panel-favorites —— 收藏（书签）侧边面板
 *
 * 与 ui-bookmarkbar 同构的**哑组件**：
 *   - 状态上行：编排层查库后经 setItems() 推下来（传入完整树）
 *   - 意图下行：点击 / 编辑 / 批量操作只上抛 intent，不做任何书签 IPC
 *   - 零 IPC / 零 electron —— 可被纯 DOM 测试全量驱动
 *
 * 树的形态（与 bookmark:tree 一致）：
 *   node = { id, title, url, favicon, children }，
 *   url 为假 → 文件夹；url 为真 → 书签；children 可无限嵌套文件夹。
 *
 * 交互：
 *   · 搜索框        → 本面板自过滤（命中项的祖先保留；搜索态默认全展开，手动折叠仍记）
 *   · 新建文件夹    → **面板内就地命名**（行内草稿行，回车即建）：
 *                     onIntent({ type: 'create-folder', title, parentId })
 *                     —— 不跳内部页；文件夹即 url 为空的收藏，走同一条 bookmark.add
 *   · 多选          → 工具栏「多选」显式进入（selectionMode）；批量条内「全选 / 取消全选」
 *   · 管理书签      → onIntent({ type: 'manage' })     → 内部页 hira://bookmarks
 *   · 书签行点击    → onIntent({ type: 'navigate', url })
 *   · ✎ 按钮        → onIntent({ type: 'edit', url, title, id })
 *   · 复选框点击    → 多选/反选（本组件维护 selected 集合）
 *   · 右键          → 只弹上下文菜单；「选择」是菜单里的一项（与点复选框同一动作）
 *   · 文件夹 › 箭头 → 展开/折叠（展开态 ∈ 本组件，会话内记忆，跨刷新保留）
 *   · 拖拽          → onIntent({ type: 'drop', ids, parentId, orderedIds })
 *                     落点三分带：行上 1/4 插前、行下 1/4 插后、文件夹行中间放入其内（可嵌套）；
 *                     多选时拖任一已选中行 = 整批一起走；文件夹亦为拖动源（可拖进另一个文件夹）；
 *                     拖进自身/自身后代会被本组件拦下（不产生环）。
 *   · 批量条        → onIntent({ type: 'delete-many' | 'batch-move-menu', ids, x, y })
 *   · 单行 / 批量删除 → **弹对话框确认**（`ctx.confirm` → 应用内 `hira://jsdialog` 浮层），
 *                     确认后才 onIntent({ type: 'delete' | 'delete-many' })；
 *                     面板里不再有任何"行内二次确认条"（那是第二套确认 UI，样式与层级都要自己维护一遍）
 *   · 新建草稿      → newFolder(parentId?, title?)（宿主在创建失败时用它回填重试）
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  createFaviconBadge,
  createFolderIcon,
  resolveBookmarkOpenTarget,
  openBookmarkTarget,
  openUrlPreferExistingTab,
  isPinnableToBookmarkbar,
  setDragItem,
  FolderPlus,
  Check,
  ExternalLink,
  Search,
  X,
  Pencil,
  Star,
  LayoutGrid
} from '@hira-ng/ui-common'
// 内部页地址的唯一拼法（真源 pages.mjs）—— 面板不手写 `hira://bookmarks`。
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
// 标签规则**唯一真源**（与主进程 domain、内部书签页共用同一份）：
// 两个系统标签（书签栏 / 侧栏图标栏）由 `pinned` / `railPinned` 派生，
// 因此分类栏筛选、批量打标签全都走这里的函数 —— 面板里不出现第二套判断。
import {
  SYSTEM_TAGS,
  tagLabel,
  isSystemTagLike,
  flattenTree,
  filterRowsByTag,
  buildFolderLookup,
  groupRowsByFolder
} from '@hira-ng/shared-types/src/bookmark-tags.mjs'
import type { BookmarkTagRow } from '@hira-ng/shared-types/src/bookmark-tags.mjs'
import type { MenuItem, MenuPopPayload, PanelSlotsPort } from '@hira-ng/ui-common'

const STYLE_ID = 'hira-panel-favorites-styles'

interface FavoriteNode extends BookmarkTagRow {
  id: string
  title: string
  nickname?: string | null
  url: string | null
  favicon?: string | null
  tags: string[]
  pinned: boolean
  railPinned: boolean
  openInSidebar?: boolean
  parentId: string | null
  children: FavoriteNode[]
}

interface FavoriteItemRef {
  id?: string
  url?: string | null
  title?: string
  parentId?: string | null
  pinned?: boolean
  railPinned?: boolean
}

interface FavoriteTag {
  tag: string
  count: number
  system?: boolean
  label?: string
}

interface FavoriteIntent {
  type: string
  url?: string
  title?: string
  id?: string
  ids?: string[]
  item?: FavoriteItemRef
  selectedIds?: string[]
  orderedIds?: string[]
  x?: number
  y?: number
  parentId?: string | null
  preferSidebar?: boolean
  modifiers?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
  tag?: string
  activeTag?: string
  pinned?: boolean
}

interface FavoriteDraft {
  parentId: string | null
  title: string
}

interface FavoritePlacement {
  parentId: string | null
  orderedIds: string[]
  expandId?: string
}

type DropZone = '' | 'before' | 'after' | 'into'

interface BatchButtonOptions {
  title?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}

type FavoriteSlotsPort = PanelSlotsPort & {
  reduce?: (slotId: string, payload: Record<string, unknown>) => unknown
}

type FavoritePanelContext = Omit<PanelContext, 'clients' | 'onIntent' | 'confirm' | 'slots'> & {
  onIntent?: (intent: FavoriteIntent) => void
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean> | boolean
  slots?: FavoriteSlotsPort
}

interface BookmarksMenuClient {
  popupMenu(payload: MenuPopPayload): Promise<string | null>
}

interface BookmarksClientPort {
  createFolder(input: { title: string; parentId: string | null }): Promise<unknown>
  tagDelete(tag: string): Promise<unknown>
  tagBulk(ids: string[], patch: { addTags?: string[]; removeTags?: string[] }): Promise<unknown>
  pinnedBulk(ids: string[], pinned: boolean): Promise<unknown>
  railPinnedBulk(ids: string[], pinned: boolean): Promise<unknown>
  remove(id: string): Promise<unknown>
  move(id: string, parentId: string | null): Promise<unknown>
  reorder(parentId: string | null, orderedIds: string[]): Promise<unknown>
  pinnedSet(id: string, pinned: boolean): Promise<unknown>
  railPinnedSet(id: string, pinned: boolean): Promise<unknown>
  snapshot(): Promise<{ folders?: FavoriteNode[]; tags?: FavoriteTag[] }>
  onChanged(listener: (payload: unknown) => void): () => void
}

interface BookmarksBridge {
  provider: { invoke(route: string, payload?: unknown): Promise<unknown> }
}

interface FavoritesTabsPort {
  newTab(input: { url: string }): Promise<unknown>
}

type FavoritesPanelContext = Omit<PanelContext, 'clients' | 'bridge' | 'menu'> & {
  clients?: (PanelContext['clients'] & {
    bookmarks?: BookmarksClientPort
    tabs?: FavoritesTabsPort
  }) | null
  bridge?: BookmarksBridge
  menu?: BookmarksMenuClient | null
  confirm?: (options: string | import('@hira-ng/ui-common').PanelConfirmOptions) => Promise<boolean> | boolean
}

export function injectFavoritesPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .favorites-panel__wrap {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      /* 面板是各视图的定位锚点（行内草稿、下方面板级浮层都相对这一层） */
      position: relative;
    }
    /* 工具条（搜索 + 新建文件夹 / 管理书签）。
       flex: 0 0 auto —— 下面的列表是 flex:1 的滚动区，工具条绝不能被压扁；
       min-height: 0 只留给列表（滚动的前提，见其规则）。 */
    .favorites-panel__toolbar {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 0 8px;
    }
    .favorites-panel__search {
      display: flex;
      align-items: center;
      gap: 8px;
      height: var(--hira-control-height, 32px);
      padding: 0 10px 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__search:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring);
    }
    .favorites-panel__search-icon {
      flex: 0 0 auto;
      color: var(--hira-text-secondary, #6b7280);
      font-size: 12px;
      line-height: 1;
      user-select: none;
    }
    .favorites-panel__search-input {
      flex: 1;
      min-width: 0;
      height: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      outline: none;
      color: var(--hira-text-primary, #1a1a1a);
      font-size: 12px;
      font-family: inherit;
    }
    .favorites-panel__search-input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    /* 清空按钮：只在有词时出现。hidden 属性必须显式复位 display（本类自己声明了 flex） */
    .favorites-panel__search-clear {
      flex: 0 0 18px;
      width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
      padding: 0; border: 0; border-radius: 50%;
      background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b);
      font-size: 10px;
      cursor: pointer;
    }
    .favorites-panel__search-clear[hidden] { display: none; }
    .favorites-panel__search-clear:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .favorites-panel__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
    .favorites-panel__actions button {
      border: 0;
      background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px);
      width: var(--hira-control-height, 36px);
      height: var(--hira-control-height, 36px);
      padding: 0;
      cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__actions button:hover {
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
    }
    /* 多选是**有状态的模式**，按钮必须能表达"此刻在里面"，不能只靠批量条暗示 */
    .favorites-panel__actions button.is-on {
      color: var(--hira-accent, #3b82f6);
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    .favorites-panel__list {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 0 0 8px;
    }
    .favorites-panel__empty {
      padding: 48px 20px;
      text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b);
      font-size: 12px;
      line-height: 19px;
    }
    /* 插件包裹层（bookmark.tree-renderer-item）：行本身没有外边距，包一层不该改变
       列表的排版 —— 显式声明为块级、不带任何间距，把"加了一层"对布局的影响收成零。 */
    .favorites-panel__row-slot { display: block; margin: 0; padding: 0; }
    /* 展开文件夹的子级：缩进落在分支容器上，行本身不再按 depth 重复缩进。
       竖线对齐文件夹展开箭头的中心，视觉与标签视图的分组导线一致。 */
    .favorites-panel__branch {
      margin-left: 15px;
      border-left: 1px solid var(--hira-border-soft, rgba(0,0,0,0.12));
    }
    .favorites-panel__row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 10px;
      min-height: calc(var(--hira-row-height, 36px) - 2px);
      box-sizing: border-box;
      border-radius: var(--hira-radius-md, 10px);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style;
      position: relative;
      white-space: nowrap;
    }
    .favorites-panel__row:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.05));
    }
    .favorites-panel__row.is-selected {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    .favorites-panel__row.drop-into {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: -2px;
    }
    /* 落点插入线：用 inset box-shadow 画在行内，不占布局、不引起位移 */
    .favorites-panel__row.drop-before { box-shadow: inset 0 2px 0 var(--hira-accent, #3b82f6); }
    .favorites-panel__row.drop-after { box-shadow: inset 0 -2px 0 var(--hira-accent, #3b82f6); }
    /* 正在被拖动的行（多选集整体拖动时全部标记） */
    .favorites-panel__row.dragging { opacity: 0.45; }
    /* 新建文件夹的就地命名行：与普通行同高、同缩进，输入框吃掉标题区 */
    .favorites-panel__row--draft {
      cursor: default;
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
    }
    .favorites-panel__row--draft:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.04)); }
    .favorites-panel__draft-input {
      flex: 1;
      min-width: 0;
      height: 26px;
      padding: 0 8px;
      border: 1px solid var(--hira-accent, #3b82f6);
      border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }
    .favorites-panel__draft-input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    /* 复选框：用**原生控件**，不自绘 —— 与历史面板同一套观感（不花里胡哨）。
       不再固定 18px 列宽、不再自画蓝底白勾：行本身就是 flex，对齐交给 gap。 */
    .favorites-panel__check {
      margin: 0;
      flex-shrink: 0;
      cursor: pointer;
    }
    /* 文件夹箭头的展开/折叠按钮 */
    .favorites-panel__toggle {
      flex: 0 0 18px;
      width: 18px; height: 18px;
      border: none; background: transparent; padding: 0;
      display: flex; align-items: center; justify-content: center;
      color: var(--hira-text-tertiary, #8b8b8b);
      cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 10px;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__toggle:hover { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .favorites-panel__toggle svg { transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease); }
    .favorites-panel__row.open > .favorites-panel__toggle svg { transform: rotate(90deg); }
    .favorites-panel__folder-ico {
      flex: 0 0 16px; width: 16px; height: 16px;
      color: var(--hira-text-secondary, #6b7280);
      display: flex; align-items: center; justify-content: center;
    }
    .favorites-panel__folder-ico svg { width: 15px; height: 15px; }
    .favorites-panel__row-favicon {
      flex: 0 0 16px;
    }
    .favorites-panel__label {
      flex: 1;
      text-align: left;
      border: none;
      background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      line-height: 17px;
      padding: 0;
    }
    .favorites-panel__badge {
      flex: 0 0 auto;
      font-size: 10.5px;
      color: var(--hira-text-tertiary, #8b8b8b);
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      border-radius: var(--hira-radius-xs, 6px);
      padding: 0 7px;
      line-height: 17px;
      min-width: 20px;
      text-align: center;
    }
    .favorites-panel__btn {
      width: 26px; height: 26px;
      border: none; background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b);
      cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 12px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__btn:hover {
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 批量操作条：一条软面浮条，不再套描边卡片。
       两行布局 —— 面板最窄 200px，把「已选 N 项 / 全选 / ✕」和「移动到… / 删除」
       挤在一行会让每个按钮都变成省略号，宁可高 24px 也不要不可读。 */
    .favorites-panel__batch {
      flex: 0 0 auto;
      display: none;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      margin: 2px 0 10px;
      border: 0;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
    }
    .favorites-panel__batch.on { display: flex; }
    .favorites-panel__batch-row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .favorites-panel__batch-count {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--hira-text-primary, #1a1a1a);
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .favorites-panel__batch-btn {
      border: 0;
      background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      flex-shrink: 0;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__batch-btn:hover { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .favorites-panel__batch-btn:disabled { opacity: 0.45; cursor: default; }
    .favorites-panel__batch-btn:disabled:hover { color: var(--hira-text-secondary, #6b7280); background: transparent; }
    .favorites-panel__batch-btn--danger {
      color: var(--hira-danger, #dc2626);
    }
    .favorites-panel__batch-btn--danger:hover { background: var(--hira-danger-bg, rgba(220,38,38,0.08)); }

    /* ── 标签分类栏 ───────────────────────────────────────────────────────
       与内部页同一条规则：系统标签（书签栏 / 侧栏图标栏）永远在前，用户标签按热度排。
       横向滚动不换行 —— 面板宽度会变，换行会把列表整体往下推。 */
    .favorites-panel__tags {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    .favorites-panel__tags[hidden] { display: none; }
    .favorites-panel__tag-chip {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      height: 22px;
      padding: 0 8px;
      border: 0;
      border-radius: 999px;
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      color: var(--hira-text-secondary, #6b7280);
      font-family: inherit;
      font-size: 11px;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__tag-chip:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.08));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .favorites-panel__tag-chip.is-active {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .favorites-panel__tag-chip svg { flex: 0 0 auto; }
    .favorites-panel__tag-chip-label {
      max-width: 96px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .favorites-panel__tag-chip-count {
      font-size: 10px;
      opacity: 0.72;
      font-variant-numeric: tabular-nums;
    }

    /* 批量条第二/三行：按钮会随选中项增加（标签 / 书签栏 / 侧栏），允许换行 */
    .favorites-panel__batch-row--wrap { flex-wrap: wrap; }

    /* ── 标签视图：按父文件夹分段的时间轴 ─────────────────────────────────
       标签视图里"文件夹只是条目原来在哪儿"，**不是可展开的容器** ——
       若把祖先文件夹也画成带箭头的行，会和「整个文件夹被固定」的展示重复，
       用户分不清哪些是筛选结果、哪些只是路径。

       所以这里只有一行**组头**（文件夹标题，可收起），下面是命中的行，
       左侧一条竖线把同组的行串起来（时间轴观感），收起后组头仍在，
       用户随时能知道自己筛掉的是哪一段。

       唯一的例外是**根目录组**：它没有"来自哪个文件夹"可讲，直接平铺
       （无组头、无竖线、不可收起），免得给顶层条目也套一层时间轴。 */
    .favorites-panel__tag-group { display: block; }
    .favorites-panel__tag-group-head {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 6px 10px 4px;
      border: 0;
      background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-secondary, #6b7280);
      font-family: inherit;
      font-size: 11px;
      /* 分组抬头是弱化标签：常规字重（中文 500 落到 Regular），避免整屏都是粗体。 */
      font-weight: 500;
      text-align: left;
      cursor: pointer;
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__tag-group-head:hover {
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-hover-bg, rgba(0,0,0,0.05));
    }
    .favorites-panel__tag-group-arrow {
      flex: 0 0 14px;
      width: 14px; height: 14px;
      display: flex; align-items: center; justify-content: center;
      /* 图标是「右箭头」：展开态顺时针 90° = 指向下方，收起态回正 = 指向右侧 */
      transform: rotate(90deg);
      transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .favorites-panel__tag-group.is-collapsed .favorites-panel__tag-group-arrow { transform: rotate(0deg); }
    .favorites-panel__tag-group-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .favorites-panel__tag-group-count {
      flex: 0 0 auto;
      font-size: 10px;
      font-weight: 400;
      color: var(--hira-text-tertiary, #8b8b8b);
      font-variant-numeric: tabular-nums;
    }
    /* 竖线 + 缩进：同组命中行挂在组头下方，形成一条时间轴 */
    .favorites-panel__tag-group-body {
      margin: 0 0 4px 17px;
      padding-left: 7px;
      border-left: 1px solid var(--hira-border-soft, rgba(0,0,0,0.12));
    }
  `
  doc.head.appendChild(style)
}

const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
// 文件夹图标不自留副本：与书签栏共用 ui-common#createFolderIcon（见该文件头）。

/**
 * 创建收藏面板内容（不含 shell）。
 * @param {Document} doc
 * @param {FavoritePanelContext} [ctx]
 *   `ctx.confirm` 是宿主注入的**平台对话框端口**（`ui-common#confirm` → `window.confirm`，
 *   面板视图里已由 `hira://jsdialog` 接管为应用内浮层）。本组件不认识这个实现，只等一个布尔。
 *   `ctx.slots` 是宿主注入的**渲染侧插槽端口**（本组件不认识插件系统）。用于
 *   `bookmark.tree-renderer-item`，见 buildNodeRow 末尾。
 * @returns {{ element: HTMLDivElement, setItems: (nodes: readonly FavoriteNode[]) => void, setQuery: (q: string) => void,
 *   setTags: (tags: readonly FavoriteTag[]) => void, confirmDelete: (item: FavoriteItemRef) => Promise<void>,
 *   confirmBatchDelete: (ids: string[]) => Promise<void>, toggleSelect: (id: string) => void,
 *   newFolder: (parentId?: string|null, title?: string) => void,
 *   removeTag: (tag: string) => void, isSelected: (id: string) => boolean }}
 */
export function createFavoritesPanel(doc: Document, ctx: PanelContext = {}) : { element: HTMLDivElement, setItems: (nodes: readonly FavoriteNode[]) => void, setQuery: (q: string) => void,
  setTags: (tags: readonly FavoriteTag[]) => void, confirmDelete: (item: FavoriteItemRef) => Promise<void>,
  confirmBatchDelete: (ids: string[]) => Promise<void>, toggleSelect: (id: string) => void,
  newFolder: (parentId?: string|null, title?: string) => void,
  removeTag: (tag: string) => void, isSelected: (id: string) => boolean } {
  const panelCtx = ctx as FavoritePanelContext
  const onIntent = typeof panelCtx.onIntent === 'function' ? panelCtx.onIntent : () => {}
  const slots = panelCtx.slots || null
  const wrap = doc.createElement('div')
  wrap.className = 'favorites-panel__wrap'

  // 视图态：会话内记忆（跨 setItems 刷新保留，不落盘）
  const expanded = new Set<string>()        // 已展开的文件夹 id（常规态）
  const searchCollapsed = new Set<string>() // 搜索态下被手动折叠的文件夹 id
  const tagCollapsed = new Set<string>()    // 标签视图下被收起的文件夹分组 id（根目录组直接平铺，不参与收起）
  const selected = new Set<string>()        // 已选中的节点 id（书签/文件夹皆可）
  let nodes: FavoriteNode[] = []                    // 当前树
  let query = ''                    // 归一化后的搜索词
  let visibleIds: string[] = []               // 上一次渲染出来的行 id（全选作用于**看得见的**那些）
  /** 标签分类栏数据（宿主经 setTags 推下来，来自同一次快照 SELECT）。 */
  let tags: FavoriteTag[] = []
  /** 当前选中的标签（'' = 全部）。系统标签（书签栏 / 侧栏）与用户标签同一条路径。 */
  let activeTag = ''
  // 多选态：唯一判据。行的点击语义、复选框列是否出现、批量条是否在，全读它，
  // 不再让各处各判一次 `selected.size > 0`（那正是两份真相的开始）。
  let selectionMode = false
  // 删除确认走平台对话框端口（宿主注入的 `ctx.confirm`）；没有端口时退回面板自己的
  // `window.confirm` —— 两边都是**同一条浏览器语义**，不额外造一套行内确认 UI。
  const confirmPort = typeof panelCtx.confirm === 'function' ? panelCtx.confirm : null
  const askConfirm = (message: string) => {
    if (confirmPort) return Promise.resolve(confirmPort({ message }))
    const view = doc.defaultView
    if (!view || typeof view.confirm !== 'function') return Promise.resolve(false)
    try { return Promise.resolve(view.confirm(message) === true) } catch (_) { return Promise.resolve(false) }
  }
  // 新建文件夹的就地草稿：{ parentId, title }；null = 没有草稿行
  let draft: FavoriteDraft | null = null
  let focusDraftNext = false        // 仅 beginNewFolder 后置位，避免每次 setItems 重建都抢焦点

  // 过滤态（搜索 / 标签）默认**全部展开**（用户要的是"一眼看到命中项"），
  // 只有手动折叠过的才收起。两种模式共用同一套展开渲染，差异只收敛在这一个判据里。
  const isFiltering = () => !!query || !!activeTag
  const isExpanded = (id: string) => (isFiltering() ? !searchCollapsed.has(id) : expanded.has(id))

  /** 属性选择器转义（拖拽落点要按 id 反查行，id 虽是内部生成，但查询必须绝对安全） */
  const cssEscape = (v: unknown) => (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(String(v))
    : String(v).replace(/["\\]/g, '\\$&')

  // ── 工具条：搜索 + 管理动作 ────────────────────────
  //
  // 搜索是**本面板自己的事**（过滤树只影响这一屏，不必问宿主）；
  // 新建文件夹也是面板内的事（就地命名，见 beginNewFolder）；
  // 只有「管理书签」（导入导出 / 备份 / 全量整理）才交给内部页 ——
  // 那套东西在 200~600px 里做不开，故上抛意图由编排层开标签。
  const toolbar = doc.createElement('div')
  toolbar.className = 'favorites-panel__toolbar'

  const searchBox = doc.createElement('div')
  searchBox.className = 'favorites-panel__search'
  const searchIcon = doc.createElement('span')
  searchIcon.className = 'favorites-panel__search-icon'
  searchIcon.appendChild(Search(doc, { size: 15 }))
  const searchInput = doc.createElement('input')
  searchInput.className = 'favorites-panel__search-input'
  searchInput.type = 'text'
  searchInput.placeholder = '搜索收藏…'
  searchInput.spellcheck = false
  const searchClear = doc.createElement('button')
  searchClear.className = 'favorites-panel__search-clear'
  searchClear.appendChild(X(doc, { size: 12 }))
  searchClear.title = '清空搜索'
  searchClear.hidden = true
  searchBox.append(searchIcon, searchInput, searchClear)

  const toolbarActions = doc.createElement('div')
  toolbarActions.className = 'favorites-panel__actions'
  const newFolderBtn = doc.createElement('button')
  newFolderBtn.appendChild(FolderPlus(doc, { size: 16 }))
  newFolderBtn.title = '在面板内新建文件夹（就地命名，回车创建）'
  newFolderBtn.setAttribute('aria-label', '新建文件夹')
  newFolderBtn.addEventListener('click', () => beginNewFolder(autoDraftParent()))
  const multiBtn = doc.createElement('button')
  multiBtn.appendChild(Check(doc, { size: 16 }))
  multiBtn.title = '进入多选（可全选 / 批量移动 / 批量删除）'
  multiBtn.setAttribute('aria-label', '多选')
  multiBtn.setAttribute('aria-pressed', 'false')
  multiBtn.addEventListener('click', () => {
    if (selectionMode) exitSelection()
    else enterSelection()
  })
  const manageBtn = doc.createElement('button')
  manageBtn.appendChild(ExternalLink(doc, { size: 16 }))
  manageBtn.title = '在标签页中打开书签管理页'
  manageBtn.setAttribute('aria-label', '管理书签')
  manageBtn.addEventListener('click', () => onIntent({ type: 'manage' }))
  toolbarActions.append(newFolderBtn, multiBtn, manageBtn)

  // ── 标签分类栏 ────────────────────────────────────
  //
  // 与内部书签页同一条规则：系统标签（书签栏 / 侧栏图标栏）永远在前（计数为 0 也在），
  // 用户标签按热度排。数据由宿主随快照推下来（setTags），面板不自己再算一遍计数 ——
  // 否则「分类栏说 3 条、点进去只有 2 条」这种两份真相对不上账。
  const tagBar = doc.createElement('div')
  tagBar.className = 'favorites-panel__tags'
  tagBar.setAttribute('role', 'toolbar')
  tagBar.setAttribute('aria-label', '按标签筛选')

  toolbar.append(searchBox, tagBar, toolbarActions)
  wrap.appendChild(toolbar)

  // 输入防抖：树是**整表重建**的，逐键重建长树会让输入发涩（与内部页 150ms 同口径，
  // 这里再快一点 —— 面板树通常更小，用户对"边打边筛"的期望更高）。
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function applyQuery() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
    setQuery(searchInput.value)
  }
  function scheduleQuery() {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { searchTimer = null; setQuery(searchInput.value) }, 120)
  }
  searchInput.addEventListener('input', scheduleQuery)
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    // Escape：有词 → 清词（与清空按钮同一动作）；无词 → 交出焦点。
    // 不再冒泡 —— 这一下已经被搜索框消费，宿主/全局快捷键不该同时收到。
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (searchInput.value) { searchInput.value = ''; applyQuery() }
    else searchInput.blur()
  })
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    applyQuery()
    searchInput.focus()
  })

  // ── 标签筛选 ──────────────────────────────────────
  //
  // 标签是**跨文件夹视图**（与内部页同一语义）：选中后整棵树按标签收窄，
  // 祖先文件夹保留路径；再点一次当前标签 = 取消。搜索词与标签**叠加**，互不覆盖。

  function systemIcon(tag: string) {
    if (tag === SYSTEM_TAGS[0].id) return Star(doc, { size: 12 })
    if (tag === SYSTEM_TAGS[1].id) return LayoutGrid(doc, { size: 12 })
    return null
  }

  function renderTagBar() {
    tagBar.replaceChildren()
    const add = (tag: string, label: string, count: number | null, system: boolean) => {
      const chip = doc.createElement('button')
      chip.className = 'favorites-panel__tag-chip' + (activeTag === tag ? ' is-active' : '')
      chip.type = 'button'
      chip.dataset.tag = tag
      chip.title = tag ? tag : '全部'
      const ic = system ? systemIcon(tag) : null
      if (ic) chip.appendChild(ic)
      const text = doc.createElement('span')
      text.className = 'favorites-panel__tag-chip-label'
      text.textContent = label
      chip.appendChild(text)
      if (count != null) {
        const num = doc.createElement('span')
        num.className = 'favorites-panel__tag-chip-count'
        num.textContent = String(count)
        chip.appendChild(num)
      }
      chip.addEventListener('click', () => setTag(tag))
      // 用户标签右键 = 删除这个标签（全库摘除）；系统标签（书签栏 / 侧栏图标栏）
      // 由 pinned / railPinned 两列派生，没有"删除"这回事，因此不挂右键。
      if (tag && !system) {
        chip.title = `${label} · 右键删除该标签`
        chip.addEventListener('contextmenu', (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          onIntent({ type: 'tag-delete', tag })
        })
      }
      tagBar.appendChild(chip)
    }

    add('', '全部', null, false)
    const rows = Array.isArray(tags) ? tags.slice() : []
    // 当前筛选的标签若已没有条目（计数掉到 0），仍留一个 chip —— 用户才看得见
    //「为什么列表是空的」，而不是以为筛选静默失效。
    const known = new Set(rows.map((row) => row && row.tag))
    if (activeTag && !known.has(activeTag)) {
      rows.push({ tag: activeTag, count: 0, system: isSystemTagLike(activeTag), label: tagLabel(activeTag) })
    }
    for (const row of rows) {
      if (!row || !row.tag) continue
      const tag = String(row.tag)
      const system = row.system === true || isSystemTagLike(tag)
      add(tag, row.label || (system ? tagLabel(tag) : tag), row.count, system)
    }
  }

  function setTag(tag: string) {
    const wanted = String(tag || '')
    // 再点一次当前标签 = 取消筛选（「全部」也走这里，语义自洽）
    activeTag = wanted && activeTag === wanted ? '' : wanted
    searchCollapsed.clear()
    tagCollapsed.clear()
    renderTagBar()
    renderList()
  }

  /** 宿主端口：整份标签分类数据（系统标签已在真源里排好序，这里不再重排） */
  function setTags(next: readonly FavoriteTag[]) {
    tags = Array.isArray(next) ? next.slice() : []
    renderTagBar()
  }

  /**
   * 宿主端口：某个用户标签已被删除（全库摘除）。
   * 若它正是当前筛选，必须同时退出该筛选 —— 否则列表会停在一个
   * "分类栏里已经没有、列表却还在按它过滤"的幽灵状态。
   */
  function removeTag(tag: string) {
    const key = String(tag || '')
    if (!key) return
    if (activeTag.toLowerCase() === key.toLowerCase()) {
      activeTag = ''
      tagCollapsed.clear()
      renderTagBar()
      renderList()
    } else {
      renderTagBar()
    }
  }

  renderTagBar()

  // ── 批量操作条 ─────────────────────────────────────
  //
  // 内容**每次都由 updateBatchBar() 整体重建**：它同时是"多选态"的唯一渲染出口
  //（模式按钮的按下态、复选框列、批量条的三段内容）。旧实现靠隐藏/换类名在
  // 同一串节点上切态，多一种状态就多一处 `hidden = true`，最后没人能确定
  // 「此刻这条里到底有几个按钮」。重建只有 5 个按钮，代价可忽略。
  const batch = doc.createElement('div')
  batch.className = 'favorites-panel__batch'
  batch.dataset.control = 'batch'
  wrap.appendChild(batch)

  const list = doc.createElement('div')
  list.className = 'favorites-panel__list'
  wrap.appendChild(list)

  function batchRow(...children: Node[]) {
    const row = doc.createElement('div')
    row.className = 'favorites-panel__batch-row'
    row.append(...children)
    return row
  }

  function batchBtn(label: string, action: string, opts: BatchButtonOptions = {}) {
    const b = doc.createElement('button')
    b.className = 'favorites-panel__batch-btn' + (opts.danger ? ' favorites-panel__batch-btn--danger' : '')
    b.dataset.action = action
    b.textContent = label
    if (opts.title) b.title = opts.title
    if (opts.disabled) b.disabled = true
    if (opts.onClick) b.addEventListener('click', opts.onClick)
    return b
  }

  /** 多选态的唯一渲染出口（模式按钮态 / 复选框列是否出现 / 批量条内容，全在这里收口） */
  function updateBatchBar() {
    multiBtn.classList.toggle('is-on', selectionMode)
    multiBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false')

    const n = selected.size
    const on = selectionMode || n > 0
    batch.classList.toggle('on', on)
    batch.replaceChildren()
    if (!on) return

    // 常态：第一行「已选 N 项 + 全选/取消全选 + 退出」，第二行「移动到… / 删除」
    // （删除的二次确认走平台对话框，见 askConfirm —— 批量条不再整体"切成问话样式"）
    const count = doc.createElement('span')
    count.className = 'favorites-panel__batch-count'
    count.textContent = n ? `已选 ${n} 项` : '未选择项目'

    const allIds = visibleIds
    const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
    const all = batchBtn(allSelected ? '取消全选' : '全选', 'batch-select-all', {
      title: allSelected ? '取消当前可见项的选择' : '选中当前可见的全部书签与文件夹',
      disabled: allIds.length === 0,
      onClick: () => toggleSelectAll()
    })
    const exit = batchBtn('✕', 'batch-exit', {
      title: '退出多选',
      onClick: () => exitSelection()
    })

    const move = batchBtn('移动到…', 'batch-move', {
      disabled: n === 0,
      onClick: () => {
        const r = move.getBoundingClientRect()
        onIntent({ type: 'batch-move-menu', ids: [...selected], x: r.left, y: r.bottom })
      }
    })
    const del = batchBtn(n > 1 ? `删除 ${n}` : '删除', 'batch-del', {
      danger: true,
      disabled: n === 0,
      onClick: () => confirmBatchDelete([...selected])
    })

    // 第三行：标签 + 两个**系统标签**（书签栏 / 侧栏图标栏）。
    // 固定位是可切换的 —— 全选中都已固定就"取消"，否则"全部固定"（与内部页同一直觉）。
    // 打标签统一走子窗口（见宿主 onIntent 的 'tag-window'），面板里不再塞浮层。
    const picked = [...selected].map((id) => findNode(id)).filter((node): node is FavoriteNode => node !== null)
    const allPinned = picked.length > 0 && picked.every((node) => !!node.pinned)
    const allRail = picked.length > 0 && picked.every((node) => !!node.railPinned)
    const tagBtn = batchBtn('打标签…', 'batch-tag', {
      disabled: n === 0,
      title: '在独立窗口里给所选项打标签（系统标签可顺带固定 / 取消固定）',
      onClick: () => onIntent({ type: 'tag-window', ids: [...selected] })
    })
    const pinBtn = batchBtn(allPinned ? '取消书签栏' : '书签栏固定', 'batch-pin', {
      disabled: n === 0,
      title: allPinned ? '从书签栏取消固定所选项' : '把所选项固定到书签栏',
      onClick: () => onIntent({ type: 'pinned-bulk', ids: [...selected], pinned: !allPinned })
    })
    const railBtn = batchBtn(allRail ? '取消侧栏' : '侧栏固定', 'batch-rail', {
      disabled: n === 0,
      title: allRail ? '从侧栏图标栏取消固定所选项' : '把所选项固定到侧栏图标栏',
      onClick: () => onIntent({ type: 'rail-bulk', ids: [...selected], pinned: !allRail })
    })

    const tagRow = batchRow(tagBtn, pinBtn, railBtn)
    tagRow.classList.add('favorites-panel__batch-row--wrap')
    batch.append(
      batchRow(count, all, exit),
      batchRow(move, del),
      tagRow
    )
  }

  /** 进入多选（工具栏按钮 / 复选框 / 菜单「选择」共用同一个入口） */
  function enterSelection() {
    if (selectionMode) return
    selectionMode = true
    renderList()
    updateBatchBar()
  }

  /** 退出多选：清空选择并收起复选框列与批量条（删除完成后也走这里） */
  function exitSelection() {
    selectionMode = false
    selected.clear()
    renderList()
    updateBatchBar()
  }

  function toggleSelect(id: string) {
    if (!id) return
    if (!selectionMode) selectionMode = true
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    renderList()
    updateBatchBar()
  }

  /** 全选 / 取消全选：作用于**当前可见**的行（搜索态即过滤后的结果）。 */
  function toggleSelectAll() {
    if (!visibleIds.length) return
    const allSelected = visibleIds.every((id) => selected.has(id))
    if (allSelected) selected.clear()
    else for (const id of visibleIds) selected.add(id)
    selectionMode = true
    renderList()
    updateBatchBar()
  }

  // ── 新建文件夹（面板内就地命名）──────────────────────
  //
  // 为什么必须留在面板里：用户在这个面板里整理收藏，"建个文件夹把这几条放进去"
  // 是同一段连续动作。跳去内部页等于把动作截断成两次上下文切换。
  // 命名用行内输入框而不是 prompt（Electron 渲染进程没有 window.prompt）。
  // 组件只负责"收集一个名字 + 落点"，真正落库由宿主走 bookmark.add（url 为空）。

  /** 新建按钮的落点：唯一选中项是文件夹 → 建在它里面；否则根目录。 */
  function autoDraftParent() {
    if (selected.size !== 1) return null
    const [id] = [...selected]
    const node = findNode(id)
    return node && !node.url ? id : null
  }

  /** 把 id 的所有祖先文件夹展开（否则草稿行会被折叠的祖先藏起来）。 */
  function expandPathTo(id: string) {
    const chain: string[] = []
    ;(function walk(children: readonly FavoriteNode[], path: readonly string[]) {
      for (const n of children) {
        if (!n) continue
        if (n.id === id) { chain.push(...path); return }
        walk(n.children || [], path.concat(n.id))
      }
    })(nodes, [])
    for (const pid of chain) {
      expanded.add(pid)
      searchCollapsed.delete(pid)
    }
  }

  /**
   * 打开就地命名的草稿行。
   * @param {string|null} [parentId] 落点父文件夹（null = 根目录）
   * @param {string} [title] 预填名字（创建失败后回填重试）
   */
  function beginNewFolder(parentId: string|null = null, title: string = '') {
    // 过滤态下新建的项大概率不命中当前条件（看不见 = 以为没建成）——先退出过滤
    if (query) {
      searchInput.value = ''
      setQuery('')
    }
    if (activeTag) setTag(activeTag)
    const pid = parentId || null
    if (pid) {
      if (!findNode(pid)) return // 目标文件夹已被删掉
      expanded.add(pid)
      searchCollapsed.delete(pid)
      expandPathTo(pid)
    }
    draft = { parentId: pid, title: String(title || '') }
    focusDraftNext = true
    renderList()
  }

  function closeDraft() {
    if (!draft) return
    draft = null
    focusDraftNext = false
    renderList()
  }

  function commitDraft(rawTitle: unknown) {
    if (!draft) return
    const title = String(rawTitle || '').trim()
    if (!title) { closeDraft(); return }
    const parentId = draft.parentId
    draft = null
    focusDraftNext = false
    renderList()
    onIntent({ type: 'create-folder', title, parentId })
  }

  /** 草稿行：不挂 data-row —— 它不是树节点，绝不能被点击/拖拽/右键委托当成一行书签。 */
  function buildDraftRow() {
    if (!draft) return doc.createElement('div')
    const row = doc.createElement('div')
    row.className = 'favorites-panel__row favorites-panel__row--folder favorites-panel__row--draft'
    row.dataset.control = 'draft'
    row.style.paddingLeft = '6px'
    row.appendChild(createFolderIcon(doc, { size: 15, className: 'favorites-panel__folder-ico' }))

    const input = doc.createElement('input')
    input.className = 'favorites-panel__draft-input'
    input.type = 'text'
    input.maxLength = 120
    input.placeholder = '文件夹名称，回车创建'
    input.spellcheck = false
    input.value = draft.title || ''
    // 阻止 mousedown 冒泡：否则容器的委托/宿主焦点管理会把刚拿到的焦点抢走
    input.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commitDraft(input.value) }
      else if (e.key === 'Escape') { e.preventDefault(); closeDraft() }
    })
    row.appendChild(input)

    const ok = doc.createElement('button')
    ok.className = 'favorites-panel__btn'
    ok.appendChild(Check(doc, { size: 14 }))
    ok.title = '创建'
    ok.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); commitDraft(input.value) })

    const cancel = doc.createElement('button')
    cancel.className = 'favorites-panel__btn'
    cancel.appendChild(X(doc, { size: 14 }))
    cancel.title = '取消'
    cancel.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); closeDraft() })

    row.append(ok, cancel)
    return row
  }

  // ── 折叠/展开 ──────────────────────────────────────
  function toggleExpand(id: string) {
    const set = isFiltering() ? searchCollapsed : expanded
    if (set.has(id)) set.delete(id)
    else set.add(id)
    renderList()
  }

  // ── 搜索过滤 ───────────────────────────────────────
  /** 节点自身是否命中：昵称/标题/URL 任一包含即算。 */
  function matchNode(node: FavoriteNode, q: string) {
    if (!node) return false
    return String(node.nickname || '').toLowerCase().includes(q)
      || String(node.title || '').toLowerCase().includes(q)
      || String(node.url || '').toLowerCase().includes(q)
  }

  /**
   * 递归过滤树：文件夹自身命中 → 整棵子树保留（用户搜到了"某个文件夹"）；
   * 否则只保留含命中后代的文件夹。返回浅拷贝，绝不改动源树（源树还给拖拽/移动用）。
   */
  function filterTree(children: readonly FavoriteNode[], q: string): FavoriteNode[] {
    const out: FavoriteNode[] = []
    for (const node of children) {
      if (!node) continue
      if (matchNode(node, q)) { out.push(node); continue }
      if (node.url) continue
      const kids = filterTree(node.children || [], q)
      if (kids.length) out.push({ ...node, children: kids })
    }
    return out
  }

  // ── 递归建行 ───────────────────────────────────────
  /**
   * @param {FavoriteNode} node
   * @param {number} depth
   * @param {{ flat?: boolean }} [opts] flat = 标签视图里的扁平行：
   *   文件夹不再画箭头/子项数（它不是容器，只是"自己带了这个标签"的一条结果），
   *   也不接受拖拽（扁平结果里没有可信的同级顺序）。
   */
  function buildNodeRow(node: FavoriteNode, depth: number, opts: { flat?: boolean } = {}) {
    const isFolder = !node.url
    const flat = !!opts.flat
    const row = doc.createElement('div')
    row.className = 'favorites-panel__row'
    row.setAttribute('data-row', '')
    row.setAttribute('data-id', node.id || '')
    row.style.paddingLeft = '6px'
    // 书签与文件夹都可拖（文件夹可拖进另一个文件夹 → 形成更深的嵌套）
    row.draggable = !flat
    if (isFolder) {
      row.classList.add('favorites-panel__row--folder')
      if (flat) {
        // 标签视图里的文件夹不是容器：点它不该触发"展开子项"（这里根本没有子项）
        row.setAttribute('data-flat', '1')
      } else if (isExpanded(node.id)) row.classList.add('open')
      row.setAttribute('data-folder-id', node.id)
      row.title = node.title || '(folder)'
    } else {
      row.setAttribute('data-url', node.url || '')
      row.setAttribute('data-title', node.title || '')
      // 打开偏好（默认在侧栏打开）随行携带：点击时作为去向规则的第 ② 层（修饰键压过它）
      row.setAttribute('data-open-in-sidebar', node.openInSidebar ? '1' : '')
      row.title = node.url || ''
    }

    // 选择复选框：多选态（或已有选中项）才并入 DOM —— 未多选时行首无复选框也无占位。
    // 用**原生 checkbox**（与历史面板同一套观感，不自绘蓝底白勾）；勾选态由 `selected`
    // 推导写入 `checked`，不靠控件自己记状态 —— 重画后不会与选中集差一拍。
    const check = doc.createElement('input')
    check.type = 'checkbox'
    check.className = 'favorites-panel__check'
    check.dataset.control = 'check'
    check.checked = selected.has(node.id)
    const showCheck = selectionMode || selected.size > 0

    // 箭头列只有文件夹需要；书签**不占位**（此前留的 16px 空槽是纯浪费，已去掉）。
    // 标签视图（flat）里文件夹不是容器 —— 不画箭头，它和书签一样只是一条结果行。
    if (isFolder) {
      if (showCheck) row.appendChild(check)
      if (!flat) {
        const t = doc.createElement('button')
        t.className = 'favorites-panel__toggle'
        t.dataset.action = 'toggle'
        t.dataset.id = node.id
        t.innerHTML = CHEVRON_SVG
        t.title = isExpanded(node.id) ? '折叠' : '展开'
        row.appendChild(t)
      }

      const fi = createFolderIcon(doc, { size: 15, className: 'favorites-panel__folder-ico' })
      row.appendChild(fi)
    } else {
      if (showCheck) row.appendChild(check)
      // 第 5 参 = 页面地址：缺 favicon 时由它推导众所周知的 /favicon.ico
      // （规则真源 shared-types/src/favicon-src.mjs，与 hira://bookmarks 页共用）
      row.appendChild(createFaviconBadge(doc, node.favicon, node.nickname || node.title, 16, node.url))
    }

    const label = doc.createElement('button')
    label.className = 'favorites-panel__label'
    // 昵称（N11）优先（与书签栏同一口径）；没设昵称则逐字回落标题/URL。
    label.textContent = node.nickname || node.title || (isFolder ? '(文件夹)' : node.url || '(未命名)')
    row.appendChild(label)

    if (isFolder) {
      // flat 行没有 children（来自扁平结果），数不出子项；不画假的「0 条」
      if (!flat) {
        const cnt = (node.children ? node.children.length : 0)
        const badge = doc.createElement('span')
        badge.className = 'favorites-panel__badge'
        badge.textContent = String(cnt)
        row.appendChild(badge)
      }
    } else {
      const edit = doc.createElement('button')
      edit.className = 'favorites-panel__btn'
      edit.appendChild(Pencil(doc, { size: 14 }))
      edit.title = '编辑书签'
      edit.dataset.action = 'edit'
      row.appendChild(edit)
    }

    // 拖拽的 dragstart/dragend/dragover/drop 全部在容器上委托（见下方 DnD 段），
    // 行级不再各挂一份监听 —— 行是整表重建的，逐行挂会在每次重绘时留下监听垃圾。
    return decorateRow(node, depth, row)
  }

  /**
   * 书签树行渲染插槽（`bookmark.tree-renderer-item`，REDUCE —— 逐层包裹）。
   *
   * **为什么是"包裹"而不是"替换"**：这一行承担着拖拽落点判定（容器上的委托会读
   * `data-row` / `data-id` / `data-url` / `data-folder-id`）、批量选择高亮、hover 反馈。
   * 若允许插件换掉行节点，它就等于必须逐个复刻这套属性契约 —— 漏一个的症状是
   * 「这一行拖不动了 / 点不动了」，而原因在插件里，宿主连线索都没有。
   *
   * 所以契约是：**行永远是宿主的行，插件只能在外面套一层自己的容器**。
   * 想往行里加东西（角标、状态点、图标）就是这一步的目的。
   *
   * 累加器形态 `{ node, depth, isFolder, element }`。插件可以返回一个新累加器
   * （把 `element` 换成包好的节点），也可以就地改 `element`；返回空值 = 这一层不做事。
   * 返回值不是元素时**回落原行**，绝不把行弄丢（少一行的书签树比没有插槽糟糕得多）。
   */
  function decorateRow(node: FavoriteNode, depth: number, row: HTMLElement): HTMLElement {
    if (!slots || typeof slots.reduce !== 'function') return row
    const out = slots.reduce('bookmark.tree-renderer-item', {
      node,
      depth,
      isFolder: !node.url,
      element: row
    })
    const el = out && typeof out === 'object' && 'element' in out ? (out as { element?: unknown }).element : null
    if (!(el instanceof HTMLElement) || el.nodeType !== Node.ELEMENT_NODE) return row
    if (el !== row && el.classList) {
      // 宿主给的类名只负责"排得进列表"，外观归插件（与下载角标同一条约定）
      el.classList.add('favorites-panel__row-slot')
    }
    return el
  }

  function renderList() {
    list.textContent = ''
    visibleIds = []
    // 草稿的父级没了解（被删 / 被搜索滤掉）→ 回根目录，绝不"输入框凭空消失"
    if (draft && draft.parentId && !findNode(draft.parentId)) draft.parentId = null

    // 标签视图：**跨文件夹的结果集**，按父文件夹分段成时间轴（见 renderTagList）
    if (activeTag) {
      renderTagList()
      return
    }

    // 常规视图：两个过滤轴叠加 —— 搜索词先滤树（保留祖先路径），再整表重建。
    const source = query ? filterTree(nodes, query) : nodes
    if (!source.length && !draft) {
      const empty = doc.createElement('div')
      empty.className = 'favorites-panel__empty'
      empty.textContent = query ? '没有匹配的收藏' : '暂无收藏'
      list.appendChild(empty)
      return
    }
    function buildLevel(children: readonly FavoriteNode[], depth: number, parentId: string | null) {
      const level = doc.createDocumentFragment()
      // 草稿行插在**它父级的第一个子项位置**（根目录 = 列表最前）
      if (draft && draft.parentId === parentId) level.appendChild(buildDraftRow())
      for (const node of children) {
        if (!node) continue
        if (node.id) visibleIds.push(node.id)
        const isFolder = !node.url
        if (isFolder) {
          const row = buildNodeRow(node, depth)
          level.appendChild(row)
          if (isExpanded(node.id)) {
            const branch = doc.createElement('div')
            branch.className = 'favorites-panel__branch'
            branch.appendChild(buildLevel(node.children || [], depth + 1, node.id))
            level.appendChild(branch)
          }
        } else {
          level.appendChild(buildNodeRow(node, depth))
        }
      }
      return level
    }

    const frag = doc.createDocumentFragment()
    frag.appendChild(buildLevel(source, 0, null))
    list.appendChild(frag)
    focusDraftIfNeeded()
  }

  /**
   * 标签视图（时间轴分段）。
   *
   * 为什么不是"过滤树"：过滤树会为了保留路径而留下**所有祖先文件夹**，
   * 于是列表里既有文件夹行又有它的子项 —— 与「整个文件夹被固定」的展示撞车，
   * 用户看不出哪一行是筛选结果、哪一行只是路径。
   *
   * 这里的语义只有一种：
   *   · 组头 = "这些条目原来在哪个文件夹"（可收起，带竖线串起下面各行）；
   *   · 行   = **自己带这个标签**的书签或文件夹（不带标签的祖先一律不出现）。
   */
  function renderTagList() {
    let rows = filterRowsByTag(flattenTree(nodes), activeTag) as FavoriteNode[]
    if (query) rows = rows.filter((row) => matchNode(row, query))
    const groups = groupRowsByFolder(rows, buildFolderLookup(nodes))

    if (!groups.length) {
      const empty = doc.createElement('div')
      empty.className = 'favorites-panel__empty'
      empty.textContent = query
        ? `没有同时匹配「${query}」和标签「${tagLabel(activeTag)}」的收藏`
        : `没有带「${tagLabel(activeTag)}」标签的收藏`
      list.appendChild(empty)
      return
    }

    const frag = doc.createDocumentFragment()
    for (const group of groups) {
      // 根目录组没有"来自哪个文件夹"可讲：直接平铺，不画组头、不画竖线、不可收起。
      if (group.id == null) {
        for (const row of group.rows) {
          if (row.id) visibleIds.push(String(row.id))
          frag.appendChild(buildNodeRow(row as FavoriteNode, 0, { flat: true }))
        }
        continue
      }
      const key = String(group.id)
      const collapsed = tagCollapsed.has(key)
      const box = doc.createElement('div')
      box.className = 'favorites-panel__tag-group' + (collapsed ? ' is-collapsed' : '')

      const head = doc.createElement('button')
      head.type = 'button'
      head.className = 'favorites-panel__tag-group-head'
      head.dataset.groupKey = key
      head.title = collapsed ? '展开这一组' : '收起这一组'
      const arrow = doc.createElement('span')
      arrow.className = 'favorites-panel__tag-group-arrow'
      arrow.innerHTML = CHEVRON_SVG
      const title = doc.createElement('span')
      title.className = 'favorites-panel__tag-group-title'
      title.textContent = group.path || group.title
      title.title = group.path || group.title
      const count = doc.createElement('span')
      count.className = 'favorites-panel__tag-group-count'
      count.textContent = String(group.rows.length)
      head.append(arrow, title, count)
      head.addEventListener('click', () => {
        if (tagCollapsed.has(key)) tagCollapsed.delete(key)
        else tagCollapsed.add(key)
        renderList()
      })
      box.appendChild(head)

      if (!collapsed) {
        const body = doc.createElement('div')
        body.className = 'favorites-panel__tag-group-body'
        for (const row of group.rows) {
          if (row.id) visibleIds.push(String(row.id))
          body.appendChild(buildNodeRow(row as FavoriteNode, 0, { flat: true }))
        }
        box.appendChild(body)
      }
      frag.appendChild(box)
    }
    list.appendChild(frag)
    focusDraftIfNeeded()
  }

  /** 刚打开就地命名草稿行 → 聚焦（仅首帧，避免每次重绘抢焦点） */
  function focusDraftIfNeeded() {
    if (draft && focusDraftNext) {
      focusDraftNext = false
      const el = list.querySelector<HTMLInputElement>('.favorites-panel__draft-input')
      if (el) { el.focus(); el.select() }
    }
  }

  function setItems(next: readonly FavoriteNode[]) {
    nodes = Array.isArray(next) ? next.slice() : []
    // 清理已不存在的选中 id（层级可能变化，避免残留幽灵选项）
    const alive = new Set<string>()
    ;(function collect(children: readonly FavoriteNode[]) {
      for (const node of children) {
        if (!node) continue
        if (node.id) alive.add(node.id)
        collect(node.children || [])
      }
    })(nodes)
    for (const id of [...selected]) if (!alive.has(id)) selected.delete(id)
    renderList()
    updateBatchBar()
  }

  /**
   * 搜索词入口 —— 面板自有搜索框的唯一落点（同时作为受控端口对外暴露）。
   * 输入框与本函数的搜索词**双向对齐**：外部调 setQuery 也会把词回填进框里，
   * 避免出现"列表在过滤、框里却是空的"这种两套真相。
   */
  function setQuery(next: unknown) {
    const raw = String(next == null ? '' : next)
    if (searchInput.value !== raw) searchInput.value = raw
    searchClear.hidden = !raw
    const q = raw.trim().toLowerCase()
    if (q === query) return
    query = q
    searchCollapsed.clear()
    renderList()
  }

  // ── 单事件委托 ─────────────────────────────────────
  wrap.addEventListener('click', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-row]')
    if (!row) return
    const id = row.getAttribute('data-id') || ''
    const url = row.getAttribute('data-url') || ''
    const btn = target?.closest<HTMLElement>('[data-action]')
    if (btn) {
      e.stopPropagation()
      const action = btn.getAttribute('data-action')
      if (action === 'toggle') { if (id) toggleExpand(id); return }
      if (action === 'edit') {
        onIntent({ type: 'edit', url, title: row.getAttribute('data-title') || '', id })
        return
      }
      return
    }
    // 复选框直接切换选择
    if (target?.closest('[data-control="check"]')) { toggleSelect(id); return }
    /**
     * **多选态** → 左键就是"点复选框"：切换这一行的选中状态，**不导航、不展开**。
     *
     * 这是"多选"的定义本身：进入多选的那一刻起，行上的点击就该用于选/取消选 ——
     * 否则用户得精准点中那个 14px 的小方格才能改主意，而点行其他地方会突然跳走页面。
     * 退出走批量条的 ✕（或工具栏「多选」再按一次），左键恢复为"打开"。
     */
    if (selectionMode) { toggleSelect(id); return }
    // 普通点击：书签→导航；文件夹→折叠/展开
    //
    // ⚠ Ctrl 在这里**不再是多选**：它是"在新标签页打开"（与书签栏同一条规则）。
    // 多选入口收敛为三处显式动作 —— 工具栏「多选」、行内复选框、右键菜单「选择」；
    // 隐式的 Ctrl 多选会与"Ctrl 点击开新标签"这条浏览器通用语义直接打架。
    if (url) {
      // 只上报**修饰键事实**：去向规则唯一一份（shift=侧栏 / ctrl=新标签 / 默认当前标签），
      // 见 ui-common#resolveBookmarkOpenTarget。
      onIntent({
        type: 'navigate',
        url,
        title: row.getAttribute('data-title') || '',
        preferSidebar: row.getAttribute('data-open-in-sidebar') === '1',
        modifiers: { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }
      })
    } else if (row.hasAttribute('data-flat')) {
      // 标签视图里的文件夹行：它是"自己带了这个标签"的一条结果，不是可展开的容器
      return
    } else if (row.hasAttribute('data-folder-id')) { if (id) toggleExpand(id) }
    else if (id) toggleSelect(id)
  })

  // 右键 → **只弹菜单**，不再顺带改选中集。
  //
  // 为什么改：右键曾是"勾上 / 取消勾选"的隐式快捷键，与"弹出上下文菜单"抢同一个手势 ——
  // 用户只想编辑一个书签，手一抖就先把它勾进批量里，接着菜单里的「删除…」变成
  // 「删除所选 N 项…」。现在两件事彻底分开：右键只出菜单，要选择走菜单里的「选择」
  //（与点行内复选框完全同一个动作，勾上后复选框列随之出现、可继续多选）。
  wrap.addEventListener('contextmenu', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-row]')
    if (!row) return
    e.preventDefault()
    const id = row.getAttribute('data-id') || ''
    const url = row.getAttribute('data-url') || ''
    const title = row.getAttribute('data-title') || ''
    onIntent({
      type: 'menu',
      item: { id, url, title },
      selectedIds: [...selected],
      activeTag,
      x: e.clientX,
      y: e.clientY
    })
  })

  // ── 拖拽 ───────────────────────────────────────────────────────────────────
  //
  // 三类落点（HTML5 DnD；拖动源 id 走闭包变量而不是 dataTransfer —— 与 opentabs
  // 的既有做法一致，dataTransfer 只用来让浏览器认这次拖拽是"可放置的"）：
  //   行上 1/4 带 → 插到该行之前    行下 1/4 带 → 插到该行之后
  //   文件夹行中间 1/2 带 → 放进这个文件夹（可嵌套到任意深度）
  // 多选时拖动任一已选中行 = 整批一起走。
  /** 本次拖动携带的 id 集（单选=1，多选=整批） */
  let dragIds: string[] = []
  /** 当前高亮的落点行与落点类型，用于最小化 DOM 操作 */
  let dropRow: HTMLElement | null = null
  let dropZone: DropZone = ''

  function setDropIndicator(row: HTMLElement | null, zone: DropZone) {
    if (dropRow === row && dropZone === zone) return
    clearDropIndicator()
    dropRow = row
    dropZone = zone
    if (!row || !zone) return
    row.classList.add(zone === 'into' ? 'drop-into' : zone === 'before' ? 'drop-before' : 'drop-after')
  }

  function clearDropIndicator() {
    if (dropRow) dropRow.classList.remove('drop-into', 'drop-before', 'drop-after')
    dropRow = null
    dropZone = ''
  }

  /** 在树里定位节点：返回自身、父级 id、以及**父级下的全部同级节点** */
  function locate(id: string): { node: FavoriteNode; parentId: string | null; siblings: readonly FavoriteNode[] } | null {
    let hit: { node: FavoriteNode; parentId: string | null; siblings: readonly FavoriteNode[] } | null = null
    ;(function walk(children: readonly FavoriteNode[], parentId: string | null) {
      for (const n of children) {
        if (!n || hit) continue
        if (n.id === id) { hit = { node: n, parentId, siblings: children }; return }
        walk(n.children || [], n.id)
      }
    })(nodes, null)
    return hit
  }

  /** targetId 是否在 rootId 的子树内（含自身）—— 用于阻止把文件夹拖进自己的后代 */
  function isWithin(rootId: string, targetId: string) {
    const root = locate(rootId)
    if (!root) return false
    let found = false
    ;(function walk(n) {
      if (!n || found) return
      if (n.id === targetId) { found = true; return }
      ;(n.children || []).forEach(walk)
    })(root.node)
    return found
  }

  /** 这批拖动的 id 会让 target 落点形成环吗（拖进自身/自己的后代） */
  function wouldCycle(parentId: string | null) {
    if (!parentId) return false
    return dragIds.some((id) => isWithin(id, parentId))
  }

  /**
   * 依据落点行算出目标父级与该父级下的完整新顺序。
   * orderedIds 必须是**全部**子节点的顺序 —— 主进程的 reorder 就按这个写入持久顺序。
   */
  function computeDrop(row: HTMLElement, zone: DropZone): FavoritePlacement | null {
    const id = row.getAttribute('data-id') || ''
    if (!id || dragIds.includes(id)) return null // 落到自己身上：什么也不做

    if (zone === 'into') {
      const hit = locate(id)
      if (!hit || hit.node.url) return null // 只有文件夹能承接"放进里面"
      if (wouldCycle(id)) return null
      const kids = (hit.node.children || []).map((node) => node.id).filter((id) => !dragIds.includes(id))
      return { parentId: id, orderedIds: kids.concat(dragIds), expandId: id }
    }

    const hit = locate(id)
    if (!hit) return null
    const parentId = hit.parentId
    if (wouldCycle(parentId)) return null
    const siblings = hit.siblings.map((node) => node.id).filter((id) => !dragIds.includes(id))
    const at = siblings.indexOf(id)
    if (at < 0) return null
    siblings.splice(zone === 'after' ? at + 1 : at, 0, ...dragIds)
    return { parentId, orderedIds: siblings }
  }

  wrap.addEventListener('dragstart', (e: DragEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-row]')
    if (!row) return
    const id = row.getAttribute('data-id') || ''
    if (!id) return
    // 多选时拖动选中的任意一行 = 整批拖（未选中则只拖它自己）
    dragIds = (selected.has(id) && selected.size > 1) ? [...selected] : [id]
    const dataTransfer = e.dataTransfer
    if (!dataTransfer) return
    try {
      // 条内是排序（move），拖到别处是搬运（copy）—— 两者都声明，落点才好选 dropEffect。
      dataTransfer.effectAllowed = 'copyMove'
      dataTransfer.setData('text/plain', dragIds.join(','))
      dataTransfer.setData('application/x-hira-favorite', JSON.stringify({ ids: dragIds }))
    } catch (_) {}
    // 统一协议（跨视图落点按 domain 分发）。多选时首个被拖项代表整批的"内容形状"，
    // 跨面板落库仍以单条为准（集锦/画板不接收批量 —— 批量移动只在收藏面板内部有意义）。
    const first = findNode(dragIds[0])
    setDragItem(dataTransfer, {
      domain: 'bookmark',
      id: dragIds[0],
      kind: first && first.url ? 'page' : 'folder',
      url: first && first.url ? first.url : '',
      title: first ? (first.nickname || first.title || '') : '',
      text: dragIds.length > 1 ? String(dragIds.length) : ''
    }, { plain: 'prefix' })
    for (const i of dragIds) {
      const r = list.querySelector(`[data-id="${cssEscape(i)}"]`)
      if (r) r.classList.add('dragging')
    }
  })

  wrap.addEventListener('dragend', () => {
    clearDropIndicator()
    for (const r of list.querySelectorAll('.dragging')) r.classList.remove('dragging')
    dragIds = []
  })

  wrap.addEventListener('dragover', (e: DragEvent) => {
    if (!dragIds.length) return
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-row]')
    if (!row) { clearDropIndicator(); return }
    const rect = row.getBoundingClientRect()
    const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
    const isFolder = row.hasAttribute('data-folder-id')
    const zone = isFolder
      ? (ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into')
      : (ratio < 0.5 ? 'before' : 'after')
    if (!computeDrop(row, zone)) { clearDropIndicator(); return }
    e.preventDefault()
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' } catch (_) {}
    setDropIndicator(row, zone)
  })

  wrap.addEventListener('dragleave', (e: DragEvent) => {
    // 只在真正离开容器时收线（行与行之间移动继续保留指示）
    const related = e.relatedTarget instanceof Node ? e.relatedTarget : null
    if (!wrap.contains(related)) clearDropIndicator()
  })

  wrap.addEventListener('drop', (e: DragEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-row]')
    const plan = row ? computeDrop(row, dropZone) : null
    clearDropIndicator()
    if (!plan) return
    e.preventDefault()
    if (plan.expandId) expanded.add(plan.expandId) // 放进折叠的文件夹 → 自动展开，让结果立刻可见
    onIntent({ type: 'drop', ids: [...dragIds], parentId: plan.parentId, orderedIds: plan.orderedIds })
    dragIds = []
  })

  /**
   * 单条「删除…」的二次确认。
   *
   * 确认 **走平台对话框**（`ctx.confirm` → 面板视图里就是 `hira://jsdialog` 浮层），
   * 而不是把这行就地换成一条"问话 + 取消/删除"的行内确认条：
   *   · 行内确认是第二套确认 UI —— 样式、层级、键盘、Esc、焦点都要自己再正确一遍；
   *   · 它与网页里 `confirm()`、与设置里那些确认框长得完全不一样（用户实测反馈的那一点）。
   * 用户点「删除」→ 弹框 → 确认后才真的发 intent。
   * @param {FavoriteItemRef} item
   */
  function confirmDelete(item: FavoriteItemRef): Promise<void> {
    if (!item || item.id == null) return Promise.resolve()
    // 文件夹删除连带子项，提示语区别
    const isFolder = !item.url
    const msg = isFolder
      ? `删除「${item.title || '文件夹'}」及其全部子项？`
      : `删除「${item.title || '(书签)'}」？`
    return askConfirm(msg).then((ok) => {
      if (ok) onIntent({ type: 'delete', id: item.id })
    })
  }

  /**
   * 批量条 / 多选菜单的「删除」确认：同样走平台对话框。
   * 确认 → 退出多选并整批删除；取消 → **什么都不动**（保留选中集，用户可继续挑）。
   * @param {string[]} ids
   */
  function confirmBatchDelete(ids: readonly string[]): Promise<void> {
    if (!ids || !ids.length) return Promise.resolve()
    if (ids.length === 1) {
      const item = findNode(ids[0])
      if (item) return confirmDelete(item)
    }
    const batch = ids.slice()
    return askConfirm(`删除所选 ${batch.length} 项（含文件夹子项）？`).then((ok) => {
      if (!ok) return
      exitSelection()
      onIntent({ type: 'delete-many', ids: batch })
    })
  }

  function findNode(id: string): FavoriteNode | null {
    let found: FavoriteNode | null = null
    ;(function walk(c) { for (const n of c) { if (found) return; if (n && n.id === id) found = n; if (n) walk(n.children || []) } })(nodes)
    return found
  }

  // 受控端口（组件零 IPC、不认识原生菜单，所有"外部发起"的动作都从这里进来）：
  //   toggleSelect  —— 右键菜单「选择」（与点复选框同一动作）
  //   newFolder     —— 面板内新建文件夹（工具栏 / 右键菜单 / 宿主创建失败重试）
  //   isSelected    —— 宿主画菜单时要问"这行选中了吗"
  return {
    element: wrap,
    setItems,
    setQuery,
    /** 标签分类栏数据（宿主随快照一起推下来；系统标签由真源派生，无需另算） */
    setTags,
    confirmDelete,
    confirmBatchDelete,
    toggleSelect: (id: string) => { if (id) toggleSelect(id) },
    newFolder: (parentId?: string | null, title?: string) => beginNewFolder(parentId || null, title || ''),
    /** 宿主删除某个用户标签后回调：若它正是当前筛选，退出该筛选。 */
    removeTag,
    isSelected: (id: string) => selected.has(String(id || ''))
  }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'favorites-panel',
  injectStyles: injectFavoritesPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as FavoritesPanelContext
    const { bridge, menu: menuClient } = panelCtx
    const bookmarksClient = panelCtx.clients?.bookmarks
    const tabsClient = panelCtx.clients?.tabs
    if (!bookmarksClient || !tabsClient || !bridge) {
      throw new Error('favorites panel requires bookmarks, tabs, and renderer bridge')
    }
    const bookmarkStore = bookmarksClient
    const rendererBridge = bridge

    const panel = createFavoritesPanel(doc, {
      slots: panelCtx.slots as FavoriteSlotsPort | undefined,
      // 删除确认的对话框端口（与应用内其它确认框同一套：`hira://jsdialog`）
      confirm: panelCtx.confirm,
      onIntent(intent: FavoriteIntent) {
        const { type, url, title, id, ids, item, selectedIds, x, y, parentId, orderedIds, modifiers, preferSidebar, pinned, tag, activeTag } = intent
        if (type === 'navigate' && url) {
          // 去向规则复用书签那一份（ui-common#resolveBookmarkOpenTarget），
          // 「去向 → 动作」的映射复用 ui-common#openBookmarkTarget。
          // 这里只交端口（新标签 / 侧栏），不在面板里另写一套判定。
          // Ctrl 新标签 / **Alt 独立侧栏** / Shift 侧栏 / 无修饰键**也新标签**
          // —— 面板是"查阅入口"，点开的东西不该顶掉用户正在看的页面。
          // Alt 在这里压过书签栏的「转到已有标签」语义：面板语境按用户口径以侧栏为准。
          const resolved = resolveBookmarkOpenTarget(modifiers, preferSidebar)
          const target = modifiers?.altKey
            ? 'sidebar'
            : resolved === 'current' ? 'tab' : resolved
          openBookmarkTarget(target, {
            url: String(url || ''),
            openTab: (u) => tabsClient.newTab({ url: u }),
            openSidebar: (u) => rendererBridge.provider.invoke('web-sidebar:open', { url: u, title: title || '' }).catch(() => {})
          })
        } else if (type === 'edit' && url) {
          rendererBridge.provider.invoke('window:open', { type: 'edit-bookmark', payload: { url, title } }).catch(() => {})
        } else if (type === 'create-folder') {
          // 面板内新建：domain 里「文件夹 = url 为空的收藏」，走与内部页同一条入口。
          // 失败则把名字回填进草稿行 —— 用户不必重打一遍（输入框才是最贵的输入）。
          bookmarkStore.createFolder({ title: title || '', parentId: parentId || null })
            .then(refresh)
            .catch(() => { panel.newFolder(typeof parentId === 'string' ? parentId : null, String(title || '')) })
        } else if (type === 'new-folder') {
          // 右键文件夹行「新建子文件夹…」—— 组件已把落点算好，宿主要做的只是打开草稿。
          panel.newFolder(typeof parentId === 'string' ? parentId : null)
        } else if (type === 'manage') {
          // 导入导出 / 备份 / 全量整理留在内部页：这些在 200~600px 里做不开。
          // 已有同页标签则切过去，否则新开 —— 不顶掉用户正在看的页面。
          openUrlPreferExistingTab(pageUrl('bookmarks'), tabsClient).catch(() => {})
        } else if (type === 'tag-window' && Array.isArray(ids) && ids.length) {
          // 批量 / 文件夹打标签 → 独立子窗口（面板里不再有浮层）
          openTagWindow(ids)
        } else if (type === 'tag-delete' && tag) {
          // 删除用户标签：全库摘除 → 面板退出该筛选并刷新分类栏
          const tagName = String(tag)
          bookmarkStore.tagDelete(tagName)
            .then(() => { panel.removeTag(tagName); refresh() })
            .catch(() => {})
        } else if (type === 'pinned-bulk' && Array.isArray(ids) && ids.length) {
          bookmarkStore.pinnedBulk(ids, !!pinned).then(refresh).catch(() => {})
        } else if (type === 'rail-bulk' && Array.isArray(ids) && ids.length) {
          bookmarkStore.railPinnedBulk(ids, !!pinned).then(refresh).catch(() => {})
        } else if (type === 'delete' && id != null) {
          bookmarkStore.remove(id).then(refresh).catch(() => {})
        } else if (type === 'delete-many' && Array.isArray(ids) && ids.length) {
          Promise.all(ids.map((i) => bookmarkStore.remove(i).catch(() => {})))
            .then(refresh).catch(() => {})
        } else if (type === 'move' && id != null) {
          bookmarkStore.move(id, parentId || null).then(refresh).catch(() => {})
        } else if (type === 'move-many' && Array.isArray(ids) && ids.length) {
          Promise.all(ids.map((i) => bookmarkStore.move(i, parentId || null).catch(() => {})))
            .then(refresh).catch(() => {})
        } else if (type === 'drop' && Array.isArray(ids) && ids.length) {
          handleDrop(ids, parentId || null, orderedIds)
        } else if (type === 'batch-move-menu' && Array.isArray(ids) && ids.length) {
          popMoveToMenu(ids, x || 0, y || 0)
        } else if (type === 'menu' && item) {
          showBookmarkMenu(item, selectedIds || [], x || 0, y || 0, activeTag || '')
        }
      }
    })

    let tree: FavoriteNode[] = [] // 完整书签树（bookmark:tree）

    /** 判断 targetId 是否落在以 rootId 为根的子树内（阻止把文件夹移入自身/后代造成环）。 */
    function isInSubtree(rootId: string, targetId: string) {
      const members = new Set<string>()
      let root: FavoriteNode | null = null
      ;(function locate(c) {
        for (const n of c) {
          if (root || !n) return
          if (n.id === rootId) { root = n; return }
          locate(n.children || [])
        }
      })(tree)
      ;(function collectSelf(n) {
        if (!n || members.has(n.id)) return
        members.add(n.id)
        ;(n.children || []).forEach(collectSelf)
      })(root)
      return members.has(targetId)
    }

    /** 过滤出可以安全移动到 parentId 的 id（文件夹移入自身/后代会产生环，跳过） */
    function safeMoveIds(ids: readonly string[], parentId: string | null): string[] {
      return (Array.isArray(ids) ? ids : []).filter((i) => {
        if (!parentId) return true
        const node = findNode(tree, i)
        // 仅文件夹有环风险；书签可直接移动
        return !node || node.url || !isInSubtree(i, parentId)
      })
    }

    /** 把一个书签/文件夹（或一批）移动到目标(可为 null=根目录)，然后刷新。
     *  文件夹移入自身/后代会产生环、破坏树渲染 —— 此处拦截跳过。 */
    function moveItems(ids: readonly string[], parentId: string | null) {
      const safe = safeMoveIds(ids, parentId)
      if (!safe.length) return Promise.resolve()
      return Promise.all(safe.map((i) => bookmarkStore.move(i, parentId).catch(() => {}))).then(refresh)
    }

    /**
     * 拖拽落点：先"搬家"，再按落点回传的完整顺序写一次 sort_order。
     *
     * 两个要点：
     *   1. 只有**父级真的变了**才发 move —— 同父级内拖动纯粹是排序，发 move 会白改
     *      modifiedAt（还让"最近修改"语义失真）。
     *   2. orderedIds 里被环保护刷掉的那些 id 要一并剔除，否则会给别的文件夹里的节点
     *      写上一个莫名其妙的顺序号。
     * 整批操作只刷新一次视图。
     */
    function handleDrop(ids: readonly string[], parentId: string | null, orderedIds?: readonly string[]) {
      const safe = safeMoveIds(ids, parentId)
      const needMove = safe.filter((i) => {
        const node = findNode(tree, i)
        return node && (node.parentId || null) !== parentId
      })
      const ordered = Array.isArray(orderedIds) && orderedIds.length
        ? orderedIds.filter((id) => safe.includes(id) || !ids.includes(id))
        : null
      Promise.all(needMove.map((i) => bookmarkStore.move(i, parentId).catch(() => {})))
        .then(() => (ordered ? bookmarkStore.reorder(parentId, ordered).catch(() => {}) : null))
        .then(refresh)
        .catch(() => {})
    }

    function findNode(nodes: readonly FavoriteNode[], id: string): FavoriteNode | null {
      let found: FavoriteNode | null = null
      ;(function walk(c) {
        for (const n of c) {
          if (found || !n) return
          if (n.id === id) found = n
          walk(n.children || [])
        }
      })(nodes)
      return found
    }

    /**
     * 递归构建「移动到文件夹」的子菜单：每个文件夹首行含「存入此文件夹」，其后是它的子文件夹。
     * 返回数组 → 直接可作为 popup-menu 的 items（含嵌套 submenu）。
     */
    function buildMoveSubmenu(folderId: string, folderName: string, children: readonly FavoriteNode[]): MenuItem[] {
      const out: MenuItem[] = [{ label: `存入「${folderName}」`, action: `move:${folderId}` }]
      const subF = children.filter((child) => !child.url)
      if (subF.length) out.push({ type: 'separator', action: null })
      for (const sf of subF) {
        const subSub = (sf.children || []).filter((child) => !child.url)
        out.push(
          (subSub.length
            ? { label: sf.title || '(文件夹)', type: 'submenu', submenu: buildMoveSubmenu(sf.id, sf.title || '(文件夹)', sf.children || []) }
            : { label: sf.title || '(文件夹)', action: `move:${sf.id}` })
        )
      }
      return out
    }

    /** 弹出「移动到…」子菜单（含根目录 + 递归文件夹路径）。 */
    function popMoveToMenu(ids: string[], x: number, y: number) {
      if (!menuClient) return
      const rootFolders = tree.filter((node) => !node.url)
      const moveItems0: MenuItem[] = [
        { label: '根目录', action: 'move-top' },
        { type: 'separator', action: null }
      ]
      for (const f of rootFolders) {
        const subSub = (f.children || []).filter((child) => !child.url)
        moveItems0.push(
          (subSub.length
            ? { label: f.title || '(文件夹)', type: 'submenu', submenu: buildMoveSubmenu(f.id, f.title || '(文件夹)', f.children || []) }
            : { label: f.title || '(文件夹)', action: `move:${f.id}` })
        )
      }
      menuClient.popupMenu({ items: [{ label: '移动到', type: 'submenu', submenu: moveItems0 }], x, y }).then((action) => {
        if (!action) return
        resolveMoveAction(action, ids)
      }).catch(() => {})
    }

    function resolveMoveAction(act: string, ids: readonly string[]) {
      if (act === 'move-top') moveItems(ids, null)
      else if (act && act.startsWith('move:')) moveItems(ids, act.slice('move:'.length))
    }

    /**
     * 打标签的唯一去向（面板里的所有「打标签…」入口都收敛到这里）：
     *   · 单条**书签** → 编辑窗口（标签就在表单里，和标题一起保存）
     *   · 文件夹 / 多选 → 批量打标签窗口
     * 一律开**子窗口** —— 面板里不再有浮层，写路径也统一由窗口走同一套 IPC。
     */
    function openTagWindow(ids: readonly string[]) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : []
      if (!list.length) return
      if (list.length === 1) {
        const node = findNode(tree, list[0])
        if (node && node.url) {
          rendererBridge.provider.invoke('window:open', {
            type: 'edit-bookmark',
            payload: { url: node.url, title: node.title }
          }).catch(() => {})
          return
        }
      }
      rendererBridge.provider.invoke('window:open', { type: 'tag-bookmarks', payload: { ids: list } }).catch(() => {})
    }

    // 书签右键菜单：单篇含 编辑/移动/删除；多选收敛为批量 移动/删除
    function showBookmarkMenu(
      item: FavoriteItemRef,
      selectedIds: readonly string[],
      x: number,
      y: number,
      viewTag: string
    ) {
      if (!menuClient) return
      const ids = selectedIds.length ? selectedIds.slice() : item.id ? [item.id] : []
      if (!ids.length) return
      const single = ids.length === 1
      const target = single ? item : { id: ids[0], url: item.url, title: item.title }

      const rootFolders = tree.filter((node) => !node.url)
      const moveItems0: MenuItem[] = [
        { label: '根目录', action: 'move-top' },
        { type: 'separator', action: null }
      ]
      for (const f of rootFolders) {
        const subSub = (f.children || []).filter((child) => !child.url)
        moveItems0.push(
          (subSub.length
            ? { label: f.title || '(文件夹)', type: 'submenu', submenu: buildMoveSubmenu(f.id, f.title || '(文件夹)', f.children || []) }
            : { label: f.title || '(文件夹)', action: `move:${f.id}` })
        )
      }

      const template: MenuItem[] = []
      // 「选择」—— 复选的**唯一菜单入口**（右键此前是隐式的复选快捷键，已挪到这里）。
      // 勾上后行内复选框列随之出现、可继续多选；对已选中的行再点一次即取消。
      if (item && item.id) {
        template.push({ label: panel.isSelected(item.id) ? '取消选择' : '选择', action: 'select' })
        template.push({ type: 'separator', action: null })
      }
      if (single && target.url) template.push({ label: '编辑…', action: 'edit' })
      // 文件夹行：就地建子文件夹（面板内命名，不跳书签页）
      if (item && item.id && !item.url) template.push({ label: '新建子文件夹…', action: 'new-folder' })
      // 「打标签…」—— 单条书签开编辑窗口，文件夹 / 多选开批量打标签窗口（见 openTagWindow）。
      if (item && item.id) template.push({ label: single ? '打标签…' : `给所选 ${ids.length} 项打标签…`, action: 'tag' })
      // 单一标签视图 = 这份菜单的上下文就是当前标签。系统标签与用户标签共用
      // 同一条 tagBulk(removeTags) 写路径，不再为 pinned / rail / 普通标签各写一套菜单动作。
      if (viewTag) {
        template.push({
          label: single
            ? `移除标签「${tagLabel(viewTag)}」`
            : `从所选 ${ids.length} 项移除标签「${tagLabel(viewTag)}」`,
          action: 'remove-view-tag'
        })
      }
      // 「在侧栏打开」—— 把这个书签放进**独立侧栏**（与面板无关的另一套系统，Vivaldi 同款）。
      // 只要求"目标行是真书签"：右键会顺带改变选中集，多选时若要求单选，这一项会时有时无
      //（用户感受就是"菜单里怎么没了"）—— 作用于**被右键的那一行**才是符合直觉的语义。
      if (target.url) template.push({ label: '在侧栏打开', action: 'open-sidebar' })
      // 「固定到书签栏 / 取消固定」—— 书签**与文件夹**都能固定：这是把文件夹挂到书签栏的入口。
      // 固定位只有一条通道、一张表（`bookmark:pinned-set`），判据唯一一份
      // （ui-common#isPinnableToBookmarkbar，真源 shared-types#bookmarkbar）。
      const pinnedNode = item && item.id ? findNode(tree, item.id) : null
      if (viewTag !== SYSTEM_TAGS[0].id && isPinnableToBookmarkbar(pinnedNode || item)) {
        template.push({ label: pinnedNode && pinnedNode.pinned ? '从书签栏取消固定' : '固定到书签栏', action: 'toggle-pin' })
      }
      // 「固定到侧栏图标栏」—— 与书签栏固定位**相互独立**（railPinned 列），也是第二种系统标签。
      if (pinnedNode && viewTag !== SYSTEM_TAGS[1].id) {
        template.push({
          label: pinnedNode.railPinned ? '从侧栏图标栏取消固定' : '固定到侧栏图标栏',
          action: 'toggle-rail'
        })
      }
      template.push({ type: 'separator', action: null })
      template.push({ label: '移动到', type: 'submenu', submenu: moveItems0 })
      template.push({ type: 'separator', action: null })
      template.push({ label: single ? '删除…' : `删除所选 ${ids.length} 项…`, action: 'delete' })

      menuClient.popupMenu({
        items: template,
        x,
        y,
        // 官方插槽 bookmark.context-menu：插件贡献的菜单项由**主进程**追加到菜单尾部，
        // 点击也在主进程内派发（onSelect 是主进程里的闭包），因此不会走下面的 action 分支。
        context: {
          kind: 'bookmark',
          snapshot: {
            bookmark: {
              id: item.id,
              url: item.url || '',
              title: item.title || '',
              parentId: item.parentId || null,
              isFolder: !item.url
            },
            selectedIds: ids.slice(),
            source: 'panel'
          }
        }
      }).then((act) => {
        if (!act) return
        if (act === 'select') {
          // 与点行内复选框**同一个动作**（组件内部同一条 toggleSelect），只是入口在菜单里。
          if (item.id) panel.toggleSelect(item.id)
        } else if (act === 'edit') {
          rendererBridge.provider.invoke('window:open', { type: 'edit-bookmark', payload: { url: item.url, title: item.title } }).catch(() => {})
        } else if (act === 'new-folder') {
          if (item.id) panel.newFolder(item.id)
        } else if (act === 'open-sidebar') {
          // 通道名见 `shared-types/src/ipc-channels.mjs#webSidebarOpen`（本包没有 shared-types 依赖，
          // 故与上面那条 'window:open' 同一口径：就地写通道字符串）。主进程负责"造/加载侧栏视图"。
          rendererBridge.provider.invoke('web-sidebar:open', { url: item.url, title: item.title }).catch(() => {})
        } else if (act === 'remove-view-tag' && viewTag) {
          bookmarkStore.tagBulk(ids, { removeTags: [viewTag] }).then(refresh).catch(() => {})
        } else if (act === 'toggle-pin') {
          // 固定 / 取消固定：**同一条通道、同一张表**，文件夹与书签一视同仁。
          const node = item && item.id ? findNode(tree, item.id) : null
          if (node) bookmarkStore.pinnedSet(node.id, !node.pinned).then(refresh).catch(() => {})
        } else if (act === 'toggle-rail') {
          // rail 固定位是另一列（railPinned），与书签栏互不影响。
          const node = item && item.id ? findNode(tree, item.id) : null
          if (node) bookmarkStore.railPinnedSet(node.id, !node.railPinned).then(refresh).catch(() => {})
        } else if (act === 'tag') {
          openTagWindow(ids)
        } else if (act === 'move-top') {
          moveItems(ids, null)
        } else if (act && act.startsWith('move:')) {
          moveItems(ids, act.slice('move:'.length))
        } else if (act === 'delete') {
          if (single) panel.confirmDelete(item)
          else panel.confirmBatchDelete(ids)
        }
      }).catch(() => {})
    }

    // 完整树 → 抽取出「子菜单要展示的文件夹集合」：popMoveToMenu / showBookmarkMenu 直接消费 tree
    // 走聚合快照（一次 IPC / 一次 SELECT）：首屏与变更刷新都只发一条请求，
    // 不再 tree + pinned 各拉一遍；`folders` 就是同一时刻一致的全量树。
    async function refresh() {
      const snap = await bookmarkStore.snapshot().catch(() => null)
      tree = Array.isArray(snap?.folders) ? snap.folders : []
      // 树与标签计数来自**同一次**快照 SELECT —— 分类栏的数字不会领先/落后于列表
      panel.setTags(Array.isArray(snap?.tags) ? snap.tags : [])
      panel.setItems(tree)
    }

    refresh()
    // 任何来源的书签变更（星标 / Ctrl+D / 书签页 / 编辑器）→ 实时对账刷新
    const offChanged = bookmarkStore.onChanged(() => { refresh() })

    return {
      element: panel.element,
      refresh,
      setQuery: panel.setQuery,
      dispose() {
        offChanged()
      }
    }
  }
}

/**
 * 书签面板 —— 对外装配入口。
 *
 * `favorites-panel` 就是「收藏」（书签树、拖拽、右键菜单、批量、检索）本身；
 * 集锦 / 稍后读 / 回收站住在独立的 `notes-panel`（见 plugins/panel-notes.renderer.js）。
 * 需要一份书签视图时只需 `createBookmarksView(doc, ctx)`，不必再复制一份 mount 逻辑。
 */
export function createBookmarksView(doc: Document, ctx: PanelContext = {}) {
  return panelDefinition.mount(doc, ctx)
}
