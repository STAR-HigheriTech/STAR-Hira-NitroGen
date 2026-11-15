// @ts-check
/**
 * Capture editor surface styles. The native host keeps this document
 * transparent; all chrome is rendered inside the editor so it can stay
 * pixel-aligned with the captured surface.
 */

import { uiFontVar, UI_MONO_STACK } from '@hira-ng/shared-types/src/font-stack.mjs'

const STYLE_ID = 'hira-capture-editor-styles'

export function injectCaptureEditorStyles(doc: Document, css: string): void {
  if (!doc?.head) return
  const existing = doc.getElementById(STYLE_ID)
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  doc.head.appendChild(style)
}

export const WINDOW_CSS = `
/* ── Layers ───────────────────────────────────────────────────────── */
/* Numeric layers are intentional. This view is loaded without the global
   layer-token sheet, so relying on --hira-z-* made z-index invalid. */
.hira-capture-editor {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: #f7f8fa;
  font: 12px/1.4 ${uiFontVar()};
  -webkit-user-select: none;
  user-select: none;
}

.hira-capture-stage {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  background: rgba(9, 11, 14, .48);
  transition: background-color .18s ease-out;
  overflow: hidden;
  touch-action: none;
}

.hira-capture-stage.is-veiled {
  background: transparent;
}

.hira-capture-ui {
  position: absolute;
  inset: 0;
  z-index: var(--hira-z-scrim, 30);
  pointer-events: none;
}

/* ── Captured document ────────────────────────────────────────────── */
.hira-capture-wrap {
  position: absolute;
  left: 0;
  top: 0;
  z-index: var(--hira-z-elevated, 1);
  overflow: hidden;
  line-height: 0;
  background: #fff;
  box-shadow: 0 16px 54px rgba(0, 0, 0, .46), 0 0 0 1px rgba(255, 255, 255, .12);
  transform-origin: 0 0;
  contain: layout paint style;
}

.hira-capture-wrap.is-panning {
  will-change: transform;
}

.hira-capture-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
  background: #fff;
}

.hira-capture-text {
  position: absolute;
  z-index: var(--hira-z-popover, 8);
  margin: 0;
  padding: 2px 4px;
  border: 1px solid rgba(255, 255, 255, .86);
  border-radius: 3px;
  outline: 2px solid rgba(15, 118, 110, .8);
  outline-offset: 1px;
  resize: none;
  overflow: hidden;
  box-sizing: content-box;
  min-width: 64px;
  background: rgba(17, 24, 39, .2);
  font-family: ${uiFontVar()};
  font-weight: 600;
  line-height: 1.3;
  white-space: pre;
}

/* ── Floating control dock ────────────────────────────────────────── */
.hira-capture-toolbar {
  position: absolute;
  z-index: var(--hira-z-elevated, 1);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  width: min(920px, calc(100vw - 16px));
  min-height: 44px;
  padding: 6px 7px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 12px;
  background: rgba(24, 27, 33, .985);
  color: #f5f6f8;
  box-shadow:
    0 18px 48px rgba(0, 0, 0, .42),
    0 2px 8px rgba(0, 0, 0, .28),
    inset 0 1px rgba(255, 255, 255, .04);
  pointer-events: auto;
  touch-action: manipulation;
  opacity: .98;
}

.hira-capture-group {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  min-width: 0;
}

.hira-capture-tools,
.hira-capture-colors,
.hira-capture-widths,
.hira-capture-view-actions,
.hira-capture-delivery {
  display: flex;
  align-items: center;
}

.hira-capture-tools {
  gap: 2px;
}

.hira-capture-style {
  gap: 8px;
  padding: 0 2px;
}

.hira-capture-colors {
  gap: 4px;
}

.hira-capture-widths {
  gap: 1px;
  padding-left: 6px;
  border-left: 1px solid rgba(255, 255, 255, .12);
}

.hira-capture-view-actions {
  gap: 2px;
}

.hira-capture-delivery {
  gap: 3px;
}

.hira-capture-divider {
  width: 1px;
  height: 20px;
  flex: 0 0 1px;
  margin: 0 1px;
  background: rgba(255, 255, 255, .14);
}

.hira-capture-spacer {
  flex: 1 1 auto;
  min-width: 4px;
}

/* ── Controls ─────────────────────────────────────────────────────── */
.hira-capture-button,
.hira-capture-swatch,
.hira-capture-width,
.hira-capture-zoom {
  appearance: none;
  border: 1px solid transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.hira-capture-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  min-width: 32px;
  padding: 0 7px;
  box-sizing: border-box;
  border-radius: 7px;
  background: transparent;
  transition: background-color .1s ease, color .1s ease, border-color .1s ease;
}

.hira-capture-button svg {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  pointer-events: none;
}

.hira-capture-button__label {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
}

.hira-capture-button:hover {
  background: rgba(255, 255, 255, .1);
}

.hira-capture-button:active {
  background: rgba(255, 255, 255, .16);
}

.hira-capture-button:focus-visible,
.hira-capture-swatch:focus-visible,
.hira-capture-width:focus-visible,
.hira-capture-zoom:focus-visible {
  outline: 2px solid #5eead4;
  outline-offset: 1px;
}

.hira-capture-button:disabled {
  opacity: .3;
  cursor: default;
  background: transparent;
}

.hira-capture-tool.is-active {
  border-color: rgba(94, 234, 212, .28);
  background: rgba(20, 184, 166, .2);
  color: #99f6e4;
}

.hira-capture-button--primary {
  border-color: color-mix(in srgb, var(--hira-accent, #0f766e) 70%, #fff 12%);
  background: var(--hira-accent, #0f766e);
  color: var(--hira-on-accent, #fff);
}

.hira-capture-button--primary:hover {
  background: color-mix(in srgb, var(--hira-accent, #0f766e) 88%, #000);
}

.hira-capture-button--primary.is-busy {
  opacity: .72;
}

.hira-capture-button--quiet {
  color: rgba(255, 255, 255, .72);
}

.hira-capture-button--quiet:hover {
  background: rgba(239, 68, 68, .14);
  color: #fecaca;
}

.hira-capture-swatch {
  position: relative;
  width: 19px;
  height: 19px;
  flex: 0 0 19px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, .44);
  border-radius: 50%;
  background: var(--capture-swatch);
  transition: transform .1s ease, box-shadow .1s ease;
}

.hira-capture-swatch:hover {
  transform: scale(1.12);
}

.hira-capture-swatch.is-active {
  transform: scale(1.06);
  box-shadow:
    0 0 0 2px #181b21,
    0 0 0 4px #5eead4;
}

.hira-capture-swatch.is-active::after {
  content: "";
  position: absolute;
  left: 6px;
  top: 4px;
  width: 4px;
  height: 7px;
  border-right: 1.5px solid #fff;
  border-bottom: 1.5px solid #fff;
  transform: rotate(42deg);
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .8));
}

.hira-capture-width {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 29px;
  height: 30px;
  padding: 0;
  border-radius: 6px;
  background: transparent;
}

.hira-capture-width:hover {
  background: rgba(255, 255, 255, .09);
}

.hira-capture-width.is-active {
  border-color: rgba(255, 255, 255, .2);
  background: rgba(255, 255, 255, .13);
}

.hira-capture-width__dot {
  display: block;
  border-radius: 50%;
  background: currentColor;
}

.hira-capture-zoom {
  height: 30px;
  min-width: 48px;
  padding: 0 7px;
  border-color: rgba(255, 255, 255, .12);
  border-radius: 6px;
  background: rgba(255, 255, 255, .055);
  font-family: ${UI_MONO_STACK};
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.hira-capture-zoom:hover {
  background: rgba(255, 255, 255, .11);
}

.hira-capture-zoom.is-fit {
  border-color: transparent;
  background: transparent;
  color: rgba(255, 255, 255, .54);
}

/* ── Transient feedback ───────────────────────────────────────────── */
.hira-capture-status {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 9px);
  z-index: var(--hira-z-popover, 2);
  min-width: max-content;
  max-width: min(320px, calc(100vw - 24px));
  padding: 7px 11px;
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 8px;
  background: rgba(20, 23, 28, .98);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .32);
  color: #f4f4f5;
  font-size: 11px;
  line-height: 1.35;
  text-align: center;
  opacity: 0;
  transform: translate(-50%, 4px);
  transition: opacity .12s ease, transform .12s ease;
  pointer-events: none;
}

.hira-capture-status.is-visible {
  opacity: 1;
  transform: translate(-50%, 0);
}

.hira-capture-status[data-tone="success"] {
  border-color: rgba(52, 211, 153, .34);
  color: #a7f3d0;
}

.hira-capture-status[data-tone="error"] {
  border-color: rgba(248, 113, 113, .34);
  color: #fecaca;
}

/* ── Empty state ──────────────────────────────────────────────────── */
.hira-capture-empty {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: var(--hira-z-popover, 2);
  margin: 0;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, .82);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

/* ── Responsive dock ──────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .hira-capture-toolbar {
    flex-wrap: wrap;
    row-gap: 5px;
    width: min(760px, calc(100vw - 16px));
  }

  .hira-capture-style {
    order: 10;
    flex: 1 0 100%;
    justify-content: center;
    padding-top: 5px;
    border-top: 1px solid rgba(255, 255, 255, .1);
  }

  .hira-capture-spacer,
  .hira-capture-view-actions,
  .hira-capture-delivery {
    order: 2;
  }
}

@media (max-width: 640px) {
  .hira-capture-toolbar {
    gap: 4px;
    width: calc(100vw - 12px);
    padding: 5px 6px;
    border-radius: 10px;
  }

  .hira-capture-tools {
    order: 1;
    flex: 1 0 100%;
    justify-content: space-between;
  }

  .hira-capture-style {
    order: 2;
    justify-content: space-between;
    padding-top: 4px;
  }

  .hira-capture-spacer {
    order: 3;
  }

  .hira-capture-view-actions {
    order: 4;
  }

  .hira-capture-delivery {
    order: 5;
  }

  .hira-capture-divider {
    display: none;
  }

  .hira-capture-button__label {
    display: none;
  }

  .hira-capture-button {
    width: 32px;
    padding: 0;
  }

  .hira-capture-copy .hira-capture-button__label {
    display: none;
  }
}

@media (pointer: coarse) {
  .hira-capture-button {
    min-width: 36px;
    height: 36px;
  }

  .hira-capture-swatch {
    width: 22px;
    height: 22px;
    flex-basis: 22px;
  }

  .hira-capture-width {
    width: 34px;
    height: 34px;
  }

  .hira-capture-zoom {
    height: 34px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hira-capture-stage,
  .hira-capture-button,
  .hira-capture-swatch,
  .hira-capture-status {
    transition: none;
  }
}
`
