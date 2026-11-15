/**
 * file-drop —— 「把系统文件拖进浏览器窗口」的页面侧统一接管。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────
 * 1. 光标：系统文件拖进 Chromium 时，默认只有**页面自己 preventDefault 过的区域**
 *    才显示可放置光标；外壳（导航栏 / 标签条 / 侧栏 / 工具栏）没有任何 drop 处理，
 *    光标会一路显示「禁止」。这里在 chrome 的每个 preload 里统一接管：
 *    dragover 一旦发现是文件就 preventDefault + dropEffect='copy'。
 * 2. 落点语义：外壳里松手 = 在**这个窗口**开新标签（由主进程按发送方窗口解析）；
 *    浏览器打不开的类型由主进程回退系统默认程序。
 * 3. 网页区域：tab-preload 同样引入本模块，于是普通网页（哪怕没有任何 drop 处理）
 *    也不会再把当前标签导航成 file://，而是走同一套「新标签 / 系统默认」策略。
 *
 * ── 与网页自带 drop zone 的边界 ────────────────────────────────────
 * 监听挂在 `window` 的**冒泡阶段**（事件链最后一站），且只在
 * `event.defaultPrevented === false` 时接管，并按「上一帧 dragover 是不是我们接受的」
 * 决定 drop 是否归我们 —— 网页自己的上传区 / 编辑器拖放保持绝对优先，绝不抢。
 *
 * ── 通道名从契约子表取 ────────────────────────────────────────────
 * preload 是沙箱环境，`@hira-ng/*` 包名会被 externalize 成运行时 require 而崩；
 * 但**相对路径的零依赖子表**（`ipc-channels-preload.mjs`）会被 vite 内联进 preload，
 * 体积只有一两 KB。通道名只在那里定义一次，不再各处手抄。
 */
const { ipcRenderer, webUtils } = require('electron')
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

/** invoke 通道（契约 `files:drop`）。 */
const DROP_CHANNEL = `ngipc:invoke:${PRELOAD_ROUTES.filesDrop}`

function hasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  const types = dataTransfer.types
  if (!types) return false
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === 'Files') return true
  }
  return false
}

/**
 * 取出拖入项的真实路径。
 * Electron 43 起 `File.path` 已删除，唯一正路是 `webUtils.getPathForFile`
 *（目录也会作为一个 File 出现，取到的就是目录路径）。
 */
function pathsFrom(dataTransfer: DataTransfer | null | undefined): string[] {
  const files = dataTransfer && dataTransfer.files
  if (!files || !files.length) return []
  const out = []
  for (let i = 0; i < files.length; i += 1) {
    try {
      const p = webUtils.getPathForFile(files[i])
      if (p) out.push(p)
    } catch (_) { /* 单个条目取不到路径就跳过，不影响其余文件 */ }
  }
  return out
}

let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true

  /**
   * 这次拖动是否由我们接管。
   * 只有「上一次 dragover / dragenter 没有被内层 preventDefault」才置 true ——
   * 网页自己的 drop zone 一 preventDefault，我们就退出，让它的行为原样保留。
   */
  let accepted = false

  const accept = (event: DragEvent): void => {
    try { event.preventDefault() } catch (_) {}
    try { if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy' } catch (_) {}
    accepted = true
  }

  window.addEventListener('dragenter', (event: DragEvent) => {
    if (!event.isTrusted) return
    if (!hasFiles(event.dataTransfer)) return
    if (event.defaultPrevented) { accepted = false; return }
    accept(event)
  }, false)

  window.addEventListener('dragover', (event: DragEvent) => {
    if (!event.isTrusted) return
    if (!hasFiles(event.dataTransfer)) return
    if (event.defaultPrevented) { accepted = false; return }
    accept(event)
  }, false)

  window.addEventListener('dragleave', (event: DragEvent) => {
    if (!event.isTrusted) return
    if (!hasFiles(event.dataTransfer)) return
    // relatedTarget 非空 = 只是在元素之间移动；为空 = 真的离开了本视图
    if (event.relatedTarget == null) accepted = false
  }, false)

  window.addEventListener('drop', (event: DragEvent) => {
    if (!event.isTrusted) return
    const wasAccepted = accepted
    accepted = false
    if (!wasAccepted) return
    if (!hasFiles(event.dataTransfer)) return
    // 吃掉默认动作：网页里那一下 file:// 导航（navigateOnDragDrop）不再发生
    try { event.preventDefault() } catch (_) {}
    const paths = pathsFrom(event.dataTransfer)
    if (!paths.length) return
    // fire-and-forget：打开动作的结果不需要回传渲染层；主进程按 sender 解析窗口
      const safePaths = paths.filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 4096).slice(0, 64)
      if (!safePaths.length) return
      Promise.resolve(ipcRenderer.invoke(DROP_CHANNEL, { paths: safePaths })).catch(() => {})
  }, false)
}

install()
