/**
 * 验证器面板 —— 由**插件自带**的渲染侧实现（`entry.render` 的用例）。
 *
 * 本文件只做「装配」这一件事，三块实现各自独立：
 *   · `panel-totp.model.js` 状态与数据来源（IPC 客户端的语义化封装 + 倒计时时钟）
 *   · `panel-totp.view.js`  DOM 渲染与用户意图转译
 *
 * 数据由 `ctx.clients.totp`（APPS 层端口）提供，最终落到 domain-totp →
 * infra-db 的 `totp_entries` 表；密钥经 `@hira-ng/infra-secret`（OS 钥匙串）加密，
 * **明文与验证码都不经过本文件** —— 验证码在主进程算，这里只拿到几个数字。
 *
 * 契约（见 renderer/shared/plugin-renderer.js）：
 *   export const rendererPlugin = { panels: [panelDefinition] }
 * `panels[].id` 必须等于 manifest `contributes.panels[].id`（这里都是 `totp-panel`）。
 */

import { injectPanelStyles } from '@hira-ng/ui-common'
import { createTotpModel } from './panel-totp.model.js'
import { createTotpView } from './panel-totp.view.js'

const STYLE_ID = 'hira-panel-totp-styles'

type TotpClientPort = Parameters<typeof createTotpModel>[0]
type TotpModelOptions = NonNullable<Parameters<typeof createTotpModel>[1]>

interface TotpRendererContext {
  clients?: { totp?: unknown; screen?: unknown }
  events?: TotpModelOptions['events']
  on?(route: string, handler: (payload: unknown) => void): () => void
  confirm?: TotpModelOptions['confirm']
  menu?: { popupMenu(options: unknown): unknown }
}

function injectTotpPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .totp-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

    /* ── 工具条 ──
       **两行**：搜索框独占第一行，第二行是「扫码」（大按钮）+「新建」+「截图导入」。
       无分隔线：外层已给留白，这里只靠 8px 间距分出层次。 */
    .totp-panel__toolbar {
      display: flex; align-items: center; gap: 6px;
      flex-wrap: wrap;
      padding: 0 0 8px; flex-shrink: 0;
    }
    .totp-panel__search {
      flex: 1 1 100%; min-width: 0;
      box-sizing: border-box;
      height: var(--hira-control-height, 32px);
      padding: 0 12px; font-size: 12px; font-family: inherit;
      border: 0;
      border-radius: var(--hira-radius-md, 10px); outline: none;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__search:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
      box-shadow: var(--hira-focus-ring);
    }
    .totp-panel__icon-btn {
      width: var(--hira-control-height, 32px); height: var(--hira-control-height, 32px); flex-shrink: 0; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      font-size: 14px; line-height: 1;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__icon-btn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 工具条上的文字按钮：无边框、比图标宽一点，让"新建 / 导入"一眼看懂 */
    .totp-panel__tool-btn {
      flex-shrink: 0; height: var(--hira-control-height, 32px); padding: 0 12px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-secondary, #6b7280); cursor: pointer;
      font-size: 11.5px; font-family: inherit; font-weight: 500;
      line-height: 1; white-space: nowrap;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__tool-btn:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    /* 「扫码」= 主入口：软色块（不再是实心高饱和），占满第二行剩下的宽度 */
    .totp-panel__tool-btn.is-primary {
      flex: 0 1 auto; min-width: 58px; height: 32px; padding: 0 14px;
      font-size: 12px; font-weight: 500;
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .totp-panel__tool-btn.is-primary:hover {
      background: var(--hira-accent-soft-strong, rgba(59,130,246,0.24));
      color: var(--hira-accent, #3b82f6);
    }
    /* 主入口铺满剩余空间（两个次级按钮按内容宽） */
    .totp-panel__tool-btn.is-main { flex: 1 1 auto; height: 32px; padding: 0 14px; font-size: 12.5px; }

    /* ── 时钟校准状态行 ──
       常驻一行、灰小字：它是"我现在用的是哪套时间"的状态 + 两个低频动作。
       不放进工具条是因为第二行已经满了，而且状态与动作分开会说不清
       "为什么验证码不对"（这是用户真正要的线索）。 */
    .totp-panel__clock {
      display: flex; align-items: center; gap: 4px;
      margin: 0 0 10px; padding: 0 2px;
      font-size: 10.5px; line-height: 1.4;
      color: var(--hira-text-tertiary, #8a8f98);
      flex-shrink: 0;
    }
    .totp-panel__clock[hidden] { display: none; }
    .totp-panel__clock-text {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .totp-panel__clock.is-off .totp-panel__clock-text { opacity: 0.72; }
    .totp-panel__clock.is-busy .totp-panel__clock-text { color: var(--hira-accent, #3b82f6); }
    .totp-panel__clock .totp-panel__link {
      flex-shrink: 0; padding: 1px 5px; font-size: 10.5px;
    }
    .totp-panel__clock .totp-panel__link:disabled {
      color: var(--hira-text-tertiary, #8a8f98);
      background: transparent; cursor: default;
    }

    /* ── 就地提示 ── */
    .totp-panel__notice {
      margin: 0 0 10px; padding: 10px 12px;
      border-radius: var(--hira-radius-sm, 8px); font-size: 11px; line-height: 1.5;
      background: var(--hira-accent-soft, rgba(59,130,246,0.12));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .totp-panel__notice.is-error { background: var(--hira-danger-bg, rgba(220,38,38,0.12)); }

    .totp-panel__body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 16px; }

    /* ── 一行条目 ──
       整行可点（= 复制验证码）：这是最高频动作，扩散到整个行面积最省事。
       进度条贴在行底边，用 transform: scaleX 推进（合成器直接处理，不触发布局）。
       每条**只占两行**（服务名 + 账号 / 验证码）—— 侧栏一屏能多放两三条。 */
    .totp-panel__row {
      position: relative; display: flex; align-items: center; gap: 10px;
      padding: 10px;
      border-radius: var(--hira-radius-md, 10px);
      cursor: pointer; overflow: hidden;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.05)); }
    .totp-panel__main { flex: 1; min-width: 0; }
    .totp-panel__head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .totp-panel__issuer {
      font-size: 12px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 账号跟在服务名右边（同一行）：它只是用来区分同名条目，不该占一整行 */
    .totp-panel__account {
      flex: 1; min-width: 0;
      font-size: 10.5px; color: var(--hira-text-tertiary, #8a8f98);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 非默认参数（8 位 / 60 秒 / HOTP）才标出来 —— 默认值标了就是噪音 */
    .totp-panel__tag {
      flex-shrink: 0; padding: 0 7px;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 10px; line-height: 16px;
      color: var(--hira-text-tertiary, #8a8f98);
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
    }
    /* 码是这一行的主角：等宽 + 大号，分两半（见 model 的 formatCode）便于核对 */
    .totp-panel__code {
      margin-top: 1px;
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 19px; font-weight: 600; letter-spacing: 0.06em;
      color: var(--hira-text-primary, #1a1a1a);
      font-variant-numeric: tabular-nums;
    }
    /* 验证码 + 剩余秒数同一行：码基线与秒数对齐（baseline），秒数才像"注"而不是另一个数字 */
    .totp-panel__code-row { display: flex; align-items: baseline; gap: 7px; margin-top: 1px; }
    .totp-panel__code-row .totp-panel__code { margin-top: 0; }
    /* 剩余秒数：小、灰、等宽（数字宽度不变，读秒时不会左右抖） */
    .totp-panel__countdown {
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 11px; line-height: 1;
      color: var(--hira-text-secondary, #6b7280);
      font-variant-numeric: tabular-nums;
    }
    /* 与进度条同一套警示：剩余 ≤5 秒转红，提醒"这串快失效了，别照着念" */
    .totp-panel__countdown.is-expiring { color: var(--hira-danger, #dc2626); font-weight: 600; }
    .totp-panel__code.is-pending { color: var(--hira-text-secondary, #6b7280); opacity: 0.5; }
    .totp-panel__broken {
      margin-top: 3px; font-size: 11px; line-height: 1.5;
      color: var(--hira-warn, #b54708);
    }
    .totp-panel__bar {
      position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
      background: var(--hira-accent, #3b82f6); opacity: 0.5;
      transform-origin: left center;
      will-change: transform;
    }
    /* 剩余 ≤5 秒：提醒"这一串快失效了，别照着念" */
    .totp-panel__bar.is-expiring { background: var(--hira-danger, #dc2626); opacity: 0.85; }
    .totp-panel__actions { flex-shrink: 0; display: flex; align-items: center; gap: 4px; }
    .totp-panel__copied {
      font-size: 10.5px; color: var(--hira-accent, #3b82f6); white-space: nowrap;
    }

    /* ── 表单 / 导入 ── */
    .totp-panel__form { display: flex; flex-direction: column; gap: 10px; }
    .totp-panel__form-head {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 1px;
    }
    .totp-panel__form-title { font-size: 12px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a); }
    .totp-panel__link {
      border: 0; background: transparent; padding: 4px 6px;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 11px; font-family: inherit; font-weight: 500;
      color: var(--hira-accent, #3b82f6); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__link:hover { background: var(--hira-accent-soft, rgba(59,130,246,0.12)); }
    /* 字段：**标签与输入框同一行**（标签定宽，左对齐成一条竖线）——
       标签单独占一行的话，三个字段就是六行，在窄侧栏里等于把按钮推出屏幕外。 */
    .totp-panel__field { display: flex; align-items: center; gap: 8px; }
    .totp-panel__field-label {
      flex: 0 0 44px; font-size: 10.5px; color: var(--hira-text-tertiary, #8a8f98);
    }
    .totp-panel__field-input {
      flex: 1; min-width: 0; box-sizing: border-box;
      height: 32px; padding: 0 12px;
      font-size: 12px; font-family: inherit;
      border: 0;
      border-radius: var(--hira-radius-sm, 8px); outline: none;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__field-input:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
      box-shadow: var(--hira-focus-ring);
    }
    .totp-panel__advanced { font-size: 11px; color: var(--hira-text-secondary, #6b7280); }
    .totp-panel__advanced > summary { cursor: pointer; padding: 4px 0; }
    .totp-panel__advanced .totp-panel__field { margin-top: 8px; }
    .totp-panel__paste {
      width: 100%; box-sizing: border-box; resize: vertical;
      padding: 10px 12px; font-size: 11.5px; line-height: 1.5;
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      border: 0;
      border-radius: var(--hira-radius-md, 10px); outline: none;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__paste:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
      box-shadow: var(--hira-focus-ring);
    }
    .totp-panel__hint {
      font-size: 10.5px; line-height: 1.5; color: var(--hira-text-tertiary, #8a8f98);
    }
    .totp-panel__form-error { font-size: 11px; color: var(--hira-danger, #dc2626); }
    .totp-panel__form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .totp-panel__btn {
      height: 32px; padding: 0 14px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0;
      border-radius: var(--hira-radius-sm, 8px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      font-size: 11.5px; font-family: inherit; font-weight: 500;
      color: var(--hira-text-primary, #1a1a1a);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .totp-panel__btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.07)); }
    .totp-panel__btn.is-primary {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .totp-panel__btn.is-primary:hover {
      background: var(--hira-accent-soft-strong, rgba(59,130,246,0.24));
    }

    /* ── 导入结果：逐条列出"第几行、为什么跳过" ── */
    .totp-panel__import-result {
      margin-top: 6px; padding: 10px 12px;
      border-radius: var(--hira-radius-sm, 8px);
      font-size: 11px; line-height: 1.5;
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
      color: var(--hira-text-secondary, #6b7280);
    }
    .totp-panel__import-list { margin: 4px 0 0; padding-left: 16px; list-style: disc; }
    /* 适配器自己的提醒（分批二维码没给全、缺密钥的条目…）—— 是"要注意"而不是"出错"，
       所以用琥珀色，与红色错误分开 */
    .totp-panel__import-warn {
      margin-top: 4px; font-size: 10.5px; line-height: 1.5; color: var(--hira-warn, #b54708);
    }
    /* 图片 / 扫码两个入口并排 */
    .totp-panel__entry-row { display: flex; flex-wrap: wrap; gap: 8px; }

    /* ── 扫码：状态行 + 待导入清单 ──
       取景框是**独立置顶窗口**，面板里没有它的画面（拍的就是用户正看着的这块屏，
       预览等于一面镜子）。所以状态只报三件事：还在不在扫 / 扫到几张 / 出错了。 */
    .totp-panel__scan-status {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-radius: var(--hira-radius-sm, 8px);
      font-size: 11px; line-height: 1.5;
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
      color: var(--hira-text-secondary, #6b7280);
    }
    /* 刚扫到：状态行**变绿 + 加粗 + 脉冲一圈**（2.2 秒后自己褪掉）——
       与「扫码器」面板同一条规矩：用户的目光在取景框上，面板只是余光。 */
    .totp-panel__scan-status.is-hit {
      background: rgba(34,197,94,0.14);
      color: #15803d;
      font-weight: 600;
      animation: totp-scan-hit-ring 0.9s ease-out 1;
    }
    .totp-panel__scan-status.is-hit .totp-panel__scan-dot { background: #16a34a; }
    @keyframes totp-scan-hit-ring {
      0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.45); }
      100% { box-shadow: 0 0 0 10px rgba(34,197,94,0); }
    }
    /* 扫到但不是验证器内容：琥珀色，与红色错误分开（它不是故障，是"这个码不对"） */
    .totp-panel__scan-status.is-warn {
      background: var(--hira-warn-bg, rgba(181,71,8,0.10)); color: var(--hira-warn, #b54708);
    }
    .totp-panel__scan-status.is-error {
      background: var(--hira-danger-bg, rgba(220,38,38,0.12));
    }
    /* 脉冲点：一眼看出"它还在看屏幕"，而不是以为卡住了 */
    .totp-panel__scan-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: var(--hira-accent, #3b82f6);
      animation: totp-scan-pulse 1.1s ease-in-out infinite;
    }
    .totp-panel__scan-status.is-warn .totp-panel__scan-dot { background: var(--hira-warn, #b54708); }
    .totp-panel__scan-status.is-error .totp-panel__scan-dot { background: var(--hira-danger, #dc2626); }
    /* 脉冲点只在"有情况"时出现（正常扫描中那一行只是一句话，不需要闪烁的装饰） */
    .totp-panel__scan-status:not(.is-warn):not(.is-error):not(.is-hit) .totp-panel__scan-dot { display: none; }
    @keyframes totp-scan-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.75); }
    }
    .totp-panel__scan-text { flex: 1 1 120px; min-width: 0; }
    .totp-panel__scan-actions { display: flex; gap: 8px; justify-content: flex-end; flex-shrink: 0; }

    /* ── 待导入的一项 ──
       与「扫码器」面板的记录行**同一套结构、同一套换行**：
       chip（中文类型）+ ⋯ / 标题 / 原文（单行省略）/ 主动作另起一行。 */
    .totp-panel__pending-list { display: flex; flex-direction: column; gap: 8px; }
    .totp-panel__pending {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.03));
    }
    .totp-panel__pending-head { display: flex; align-items: center; gap: 8px; }
    .totp-panel__pending-head .totp-panel__icon-btn { margin-left: auto; }
    /* 中文类型名（与「扫码器」面板的 otpauth chip 同一配色：密钥类用琥珀色） */
    .totp-panel__pending-chip {
      flex-shrink: 0; padding: 0 7px;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 10px; line-height: 16px;
      color: var(--hira-warn, #b54708); background: var(--hira-warn-bg, rgba(181,71,8,0.12));
    }
    .totp-panel__pending-title {
      font-size: 12px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 原文（otpauth 链接）：单行省略，全文在悬停提示里 */
    .totp-panel__pending-detail {
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      font-size: 10.5px; color: var(--hira-text-secondary, #6b7280);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 主动作**另起一行**、靠左 —— 与扫码器面板的行内动作一致 */
    .totp-panel__pending > .totp-panel__btn { align-self: flex-start; margin-top: 4px; }
    /* 导入失败的原因（贴在这一条上）：可以换行显示，因为"为什么失败"必须看得全 */
    .totp-panel__pending-error {
      font-size: 10.5px; line-height: 1.45; color: var(--hira-danger, #dc2626);
      word-break: break-word;
    }

    /* ── 导出（唯一会显示密钥的地方）── */
    .totp-panel__reveal {
      margin: 0 0 10px; padding: 10px 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-danger-bg, rgba(220,38,38,0.06));
      display: flex; flex-direction: column; gap: 8px;
    }
    .totp-panel__reveal-input {
      width: 100%; box-sizing: border-box;
      height: 32px; padding: 0 12px; font-size: 11.5px;
      font-family: var(--hira-font-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace);
      border: 0;
      border-radius: var(--hira-radius-sm, 8px); outline: none;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .totp-panel__reveal-input:focus {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
      box-shadow: var(--hira-focus-ring);
    }

    /* ── 空态 ──
       空态要放**真按钮**（见 view 的 renderEmptyState）：新用户第一眼就得能点。
       刻意**不写解释段落** —— 侧栏很窄，那种段落最占地方。 */
    .totp-panel__empty { padding: 48px 20px; text-align: center; }
    .totp-panel__empty-title { font-size: 12px; line-height: 19px; color: var(--hira-text-tertiary, #8a8f98); }
    .totp-panel__empty-actions {
      display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
      margin-top: 14px;
    }
  `
  doc.head.appendChild(style)
}

/** 面板定义 —— 宿主按 id 对齐 manifest 的 `contributes.panels[].id`。 */
const totpPanelDefinition = {
  id: 'totp-panel',
  injectStyles: injectTotpPanelStyles,

  mount(doc: Document, ctx: TotpRendererContext) {
    const client = ctx.clients?.totp as TotpClientPort | undefined
    const hostOn = ctx.on
    if (!client) {
      // 端口没接上时**说清是接线问题**，而不是留一句"加载失败"让人去猜
      const box = doc.createElement('div')
      box.className = 'totp-panel__hint'
      box.style.padding = '16px'
      box.textContent = '验证器面板缺少 totp 客户端端口（ctx.clients.totp）—— 宿主接线问题'
      return { element: box }
    }

    // 先建 model，再把两条信号接到 view：onChange 重建结构、onTick 只改数字。
    // 用一个可变引用穿起来（与 ui 包里的 refs 手法一致），避免构造顺序绑成死结。
    let viewRef: ReturnType<typeof createTotpView> | null = null
    const model = createTotpModel(client, {
      onChange: () => { if (viewRef) viewRef.render() },
      onTick: () => { if (viewRef) viewRef.renderCodes() },
      confirm: ctx.confirm,
      doc,
      // 屏幕扫码的两条端口：抓帧客户端 + 事件订阅口（"放下取景框" / "取景框被关掉"
      // 都从主进程来）。面板包不认识 IPC —— 事件名从 ctx.events 进来。
      screen: ctx.clients?.screen as TotpModelOptions['screen'],
      subscribe: typeof hostOn === 'function'
        ? (route, handler) => hostOn(route, (payload) => handler(payload))
        : null,
      events: ctx.events
    })
    viewRef = createTotpView(doc, model, {
      // 行菜单走**原生菜单端口**（与标签行菜单/笔记面板同一个）：面板不自绘菜单，
      // 层级、裁剪、点外面关闭、键盘导航都由系统那一侧负责。见 view 的 openRowMenu。
      menu: ctx.menu
    })
    model.start()
    /**
     * 视图被销毁时的最后一道保险：停掉倒计时与取景框会话。
     *
     * 正常路径下面板一关（或隐藏）我们就会收；这里兜的是"销毁先于我们收到信号"
     * 那一拍 —— 多收一次的代价是零，漏掉的代价是一个置顶取景框一直挂在那儿扫屏幕。
     */
    const win = doc.defaultView
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', () => model.stop(), { once: true })
    }
    return { element: viewRef.element }
  }
}

export const rendererPlugin = { panels: [totpPanelDefinition] }
