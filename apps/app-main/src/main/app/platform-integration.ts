/**
 * App: 平台级入口（Windows JumpList / macOS Dock 菜单）
 *
 * ── 为什么需要 ────────────────────────────────────────────────────
 * 这两个是「任务栏 / Dock 右键」上的浏览器入口，主流浏览器都有：
 *   · Windows：任务栏图标右键 → 新建窗口 / 新建无痕窗口 / 新标签页
 *   · macOS：Dock 图标右键 → 同样的几项
 * 缺了它们，用户必须先把窗口拉出来才能开新窗口 —— 多窗口场景下这是最常用的一条路径。
 *
 * ── 设计口径 ──────────────────────────────────────────────────────
 * 1. **纯装配、零业务**：只接受注入的 actions，本模块不认识 TabManager / 窗口。
 * 2. **平台守卫**：JumpList 只在 win32、Dock 菜单只在 darwin 生效；
 *    非对应平台直接空转（不是"静默失败"——是这条入口在别的平台上不存在）。
 * 3. **失败绝不致命**：`setUserTasks` / `setJumpList` / `dock.setMenu` 在
 *    某些环境（无任务栏、被系统策略禁用）会抛错，任务栏入口属于锦上添花，
 *    绝不能因为它在启动路径上抛错而让整个应用起不来。
 *
 * 与 keybindings / app-menu 的分工：三者都是「另一条调用路径」，全部复用同一批
 * action 实现，不新增任何业务逻辑。
 */

import fs from 'node:fs'
import type { App, MenuItemConstructorOptions } from 'electron'
import { getRuntimeIdentity } from './runtime-identity'

interface PlatformIntegrationOptions {
  app: App
  actions?: Record<string, () => void>
  maxJumpListItems?: number
}

export interface PlatformIntegrationResult {
  jumpList: boolean
  dockMenu: boolean
  /** 非空 = 当前运行时不具备写系统入口的资格（开发态）。 */
  skippedReason?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {Record<string, () => void>} deps.actions 与 app-menu 同名同义的动作表
 * @param {number} [deps.maxJumpListItems] JumpList 最多展示几项（Windows 上限约 10）
 */
export function registerPlatformIntegration({
  app,
  actions = {},
  maxJumpListItems = 5
}: PlatformIntegrationOptions): PlatformIntegrationResult {
  if (!app) return { jumpList: false, dockMenu: false }

  /** 取了动作就包一层 try —— 任务栏点击不应把异常抛回系统回调。 */
  const run = (name: string): (() => void) | undefined => {
    const fn = actions[name]
    if (typeof fn !== 'function') return undefined
    return () => { try { fn() } catch (e) { console.error(`[platform] action ${name} failed:`, errorMessage(e)) } }
  }

  const applied: PlatformIntegrationResult = { jumpList: false, dockMenu: false }
  const identity = getRuntimeIdentity()

  // ── Windows：任务栏 JumpList ─────────────────────────────────
  // 这是持久化到系统的入口，开发态必须整块跳过。否则任务栏会记住 electron.exe，
  // 安装后仍可能被旧任务抢走，表现就是“点新建窗口却弹出 Electron”。
  if (process.platform === 'win32' && typeof app.setUserTasks === 'function') {
    if (!identity.systemIntegrationEnabled || !fs.existsSync(identity.executablePath)) {
      applied.skippedReason = identity.systemIntegrationReason || '当前可执行文件不是正式安装版'
      return applied
    }
    const tasks = [
      { name: '新建窗口', action: 'windowNew' },
      { name: '新建无痕窗口', action: 'windowNewIncognito' },
      { name: '新建标签页', action: 'tabNew' }
    ]
      .filter((t) => typeof actions[t.action] === 'function')
      .slice(0, maxJumpListItems)

    if (tasks.length > 0) {
      try {
        app.setUserTasks(
          tasks.map((t) => ({
            program: identity.executablePath,
            // 任务栏点击会**新起一个进程**，动作名只能靠命令行带过去；
            // 已有实例在 second-instance 里识别这个标记并执行（见 pickJumpListAction）。
            arguments: `--jump-list-action=${t.action}`,
            title: t.name,
            description: t.name,
            iconPath: identity.executablePath,
            iconIndex: 0
          }))
        )
        applied.jumpList = true
      } catch (e) {
        console.warn('[platform] setUserTasks failed (non-fatal):', errorMessage(e))
      }
    }
  }

  // ── macOS：Dock 菜单 ────────────────────────────────────────
  if (process.platform === 'darwin' && app.dock && typeof app.dock.setMenu === 'function') {
    try {
      // 延迟 require：只有在 macOS 上才真的需要 Menu，其它平台零开销。
      const { Menu } = require('electron')
      const templateItems: MenuItemConstructorOptions[] = [
        { label: '新建窗口', click: run('windowNew') },
        { label: '新建无痕窗口', click: run('windowNewIncognito') },
        { type: 'separator' },
        { label: '新建标签页', click: run('tabNew') }
      ]
      const template = templateItems.filter(
        (item) => item.type === 'separator' || typeof item.click === 'function'
      )
      app.dock.setMenu(Menu.buildFromTemplate(template))
      applied.dockMenu = true
    } catch (e) {
      console.warn('[platform] dock.setMenu failed (non-fatal):', errorMessage(e))
    }
  }

  return applied
}

/**
 * 从命令行里取出 JumpList 动作名（`--jump-list-action=windowNew`）。
 * 第二个实例会用这个标记请求已有实例执行动作，而不是当成 URL 打开。
 * @param {unknown} argv
 * @returns {string|null}
 */
export function pickJumpListAction(argv: unknown): string | null {
  const list = Array.isArray(argv) ? argv : []
  for (const arg of list) {
    const m = /^--jump-list-action=(.+)$/.exec(String(arg))
    if (m) return m[1] || null
  }
  return null
}

