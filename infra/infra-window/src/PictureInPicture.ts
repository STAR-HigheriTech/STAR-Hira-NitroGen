/**
 * PictureInPicture —— 标签可见性驱动的「自动画中画」（对齐 RT tab-lifecycle / tab-layout）。
 *
 * 为什么需要它：标签被切走 / 隐藏后，其 WebContentsView 仍在后台播放视频，但用户
 * 看不到画面。RT 的做法是：标签隐藏且网页内有「正在播放」的 <video> 时自动进入
 * 系统画中画（PiP）；标签重新可见时自动退出；用户在 PiP 窗口点「返回标签页」时，
 * 再切回该标签。
 *
 * **彻底解耦**：本模块不 import electron，不碰任何 web/electron 全局。
 *   - 对页面执行脚本的能力经 `execute(webContents, script)` 注入（宿主用
 *     webContents.executeJavaScript 实现）；
 *   - 「返回标签页」经 `onReturnToTab(tabId)` 注入（宿主决定聚焦窗口 / 切标签）；
 *   - 跨标签互斥（同一时刻只允许一个标签进 PiP，避免互相触发的死循环）由内部
 *     `inPip` 集合维护，本模块是唯一真源。
 *
 * 脚本设计：进入脚本在页面主世界内**先挂好** `leavepictureinpicture` 监听、并把
 * 「离开时才 resolve」的 Promise 挂到页面全局后，才 resolve `true`；宿主侧再
 * await 该 Promise 即得到 `goBackToTab` 布尔值。全程**无需**页面 → 主进程的反向
 * 桥（对比 RT 依赖 preload 暴露 `flow.tabs.disablePictureInPicture`），故本模块对
 * 无注入 bridge 的第三方页面同样可用。
 */

/**
 * 进入 PiP 的页面脚本。
 * 返回（executeJavaScript 解析值）：
 *   - `true`  —— 已成功进入 PiP（并已挂好离开监听）
 *   - `false` —— 已有同名视频在 PiP / requestPictureInPicture 失败 / 异常
 *   - `null`  —— 页面内没有「正在播放」的视频（无需进入）
 */
interface HiraPipState {
  video?: HTMLVideoElement | null
  leavePromise?: Promise<boolean> | null
}

const PIP_ENTER_SCRIPT = `(${function () {
  try {
    const videos = Array.prototype.slice.call(document.querySelectorAll('video')).filter(function (v) {
      return !v.paused && !v.ended && v.readyState > 2
    })
    if (!videos.length) return null
    const video = videos[0]
    if (document.pictureInPictureElement === video) return false
    const host = window as Window & { __hiraPip?: HiraPipState }
    let g = host.__hiraPip
    if (!g) { g = host.__hiraPip = {} }
    g.video = video
    g.leavePromise = new Promise(function (resolve) {
      const onLeave = function () {
        video.removeEventListener('leavepictureinpicture', onLeave)
        window.setTimeout(function () { resolve(!video.paused && !video.ended) }, 50)
      }
      video.addEventListener('leavepictureinpicture', onLeave)
    })
    return video.requestPictureInPicture().then(function () { return true }).catch(function () { return false })
  } catch (e) {
    return false
  }
}})()`

/** 等待「离开 PiP」的页面脚本：resolve 出 goBackToTab 布尔值（无监听 → null）。 */
const PIP_LEAVE_SCRIPT = `(${function () {
  const g = (window as Window & { __hiraPip?: HiraPipState }).__hiraPip
  if (!g || !g.leavePromise) return Promise.resolve(null)
  return g.leavePromise
}})()`

/** 退出 PiP 的页面脚本：页面内确有 PiP 元素则退出并返回 true，否则 false。 */
const PIP_EXIT_SCRIPT = `(${function () {
  try {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture()
      const g = (window as Window & { __hiraPip?: HiraPipState }).__hiraPip
      if (g) { g.video = null; g.leavePromise = null }
      return true
    }
    return false
  } catch (e) {
    return false
  }
}})()`

/**
 * @param {object} [options]
 * @param {(wc:any, script:string) => Promise<any>} [options.execute] 页面脚本执行器（注入 webContents.executeJavaScript）
 * @param {(tabId:string) => void} [options.onReturnToTab] 用户离开 PiP 且视频仍在播放时回调（聚焦该标签）
 * @param {object} [options.logger] 日志出口（默认 console）
 */
interface PictureInPictureContents {
  isDestroyed?(): boolean
}
interface PictureInPictureOptions {
  execute?(webContents: PictureInPictureContents, script: string): unknown | Promise<unknown>
  onReturnToTab?(tabId: string): void
  logger?: Pick<Console, 'error'>
}

