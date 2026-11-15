/**
 * 画板（D4）两形态共用的样式注入。
 *
 * ⚠ **令牌名**：面板与子窗口里存在的是 `--hira-*` 那一套（见 `shared-ui-tokens/tokens-base.css`），
 * 不是内部页 `base.css` 的 `--surface/--text/--border`。此前这里写的是后者，
 * 于是在面板/窗口里全部落空 —— 表现就是"按钮没样式"。两形态的样式**只认 `--hira-*`**。
 *
 * 用 `id` 守卫做幂等：面板会被反复挂载（切面板 / 换 profile 重新 mount），
 * 每次挂载都插一遍 <style> 会让文档里堆几十份同内容样式。
 */

const STYLE_ID = 'hira-easel-styles'

export function injectEaselStyles(doc: Document, css: string) {
  if (!doc || !doc.head) return
  const existing = doc.getElementById(STYLE_ID)
  if (existing) {
    // 内容变了才替换（开发期热更新 / 两形态先后挂载时保证拿到最新一份）。
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  doc.head.appendChild(style)
}

/** 两形态共用的原子（按钮 / 下拉 / 分隔线）。 */
const ATOMS = `
.hira-easel-btn {
  font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1;
  height: var(--hira-control-height, 32px); box-sizing: border-box;
  padding: 0 12px; cursor: pointer;
  border: 0; border-radius: var(--hira-radius-sm, 8px);
  background: transparent; color: var(--hira-text-primary, #1a1a1a);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.hira-easel-btn:hover { background: var(--hira-surface-soft, rgba(0,0,0,.05)); }
.hira-easel-btn:disabled { opacity: .4; cursor: default; }
.hira-easel-btn.primary { background: var(--hira-accent, #2563eb); color: var(--hira-on-accent, #fff); }
.hira-easel-btn.primary:hover { background: color-mix(in srgb, var(--hira-accent, #2563eb) 88%, #000); }
.hira-easel-btn.danger { color: var(--hira-danger, #dc2626); }
.hira-easel-btn.danger:hover { background: var(--hira-danger-bg, rgba(220,38,38,.08)); }
.hira-easel-select {
  font-family: inherit; font-size: 12px;
  height: var(--hira-control-height, 32px); box-sizing: border-box;
  padding: 0 10px; border-radius: var(--hira-radius-sm, 8px); max-width: 200px;
  background: var(--hira-field-bg, rgba(0,0,0,.04)); color: var(--hira-text-primary, #1a1a1a);
  border: 0; outline: none;
}
.hira-easel-select:focus-visible { box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,.35)); }
.hira-easel-sep { width: 1px; align-self: stretch; margin: 6px 4px; background: var(--hira-hairline, rgba(0,0,0,.08)); }
.hira-easel-grow { flex: 1 1 auto; }
`

/** 面板形态的样式。 */
export const PANEL_CSS = ATOMS + `
.hira-easel-panel { display: flex; flex-direction: column; height: 100%; width: 100%; }
/* ⚠ 横向内边距一律留 0：面板外壳（宿主 renderer/panels/main.js 建的 createPanelShell）
   已经给了内容边距。这里再叠一层，再加上行自己的内边距 → 左右缩进比别的面板宽一倍。
   全仓面板的同一口径是「列表无内边距、行自带内边距」。 */
.hira-easel-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 0 8px; display: flex; flex-direction: column; gap: 4px; }
.hira-easel-board {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; min-height: var(--hira-row-height, 36px); box-sizing: border-box;
  border-radius: var(--hira-radius-md, 10px); cursor: pointer;
  background: transparent; border: 0;
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.hira-easel-board:hover { background: var(--hira-surface-soft, rgba(0,0,0,.05)); }
.hira-easel-board .meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hira-easel-board .name {
  font-size: 12px; font-weight: 500; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hira-easel-board .sub { font-size: 11px; line-height: 15px; color: var(--hira-text-tertiary, #8b8b8b); }
.hira-easel-empty {
  padding: 48px 20px; text-align: center; font-size: 12px; line-height: 19px;
  color: var(--hira-text-tertiary, #8b8b8b);
}
/* 底部动作条：同样横向 0 —— 与上面的行**左右对齐**，不被自己的内边距再推一格。 */
.hira-easel-bar { display: flex; gap: 6px; padding: 8px 0 0; margin-top: 6px; }
`

/** 独立窗口（画布编辑器）的样式。 */
export const WINDOW_CSS = ATOMS + `
.hira-easel-window { display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; background: var(--hira-bg-surface, #f9fafb); }
.hira-easel-toolbar {
  display: flex; align-items: center; gap: 4px; padding: 8px 12px; flex-shrink: 0; flex-wrap: wrap;
  background: transparent;
}
/* 工具按钮：方形图标钮，选中态用 accent 软底 —— 无描边、无实心块，与面板按钮同一语言。 */
.hira-easel-tool {
  width: var(--hira-control-height, 32px); height: var(--hira-control-height, 32px); padding: 0; cursor: pointer; font-size: 15px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--hira-radius-sm, 8px);
  background: transparent; color: var(--hira-text-secondary, #6b7280);
  font-family: inherit;
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.hira-easel-tool:hover { background: var(--hira-surface-soft, rgba(0,0,0,.04)); color: var(--hira-text-primary, #1a1a1a); }
.hira-easel-tool.is-active {
  background: var(--hira-accent-soft, rgba(59,130,246,.14)); color: var(--hira-accent, #2563eb);
}
/* 图标按钮里的 SVG 统一 16px；退化的字符图标也走同一格，免得一排按钮高矮不齐。 */
.hira-easel-tool svg, .hira-easel-btn svg { width: 16px; height: 16px; display: block; }
.hira-easel-tool .glyph { font-size: 14px; line-height: 1; }

/* 画板下拉：**自绘**而不是 <select> —— 原生下拉的弹层是 OS 窗口，
   在无边框子窗口里既不受主题控制、也容易被窗口焦点变化打断（"点了打不开"）。 */
.hira-easel-dd { position: relative; }
.hira-easel-dd-btn { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; }
.hira-easel-dd-btn .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hira-easel-dd-btn svg { width: 14px; height: 14px; }
.hira-easel-menu {
  /* 下拉菜单：按渲染层 z-index 门禁的兜底写法保留原值（语义层待定 —— 见 scripts/check-z-index.cjs）。
     ⚠ 本文件的样式是模板字符串，注释里**不能出现反引号**，否则会提前闭合字符串。 */
      position: absolute; top: calc(100% + 6px); left: 0; z-index: var(--hira-z-tooltip);
  min-width: 240px; max-height: 320px; overflow: auto; padding: 6px;
  border-radius: var(--hira-radius-lg, 14px); background: var(--hira-surface, #fff);
  border: 0;
  box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.10);
}
.hira-easel-menu[hidden] { display: none; }
.hira-easel-menu .item {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: var(--hira-radius-sm, 8px);
  cursor: pointer; font-size: 12px; color: var(--hira-text-primary, #1a1a1a);
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.hira-easel-menu .item:hover { background: var(--hira-surface-soft, rgba(0,0,0,.04)); }
.hira-easel-menu .item.is-active { color: var(--hira-accent, #2563eb); background: var(--hira-accent-soft, rgba(37,99,235,.14)); }
.hira-easel-menu .item .meta { flex: 1 1 auto; min-width: 0; }
.hira-easel-menu .item .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hira-easel-menu .item .sub { font-size: 11px; line-height: 15px; color: var(--hira-text-secondary, #6b7280); }

/* 线宽：三个实心圆点（比下拉更直观，也少一个原生控件）。 */
.hira-easel-width { display: inline-flex; align-items: center; gap: 4px; }
.hira-easel-width button {
  width: 30px; height: var(--hira-control-height, 32px); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; border: 0; border-radius: var(--hira-radius-sm, 8px);
  background: transparent; color: var(--hira-text-secondary, #6b7280);
  font-family: inherit;
  transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
}
.hira-easel-width button:hover { background: var(--hira-surface-soft, rgba(0,0,0,.04)); color: var(--hira-text-primary, #1a1a1a); }
.hira-easel-width button.is-active { background: var(--hira-accent-soft, rgba(59,130,246,.14)); color: var(--hira-accent, #2563eb); }
.hira-easel-width .dot { border-radius: 50%; background: currentColor; }
.hira-easel-swatches { display: flex; align-items: center; gap: 5px; }
.hira-easel-swatch {
  width: 18px; height: 18px; padding: 0; cursor: pointer; border-radius: 50%;
  border: 0; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12);
}
.hira-easel-swatch.is-active { box-shadow: inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 2px var(--hira-bg-surface, #f9fafb), 0 0 0 3.5px var(--hira-accent, #2563eb); }
/* 缩放三件套（− 百分比 +）：两个方形图标钮夹一个居中百分比。 */
.hira-easel-zoombar { display: inline-flex; align-items: center; gap: 4px; }
.hira-easel-btn.icon {
  width: var(--hira-control-height, 32px); height: var(--hira-control-height, 32px); padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.hira-easel-zoom {
  min-width: 44px; text-align: center; font-size: 11px;
  font-variant-numeric: tabular-nums; color: var(--hira-text-secondary, #6b7280);
}

.hira-easel-canvas {
  position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
  /* 背景色 / 网格点色**不在这里定**：它属于画板内容（board.background，随画板持久化，
     不跟随主题），由 window/index.js#applyBackground 写成内联样式。
     点距与相位同样由 JS 每帧写入（见 updateGrid）。这里只留布局与光标。 */
}
.hira-easel-canvas.is-panning { cursor: grabbing; }
.hira-easel-canvas.is-drawing { cursor: crosshair; }
.hira-easel-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
/* SVG 层：1×1 但 overflow:visible —— 路径按世界坐标画，不受画布尺寸约束。 */
.hira-easel-svg { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
.hira-easel-svg .hira-stroke { fill: none; stroke-linecap: round; stroke-linejoin: round; pointer-events: stroke; }
.hira-easel-svg .hira-stroke.is-selected { filter: drop-shadow(0 0 4px var(--hira-accent, #2563eb)); }
.hira-easel-svg .hira-stroke.is-hit { pointer-events: stroke; }

.hira-easel-card {
  position: absolute; display: flex; flex-direction: column; overflow: hidden;
  border-radius: var(--hira-radius-md, 10px); box-shadow: 0 2px 10px rgba(0,0,0,.16);
  background: var(--hira-surface, #fff); color: var(--hira-text-primary, #1a1a1a);
  border: 1px solid var(--hira-border-subtle, rgba(0,0,0,.12));
}
.hira-easel-card.is-selected { border-color: var(--hira-accent, #2563eb); box-shadow: 0 4px 18px color-mix(in srgb, var(--hira-accent, #2563eb) 35%, transparent); }
.hira-easel-card-head {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: move; flex-shrink: 0;
  font-size: 11px; color: var(--hira-text-secondary, #6b7280);
  background: var(--hira-surface-soft, rgba(0,0,0,.04));
}
.hira-easel-card-head .kind { font-weight: 600; }
.hira-easel-card-head .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.hira-easel-card-head .grow { flex: 1 1 auto; }
/* 色点 = 跨面板拖拽手柄（按住再拖出去）。 */
.hira-easel-card-head .dot.is-grip { width: 10px; height: 10px; cursor: grab; box-shadow: 0 0 0 3px transparent; }
.hira-easel-card-head .dot.is-grip:hover { box-shadow: 0 0 0 3px var(--hira-hover-bg, rgba(0,0,0,.08)); }
.hira-easel-card.is-dragging { opacity: .45; }
/* 拖入画布时整块画布给一个明确的"可以放这里"信号。 */
.hira-easel-canvas.is-drop-target { outline: 2px dashed var(--hira-accent, #2563eb); outline-offset: -2px; }
/* 卡片头部的小动作：+ 子节点 / 删除。图标钮，hover 才显眼。 */
.hira-easel-card-head .act {
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; border: none; background: transparent; color: inherit; padding: 1px; opacity: .7;
}
.hira-easel-card-head .act svg { width: 13px; height: 13px; display: block; }
.hira-easel-card-head .act:hover { opacity: 1; color: var(--hira-accent, #2563eb); }
.hira-easel-card-head .act.del:hover { color: var(--hira-danger, #dc2626); }
.hira-easel-card-body { flex: 1 1 auto; min-height: 0; padding: 8px; overflow: auto; font-size: 13px; }
.hira-easel-card-body textarea {
  width: 100%; height: 100%; border: none; outline: none; resize: none; font: inherit;
  background: transparent; color: inherit;
}
.hira-easel-card-body a { color: var(--hira-accent, #2563eb); word-break: break-all; }
.hira-easel-card-body img { max-width: 100%; max-height: 100%; display: block; }
.hira-easel-resize {
  position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, var(--hira-border-subtle, rgba(0,0,0,.3)) 50%);
  border-bottom-right-radius: 10px;
}
/* 画布背景选择：一个圆点色块 + 下拉菜单（三项固定纸色）。 */
.hira-easel-bg-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; }
.hira-easel-bg-btn svg { width: 14px; height: 14px; }
.hira-easel-bg-dot {
  width: 15px; height: 15px; border-radius: 50%; flex: 0 0 auto;
  border: 1px solid var(--hira-border-subtle, rgba(0,0,0,.28));
}
.hira-easel-menu .item.bg .nm { flex: 1 1 auto; }
`
