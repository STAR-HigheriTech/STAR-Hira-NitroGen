/**
 * keyboard-shortcuts-controller —— 主进程快捷键 → 外壳动作的**唯一**接线处。
 *
 * 分工：主进程只发「命令意图」（shortcut:xxx），不碰 DOM；这里按意图调用注入的
 * 动作（addressInput…）。新增一个快捷键 = 主进程 keybindings 加一条 +
 * 这里加一行订阅，两边都不需要认识对方的实现。
 *
 * 只接**必须落到外壳**的意图：像「标签页搜索」这种打开面板的动作，
 * 主进程直接走 layoutCoordinator.togglePanel，不在这里绕一圈。
 *
 * 彻底解耦：全部依赖注入，本文件不 import bridge、不读全局。
 */
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'

interface KeyboardShortcutsControllerDeps {
  onSubscribe(route: string, listener: (payload: unknown) => void): () => void
  addressInput: HTMLInputElement | HTMLTextAreaElement | null
}

export function createKeyboardShortcutsController({ onSubscribe, addressInput }: KeyboardShortcutsControllerDeps) {
  const unsubscribeFocusUrl = onSubscribe(IPC_EVENTS.shortcutFocusUrl, () => {
    if (!addressInput) return
    addressInput.focus()
    addressInput.select()
  })
  return {
    dispose: () => {
      unsubscribeFocusUrl()
    }
  }
}
