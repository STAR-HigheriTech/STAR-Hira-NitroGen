/**
 * @hira-ng/ui-common / panelKit —— 侧边面板的**原子层**（Panel Kit）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────
 * 面板是独立 WebContentsView，各有各的包。过去每个包都自己写一遍
 * 「按钮 → 描边 + 高度 + hover」「列表行 → 卡片底 + 描边 + hover」，
 * 于是同一个应用里出现了 24/26/28 三种按钮高度、6/8/10 三种圆角、
 * 每行一层描边卡片 —— 界面越加越挤、越加越"框"。
 *
 * 这一层把「控件长什么样」收成**唯一一份**：
 *   · 结构类（行 / 组 / 工具栏 / 空态）+ 控件类（按钮 / 输入 / 搜索 / chip / 徽标）
 *   · 全部引用 `packages/shared-ui-tokens` 的 `--hira-*` 令牌，不自带任何字面量体系
 *   · 视觉口径：**无多余描边**、hover 是软底、选中是 accent 软底、焦点只有一圈环
 *
 * 面板包只负责「用哪个类」，不再负责「长什么样」—— 改一次全站一起变，
 * 也不可能出现"这个面板圆角 8、那个圆角 7"。
 *
 * ── 扩展方式 ────────────────────────────────────────────────────────────
 * 新控件一律加在**本文件**（并在这里写清几何来源），不要回面板包里另起一套；
 * 面板特有的结构（书签树缩进、色卡网格、进度条）留在面板包内，只消费本层的令牌。
 *
 * ── 完整面板样式（`injectPanelStyles`）为什么也在这里 ──────────────────
 * 它只是把「通用件 + 本层 + 面板基底」按**固定顺序**串起来，真源仍各自在文件里。
 * 放在本文件而不是 `index.js`，是为了让**面板宿主**（panels/host.js）能深路径拿到它：
 * `index.js` 是四十多条 `export *` 的重桶，宿主在壳已可见之后才补齐内容样式，
 * 没有理由为此把整桶模块再求值一遍。`index.js` 通过 `export * from './panelKit'`
 * 转发，两个入口看到的永远是同一份实现。
 *
 * 依赖方向：本文件 → `panelShell.ts`（基底）**单向**。反过来不许 ——
 * 薄引导只引 panelShell，一旦反向依赖就会把整个原子层拖进首帧。
 */

import { injectCommonStyles, injectPanelBaseStyles } from './panelShell'

const KIT_STYLE_ID = 'ui-common-panel-kit-styles'

/**
 * 面板宿主（panel webContents view）**完整**样式 = 通用件 + 原子层 + 面板基底。
 * 各 ui-panel-* 包调用一次即可，重复调用幂等。
 *
 * 顺序即优先级：原子层先于面板基底 —— 面板自己的局部规则写在后面，
 * 真要覆盖某个原子时天然就赢（不必靠 !important 或更长的选择器）。
 *
 * 面板也要 common 那一份（列表项等共用件）：早先两者分开注入，于是出现过
 * "面板里某个共用件没样式"的一类问题 —— 组件在哪都该长一样，由面板入口一并保证
 * （三份各自按 id 幂等，重复调用无代价）。
 *
 * @param {Document} doc
 */
export function injectPanelStyles(doc: Document): void {
  injectCommonStyles(doc)
  injectPanelKitStyles(doc)
  injectPanelBaseStyles(doc)
}

/**
 * 原子层样式（幂等注入）。
 * 由 `injectPanelStyles` 统一调用 —— 面板包不需要单独记得注入它。
 * @param {Document} doc
 */
