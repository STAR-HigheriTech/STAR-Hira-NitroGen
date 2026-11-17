# 站点信息聚合浮层（Site Info Popover）—— Vivaldi 对照与重构方案

> 目标：把地址栏左侧“临时锁按钮”、输入框内“权限铃铛”、输入框内“内容拦截盾牌”三件临时方案，
> 收敛为**一个第一方站点身份入口 + 一块地址栏锚定的聚合浮层**。
> 入口与浮层都按插件化契约拆分：新增一类站点信息 = 新增一个 section 模块，不改浮层壳、不改 navbar、不改主进程。
>
> 本文既是决策记录，也是落地清单。落地时按“第 9 节 阶段清单”逐项对照执行。

---

## 1. 结论先行

| 问题 | 决定 |
| --- | --- |
| 做新面板 / 聚合浮层 / 合入现有面板？ | **新建“地址栏锚定的站点信息聚合浮层”（site-info popover）** |
| 现有 `permissions-panel` 怎么办？ | **保留**，定位收窄为“所有站点的权限与规则管理”，不再承担当前站点聚合 |
| 现有 `permission-overlay` 怎么办？ | **保留为独立浮层（2026-10-19 回滚）**：仍只在“网页发起权限申请”时弹出，保持原卡片样式，落位改为**内容区左上角**；能力不并入 site-info popover |
| navbar 的权限铃铛、内容拦截盾牌？ | **退休并删除**，状态并入 site-info 按钮的 badge 与浮层内的开关 |
| 地址栏左侧按钮？ | **保留位置，重做语义与形态**：从“锁/地球”升级为“站点身份按钮（site identity）” |
| 按钮 id | 继续使用 `site-info`，让用户已有的工具栏顺序设置自动兼容 |
| 浮层定位 | `anchor-below`：贴地址栏字段下缘的小卡片，**不铺满整窗** |
| 证书数据 | 新增主进程能力 `security:site`（CDP `Network.getCertificate` + `X509Certificate` 解析，失败降级） |

一句话：**入口一颗按钮，信息一块浮层，管理仍回面板。**

---

## 2. 现状盘点：三件“临时件”为什么必须退役

当前涉及站点/权限/拦截的 UI 分散在三个互不相识的部件里：

| 位置 | 文件 | 现状问题 |
| --- | --- | --- |
| 地址栏字段左端 | `ui/ui-navbar/src/components/siteInfo.js` | 只换锁/地球图标，点击直接打开**侧边权限面板**；没有站点身份、证书、Cookie、拦截信息 |
| 地址栏输入框右端 | `ui/ui-navbar/src/components/permission-requests.js` + `permission/` | 铃铛 + badge + 自动弹 `permission-overlay`；只处理“待决定请求”，不承载站点信息 |
| 地址栏输入框右端 | `ui/ui-navbar/src/components/content-blocking-toggle.js` | 盾牌开关只切全局 adblocker，和站点无关，却占着地址栏黄金位置 |
| 独立浮层 | `apps/app-main/src/renderer/permission-overlay/` | 只渲染权限请求卡片；定位是 `below-topbar`，与地址栏无锚定关系 |

由此产生四个结构性问题：

1. **入口语义分裂**：用户想“看这个站安不安全/给了哪些权限/存了多少 Cookie/拦截开没开”，要在三个按钮之间猜。
2. **地址栏拥挤**：一个输入框里塞了锁、铃铛、盾牌、星标、安装、转到，视觉噪声大且互相挤压。
3. **能力不可扩展**：权限、拦截、证书各自长在按钮里；再加“站点数据/隐私统计/站点白名单”只能继续塞按钮。
4. **浮层重复**：`permission-overlay` 与未来的站点信息浮层会是两块几乎同构的 overlay，违背“一个视图一套壳”的解耦原则。

另外，构建产物 `out/renderer/assets/siteinfo-overlay-*.js` 里已经存在一版完整的站点信息浮层实现，
说明这个方向此前已被验证过；但源码目录 `apps/app-main/src/renderer/siteinfo-overlay/` 为空，
且旧产物缺少证书区、Cookie 只有数量、采用“铺满整窗的交互浮层”。本次按本文结构重建源码，不直接复用旧产物。

---

## 3. 外部对照：Vivaldi / Chrome / Edge / Firefox 的共同答案

| 浏览器 | 入口位置 | 展示形态 | 聚合内容 | 可借鉴点 |
| --- | --- | --- | --- | --- |
| **Vivaldi** | 地址栏左端站点图标 | 贴地址栏的站点信息浮层 | 连接安全、证书、站点权限、Cookie/站点数据、内容拦截/广告拦截 | “一个入口聚合站点一切”；拦截开关与统计同屏 |
| **Chrome** | 地址栏左端页面图标 | Page Info 气泡（安全 / 权限两块） | 连接安全、证书、权限、Cookie 与站点数据 | 入口就是站点身份；权限按“已允许/已阻止”分组 |
| **Edge** | 地址栏左端站点图标 | 站点信息浮层 | 连接安全、证书、权限、Cookie、跟踪防护 | 与 Chrome 同构，说明该模型是 Chromium 系共识 |
| **Firefox** | 地址栏左端站点图标 | Site Information 面板 | 连接安全、证书、权限、Cookie 与站点数据、跟踪保护、清除数据 | “清除本站数据”放在站点上下文里，路径最短 |

**共同结论（不是抄某一家的皮肤，而是抄它的信息架构）：**

1. 入口必须**唯一**，且固定在地址栏左端 —— 用户对“点站点图标看这个站”的心智是跨浏览器一致的。
2. 展示必须是**就地浮层**，不是侧边面板：看站点信息是“核对一下”的短任务，不应该把整个侧栏拉出来。
3. 浮层内容按“身份 → 安全 → 权限 → 数据 → 拦截”排序，先回答“我能不能信它”，再回答“我给了它什么”。
4. 侧边面板仍然需要，但职责是**跨站点的批量管理**，不是“当前这一站”。

---

## 4. 方案选型

### 4.1 候选方案

