// @ts-check
/**
 * @hira-ng/ui-bookmarkbar —— 书签栏（pinned bookmarks bar）
 *
 * 与 ui-navbar / ui-tabbar 同构的**哑组件**：
 *   - 状态上行：编排层查库后经 setItems()/setVisible() 推下来
 *   - 意图下行：点击 / 右键 / 拖拽重排只上抛意图，不做任何书签操作
 *   - 零 IPC / 零 electron —— 可被纯 DOM 测试全量驱动
 *
 * 交互（对齐老版 Hira pinnedBookmarksBar 的核心能力，砍掉冗余）：
 *   · 左键点击书签 → onNavigate(item, modifiers)（带修饰键：shift=侧栏 / ctrl=新标签 / alt=转到已有，见编排层）
 *   · 左键点击文件夹 → onOpenFolder(item, anchorRect)（**只上抛意图**：弹列表是编排层/浮层的事，
 *     本组件零 IPC —— 文件夹在数据里就是 `url` 为假的节点）
 *   · 右键         → onContextMenu(item, {x, y})（菜单由编排层用原生 Menu 呈现）
 *   · 拖拽排序     → onReorder(orderedIds)（完整新顺序，落点由编排层定夺）
 *   · 无固定书签时 → 空 element（高度 0，不占视觉空间）
 */

