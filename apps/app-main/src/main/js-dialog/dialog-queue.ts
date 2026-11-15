/**
 * JS Dialog 队列管理
 *
 * 完全复刻 Hira jsDialogQueue 的行为：
 *   - 连续调用 alert/confirm/prompt 时，后到的入队等待
 *   - 避免后到的浮层立即销毁前面的（用户根本看不到前面的界面）
 *   - alert/beforeunload：立即处理下一个
 *   - confirm/prompt：延迟到 poll-result handler 取走结果后处理
 */

export interface DialogQueueEntry<Request, Parent = object> {
  parentWindow: Parent
  requestData: Request
}

export interface DialogQueue<Request, Parent = object> {
  push(parentWindow: Parent, requestData: Request): void
  shift(): DialogQueueEntry<Request, Parent> | null
  hasPending(): boolean
}

export function createDialogQueue<Request = Record<string, unknown>, Parent = object>(): DialogQueue<Request, Parent> {
  const _queue: Array<DialogQueueEntry<Request, Parent>> = []

  /**
   * 入队一个弹窗请求
   * @param {Object} parentWindow - 父窗口
   * @param {Object} requestData - 请求数据
   */
  function push (parentWindow: Parent, requestData: Request): void {
    _queue.push({ parentWindow, requestData })
  }

  /**
   * 取出下一个弹窗请求
   * @returns {{parentWindow: Object, requestData: Object}|null}
   */
  function shift (): DialogQueueEntry<Request, Parent> | null {
    if (_queue.length === 0) return null
    return _queue.shift() ?? null
  }

  /**
   * 队列中是否有待处理的弹窗
   */
  function hasPending (): boolean {
    return _queue.length > 0
  }

  return { push, shift, hasPending }
}