| 方案 | 描述 | 优点 | 致命问题 |
| --- | --- | --- | --- |
| A. 新建独立侧边面板 | 像书签/下载一样再开一个 panel | 空间大、易扩展 | 打开成本高；与“看一眼”任务不匹配；挤占内容区；还要新增一条 rail 入口 |
| B. 地址栏锚定聚合浮层 | 点站点按钮弹小卡片 | 路径最短；与 Vivaldi/Chrome/Firefox 一致；不打断页面 | 需要新增 overlay 注册链路；要处理外部点击收起 |
| C. 全部塞进现有 `permissions-panel` | 在权限面板顶部继续堆卡片 | 不新增 overlay | 面板语义被稀释；Cookie/证书/拦截与“权限规则”不同生命周期；面板关闭后无法就地查看 |

### 4.2 决定：B + 保留 C 作为“管理所有站点”出口

- **B 作为主形态**：当前站点的“身份 / 证书 / 权限 / Cookie / 拦截”全部放进 `siteinfo-overlay`。
- **C 不扩张**：`ui/ui-panel-permissions` 保留，继续做“所有站点规则 + 待处理请求”的批量管理；
  浮层底部提供“管理所有站点”深链（打开现有 `permissions-panel`）。
- **A 不做**：不新增第三个站点信息面板，避免同一份数据三处渲染。

### 4.3 为什么不是“把浮层做成现有面板的一个 tab”

面板是常驻的、宽大的、面向批量的；浮层是瞬态的、窄的、面向当前上下文的。
两者共享数据源（权限/Cookie/adblocker IPC），但**不共享视图壳**。
强行合并会让面板承担两套交互模式，正是用户规则里明确反对的“这里一个规则、那里一个变化”。

---

## 5. 新按钮设计：站点身份按钮（Site Identity）

### 5.1 位置与形态

- 位置不变：`.omnibox__field` 左端、地址输入框之前。
- 尺寸：24 × 24，视觉重心与输入框文字基线对齐；右侧留 6px 间距。
- 按钮 id 继续为 `site-info`（工具栏账本兼容旧顺序设置）。
- 组件文件从 `siteInfo.js` 演进为 `siteIdentity.js`，导出 `createSiteIdentity`。

### 5.2 状态表

| 状态 | 图标 | 附加标记 | tooltip |
| --- | --- | --- | --- |
| HTTPS 且无显式站点规则 | `Lock` | 无 | `example.com · 连接安全` |
| HTTPS 且有显式站点规则 | `Lock` | 右下 5px 强调色圆点 | `example.com · 已自定义站点权限` |
| HTTP | `Globe`（警示色） | 无 | `example.com · 连接不安全` |
| 有未决定权限请求 | 当前安全图标 | 红色计数 badge（1–9，9+ 显示 `9+`） | `example.com · 2 个权限请求待处理` |
| 内部页 / 空白页 | 隐藏 | — | — |

- badge 取代原铃铛：不再单独占位，权限请求的“可见性”由站点身份按钮承担。
- “有显式规则”的判定来自 `permission:get-site` 的结果中是否存在 `allow/block`（`ask` 不算显式规则）。
- 图标切换只做颜色/透明度过渡，不做缩放动画，避免地址栏抖动。

### 5.3 交互

| 操作 | 行为 |
| --- | --- |
| 单击 | 切换浮层；已开则关 |
| 悬停 | 仅显示 tooltip；**不自动弹浮层**（避免鼠标扫过地址栏就弹窗） |
| 键盘聚焦 + Enter/Space | 同单击 |
| 浮层打开时按 Esc | 收起浮层，焦点回地址栏 |
| 新权限请求到达 | 站点身份按钮 badge 更新；独立 `permission-overlay` 在**内容区左上角**弹出（窗口在后台时压住，回前台补弹）。site-info popover 不自动打开、不抢输入焦点 |
| 点击页面 / 其他 chrome | 收起浮层 |

### 5.4 显隐条件

- 仅当活动标签是 `http:` / `https:` 时显示。
- `hira://`、`about:blank`、`file:`、DevTools、应用窗口不显示。
- 权限功能被插件禁用时按钮仍显示（证书/Cookie/拦截仍可用），只是“权限”section 隐藏。

---

## 6. 浮层信息架构

### 6.1 布局

```
┌────────────────────────────────────────────┐
│ [favicon] example.com            HTTPS ✓  │  ← 身份头
│           连接安全 · TLS 1.3              │
├────────────────────────────────────────────┤
│ 证书                                       │
│  颁发给  example.com                       │
│  颁发者  R11 · Let's Encrypt               │
│  有效期  2026-01-01 → 2026-04-01           │
│  指纹    A1:B2:...            查看详情 →   │
├────────────────────────────────────────────┤
│ 本站权限                          2 项     │
│  📷 摄像头            允许 ▾               │
│  🔔 通知              阻止 ▾               │
│  更多权限设置 →                            │
├────────────────────────────────────────────┤
│ 待处理请求（仅有请求时出现）               │
│  📍 位置信息                               │
│  [仅本次允许] [始终允许] [阻止]            │
├────────────────────────────────────────────┤
│ Cookie 与站点数据                          │
│  12 个 Cookie · 本站存储约 1.2 MB          │
│  [清除本站数据]            管理 Cookie →   │
├────────────────────────────────────────────┤
│ 内容拦截                          [ 开 ]   │
│  已拦截 128 次 · 广告 + 跟踪器             │
├────────────────────────────────────────────┤
│ 管理所有站点 →                  页面信息 → │
└────────────────────────────────────────────┘
```

- 卡片宽度 `340–380px`，最大高度 `min(460px, 窗口内容高 - 24px)`，内部滚动。
- 圆角、阴影、分隔线、hover 全部复用 `@hira-ng/ui-common` 的浮层卡片变量，不另起一套视觉语言。
- 深色模式跟随主题变量，不写死颜色。

### 6.2 各 section 的数据来源与动作

| Section | 数据来源 | 动作 |
| --- | --- | --- |
| 身份头 | `siteInfoOfUrl(active.url)` + 当前 tab 的 title/favicon | 无（纯展示） |
| 证书 | `security:site`（CDP + X509） | `查看详情` → 新标签 `hira://certificates?tabId=<来源>` |
| 本站权限 | `permission:get-site`（`{origin}`） | 三态切换：`permission:set` / `permission:remove` |
| 待处理请求 | `permission:pending-list`（按 origin 过滤） | `permission:respond`（4 档：仅本次/始终 × 允许/阻止） |
| Cookie 与站点数据 | `cookie:list({domain})`；存储估算走现有站点数据能力 | `browsing-data:clear({ types:['cookies','siteData'], origin })`；`管理 Cookie` → `hira://cookies` |
| 内容拦截 | `adblocker:status` + `adblocker:blocked-count` | `adblocker:toggle` |
| 底部 | 无 | `管理所有站点` → 打开 `permissions-panel`；`页面信息` → `hira://page-info` |

