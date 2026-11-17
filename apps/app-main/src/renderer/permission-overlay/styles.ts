/**
 * 权限申请浮层样式（唯一真源）。
 *
 * ── 视觉词汇从哪来（对齐，而不是自创）──────────────────────────────────────
 * 卡片本体（圆角 / 边框 / 底色 / 阴影 / 文字色）复用 `ui-common#overlayCard` 的共享类
 * `.hira-overlay-card` —— 与空间切换菜单、站点信息浮层**逐像素同源**。
 * 本文件只写「权限申请浮层独有的部件」：
 *   · 请求卡（图标 + 站点 + 一句请求说明 + 敏感标记）
 *   · 四档决定按钮（允许一次 / 始终允许 / 阻止一次 / 始终阻止）
 * 圆角 / 阴影 / 边框 / 底色**一律不再本地定义** —— 那是第二份实现。
 *
 * ── 为什么四按钮必须"大"（而不是 ✓ / ✕ 两个小图标）─────────────────────────
 * 权限申请是**必须被看见并当场决定**的模态语义。两个无字图标按钮会逼用户先猜
 * 哪个是允许、再猜会不会被记住（旧实现把"是否写库"整个藏进了两个图标里）。
 * 四档带字按钮把「一次 / 始终」这层语义直接摆在按钮上 —— 文案与 allow·persist
 * 语义全部来自 `shared-types#PERMISSION_CHOICES` 单一真源，本文件只负责配色：
 * 「一次」浅底描边（轻决定），「始终」实心（会写库、影响以后，视觉上就该更重）。
 * 配色与侧栏权限面板（ui-panel-permissions）同一套值，两处观感一致。
 *
 * ── 为什么是 JS 而不是 css 文件 ────────────────────────────────────────────
 * 浮层是独立 WebContentsView，构建链只把 `index.html` 当入口 —— 样式以字符串注入
 * 是这类独立 renderer 的既有范式（见 siteinfo-overlay/styles.js 的同段说明）。
 * 同一份字符串也让「尺寸常量」与 main.js 共享（PERMISSION_METRICS），
 * 避免 CSS 里写 380、JS 里写 360。
 *
 * ── 设计约束 ──────────────────────────────────────────────────────────────
 *   · 只用令牌（`--hira-*`）取色，深浅色由主题控制器推来的令牌决定，本文件不判断模式；
 *   · 仅「令牌表里没有的语义色」（四档决定的绿 / 红）就地定义并给 `[data-theme='dark']`
 *     覆盖 —— 语义色集中一份，不在各处写死十六进制；
 *   · 所有类名 `hira-permission-` 前缀，绝不污染浮层外的任何选择器。
 */

// 深路径引用（避开 ui-common 重桶）—— 浮层启动只评估真正用到的模块。
import { injectOverlayCardStyles } from '@hira-ng/ui-common/src/overlayCard'
import { injectListOverflowStyles } from '@hira-ng/ui-common/src/listOverflow'

export const PERMISSION_STYLE_ID = 'hira-permission-styles'

/**
 * 几何常量：main.js 与 CSS 共用。
 * 三个方向分开留白：左侧只负责离网页边缘的距离，右侧与底部分别承接
 * `box-shadow` 的水平扩散和向下偏移。视图 outer 尺寸因此不会被阴影边界裁切。
 * `width` 是卡片固定宽度 —— 四个中文按钮要一字排开且都够大，宽度必须由宿主定死，
 * 不能随内容（域名长短 / 权限名长短）抖动；高度则由内容自然决定、实测上报。
 */
export const PERMISSION_METRICS = Object.freeze({
  leftPad: 28,
  rightPad: 48,
  bottomPad: 56,
  width: 380
})

