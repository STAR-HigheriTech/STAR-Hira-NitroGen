import { z } from 'zod'

const windowSchemas = Object.freeze({
  popupMenu: Object.freeze({
    request: z.object({
      items: z.array(z.lazy(() => z.object({
        label: z.string().optional(),
        type: z.enum(['normal', 'separator', 'submenu', 'checkbox', 'radio']).optional(),
        /**
         * ⚠ 必须是 `nullish()`，不能是 `optional()`：`optional` 只接受 `undefined`，
         * 而分隔项在渲染层一贯写成 `{ type: 'separator', action: null }`
         *（"明确没有动作"比"省略字段"更不容易被误读成漏写）。
         * 这一处曾让**整条菜单请求**校验失败、菜单一个字都弹不出来 ——
         * 表现是"右键没反应"，而根因在契约的一个允许值上，极难从现象反推。
         */
        action: z.string().nullish(),
        enabled: z.boolean().optional(),
        checked: z.boolean().optional(),
        visible: z.boolean().optional(),
        /**
         * 右侧快捷键提示。上下文菜单里的 accelerator **只展示、不注册**
         *（见 main/ipc/window.js#build），菜单想显示「Ctrl+T」这类提示就得靠它。
         * ⚠ 这张 schema 会**剥掉未声明的字段**（zod 默认 strip）：不在这里列出来，
         *   渲染层传的 accelerator 会被静默丢弃，菜单看起来"什么都没变"。
         */
        accelerator: z.string().optional(),
        /**
         * Electron 原生 role（撤销 / 复制 / 粘贴…）：点击语义交给原生实现
         * （粘贴只能原生做，启用态也由原生按选区裁定）。同上：不声明就会被剥掉，
         * role 项退化成"点了没反应"的普通项。
         */
        role: z.string().optional(),
        submenu: z.array(z.lazy(() => z.unknown())).optional()
      }))).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      // 非阻塞对账标识：选中结果经 `ui:popup-menu-selected` 事件按此 id 回传
      requestId: z.string().optional(),
      /**
       * 「这是哪一类菜单」—— 让主进程把官方插槽贡献的菜单项追加进来
       * （如 `{ kind: 'bookmark', snapshot: {...} }` → `bookmark.context-menu`）。
       *
       * 只传**种类 + 纯数据快照**，不传插槽 id：种类 → 插槽的映射在主进程侧白名单里
       * （`apps/app-main/src/main/ipc/window.js#MENU_SLOT_BY_KIND`），
       * 否则渲染层可以借这条通道触发任意插槽。
       */
      context: z.object({
        kind: z.string(),
        snapshot: z.unknown().optional()
      }).optional()
    }),
    // invoke 立即返回的 ack；真正的选中 action 走事件回传（不阻塞菜单生命周期）
    response: z.object({ ok: z.boolean() })
  }),
  minimize: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) }),
  /**
   * 读剪贴板纯文本。
   *
   * 返回 `{ text }`（永远有值，空剪贴板就是空串）—— 调用方据此判断「粘贴并前往」
   * 是否可用，不需要为"没内容"再造一个错误分支。
   */
  clipboardReadText: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ text: z.string() })
  }),
  maximize: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) }),
  close: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) }),
  getState: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      isMaximized: z.boolean(),
      isFullscreen: z.boolean(),
      /**
       * 窗口**能力**（自绘标题栏据此决定亮出哪几个按钮）。
       *
       * 为什么在这里现问、而不是渲染层按窗口类型抄一张表：那张表必然与
       * `window-config.js` 漂移，而漂移的表现是"按钮亮着却点不动"（或反之）。
       * `win.isMinimizable()/isMaximizable()/isResizable()` 是**当前窗口的真实状态**。
       * 可选：老调用方只关心 isMaximized/isFullscreen，不传这两项也不该失败。
       */
      minimizable: z.boolean().optional(),
      maximizable: z.boolean().optional(),
      resizable: z.boolean().optional()
    })
  }),
  // 原生窗口标题：渲染层（chrome 外壳）把「页面标题 | 应用名」算好后发过来，
  // 主进程只做落盘动作 —— 排版规则的真源在 shared-types/layout.mjs，不在主进程。
  setTitle: Object.freeze({
    request: z.object({ title: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  open: Object.freeze({
    request: z.object({ type: z.string(), payload: z.unknown().optional() }),
    response: z.unknown()
  }),
  // 新建浏览器窗口 / 无痕窗口。url 可选：缺省时新窗口打开新标签页。
  newWindow: Object.freeze({
    request: z.object({ url: z.string().optional() }).optional(),
    response: z.object({ ok: z.boolean(), windowId: z.number().optional() })
  }),
  // 多窗口：列出全部浏览器窗口（供「移动到其他窗口」这类菜单构建目标列表）
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      windows: z.array(z.object({
        id: z.number(),
        ordinal: z.number(),
        isPrimary: z.boolean(),
        incognito: z.boolean(),
        focused: z.boolean(),
        tabCount: z.number()
      }))
    })
  }),
  // 把一个标签迁到别的窗口（newWindow=true 时新建窗口承接）
  moveTabToWindow: Object.freeze({
    request: z.object({
      tabId: z.string(),
      targetWindowId: z.number().optional(),
      newWindow: z.boolean().optional(),
      // 目标窗口内的落位（跨窗口拖动专用）：贴着 targetId 这条标签、在其前/后。
      // 缺省 → 追加到末尾（菜单「移动到其他窗口」的语义）。
      targetId: z.string().nullable().optional(),
      insertAfter: z.boolean().optional(),
      // 拖出成新窗时，用松手处的屏幕坐标决定新窗位置
      atCursor: z.object({ x: z.number(), y: z.number() }).optional()
    }),
    response: z.object({
      ok: z.boolean(),
      movedTo: z.number().optional(),
      error: z.string().optional()
    })
  }),
  // 小窗预览的自绘标题栏高度（相对窗口内容区，单向上报、无回执）。
  // **只有渲染层知道**自绘 chrome 占了多高，
  // 主进程据此把贴在标题栏之下的原生网页视图摆在正确的 y 上（见 main/peek.js）。
  peekChrome: Object.freeze({
    request: z.object({ titlebarHeight: z.number() })
  })
})

export { windowSchemas }