> **v1 边界**：adblocker 只有全局级别（与现有 `ADBLOCKER_LEVELS` 一致），不做按站点白名单。
> 但 section 接口预留 `siteException` 能力位；未来做站点白名单时只新增一个 section，不改浮层壳。

### 6.3 待处理请求的展示规则

- 浮层顶部优先展示待处理请求（最多 3 条，超出显示“还有 N 条”并跳转面板）。
- 请求卡片提供四个动作，复用 `PERMISSION_CHOICES` 的语义：
  - 仅本次允许 / 始终允许 / 阻止 / 始终阻止。
- 浮层收起时**不自动拒绝**请求。site-info popover 与独立 `permission-overlay` 同一语义：
  关闭浮层不等于用户做了决定；请求保持待处理，badge 继续提示。
  > 独立权限浮层的 Esc / 点外部只做「收起 + 回传 hide」释放交互区，不产生任何允许/拒绝决定。

---

## 7. 架构与模块拆分

### 7.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│ app-shell/main.js（唯一编排层）                              │
│  · 活动标签 → site 事实                                       │
│  · 点击/自动弹出 → overlayClient.showSiteInfo({ anchor, site })│
│  · 订阅 overlay:commit（siteinfo-*）→ 动作                    │
│  · permissionState / adblocker 事件 → 按钮状态                │
└───────────────┬─────────────────────────────┬───────────────┘
                │ handlers / setSiteInfo       │ IPC
┌───────────────▼──────────────┐   ┌──────────▼────────────────┐
│ ui/ui-navbar                 │   │ siteinfo-overlay renderer  │
│  siteIdentity.js（哑组件）    │   │  model.js（状态机，无 DOM）│
│  · 只画图标/badge            │   │  view.js（卡片壳/测量/收起）│
│  · 只上抛 onToggle           │   │  sections/*（可插拔信息块） │
└──────────────────────────────┘   └──────────┬────────────────┘
                                              │ IPC
                                   ┌──────────▼────────────────┐
                                   │ main/ipc/security.ts       │
                                   │  security:site（证书）      │
                                   └───────────────────────────┘
```

边界不变：

- `ui/ui-navbar` 不认识 IPC、权限、Cookie、证书；它只接收 `setSiteInfo(state)` 并上抛 `onToggle`。
- `siteinfo-overlay` 不直接改 navbar；它只回传 `overlay:commit` 事实，由 app-shell 决定按钮状态与面板打开。
- 主进程只提供能力（权限/Cookie/拦截/证书），不认识浮层长什么样。

### 7.2 文件清单

| 文件 | 职责 |
| --- | --- |
| `ui/ui-navbar/src/components/siteIdentity.js` | 站点身份按钮（哑组件）：图标、badge、tooltip、显隐、点击上抛 |
| `ui/ui-navbar/src/components/omnibox.js` | 移除铃铛/盾牌挂载；改为挂 `siteIdentity`；暴露锚点元素 |
| `ui/ui-navbar/src/index.js` | 移除 `permissionRequests` / `contentBlockingToggle` 契约；暴露 `setSiteInfo` / `getSiteInfoAnchorRect` / `toggleSiteInfo` |
| `apps/app-main/src/renderer/siteinfo-overlay/index.html` | 浮层入口 |
| `apps/app-main/src/renderer/siteinfo-overlay/main.js` | 引导：bridge、model、view、事件订阅、ready |
| `apps/app-main/src/renderer/siteinfo-overlay/model.js` | 聚合状态机：拉取、并发、乐观更新、回滚、动作 |
| `apps/app-main/src/renderer/siteinfo-overlay/view.js` | 卡片壳、分区容器、测量、`anchor-below` display、外部点击/Esc 收起 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/registry.js` | section 注册表（按 order 排序，未来插件从这里追加） |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/identity.js` | 身份头 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/certificate.js` | 证书区 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/permissions.js` | 本站权限 + 待处理请求 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/site-data.js` | Cookie / 站点数据 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/blocking.js` | 内容拦截 |
| `apps/app-main/src/renderer/siteinfo-overlay/sections/footer.js` | 管理入口 |
| `apps/app-main/src/renderer/siteinfo-overlay/styles.js` | 浮层样式（前缀 `si-`） |
| `apps/app-main/src/main/site-security.ts` | 证书查询服务（CDP + X509 解析 + 缓存/降级） |
| `apps/app-main/src/main/ipc/security.ts` | 注册 `security:site` |
| `apps/app-main/src/renderer/controllers/overlay-adapter.js` | 新增 `showSiteInfo` / `hideSiteInfo`，删除 `showPopover` / `hidePopover` |
| `apps/app-main/src/renderer/app-shell/main.js` | 按钮状态、锚点、自动弹出、`siteinfo-*` commit 分支、面板深链 |
| `packages/shared-types/src/ipc-channels.mjs` | `siteinfoOverlay*` + `securitySite` |
| `infra/infra-ipc/src/contracts/security.js` | `security:site` 请求/响应 schema |
| `electron.vite.config.js` | renderer input 增加 `siteinfo-overlay` |
| `apps/app-main/src/main/ipc/layout.js` | `FLOAT_NAMES` / `COMMIT_OWNER` 注册 |
| `apps/app-main/src/main/window-chrome.js` | 视需要加入模态遮罩名单（见 7.4） |

### 7.3 Section 插件契约

每个 section 是一个纯视图模块，统一签名：

```js
/**
 * @typedef {Object} SiteInfoSection
 * @property {string} id
 * @property {number} order
 * @property {(ctx: SectionContext) => SectionHandle} create
 *
 * @typedef {Object} SectionContext
 * @property {Document} doc
 * @property {(action: string, payload?: object) => void} emit   // 只上抛意图
 * @property {() => object} getState
 *
 * @typedef {Object} SectionHandle
 * @property {HTMLElement} element
 * @property {(state: object) => void} update
 * @property {() => void} [destroy]
 */