export function createPictureInPicture(options: PictureInPictureOptions = {}) {
  const execute = typeof options.execute === 'function' ? options.execute : null
  const onReturnToTab = typeof options.onReturnToTab === 'function' ? options.onReturnToTab : () => {}
  const logger = options.logger || console

  /** 当前处于自动 PiP 的 tabId 集合（跨标签互斥的唯一真源） */
  const inPip = new Set<string>()

  /**
   * 隐藏时页面内**确有可进入 PiP 的视频**的标签集合。
   *
   * 用途：让「重新可见」时的退出探测只在必要时刻才 executeJavaScript。
   * 标签切走时 enter() 已经跑过一次页面脚本，返回值即"页面里有没有在播放的视频"：
   *   null  → 没有视频，切回来时根本无需再跑退出脚本（绝大多数标签属于此类，
   *           例如切来切去都是普通网页 —— 这正是"切标签卡顿"的主要来源之一）；
   *   true/false → 有视频（自动进 PiP 成功 / 或页面自己已开 PiP），切回来必须探测退出。
   */
  const maybePip = new Set<string>()

  /** 该标签是否由本模块进入了 PiP。 */
  function isActive(tabId: string): boolean {
    return inPip.has(String(tabId))
  }

  /** 是否有「其它」标签正处于 PiP（用于互斥：同一时刻只允许一个标签进 PiP）。 */
  function hasOther(tabId: string): boolean {
    const id = String(tabId)
    for (const x of inPip) if (x !== id) return true
    return false
  }

  /** 安全执行页面脚本：无执行器 / wc 缺失 / 已销毁 / 抛错 → 一律解析为 null。 */
  function safeExecute(wc: PictureInPictureContents | null | undefined, script: string): Promise<unknown | null> {
    if (!execute || !wc) return Promise.resolve(null)
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return Promise.resolve(null)
    } catch (_) {
      return Promise.resolve(null)
    }
    try {
      return Promise.resolve(execute(wc, script))
    } catch (_) {
      return Promise.resolve(null)
    }
  }

  /**
   * 尝试让某标签进入 PiP（通常在标签「隐藏」时调用）。
   * 互斥：已有其它标签在 PiP 时直接跳过，避免多标签同时 PiP / 相互触发死循环。
   * @param {string} tabId
   * @param {any} wc
   * @returns {Promise<boolean>}
   */
  async function enter(tabId: string, wc: PictureInPictureContents | null | undefined): Promise<boolean> {
    const id = String(tabId)
    if (!execute || !wc) return false
    if (inPip.has(id)) return false
    if (hasOther(id)) return false
    let entered: unknown = null
    try {
      entered = await safeExecute(wc, PIP_ENTER_SCRIPT)
    } catch (_) {
      return false
    }
    // 记录"页面内有视频"的事实，供切回来时决定是否需要探测退出（见 maybePip 注释）
    if (entered !== null && entered !== undefined) maybePip.add(id)
    if (entered !== true) return false
    inPip.add(id)
    // 离开监听已在页面内挂好，这里只 await 其结果：resolve 即用户关掉了 PiP 窗口。
    safeExecute(wc, PIP_LEAVE_SCRIPT)
      .then((goBackToTab) => {
        inPip.delete(id)
        if (goBackToTab === true) {
          try {
            onReturnToTab(id)
          } catch (e) {
            if (logger && logger.error) logger.error('[pip] onReturnToTab failed:', e instanceof Error ? e.message : e)
          }
        }
      })
      .catch(() => {
        inPip.delete(id)
      })
    return true
  }

  /**
   * 让某标签退出 PiP（通常在标签「重新可见」时调用）。
   * 无论是否由本模块进入都会尝试退出（对齐 RT：可见即退出页面内 PiP）。
   * @param {string} tabId
   * @param {any} wc
   * @returns {Promise<boolean>}
   */
  async function exit(tabId: string, wc: PictureInPictureContents | null | undefined): Promise<boolean> {
    const id = String(tabId)
    inPip.delete(id)
    // 该标签切走时页面内没有视频（enter 返回 null）→ 无需跑退出脚本，
    // 直接跳过这次 executeJavaScript 往返。这是切标签路径上最常见的分支。
    if (!maybePip.has(id)) return false
    maybePip.delete(id)
    if (!execute || !wc) return false
    try {
      return (await safeExecute(wc, PIP_EXIT_SCRIPT)) === true
    } catch (_) {
      return false
    }
  }

  /** 标签关闭 / 销毁时清理其 PiP 状态（内存即时回收）。 */
  function forget(tabId: string): void {
    const id = String(tabId)
    inPip.delete(id)
    maybePip.delete(id)
  }

  function clear(): void {
    inPip.clear()
    maybePip.clear()
  }

  return {
    enter,
    exit,
    forget,
    clear,
    isActive,
    hasOther,
    get size() {
      return inPip.size
    },
    get activeIds() {
      return Array.from(inPip)
    }
  }
}

export { PIP_ENTER_SCRIPT, PIP_LEAVE_SCRIPT, PIP_EXIT_SCRIPT }
