/**
 * 浏览器窗口几何的持久化（多窗口第四步）。
 *
 * ── 存什么 ────────────────────────────────────────────────────────
 * 只存「最后一次关闭的那个普通浏览器窗口」的几何：{ x, y, width, height, maximized }。
 * 这正是 Chrome / Edge 的行为 —— 新窗口按上次的尺寸与位置出现，而不是每次都回到
 * 居中默认值。不按窗口逐一记忆：那样会积累一堆再也不会用到的槽位（窗口编号只增不减），
 * 而且用户对新窗口的期望就是「和上次一样大」。
 *
 * ── 为什么是 JSON 文件而不是 windowStates 表 ──────────────────────
 * 路线图里写的是「windowStates 表」。落地时选了 JSON 文件，原因有二：
 *   1. 这份数据是**纯 UI 状态**，与业务无关，不进 DB 也让 DB 保持「只放用户资产」
 *      （书签 / 历史 / 空间 …）的边界；
 *   2. 复用既有 FilePort 端口（settings.json / session.json 同一条链路），
 *      零迁移、零 schema 变更，不会因为加一张表而影响老库升级路径。
 * 语义与「一张只有一行、且每次覆盖的行」完全等价。
 *
 * 写入防抖 800ms：resize / move 在拖拽期间会以极高频率触发，逐次落盘会把主进程
 * 拖住（这正是本仓库反复出现的卡顿成因）。退出前由 flush() 等待串行队列写完。
 */

const path = require('node:path')
const { createFilePort } = require('@hira-ng/infra-fs')

/** 兜底默认几何（与 WindowFactory.createMainWindow 的默认值保持一致）。 */
const DEFAULT_BOUNDS: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 1100,
  height: 720
})

interface WindowState {
  x?: number
  y?: number
  width?: number
  height?: number
  maximized?: boolean
}

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

interface BrowserWindowPort {
  isDestroyed: () => boolean
  isMaximized: () => boolean
  getBounds: () => { x: number; y: number; width: number; height: number }
  getNormalBounds?: () => { x: number; y: number; width: number; height: number }
}

function createWindowStateStore({
  filePath,
  debounceMs = 800
}: { filePath: string; debounceMs?: number }) {
  const filePort = createFilePort()
  let state: WindowState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次发生几何变化的窗口；真正的原生读数延迟到静默后一次完成。 */
  let pendingWindow: BrowserWindowPort | null = null
  /** 同一文件的异步写严格串行，避免旧几何晚于新几何落盘。 */
  let writeTail: Promise<void> = Promise.resolve()

  function read(): WindowState {
    if (state) return state
    try {
      const raw = filePort.readJsonSync(filePath)
      state = raw && typeof raw === 'object' ? raw as WindowState : {}
    } catch (_) {
      state = {}
    }
    return state
  }

  /** 供 createMainWindow 直接展开的几何（永不含 undefined，避免窗口跑到 (0,0)）。 */
  function bounds(): Bounds {
    const s = read()
    const out: Bounds = {
      width: typeof s.width === 'number' && Number.isFinite(s.width) && s.width > 0 ? s.width : DEFAULT_BOUNDS.width,
      height: typeof s.height === 'number' && Number.isFinite(s.height) && s.height > 0 ? s.height : DEFAULT_BOUNDS.height
    }
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      out.x = s.x
      out.y = s.y
    }
    if (s.maximized === true) out.maximized = true
    return out
  }

  /**
   * 记录"这个窗口的几何变脏了"（防抖）。
   *
   * resize / move 拖动期每帧都会调用这里；原生 `isMaximized/getNormalBounds` 与对象
   * 展开都推迟到静默后只做一次，避免在窗口拖动热路径上反复跨进程取几何。
   */
  function capture(win: BrowserWindowPort | null | undefined): void {
    if (!win || win.isDestroyed()) return
    pendingWindow = win
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      captureNow()
      void writeNow()
    }, debounceMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** 读取一次最终几何并合并进内存状态；只在防抖落点 / 退出冲刷时调用。 */
  function captureNow(): void {
    const win = pendingWindow
    pendingWindow = null
    if (!win || win.isDestroyed()) return
    try {
      const maximized = win.isMaximized()
      // 最大化时 getBounds() 返回的是最大化后的矩形；直接存下来会让「还原」后
      // 的窗口仍是全屏尺寸。此时保留上一次的还原几何，只更新 maximized 标记。
      const s = read()
      const patch: WindowState = maximized
        ? { maximized: true }
        : (() => {
            const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
            return { maximized: false, x: b.x, y: b.y, width: b.width, height: b.height }
          })()
      state = { ...s, ...patch }
    } catch (_) {
      return
    }
  }

  function writeNow(): Promise<void> {
    const snapshot = { ...read() }
    writeTail = writeTail
      .catch(() => {})
      .then(() => filePort.writeJsonAtomic(filePath, snapshot))
      .catch((error: unknown) => {
        console.warn('[window-state] write failed:', error instanceof Error ? error.message : error)
      })
    return writeTail
  }

  /** 退出前等待最后一次落盘；写入队列保证不会发生旧快照覆盖新快照。 */
  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    captureNow()
    return writeNow()
  }

  return { bounds, capture, flush }
}

/**
 * 默认落盘位置：`<userData>/window-state.json`。
 * @param {string} userDataPath
 */
function defaultWindowStatePath(userDataPath: string): string {
  return path.join(String(userDataPath || ''), 'window-state.json')
}

module.exports = { createWindowStateStore, defaultWindowStatePath, DEFAULT_BOUNDS }