```

- `sections/registry.js` 只负责 `register(section)` / `mountAll(ctx)` / `updateAll(state)`。
- 新增“站点白名单”“隐私统计”“密码保存状态”等，只加一个文件并 `register()`，不动壳。
- section 不直接 `invoke` IPC；所有动作经 `emit` 交给 model。**这是防止未来散落规则的关键约束。**

### 7.4 浮层注册链路（新增 overlay 的固定动作）

按现有 `searchbar-overlay` / `target-picker-overlay` 的范式，逐项补齐：

1. `electron.vite.config.js` renderer input 增加 `siteinfo-overlay`。
2. 新建 `siteinfo-overlay/index.html` + `main.js`。
3. `packages/shared-types/src/ipc-channels.mjs` 增加：
   - `siteinfoOverlayShow: 'siteinfo-overlay:show'`
   - `siteinfoOverlayHide: 'siteinfo-overlay:hide'`
   - `siteinfoOverlayReady / SetBounds / SetInteractive`
4. `main/ipc/layout.js`：
   - `FLOAT_NAMES` 增加 `'siteinfo-overlay'`；
   - `COMMIT_OWNER` 增加 `siteinfo-state / siteinfo-dismiss / siteinfo-action → 'siteinfo-overlay'`。
5. `main/window-chrome.js`：浮层锚定在工具栏下方即可 —— **不需要为此登记任何名单**。
   让位拖拽区是几何判据（`LayoutCoordinator#_chromeDragBands` / `_syncFloatDragGuard`）：
   浮层矩形压在 navbar / 书签栏等 chrome 拖拽带上时自动广播 `overlay:modal` 让下层放弃 drag。
6. `overlay-adapter.js` 增加 `showSiteInfo({ anchor, site }) / hideSiteInfo()`。
7. `app-shell/main.js`：
   - 计算锚点：`shell.getSiteInfoAnchorRect()`；
   - 打开/关闭；订阅 `overlay:commit`；
   - 切换标签、地址变化、窗口 resize 时更新锚点或收起。
8. 定位参数：`position: 'anchor-below'`，`gap: 6`，`pad: 12`，`anchor` 为按钮矩形。

### 7.5 证书能力：`security:site`

**请求**：`{ tabId?: string }`。浮层省略参数，读取当前活动标签；证书页显式传入来源标签。

**响应**：

```ts
{
  secure: boolean,
  protocol: string,
  hostname: string | null,
  origin: string | null,
  tabId: string | null,
  certificate: null | {
    subjectName: string,
    issuerName: string,
    validStart: number,
    validExpiry: number,
    serialNumber: string,
    fingerprint: string,       // SHA-256，冒号分隔
    san: string[]
  },
  certificateChain: SiteCertificate[], // 叶子证书在前
  error: string | null
}
```

**实现**：

1. 浮层按 IPC 发送方解析到所属窗口，再读取该窗口的活动标签；证书页可在同一窗口内显式指定来源标签。
2. 若 URL 非 `https:` → 直接返回 `secure: false` 与空证书，不 attach debugger。
3. `webContents.debugger.attach('1.3')`，启用 `Network` 域后调用 `Network.getCertificate({ origin })` 取整条 DER 证书链。
4. 定制 Chromium 返回空表或 debugger 被占用时，`certificate-tls-probe` 对同源做一次**不发送 HTTP 数据**的 TLS 握手，读取服务器证书链作为兜底。
5. Node `crypto.X509Certificate` 解析每条链成员的 subject / issuer / 有效期 / 序列号 / SAN / SHA-256 指纹。
6. 任一步失败 → 只降级证书详情，URL 得出的协议与安全状态仍正常返回。
7. 结果按 `webContents.id + url` 做短 TTL 缓存；成功结果另存一份按 profile + space 隔离的本会话站点证书快照（只保留 origin，不保存路径 / 查询串），供证书页在来源标签已关闭时降级。
8. `debugger.detach()` 只在由本服务 attach 时执行；DevTools 已占用连接则返回可读错误，不抢连接。

> 安全边界：`tabId` 只能在发送方所属窗口内解析，且显式目标标签只允许由 `hira://certificates`
> 页面请求。浮层与其它受信 UI 省略 `tabId`，始终读取活动标签，避免变成任意站点证书探测接口。

---

## 8. 旧按钮与旧浮层退休清单

### 8.1 删除

| 对象 | 文件 |
| --- | --- |
| 权限铃铛装配 | `ui/ui-navbar/src/components/permission-requests.js` |
| 铃铛外观 | `ui/ui-navbar/src/components/permission/permissionBell.js` |
| 权限浮层可见性状态机 | `ui/ui-navbar/src/components/permission/permissionPopover.js` |
| 自动收起 | `ui/ui-navbar/src/components/permission/autoDismiss.js` |
| 内容拦截盾牌 | `ui/ui-navbar/src/components/content-blocking-toggle.js` |
| 旧权限浮层渲染层 | **已回滚，不删除**：`apps/app-main/src/renderer/permission-overlay/` 保留为独立浮层（原卡片样式，落位改到内容区左上角） |

### 8.2 清理引用

- `ui/ui-common/src/icons.ts#CHROME_BUTTONS`：删除 `permission-requests`、`content-blocking-toggle` 两项；
  `site-info` 的 `feature: 'permissions'` 改为不设 feature（按钮常显，section 内再按能力隐藏）。
- `ui/ui-navbar/src/components/omnibox.js`：删除两处 `appendChild` 与相关 CSS/返回值。
- `ui/ui-navbar/src/index.js`：删除 `permissionRequests`、`contentBlockingToggle`、`refreshPermissions`、
  `hidePermissionsPopover`、`showPermissionsPopover`；新增 `setSiteInfo`、`getSiteInfoAnchorRect`、`toggleSiteInfo`。
- `apps/app-main/src/renderer/app-shell/main.js`：
  - 删除 `shell.contentBlockingToggle?.refresh()` 两处；
  - 删除 `showPermissionsPopover()` / `shell.refreshPermissions` / `shell.hidePermissionsPopover` 调用；
  - `onPermissionRequest` 只刷新站点身份角标与独立权限浮层（`focusPendingPermissions()`），**不**自动展开 site-info popover；
  - `onSiteInfo` 改为切换 siteinfo 浮层；
  - `overlay:commit` 的 `permission` 分支**保留**（2026-10-19 回滚）：独立浮层只报 `{ kind:'permission', id, allow }`，响应策略仍留外壳（`permission:respond` + `persist:true`）。
