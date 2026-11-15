/**
 * IPC · 页内查找（查找栏窗口 → 主进程）
 *
 * ── 为什么只有单向通道 ────────────────────────────────────────────────
 * 查找是**高频**操作（输入框每变一个字符就发一次），任何一次 invoke 往返都会让
 * "边打字边跳转"出现可感的延迟。因此全部走 send，结果由 `find:result` 事件异步回来
 * （见 ipc-channels.mjs 的说明）。返回 Promise 的另一半责任由查找栏承担：它只画
 * "当前已知的计数"，真值随事件到达再刷新 —— 这正是 Chromium 自己的模型。
 *
 * ── 窗口解析：`findInPage` 是 **scoped 端口** ─────────────────────────────
 * 发送方是查找栏**浮层**的 renderer（一条 WebContentsView，住在浏览器窗口里）——
 * `BrowserWindow.fromWebContents` 对 WebContentsView 同样成立，因此
 * `runtimeRegistry` 能按它解析回**所属浏览器窗口**的那一份控制器：
 * 多窗口下不会把 A 窗口的查找打到 B 窗口的页面上。
 *
 * ── 收起 = 会话结束（单一收敛点）────────────────────────────────────────
 * 用户按 Esc / ✕ 时查找栏窗口的 renderer 发 `find:close`，主进程据此隐藏窗口并
 * 结束查找会话（含清页内高亮）。父窗口失焦、切标签等其它收起路径由窗口装配
 * 直接调用控制器的 close() —— **同一个方法**，因此"清高亮"只有一处实现。
 */

import type { IpcRawMain, IpcRoutes, IpcTypedMain } from './types'

interface FindInPagePort {
  query(request: unknown): unknown
  stop(action: string): unknown
  close(): unknown
}

interface FindIpcContext { routes: IpcRoutes; findInPage?: FindInPagePort | null }

/**
 * @param {object} typedMain 带 schema 校验的 invoke 注册器（本域不用，保留签名一致性）
 * @param {object} senderScopedIpcMain 裸通道注册器（按 sender 解析窗口）
 * @param {{ routes:object, findInPage:object }} deps
 */
export function registerFindIpc(
  _typedMain: IpcTypedMain,
  senderScopedIpcMain: IpcRawMain,
  { routes, findInPage }: FindIpcContext
): void {
  const sendCh = (route: string): string => `ngipc:send:${route}`

  // ── 发起 / 步进一次查找 ──
  senderScopedIpcMain.on(sendCh(routes.findQuery), (_e, req) => {
    if (!findInPage) return
    findInPage.query(req || {})
  })

  // ── 结束查找（保留 / 清除高亮）──
  // 用途之一：用户清空输入框 → 高亮该撤掉，但查找栏**不关**（Chrome 同款）。
  senderScopedIpcMain.on(sendCh(routes.findStop), (_e, req) => {
    if (!findInPage) return
    const action = req && typeof req.action === 'string' ? req.action : 'clearSelection'
    findInPage.stop(action)
  })

  // ── 收起查找栏（Esc / ✕）→ 隐藏浮层 + 结束会话 ──
  // 与「父窗口失焦 / 切标签」两条收起路径走的是**同一个** close()，因此
  // "清页内高亮"只有一处实现，不会有某条路径漏掉而留下一片黄底。
  senderScopedIpcMain.on(sendCh(routes.findClose), () => {
    if (!findInPage) return
    findInPage.close()
  })
}

