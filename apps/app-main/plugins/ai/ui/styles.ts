/**
 * AI 面板 · 样式（唯一收口）。
 *
 * 契约（PART15 §11.4 / §12）：
 *   · 窄栏 ≤ 380px 与独立窗口用**同一份**实现，密度差异只在这里用 `.is-compact` 分档；
 *   · 颜色 / 圆角 / 动效一律 `--hira-*` 主题令牌，不写死颜色（深色模式跟随主题）；
 *   · 宽度差异走**容器查询**（`container-type: inline-size`）—— 面板宽度与窗口宽度无关，
 *     `@media` 在这里量不准（与集锦面板同一口径）。
 *
 * 类名前缀统一 `ai-`：面板自带 UI 打出去时不与宿主/其它面板撞名。
 */

// 深路径而非重桶：面板 / 内部页只需要这一份样式串行器，不该顺带求值 ui-common 的四十多条导出
// （与 `subwindow/windows/detached-panel.js` 同一口径）。
import { injectPanelStyles } from '@hira-ng/ui-common/src/panelKit'

const STYLE_ID = 'hira-ai-panel-styles'

/**
 * 注入样式（幂等）。宿主在 panelDefinition.injectStyles 里调用。
 * @param {Document} doc
 */
export function injectAiPanelStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return
  // 面板原子层（图标按钮 / 输入框 / 骨架）与其它面板共用，不重复实现。
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* ══════════════════════════════════════════════════════════════════
       密度 token —— 改密度只改这一段。
       窄栏（compact）以"一行能放下 12px 的句子 + 气泡不贴边"为准；
       窗口态放开字号与行高、正文最大宽度居中（长行读起来不累）。
       ══════════════════════════════════════════════════════════════════ */
    .ai-panel {
      --ai-fs-body: 13.5px;
      /* 回答正文单独一档：AI 输出是"要读的长文"，比输入 / 用户气泡略大半档 */
      --ai-fs-answer: 13.5px;
      --ai-fs-meta: 12px;
      --ai-fs-title: 13.5px;
      --ai-lh-body: 1.7;
      --ai-gap: 14px;
      --ai-bubble-pad: 9px 12px;
      /* 控件尺寸也归这一档：按钮 / 胶囊 / 输入栏共用，不给每处写魔法数字 */
      --ai-control-h: 30px;
      --ai-control-sm: 26px;
      --ai-bubble-radius: var(--hira-radius-md, 10px);
      --ai-user-bg: var(--hira-accent-soft, rgba(59,130,246,0.14));
      --ai-code-bg: var(--hira-surface-soft, rgba(0,0,0,0.05));
      --ai-line: var(--hira-border-subtle, rgba(0,0,0,0.08));
      --ai-read-width: none;
      --ai-title-weight: 500;
      --ai-composer-max: 180px;

      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      color: var(--hira-text-primary, #1a1a1a);
      font-size: var(--ai-fs-body);
      line-height: var(--ai-lh-body);
      /* 容器查询：宽度档只跟"自己有多宽"有关 */
      container-type: inline-size;
    }
    .ai-workspace {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      align-items: stretch;
    }
    .ai-main {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    /* 窗口态：无窄栏预算，正文放开并居中收窄到可读行宽 */
    .ai-panel:not(.is-compact) {
      --ai-fs-body: 14px;
      --ai-fs-answer: 14.5px;
      --ai-fs-meta: 12.5px;
      --ai-fs-title: 14.5px;
      --ai-lh-body: 1.7;
      --ai-gap: 16px;
      --ai-bubble-pad: 11px 15px;
      --ai-control-h: 32px;
      --ai-control-sm: 28px;
      --ai-read-width: 780px;
      --ai-composer-max: 300px;
    }
    /* [hidden] 必须赢过类上的 display（光标 / 空态 / 输入框都设了 display）。 */
    .ai-panel [hidden] { display: none !important; }

    /* ── 顶部：会话列表入口 / 新建 / 设置 ───────────────────────────── */
    .ai-topbar {
      display: flex; align-items: center; gap: 8px;
      padding: 0 0 8px; flex: 0 0 auto; min-width: 0;
    }
    /* 会话入口是一颗"控件"，不是一行标题：
       图标徽章 + 当前会话标题 + 会话数 + 箭头，一眼能看出点开是一份列表。 */
    .ai-topbar__session {
      flex: 1 1 auto; min-width: 0;
      display: flex; align-items: center; gap: 8px;
      height: var(--ai-control-h, 30px);
      padding: 0 8px 0 6px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.07));
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      font: inherit; font-size: var(--ai-fs-title); font-weight: var(--ai-title-weight);
      cursor: pointer; text-align: left;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  border-color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-topbar__session:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.07));
      border-color: var(--hira-border-strong, rgba(0,0,0,0.12));
    }
    .ai-topbar__session.is-open {
      border-color: color-mix(in srgb, var(--hira-accent, #3b82f6) 34%, var(--hira-border-subtle, rgba(0,0,0,0.08)));
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
    }
    .ai-topbar__session-icon {
      flex: 0 0 auto; width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 6px;
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .ai-topbar__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-topbar__count {
      flex: 0 0 auto; min-width: 18px; height: 18px; padding: 0 5px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 9px;
      background: var(--hira-surface-strong, rgba(0,0,0,0.08));
      color: var(--hira-text-tertiary, #8a8f98);
      font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums;
    }
    .ai-topbar__chevron { flex: 0 0 auto; display: flex; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-topbar__chevron.is-open { color: var(--hira-accent, #3b82f6); }

    /* ── 本次上下文摘要条（常驻，只在有引用时出现） ──────────────────
       两行：**头部信息行**（本次上下文 · N 项 · ≈ tokens · 一键清空）+
       **材料本身**（favicon / 缩略图 + 标题 + 类型 + 单项移除）。
       画材料而不是画统计 —— "页面 ×2"看不出到底引用了哪两篇。 */
    .ai-context-bar {
      display: flex; flex-direction: column; gap: 8px;
      flex: 0 0 auto; min-width: 0;
      margin: 0 0 10px; padding: 8px 10px 9px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.07));
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      color: var(--hira-text-secondary, #6b7280);
      font-size: var(--ai-fs-meta);
      line-height: 1.4;
    }
    .ai-context-bar__head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .ai-context-bar__label {
      flex: 0 0 auto;
      display: inline-flex; align-items: center; gap: 5px;
      font-weight: 500;
      color: var(--hira-text-secondary, #6b7280);
      white-space: nowrap;
    }
    /* 一颗强调色小圆点：让这条"状态栏"有视觉锚点，不与正文混在一起 */
    .ai-context-bar__label::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--hira-accent, #3b82f6);
      box-shadow: 0 0 0 3px var(--hira-accent-soft, rgba(59,130,246,0.16));
    }
    .ai-context-bar__count {
      flex: 0 0 auto;
      display: inline-flex; align-items: center;
      height: 19px; padding: 0 7px;
      border-radius: 999px;
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
      font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .ai-context-bar__tokens {
      margin-left: auto;
      display: inline-flex; align-items: center;
      height: 22px; padding: 0 8px;
      border-radius: 999px;
      background: var(--hira-surface-strong, rgba(0,0,0,0.06));
      color: var(--hira-text-secondary, #6b7280);
      font-size: 11.5px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .ai-context-bar__tokens[hidden] { display: none; }
    /* 材料区：允许换行，超过 96px 自行滚动（引用多时不吃掉整个输入区） */
    .ai-context-bar__chips {
      display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px;
      max-height: 96px; overflow-y: auto;
      scrollbar-width: thin;
      overscroll-behavior: contain;
    }
    /* 摘要条里的 chip 提亮一档：这里不是"输入区的待发送标记"，是真正要看的内容 */
    .ai-context-bar .ai-chip {
      background: var(--hira-surface-raised, var(--hira-surface, #fff));
      border-color: var(--ai-line);
    }
    .ai-context-bar .ai-chip--link:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.08)); }
    .ai-context-bar .ai-icon-btn--tiny { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px; }

    /* ── 通用按钮 ──────────────────────────────────────────────────── */
    .ai-icon-btn {
      width: var(--ai-control-h, 30px); height: var(--ai-control-h, 30px);
      flex: 0 0 auto; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: var(--hira-radius-sm, 8px); background: transparent;
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-icon-btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); color: var(--hira-text-primary, #1a1a1a); }
    .ai-icon-btn:disabled { opacity: 0.45; cursor: default; background: transparent; }
    /* 卡片里的小号图标按钮（删除模型 / 删除技能）—— 不撑高行 */
    .ai-icon-btn--tiny { width: 24px; height: 24px; border-radius: 6px; }
    .ai-btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 5px; min-height: var(--ai-control-h, 30px); padding: 0 12px;
      border: 0; border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      color: var(--hira-text-primary, #1a1a1a);
      font: inherit; font-size: var(--ai-fs-meta); font-weight: 500;
      cursor: pointer; white-space: nowrap;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.09)); }
    .ai-btn.is-primary {
      background: var(--hira-accent, #3b82f6);
      color: var(--hira-on-accent, #fff);
    }
    .ai-btn.is-primary:hover { background: var(--hira-accent-strong, #2563eb); }
    .ai-btn.is-danger { color: var(--hira-danger, #dc2626); }
    .ai-btn.is-danger:hover { background: var(--hira-danger-bg, rgba(220,38,38,0.12)); }
    /* 「始终允许」：与主按钮区分开 —— 它是模式开关（开启允许模式），不是"再来一次"。 */
    .ai-btn.is-success {
      background: var(--hira-success-bg, rgba(22, 163, 74, 0.12));
      color: var(--hira-success, #16a34a);
      border: 1px solid color-mix(in srgb, var(--hira-success, #16a34a) 40%, transparent);
    }
    .ai-btn.is-success:hover { background: var(--hira-success-bg-strong, rgba(22, 163, 74, 0.2)); }
    .ai-btn:disabled { opacity: 0.45; cursor: default; }

    /* ── 消息区 ────────────────────────────────────────────────────── */
    .ai-chat {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
      /* 顶部给浮起的回底按钮留出呼吸，但默认不挡内容 */
      padding: 2px 0 10px;
      scrollbar-width: thin;
      overscroll-behavior: contain;
    }
    .ai-chat__inner {
      display: flex; flex-direction: column;
      gap: var(--ai-gap);
      width: 100%;
      max-width: var(--ai-read-width);
      margin: 0 auto;
    }
    .ai-msg { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ai-msg--user { align-items: flex-end; }
    .ai-msg--assistant { align-items: stretch; }
    .ai-msg__bubble {
      max-width: 88%;
      padding: var(--ai-bubble-pad);
      border-radius: var(--ai-bubble-radius);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      overflow-wrap: anywhere;
    }
    .ai-msg--user .ai-msg__bubble {
      background: var(--ai-user-bg);
      border-bottom-right-radius: var(--hira-radius-xs, 6px);
    }
    .ai-msg--assistant .ai-msg__bubble {
      background: transparent;
      padding: 0 2px;
      max-width: 100%;
    }
    /* 流式文本：只改这一个文本节点；pre-wrap 保住模型的换行 */
    .ai-msg__text { white-space: pre-wrap; word-break: break-word; }
    .ai-msg__body { min-width: 0; }
    /* 回答正文走独立字号档（标题、列表、引用都按 em 跟着放大）；流式中同样是这一档 */
    .ai-msg--assistant .ai-msg__body,
    .ai-msg--assistant .ai-msg__text { font-size: var(--ai-fs-answer); }
    .ai-msg__body > :first-child { margin-top: 0; }
    .ai-msg__body > :last-child { margin-bottom: 0; }
    .ai-msg__body p { margin: 0 0 0.65em; }
    /* 标题：比正文明显大 + 加粗（DeepSeek / 豆包 的层次感），但不过分夸张 */
    .ai-msg__body h1, .ai-msg__body h2, .ai-msg__body h3,
    .ai-msg__body h4, .ai-msg__body h5, .ai-msg__body h6 {
      margin: 0.9em 0 0.4em; line-height: 1.32; font-weight: 700;
      letter-spacing: -0.01em;
    }
    .ai-msg__body h1 { font-size: 1.35em; }
    .ai-msg__body h2 { font-size: 1.2em; }
    .ai-msg__body h3 { font-size: 1.08em; font-weight: 600; }
    .ai-msg__body h4 { font-size: 1em; font-weight: 600; }
    .ai-msg__body h5, .ai-msg__body h6 {
      font-size: 1em; font-weight: 600; color: var(--hira-text-secondary, #6b7280);
    }
    .ai-msg__body ul, .ai-msg__body ol { margin: 0 0 0.6em; padding-left: 1.4em; }
    .ai-msg__body li { margin: 0.15em 0; }
    .ai-msg__body .md-table {
      max-width: 100%; margin: 0 0 0.7em; overflow-x: auto;
      border: 1px solid var(--ai-line); border-radius: var(--hira-radius-sm, 8px);
    }
    .ai-msg__body table {
      width: 100%; min-width: 420px; border-collapse: collapse;
      font-size: var(--ai-fs-meta); line-height: 1.5;
    }
    .ai-msg__body th, .ai-msg__body td {
      padding: 7px 9px; border-bottom: 1px solid var(--ai-line); text-align: left; vertical-align: top;
    }
    .ai-msg__body th {
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a); font-weight: 600; white-space: nowrap;
    }
    .ai-msg__body tr:last-child td { border-bottom: 0; }
    .ai-msg__body blockquote {
      margin: 0 0 0.6em; padding: 2px 0 2px 10px;
      border-left: 2px solid var(--ai-line); color: var(--hira-text-secondary, #6b7280);
    }
    .ai-msg__body pre {
      margin: 0.5em 0; padding: 8px 10px; overflow-x: auto;
      background: var(--ai-code-bg); border-radius: var(--hira-radius-sm, 8px);
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 12px; line-height: 1.55;
    }
    .ai-msg__body code {
      padding: 1px 4px; border-radius: 4px; background: var(--ai-code-bg);
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 0.94em;
    }
    .ai-msg__body pre code { padding: 0; background: transparent; font-size: inherit; }
    /* 正文链接：常驻下划线（不靠蓝色一色区分）+ 悬停提亮整条 */
    .ai-msg__body a {
      color: var(--hira-accent, #3b82f6);
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
      text-decoration-color: color-mix(in srgb, var(--hira-accent, #3b82f6) 42%, transparent);
    }
    .ai-msg__body a:hover {
      text-decoration-color: currentColor;
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      border-radius: 3px;
    }
    .ai-msg__body img { max-width: 100%; border-radius: var(--hira-radius-sm, 8px); }
    .ai-msg__body hr { border: 0; border-top: 1px solid var(--ai-line); margin: 0.8em 0; }
    .ai-msg__meta {
      display: flex; align-items: center; gap: 6px;
      font-size: var(--ai-fs-meta); color: var(--hira-text-tertiary, #8a8f98);
    }
    /* 消息操作条（复制 / 重生成）：常驻但压低存在感，hover 或聚焦时提亮 —— 不抢注意力 */
    .ai-msg--assistant .ai-msg__bubble { position: relative; }
    .ai-msg__actions {
      display: flex; align-items: center; gap: 2px;
      margin-top: 2px; opacity: 0.72;
      transition: opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-msg:hover .ai-msg__actions,
    .ai-msg__actions:focus-within { opacity: 1; }
    .ai-msg__actions[hidden] { display: none; }
    .ai-msg__action {
      width: auto; height: 26px; min-width: 26px; padding: 0 7px;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      border: 0; border-radius: 6px; background: transparent;
      color: var(--hira-text-tertiary, #8a8f98); cursor: pointer;
      font: inherit; font-size: var(--ai-fs-meta); line-height: 1;
    }
    .ai-msg__action:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.07)); color: var(--hira-text-primary, #1a1a1a); }
    .ai-msg__action--copy { padding: 0 7px 0 5px; }
    .ai-msg__action--copy.is-done { color: var(--hira-success, #16a34a); }
    /* 流式光标：一个呼吸的方块，不参与排版（不引起重排） */
    .ai-msg__caret {
      display: inline-block; width: 6px; height: 1em; margin-left: 2px;
      vertical-align: text-bottom; border-radius: 2px;
      background: var(--hira-accent, #3b82f6); opacity: 0.55;
      animation: ai-caret 1s ease-in-out infinite;
    }
    @keyframes ai-caret { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.7; } }

    /* ── 思考过程（深度思考才出现） ───────────────────────────────────
       历史消息默认收起，流式默认展开（见 chat.js#createReasoningBlock）。
       视作正文之上的一段"旁白"：小一号字、弱一档色，不与答案抢层级。 */
    .ai-reasoning {
      margin: 0 0 8px;
      border-left: 2px solid var(--ai-line);
      padding-left: 10px;
    }
    .ai-reasoning[hidden] { display: none; }
    .ai-reasoning__summary {
      display: flex; align-items: center; gap: 8px;
      list-style: none; cursor: pointer; user-select: none;
      padding: 1px 0 2px;
      font-size: var(--ai-fs-meta); color: var(--hira-text-tertiary, #8a8f98);
    }
    .ai-reasoning__summary::-webkit-details-marker { display: none; }
    /* 折叠指示：一个小三角，跟着 open 状态转向（不占额外图标位） */
    .ai-reasoning__summary::before {
      content: ''; flex: 0 0 auto;
      width: 0; height: 0; margin-left: 1px;
      border-left: 4px solid currentColor;
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-reasoning[open] > .ai-reasoning__summary::before { transform: rotate(90deg); }
    .ai-reasoning__summary:hover { color: var(--hira-text-secondary, #6b7280); }
    .ai-reasoning__title { flex: 0 0 auto; font-weight: 500; }
    .ai-reasoning__meta { flex: 0 0 auto; opacity: 0.7; }
    .ai-reasoning__body {
      padding: 4px 0 2px;
      font-size: calc(var(--ai-fs-answer) - 1px);
      line-height: 1.62;
      color: var(--hira-text-secondary, #6b7280);
      white-space: pre-wrap; word-break: break-word;
      overflow-wrap: anywhere;
    }
    /* 流式中：标题右移一点点留出呼吸，内容渐入（不改变布局） */
    .ai-reasoning--stream .ai-reasoning__title { color: var(--hira-accent, #3b82f6); }

    /* ── 参考来源（联网检索 / 读页的执行事实） ─────────────────────── */
    .ai-sources {
      margin: 8px 0 0;
      padding: 8px 10px;
      border: 1px solid var(--ai-line);
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
    }
    .ai-sources[hidden] { display: none; }
    .ai-sources__title {
      margin-bottom: 5px;
      font-size: var(--ai-fs-meta); color: var(--hira-text-tertiary, #8a8f98);
    }
    .ai-sources__list { display: flex; flex-direction: column; gap: 1px; }
    .ai-sources__item {
      display: flex; align-items: baseline; gap: 8px;
      width: 100%; padding: 3px 5px; margin: 0 -5px;
      border: 0; border-radius: 5px; background: transparent;
      font: inherit; font-size: var(--ai-fs-meta); text-align: left;
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
    }
    .ai-sources__item:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .ai-sources__item:focus-visible { outline: 2px solid var(--ai-accent, #4a8cff); outline-offset: -2px; }
    .ai-sources__name {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ai-sources__item:hover .ai-sources__name { text-decoration: underline; text-underline-offset: 2px; }
    .ai-sources__host {
      flex: 0 0 auto; max-width: 40%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; color: var(--hira-text-tertiary, #8a8f98);
    }

    /* ── 引用 chip ─────────────────────────────────────────────────── */
    .ai-chips { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; }
    .ai-chip {
      display: inline-flex; align-items: center; gap: 7px;
      max-width: 100%; padding: 5px 9px 5px 6px;
      border: 1px solid transparent;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      font-size: var(--ai-fs-meta); color: var(--hira-text-secondary, #6b7280);
      line-height: 1.4;
    }
    .ai-chip__thumb {
      width: 24px; height: 24px; flex: 0 0 auto;
      border-radius: var(--hira-radius-xs, 6px); object-fit: cover;
      background: var(--hira-surface-strong, rgba(0,0,0,0.08));
    }
    /* 站点图标：不裁切、留 3px 内边距，白底上也能看清（截图缩略图仍走 cover） */
    .ai-chip__thumb--icon { object-fit: contain; padding: 3px; }
    .ai-chip__glyph { flex: 0 0 auto; display: flex; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-chip__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
    .ai-chip__kind {
      flex: 0 0 auto; padding: 0 5px; border-radius: 5px;
      font-size: 11px; color: var(--hira-text-tertiary, #8a8f98);
      background: var(--hira-surface-strong, rgba(0,0,0,0.06));
    }
    .ai-chip__x {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; padding: 0;
      border: 0; border-radius: 5px; background: transparent;
      color: var(--hira-text-tertiary, #8a8f98); cursor: pointer;
    }
    .ai-chip__x:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.1)); color: var(--hira-text-primary, #1a1a1a); }
    /* 可回跳的 chip（页面 / 标签 / 书签 / 历史）：只是提示可点，别做成链接色 */
    .ai-chip--link { cursor: pointer; }
    .ai-chip--link:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.08));
      border-color: var(--hira-border-strong, rgba(0,0,0,0.12));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 悬停时给标题一道下划线 —— "这里可以点跳转"的唯一提示，不加额外图标 */
    .ai-chip--link:hover .ai-chip__label { text-decoration: underline; text-underline-offset: 2px; }
    .ai-chip--link:focus-visible { outline: 2px solid var(--ai-accent, #4a8cff); outline-offset: 1px; }

    /* ── 工具卡 ────────────────────────────────────────────────────── */
    .ai-tool {
      border: 1px solid var(--ai-line); border-radius: var(--ai-bubble-radius);
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
      overflow: hidden; font-size: var(--ai-fs-meta);
    }
    .ai-tool__head {
      display: flex; align-items: center; gap: 7px; width: 100%;
      padding: 8px 10px; border: 0; background: transparent;
      color: var(--hira-text-secondary, #6b7280); font: inherit; cursor: pointer; text-align: left;
    }
    .ai-tool__head:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.04)); }
    .ai-tool__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--hira-text-primary, #1a1a1a); font-weight: 500; }
    .ai-tool__dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--hira-text-tertiary, #8a8f98); }
    .ai-tool__dot.is-running { background: var(--hira-accent, #3b82f6); animation: ai-caret 1s ease-in-out infinite; }
    .ai-tool__dot.is-error { background: var(--hira-danger, #dc2626); }
    .ai-tool__dot.is-ok { background: var(--hira-success, #16a34a); }
    .ai-tool__spacer { flex: 1 1 auto; }
    .ai-tool__status { flex: 0 0 auto; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-tool__body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 7px; }
    .ai-tool__body[hidden] { display: none; }
    .ai-tool__label { color: var(--hira-text-secondary, #6b7280); font-size: 11.5px; }
    .ai-tool__meta {
      color: var(--hira-text-secondary, #6b7280);
      font-size: 11.5px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .ai-tool__meta.mono { font-family: var(--hira-font-mono, ui-monospace, Consolas, monospace); }
    .ai-tool__pre {
      margin: 0; padding: 8px 10px; max-height: 240px; overflow: auto;
      background: var(--ai-code-bg); border-radius: var(--hira-radius-xs, 6px);
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
    }

    /* ── 审批卡 ────────────────────────────────────────────────────── */
    .ai-approval {
      border: 1px solid var(--hira-accent-soft-strong, rgba(59,130,246,0.32));
      border-radius: var(--ai-bubble-radius);
      background: var(--hira-accent-soft, rgba(59,130,246,0.08));
      padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .ai-approval__title { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: var(--ai-fs-title); }
    .ai-approval__meta { color: var(--hira-text-secondary, #6b7280); font-size: var(--ai-fs-meta); overflow-wrap: anywhere; }
    .ai-approval__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
    .ai-approval__hint { color: var(--hira-text-tertiary, #8a8f98); font-size: 11.5px; line-height: 1.55; }

    /* ── 错误卡 ────────────────────────────────────────────────────── */
    .ai-error {
      border-radius: var(--ai-bubble-radius); padding: 10px 12px;
      background: var(--hira-danger-bg, rgba(220,38,38,0.1));
      color: var(--hira-danger, #dc2626); font-size: var(--ai-fs-meta);
      display: flex; align-items: flex-start; gap: 7px;
    }
    .ai-error__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ai-error__text { overflow-wrap: anywhere; }
    .ai-error__hint { color: var(--hira-text-secondary, #6b7280); font-size: 11.5px; line-height: 1.5; }
    .ai-error__hint[hidden] { display: none; }
    .ai-error__retry {
      flex: 0 0 auto; padding: 3px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--hira-danger, #dc2626); background: transparent;
      color: var(--hira-danger, #dc2626); font: inherit; font-size: 11.5px;
    }
    .ai-error__retry:hover { background: var(--hira-danger-bg, rgba(220,38,38,0.16)); }
    .ai-error__retry[hidden] { display: none; }
    .ai-error__close { flex: 0 0 auto; width: 20px; height: 20px; margin: -1px -3px 0 0; }

    /* ── 空态 ──────────────────────────────────────────────────────── */
    .ai-empty {
      display: flex; flex-direction: column; gap: 10px;
      padding: 14px 2px; color: var(--hira-text-secondary, #6b7280);
    }
    .ai-empty__title { font-size: var(--ai-fs-title); font-weight: 600; color: var(--hira-text-primary, #1a1a1a); }
    .ai-empty__text { font-size: var(--ai-fs-meta); line-height: 1.6; }
    .ai-empty__card {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; border-radius: var(--ai-bubble-radius);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-empty__card:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.07)); }
    .ai-empty__glyph { flex: 0 0 auto; display: flex; margin-top: 1px; color: var(--hira-accent, #3b82f6); }
    .ai-empty__body { min-width: 0; }
    .ai-empty__card-title { display: block; font-weight: 500; color: var(--hira-text-primary, #1a1a1a); }
    .ai-empty__hint { display: block; margin-top: 2px; font-size: var(--ai-fs-meta); line-height: 1.5; color: var(--hira-text-secondary, #6b7280); }

    /* ── 回到底部：浮在内容之上，用**实底**（不做毛玻璃：糊住下层会让文字发花） ── */
    .ai-jump {
      position: absolute; right: 8px; bottom: 100px; z-index: 3;
      width: 32px; height: 32px; padding: 0;
      display: none; align-items: center; justify-content: center;
      border: 1px solid var(--ai-line); border-radius: 50%;
      background: var(--hira-surface-raised, var(--hira-surface, #fff));
      color: var(--hira-text-secondary, #6b7280);
      box-shadow: var(--hira-shadow-sm, 0 2px 8px rgba(0,0,0,0.12));
      cursor: pointer;
    }
    .ai-jump.is-visible { display: flex; }

    /* ── 输入区 ────────────────────────────────────────────────────── */
    .ai-composer {
      position: relative; /* 浮层 / 文件选择器相对它定位 */
      flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
      padding: 10px 0 0; border-top: 1px solid transparent;
    }
    /* 窗口 / 页面态：底部控制区与正文**同一条左右基准线**。
       正文列宽由 .ai-chat__inner 的可读宽度决定，输入区、上下文摘要条若撑满，
       宽窗口下就成了"正文收窄、下巴铺满"的两套布局。这里直接复用同一个
       --ai-read-width，三种宿主一份口径。
       浮层（.ai-popover）与文件选择器是 .ai-composer 的绝对定位子节点，
       宽度天然跟随，不需要再写一条规则。 */
    .ai-panel:not(.is-compact) .ai-main > .ai-composer,
    .ai-panel:not(.is-compact) .ai-main > .ai-context-bar {
      width: 100%;
      max-width: var(--ai-read-width);
      margin-left: auto;
      margin-right: auto;
    }
    /* 回底按钮同理：贴着正文列的右边界，而不是贴着窗口右边界 */
    .ai-panel:not(.is-compact) .ai-jump {
      right: max(8px, calc((100% - var(--ai-read-width)) / 2 + 8px));
    }
    /* 滚动条会从正文列中啃掉一块宽度，令正文中线左偏半个滚动条。
       两边同时预留：中线与输入区严格重合（不滚动时只是多了两小段留白）。 */
    .ai-panel:not(.is-compact) .ai-chat { scrollbar-gutter: stable both-edges; }
    .ai-composer.is-drag-over .ai-composer__box {
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
    }
    .ai-composer__chips:empty { display: none; }
    .ai-composer__box {
      display: flex; flex-direction: column; gap: 8px;
      padding: 10px 10px 10px 12px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.07));
      border-radius: var(--hira-radius-lg, 14px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      box-shadow: var(--hira-shadow-sm, 0 1px 3px rgba(0,0,0,0.05));
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  border-color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-composer__box:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      border-color: var(--hira-border-strong, rgba(0,0,0,0.12));
      box-shadow: var(--hira-focus-ring, 0 0 0 3px rgba(59,130,246,0.18));
    }
    /* 面板里的**无框输入件**统一带 .ai-panel 前缀。
       原因：内部页宿主（hira://ai）会加载 pages/_shared/base.css，那里把
       input[type=…] / textarea 定义成通用字段原语（软底 + 聚焦环），且
       input[type='text']（0,1,1）/ textarea:focus（0,1,1）的权重压过单个类名。
       不加重前缀的话，内部页里的输入框就会多出 base 的一层底色块与聚焦环，
       与面板自己的 .ai-composer__box:focus-within 叠成两层 —— 侧栏/窗口却正常。
       所以这里是"宿主注入的通用原语免疫"，一处出清，不给每个部件写 :focus 补丁。
       ⚠ 底色、边框、内边距之外，还必须把 box-shadow 一起清掉：base.css 的
       textarea:focus 用 box-shadow 画环，只覆盖 outline 拦不住它 ——
       于是输入区里会再套一个更小的聚焦框（外层 composer、内层 textarea）。 */
    .ai-panel .ai-composer__input {
      width: 100%; min-height: 48px; max-height: var(--ai-composer-max);
      padding: 4px 0; border: 0; border-radius: 0; outline: none; resize: none;
      background: transparent; box-shadow: none; color: var(--hira-text-primary, #1a1a1a);
      font: inherit; font-size: var(--ai-fs-body); line-height: 1.55;
      overflow-y: auto; scrollbar-width: thin;
    }
    .ai-panel .ai-composer__input::placeholder { color: var(--hira-text-tertiary, #8a8f98); }
    .ai-composer__bar { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .ai-composer__spacer { flex: 1 1 auto; }
    .ai-composer__send {
      width: var(--ai-control-h, 30px); height: var(--ai-control-h, 30px); flex: 0 0 auto; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 50%; cursor: pointer;
      background: var(--hira-accent, #3b82f6); color: var(--hira-on-accent, #fff);
      transition: opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-composer__send:disabled { opacity: 0.4; cursor: default; }
    .ai-composer__send.is-stop { background: var(--hira-danger, #dc2626); }
    /* 输入区上方的引用 chip（复用 .ai-chip 的外观，这里只管排布） */
    .ai-composer__chips { display: flex; flex-wrap: wrap; gap: 8px; }
    /* 输入栏里的工具按钮：与模型胶囊同高（走 --ai-control-sm），不吃掉输入高度 */
    .ai-composer__tool {
      width: var(--ai-control-sm, 26px); height: var(--ai-control-sm, 26px); flex: 0 0 auto; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 7px; background: transparent;
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-composer__tool:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); color: var(--hira-text-primary, #1a1a1a); }
    .ai-composer__tool:disabled { opacity: 0.4; cursor: default; background: transparent; }
    /* 停止方块（与发送箭头共用按钮，只换里面那颗 glyph） */
    .ai-stop-glyph {
      display: block; width: 8px; height: 8px; border-radius: 2px;
      background: currentColor;
    }

    /* ── 模型选择器 ──────────────────────────────────────────────────
       输入栏里三颗同形胶囊（模型 / 推理 / 审批）：同一档高度、secondary 灰，
       悬停整颗浮起 —— 先前 22px + 10.5px 的第三级灰在浅底上几乎看不清。 */
    .ai-model-btn {
      display: inline-flex; align-items: center; gap: 4px;
      max-width: 184px; height: var(--ai-control-sm, 26px); padding: 0 8px;
      border: 1px solid transparent; border-radius: 7px; background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      font: inherit; font-size: 12.5px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  border-color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-model-btn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      border-color: var(--hira-border-subtle, rgba(0,0,0,0.08));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .ai-model-btn__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-model-btn[hidden] { display: none; }
    /* 推理等级：与模型同为胶囊，但更窄 —— 它只有一个字到两个字 */
    .ai-reason-btn { max-width: 80px; flex: 0 0 auto; }
    .ai-reason-btn .ai-model-btn__label { flex: 1 1 auto; }
    /* 审批模式：两态开关，**两态都要一眼看见**。
       询问 = 琥珀（"会先问你"）；允许 = 绿（"全站直接读"）。
       只换文字颜色在浅底胶囊上几乎无感，所以整颗给描边 + 淡底 + 加粗。 */
    .ai-approval-btn {
      max-width: 108px; flex: 0 0 auto; gap: 4px; font-weight: 600;
      border-color: color-mix(in srgb, var(--hira-warning, #d97706) 42%, transparent);
      background: var(--hira-warning-bg, rgba(245, 158, 11, 0.13));
      color: var(--hira-warning, #b45309);
    }
    .ai-approval-btn:hover {
      border-color: color-mix(in srgb, var(--hira-warning, #d97706) 64%, transparent);
      background: var(--hira-warning-bg-strong, rgba(245, 158, 11, 0.22));
      color: var(--hira-warning, #b45309);
    }
    .ai-approval-btn__glyph { display: inline-flex; align-items: center; flex: 0 0 auto; }
    .ai-approval-btn.is-allow {
      border-color: color-mix(in srgb, var(--hira-success, #16a34a) 42%, transparent);
      background: var(--hira-success-bg, rgba(22, 163, 74, 0.13));
      color: var(--hira-success, #16a34a);
    }
    .ai-approval-btn.is-allow:hover {
      border-color: color-mix(in srgb, var(--hira-success, #16a34a) 64%, transparent);
      background: var(--hira-success-bg-strong, rgba(22, 163, 74, 0.22));
      color: var(--hira-success, #16a34a);
    }
    .ai-model-btn:disabled { opacity: 0.45; cursor: default; background: transparent; }

    /* ── 浮层（popover）：与抽屉同一套"半透明 + 毛玻璃"，不做白板 ── */
    .ai-popover {
      position: absolute; z-index: 12; left: 0; right: 0; bottom: 100%;
      margin-bottom: 6px; padding: 5px;
      max-height: 320px; overflow-y: auto;
      border: 1px solid var(--ai-line); border-radius: var(--hira-radius-lg, 14px);
      /* 实底菜单：半透明 + 模糊在长列表下会透出下层文字，读起来发花 */
      background: var(--hira-surface-raised, var(--hira-surface, #fff));
      box-shadow: var(--hira-shadow-md, 0 8px 24px rgba(0,0,0,0.16));
      animation: ai-pop-in 120ms var(--hira-ease-standard, ease);
    }
    .ai-popover__item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 9px 11px; border: 0; border-radius: var(--hira-radius-sm, 8px);
      background: transparent; color: var(--hira-text-primary, #1a1a1a);
      font: inherit; font-size: var(--ai-fs-body); cursor: pointer; text-align: left;
    }
    .ai-popover__item:hover, .ai-popover__item.is-active { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .ai-popover__glyph { flex: 0 0 auto; display: flex; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-popover__glyph.is-tone-accent { color: var(--hira-accent, #3b82f6); }
    .ai-popover__glyph.is-tone-success { color: var(--hira-success, #16a34a); }
    .ai-popover__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .ai-popover__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-popover__sub { font-size: 11.5px; line-height: 1.45; color: var(--hira-text-tertiary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-popover__group {
      padding: 8px 11px 3px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
      color: var(--hira-text-tertiary, #8a8f98);
    }
    /* 二级来源列表的顶部（返回 + 当前来源名） */
    .ai-popover__nav {
      display: flex; align-items: center; gap: 7px;
      padding: 2px 4px 6px; border-bottom: 1px solid var(--ai-line);
      margin-bottom: 4px;
    }
    .ai-popover__back {
      padding: 4px 9px; border: 0; border-radius: 6px;
      background: transparent; color: var(--hira-text-secondary, #6b7280);
      font: inherit; font-size: 12px; cursor: pointer;
    }
    .ai-popover__back:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); color: var(--hira-text-primary, #1a1a1a); }
    .ai-popover__nav-title { font-size: 11px; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-popover__empty { padding: 10px 12px; font-size: var(--ai-fs-meta); color: var(--hira-text-tertiary, #8a8f98); }

    /* ── 思考强度滑块（推理浮层专用） ────────────────────────────
       一条有方向的轴：底轨 + 发光推进条 + 玻璃珠停靠点 + 圆角矩形手柄。
       位置只由一个变量 --ai-reason-t 驱动，拖动时只改它（不碰布局）。
       光晕一律从 --hira-accent 派生（--ai-reason-glow），换主题不用改第二处。 */
    /* 推理滑块的浮层是**一块定宽的仪表盘**，不是菜单。
       菜单跟着输入区撑满是对的（条目本来就要占满一行）；仪表盘撑满会让轨道长得
       离谱、四个档位标签飘到两端。定宽后水平居中：窄栏里几乎与输入区同宽，宽宿主
       里则是一块居中的仪表盘。居中用 translate 属性而不是 transform ——
       进场动画 keyframes 用的是 transform，两者互不覆盖。
       min(定格宽度, 100%) 兜住极窄宿主：宽宿主里是一块大仪表盘，窄栏里自动收成面板宽。 */
    .ai-popover.is-reason {
      left: 50%; right: auto; width: min(530px, 100%);
      translate: -50% 0;
      padding: 12px 15px 10px;
      /* 左上角一层主题色晕染；底下仍是实底，不会透出下层文字 */
      background:
        radial-gradient(125% 150% at 0% 0%,
          color-mix(in srgb, var(--hira-accent, #3b82f6) 9%, transparent),
          transparent 62%),
        var(--hira-surface-raised, var(--hira-surface, #fff));
    }
    /* 窗口 / 页面态：仪表盘再放宽一档（窄栏宽度在宽正文里会显得局促）。 */
    .ai-panel:not(.is-compact) .ai-popover.is-reason { width: min(740px, 100%); }
    .ai-reason {
      --ai-reason-glow: color-mix(in srgb, var(--hira-accent, #3b82f6) 55%, transparent);
      /* 高温档的紫色终点（与主题色无关：这是"更深入"的专属信号） */
      --ai-reason-hot-1: #6d28d9;
      --ai-reason-hot-2: #a855f7;
      --ai-reason-hot-3: #e879f9;
      /* 热度 0..1：由控件按滑块**连续位置**逐帧写入 ——
         低 / 中保持主题色，中→高一路升温，到「高」满格，「自动」沿用满格。
         所有紫色与星点都用它插值，不存在"到档位才突然变色"的跳变。 */
      --ai-reason-heat: 0;
      --ai-reason-heat-pct: 0%;
      /* 手柄尺寸收口在这里：轨道两端、停靠点、推进条都按它算留白，
         保证手柄走到 0% / 100% 时**上下左右都被轨道包住**（不探出圆角）。
         位置由 --ai-reason-t（0..1 的无量纲连续位置）驱动。 */
      --ai-reason-thumb-w: 15px;
      --ai-reason-thumb-h: 15px;
      --ai-reason-half: calc(var(--ai-reason-thumb-w) / 2);
      /* 行程两端再让出的余量：与上下留白同量级，手柄到端点时四边都有轨道露出来 */
      --ai-reason-end-gap: 3px;
      display: flex; flex-direction: column; gap: 5px;
    }
    .ai-reason__head { display: flex; align-items: center; gap: 7px; }
    .ai-reason__title {
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em;
      color: var(--hira-text-tertiary, #8a8f98);
    }
    .ai-reason__value {
      margin-left: auto; padding: 1px 9px; border-radius: 999px;
      background: linear-gradient(135deg,
        color-mix(in srgb,
          rgba(168,85,247,0.42) var(--ai-reason-heat-pct),
          color-mix(in srgb, var(--hira-accent, #3b82f6) 20%, transparent)),
        color-mix(in srgb,
          rgba(232,121,249,0.26) var(--ai-reason-heat-pct),
          color-mix(in srgb, var(--hira-accent, #3b82f6) 7%, transparent)));
      box-shadow: inset 0 0 0 1px color-mix(in srgb,
        rgba(168,85,247,0.55) var(--ai-reason-heat-pct),
        color-mix(in srgb, var(--hira-accent, #3b82f6) 22%, transparent));
      color: color-mix(in srgb,
        var(--ai-reason-hot-2) var(--ai-reason-heat-pct),
        var(--hira-accent, #3b82f6));
      font-size: 11px; font-weight: 600;
      transition: box-shadow 140ms var(--hira-ease-standard, ease);
    }
    .ai-reason.is-dragging .ai-reason__value {
      box-shadow: inset 0 0 0 1px color-mix(in srgb,
                    rgba(168,85,247,0.6) var(--ai-reason-heat-pct),
                    color-mix(in srgb, var(--hira-accent, #3b82f6) 40%, transparent)),
                  0 0 12px color-mix(in srgb,
                    rgba(168,85,247,0.5) var(--ai-reason-heat-pct),
                    var(--ai-reason-glow));
    }
    .ai-reason__rail { position: relative; padding: 0 10px; }
    .ai-reason__track {
      position: relative; height: 32px; border-radius: 9px;
      cursor: pointer; touch-action: none; outline: none;
    }
    .ai-reason.is-dragging .ai-reason__track { cursor: grabbing; }
    /* 底轨：一根**略厚的圆角矩形**（不是全胶囊：半径只取一小截），
       厚度大过拇指，把拇指整个包在里面 */
    .ai-reason__track::before {
      content: ''; position: absolute; left: 0; right: 0; top: 50%;
      height: 22px; transform: translateY(-50%); border-radius: 7px;
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.16),
                  inset 0 0 0 1px var(--ai-line),
                  inset 0 -1px 0 rgba(255,255,255,0.18);
    }
    /* 推进条：与底轨同厚，手柄在它内部滑行；
       颜色随热度从主题色连续过渡到紫→品红（不是到档位才换色）。 */
    .ai-reason__fill {
      position: absolute; left: 0; top: 50%; height: 22px;
      /* 末端跟着手柄中心走：两端各让出半个手柄，手柄才不会被推进条顶出轨道 */
      width: calc(var(--ai-reason-half) + var(--ai-reason-end-gap) + var(--ai-reason-t, 0) * (100% - var(--ai-reason-thumb-w) - 2 * var(--ai-reason-end-gap)));
      transform: translateY(-50%); border-radius: 7px;
      background: linear-gradient(90deg,
        color-mix(in srgb,
          var(--ai-reason-hot-1) var(--ai-reason-heat-pct),
          color-mix(in srgb, var(--hira-accent, #3b82f6) 65%, transparent)),
        color-mix(in srgb,
          var(--ai-reason-hot-2) var(--ai-reason-heat-pct),
          color-mix(in srgb, var(--hira-accent, #3b82f6) 82%, transparent)) 55%,
        color-mix(in srgb,
          var(--ai-reason-hot-3) var(--ai-reason-heat-pct),
          var(--hira-accent, #3b82f6)));
      box-shadow:
        0 0 calc(8px + var(--ai-reason-heat) * 5px)
          color-mix(in srgb, rgba(168,85,247,0.6) var(--ai-reason-heat-pct), var(--ai-reason-glow)),
        inset 0 -1px 0 rgba(255,255,255,0.22);
      overflow: hidden;
      transition: box-shadow 240ms var(--hira-ease-standard, ease);
    }
    /* 星点层常驻，透明度 = 热度：中→高 一路星星渐显，到「高」满格 */
    .ai-reason__fill::after {
      content: ''; position: absolute; inset: 0; border-radius: inherit;
      background-image:
        radial-gradient(1.6px 1.6px at 10% 32%, #fff 55%, transparent 62%),
        radial-gradient(1.1px 1.1px at 26% 68%, #fff 55%, transparent 62%),
        radial-gradient(1.8px 1.8px at 44% 38%, #fff 55%, transparent 62%),
        radial-gradient(1.2px 1.2px at 63% 66%, #fff 55%, transparent 62%),
        radial-gradient(1.5px 1.5px at 82% 34%, #fff 55%, transparent 62%);
      background-size: 96px 100%;
      background-repeat: repeat-x;
      animation: ai-reason-stars 1.8s linear infinite;
      opacity: var(--ai-reason-heat, 0);
      pointer-events: none;
    }
    /* 停靠点：玻璃珠 —— 未越过的半透明白，越过的点亮并带光晕 */
    .ai-reason__dot {
      position: absolute; top: 50%; width: 6px; height: 6px;
      margin-left: -3px; transform: translateY(-50%); border-radius: 50%;
      background: rgba(255,255,255,0.55);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.35);
      transition: background 120ms var(--hira-ease-standard, ease),
                  box-shadow 120ms var(--hira-ease-standard, ease);
    }
    .ai-reason__dot.is-passed {
      background: #fff;
      box-shadow: 0 0 6px color-mix(in srgb,
        rgba(255,255,255,0.9) var(--ai-reason-heat-pct),
        var(--ai-reason-glow));
    }
    /* 手柄：正方形圆角块（与轨道同一套 R 角语言，只是更小），
       高度小于轨道厚度、行程两端再让出 end-gap —— 上下左右都被轨道包住。 */
    .ai-reason__thumb {
      position: absolute; top: 50%;
      left: calc(var(--ai-reason-half) + var(--ai-reason-end-gap) + var(--ai-reason-t, 0) * (100% - var(--ai-reason-thumb-w) - 2 * var(--ai-reason-end-gap)));
      width: var(--ai-reason-thumb-w); height: var(--ai-reason-thumb-h);
      margin-left: calc(var(--ai-reason-half) * -1);
      transform: translateY(-50%);
      border-radius: 5px;
      background: linear-gradient(180deg, #fff 0%, var(--hira-surface, #fff) 78%);
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.9),
        0 1px 4px rgba(0,0,0,0.26),
        0 0 calc(7px + var(--ai-reason-heat) * 4px) -1px color-mix(in srgb,
          rgba(168,85,247,0.7) var(--ai-reason-heat-pct),
          var(--ai-reason-glow));
      transition: transform 130ms var(--hira-ease-standard, ease),
                  box-shadow 160ms var(--hira-ease-standard, ease);
      pointer-events: none;
    }
    /* 拖拽时的脉冲环（平时透明，不占视觉） */
    .ai-reason__thumb::after {
      content: ''; position: absolute; inset: -2px; border-radius: 7px;
      border: 1.5px solid color-mix(in srgb,
        rgba(232,121,249,0.55) var(--ai-reason-heat-pct),
        color-mix(in srgb, var(--hira-accent, #3b82f6) 45%, transparent));
      opacity: 0;
    }
    .ai-reason__track:hover .ai-reason__thumb { transform: translateY(-50%) scale(1.06); }
    .ai-reason.is-dragging .ai-reason__fill,
    .ai-reason.is-dragging .ai-reason__thumb { transition: none; }
    .ai-reason.is-dragging .ai-reason__thumb {
      transform: translateY(-50%) scale(1.14);
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.95),
        0 2px 6px rgba(0,0,0,0.28),
        0 0 calc(11px + var(--ai-reason-heat) * 5px) -1px color-mix(in srgb,
          rgba(168,85,247,0.75) var(--ai-reason-heat-pct),
          var(--ai-reason-glow));
    }
    .ai-reason.is-dragging .ai-reason__thumb::after {
      opacity: 1;
      animation: ai-reason-pulse 1.2s ease-out infinite;
    }
    .ai-reason__track:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--hira-accent, #3b82f6) 70%, transparent);
      outline-offset: 6px;
    }
    .ai-reason__labels { position: relative; height: 13px; margin-top: 1px; }
    .ai-reason__label {
      position: absolute; top: 0; white-space: nowrap;
      font-size: 10.5px; line-height: 13px;
      color: var(--hira-text-tertiary, #8a8f98);
      cursor: pointer; user-select: none;
      transition: color 120ms var(--hira-ease-standard, ease),
                  text-shadow 120ms var(--hira-ease-standard, ease);
    }
    .ai-reason__label:hover { color: var(--hira-text-secondary, #6b7280); }
    .ai-reason__label.is-active {
      color: color-mix(in srgb,
        var(--ai-reason-hot-2) var(--ai-reason-heat-pct),
        var(--hira-accent, #3b82f6));
      font-weight: 600;
      text-shadow: 0 0 10px color-mix(in srgb,
        rgba(168,85,247,0.5) var(--ai-reason-heat-pct),
        var(--ai-reason-glow));
    }
    .ai-reason__hint {
      min-height: 13px; font-size: 10.5px; line-height: 13px;
      color: var(--hira-text-tertiary, #8a8f98);
    }

    /* 星点逆行：背景往左走 ⇒ 星轨看起来从右往左流（与"向右升温"的推进方向相反） */
    @keyframes ai-reason-stars {
      from { background-position: 0 0; }
      to { background-position: -96px 0; }
    }

    @keyframes ai-reason-pulse {
      from { transform: scale(0.72); opacity: 0.85; }
      to { transform: scale(1.5); opacity: 0; }
    }

    /* ── 会话侧栏 ──────────────────────────────────────────────────
       窄面板：从左侧覆盖主对话区，由顶部按钮收起。
       宽页面 / 窗口：以真实 flex 列常驻在主对话区左侧，宽度不足时自动退出常驻。 */
    .ai-drawer {
      position: absolute; top: 4px; bottom: 4px; left: 4px; z-index: 20;
      width: min(88%, 310px);
      display: flex; flex-direction: column;
      padding: 10px 10px 6px;
      border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.08));
      border-radius: var(--hira-radius-lg, 14px);
      background: var(--hira-surface, #fff);
      box-shadow: var(--hira-shadow-md, 0 8px 24px rgba(0,0,0,0.16));
      animation: ai-drawer-in 140ms var(--hira-ease-standard, ease);
    }
    .ai-drawer[hidden] { display: none; }
    .ai-drawer.is-docked {
      position: relative; inset: auto; z-index: auto;
      flex: 0 0 264px; width: 264px; max-width: 264px;
      align-self: stretch;
      margin: 4px 10px 4px 0;
      padding: 10px 9px 8px;
      border-color: var(--hira-border-subtle, rgba(0,0,0,0.08));
      border-radius: var(--hira-radius-md, 10px);
      background: color-mix(in srgb, var(--hira-surface, #fff) 88%, var(--hira-surface-soft, rgba(0,0,0,0.04)));
      box-shadow: none;
      animation: none;
    }
    @container (max-width: 820px) {
      .ai-drawer.is-docked { flex-basis: 236px; width: 236px; max-width: 236px; }
    }
    .ai-drawer__head {
      display: flex; align-items: center; gap: 8px;
      padding: 2px 0 10px; flex: 0 0 auto;
    }
    .ai-drawer__title { flex: 1 1 auto; min-width: 0; font-size: var(--ai-fs-title); font-weight: 600; }
    .ai-drawer__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 2px; scrollbar-width: thin; }
    /* 抽屉顶部的检索框：与设置页输入框同一套观感，只是带一颗前置图标 */
    .ai-drawer__search {
      display: flex; align-items: center; gap: 6px;
      padding: 0 10px; margin-bottom: 8px;
      height: var(--ai-control-h, 30px);
      border: 1px solid transparent; border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-field-bg, rgba(0,0,0,0.05));
    }
    .ai-drawer__search:focus-within { border-color: var(--hira-accent, #3b82f6); }
    .ai-drawer__search-glyph { flex: 0 0 auto; display: flex; color: var(--hira-text-tertiary, #8a8f98); }
    /* .ai-panel 前缀同样是为了压过 base.css 的 input[type='search']（见输入区注释）。 */
    .ai-panel .ai-drawer__search-input {
      flex: 1 1 auto; min-width: 0; height: 100%;
      padding: 0; border: 0; background: transparent; box-shadow: none; color: inherit;
      font: inherit; font-size: var(--ai-fs-meta); outline: none;
    }
    .ai-panel .ai-drawer__search-input::placeholder { color: var(--hira-text-tertiary, #8a8f98); }
    /* ── 会话列表 ──────────────────────────────────────────────────── */
    .ai-sessions { display: flex; flex-direction: column; gap: 2px; }
    .ai-sessions[hidden] { display: none; }
    .ai-session {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 10px; border-radius: var(--hira-radius-sm, 8px);
      border: 0; background: transparent; color: inherit;
      font: inherit; text-align: left; cursor: pointer; min-width: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .ai-session:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    /* 当前会话：底色 + 左侧一道强调条（只靠浅底在窄面板里几乎看不出来） */
    .ai-session.is-active {
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      box-shadow: inset 2px 0 0 var(--hira-accent, #3b82f6);
    }
    .ai-session.is-active .ai-session__title { font-weight: 600; }
    /* 检索命中行：标题 + 时间一行，下面是两行截断的片段 */
    .ai-session--hit { flex-direction: column; align-items: stretch; gap: 2px; }
    .ai-session__hit-head {
      display: flex; align-items: baseline; gap: 6px; min-width: 0;
    }
    .ai-session__hit-head .ai-session__title { flex: 1 1 auto; min-width: 0; font-weight: 500; }
    .ai-session__snippet {
      font-size: 11.5px; line-height: 1.5; color: var(--hira-text-secondary, #6b7280);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; overflow-wrap: anywhere;
    }
    .ai-session__snippet mark {
      background: var(--hira-accent-soft, rgba(59,130,246,0.2));
      color: var(--hira-accent, #3b82f6); border-radius: 3px; padding: 0 1px;
    }
    /* 行主体是一个"透明按钮"：整块可点，但外观完全由行自己决定 */
    .ai-session__pick {
      flex: 1 1 auto; min-width: 0;
      display: flex; flex-direction: column; gap: 1px;
      padding: 0; border: 0; background: transparent;
      color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .ai-session__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--ai-fs-body); }
    .ai-session__time { font-size: 11.5px; color: var(--hira-text-tertiary, #8a8f98); }
    .ai-session__actions { display: none; align-items: center; gap: 4px; flex: 0 0 auto; }
    .ai-session__actions .ai-icon-btn { width: 26px; height: 26px; border-radius: 7px; }
    .ai-session:hover .ai-session__actions, .ai-session.is-active .ai-session__actions { display: flex; }
    .ai-session.is-renaming { background: var(--hira-field-bg, rgba(0,0,0,0.05)); }
    /* .ai-panel 前缀同上：否则内部页里改名框会退化成 base 的通用字段（0 10px 内边距 + 软底）。 */
    .ai-panel .ai-session__rename {
      flex: 1 1 auto; min-width: 0; height: auto; padding: 2px 4px;
      border: 1px solid var(--hira-accent, #3b82f6); border-radius: 4px;
      background: var(--hira-surface, #fff); color: inherit; font: inherit; outline: none;
      box-shadow: none;
    }

    /* ── 入场动效：只动 transform / opacity（合成层，不触发布局） ───────── */
    @keyframes ai-drawer-in {
      from { opacity: 0; transform: translateX(-8px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes ai-pop-in {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ai-drawer, .ai-popover { animation: none; }
      .ai-reason__thumb::after { animation: none; }
      /* 星点流动降级为静态星点（信息还在，动画去掉） */
      .ai-reason__fill::after { animation: none; }
    }

    /* ── 窄档再收一档（容器真正的宽度，不是窗口宽度）─────────────── */
    @container (max-width: 300px) {
      .ai-panel { --ai-gap: 10px; --ai-bubble-pad: 8px 10px; }
      .ai-chip__label { max-width: 140px; }
      .ai-msg__bubble { max-width: 96%; }
    }
    @container (min-width: 560px) {
      .ai-panel { --ai-gap: 18px; }
    }
  `
  ;(doc.head || doc.documentElement).appendChild(style)
}
