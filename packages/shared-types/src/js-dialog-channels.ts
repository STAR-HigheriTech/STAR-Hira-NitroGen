/**
 * JS Dialog **裸通道**契约（零依赖）
 *
 * ── 为什么单独一份、且不进 IPC_ROUTES ────────────────────────────────
 * alert/confirm/prompt/beforeunload 的同步语义必须走 Electron 的裸
 * `ipcRenderer.send` / `sendSync`：`sendSync` 是唯一能让被注入的网页脚本
 * **原地拿到返回值**的机制（invoke 是 Promise，网页侧 `window.confirm` 不能返回 Promise）。
 * 因此这组通道**不经过** ngipc provider，也不属于 `IPC_ROUTES` / `IPC_EVENTS`
 * 的 invoke/handle 契约 —— 但**名字必须只有一份真源**：
 *   发送方：tab preload（注入任意网页）与浮层 preload（对话框 UI）
 *   接收方：主进程 js-dialog 协调器、浮层窗口的 sendInit / sendTheme
 * 过去这些名字在 4 个文件里各抄一遍，改名时漏一处就是"弹窗再也不出现"。
 *
 * ── 为什么零依赖 ────────────────────────────────────────────────────
 * tab preload 在 sandbox 下运行，只能相对路径 import 并被内联打进 `tab.js`；
 * `@hira-ng/*` 包名会被 externalize 成运行时 require 而当场抛错。
 *
 * ── 维护规则 ────────────────────────────────────────────────────────
 *   · 只需要在本协议里新开一条 → 加到这里，四处消费方统一取值；
 *   · 想让它变成普通 invoke 契约 → 别加这里，去 ipc-channels.mjs。
 */

export const JS_DIALOG_CHANNELS = Object.freeze({
  // 页面 → 主进程：alert/beforeunload（sendSync，立刻拿默认值，浮层异步弹出）
  show: 'jsDialog:show',
  // 页面 → 主进程：confirm/prompt（send，异步开窗；结果由下面 pollResult 取）
  showAsync: 'jsDialog:show-async',
  // 页面 → 主进程：sendSync 等待用户结果；未就绪时主进程挂起该事件（零轮询）
  pollResult: 'jsDialog:poll-result',
  // 浮层 → 主进程：用户点了确定/取消
  response: 'jsDialog:response',
  // 主进程 → 浮层：本次弹窗的类型/文案/默认值
  init: 'jsDialog:init',
  // 浮层 → 主进程：sendSync 取当前主题色（浮层加载时就着色，不等推送）
  getThemeInfo: 'jsDialog:get-theme-info',
  // 主进程 → 浮层：系统主题变化时的增量推送
  themeChanged: 'jsDialog:theme-changed',
  // 浮层 → 主进程：上报内容自然高度（主进程据此调整窗口高度，见 dialog-overlay）
  resize: 'jsDialog:resize'
})
