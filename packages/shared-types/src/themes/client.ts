/**
 * themes/client.js —— 主题域客户端（**唯一的请求入口**，两个宿主共用）。
 *
 * ── 为什么放在共享层 ─────────────────────────────────────────────────
 * 消费主题请求的宿主有两个、且**运行环境不同**：
 *   · 侧栏面板 / 主窗口渲染层：`themeClient`（apps 层薄壳，invoke 走 hira bridge）
 *   · 主题内部页（`hira://themes`）：只能用 `hira://shared/` 拿到的代码，
 *     桥是 `runtime.js` 的 `rpc` / `subscribe`
 * 两份各自拼一遍通道名与载荷形状，必然出现"页面里能保存、面板里保存报错"。
 * 于是把"怎么跟主题域说话"收成这一份工厂：宿主只注入 `invoke` 与 `subscribe`
 * 两个端口，通道名与载荷形状在这里**只有一份**。
 *
 * ── 返回值为什么原样透传 ──────────────────────────────────────────────
 * 主进程已经剪裁成"渲染层直接能用"的形状（见 main/ipc/theme.js）：
 *   theme:list → { themes, activeId, privateId }
 *   theme:save → { ok, id, theme, themes, activeId, privateId }
 * 这里不再包一层（不重命名字段、不补默认值）—— 多一层映射就多一处会与主进程脱节。
 *
 * ⚠ 本文件被**内部页**直接引用（不打包的静态页），只能用相对路径引入已登记的共享
 *   模块（`../ipc-channels.mjs` 在 SHARED_PAGES_MODULES 里）；不得出现任何裸包名。
 */

import { IPC_ROUTES, IPC_EVENTS } from '../ipc-channels.js'
import type { ThemeData, ThemeSchedule } from '../theme.js'

/**
 * @param {{
 *   invoke: (route: string, payload?: any) => Promise<any>,
 *   subscribe?: (event: string, listener: Function) => (() => void)
 * }} ports
 */
export interface ThemeClientPorts {
  invoke: (route: string, payload?: Record<string, unknown>) => Promise<unknown>
  subscribe?: (event: string, listener: (payload: unknown) => void) => () => void
}

export function createThemeClient({ invoke, subscribe }: ThemeClientPorts = {} as ThemeClientPorts) {
  if (typeof invoke !== 'function') {
    throw new Error('createThemeClient: 需要 invoke(route, payload) 端口')
  }

  return {
    /** 主题目录 + 当前主题 + 私密窗口主题：`{ themes, activeId, privateId }`。
     * 传入 profileId 时按目标 profile 解析用户主题目录（给另一个 profile 的空间配主题时用）。
     */
    list(profileId?: string) {
      return invoke(IPC_ROUTES.themeList, profileId ? { profileId: String(profileId) } : {})
    },

    /** 当前主题（按**发起窗口**解析：私密窗口拿到的可能是私密主题）。 */
    active() {
      return invoke(IPC_ROUTES.themeActive, {})
    },

    /** 切换主题（写 `app.theme`，并顺手把调度切回 `none` —— 用户显式选择压过自动切换）。 */
    set(id: string) {
      return invoke(IPC_ROUTES.themeSet, { id })
    },

    /** 重新扫描目录（插件启停后对账 / 打开管理界面时刷新一次）。 */
    refresh() {
      return invoke(IPC_ROUTES.themeRefresh, {})
    },

    // ── 调度 ───────────────────────────────────────────────────────────
    scheduleGet() {
      return invoke(IPC_ROUTES.themeScheduleGet, {}).then((res) => {
        return res && typeof res === 'object' ? (res as Record<string, unknown>).schedule || null : null
      })
    },
    scheduleSet(schedule: ThemeSchedule) {
      return invoke(IPC_ROUTES.themeScheduleSet, { schedule })
    },

    // ── 编辑器（用户主题）──────────────────────────────────────────────
    /**
     * 取一份**可编辑草稿**：传 id = 以它编辑（内置/插件主题会被复制成用户主题草稿，
     * 且 id 留空），不传 = 以当前主题新建。判据全在主进程。
     *
     * `opts.asNew` = 「新建主题」：即使起点是自建主题，也另起一份**新**草稿
     * （不带它时，自建主题会被当作"原地编辑"，界面看起来毫无变化）。
     * @param {string} [id]
     * @param {{ asNew?: boolean }} [opts]
     */
    draft(id: string, opts: { asNew?: boolean } = {}) {
      const req: Record<string, unknown> = {}
      if (id) req.id = String(id)
      if (opts && opts.asNew) req.asNew = true
      return invoke(IPC_ROUTES.themeDraft, req)
    },

    /** 保存（新建或覆盖）用户主题。 */
    save(theme: ThemeData) {
      return invoke(IPC_ROUTES.themeSave, { theme })
    },

    /** 删除用户主题（内置 / 插件主题会被拒 —— 它们不由用户资产表达）。 */
    remove(id: string) {
      return invoke(IPC_ROUTES.themeDelete, { id })
    },

    /** 草稿 → 令牌表（编辑器实时预览；不落盘、不改任何状态）。 */
    preview(theme: ThemeData) {
      return invoke(IPC_ROUTES.themePreview, { theme })
    },

    /**
     * 「选择背景图片 / 视频」—— 主进程弹系统文件对话框，把选中的文件**拷进**主题资产库，
     * 回来 `{ ok, key, url, mediaKind }`：`key` 写进 `background.path`，
     * `mediaKind`（按真实扩展名判定）写进 `background.kind`，`url` 只用于即时预览。
     *
     * `kind` 只决定对话框的标题与过滤器（用户能切到"所有文件"）——**不要**拿它当
     * `background.kind` 的来源，那会造出"kind=video 却指向一张 jpg"的主题。
     * @param {'image'|'video'} [kind]
     */
    pickAsset(kind: 'image'|'video') {
      return invoke(IPC_ROUTES.themeAssetPick, kind ? { kind: String(kind) } : {})
    },

    // ── 主题包（导入 / 导出）───────────────────────────────────────────
    /**
     * 导出主题为 `.zip`。**主进程弹保存框并写盘** —— 渲染层不碰任何本地路径 API。
     * @param {string} [id] 缺省 = 当前主题
     */
    exportTheme(id: string) {
      return invoke(IPC_ROUTES.themeExport, id ? { id } : {})
    },

    /**
     * 导入一个主题包（zip）。主进程弹选择框 → 解析 → 落成主题插件 → 安装并启用。
     * 成功后应重新拉一次目录（新主题会出现在「插件主题」分组里）。
     */
    importTheme() {
      return invoke(IPC_ROUTES.themeImport, {})
    },

    // ── 私密窗口主题 ───────────────────────────────────────────────────
    /**
     * 设置私密窗口专用主题；`id` 传空串 = 与普通窗口相同。
     * 读不单独开接口：`list()` 的载荷里已经带 `privateId`（少一条通道少一处要同步）。
     */
    privateSet(id: string) {
      return invoke(IPC_ROUTES.themePrivateSet, { id: id == null ? '' : id })
    },

    /**
     * 主题变更推送（含私密窗口收到的那一条定向推送，语义相同）。
     * @param {(payload: any) => void} handler
     * @returns {() => void} 退订
     */
    onChanged(handler: (payload: unknown) => void) : () => void {
      if (typeof subscribe !== 'function') return () => {}
      return subscribe(IPC_EVENTS.themeChanged, handler)
    }
  }
}