export const PERMISSION_CSS = `
/* ── 浮层根：贴视图左上角，卡片纵向排（多条请求同时到达时叠成一列）──────── */
.hira-permission-popover {
  position: fixed;
  left: var(--pp-left-pad, ${PERMISSION_METRICS.leftPad}px);
  top: 0;
  display: none;
  flex-direction: column;
  gap: 8px;
  width: ${PERMISSION_METRICS.width}px;
  font-size: 13px;
  line-height: 1.45;
  user-select: none;
}
.hira-permission-popover.is-open { display: flex; }

/* 请求列表：多条请求纵向排开（含末尾那条「转到权限面板」的省略行）——
   间距与 popover 的 gap 一致，卡片之间不会挤成一片。 */
.hira-permission-list { display: flex; flex-direction: column; gap: 8px; }

/* ── 请求卡 ──────────────────────────────────────────────────────────────
   外观（圆角 / 边框 / 底色 / 阴影）来自共享的 .hira-overlay-card；
   这里只改定位 —— 共享类为「贴触发器」的浮层写成 position:fixed; left/top:0，
   而本浮层是**卡片列**（外层 .hira-permission-popover 才是那个固定定位的盒子），
   卡片应随列布局流动，故显式改回 relative 并清掉 left/top。 */
.hira-permission-card {
  position: relative;
  left: auto;
  top: auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  cursor: default;
}

/* ── 头部：图标 + 站点 + 请求说明（与旧版站点权限询问框同构的两行式）──── */
.hira-permission-head { display: flex; align-items: center; gap: 10px; }
.hira-permission-icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--hira-accent, #3b82f6);
}
/* display:inline-flex 会盖掉 [hidden] 的 UA 样式（未识别类型没有图标），必须显式写回来 */
.hira-permission-icon[hidden] { display: none; }
.hira-permission-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hira-permission-host {
  font-size: 14px;
  font-weight: 600;
  color: var(--hira-text-primary, #1a1a1a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hira-permission-desc {
  font-size: 12px;
  color: var(--hira-text-secondary, #6b7280);
  white-space: normal;
  overflow-wrap: anywhere;
}
/* 敏感权限标记：琥珀色药丸，与侧栏权限面板 .perm-panel__sensitive 同一语义色 */
.hira-permission-sensitive {
  margin-left: 6px;
  font-size: 10px;
  padding: 0 5px;
  border-radius: var(--hira-radius-2xs, 4px);
  color: var(--hira-warn, #d97706);
  border: 1px solid var(--hira-warn, #d97706);
}

/* ── 四档决定：整行四个等宽大按钮 ───────────────────────────────────────── */
.hira-permission-choices { display: flex; gap: 6px; }
.hira-permission-btn {
  flex: 1 1 0;
  height: 34px;
  padding: 0 6px;
  font: inherit;
  font-size: 13px;
  border: 1px solid transparent;
  border-radius: var(--hira-radius-xs, 6px);
  background: transparent;
  color: var(--hira-text-primary, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}
.hira-permission-btn:active { opacity: 0.78; }
/* 键盘可达：焦点环只给键盘用户，不给鼠标点出来的按钮画框 */
.hira-permission-btn:focus-visible { outline: 2px solid var(--hira-accent, #3b82f6); outline-offset: 1px; }

/* 四档决定：语义色全部走令牌（--hira-success / --hira-danger 深浅两档由主题自己给值），
   本文件不再写 [data-theme='dark'] 覆盖 —— 那是主题体系之外的第二套规则。 */
.hira-permission-btn--allow-once { color: var(--hira-success, #15803d); border-color: color-mix(in srgb, var(--hira-success, #16a34a) 45%, transparent); background: var(--hira-success-bg, rgba(22, 163, 74, 0.10)); }
.hira-permission-btn--allow-always { color: #fff; font-weight: 600; background: var(--hira-success, #16a34a); border-color: var(--hira-success, #16a34a); }
.hira-permission-btn--deny-once { color: var(--hira-danger, #b91c1c); border-color: color-mix(in srgb, var(--hira-danger, #dc2626) 45%, transparent); background: var(--hira-danger-bg, rgba(220, 38, 38, 0.10)); }
.hira-permission-btn--deny-always { color: #fff; font-weight: 600; background: var(--hira-danger, #dc2626); border-color: var(--hira-danger, #dc2626); }
/* 实心档的悬停必须显式声明，否则会被通用 hover 底灰盖掉 */
.hira-permission-btn--allow-once:hover { background: color-mix(in srgb, var(--hira-success, #16a34a) 18%, transparent); }
.hira-permission-btn--allow-always:hover { background: color-mix(in srgb, var(--hira-success, #16a34a) 88%, #000); border-color: color-mix(in srgb, var(--hira-success, #16a34a) 88%, #000); }
.hira-permission-btn--deny-once:hover { background: color-mix(in srgb, var(--hira-danger, #dc2626) 18%, transparent); }
.hira-permission-btn--deny-always:hover { background: color-mix(in srgb, var(--hira-danger, #dc2626) 88%, #000); border-color: color-mix(in srgb, var(--hira-danger, #dc2626) 88%, #000); }

/* 空态：正常路径不会出现（列表清空时外壳直接收起浮层），只作为兜底不留白块 */
.hira-permission-empty {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--hira-text-secondary, #6b7280);
}
`

/**
 * 注入样式（幂等）。
 * 先注入共享卡片词汇，再注入本浮层独有的部件 —— 顺序保证共享类先落地，
 * 本文件对 `.hira-permission-card` 的定位覆盖才稳定压在共享规则之后。
 * @param {Document} doc
 */
export function injectPermissionStyles(doc: Document) {
  injectOverlayCardStyles(doc)
  // 省略行（「还有 N 项 · 转到权限面板」）的共用样式 —— 与选择目标 / 站点信息浮层同源。
  injectListOverflowStyles(doc)
  if (doc.getElementById(PERMISSION_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = PERMISSION_STYLE_ID
  style.textContent = PERMISSION_CSS
  doc.head.appendChild(style)
}

