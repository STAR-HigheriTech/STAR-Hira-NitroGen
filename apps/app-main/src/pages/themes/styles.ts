// @ts-check
/**
 * themes/styles.js —— 主题页专属样式（两栏布局 / 卡片 / 表单控件 / 迷你预览）。
 *
 * 与共享层 `themes/styles.js` 的分工：这里只放**只有整页才要**的东西。
 * 颜色一律走 `--hira-*` 令牌（+兜底值），于是本页自身跟着当前主题换肤。
 *
 * 预览段（`.thm-preview*`）的**每一块都只用令牌**：那些令牌由 JS 写在预览子树的
 * 根上（见 preview.js），所以预览画的是**草稿**的皮肤，而不是页面自己的。
 */

const THEME_PAGE_CSS = `
/* ══ 骨架：视图切换 与 两栏 ═════════════════════════════════════ */
.thm-win__views { flex: 1 1 auto; min-height: 0; display: none; }
.thm-win__views[data-active="1"] { display: flex; }
.thm-win__pane { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px; }

.thm-lib { flex: 1 1 auto; display: flex; min-height: 0; }
/**
 * 左右两栏的宽度：左侧（主题库）是**定宽 + 可拖**，右侧（编辑器）吃剩余。
 * 为什么默认给编辑区更多：编辑器是"要动手"的那一半（六格取色器 + 一堆滑杆），
 * 而主题库只是"选一个"。默认值写在这里，用户拖动后由 JS 写 --thm-list-w 覆盖。
 * ⚠ 本段是 CSS 模板字符串的一部分，注释里不能出现反引号。
 */
.thm-lib__list { flex: 0 0 var(--thm-list-w, 380px); min-width: 0; overflow: auto; padding: 12px 12px 16px; }
.thm-lib__split {
  flex: 0 0 6px; cursor: col-resize; position: relative;
  /* 分隔条自己就是那条 1px 线：它既是视觉分界，也是拖拽把手（命中区 6px 好抓）。 */
}
.thm-lib__split::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px;
  transform: translateX(-50%);
  background: var(--hira-border-subtle, rgba(0,0,0,0.08));
  transition: background .12s ease, width .12s ease;
}
.thm-lib__split:hover::after, .thm-lib__split[data-dragging="1"]::after {
  width: 2px; background: var(--hira-accent, #3b82f6);
}
.thm-lib__side {
  flex: 1 1 auto; min-width: 340px; display: flex; flex-direction: column;
  overflow: auto;
}
.thm-lib__hint {
  padding: 40px 16px; text-align: center;
  font-size: 12px; line-height: 18px;
  color: var(--hira-text-tertiary, #8b8b8b);
}

/* ══ 主题卡片 ══════════════════════════════════════════════════ */
.thm-card {
  width: 148px; border-radius: var(--hira-radius-lg, 14px); padding: 6px; cursor: pointer; position: relative;
  border: 0;
  background: var(--hira-surface-soft, rgba(0, 0, 0, 0.03));
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
    box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  outline: none;
}
.thm-card:hover { background: var(--hira-hover-bg, rgba(0, 0, 0, 0.06)); }
.thm-card:focus-visible { box-shadow: var(--hira-focus-ring); }
.thm-card[data-active="1"] {
  background: var(--hira-accent-soft, rgba(59, 130, 246, 0.12));
  box-shadow: inset 0 0 0 1.5px var(--hira-accent, #3b82f6);
}
.thm-card__shot {
  position: relative; height: 62px; border-radius: var(--hira-radius-sm, 8px); overflow: hidden;
  background-size: cover; background-position: center;
}
.thm-card__strip { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; display: flex; }
.thm-card__cell { flex: 1 1 0; }
.thm-card__check {
  position: absolute; top: 4px; right: 4px; width: 16px; height: 16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 10px;
  background: var(--hira-accent, #3b82f6); color: var(--badge-font-color, #fff);
}
/* 「视频」角标：卡片不抽首帧，用一个小标说明"这条主题带动态壁纸"。
   压在左上角（右下角是配色条、右上角是选中勾）。 */
.thm-card__flag {
  position: absolute; top: 4px; left: 4px;
  padding: 1px 5px; border-radius: var(--hira-radius-xs, 6px);
  font-size: 10px; line-height: 14px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
.thm-card__meta { padding: 6px 2px 2px; }
.thm-card__name { display: flex; align-items: center; gap: 5px; }
.thm-card__title {
  font-size: 12px; font-weight: 500; line-height: 17px; color: var(--hira-text-primary, #1a1a1a);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.thm-card__sub { font-size: 10.5px; line-height: 14px; color: var(--hira-text-tertiary, #8b8b8b); margin-top: 1px; }

/* ══ 表单控件 ═════════════════════════════════════════════════ */
.thm-section-title {
  font-size: 11px; font-weight: 500; letter-spacing: .02em;
  color: var(--hira-text-tertiary, #8b8b8b);
  margin: 18px 0 8px; padding-bottom: 0;
  border-bottom: 0;
}
.thm-section-title:first-child { margin-top: 0; }
/* 次级标题：同一大节内部再分组（「材质与玻璃 / 其它外观」），字号更小、间距更紧 */
.thm-section-title--sub {
  font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
  margin: 14px 0 6px; opacity: .85;
}

/* 「套用推荐值」一行：按钮 + 一句"不锁死"的说明，横排且允许换行 */
.thm-glass__actions {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 0 2px;
}
/* 材质说明 / 推荐值旁的辅助文字（与 .thm-note 同用时由 .thm-note 决定底色） */
.thm-glass__hint { font-size: 10.5px; line-height: 15px; }

.thm-field { display: flex; align-items: center; gap: 12px; padding: 5px 0; }
.thm-field__head { flex: 0 0 108px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.thm-field__label { font-size: 12px; line-height: 17px; color: var(--hira-text-primary, #1a1a1a); }
.thm-field__hint { font-size: 10px; line-height: 14px; color: var(--hira-text-tertiary, #8b8b8b); }

/* 表单里的一条**整行说明**（不是控件下方那行小字 hint）。
   用于"这条来源有一条必须知道的限制"——目前是：动态壁纸不参与「自动」前景判定。 */
.thm-note {
  padding: 8px 10px; border-radius: var(--hira-radius-sm, 8px);
  font-size: 11px; line-height: 16px;
  color: var(--hira-text-secondary, #6b7280);
  background: var(--hira-surface-soft, rgba(0, 0, 0, 0.03));
}
.thm-note--warn {
  color: var(--hira-warn, #b45309);
  background: var(--hira-warn-bg, rgba(180, 83, 9, 0.10));
}
.thm-field__control { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; }

.thm-input, .thm-select {
  font-family: inherit; font-size: 12px; width: 100%; min-width: 0;
  height: 28px; padding: 0 8px; box-sizing: border-box;
  border-radius: var(--hira-radius-sm, 8px);
  border: 0;
  background: var(--hira-field-bg, rgba(0, 0, 0, 0.04));
  color: var(--hira-text-primary, #1a1a1a);
  outline: none;
  transition: box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.thm-input:focus-visible, .thm-select:focus-visible { box-shadow: var(--hira-focus-ring); }
.thm-input:disabled { opacity: .5; }

/* ── 原生下拉：弹出列表也要跟主题走 ───────────────────────────────────
 * ⚠ 本段是 CSS 模板字符串的一部分，注释里**不能出现反引号**（会提前闭合字符串）。
 * 弹出列表由**浏览器自己绘制**（不是我们 DOM 里的一块），它取的是控件自己的
 * color-scheme 与选项的颜色，而**不认**页面声明的那些变量。只靠继承时，
 * 深色主题下就会看到"这个主题是深色的、列表却是另一种深"。
 * 两件事都要做：
 *   ① 把 color-scheme 钉在控件上（按主题明暗显式给，不赌继承链）；
 *   ② 给 option 不透明底色 + 前景色 —— 部分平台上列表行底色直接取自 option。
 * 底色用"抬升面"（--hira-surface）而不是输入框那层更淡的 field 色：
 * 弹层在视觉上是一块浮起来的列表，与编辑器里的卡片同层。 */
html[data-theme='dark'] .thm-select,
html[data-theme='dark'] .thm-input { color-scheme: dark; }
html[data-theme='light'] .thm-select,
html[data-theme='light'] .thm-input { color-scheme: light; }
.thm-select option {
  background-color: var(--hira-surface, #ffffff);
  color: var(--hira-text-primary, #1a1a1a);
}

.thm-slider { display: flex; align-items: center; gap: 8px; width: 100%; }
.thm-slider__input { flex: 1 1 auto; min-width: 0; accent-color: var(--hira-accent, #3b82f6); }
.thm-slider__value { flex: 0 0 44px; text-align: right; font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }

.thm-color { display: flex; align-items: center; gap: 8px; width: 100%; }
.thm-color__picker {
  flex: 0 0 30px; width: 30px; height: 26px; padding: 0; border-radius: var(--hira-radius-xs, 6px);
  border: 0;
  background: var(--hira-field-bg, rgba(0, 0, 0, 0.04)); cursor: pointer;
}
.thm-color__hex { flex: 1 1 auto; min-width: 0; font-family: var(--hira-font-mono, ui-monospace, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace); }

/* 「图片」一行：选择按钮 + 文件名 + 清除。
   文件名是**只读反馈**（"我选的是哪张"），不是输入框 —— 用户主题的图拷进资产库后
   只剩一个内部 key，让他编辑它既没意义也会诱导他去写一个不生效的路径。 */
.thm-image { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.thm-image__name {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px;
  color: var(--hira-text-secondary, #6b7280);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.thm-checks { display: flex; align-items: center; gap: 12px; }
.thm-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer; }
.thm-check__box { width: 14px; height: 14px; accent-color: var(--hira-accent, #3b82f6); cursor: pointer; }
.thm-check__label { color: var(--hira-text-primary, #1a1a1a); }

/* 编辑器页脚（保存 / 另存为 / 删除） */
.thm-editor__foot {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-top: 1px solid var(--hira-hairline, rgba(0, 0, 0, 0.06));
  position: sticky; bottom: 0; background: var(--hira-surface, #f9fafb);
}
.thm-editor__foot-spacer { flex: 1 1 auto; }
.thm-editor__title { font-size: 12px; font-weight: 600; }
.thm-editor__note { font-size: 10.5px; color: var(--hira-text-tertiary, #8b8b8b); }

/* 调度 / 私密窗口 这种"一列设置"的页面 */
.thm-form { max-width: 560px; }
.thm-form__desc { font-size: 11px; line-height: 16px; color: var(--hira-text-secondary, #6b7280); margin: 2px 0 12px; }
/* 只读事实行（着色模式只剩一档）：与控件行同高，右列是一句结论 */
.thm-value { font-size: 12px; line-height: 17px; color: var(--hira-text-primary, #1a1a1a); }
.thm-rows { display: flex; flex-direction: column; gap: 2px; }
.thm-row {
  display: flex; align-items: center; gap: 10px;
  min-height: var(--hira-row-height, 36px);
  padding: 6px 10px; border-radius: var(--hira-radius-md, 10px);
  border: 0;
  background: var(--hira-surface-soft, rgba(0, 0, 0, 0.03));
}
.thm-row__grow { flex: 1 1 auto; min-width: 0; }

/* ══ 迷你浏览器预览 ═══════════════════════════════════════════ */
.thm-preview { padding: 8px 10px 2px; flex: 0 0 auto; }
.thm-preview__frame {
  position: relative; height: 232px; border-radius: var(--hira-radius-lg, 14px); overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--hira-surface, #f9fafb);
  border: 0;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.14);
  /* 缩略图内部的层叠**自成一体**：chrome / 页面区压在背景层之上，而 frame 自己不参与
     外层的层叠 —— 否则内部的层号会与外层同级元素打架（隔离层不产生新的层号）。 */
  isolation: isolate;
}
.thm-preview__bg, .thm-preview__overlay { position: absolute; inset: 0; pointer-events: none; }
.thm-preview__overlay { transition: background .12s ease; }

.thm-preview__chrome {
  position: relative; z-index: var(--hira-z-elevated);
}
/* UI 模糊只作用于 chrome 玻璃面；壁纸自身的 blur 已在背景层内独立处理。 */
.thm-preview[data-bg="1"] .thm-preview__chrome,
.thm-preview[data-bg="1"] .thm-preview__stage {
  -webkit-backdrop-filter: blur(var(--hira-ui-blur, var(--hira-chrome-blur, 10px)));
  backdrop-filter: blur(var(--hira-ui-blur, var(--hira-chrome-blur, 10px)));
}
/* chrome 两行用主题的**玻璃色**（--hira-chrome-bg）：无壁纸时它就是主题底色，
   有壁纸时是"底色 + alpha"——于是预览里的工具栏与真实窗口**同色同透明度**，
   不需要另写一套"预览用的透视系数"。 */
.thm-preview__top {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 4px;
  background: var(--hira-chrome-bg, #fff);
}
.thm-preview__dots { display: flex; gap: 4px; flex: 0 0 auto; }
.thm-preview__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hira-border-subtle, rgba(0,0,0,0.2)); }
.thm-preview__dot:first-child { background: #ff5f57; }
.thm-preview__dot:nth-child(2) { background: #febc2e; }
.thm-preview__dot:nth-child(3) { background: #28c840; }
.thm-preview__tabs { display: flex; align-items: flex-end; gap: 3px; min-width: 0; flex: 1 1 auto; }
.thm-preview__tab {
  font-size: 10.5px; padding: 3px 10px; border-radius: 6px 6px 0 0;
  color: var(--hira-text-secondary, #6b7280); background: transparent;
  max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.thm-preview__tab[data-active="1"] {
  background: var(--hira-surface, #f9fafb);
  color: var(--hira-text-primary, #1a1a1a);
  box-shadow: inset 0 2px 0 var(--hira-accent, #3b82f6);
}
.thm-preview__nav {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px;
  background: var(--hira-chrome-bg, #fff);
}
.thm-preview__nav-left, .thm-preview__nav-right { display: flex; gap: 4px; flex: 0 0 auto; }
.thm-preview__nav-btn {
  width: 16px; height: 16px; border-radius: 50%; font-size: 10px; line-height: 16px;
  text-align: center; color: var(--hira-text-secondary, #6b7280);
  background: var(--hira-hover-bg, rgba(0,0,0,0.05));
}
.thm-preview__address {
  flex: 1 1 auto; min-width: 0; font-size: 10.5px; padding: 4px 10px; border-radius: var(--hira-radius-xs, 6px);
  color: var(--hira-text-secondary, #6b7280);
  background: var(--hira-field-bg, rgba(0,0,0,0.05));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.thm-preview__stage { position: relative; z-index: var(--hira-z-elevated); flex: 1 1 auto; min-height: 0; display: flex; }
.thm-preview__content { flex: 1 1 auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.thm-preview__hero { text-align: center; color: var(--ntp-text, var(--hira-text-primary, #1a1a1a)); }
.thm-preview__hero-title { font-size: 20px; font-weight: 300; letter-spacing: .02em; }
.thm-preview__hero-sub { font-size: 10.5px; opacity: .7; }
.thm-preview__grid { display: flex; flex-wrap: wrap; gap: 6px; }
.thm-preview__tile {
  width: 52px; height: 34px; border-radius: var(--hira-radius-sm, 8px); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 3px;
  background: var(--hira-surface-soft, rgba(0,0,0,0.04));
  border: 0;
}
.thm-preview__tile-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--hira-accent, #3b82f6); }
.thm-preview__tile-bar { width: 26px; height: 3px; border-radius: 2px; background: var(--hira-text-tertiary, rgba(0,0,0,0.2)); }
/* 有背景时内容区不再画自己的底，避免把背景盖住 */
.thm-preview[data-bg="1"] .thm-preview__tile { background: rgba(255,255,255,0.14); }
`

/** 注入窗口样式（幂等）。 */
export function injectPageStyles(doc: Document) {
  if (!doc || doc.getElementById('thm-theme-page-styles')) return
  const style = doc.createElement('style')
  style.id = 'thm-theme-page-styles'
  style.textContent = THEME_PAGE_CSS
  doc.head.appendChild(style)
}