export function injectPanelKitStyles(doc: Document): void {
  if (!doc || !doc.head || doc.getElementById(KIT_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = KIT_STYLE_ID
  style.textContent = `
    /* ══ 布局原语 ═══════════════════════════════════════════════════════
       面板内的节奏只有两档：一档同组（--hira-panel-gap）/ 一档组间（--hira-panel-gap-loose）。
       两档都在 tokens-base.css 里定义 —— 不再各处写 4/6/8/10。 */
    .hp-stack { display: flex; flex-direction: column; gap: var(--hira-panel-gap, 10px); min-height: 0; }
    .hp-stack--loose { gap: var(--hira-panel-gap-loose, 18px); }
    .hp-stack--fill { flex: 1; min-height: 0; }
    .hp-inline { display: flex; align-items: center; gap: var(--hira-panel-gap, 10px); min-width: 0; }
    .hp-spacer { flex: 1; }

    /* ══ 行（列表项 / 可点条目）══════════════════════════════════════════
       关键：**没有描边**。层级靠 hover / 选中的软底表达 —— 一个面板里十几行，
       每行一条边框就是用户说的"多余条条框框"。
       行高与内距全部走令牌：面板窄，靠**行内空气**而不是字号把内容隔开。 */
    .hp-row {
      display: flex; align-items: center; gap: 10px;
      min-height: var(--hira-row-height, 36px);
      padding: 6px 10px;
      border: 0; border-radius: var(--hira-radius-md, 10px);
      background: transparent; color: inherit;
      font: inherit; text-align: left;
      cursor: default;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-row--button { cursor: pointer; }
    .hp-row--button:hover,
    .hp-row--hover:hover { background: var(--hira-panel-card-hover, rgba(0,0,0,0.035)); }
    /* 选中行与 tabbar / 标签列表的选中标签**同一组令牌**（--ng-tab-active-*）：
       同一套"我在这儿"的底色，不再单独一套 accent 软底。 */
    .hp-row--selected { background: var(--ng-tab-active-bg, var(--bg-color, #fff)); }
    .hp-row--selected:hover { background: var(--ng-tab-active-bg, var(--bg-color, #fff)); }
    .hp-row:focus-visible { outline: none; box-shadow: var(--hira-focus-ring); }
    .hp-row__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }
    .hp-row__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--hira-node-gap, 4px); }
    .hp-row__title {
      font-size: 12px; font-weight: 500; line-height: 18px;
      color: var(--hira-text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hp-row__sub {
      font-size: 11px; line-height: 16px;
      color: var(--hira-text-tertiary, #9ca3af);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hp-row__actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

    /* ══ 按钮 ═══════════════════════════════════════════════════════════
       三档：默认（无底）/ primary（accent 软底）/ danger（红软底）。
       高度统一走 --hira-control-height（图标按钮同高同宽）。 */
    .hp-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border: 0; border-radius: var(--hira-radius-sm, 8px);
      background: transparent; color: var(--hira-text-secondary);
      font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1;
      white-space: nowrap; cursor: pointer;
      transition:
        background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
        color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-btn:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.04)); color: var(--hira-text-primary); }
    .hp-btn:active { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .hp-btn:focus-visible { outline: none; box-shadow: var(--hira-focus-ring); }
    .hp-btn--primary { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); color: var(--hira-accent, #3b82f6); }
    .hp-btn--primary:hover { background: var(--hira-accent-soft-strong, rgba(59,130,246,0.22)); color: var(--hira-accent, #3b82f6); }
    .hp-btn--danger { color: var(--hira-danger, #dc2626); }
    .hp-btn--danger:hover { background: var(--hira-danger-bg, rgba(220,38,38,0.08)); color: var(--hira-danger, #dc2626); }
    .hp-btn--icon { width: var(--hira-control-height, 32px); padding: 0; }
    .hp-btn[disabled] { opacity: 0.42; pointer-events: none; }

    /* ══ 输入 / 搜索 ════════════════════════════════════════════════════
       字段只有一层软底，聚焦**只加一圈环**（不再同时改 border-color ——
       那正是过去"两层聚焦框"的来源）。 */
    .hp-input,
    .hp-select,
    .hp-textarea {
      width: 100%; box-sizing: border-box;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border: 0; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary);
      font-family: inherit; font-size: 12px;
      outline: none;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-textarea { height: auto; min-height: 80px; padding: 10px 12px; line-height: 19px; resize: vertical; }
    .hp-input:focus,
    .hp-select:focus,
    .hp-textarea:focus { background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); box-shadow: var(--hira-focus-ring); }
    .hp-input::placeholder,
    .hp-textarea::placeholder { color: var(--hira-text-tertiary, #9ca3af); }

    .hp-search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-search:focus-within { background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); box-shadow: var(--hira-focus-ring); }
    .hp-search__icon { flex-shrink: 0; display: inline-flex; color: var(--hira-text-tertiary, #9ca3af); font-size: 12px; line-height: 1; }
    .hp-search__input {
      flex: 1; min-width: 0; padding: 0; border: 0; outline: none; background: transparent;
      color: var(--hira-text-primary); font-family: inherit; font-size: 12px;
    }
    .hp-search__input::placeholder { color: var(--hira-text-tertiary, #9ca3af); }

    /* ══ Chip（筛选 / 标签）═════════════════════════════════════════════ */
    .hp-chip {
      display: inline-flex; align-items: center; gap: 6px;
      height: 28px; padding: 0 11px;
      border: 0; border-radius: var(--hira-radius-xs, 6px);
      background: transparent; color: var(--hira-text-secondary);
      font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1; cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-chip:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.04)); color: var(--hira-text-primary); }
    .hp-chip--active { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); color: var(--hira-accent, #3b82f6); }
    .hp-chip--active:hover { background: var(--hira-accent-soft-strong, rgba(59,130,246,0.22)); }

    /* ══ 工具栏 ═════════════════════════════════════════════════════════ */
    .hp-toolbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .hp-toolbar--between { justify-content: space-between; }

    /* ══ 分组 / 标题 / 分隔 ═════════════════════════════════════════════ */
    .hp-group { display: flex; flex-direction: column; gap: var(--hira-node-gap, 4px); }
    .hp-group__title {
      padding: var(--hira-section-gap-top, 16px) 10px var(--hira-section-gap-bottom, 8px);
      font-size: 11px; font-weight: 500; line-height: 16px;
      letter-spacing: 0.02em; color: var(--hira-text-tertiary, #9ca3af);
    }
    .hp-group:first-child > .hp-group__title { padding-top: 4px; }
    .hp-divider { height: 1px; margin: 10px 0; border: 0; background: var(--hira-hairline, rgba(0,0,0,0.07)); }

    /* ══ 徽标 / 空态 ════════════════════════════════════════════════════ */
    .hp-badge {
      display: inline-flex; align-items: center; height: 18px; padding: 0 7px;
      border-radius: var(--hira-radius-xs, 6px); background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      color: var(--hira-text-secondary);
      font-size: 10px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums;
    }
    .hp-badge--accent { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); color: var(--hira-accent, #3b82f6); }
    .hp-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #9ca3af); font-size: 12px; line-height: 19px;
    }

    /* ══ 开关 ═══════════════════════════════════════════════════════════ */
    .hp-switch {
      position: relative; flex-shrink: 0;
      width: 32px; height: 18px; padding: 0;
      border: 0; border-radius: 999px; /* 开关轨道：恒定胶囊，不参与主题圆角（圆角 0 也不该变成方块） */
      background: var(--hira-switch-off, var(--hira-track-bg, rgba(0,0,0,0.1)));
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-switch::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--hira-surface, #fff);
      box-shadow: 0 1px 2px rgba(0,0,0,0.18);
      transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .hp-switch[aria-checked='true'] { background: var(--hira-accent, #3b82f6); }
    .hp-switch[aria-checked='true']::after { transform: translateX(14px); }
    .hp-switch:focus-visible { outline: none; box-shadow: var(--hira-focus-ring); }
  `
  doc.head.appendChild(style)
}