// 滚动条（溢出策略 / 滚动条外观 / 滚轮 → 主轴换算）与标签条、纵向标签列共用同一份实现。
// 这一份必须共用：横向溢出的条，普通滚轮（只带 deltaY）在 Chromium 里**不会**横滚，
// 缺了「滚轮换算」那一环的表现就是「书签多到溢出，滚轮却滚不动」。
import { createStripScroller, injectStripScrollerStyles, createFolderIcon, setDragItem, getDragItem, hasDragItem, pickDropEffect } from '@hira-ng/ui-common'
import { createFaviconImg, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
// 首字兜底必须显式指定字体（纯文字节点，继承链可能落到系统默认宋体点阵）。
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack.mjs'

export interface BookmarkbarItem {
  id: string
  title: string
  url?: string | null
  favicon?: string | null
  nickname?: string | null
  children?: BookmarkbarItem[]
}

export interface BookmarkbarModifiers {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface ExternalBookmarkDropItem {
  domain: string
  id: string
  kind: string
  url: string
  title: string
  text?: string
}

export interface BookmarkbarHandlers {
  onNavigate?: (item: BookmarkbarItem, modifiers: BookmarkbarModifiers) => void
  onOpenFolder?: (item: BookmarkbarItem, anchorRect: DOMRect) => void
  onFolderIntent?: (item: BookmarkbarItem) => void
  onContextMenu?: (item: BookmarkbarItem, position: { x: number; y: number }) => void
  onReorder?: (orderedIds: string[]) => void
  onExternalDrop?: (item: ExternalBookmarkDropItem, position: { x: number; y: number }) => void
}

export interface BookmarkbarController {
  readonly element: HTMLElement
  setItems(items: BookmarkbarItem[]): void
  setVisible(visible: boolean): void
  isVisible(): boolean
}

/** 注入书签栏样式（幂等）。 */
export function injectBookmarkbarStyles(doc: Document): void {
  injectStripScrollerStyles(doc)
  if (doc.getElementById('hira-bookmarkbar-styles')) return
  const style = doc.createElement('style')
  style.id = 'hira-bookmarkbar-styles'
/*
   * ⚠ 下面的 CSS 写在模板字面量里：**注释中绝不能出现反引号**（它会提前闭合字符串，
   *   轻则 Rollup 报语法错，重则运行时变成「那段 CSS is not a function」）。
   *   要在注释里提选择器，直接裸写（#tabs-inner）或加书名号，**不要用反引号**。
   */
  style.textContent = `
    .bookmarkbar {
      display: none;
      align-items: stretch;
      /* **吃满整行**：宿主那一条是 flex 行（.chrome-band），不写这条的话本元素只占
         「内容宽」—— 书签右侧那片空白根本不属于它，于是既拖不动窗口、也不参与任何排版。
         标签条同样写着 flex: 1（见 ui-tabbar 的 #tabs），此处对齐。
         min-width: 0 是配套的：flex 项默认最小宽度 = 内容宽，书签多时会顶破整行。 */
      flex: 1 1 auto;
      min-width: 0;
      /* 上下各留 3px：书签行（stretch 到内容高）不再贴住书签栏的上下边缘。
         高度 28px ⇒ 行本身 22px。曾经是 34/28 —— 用户反馈"书签栏与书签项都太厚"，
         这里整体收薄 6px（行高、行内左右缩进、行距同步收一点，见 .bookmarkbar__item）。 */
      height: 28px;
      padding: 3px 6px;
      /* 空白处可拖窗口（与横向标签条同一套口径）：**本容器是拖拽区**，
         真正滚动的内容在 .bookmarkbar__strip 里（它 no-drag）—— 于是
         「空白拖窗口 + 书签照常点 / 照常滚」三件事同时成立。
         空白由 ::after 的**拖拽填充块**接住（见下），写法与标签条一致。 */
      -webkit-app-region: drag;
      /* 底色用 --main-bg-color（**chrome 底色**）而不是 --hira-bg-surface：
         两者在不带壁纸时是同一个值（主题主背景），但带壁纸时前者是 transparent ——
         书签栏属于 chrome，必须与 navbar/tabbar 一起变成玻璃，
         不能自己留一块不透明色块（否则整条工具栏就那一截挡着壁纸）。
         详见 docs-ng 主题系统设计.md §6.2。 */
      background: var(--main-bg-color, var(--bg-color, transparent));
      /* 不画底分割线（用户口径）：这一条横带与它下面的内容共用同一层玻璃遮罩，
         再压一条 1px 线只是多一道缝 —— 与纵排形态（下面那条规则原本显式写
         border-bottom: none）取同一种长相，两态一致。 */
      user-select: none;
    }
    .bookmarkbar.visible { display: flex; }
    /* 按钮编辑是临时“全界面展开”态：空书签栏或“仅新标签页”模式也必须露出
       占位 bar，否则没有可拖放对象。该规则只依赖全局编辑态，不改用户设置。 */
    body.hira-buttons-editing .bookmarkbar { display: flex; }

    /*
     * 滚动条（真正滚动的那个元素）—— 与标签条 #tabs-inner 同构：
     * 只占**内容宽**（flex: 0 1 auto），不够宽时收缩到可用宽、在自己内部横向滚动。
     *
     * 为什么必须显式让出拖拽：本层在 .bookmarkbar 的拖拽区里，而 Chromium 把拖拽区
     * 当窗口非客户区 —— 滚轮 / mousedown / click 根本不进渲染进程（表现就是滚动条
     * 点不到、滚不动、指针一移上去滑块就消失）。让出的那段空白由 ::after 接回。
     */
    .bookmarkbar__strip {
      display: flex;
      align-items: stretch;
      gap: 2px;
      flex: 0 1 auto;
      min-width: 0;
      /* 溢出策略与滚动条外观**不在这里**：横竖两种模式共用同一份，见
         @hira-ng/ui-common 的 stripScroller（装配处 createStripScroller(strip, 'x')）。
         它同时给了「滚轮 → 主轴」的换算 —— 横向溢出的条，普通滚轮（只有 deltaY）
         在 Chromium 里本来是不会横滚的，缺了那一环就是「滚不动」。 */
      /* 但滚动条**本栏不显示**（与改动前一致）：它藏在行底下会占走 4px，
         让书签行在"刚好溢出"那一刻突然矮一截。滚动靠滚轮 —— 观感与之前一模一样。 */
      scrollbar-width: none;
      -webkit-app-region: no-drag;
    }
    .bookmarkbar__strip::-webkit-scrollbar { display: none; }

    /* 书签右侧的空白 = **窗口拖拽区**（与标签条 #tabs::after 同一套写法）。
       它是 .bookmarkbar 自己的 flex 项、不是滚动容器里的东西：拖拽区**先于**交互控件
       算出来，语义最干净；书签溢出时它收缩为 0 —— 既不盖住滚动条，也不给滚动多加假距离。 */
    .bookmarkbar::after {
      content: '';
      flex: 1 1 0;
      min-width: 0;
      -webkit-app-region: drag;
    }

    /* 住在侧栏里（宿主轴 = 纵排）时的形态：横排一行 → 纵向列表。
       这是**块自己的**事：摆放容器只打 data-host-axis 标记、不认识书签栏，
       书签栏也不认识容器 —— 换区域不改任何一方的代码。
       flex:1 让它吃满侧栏剩余高度（与标签列表同一套口径：块自己决定占多少）。
       纵排下「填满剩余高度」的是滚动条自己（填充块不参与：没有横向空白可言）。 */
    .bookmarkbar[data-host-axis="column"] {
      /* flex: 1 1 auto（吃满剩余高度）已由上面的基础规则给出 —— 横竖两种形态都一样。 */
      flex-direction: column;
      align-items: stretch;
      height: auto;
      min-height: 0;
      padding: 6px;
    }
    .bookmarkbar[data-host-axis="column"]::after { display: none; }
    .bookmarkbar[data-host-axis="column"] > .bookmarkbar__strip {
      flex: 1 1 auto;
      flex-direction: column;
      gap: 1px;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .bookmarkbar[data-host-axis="column"] .bookmarkbar__item {
      max-width: none;
      width: 100%;
      border-radius: var(--hira-radius-xs, 6px);
    }

    .bookmarkbar__item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 160px;
      padding: 0 7px;
      border: none;
      border-radius: var(--hira-radius-2xs, 4px);
      background: transparent;
      color: var(--hira-text-primary, var(--text-color, inherit));
      font-size: 12px;
      line-height: 18px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      /* 书签本身是交互控件 → 让出窗口拖拽（容器才是拖拽区，见 .bookmarkbar）。
         横排（顶部一条）与纵排（住侧栏）两种形态用同一条口径。 */
      -webkit-app-region: no-drag;
    }
    .bookmarkbar__item:hover { background: var(--hira-hover-bg, rgba(128,128,128,0.15)); }
    /* 拖拽落点定位条：画在**指针所在的那半区** —— 左半区 → 项前，右半区 → 项后。
       与落库判定同源（见 resolveDrop）：线画在哪，松手就落在哪。
       旧实现只有「项前」一种线，于是往后（向右）拖时线出现在目标项**前面**，
       与松手后真正落下的位置对不上 —— UI 在说谎。 */
    .bookmarkbar__item.drag-over[data-drop-side='before'] {
      box-shadow: -2px 0 0 0 var(--hira-accent, #3b82f6);
    }
    .bookmarkbar__item.drag-over[data-drop-side='after'] {
      box-shadow: 2px 0 0 0 var(--hira-accent, #3b82f6);
    }
    .bookmarkbar__item.dragging { opacity: 0.4; }

    .bookmarkbar__favicon {
      width: 14px;
      height: 14px;
      border-radius: 3px;
      flex-shrink: 0;
      object-fit: cover;
    }
    .bookmarkbar__favicon-fallback {
      width: 14px;
      height: 14px;
      border-radius: 3px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: ${uiFontVar()};
      font-size: 9px;
      font-weight: 600;
      background: var(--hira-hover-bg, rgba(128,128,128,0.2));
      color: var(--hira-text-secondary, #888);
    }
    /* 文件夹项图标：与收藏面板**同一个字形**（ui-common#createFolderIcon），
       这里只负责它的排版（尺寸 + 主题次要前景色）。 */
    .bookmarkbar__folder-ico {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--hira-text-secondary, var(--text-color, #888));
    }
    .bookmarkbar__folder-ico svg { width: 14px; height: 14px; }
    .bookmarkbar__title { overflow: hidden; text-overflow: ellipsis; }
  `
  doc.head.appendChild(style)
}

/** 「插到目标项前/后」→ 新 id 顺序；纯函数，不碰 DOM。 */
function reorderIds(ids: string[], draggedId: string, targetId: string | null, after: boolean): string[] {
  if (ids.indexOf(draggedId) < 0) return ids.slice()
  const rest = ids.filter((id) => id !== draggedId)
  if (targetId == null) return rest.concat(draggedId)
  const anchor = rest.indexOf(targetId)
  if (anchor < 0) return ids.slice()
  rest.splice(anchor + (after ? 1 : 0), 0, draggedId)
  return rest
}

/** 创建书签栏；只上抛交互意图，不持有持久化状态。 */
export function createBookmarkbar(doc: Document, handlers: BookmarkbarHandlers = {}): BookmarkbarController {
  const bar = doc.createElement('div')
  bar.className = 'bookmarkbar'
  /**
   * 内侧的**滚动条**（真正滚动的元素）—— 与标签条的 `#tabs-inner` 同构。
   *
   * 为什么必须分成两层：拖拽区会吃掉指针事件（滚动条点不到、滚轮进不来），
   * 而"空白拖窗口"又想留着 —— 把「可滚的书签」与「空白」拆成两个元素，
   * 才谈得上「空白拖窗口 + 书签照常点 / 照常滚」。
   */
  const strip = doc.createElement('div')
  strip.className = 'bookmarkbar__strip'
  // 挂上共享滚动区：溢出策略 + 滚动条外观 + 「滚轮 → 主轴」换算都在那一份实现里
  // （书签多到溢出时，普通滚轮可直接横推 —— 这正是"没反应"缺的那一环）。
  createStripScroller(strip, 'x')
  bar.appendChild(strip)
  bar.id = 'bookmark-bar'

  let items: BookmarkbarItem[] = []
  /**
   * 上一次真正重绘时用过的「内容签名」。
   *
   * 为什么需要：`setItems` 的调用方（bookmark-controller）在**每次切标签**时都会推一遍
   * （书签栏的显隐跟着导航走），而书签项本身与标签无关。原来无条件清空 + 全量重建，
   * 于是切一次标签就要重插一遍 DOM、把每个 favicon 的 `src` 重设一次
   * （浏览器重新解码 + 肉眼可见的一闪）—— 纯白付，且发生在最高频的路径上。
   */
  let appliedSig = ''
  let visible = false
  /** @type {string|null} */
  let dragId: string | null = null
  /**
   * 项元素缓存（顺序 = items 顺序）。
   * 落点判定在 dragover 里逐帧要量矩形，不能每次都查一遍 DOM；
   * 列表由 setItems 整体重绘，缓存点也就只有一处需要同步。
   * @type {HTMLElement[]}
   */
  let itemEls: HTMLElement[] = []

  /**
   * 此刻是否**真的可见**（有内容 + 被允许显示）—— `.visible` 类就是按它切的。
   *
   * 单独抽出来是因为外部（编排层）也要问同一个问题：不可见的块不该参与外壳布局
   * ——它会在布局容器里占着空行，让底部留白之类的容器级样式在「一块 bar 都没有」
   * 时凭空多出来。判据只有一份，两边不会漂移。
   */
  function isShown() {
    return visible && items.length > 0
  }

  /** 空书签栏不占视觉空间：有内容且被允许显示时才展开 */
  function applyVisibility() {
    bar.classList.toggle('visible', isShown())
  }

  function buildItem(item: BookmarkbarItem): HTMLButtonElement {
    const el = doc.createElement('button')
    el.className = 'bookmarkbar__item'
    el.dataset.id = item.id
    el.draggable = true
    // 文件夹 = `url` 为假的节点（与收藏面板同一判据：node = {id,title,url,favicon,children}）。
    const isFolder = !item.url
    el.title = isFolder ? (item.title || '') : `${item.title}\n${item.url || ''}`

    if (isFolder) {
      // 文件夹图标取自**共用那一份**（ui-common#createFolderIcon）——绝不在这里另画一遍。
      el.appendChild(createFolderIcon(doc, { size: 14, className: 'bookmarkbar__folder-ico' }))
    } else if (item.url) {
      // 与内部页 / 面板共用同一条来源链：主进程代理 → 站点原始图标 → 首字。
      const candidates = faviconSourceCandidates(item.url, item.favicon ?? null)
      if (!candidates.primary) {
        el.appendChild(makeFallback(item.nickname || item.title))
      } else {
        const img = createFaviconImg(doc, candidates, {
          size: 14,
          className: 'bookmarkbar__favicon',
          borderRadius: 3,
          onFail: () => img.replaceWith(makeFallback(item.nickname || item.title))
        })
        el.appendChild(img)
      }
    } else {
      el.appendChild(makeFallback(item.nickname || item.title))
    }

    const title = doc.createElement('span')
    title.className = 'bookmarkbar__title'
    // 昵称（N11）优先：窄书签栏放不下长标题时用短名；没设昵称则逐字回落标题/URL。
    title.textContent = item.nickname || item.title || item.url || ''
    el.appendChild(title)

    el.addEventListener('click', (e) => {
      // 只上报**修饰键事实**（含 Alt：`tab-or-existing` 那条去向要用它）。"往哪儿开"的策略
      // 不在这里 —— 唯一一份规则见 ui-common#resolveBookmarkOpenTarget / #openBookmarkTarget。
      const modifiers = { shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey }
      if (isFolder) {
        // 文件夹：只上抛「打开这个文件夹」的意图 + 它**自己的锚点矩形**（浮层列表贴着它下缘弹）。
        // 本组件零 IPC —— 弹列表、取内容都是编排层与浮层的事。
        if (typeof handlers.onOpenFolder === 'function') handlers.onOpenFolder(item, el.getBoundingClientRect())
        return
      }
      if (typeof handlers.onNavigate === 'function') handlers.onNavigate(item, modifiers)
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (typeof handlers.onContextMenu === 'function') {
        handlers.onContextMenu(item, { x: e.clientX, y: e.clientY })
      }
    })

    // 意图信号：文件夹项在指针进入时上报 —— 编排层据此预热「选择目标」浮层 + 预取子项。
    // 只对文件夹接线：普通书签点了就跳转，没有浮层可预热。
    const onFolderIntent = handlers.onFolderIntent
    if (isFolder && onFolderIntent) {
      el.addEventListener('pointerenter', () => onFolderIntent(item))
    }

    // ── 原生 HTML5 DnD：轻量重排，无需指针手势库 ──
    // 这里只登记**拖拽源**；落点判定统一在条级委托里做一次（见下面的 DnD 段）——
    // 每个项各判一次的话，「空白处」就没人管，而且线与落库容易判成两个口径。
    el.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return
      dragId = item.id
      el.classList.add('dragging')
      // 统一协议 + `text/plain` 兜底给 URL（外部应用可用）；内部重排只读闭包 dragId。
      setDragItem(e.dataTransfer, {
        domain: 'bookmark',
        id: item.id,
        kind: isFolder ? 'folder' : 'page',
        url: item.url || '',
        title: item.nickname || item.title || ''
      }, { effectAllowed: 'copyMove', plain: 'url' })
    })
    el.addEventListener('dragend', () => {
      dragId = null
      el.classList.remove('dragging')
      clearDrop()
    })

    return el
  }

  // ── 拖动落点（条级委托，只注册一次）────────────────────────────────────
  // 判据与 tabbar / 面板列表保持一致：**指针落在目标项的左半区 → 插到它前面；
  // 右半区 → 插到它后面**。定位线画在哪、松手落到哪，都由 resolveDrop 一个函数回答 ——
  // 两处各判一次，就会出现「线画在右边、项却停在原处」这种 UI 在说谎的情况。

  /**
   * @param {number} clientX
   * @returns {{ targetId: string|null, after: boolean }} targetId=null → 落在末尾
   */
  function resolveDrop(clientX: number): { targetId: string | null; after: boolean } {
    for (const el of itemEls) {
      // 跳过拖动源自己：它仍留在流里。跳过之后，「指针压在它自己身上」会自然落到
      // 相邻项上（= 保持原位），与落库结果一致。
      if (el.dataset.id === dragId) continue
      const r = el.getBoundingClientRect()
      // 指针在某项左边缘之前（缝隙 / 条首空白）→ 插到这一项前面
      const targetId = el.dataset.id
      if (!targetId) continue
      if (clientX < r.left) return { targetId, after: false }
      if (clientX <= r.right) {
        return { targetId, after: clientX > r.left + r.width / 2 }
      }
    }
    // 越过最后一项的右边缘（条尾空白）→ 末尾。这正是「一直往后拖」的终点，
    // 旧实现只在项上有监听，拖到空白处既没有反馈、松手也不动。
    return { targetId: null, after: true }
  }

  /** 收掉所有落点标记（类 + data 属性一起收，避免残留的半区样式）。 */
  function clearDrop() {
    for (const el of itemEls) {
      el.classList.remove('drag-over')
      delete el.dataset.dropSide
    }
  }

  /** 按落点画定位条。 */
  function paintDrop(at: { targetId: string | null; after: boolean }) {
    clearDrop()
    if (!at) return
    // 末尾（targetId=null）用最后一项的右边缘画线；列表为空则无处可画。
    const el = at.targetId
      ? itemEls.find((node) => node.dataset.id === at.targetId)
      : itemEls[itemEls.length - 1]
    if (!el) return
    el.classList.add('drag-over')
    el.dataset.dropSide = at.after ? 'after' : 'before'
  }

  bar.addEventListener('dragover', (e) => {
    if (!dragId) {
      // 外部拖入（标签 / 集锦 / 历史 / 画板 / 链接）：认领统一协议，给"复制"光标。
      if (!hasDragItem(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = pickDropEffect(e.dataTransfer, 'copy')
      clearDrop()
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    paintDrop(resolveDrop(e.clientX))
  })

  bar.addEventListener('dragleave', (e) => {
    // 项与项之间移动同样会触发 dragleave，那一下收线会让定位条闪一下。
    // 判据用**指针是否仍在条的矩形内**，不用 relatedTarget —— 拖拽事件的
    // relatedTarget 在各版本里时有时无，靠它会间歇性收错线。
    const r = bar.getBoundingClientRect()
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) clearDrop()
  })

  bar.addEventListener('drop', (e) => {
    if (!dragId) {
      if (!e.dataTransfer || !hasDragItem(e.dataTransfer)) return
      e.preventDefault()
      const item = getDragItem(e.dataTransfer) as ExternalBookmarkDropItem | null
      clearDrop()
      if (item && item.url && typeof handlers.onExternalDrop === 'function') {
        handlers.onExternalDrop(item, { x: e.clientX, y: e.clientY })
      }
      return
    }
    e.preventDefault()
    const draggedId = dragId
    const at = resolveDrop(e.clientX)
    clearDrop()
    // 先收干净状态，再上抛意图 —— 编排层会回灌新顺序并整体重绘（本组件无自持状态）。
    dragId = null
    if (typeof handlers.onReorder === 'function') {
      handlers.onReorder(reorderIds(items.map((it) => it.id), draggedId, at.targetId, at.after))
    }
  })

  function makeFallback(title?: string | null) {
    const span = doc.createElement('span')
    span.className = 'bookmarkbar__favicon-fallback'
    span.textContent = (title || '?').trim().charAt(0).toUpperCase() || '?'
    return span
  }

  return {
    element: bar,
    /**
     * 全量重绘固定书签（列表小，直接重建；避免 diff 复杂度）。
     *
     * **内容没变就不重建**：判据是 id/标题/图标/地址四者的拼接签名 ——
     * 切标签这类"只是把同一份列表又推了一遍"的调用会走 `applyVisibility()` 直接返回
     * （见 `appliedSig` 的说明）；真改了标题、换了图标、增删了书签时签名变化，照常重绘。
     */
    setItems(next: BookmarkbarItem[]) {
      const list = Array.isArray(next) ? next : []
      items = list
      // 签名要覆盖 `buildItem` 真正读到的**全部**字段（含降级用的 nickname），
      // 少一个就可能出现"数据变了但界面不重绘"的僵化。
      const sig = list
        .map((it) => `${(it && it.id) || ''}|${(it && it.title) || ''}|${(it && it.url) || ''}|${(it && it.favicon) || ''}|${(it && it.nickname) || ''}`)
        .join('\n')
      if (sig !== appliedSig) {
        appliedSig = sig
        // 重绘前先把落点标记收掉：旧节点被替换后，标记与缓存都会指向游离节点。
        clearDrop()
        // 清的是**滚动条**而不是整条书签栏（容器里还住着滚动条本身，清空它会把那层也拆掉）。
        strip.textContent = ''
        itemEls = items.map((item) => {
          const el = buildItem(item)
          strip.appendChild(el)
          return el
        })
      }
      applyVisibility()
    },
    setVisible(next: boolean) {
      visible = !!next
      applyVisibility()
    },
    /**
     * 此刻是否真的可见（判据与 `.visible` 类同源）。
     * 编排层据此决定把这块**登记进外壳布局**还是从布局里注销。
     * @returns {boolean}
     */
    isVisible: isShown
  }
}
