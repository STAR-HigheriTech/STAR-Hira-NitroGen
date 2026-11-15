/**
 * 扫码器面板 —— 由**插件自带**的渲染侧实现（`entry.render` 的用例）。
 *
 * 本文件只做「装配」这一件事，三块实现各自独立：
 *   · `qr-scanner.model.js`  状态与数据来源（共享内核 + 宿主端口）
 *   · `qr-scanner.view.js`   DOM 渲染与用户意图转译
 *
 * 数据源是**屏幕**：抓屏在主进程（`qr-scanner.cjs` 的能力 `qr.captureScreen`），
 * 经 `ctx.clients.screen` 端口进来，解码复用共享内核 `qr-scan/`（与验证器面板
 * 的扫码导入同一份引擎）—— 所以"准不准"在两条入口上必然一致。
 *
 * 契约（见 renderer/shared/plugin-renderer.js）：
 *   export const rendererPlugin = { panels: [panelDefinition] }
 * `panels[].id` 必须等于 manifest `contributes.panels[].id`（这里都是 `qr-scanner-panel`）。
 */

import { injectPanelStyles } from '@hira-ng/ui-common'
import { createQrScannerModel } from './qr-scanner.model.js'
import { createQrScannerView } from './qr-scanner.view.js'

type QrModelOptions = NonNullable<Parameters<typeof createQrScannerModel>[0]>

interface QrRendererContext {
  clients: unknown
  events?: { qrScanSettled?: string; qrScanFrameClosed?: string }
  on?(route: string, handler: (payload: unknown) => void): () => void
  menu?: { popupMenu(options: unknown): unknown }
}

const STYLE_ID = 'hira-qr-scanner-styles'

function injectQrScannerStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .qrscanner-panel {
      display: flex; flex-direction: column; height: 100%; min-height: 0;
      position: relative; overflow: hidden;
    }
    /* 命中闪光：整块描一圈绿边 —— 扫到没扫到，余光就能看出来 */
    .qrscanner-panel.is-hit {
      box-shadow: inset 0 0 0 2px rgba(74,222,128,0.75);
      transition: box-shadow 0.12s ease;
    }

    /* ── 工具条：主按钮占满剩余宽度（扫描／停止是这里唯一的动作）──
       无分隔线，只靠下方留白与内容分层。 */
    .qrscanner-panel__toolbar {
      display: flex; align-items: center; gap: 6px;
      padding: 0 0 8px; flex-shrink: 0;
    }
    .qrscanner-panel__scan-btn { flex: 1; }
    /* 「⋯」：工具条与行内共用的轻量图标按钮 */
    .qrscanner-panel__icon-btn {
      width: 28px; height: 28px; flex-shrink: 0; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      font-size: 14px; line-height: 1;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .qrscanner-panel__icon-btn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }

    /* ── 状态条：扫描中 / 刚扫到 ──
       固定占位（min-height）避免"有提示/没提示"之间整块跳动 */
    .qrscanner-panel__status {
      display: flex; align-items: center; gap: 6px;
      margin: 0 0 8px; padding: 8px 10px;
      border-radius: var(--hira-radius-sm, 8px);
      min-height: 30px; flex-shrink: 0;
      font-size: 11px; line-height: 1.4;
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
      color: var(--hira-text-secondary, #6b7280);
    }
    .qrscanner-panel__status.is-scanning { color: var(--hira-accent, #3b82f6); }
    /* 刚扫到：变绿 + 加粗 + 脉冲一圈（**这条已经够显眼，保持不动**） */
    .qrscanner-panel__status.is-hit {
      background: rgba(34,197,94,0.14);
      color: #15803d;
      font-weight: 600;
      animation: qrscanner-hit-ring 0.9s ease-out 1;
    }
    @keyframes qrscanner-hit-ring {
      0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.45); }
      100% { box-shadow: 0 0 0 10px rgba(34,197,94,0); }
    }

    .qrscanner-panel__status-text {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 脉冲点：一眼看出"它还在看屏幕"，而不是以为卡住了 */
    .qrscanner-panel__pulse {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: currentColor;
      animation: qrscanner-pulse 1.1s ease-in-out infinite;
    }
    @keyframes qrscanner-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.75); }
    }

    /* ── 就地提示 ── */
    .qrscanner-panel__notice {
      margin: 0 0 8px; padding: 8px 10px;
      border-radius: var(--hira-radius-sm, 8px);
      font-size: 11px; line-height: 1.5;
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .qrscanner-panel__notice.is-error { background: var(--hira-danger-bg, rgba(220,38,38,0.12)); }

    .qrscanner-panel__body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 12px; }
    .qrscanner-panel__list { display: flex; flex-direction: column; gap: 6px; }

    /* ── 一条识别记录 ── */
    .qrscanner-panel__row {
      display: flex; flex-direction: column; gap: 3px;
      padding: 8px 10px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
    }
    /* 最新扫到的那一条：**强力高亮，一直留着**，直到下一条命中把它换下来。
       三层信号都用内阴影实现（不用 border/outline：不挤内边距，文字基线不会差 1px）。 */
    .qrscanner-panel__row.is-new {
      background: rgba(34,197,94,0.16);
      box-shadow: inset 0 0 0 1.5px rgba(22,163,74,0.45), inset 3px 0 0 #16a34a;
    }
    .qrscanner-panel__row.is-new .qrscanner-panel__title { color: #15803d; }
    /* 入场动画：一次性（只在插入时加，重建列表不会重播）—— 从右侧滑入，看得见"新的来了" */
    .qrscanner-panel__row.is-pop { animation: qrscanner-row-pop 0.34s cubic-bezier(0.2,0.9,0.3,1) 1; }
    @keyframes qrscanner-row-pop {
      0% { transform: translateX(14px) scale(0.97); opacity: 0; }
      100% { transform: none; opacity: 1; }
    }
    .qrscanner-panel__head { display: flex; align-items: center; gap: 6px; }
    /* 行内「⋯」靠右收尾 */
    .qrscanner-panel__head .qrscanner-panel__icon-btn { margin-left: auto; }
    .qrscanner-panel__chip {
      flex-shrink: 0; padding: 0 7px;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 10px; line-height: 16px;
      color: var(--hira-accent, #3b82f6);
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
    }
    /* 密钥类内容用琥珀色：它比普通链接敏感，视觉上要有区别 */
    .qrscanner-panel__chip.is-otpauth {
      color: var(--hira-warn, #b54708); background: var(--hira-warn-bg, rgba(181,71,8,0.12));
    }
    .qrscanner-panel__chip.is-count {
      color: var(--hira-text-tertiary, #8a8f98);
      background: transparent; padding: 0 2px;
    }
    .qrscanner-panel__copied {
      margin-left: auto; font-size: 10.5px; white-space: nowrap;
      color: var(--hira-accent, #3b82f6);
    }
    .qrscanner-panel__title {
      font-size: 12px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 原始内容：**单行省略**（全文在悬停提示里）—— 窄面板里多行会把列表撑爆 */
    .qrscanner-panel__detail {
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 10.5px; line-height: 1.5;
      color: var(--hira-text-tertiary, #8a8f98);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 主动作（打开 / 存入验证器）：行内唯一的常显按钮 */
    .qrscanner-panel__action {
      align-self: flex-start;
      margin-top: 2px;
      height: 28px; padding: 0 11px; cursor: pointer;
      display: inline-flex; align-items: center;
      border: 0;
      border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      font-size: 11px; font-family: inherit; font-weight: 500;
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .qrscanner-panel__action:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.07)); }
    /* 行内主动作：**软色块主色** —— 与面板里的主按钮同一观感（不再是实心高饱和）。 */
    .qrscanner-panel__action.is-primary {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .qrscanner-panel__action.is-primary:hover {
      background: var(--hira-accent-soft-strong, rgba(59,130,246,0.24));
    }

    /* ── 通用按钮（空态 / 工具条）── */
    .qrscanner-panel__btn {
      height: var(--hira-control-height, 32px); padding: 0 12px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      font-size: 11.5px; font-family: inherit; font-weight: 500;
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .qrscanner-panel__btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.07)); }
    .qrscanner-panel__btn.is-primary {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .qrscanner-panel__btn.is-primary:hover {
      background: var(--hira-accent-soft-strong, rgba(59,130,246,0.24));
    }
    /* 停止：扫描中按钮变成"危险动作"的观感，让人一眼知道再点一下就停 */
    .qrscanner-panel__btn.is-stop {
      background: var(--hira-danger-bg, rgba(220,38,38,0.12));
      color: var(--hira-danger, #dc2626);
    }
    .qrscanner-panel__btn:disabled { opacity: 0.5; cursor: default; }

    /* ── 空态 ──
       空态放**真按钮**：新用户第一眼就得能点，而不是去别处找入口。
       这里刻意**不写解释段落** —— 侧栏很窄，一句话 + 一个按钮就够了。 */
    .qrscanner-panel__empty { padding: 48px 20px; text-align: center; }
    .qrscanner-panel__empty-title { font-size: 12px; line-height: 19px; color: var(--hira-text-tertiary, #8a8f98); }
    .qrscanner-panel__empty-actions {
      display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px;
    }
  `
  doc.head.appendChild(style)
}

/** 面板定义 —— 宿主按 id 对齐 manifest 的 `contributes.panels[].id`。 */
const qrScannerPanelDefinition = {
  id: 'qr-scanner-panel',
  injectStyles: injectQrScannerStyles,

  mount(doc: Document, ctx: QrRendererContext) {
    // 端口从宿主注入（面板包不得 import apps/**）：导航、验证器、插件清单、抓屏，
    // 外加事件订阅口（"放下取景框" / "取景框被关掉"两条都从主进程来）。
    const clients = ctx.clients as unknown as NonNullable<QrModelOptions['clients']>
    const hostOn = ctx.on
    let viewRef: ReturnType<typeof createQrScannerView> | null = null
    const model = createQrScannerModel({
      doc,
      clients,
      events: ctx.events,
      subscribe: typeof hostOn === 'function'
        ? (route, handler) => hostOn(route, (payload) => handler(payload))
        : null,
      onChange: () => { if (viewRef) viewRef.render() },
      // 命中走轻量路径：只改状态条 + 新记录插到顶部（见 model 文件头两条信号）
      onHit: () => { if (viewRef) viewRef.renderHit() }
    })
    viewRef = createQrScannerView(doc, model, {
      // 低频动作（重新扫描 / 清空 / 复制 / 移除）走**原生菜单**，面板因此不拥挤
      menu: ctx.menu
    })
    model.start()
    /**
     * 面板视图被销毁时的**最后一道保险**：停掉抓帧轮询。
     *
     * 正常路径下面板一关（或隐藏）我们就会停；这里兜的是"销毁先于我们收到信号"
     * 那一拍 —— 多停一次的代价是零，漏掉的代价是接着每 600ms 抓一次整屏。
     */
    const win = doc.defaultView
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', () => model.stop(), { once: true })
    }
    return { element: viewRef.element }
  }
}

export const rendererPlugin = { panels: [qrScannerPanelDefinition] }