- `apps/app-main/src/renderer/controllers/overlay-adapter.js`：删除旧的 `showPopover` / `hidePopover`；**保留** `showPermissionRequests` / `hidePermissionRequests`（转投独立浮层）。
- `packages/shared-types/src/ipc-channels.mjs`：**不删除** `permissionOverlayShow/Hide/Ready`（回滚保留）；**不恢复** `SetBounds` / `SetInteractive` —— 浮层自己测量后走通用 `:display` 通道，与 hoverurl / zoom 同一条路径。
- `apps/app-main/src/main/ipc/layout.js`：`FLOAT_NAMES` **保留** `permission-overlay`；`COMMIT_OWNER` 不登记 `permission`（回退外壳）。
- `electron.vite.config.js`：**保留** `permission-overlay` input（名字与 `FLOAT_NAMES`、renderer 目录逐字一致）。
- 全局检索 `permission-overlay`：应只剩独立浮层的合法引用；`permission-requests` / `content-blocking-toggle` 仍须零残留。

### 8.3 迁移兼容

- 工具栏顺序设置里的 `permission-requests` / `content-blocking-toggle` 会被
  `ui/ui-navbar/src/toolbar/ledger.js#setOrder` 自动过滤（只保留 `items.has(id)` 的 id），**无需写迁移代码**。
- `site-info` id 不变，用户原有位置/显隐设置继续生效。
- 旧 `permission-overlay` 的 `below-topbar` 定位不再使用；回滚后改走 `position:'in-content'` + 左上对齐（`margin:0`）。

---

## 9. 落地阶段清单

> 顺序即依赖顺序，逐项做完再进入下一项；每项完成后删除对应死代码。

### P0 — 契约先行

- [x] `ipc-channels.mjs`：新增 `siteinfoOverlay*` 与 `securitySite`。
- [x] `infra-ipc/contracts/security.js`：新增 `security:site` schema。
- [x] `shared-types`：如有必要导出 `SiteSecurity` 类型（TS 侧）。

### P1 — 主进程能力

- [x] 新建 `main/site-security.ts`：CDP 证书查询 + X509 解析 + TTL 缓存 + 降级。
- [x] `main/ipc/security.ts` 注册 `security:site`，依赖注入活动标签 webContents 解析器。
- [x] `main/ipc/layout.js`：`FLOAT_NAMES` + `COMMIT_OWNER` 增加 `siteinfo-overlay`。
- [x] `electron.vite.config.js`：增加 renderer input。

### P2 — 浮层渲染层

- [x] `siteinfo-overlay/index.html` + `styles.js` + `view.js`（卡片壳、测量、`anchor-below`、外部点击/Esc 收起）。
- [x] `model.js`：并发拉取权限/Cookie/拦截/证书/待处理请求；动作与乐观更新。
- [x] `sections/registry.js` + 六个 section。
- [x] `main.js`：bridge 订阅、`siteinfo-overlay:ready`、`overlay:commit` 回传。

### P3 — 入口与编排

- [x] `siteIdentity.js`：新按钮（图标、badge、dot、tooltip、显隐）。
- [x] `omnibox.js`：挂新按钮，删旧三件。
- [x] `ui-navbar/index.js`：新契约与锚点矩形。
- [x] `overlay-adapter.js`：`showSiteInfo` / `hideSiteInfo`。
- [x] `app-shell/main.js`：打开/关闭、锚点、自动弹出、`siteinfo-*` 分支、面板深链、adblocker/权限事件 → 按钮状态。

### P4 — 退休与清理

- [x] 删除 `permission-requests.js`、`permission/`、`content-blocking-toggle.js`。
- [x] 清理 `CHROME_BUTTONS`、layout 白名单、vite input、adapter 旧方法、app-shell 旧分支。
- [x] 全局检索确认零残留。
- [x] **2026-10-19 回滚**：`permission-overlay/` 恢复为独立浮层（原样式 + 内容区左上角），保留 `permission-overlay:show/hide/ready` 通道、vite input 与 `FLOAT_NAMES` 条目；`overlay:commit` 保留 `kind:'permission'`。

### P5 — 细节打磨

- [x] 浮层打开时地址栏字段保持聚焦样式；Esc 收起后焦点回地址栏。
- [x] 切换标签时若浮层开着：内容刷新到新站点；新站点非 http(s) 则自动收起。
- [x] 窗口 resize / 侧栏开合后重新上报锚点，浮层跟随。
- [x] 权限请求到达且浮层已开：只增量更新待处理区，不重建整卡。
- [x] 清除本站数据 / 重置权限 / 拦截开关失败时回滚并提示。
- [x] 深色模式、窄窗口、最大高度滚动。

### P6 — 收尾

- [x] 删除构建产物中不再引用的旧 chunk（由构建自然完成，不手工改 `out/`）。
- [x] 更新本文件“实现差异”小节（若落地时与计划有偏差，记录原因）。

---

## 10. 关键设计约束（落地时逐条自检）

1. **一个入口**：地址栏左端只有站点身份按钮承担“站点一切”；输入框内不再出现铃铛/盾牌。
2. **浮层各司其职**：站点事实只由 `siteinfo-overlay` 渲染；权限申请只由独立 `permission-overlay` 渲染。两者不互相内嵌、不共用视图壳，各自单一语义。
3. **一个真源**：权限类型/文案来自 `permission-labels.mjs`；站点事实来自 `site.mjs`；拦截级别来自 `adblocker.mjs`。
4. **UI 不碰 IPC**：navbar 哑组件与 section 都不直接 `invoke`；动作统一经 app-shell 或 model。
5. **可扩展**：新增站点信息块 = 新增 section 文件 + `register()`；不改浮层壳、不改 navbar、不改主进程。
6. **不误伤**：收起浮层不再自动拒绝权限请求；请求保持待处理。
7. **不铺满**：浮层走 `anchor-below` 小视图，不用全窗口交互层。
8. **旧 id 兼容**：`site-info` 保持不变；被删除的 id 由账本自动过滤。

---

## 11. 实现差异记录（落地后填写）

