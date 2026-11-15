/**
 * SiteInfo Overlay 样式（唯一真源）。
 *
 * ── 视觉词汇从哪来（对齐，而不是自创）──────────────────────────────────────
 * 卡片本体 / 滚动区 / 分组标题 / 分隔线 / 行 / 行内文字块，全部复用
 * `ui-common#overlayCard` 的共享类名与共享样式（`.hira-overlay-card` /
 * `-scroll` / `-group` / `-sep` / `-row` / `-label`）—— 与空间切换菜单
 * （profileswitcher / ui-space-switcher）**逐像素同源**。
 *
 * 本文件只写「站点信息浮层独有的部件」：
 *   · 身份头（图标 / 主机名 / 安全徽标）
 *   · 键值行、待处理权限卡、下拉、开关、空态说明
 *   · 顶部 notice 条（卡片内的一枚圆角提示块）
 * 圆角 / 阴影 / 边框 / 底色 / 行距 **一律不再本地定义** —— 那是第二份实现。
 *
 * ── 为什么是 JS 而不是 css 文件 ────────────────────────────────────────────
 * 浮层是独立 WebContentsView，构建链只把 `index.html` 当入口 —— 样式以字符串注入
 * 是这类独立 renderer 的既有范式（见 searchbar-overlay）。同一份字符串也让
 * 「尺寸常量」与 view.js 共享（`SITEINFO_METRICS`），避免 CSS 里写 360、JS 里写 340。
 *
 * ── 设计约束 ──────────────────────────────────────────────────────────────
 *   · 只用令牌（`--hira-*`）取色，深浅色由主题控制器推来的令牌决定，本文件不判断模式；
 *   · 仅「令牌表里没有的语义色」在 `.si-card` 上就地定义，并给 `[data-theme='dark']`
 *     覆盖 —— 语义色集中一份，不在各处写死十六进制；
 *   · 警告一律用红色（`--hira-danger`），不引入琥珀色/黄色，避免整卡看起来「告警」；
 *   · 所有类名 `si-` 前缀，绝不污染浮层外的任何选择器（本视图只有本卡片）。
 */

// 深路径引用（避开 ui-common 重桶）—— 浮层启动只评估真正用到的模块。
import { injectCommonStyles } from '@hira-ng/ui-common/src/panelShell'
import { injectOverlayCardStyles } from '@hira-ng/ui-common/src/overlayCard'

export const SITEINFO_STYLE_ID = 'hira-siteinfo-styles'

/**
 * 几何常量：view.js 与 CSS 共用。
 *
 * ── 四边留白为什么要分开报 ─────────────────────────────────────────────────
 * `padX` / `padTop` / `padBottom` 是**阴影留白**（outer 尺寸 = 卡片尺寸 + 留白）。
 * 卡片阴影只向下投（见 `.si-card` 的 box-shadow），所以：
 *   · `padTop = 0` —— 上方不留白，卡片顶就直接贴着 gap 走，不再浪费一整条空气；
 *   · `padX = 16` / `padBottom = 26` —— 左右与下方的留白必须足够大，
 *     否则阴影会被原生视图的边界**裁掉**（用户看到的"阴影缺一块"）。
 * 主进程 `LayoutCoordinator#anchorFloatBelow` 认一个数或 `{top,right,bottom,left}`，
 * 这里上报四边对象，数字形态留给 searchbar 下拉（行为逐字不变）。
 */
export const SITEINFO_METRICS = Object.freeze({
  padX: 16,
  padTop: 0,
  padBottom: 26,
  gap: 10,
  edgeMargin: 8,
  width: 360,
  minWidth: 260,
  maxHeight: 460,
  minHeight: 180
})

