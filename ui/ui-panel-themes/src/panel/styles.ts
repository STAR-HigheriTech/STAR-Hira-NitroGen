// @ts-check
/**
 * panel/styles.js —— 侧栏窄面板专属样式（当前主题 / 色卡网格 / 管理入口）。
 *
 * 只有这一形态要的东西才在这里（基础原子在 shared/styles.js）。
 * 窄栏（200~600px）的判据：**一张色卡就够表达一个主题**，不摆名称与作者 ——
 * 一屏能放十几个，这才叫"瞥一眼就能换"。
 */

const PANEL_CSS = `
.thm-panel { height: 100%; display: flex; flex-direction: column; }
.thm-panel__body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 0 8px; }

.thm-panel__current {
  display: flex; align-items: center; gap: 10px;
  padding: 10px; margin-bottom: 10px;
  border-radius: var(--hira-radius-md, 10px);
  background: var(--hira-surface-soft, rgba(0,0,0,0.035));
  border: 0;
}
.thm-panel__dot {
  flex: 0 0 24px; width: 24px; height: 24px; border-radius: 50%;
  border: 0;
  box-shadow: inset 0 0 0 2px var(--hira-bg-surface, #fff);
}
.thm-panel__current-meta { min-width: 0; }
.thm-panel__current-name {
  font-size: 12px; font-weight: 500; line-height: 17px; color: var(--hira-text-primary, #1a1a1a);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.thm-panel__current-sub {
  font-size: 10.5px; line-height: 14px;
  color: var(--hira-text-tertiary, #8b8b8b);
}

.thm-panel__label {
  font-size: 11px; font-weight: 500; letter-spacing: .02em;
  color: var(--hira-text-tertiary, #8b8b8b); margin: 0 2px 10px;
}
.thm-panel__swatches { display: flex; flex-wrap: wrap; gap: 10px; }
.thm-panel__swatch {
  width: 28px; height: 28px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 0;
  background-size: cover; background-position: center;
  transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
              box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
  -webkit-app-region: no-drag;
}
.thm-panel__swatch:hover { transform: scale(1.08); }
.thm-panel__swatch[data-active="1"] {
  box-shadow: 0 0 0 2px var(--hira-bg-surface, #fff), 0 0 0 3.5px var(--hira-accent, #3b82f6);
}
.thm-panel__foot { flex: 0 0 auto; padding: 10px 0; display: flex; flex-direction: column; gap: 6px; }
.thm-panel__foot .thm-btn { width: 100%; justify-content: flex-start; }
`

/** 注入面板样式（幂等）。 */
export function injectPanelStyles(doc: Document): void {
  if (!doc || doc.getElementById('thm-panel-styles')) return
  const style = doc.createElement('style')
  style.id = 'thm-panel-styles'
  style.textContent = PANEL_CSS
  doc.head.appendChild(style)
}