| 日期 | 计划项 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 2026-10-18 | P1 构建接入 | `electron.vite.config.js` 的 renderer inputs 补 `'siteinfo-overlay'` | 计划未显式列出构建入口。源码目录建好后若不加 input，rollup 不会产出该 renderer，浮层视图加载即 404；这是落地时才暴露的真实构建缺陷，非可选项。 |
| 2026-10-18 | P2 浮层内改规则后同步入口徽标 | 新增浮层动作 `siteinfo-action: 'rules-changed'`（由 `model.js#notifyRulesChanged()` 发出），编排层收到后调 `refreshSiteRules()` 重取 `hasRules` 并重画按钮圆点 | 原计划只写“浮层内可开关 adblocker”，未定义“改完之后地址栏按钮怎么知道”。若不回传，用户关掉拦截后入口 badge 会停在旧状态直到切标签——这是状态双源问题，必须在契约层补一条单向通知，而不是让浮层自己去碰 navbar。 |
| 2026-10-18 | P5 “点击页面 / 其他 chrome 区域收起” | 分三层落地：① 外壳内（地址栏、标签栏、书签栏）用 app-shell `document` 捕获阶段 `pointerdown`，命中 `shell.getSiteInfoElement()` 之外即 `closeSiteInfo()`；② 网页与其它独立 chrome 视图（rail / 侧栏面板）由 `LayoutCoordinator#setFloatDismissOnOutside` 在 `webContents.on('input-event')` 的 `mouseDown` 上侦测，回调宿主 `window-chrome#hideFloat(name)`；③ 窗口 `blur` 兜底收起 | 浮层是独立 `WebContentsView`，只在自己矩形内收鼠标，点外壳/网页时它根本收不到事件——单靠渲染层无法实现“点外面就收起”。故把“侦测”下沉到布局层（它本来就持有全部 webContents），把“收起”仍留给 `hideFloat`（保证 `<name>:hide` + `overlay:closed` 双投递，宿主开合状态不会失真）。放捕获阶段是因为中间层可能 `stopPropagation`，而“用户已离开”这个事实不该被任何一层吞掉。 |
| 2026-10-18 | P5 侦测性能 | 侦听器按需挂载：仅当“存在可外部收起且确实在屏上”的浮层时才给各 webContents 挂 `input-event`；bounds 显隐跳变、`hideFloat`、新标签挂载三处触发重算，全部收起即整表解绑 | `input-event` 连 `mousemove` 都会派发，常驻监听会让每个网页的每次鼠标移动都过一道主进程 JS。按需挂载把开销压到“浮层开着的那几秒”，符合“流畅至上”。 |
| 2026-10-18 | P5 泛化能力 | `WebContentsManager#listTabWebContents()`（与既有 `listChromeWebContents()` 互补） | 原方法刻意排除标签页（广播场景要避免 N 倍流量），但“点网页收起浮层”恰恰只需要标签页这一侧。新增只读枚举，回答事实、不参与生命周期，供布局层统一取源，避免各处自己遍历 `_tabViews`。 |
| 2026-10-18 | P5 外部点击与按钮开关的时序 | 外壳捕获阶段先判断 `button.contains(e.target)` 并放行；主进程侧对 `getFloatWebContents(name) === sourceWc` 跳过 | 否则“点按钮想关掉”会先触发外部点击收起、再被 toggle 打开，表现为闪一下关不掉。两处排除缺一不可：渲染层管按钮自身，主进程管浮层自身。 |
| 2026-10-18 | 页面信息（`hira://page-info`） | 改为**新标签打开 + 带来源 tabId**：`navigateInternal(page, { newTab, query })` → `hira://page-info?tabId=<来源>`；页面侧读 `location.search` 并显式传给 `page:info`；**没有 tabId 时直接给出“未指定要查看的页面”，绝不回退问当前标签**（本页就是当前标签，回退必然自指）；主进程对“显式 tabId 已不存在”也如实返回 `tabId: null`，不回落 | 原实现 `navigateInternal('page-info')` 会**替换当前标签**，随后 `page:info` 按“当前活动标签”解析，问到的必然是 page-info 自己 —— 用户看到的永远是“页面信息页面的信息”。来源必须由打开方显式给出，页面不猜。 |
| 2026-10-18 | P2/P5 浮层视觉词汇 | 卡片 / 滚动区 / 分组标题 / 分隔线 / 行 / 行内文字块全部改用 `ui-common#overlayCard` 的共享类（`.hira-overlay-card` / `-scroll` / `-group` / `-sep` / `-row` / `-label`），`styles.js` 只保留站点信息独有部件 | 与空间切换菜单（profileswitcher）逐像素同源：圆角 / 阴影 / 行距 / hover 不再有第二份实现。原 `styles.js` 自写了一套卡片外观，改一处必漂移。 |
| 2026-10-18 | P5 “浮层不要黄色框” | 卡片 `focus()` 产生的 UA 焦点环用 `.si-card:focus { outline: none }` 移除；焦点轮廓只保留给按钮 / 下拉的 `:focus-visible`（accent 蓝） | 卡片 `tabIndex=-1` + `focus()` 是为了让 Esc 能收到按键；但程序化聚焦不该画出“选中框”，那只是实现细节，不是可交互控件。 |
| 2026-10-18 | 深链去向 | `open-permissions` 显式 `{ side: 'left' }`（与浮层同侧）；`open-cookies` 改新标签 | 浮层从地址栏左端展开，面板在右侧打开会让视线横跳；Cookie 管理是完整页面（可增删改查），替换当前标签会把用户正在看的站点顶掉。 |
| 2026-10-18 | Cookie section 范围 | 删除“清除本站数据”按钮、二次确认（`is-armed`）、hint，以及 `model.js#clearSiteData()` 死代码；浮层只保留数量摘要 + “管理 Cookie”出口 | 浮层定位是“看事实 + 去管理”，破坏性动作属于完整页面；把半套危险动作留在浮层里既难撤销也难解释。 |
| 2026-10-18 | 浮层站点图标 | 改用 `faviconSourceCandidates` + `createFaviconImg`（代理 → 直连 → 锁/地球回退，6s 看门狗），并只在加载成功后隐藏回退图标 | 原实现直接 `img.src = tab.favicon`：那是站点自己的异源地址，绕开了主进程代理的限流 / 去重，失败时会挂住并显示成上一个站点的图 —— 与面板 / 书签栏 / 内部页的取图规则不一致。 |
| 2026-10-18 | section 分隔线 | 分隔线由注册表统一插入 `.hira-overlay-sep` 并按“前后两块都可见”同步显隐；section 不感知自己是不是最后一块 | 若让每个 section 自己画 `border-top`，新增 / 整块隐藏（无活动页面、权限不可用）时会出现孤立线或双线；排序与视觉边界应由宿主统一管理。 |
| 2026-10-18 | page-info 的三个入口 | 浮层深链、⋮ 菜单、原生应用菜单统一为“先取来源 tabId → `newTab('hira://page-info?tabId=…')`”；`page-info` 从 `PAGE_ACTIONS` 集合移除，避免回落成“当前标签 + 无 tabId”的死路径 | 只修浮层入口会留下一半真相：另两个入口仍是 `navigate` 替换当前标签，之后 `page:info` 按“当前活动标签”解析，问到的还是 page-info 自己。同一语义必须收口在一个分支里，三个入口不许各写一套。 |
| 2026-10-18 | 深链参数传递 | `navigateInternal(page, { query })` 统一用 `URLSearchParams` 拼 query；`hira-protocol` 侧 `new URL(request.url)` 原样保留 search，页面通过 `location.search` 读取 | 避免各调用点手写字符串拼接（编码 / 空值处理各写一遍），并确保 query 在 `hira://` 协议解析中不被吞掉。 |
| 2026-10-19 | 收藏星入地址栏（C1） | `bookmarkStar` 从工具栏账本移入 `.omnibox__field` 右端：与站点身份按钮同级、`calc(var(--ng-omnibox-height) - 2px)`（28×28）、`border-radius:50%`、透明底、hover 用 `--main-btn-bg-color-hover`；`#address-input` 左右内边距对称收窄到 4px；`icons.js#CHROME_BUTTONS` 删除 `bookmark-star` 条目 | 收藏星是输入框的固定装饰件，不是可排序工具按钮。经 `useItem()` 登记会被工具栏账本的排序 / 显隐 / 编辑模式误伤，并在按钮编辑浮层留下无法生效的“幽灵格子”。位置、尺寸、hover 与左侧锁按钮同一套视觉规格，字段两端才是“一整条”。 |
| 2026-10-19 | 权限申请浮层回滚（C2） | 恢复 `renderer/permission-overlay/` 独立视图（拆成 `styles.js` / `view.js` / `main.js` 三层）：新增 `permission-overlay:show/hide` 事件与 `permission-overlay:ready` 路由；`layout.js#FLOAT_NAMES`、`vite` renderer input 同步恢复；展示时浮层自测尺寸并 `display({ position:'in-content', align:'left', valign:'top', margin:0 })` → 内容区左上角；`overlay:commit kind:'permission'` 由外壳统一转 `permission:respond`；Esc / 点外部留白回传 `permission-overlay:hide` 释放交互区；窗口后台不弹、回前台补弹 | 站点身份聚合浮层解决的是“看站点事实”，权限申请是“必须被看见并即时决定”的模态语义——塞进同一壳会让两套生命周期互相牵制。保留独立视图即可继续复用原卡片样式；落位从旧的 `below-topbar` 改为 `in-content` 左上角，与内容区绑定而不依赖地址栏锚点（铃铛已并入站点身份按钮）。收起只释放交互区、不产生决定，避免误伤。 |
| 2026-10-19 | 权限申请浮层的**卡片与按钮规格**（推翻同日"保留原内联样式"的写法） | 一条请求 = 一张卡：卡片外壳改用共享类 `.hira-overlay-card`（与空间菜单 / 站点信息浮层同源），内部是「图标 + 站点名（14px/600）+ 请求使用「权限名」（12px 次要色）+ 敏感药丸」，下方是**四个带字大按钮**（`flex:1`、高 34px、字号 13px，配色与侧栏权限面板同一套：一次=浅底描边、始终=实心）。文案 / 图标 / 站点可读化 / `allow·persist` 全部取自 `shared-types#permission-labels.mjs`；外壳不再写死 `persist:true`，改为透传浮层报来的那一档 | 旧实现是 ✓ / ✕ 两个 28px 无字图标按钮，把「一次 / 始终」整层语义藏进了按钮颜色里 —— 用户既猜不到哪颗是允许，也不知道点下去会不会被记住。四档带字按钮把语义摆在按钮上，与侧栏权限面板、hira:// 权限页逐字一致（三处同一份 `PERMISSION_CHOICES`）。卡片外壳复用共享词汇而不是各写一份圆角阴影，避免第三个浮层再漂移一套外观；`persist` 若被外壳统一改成 `true`，四档按钮就退化成两档、且会把用户没做过的「始终」决定写进权限库。 |
| 2026-10-19 | 「列表项过多 → 省略 + 转到面板」抽成**唯一一份**（C3） | 新增 `ui-common#listOverflow.ts`：`LIST_LIMITS`（额度表：权限 5 / 空间 6 / profile 4 / 书签 8）、`splitByLimit()`（纯截断判据）、`overflowRowText()`（唯一一份文案 `还有 N 项 · 转到 X`）、`createOverflowRow()`（与 `.hira-overlay-row` 同骨架、`.hira-overflow-row` 说明行配色）、`injectListOverflowStyles()`。四个表面各自**只声明额度与去向**，截断与文案不再各写一份。 | 此前每个浮层若各自 `slice(0, n)` + 各写一行"还有 N 项"，额度与措辞必然漂移（改了一处忘了另一处）。把这套词汇与判据收进 ui-common，与 `overlayCard` 同一层、同一纪律：`ui/*` 不认识具体面板，省略行只报"我点了"，去向由宿主裁定。 |
| 2026-10-19 | 四个「小浮层列表」接上上限与去向（C3） | ① **权限申请浮层**：`view.js` 按 `LIST_LIMITS.permission` 截断，超出追加省略行 → 报 `overlay:commit{kind:'permission-open-panel'}` → 外壳 `openPanelFromOverlay('permissions-panel', {side:'left'})`（与站点信息浮层的 open-permissions 同一落点、同侧）；② **空间切换菜单**：`ui-space-switcher#createSpaceMenu` 按 `LIST_LIMITS.profile`（分组数）与 `LIST_LIMITS.space`（组内条数）双层截断、各补省略行 → 新 handler `onOpenSpacesPanel`（spaces-overlay 报 `kind:'space-open-panel'`）→ `space-commit.js` 新增该 kind → `space-controller#openSpacesPanel()`（收起菜单 + `openPanel('spaces-panel')`；与既有 `manageSpaces`（hira://spaces 页）各一条入口）；③ **书签夹下拉**（target-picker 的 bookmark 来源）：来源声明 `limit: LIST_LIMITS.bookmark` 与 `overflowTarget:{label:'收藏面板', panelId:'favorites-panel'}`，内核按共享判据截断并渲染省略行 → 回传 `kind:'target-picker-open-panel'` → `bookmark-controller` 认领并把 panelId 转交外壳 | 三处小浮层都是"随手看一眼"的入口，不是管理界面：不设上限会拉出一屏高、设了上限又必须让用户找得到剩下的项。故统一为"收成一行 + 一次点击到完整面板"。去向一律经 `overlay:commit` 回外壳（`openPanelFromOverlay` 是唯一一份目录查找与展开侧裁定），浮层不 import 面板目录；空间菜单有两个宿主（外壳 / 侧栏浮出层），动作表只有一份 `space-commit.js`，两个宿主各注入一个 `openPanel` 端口。 |
| 2026-10-19 | 权限下拉的档位顺序与文案（A1） | `sections/permissions.js`：`SETTING_ORDER = ['allow','block','ask']`（阻止提到询问上方）、`SETTING_LABELS = { allow:'允许', block:'阻止', ask:'清除' }`（「询问」改名「清除」）。value 仍是 `ask`、落库仍走 `permission:remove` | 下拉的第三档真实语义是**把规则删掉**（无规则 = 每次询问），与权限面板 / 权限页的「清除」是同一件事。叫「询问」会让人以为它是"每次都问"的一种设置，从而找不到"撤销我之前的决定"这条路。排序把「允许 / 阻止」两条相反的决定相邻，第三档单独作为"撤销"，扫读成本最低。 |
| 2026-10-19 | 权限表态后主动对齐聚合按钮的两个指示器（A2） | `app-shell/main.js` 的 `overlay:commit{kind:'permission'}` 分支：`respond` 成功（或失败/异常）后**主动** `permissionState.refresh()`，成功时再 `refreshSiteRules()` —— 不再只依赖主进程推来的 `permission:cleared` 事件。`badge`（待处理数）与 `dot`（规则圆点）因此与主进程同步 | `dot` 的唯一刷新触发点是「换站」与 `siteinfo-action#rules-changed`，**权限浮层的表态路径从不触发它** → 用户明明已经对权限表态，按钮右下的圆点却"没完了"地亮着；`badge` 虽由 `permission:cleared` 驱动，但该事件一旦丢失（或归属窗口解析不到）就留下"按钮还挂着通知"的形态。事件是广播、不是回执：表态者自己主动拉一次全量真值，才是与主进程一致的最短路径。 |
| 2026-10-19 | 站点信息浮层的落位与阴影（A3） | ① `SITEINFO_METRICS` 由 `pad:12` 改为**按边留白** `{ padX:16, padTop:0, padBottom:26 }` + `gap:10`（下移一点）；② `.si-card` 阴影由共享的 `0 8px 24px` 覆盖为**只向下投**的 `0 10px 16px -2px rgba(0,0,0,0.22)`（去掉上方那一截）；③ `LayoutCoordinator#anchorFloatBelow` 的 `pad` **向后兼容扩展**为可传 `{top,right,bottom,left}`（一个数 = 四边同宽，searchbar 下拉行为逐字不变），view bounds 与卡片尺寸按边回展 | 共享卡片的 `0 8px 24px` 在上方漏出约 4px、下方 20px、左右 12px；而浮层上报的 outer 尺寸只按一个 pad（12）给四边留白，**下方的阴影必然被原生视图边界裁掉**（用户看到的"阴影缺一块"）。解法必须两侧一起改：renderer 按边上报真实阴影留白（上 0 / 左右 16 / 下 26），主进程按边回展成 view bounds；卡片本身把阴影改成一维向下，则上方那一圈留白既不需要、也不再贴着 navbar。 |
| 2026-11-16 | 证书详情页不再只是“校验失败列表” | `security:site` 允许在**当前窗口**内按来源 `tabId` 读取；`site-security` 增加本会话站点证书快照（进程内上限 64、同标签同证书去重）；`certificate:list` 同时返回快照与校验失败；证书页改为「来源站点 / 本会话已读取 / 校验失败」三段，并从浮层入口新标签打开，不覆盖原网页 | Chromium 没有“列出本机全部证书”的稳定接口，直接把侧栏项做成根证书库只能是假数据。站点证书页真正常用的上下文是“我刚看的那一页”，因此来源标签必须由浮层/菜单显式传入；后台标签可能已被冻结、DevTools 也可能占着调试连接，故再保留一层本会话快照作为降级，侧栏直达时同样有可读内容。 |
| 2026-11-16 | 证书链补齐与 IPC 边界收口 | `Network.getCertificate` 返回的所有 DER 成员都经 `X509Certificate` 解析为 `certificateChain`（叶证书在前）；浮层显示链长度，证书页用原生 `details` 展开成员；`security:site` 的显式 `tabId` 仅允许 `hira://certificates` 发送，浮层改为省略参数读取活动标签 | 原实现只保留第一张证书，内部页无法回答“中间证书是谁签的”；同时若所有受信 UI 都能传 `tabId`，会被当成同窗口任意标签的证书探测口。链数据与专用入口分别补齐后，能力完整且权限边界仍保持最小。 |
| 2026-11-16 | 证书会话数据的 profile / space 隔离 | 站点证书快照和证书校验失败记录都写入内部 `scopeKey`（profile + space），证书页只读取当前作用域；`scopeKey` 不进入 IPC 响应 schema | 证书页开始展示会话快照后，若不分区就会把账号 A / 空间 A 的站点身份泄漏到账号 B / 空间 B。隔离键只在主进程内部用于过滤，不给渲染层提供新的追踪维度。 |
| 2026-11-17 | CDP 证书表为空时的可用性兜底 | `Network.getCertificate` 前显式启用 Network 域；空表、debugger 占用或命令失败时，新增 `certificate-tls-probe` 做 5 秒超时的独立 TLS 握手读取证书链。实测 `example.com` 返回 4 张证书，主进程服务可在 CDP 不可用时返回叶证书与完整链 | 定制 Electron/Chromium 或特定代理链路中 CDP 命令成功 resolve 但 `tableNames` 为空，原实现把它误判成“页面没有证书”。兜底只读取 TLS 握手证书，不发送 HTTP 请求、不改变网页连接的安全策略，也不接触页面数据。 |

