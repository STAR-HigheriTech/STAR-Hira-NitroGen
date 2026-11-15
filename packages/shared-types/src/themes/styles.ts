/**
 * shared/styles.js —— 两个形态**必须逐字相同**的基础样式（原子 + 骨架）。
 *
 * 边界（与本仓其它双形态包同一条纪律）：
 *   · 这里放容器 / 按钮原子 / 分组块 / 空态 / 状态条 —— 两形态都要，且长得一样；
 *   · 布局与形态特有的块（编辑器的两栏、预览 mock）进各自目录的 styles.js。
 *
 * 全部颜色走 `--hira-*` 令牌（由宿主的 theme-controller 注入）并带兜底值：
 * 令牌拿不到时界面仍然可读。**不在这里写任何字面配色主题** —— 主题一变就露馅。
 */

const SHARED_CSS = `
.thm-root {
  font-size: 12px;
  color: var(--hira-text-primary, #1a1a1a);
  background: var(--hira-bg-surface, #f9fafb);
  height: 100%;
  /* 两个形态的宿主都是 flex 列（面板内容区 / 窗口 surface）—— 同时给上伸缩属性，
     这样"宿主给的是 flex 项"时也铺满，而不是塌成内容高度。 */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── 工具条 ─────────────────────────────────────────────────── */
.thm-bar {
  display: flex; align-items: center; gap: 4px;
  padding: 0 0 6px;
  flex: 0 0 auto;
}
.thm-bar__spacer { flex: 1 1 auto; }

/* ── 按钮 ───────────────────────────────────────────────────── */
.thm-btn {
  font-family: inherit; font-size: 12px; font-weight: 500;
  height: var(--hira-control-height, 32px); padding: 0 12px;
  border-radius: var(--hira-radius-sm, 8px); cursor: pointer;
  border: 0;
  background: transparent;
  color: var(--hira-text-primary, #1a1a1a);
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  -webkit-app-region: no-drag;
  white-space: nowrap;
}
.thm-btn:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.06)); }
.thm-btn:disabled { opacity: .4; cursor: default; }
.thm-btn--ghost { color: var(--hira-text-secondary, #6b7280); }
.thm-btn--ghost:hover { color: var(--hira-text-primary, #1a1a1a); }
.thm-btn--primary {
  background: var(--hira-accent, #3b82f6);
  color: var(--hira-on-accent, #fff);
}
.thm-btn--primary:hover { background: color-mix(in srgb, var(--hira-accent, #3b82f6) 88%, #000); }
.thm-btn--danger { color: var(--hira-danger, #dc2626); }
.thm-btn--danger:hover { background: var(--hira-danger-bg, rgba(220,38,38,0.08)); }
.thm-btn--sm { height: 26px; padding: 0 8px; font-size: 11.5px; }

/* 分段控件（库 / 调度 / 私密窗口 这一类平级视图切换） */
.thm-seg {
  display: inline-flex; gap: 1px; padding: 2px;
  border-radius: var(--hira-radius-md, 10px);
  background: var(--hira-field-bg, rgba(0,0,0,0.04));
}
.thm-seg__item {
  font-family: inherit; font-size: 12px; font-weight: 500;
  height: 26px; padding: 0 10px; border: 0;
  border-radius: var(--hira-radius-sm, 8px);
  background: transparent; color: var(--hira-text-secondary, #6b7280); cursor: pointer;
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  -webkit-app-region: no-drag;
}
.thm-seg__item:hover { color: var(--hira-text-primary, #1a1a1a); }
.thm-seg__item[data-active="1"] {
  background: var(--hira-surface, #fff);
  color: var(--hira-text-primary, #1a1a1a);
  font-weight: 600; /* 只有选中项加粗（未选中 500，中文落到 Regular） */
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}

/* ── 内容区 ─────────────────────────────────────────────────── */
.thm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 0 10px; }

/* ── 分组 ───────────────────────────────────────────────────── */
.thm-group { margin-bottom: 10px; }
.thm-group__head { display: flex; align-items: center; gap: 6px; margin: 0 2px 8px; }
.thm-group__title {
  font-size: 11px; font-weight: 500; letter-spacing: .02em;
  color: var(--hira-text-tertiary, #8b8b8b);
}
/* 分组标题右侧动作（如「插件主题」→ 去插件页）：靠右，不与标题抢同一侧 */
.thm-group__action { margin-left: auto; }
.thm-group__body { display: flex; flex-wrap: wrap; gap: 8px; }

/* ── 空态 / 状态条 ──────────────────────────────────────────── */
.thm-empty {
  padding: 48px 20px; text-align: center;
  color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
}
.thm-status { flex: 0 0 auto; padding: 6px 10px; font-size: 11px; min-height: 0; }
.thm-status:empty { display: none; padding: 0; }
.thm-status[data-kind="error"] { color: var(--hira-danger, #dc2626); }
.thm-status[data-kind="ok"] { color: var(--hira-text-tertiary, #8b8b8b); }

/* ── 徽标 ───────────────────────────────────────────────────── */
.thm-badge {
  font-size: 10.5px; padding: 1px 7px; border-radius: var(--hira-radius-xs, 6px);
  background: var(--hira-accent-soft, rgba(59,130,246,0.14));
  color: var(--hira-accent, #3b82f6);
}
.thm-badge--muted { background: var(--hira-bg-subtle, rgba(0,0,0,0.05)); color: var(--hira-text-secondary, #6b7280); }
`

/** 注入共享样式（幂等：同一文档注入两次不会叠加两份规则）。 */
export function injectSharedStyles(doc: Document | null | undefined): void {
  if (!doc || doc.getElementById('thm-shared-styles')) return
  const style = doc.createElement('style')
  style.id = 'thm-shared-styles'
  style.textContent = SHARED_CSS
  doc.head.appendChild(style)
}