export const SITEINFO_CSS = `
/* ── 卡片壳（几何 + 语义色；外观来自 .hira-overlay-card）──────────────── */
.si-card {
  /* 强调/成功色跟随主题令牌（深浅两档由主题自己给值，这里不再写媒体查询/暗色覆盖）。
     --si-* 只是本卡片内部的短别名，方便下面的规则读起来短。 */
  --si-accent: var(--hira-accent, #3b82f6);
  --si-success: var(--hira-success, #1a7f37);
  --si-success-bg: var(--hira-success-bg, rgba(26, 127, 55, 0.10));

  position: fixed;
  /* 卡片在原生视图里的落点 = 留白宽度；上方留白为 0 → 卡片顶就是视图顶。 */
  left: ${SITEINFO_METRICS.padX}px;
  top: ${SITEINFO_METRICS.padTop}px;
  display: none;
  flex-direction: column;
  width: ${SITEINFO_METRICS.width}px;
  overflow: hidden;
  /* 只向下投的阴影：偏移量(10) ≥ 模糊半径(16) − 收缩(2) 时上半部分不可见 →
     等价于"去掉上方那一截"，卡片下方 12px 内是清晰的投影，左右各 14px。
     共享卡片词汇（.hira-overlay-card）是 0 8px 24px（上方 4px、下方 20px），
     本条与它同特异度，但 injectSiteInfoStyles 在其后注入 → 本条胜出。 */
  box-shadow: 0 10px 16px -2px rgba(0, 0, 0, 0.22);
  font-size: 12px;
  line-height: 1.45;
  user-select: none;
}
.si-card.is-open { display: flex; }

/* 程序化 focus（Esc 需要视图持焦）不该画出 UA 焦点环 —— 这就是用户看到的「黄框」。 */
.si-card:focus,
.si-card:focus-visible { outline: none; }

/* ── 滚动区（padding 由 .hira-overlay-scroll 提供）────────────────────── */
.si-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--hira-track-bg, rgba(0, 0, 0, 0.1)) transparent;
}
.si-body::-webkit-scrollbar { width: 8px; }
.si-body::-webkit-scrollbar-track { background: transparent; }
.si-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--hira-radius-2xs, 4px);
  background: var(--hira-track-bg, rgba(0, 0, 0, 0.1));
  background-clip: content-box;
}

/* ── 分区骨架（不再有各自的内边距与 border-top，间距交给共享词汇）────── */
.si-section { min-width: 0; }
.si-section-head { display: flex; align-items: center; gap: 8px; min-height: 18px; }
.si-section-title { font: inherit; }
.si-section-meta {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--hira-text-tertiary, #9ca3af);
}
.si-section-body { min-width: 0; }
.si-section-body:empty { display: none; }

/* ── 文字按钮 ───────────────────────────────────────────────────────── */
.si-link {
  margin-left: auto;
  padding: 2px 5px;
  border: 0;
  border-radius: var(--hira-radius-xs, 6px);
  background: none;
  color: var(--si-accent);
  font: inherit;
  font-size: 11.5px;
  font-weight: 400;
  letter-spacing: 0;
  cursor: pointer;
}
.si-link:hover { background: var(--hira-hover-bg, rgba(128, 128, 128, 0.12)); }
.si-pending-more .si-link { margin-left: 0; }

/* ── 身份头 ─────────────────────────────────────────────────────────── */
.si-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 8px;
}
.si-identity-favicon {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  overflow: hidden;
  border-radius: var(--hira-radius-control, 7px);
  background: var(--hira-surface-soft, rgba(128, 128, 128, 0.1));
  color: var(--hira-text-secondary, #6b7280);
}
.si-identity-favicon-img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}
.si-identity-favicon-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--hira-font-ui, "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif);
}
.si-identity-text { flex: 1 1 auto; min-width: 0; }
.si-identity-host {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.si-identity-sub {
  margin-top: 1px;
  overflow: hidden;
  font-size: 11px;
  color: var(--hira-text-secondary, #6b7280);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.si-identity-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
}
.si-identity-badge.is-secure {
  color: var(--si-success);
  background: var(--si-success-bg);
}
.si-identity-badge.is-insecure {
  color: var(--hira-danger, #dc2626);
  background: var(--hira-danger-bg, rgba(220, 38, 38, 0.08));
}
.si-identity-badge-icon { display: flex; }

/* ── 键值行（证书）—— 行的 padding / hover 由 .hira-overlay-row 提供 ── */
.si-kv { gap: 10px; }
.si-kv-key {
  flex: 0 0 58px;
  color: var(--hira-text-secondary, #6b7280);
}
.si-kv-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.si-kv-value.is-warning { color: var(--hira-danger, #dc2626); }

/* ── 说明文字 / 统计摘要（与行内文字同一条左缘）──────────────────────── */
.si-note {
  margin-top: 2px;
  padding: 2px 8px 4px;
  font-size: 11.5px;
  color: var(--hira-text-secondary, #6b7280);
}
.si-note.is-warning { color: var(--hira-danger, #dc2626); }
.si-summary {
  padding: 2px 8px 4px;
  font-size: 11.5px;
  color: var(--hira-text-secondary, #6b7280);
}

/* ── 通用行（结构来自 .hira-overlay-row，这里只补站点信息专属）────────── */
.si-rows { display: flex; flex-direction: column; }
.si-row { min-height: 26px; }
.si-row-label { font-size: 12px; }
.si-icons {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  color: var(--hira-text-secondary, #6b7280);
}
.si-icons svg { display: block; }
.si-row-actions {
  display: flex;
  justify-content: flex-end;
  padding: 2px 8px;
}

/* ── 菜单行（footer 深链）────────────────────────────────────────────── */
.si-menu-row { min-height: 28px; }
.si-menu-icon {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  color: var(--hira-text-secondary, #6b7280);
}

/* ── 下拉（权限设置）────────────────────────────────────────────────── */
.si-select {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 20px 0 8px;
  appearance: none;
  border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
  border-radius: var(--hira-radius-xs, 6px);
  background-color: var(--hira-field-bg, rgba(128, 128, 128, 0.08));
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  color: var(--hira-text-primary, #1a1a1a);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.si-select:hover { background-color: var(--hira-field-bg-focus, rgba(128, 128, 128, 0.14)); }
.si-select:disabled { opacity: 0.55; cursor: default; }

/* ── 待处理权限请求 ─────────────────────────────────────────────────── */
.si-pending {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 0 4px;
}
.si-subhead {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 8px;
}
.si-subhead-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--si-accent);
}
.si-subhead-meta {
  font-size: 10.5px;
  color: var(--hira-text-tertiary, #9ca3af);
}
.si-pending-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 6px;
}
.si-pending-card {
  padding: 8px;
  border-radius: var(--hira-radius-sm, 8px);
  background: var(--hira-surface-soft, rgba(128, 128, 128, 0.08));
}
.si-pending-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.si-pending-label {
  font-size: 12px;
  font-weight: 600;
}
.si-pending-more { padding: 0 8px; }
.si-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.si-choice {
  height: 24px;
  border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.1));
  border-radius: var(--hira-radius-xs, 6px);
  background: var(--hira-surface, #ffffff);
  color: var(--hira-text-primary, #1a1a1a);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.si-choice:hover { background: var(--hira-hover-bg, rgba(128, 128, 128, 0.12)); }
.si-choice--allow-once,
.si-choice--allow-always { color: var(--si-accent); }
.si-choice--deny-once,
.si-choice--deny-always { color: var(--hira-danger, #dc2626); }
.si-choice:disabled { opacity: 0.5; cursor: default; }

/* ── 开关（内容拦截）────────────────────────────────────────────────── */
.si-switch {
  position: relative;
  flex: 0 0 auto;
  margin-left: auto;
  width: 32px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--hira-track-bg, rgba(0, 0, 0, 0.15));
  cursor: pointer;
  transition: background 0.16s ease;
}
.si-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 0.16s ease;
}
.si-switch.is-on { background: var(--si-accent); }
.si-switch.is-on .si-switch-thumb { transform: translateX(14px); }
.si-switch:disabled,
.si-switch.is-busy { opacity: 0.55; cursor: default; }

/* ── 顶部提示条（卡片内的一枚圆角条，不再横贯整卡）────────────────────── */
.si-notice {
  display: none;
  margin: 6px 6px 0;
  padding: 6px 8px;
  border-radius: var(--hira-radius-sm, 8px);
  font-size: 11.5px;
}
.si-notice.is-visible { display: block; }
.si-notice.is-error {
  color: var(--hira-danger, #dc2626);
  background: var(--hira-danger-bg, rgba(220, 38, 38, 0.08));
}
.si-notice.is-info {
  color: var(--hira-text-secondary, #6b7280);
  background: var(--hira-surface-soft, rgba(128, 128, 128, 0.08));
}

/* ── 交互细节 ───────────────────────────────────────────────────────── */
.si-card button,
.si-card select { -webkit-app-region: no-drag; }
.si-card button:focus { outline: none; }
.si-card button:focus-visible,
.si-card select:focus-visible {
  outline: 2px solid var(--si-accent);
  outline-offset: 1px;
}
.si-card [hidden] { display: none !important; }
`

/**
 * 幂等注入。多次调用（热重载 / 重复 mount）不会产生第二份 `<style>`。
 * 先保证共享词汇（common + overlayCard）在位，再落本浮层的专属样式。
 * @param {Document} doc
 */
export function injectSiteInfoStyles(doc: Document) {
  injectCommonStyles(doc)
  injectOverlayCardStyles(doc)
  if (doc.getElementById(SITEINFO_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = SITEINFO_STYLE_ID
  style.textContent = SITEINFO_CSS
  doc.head.appendChild(style)
}

