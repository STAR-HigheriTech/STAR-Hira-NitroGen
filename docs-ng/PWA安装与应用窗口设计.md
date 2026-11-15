# PWA 安装与应用窗口 —— 落地设计

> 目标：让 Hira NG 像 Edge / Chrome 一样，把任意站点「安装为应用」：地址栏一键安装、安装确认框、独立应用窗口、开始菜单 / 桌面快捷方式、独立任务栏身份、可卸载、可检查更新。
> 本文是落地时的对照清单：按 §15 的文件表逐项做完即可，不需要再回头做设计决策。§16 是给后续扩展留的口，本期不实现。
>
> 红线（见 `docs-new/5-文档地图与工程红线.md`）：
> 1. 依赖方向 domain → infra → ui → apps，永不反转；domain 不许 require electron / fs / net。
> 2. 窗口特性只在 `window-config.js` 定义；webPreferences 只在 `infra-window` 生成。
> 3. 单一事实源：能力定义在 domain，路径/协议/窗口在各自唯一位置，禁止"这里一条规则、那里一个变化"。

---

## 0. 结论速览

| 决策 | 结论 | 一句话理由 |
| --- | --- | --- |
| **运行时形态** | **单进程多窗口** + 窗口级 `win.setAppDetails()` | Chromium 的 userData / session profile 不支持多进程并存，Electron 单实例锁又是全局的；PWA 每应用一进程走不通 |
| **安装判定** | **自建探测链路**（`tab-preload` 上报线索 → 主进程 `ses.fetch` 重拉 manifest → domain 纯规则判定） | Electron 没有 `beforeinstallprompt`，也没有 `app.installPWA()` |
| **两档安装** | 完整 PWA / 站点应用（无 manifest 或门槛不达标时兜底） | 对齐 Edge 的两种结果，且不因 manifest 缺失断掉能力 |
| **manifest 可信度** | 渲染层只上报**线索**（href / 标题 / 主题色），主进程**重新拉取并校验** | 页面内容一律不可信；图标与 start_url 会被落盘执行 |
| **应用窗口** | 新增 `WINDOW_TYPES.PWA_APP`（`dynamic`，无 page/entry）+ `WebContentsView` | 复用 PEEK 已验证的「chrome 渲染 + 网页视图」结构，风险最低 |
| **冷启动** | `--pwa-app=<id> --pwa-profile=<pid>` + 隐藏主窗、**不 mount**、跳过会话恢复 | 主窗口在 DB 之前创建（main.js L884 vs L901），不能"先查库再决定建窗" |
| **存储** | profile 级 `pwa_apps` 表 + `userData/profiles/<pid>/pwa/<appId>/` 资产目录 | 与现有 profile 隔离、删 profile 一并清理的既有语义对齐 |
| **图标访问** | 新增 `hira-pwa://` 协议 | 不把绝对路径交给渲染层 |
| **任务栏身份** | 进程 AUMID 不变，应用窗 `setAppDetails({ appId })` 覆盖 | Electron 没有 per-app AUMID；窗口级覆盖是唯一可用手段 |
| **插件形态** | `pwa-service`（`createServicePlugin`）+ `feature-map` 的 `pwaApps` 功能面 | 与 TOTP / 扫码器同一套插件化范式，默认启用 |
| **系统集成** | 只做 Windows（`shell.writeShortcutLink`），接口留 `ShortcutDriver` | 先把主平台做透；macOS/Linux 后续补驱动 |

---

## 1. Edge 能力对照与本期边界

| Edge / Chrome 行为 | 本期 | 实现说明 |
| --- | --- | --- |
| 地址栏出现"安装"图标 | ✅ | 三态：隐藏 / 可安装 / 已安装 |
| 安装确认框（图标、名称、来源、"创建桌面快捷方式"） | ✅ | 独立 modal 窗 `PWA_INSTALL` |
| 独立应用窗口（无地址栏、无标签栏） | ✅ | `PWA_APP` + `WebContentsView` |
| 独立任务栏图标与分组 | ✅（有差异） | `win.setAppDetails()`；见 §17 的 Windows 行为差异 |
| 开始菜单 / 桌面快捷方式 | ✅ | `shell.writeShortcutLink` |
| 开机自动启动 | ✅ | 写 Startup 目录快捷方式 |
| 已安装应用列表（管理页） | ✅ | `hira://apps` |
| 卸载（清数据 + 清快捷方式 + 关窗） | ✅ | 见 §13 |
| 检查更新（manifest 变更） | ✅ | 启动后延迟 30s + 手动入口 |
| 文件处理 `file_handlers` | ❌ 留扩展点 | §16 |
| 协议处理 `protocol_handlers` | ❌ 留扩展点 | §16 |
| 分享目标 `share_target` | ❌ 留扩展点 | §16 |
| 应用角标 `badging` | ❌ 留扩展点 | §16 |
| 窗口控件覆盖 `window-controls-overlay` | ❌ | 自绘 chrome，不需要 |

**明确不做：**

- 不复制 Chrome 的「必须有 Service Worker」硬性要求。离线能力交给 Chromium 自身缓存策略，不因缺 SW 拒绝安装。
- 不做每个应用独立 session / 独立 cookie 分区。`pwa_apps.session_partition` 字段先留着，本期恒为 `null`（共用默认 session）。
- 不做 macOS / Linux 快捷方式实现，但快捷方式调用必须走 `ShortcutDriver` 接口（§10）。
- 不做 Web App Manifest 的 `display_override` / `launch_handler` 语义，本期只读 `display`。

---

## 2. Electron 事实基线（决定方案形状）

这九条是本方案的地基，实施时不要试图"绕过去"：

1. **没有 `beforeinstallprompt`**：Chromium 的安装事件是浏览器 UI 层的能力，Electron 不暴露。→ 必须自建探测。
2. **没有 `app.installPWA()`**：安装 = 自己写快捷方式 + 自己开窗。
3. **没有自动 per-app AUMID**：`app.setAppUserModelId()` 是**进程级**；`win.setAppDetails({ appId, appIconPath, relaunchCommand, relaunchDisplayName })` 是**窗口级**，通过窗口属性覆盖任务栏分组。
4. **`shell.writeShortcutLink` 只能写 `.lnk`**：Windows 专用，`appUserModelId` 必须与 `setAppDetails.appId` 完全一致，否则任务栏会分成两个图标。
5. **`ses.fetch()` 走会话**：带 cookie / 代理 / 证书策略，是拉 manifest 与图标的唯一正确入口（不要用 Node 的 `fetch`）。
6. **`window-all-closed` 在还有隐藏主窗时不会触发**：PWA-only 模式必须显式退出。
7. **Chromium 的 userData / session 目录不支持多进程并存**：两个进程共用一个 userData 会互相锁死。→ 放弃"每应用一进程"。
8. **Electron 单实例锁是全局的**：`requestSingleInstanceLock()` 只认整个 app，不认 AUMID。→ 第二次启动统一走 `second-instance` 转交。
9. **sandbox 的 `tab-preload` 是 CJS**：只能 `require('electron')`，不能 require `.mjs` / 共享包。→ 通道字符串必须手写字面量，并在注释里标注与 `IPC_ROUTES` 同步。

---

## 3. 分层与数据流总览

### 3.1 四层职责

| 层 | 包 | 职责 | 绝对不做 |
| --- | --- | --- | --- |
| domain | `domain/domain-pwa` | manifest 规范化、门槛判定、`start_url`/`scope` 校验、`appId` 生成、应用名/图标挑选、快捷方式路径规则、`pwa_apps` 读写服务 | 不碰 electron、不碰 fs、不发网络请求 |
| infra | `infra/infra-pwa` | `ses.fetch` 拉 manifest、图标下载与落盘、PNG→ICO、快捷方式驱动（Windows 实现）、图标协议的文件读取 | 不知道"应用"是什么业务概念，只提供原子能力 |
| ui | `ui/ui-navbar` + `apps/app-main/src/pages/apps` + `renderer/subwindow/windows/pwa-*` | 地址栏按钮、安装框、管理页、应用窗 chrome | 不做校验、不拼路径、不读 DB |
| apps | `apps/app-main/src/main/pwa/*` + `ipc/pwa.js` + 插件 `.cjs` | 装配：把 domain 规则、infra 能力、窗口、IPC、插件接到一起 | 不重复实现规则（规则只在 domain） |

### 3.2 主链路

```
页面 DOM
  └─(tab-preload 收集线索, 单向 send)──► main/pwa/detect.js
                                            ├─ ses.fetch(manifestUrl)  ← 不信任渲染层内容
                                            ├─ domain-pwa/manifest.normalizeManifest()
                                            ├─ domain-pwa/classifyInstall()
                                            └─ candidateStore（TTL 10min）
                                                     │
地址栏 ◄──(IPC_EVENTS.pwaDetected)────────────────────┘

地址栏点击安装
  └─(invoke pwa:prepare)──► ipc/pwa.js ──► detect.getCandidateForTab(tabId)
                                              └─► { candidateId, preview }

window:open('pwa-install', { candidateId })
  └─(invoke pwa:install)──► ipc/pwa.js ──► main/pwa/install.js
                                              ├─ infra-pwa/icon-store（下载/缩放/ICO）
                                              ├─ infra-pwa/shortcut（.lnk × N）
                                              ├─ pwaService.upsert()
                                              └─ broadcast pwa:changed

启动应用
  └─► main/pwa/window.js#openAppWindow()
        ├─ createSubWindow(hira://subwindow?type=pwa-app&appId=…)
        ├─ win.setAppDetails({ appId: `…pwa.${appId}`, … })
        └─ WebContentsView(loadURL(start_url))
```

---

## 4. domain-pwa：纯规则与服务

### 4.1 文件

| 文件 | 内容 |
| --- | --- |
| `domain/domain-pwa/package.json` | 类型入口 `src/index.ts`，运行入口 `dist/index.cjs`；依赖 `@hira-ng/infra-db`、`@hira-ng/shared-types`、`drizzle-orm` |
| `domain/domain-pwa/src/index.ts` | `createPwaService(db, options)`，导出类型化 PWA 服务契约 |
| `domain/domain-pwa/src/manifest.ts` | manifest 规范化 / 图标挑选 / 名称解析（纯函数） |
| `domain/domain-pwa/src/rules.ts` | 门槛判定、URL/scope 校验、`appId` 生成（纯函数） |

### 4.2 纯函数清单（无 I/O，可单测）

```js
// manifest.js
normalizeManifest(raw, { documentUrl })   // → 规范化对象 | null
resolveStartUrl(manifest, documentUrl)    // → 绝对 URL（缺省 = documentUrl）
resolveScope(manifest, startUrl)          // → 默认 = start_url 的目录
pickBestIcon(icons, { targetSize })       // → { src, sizes, type } | null
resolveAppName(manifest, pageTitle, documentUrl)
sanitizeShortcutName(name)                // 去掉 \ / : * ? " < > | 与首尾空白，限 60 字符

// rules.js
isHttpUrl(url)
isSameOrigin(a, b)
isInScope(url, scope)
classifyInstall(manifest)                 // → 'full' | 'shortcut'
makeAppId(profileId, startUrl)            // → 'pwa-' + sha256(profileId + '\n' + startUrl).slice(0, 16)
```

### 4.3 判定规则（唯一真源）

**完整 PWA（`full`）需要同时满足：**

| 条件 | 取值 |
| --- | --- |
| `name` 或 `short_name` | 至少一个非空 |
| `start_url` | 解析后与 `documentUrl` **同源** |
| 图标 | 至少一个 `sizes` 含 ≥192×192 的 `png` / `webp` / `svg` |
| `display` | `standalone` / `minimal-ui` / `fullscreen` 之一 |

**否则 → 站点应用（`shortcut`）**：`start_url = documentUrl`、`name = 页面标题`、图标回落 favicon、`display = 'standalone'`。
`install_kind` 落库，安装框与管理页如实展示"简化应用"，不假装是完整 PWA。

### 4.4 服务

```js
function createPwaService(db, options = {}) {
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null
  function currentProfile() { /* 端口缺失/抛错 → 'default'，绝不"拿不到就不过滤" */ }
  return {
    list(), get(id), findByStartUrl(url),
    upsert(record),                       // 唯一写入入口，内部维护 created_at/updated_at
    remove(id),
    touchLaunched(id),
    markChecked(id, { updateState, lastCheckedAt }),
    setFlags(id, { runOnStartup, startMenuShortcut, desktopShortcut }),
    setWindowState(id, stateObj),
    setSessionPartition(id, partition)    // 本期不用，给扩展点留
  }
}
```

约定：

- 所有查询强制带 `profile_id`；`get(id)` 也校验 profile，避免跨 profile 串号。
- 对外一律返回 camelCase 对象，不把 SQL 行原样抛给上层。
- `upsert` 以 `(profile_id, start_url)` 唯一键做冲突合并：已存在时保留 `id`、`created_at`、快捷方式标记与 `window_state`，只更新 manifest 派生字段。

---

## 5. 存储：表与资产目录

### 5.1 DDL（两处必须同步：`infra/infra-db/src/schema.js` 与 `PROFILE_SCHEMA_DDL`）

```sql
CREATE TABLE IF NOT EXISTS pwa_apps (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL DEFAULT 'default',
  name               TEXT NOT NULL,
  short_name         TEXT,
  start_url          TEXT NOT NULL,
  scope              TEXT,
  manifest_url       TEXT,
  manifest_json      TEXT,
  display            TEXT NOT NULL DEFAULT 'standalone',
  theme_color        TEXT,
  background_color   TEXT,
  icon_path          TEXT,
  icon_small_path    TEXT,
  icon_ico_path      TEXT,
  install_kind       TEXT NOT NULL DEFAULT 'full',
  source             TEXT NOT NULL DEFAULT 'manifest',
  session_partition  TEXT,
  start_menu_shortcut TEXT,
  desktop_shortcut   TEXT,
  run_on_startup     INTEGER NOT NULL DEFAULT 0,
  window_state       TEXT,
  update_state       TEXT NOT NULL DEFAULT 'idle',
  last_checked_at    INTEGER,
  last_launched_at   INTEGER,
  launch_count       INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pwa_apps_profile_start_url ON pwa_apps (profile_id, start_url);
CREATE INDEX IF NOT EXISTS pwa_apps_profile ON pwa_apps (profile_id);
```

### 5.2 资产目录（profile 级，删 profile 一并清理）

```
userData/profiles/<profileId>/pwa/<appId>/
  manifest.json      // 安装时的 manifest 快照（更新 diff 用）
  icon-512.png
  icon-192.png
  icon-32.png
  icon.ico           // PNG-in-ICO 多尺寸容器
```

- 目录常量只在 `main/pwa/paths.js` 拼一次，其他模块一律调用它。
- 落盘全部用 `fs.promises`；写入先写 `*.tmp` 再 `rename`，避免半截文件。

### 5.3 `hira-pwa://` 协议

- 注册：`apps/app-main/src/main/hira-pwa-protocol.js`，在 `app.whenReady` 内 `protocol.handle('hira-pwa', handler)`。
- URL 形态：`hira-pwa://<appId>/<file>?p=<profileId>`。
  **为什么要带 `p`**：协议请求没有 sender 上下文，`runtimeRegistry` 解析不到 profile；显式带参是唯一无歧义的做法。
- handler：
  1. 校验 `appId` 形如 `^pwa-[a-f0-9]{16}$`，`file` 只允许白名单（`icon-512.png` / `icon-192.png` / `icon-32.png` / `icon.ico`）；
  2. 用 `p` 拼目录（`resolvePwaAssetDir`），再 `path.resolve` + `startsWith` 双保险，杜绝 `..`；
  3. 返回 `new Response(stream, { headers })`，带 `Cache-Control: no-cache`（图标会随更新变化）。
- 主进程把 `hira-pwa://…` 作为 `iconUrl` 下发给渲染层，**绝不传绝对路径**。

---

## 6. 探测链路

### 6.1 渲染侧（`infra/infra-window/preload/tab-preload.js`）

新增一段独立函数，不污染既有 `window.hira` API：

```js
// 注意：sandbox preload 是 CJS，通道必须写字面量；
// 与 packages/shared-types/src/ipc-channels.mjs 的 IPC_ROUTES.pwaCandidate 保持同步。
const PWA_CANDIDATE_CHANNEL = 'ngipc:send:pwa:candidate'

function collectInstallHints() {
  const link = document.querySelector('link[rel="manifest"]')
  const theme = document.querySelector('meta[name="theme-color"]')
  return {
    manifestUrl: link ? new URL(link.getAttribute('href'), location.href).href : null,
    documentUrl: location.href,
    title: document.title,
    themeColor: theme ? theme.getAttribute('content') : null
  }
}
```

触发时机：

- `document.readyState` 到 `interactive` / `complete` 各发一次；
- `pageshow`、`popstate`、`hashchange` 各发一次；
- `MutationObserver` 监听 `<head>` 的 `childList`，**300ms 防抖**，只在 `manifestUrl` 或 `title` 变化时发。

节流：同一 URL + 同一 manifestUrl 只发一次（模块内 `lastSent` 记录）。隐身标签、非 `http(s)` 页面直接不发。

### 6.2 主进程（`apps/app-main/src/main/pwa/detect.js`）

```js
async function handleCandidate(event, payload)
```

1. **身份校验**：`event.sender` 必须是某个 runtime 的 tab webContents；用 `tabManager.getTabIdByWebContents(wc)` 反查 `tabId`，查不到直接丢弃。
2. **准入**：`documentUrl` / `manifestUrl` 必须 `http(s)`；隐身窗口（`tabManager` 的隐身标记）不处理。
3. **拉取**：`webContents.session.fetch(manifestUrl, { credentials: 'include', signal: AbortSignal.timeout(8000) })`；限制响应体 ≤ 512KB，`Content-Type` 必须含 `json` 或 `manifest`。
4. **同源**：`isSameOrigin(manifestUrl, documentUrl)` 为 false 时要求 `Access-Control-Allow-Origin` 放行，否则按"无 manifest"处理。
5. **规范化**：`normalizeManifest(raw, { documentUrl })` + `classifyInstall()`。
6. **缓存**：`candidateStore.put({ tabId, profileId, candidate })`，key = `randomUUID()`，TTL 10 分钟；同一 tab 的新候选覆盖旧候选。
7. **通知**：`emitToWindow(win, IPC_EVENTS.pwaDetected, { tabId, state, candidateId, appId })`。
   - `state = 'installed'`：`pwaService.findByStartUrl(start_url)` 命中；
   - `state = 'installable'`：有候选；
   - `state = 'none'`：无 manifest 且非 http(s)。

导航离开时由 `TabManager` 的 `did-navigate` / 标签关闭事件回调 `detect.clear(tabId)` 并推送 `state: 'none'`。

---

## 7. 安装链路

### 7.1 交互顺序

```
地址栏按钮点击
  → invoke pwa:prepare { tabId }
  → 返回 { candidateId, preview: { name, iconUrl, kind, origin } }
  → window:open('pwa-install', { candidateId })
  → 确认框展示 + 勾选项
  → invoke pwa:install { candidateId, createDesktopShortcut, createStartMenuShortcut, runOnStartup }
  → 成功：关闭确认框 + 广播 pwa:changed + 地址栏切"已安装"
```

### 7.2 主进程安装管线（`apps/app-main/src/main/pwa/install.js`）

| 步 | 动作 | 失败处理 |
| --- | --- | --- |
| 1 | 取候选并校验未过期、`profileId` 与当前一致 | 抛"安装信息已过期，请刷新页面重试" |
| 2 | `appId = makeAppId(profileId, start_url)`；若已存在则走"覆盖安装"分支 | — |
| 3 | `assets.mkdir(assetDir)` | 中止 |
| 4 | 下载最佳图标（≤4MB；校验 `Content-Type` 与魔数：PNG/JPEG/WEBP/SVG） | 回落 favicon；再失败用内置默认图标 |
| 5 | `nativeImage` 缩放 512 / 192 / 32，写 PNG | 同上 |
| 6 | 生成多尺寸 `icon.ico`（PNG-in-ICO 容器，`infra-pwa/src/ico.js`） | 无 ICO 只影响快捷方式图标，不中止安装 |
| 7 | 写 `manifest.json` 快照 | 中止（更新 diff 依赖它） |
| 8 | 生成快捷方式（按用户勾选） | 记录失败项，安装仍算成功，结果里回报 |
| 9 | `pwaService.upsert(...)` | 中止并清理 3-7 的产物 |
| 10 | `broadcast(IPC_EVENTS.pwaChanged, { appId, action: 'install' })` | — |

**回滚**：任一致命步失败时，删除本次新建的资产目录与已写快捷方式；覆盖安装不删旧目录（先写临时目录，成功后整体替换）。

**进度**：安装框订阅 `IPC_EVENTS.pwaInstallProgress`（`{ candidateId, stage: 'icon' | 'shortcut' | 'db' }`），仅用于文案，不阻塞。

---

## 8. 应用窗口运行时

### 8.1 窗口类型（`apps/app-main/src/main/window-config.js`）

```js
PWA_APP: 'pwa-app',
PWA_INSTALL: 'pwa-install',

[WINDOW_TYPES.PWA_APP]: {
  dynamic: true,                 // 无 page、无 entry → getWindowConfig 返回 null，只能由专用启动器打开
  width: 1200, height: 800,
  minWidth: 360, minHeight: 240,
  modal: false, frame: false, autoHideMenuBar: true,
  resizable: true, independent: true, showOnReady: true,
  backgroundColor: '#ffffff'
},
[WINDOW_TYPES.PWA_INSTALL]: {
  entry: 'subwindow',
  params: { type: 'pwa-install' },
  width: 480, height: 420,
  resizable: false, modal: true, showOnReady: true,
  backgroundColor: '#ffffff'
}
```

> `PWA_APP` 故意不配 `entry`：它必须带 `appId` 参数，走 `window:open` 的通用链路会丢参。专用启动器在 `main/pwa/window.js`。

### 8.2 组装（`apps/app-main/src/main/pwa/window.js`）

结构完全对齐 `peek.js`：

1. `windowFactory.createSubWindow({ type: WINDOW_TYPES.PWA_APP, ... })`；
2. `win.loadURL('hira://subwindow?type=pwa-app&appId=…&p=…')`（chrome 只画标题栏）；
3. 创建 `WebContentsView`：`webPreferences = buildTabWebPreferences({ preload: false, session: 默认 session })`；
4. `win.contentView.addChildView(view)`；
5. 等 chrome 上报高度（`ngipc:send:pwa:chrome`）后 `placePage({ x: 0, y: height, w, h })`；
6. 窗口 `resize` 时重算 bounds；
7. `view.webContents.loadURL(start_url)`，随后 `touchLaunched(id)` 并把 `launch_count + 1`。

**导航策略**（`will-navigate` / `setWindowOpenHandler`）：

- 目标 URL 在 `scope` 内 → 留在应用窗内导航；
- 超出 `scope` 的 `http(s)` → `shell.openExternal`，应用窗保持不变；
- 非 `http(s)` 协议 → 一律 `shell.openExternal`（交给系统）；
- 禁止 `window.open` 再开 Electron 窗（`setWindowOpenHandler` 返回 `{ action: 'deny' }`）。

**窗口身份与生命周期**：

```js
win.setAppDetails({
  appId: `com.starhigheritech.hira-ng.pwa.${appId}`,
  appIconPath: absoluteIconPath,          // 仅此处允许绝对路径，不经过渲染层
  relaunchCommand: buildRelaunchCommand({ appId, profileId }),  // 含 dev 态 appRoot
  relaunchDisplayName: name
})
```

- 内存表 `Map<appId, { win, view }>`：同 appId 再启动 → `restore()` + `focus()`；
- `closed` → 删表项；若 `pwaOnlyMode` 且表为空 → `app.quit()`；
- 几何：`move` / `resize` 防抖 500ms → `pwaService.setWindowState(id, { x, y, width, height, maximized })`；下次打开恢复并做屏幕可见性裁剪。

### 8.3 chrome 渲染（`apps/app-main/src/renderer/subwindow/windows/pwa-app.js`）

- 标题栏：应用图标 + 名称 + 后退 / 前进 / 刷新 + `…` 菜单；
- 高度测量：`ResizeObserver` → `ngipc:send:pwa:chrome`，只在整数像素变化时发；
- `…` 菜单：在浏览器中打开 / 复制链接 / 缩放（100%/125%/150%）/ 开发者工具 / 卸载此应用；
- 主题：读 `theme_color` 作为标题栏底色，文字颜色按对比度自动取黑/白；
- 拖拽区：标题栏 `-webkit-app-region: drag`，按钮 `no-drag`。

注册到 `apps/app-main/src/renderer/subwindow/main.js` 的 `WINDOW_MOUNTS`：

```js
'pwa-app': mountPwaApp,
'pwa-install': mountPwaInstall
```

### 8.4 安装框（`windows/pwa-install.js`）

展示：图标、名称、来源域名、"完整应用 / 简化应用"标记、三个勾选项（桌面快捷方式默认开、开始菜单默认开、开机启动默认关）。
按钮：取消 / 安装。安装中禁用按钮并显示阶段文案。错误就地展示（不弹系统框）。

---

## 9. 冷启动与单实例

### 9.1 启动参数（`apps/app-main/src/main/app/pwa-args.js`）

```js
parsePwaArgs(argv)   // → { appId, profileId, spaceId } | null
buildPwaArgs({ appId, profileId, isPackaged, appRoot })
buildRelaunchCommand({ appId, profileId })   // 快捷方式 target/args 用
```

- 形态：`--pwa-app=<id> --pwa-profile=<pid> [--pwa-space=<sid>]`
- `buildPwaArgs` 在 **dev 态**返回 `["<appRoot>", "--pwa-app=…", …]`（第一个参数是 app 路径，否则 `electron.exe` 不知道跑什么）；打包态只返回 `--pwa-app=…`。
- 该模块 only 依赖 `node:path` / `process`，`whenReady` 之前即可用。

### 9.2 已有实例（`main.js` 的 `second-instance`）

识别顺序改为：**`--pwa-app` → JumpList 动作 → URL**。

```js
const pwa = parsePwaArgs(argv)
if (pwa) { pwaRuntime.open(pwa.appId, pwa.profileId); return }
```

`pwaRuntime.open` 若窗口不存在则新建（并聚焦主窗？不——PWA-only 时不唤醒主窗，只开应用窗）。

### 9.3 冷启动时序（在 `main.js` 现有顺序上插入，不改建窗顺序）

| 位置 | 现有行为 | PWA 冷启动分支 |
| --- | --- | --- |
| L884 | 创建主窗（隐藏） | 不变，照常创建 |
| L901 | 建 DB provider | 不变 |
| L986-1012 | `activeProfile` / `resolveStartupSpace()` / `spaceRuntime.setCurrent` | 若 argv 带 `--pwa-profile`：`spaceRuntime.setCurrent({ profileId: argv.pid, spaceId: argv.sid ?? 该 profile 的 lastUsed })`；**不改** `profileService` 的全局 active，不写 lastUsed |
| L1655 前后 | 建各域服务 | 不变 |
| L3059 / L4044 | 面板目录 / `registerCoreIpc` | 不变 |
| **L4285** | `browserWindows.mount(primaryWindow)`（此刻才 show） | **跳过**；`pwaOnlyMode = true` |
| L4297+ | 插件后台启用 | 不变（PWA 需要 `pwa-service`） |
| L4390-4446 | 会话恢复 / 起始页 | **跳过**（不能把上次的标签塞进 PWA-only 进程） |
| 服务就绪后 | — | `await pwaRuntime.open(appId, profileId)` |

**退出规则**：`pwaOnlyMode` 时监听应用窗关闭，最后一个关闭 → `app.quit()`（`window-all-closed` 因隐藏主窗不会触发）。

**唤醒浏览器**：应用窗菜单"在浏览器中打开" → `browserWindows.mount(primaryWindow)` + 新标签打开当前 URL，`pwaOnlyMode = false`，之后恢复正常规则。

**降级**：`appId` 查不到 / 资产目录缺失 / manifest 快照损坏 → 正常 `mount` 主窗 + 一次性标签页 + `dialog.showMessageBox` 说明"该应用已被移除"，并清理残留行。

---

## 10. 操作系统集成

### 10.1 快捷方式驱动（`infra/infra-pwa/src/shortcut.js`）

```js
createShortcut({ target, args, cwd, icon, iconIndex, appUserModelId, description, location })
removeShortcut(filePath)
```

| 位置 | 路径 |
| --- | --- |
| 开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Hira\<name>.lnk` |
| 桌面 | `app.getPath('desktop')\<name>.lnk` |
| 开机启动 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\<name>.lnk` |

- `target = process.execPath`；`icon = icon.ico`；`iconIndex = 0`。
- `appUserModelId` 必须与 `win.setAppDetails.appId` **逐字符一致**。
- 同名冲突 → 追加 ` (2)`、` (3)`（`sanitizeShortcutName` + 唯一化函数）。
- 删除前先 `shell.readShortcutLink` 校验 `target === process.execPath`，避免误删用户自己的快捷方式。
- **接口形状固定为 driver**：`{ id: 'windows', create, remove, isSupported }`，`shortcut.js` 只做选择与转发。macOS/Linux 后续加驱动即可，不动调用方。

### 10.2 已固定的任务栏项

Windows 不允许程序化取消"固定到任务栏"。文档与 UI 都不承诺这一点；卸载时只删快捷方式与文件。

---

## 11. 插件 / IPC / feature-map

### 11.1 插件

`apps/app-main/plugins/pwa-service.cjs`：

```js
const { createServicePlugin } = require('@hira-ng/infra-plugin/service-plugin')
module.exports = createServicePlugin({
  domain: 'pwa',
  serviceName: 'pwaService',
  capabilities: {
    'pwa.list':        (svc) => () => svc.list(),
    'pwa.get':         (svc) => (input) => svc.get(input.id),
    'pwa.install':     (svc) => (input, ctx) => ctx.install(input),
    'pwa.uninstall':   (svc) => (input, ctx) => ctx.uninstall(input.id),
    'pwa.launch':      (svc) => (input, ctx) => ctx.launch(input.id),
    'pwa.update':      (svc) => (input, ctx) => ctx.update(input.id),
    'pwa.checkUpdates':(svc) => (input, ctx) => ctx.checkUpdates(),
    'pwa.setRunOnStartup': (svc, input) => svc.setFlags(input.id, { runOnStartup: input.enabled }),
    'pwa.createShortcut':  (svc, input, ctx) => ctx.createShortcut(input.id, input.location),
    'pwa.removeShortcut':  (svc, input, ctx) => ctx.removeShortcut(input.id, input.location)
  }
})
```

`pwa-service.hira-plugin.json`：

```json
{
  "id": "pwa-service",
  "type": "feature-plugin",
  "trustLevel": "internal",
  "main": "pwa-service.cjs",
  "capabilities": ["pwa.list", "pwa.get", "pwa.install", "pwa.uninstall", "pwa.launch",
                   "pwa.update", "pwa.checkUpdates", "pwa.setRunOnStartup",
                   "pwa.createShortcut", "pwa.removeShortcut"],
  "dependsOn": []
}
```

（provider id 由工厂自动生成为 `pwa.service.list` 等；`ctx` 由 `plugin-bootstrap` 注入的 `getDomainServices()` 提供，不在此文件 require 任何业务模块。）

`feature-map.js` 新增：

```js
pwaApps: Object.freeze({ plugins: Object.freeze(['pwa-service']), label: '已安装应用' })
```

### 11.2 IPC 路由（`packages/shared-types/src/ipc-channels.mjs`）

```js
pwaList:            'pwa:list',
pwaGet:             'pwa:get',
pwaPrepare:         'pwa:prepare',
pwaInstall:         'pwa:install',
pwaUninstall:       'pwa:uninstall',
pwaLaunch:          'pwa:launch',
pwaUpdate:          'pwa:update',
pwaCheckUpdates:    'pwa:check-updates',
pwaSetRunOnStartup: 'pwa:set-run-on-startup',
pwaCreateShortcut:  'pwa:create-shortcut',
pwaRemoveShortcut:  'pwa:remove-shortcut',
pwaNavigate:        'pwa:navigate',
pwaGetWindowState:  'pwa:get-window-state',
pwaChrome:          'pwa:chrome',        // 单向 send：chrome 高度上报
pwaCandidate:       'pwa:candidate'      // 单向 send：tab-preload 上报线索
```

事件：

```js
pwaChanged:          'pwa:changed',
pwaDetected:         'pwa:detected',
pwaInstallProgress:  'pwa:install-progress',
pwaWindowState:      'pwa:window-state'
```

### 11.3 契约（`infra/infra-ipc/src/contracts/pwa.js`）

| schema | 用途 |
| --- | --- |
| `pwaPrepareSchema` | `{ tabId: string }` |
| `pwaInstallSchema` | `{ candidateId: string, createDesktopShortcut: boolean, createStartMenuShortcut: boolean, runOnStartup: boolean }` |
| `pwaIdSchema` | `{ id: string }` |
| `pwaSetRunOnStartupSchema` | `{ id: string, enabled: boolean }` |
| `pwaShortcutSchema` | `{ id: string, location: 'desktop' \| 'start-menu' }` |
| `pwaNavigateSchema` | `{ appId: string, url: string }` |
| `pwaChromeSchema` | `{ appId: string, height: number }` |
| `pwaCandidateSchema` | `{ manifestUrl: string \| null, documentUrl: string, title: string, themeColor: string \| null }` |

在 `contracts/index.js` 登记为 `pwa`。

### 11.4 装配（`apps/app-main/src/main/ipc/pwa.js`）

```js
registerPwaIpc(typedMain, { routes, schemas, pwaService, pwaRuntime, detect, install, emit })
```

- 所有 `invoke` 走 `typedMain.handle(routes.xxx, schema, handler)`；
- `pwa:candidate` / `pwa:chrome` 走裸通道（`ipcMain.on`），由 `runtimeRegistry.scopeRawIpcMain` 纳入上下文；
- 注册器只拿自己需要的依赖，不读全局单例。

在 `ipc-routes.js` 中紧跟 `registerTotpIpc` 之后调用，并把 `pwaService` / `pwaRuntime` / `pwaDetect` / `pwaInstall` 加进 `registerCoreIpc` 的解构入参。

---

## 12. UI 入口

### 12.1 地址栏按钮

`ui/ui-common/src/icons.ts` 的 `CHROME_BUTTONS` 新增：

```js
{ id: 'pwa-install-button', label: '安装应用', icon: AppWindow, navbar: true, rail: false, segment: 'omnibox', feature: 'pwaApps' }
```

组件 `ui/ui-navbar/src/components/pwa-install-button.js`：

| 状态 | 表现 |
| --- | --- |
| `none` | `hidden`（不占位） |
| `installable` | 显示"安装"图标，点击 `pwa:prepare` → `window:open('pwa-install')` |
| `installed` | 显示"打开应用"图标，点击 `pwa:launch` |

订阅 `IPC_EVENTS.pwaDetected`（按 `tabId` 过滤，切换标签时重算）；插件被显式关闭时 `feature: 'pwaApps'` 自动隐藏，组件无需自己判断。

### 12.2 管理页 `hira://apps`

`apps/app-main/src/pages/apps/{index.html, apps.js, apps.css}`（结构照抄 `pages/extensions/`）：

- 头部：标题"已安装应用" + "检查更新"按钮；
- 列表：图标、名称、来源域名、安装类型、上次启动、快捷方式状态；
- 行操作：打开 / 在浏览器中打开 / 创建快捷方式 / 开机启动开关 / 检查更新 / 卸载；
- 空状态：说明"在网页地址栏点击安装图标即可把站点安装为应用"。

新增 `WINDOW_TYPES.APPS_MANAGER`（`page: 'apps'`），并在设置页与主菜单加入口。

### 12.3 主菜单

`app-menu.js` 的「文件」：新增 `将本页安装为应用…`（当前标签不可安装时置灰）；「工具 / 应用」下新增 `已安装应用`。

---

## 13. 更新与卸载

### 13.1 更新检测（`main/pwa/updater.js`）

- 启动完成 30s 后跑一轮；只处理 `last_checked_at` 超过 24h 的记录，并发上限 3。
- 重新 `ses.fetch(manifest_url)` → `normalizeManifest` → 与 `manifest.json` 快照 diff：`name` / `short_name` / `start_url` / `scope` / `theme_color` / 图标集合 / `display`。
- 有差异 → `update_state = 'available'`，在管理页与地址栏提示；**不自动应用**。
- `pwa:update`：重下图标、重写快照、必要时重写快捷方式（名称/图标变了才写），完成后 `update_state = 'idle'`。
- 网络失败：`update_state = 'error'`，保留上次成功时间，不弹窗骚扰。

### 13.2 卸载

顺序（每步失败都汇总，不静默中断）：

1. 关闭该 appId 的应用窗（若开）；
2. 删开始菜单 / 桌面 / Startup 三个 `.lnk`（存在才删，删前校验 target）；
3. `pwaService.remove(id)`；
4. 删资产目录（`fs.rm(recursive: true, force: true)`）；
5. `broadcast(pwa:changed, { id, action: 'uninstall' })`。

返回 `{ ok, failures: [{ step, message }] }`；管理页逐条展示失败项。

---

## 14. 安全边界

| 面 | 约束 |
| --- | --- |
| 协议 | 只允许 `http:` / `https:`；`file:` / `javascript:` / 自定义协议一律拒绝安装 |
| manifest | 必须同源（或 CORS 显式放行）；响应 ≤ 512KB；超时 8s |
| `start_url` | 必须与 `documentUrl` 同源，且落在 `scope` 前缀内；否则降级为 `shortcut` 或拒绝 |
| 图标 | ≤ 4MB；只认 png/jpeg/webp/svg 魔数；落盘文件名由我们生成，不使用 manifest 里的路径 |
| 资产路径 | `path.resolve` + `startsWith(assetDir)` 双校验；`hira-pwa://` 只放行白名单文件名 |
| 渲染层 | 应用窗口 `preload: false`、`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`（全部由 `buildTabWebPreferences` 保证） |
| 外链 | 应用窗外链一律 `shell.openExternal`；`window.open` 一律 deny |
| 隐私 | 隐身标签不提供安装；安装记录按 profile 隔离，不跨 profile 查询 |
| 权限 | 沿用既有 permission session 处理器；不为 PWA 单独放宽任何权限 |

---

## 15. 分阶段实施清单

> 按依赖顺序做，每阶段结束 `pnpm build` 必须过。✅ 为完成标记。

### P1 · 存储与领域（无 UI，可独立验收）

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 1 | `infra/infra-db/src/schema.js` | 新增 `pwaApps` 表定义 | ✅ |
| 2 | `infra/infra-db/src/index.js` | `PROFILE_SCHEMA_DDL` 同步 DDL + 两个索引 | ✅ |
| 3 | `domain/domain-pwa/package.json` | 新建包 | ✅ |
| 4 | `domain/domain-pwa/src/manifest.ts` | 规范化 / 图标挑选 / 名称解析 | ✅ |
| 5 | `domain/domain-pwa/src/rules.ts` | 门槛 / URL / scope / appId | ✅ |
| 6 | `domain/domain-pwa/src/index.ts` | `createPwaService` | ✅ |

### P2 · infra-pwa 原子能力

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 7 | `infra/infra-pwa/package.json` | 新建包（依赖 `electron` 仅 peer） | ✅ |
| 8 | `infra/infra-pwa/src/manifest-fetch.js` | `ses.fetch` + 超时 + 大小限制 | ✅ |
| 9 | `infra/infra-pwa/src/icon-store.js` | 下载 / 魔数校验 / 缩放 / 落盘 | ✅ |
| 10 | `infra/infra-pwa/src/ico.js` | PNG-in-ICO 多尺寸容器 | ✅ |
| 11 | `infra/infra-pwa/src/shortcut.js` | `ShortcutDriver` + Windows 驱动 | ✅ |
| 12 | `infra/infra-pwa/src/index.js` | 统一导出 | ✅ |

### P3 · 探测 / 安装 / IPC / 插件

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 13 | `infra/infra-window/preload/tab-preload.js` | 新增 `collectInstallHints` 上报 | ✅ |
| 14 | `apps/app-main/src/main/pwa/candidate-store.js` | TTL 候选缓存 | ✅ |
| 15 | `apps/app-main/src/main/pwa/paths.js` | 资产目录唯一拼接点 | ✅ |
| 16 | `apps/app-main/src/main/pwa/detect.js` | 线索校验 + 拉取 + 推送 | ✅ |
| 17 | `apps/app-main/src/main/pwa/install.js` | 安装管线 + 回滚 | ✅ |
| 18 | `apps/app-main/src/main/hira-pwa-protocol.js` | 图标协议 | ✅ |
| 19 | `packages/shared-types/src/ipc-channels.mjs` | 路由 + 事件 | ✅ |
| 20 | `infra/infra-ipc/src/contracts/pwa.js` + `contracts/index.js` | zod 契约 | ✅ |
| 21 | `apps/app-main/src/main/ipc/pwa.js` | `registerPwaIpc` | ✅ |
| 22 | `apps/app-main/src/main/ipc-routes.js` | 装配新注册器 | ✅ |
| 23 | `apps/app-main/plugins/pwa-service.cjs` + `.hira-plugin.json` | 服务插件 | ✅ |
| 24 | `apps/app-main/src/main/feature-map.js` | `pwaApps` 功能面 | ✅ |

### P4 · 应用窗口与冷启动

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 25 | `apps/app-main/src/main/window-config.js` | `PWA_APP` / `PWA_INSTALL` / `APPS_MANAGER` | ✅ |
| 26 | `apps/app-main/src/main/app/pwa-args.js` | 参数解析 / 组装 | ✅ |
| 27 | `apps/app-main/src/main/pwa/window.js` | 应用窗组装 + `setAppDetails` + 导航策略 | ✅ |
| 28 | `apps/app-main/src/main/pwa/runtime.js` | `pwaRuntime.open/close/list` | ✅ |
| 29 | `apps/app-main/src/renderer/subwindow/windows/pwa-app.js` | 应用窗 chrome | ✅ |
| 30 | `apps/app-main/src/renderer/subwindow/main.js` | 注册两个 mount | ✅ |
| 31 | `apps/app-main/src/main/main.js` | 冷启动分支 + 跳过 mount/会话恢复 + 退出规则 | ✅ |
| 32 | `apps/app-main/src/main/app/instance.js` / `second-instance` | 优先识别 `--pwa-app` | ✅ |

### P5 · UI 入口与系统集成

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 33 | `ui/ui-common/src/icons.ts` | `pwa-install-button` | ✅ |
| 34 | `ui/ui-navbar/src/components/pwa-install-button.js` | 三态按钮 | ✅ |
| 35 | `apps/app-main/src/renderer/subwindow/windows/pwa-install.js` | 安装确认框 | ✅ |
| 36 | `apps/app-main/src/pages/apps/*` | 管理页三件套 | ✅ |
| 37 | `apps/app-main/src/main/app-menu.js` | 菜单入口 | ✅ |
| 38 | `apps/app-main/package.json` | 依赖两个新包 | ✅ |

### P6 · 更新 / 卸载 / 收尾

| # | 文件 | 动作 | 状态 |
| --- | --- | --- | --- |
| 39 | `apps/app-main/src/main/pwa/updater.js` | 24h 检查 + 应用更新 | ✅ |
| 40 | `apps/app-main/src/main/pwa/uninstall.js` | 卸载编排 + 失败汇总 | ✅ |
| 41 | `apps/app-main/src/main/main.js` | 启动后 30s 触发更新检查 | ✅ |
| 42 | 全链路自检 | 安装 / 启动 / 冷启动 / 卸载 / 更新 | ✅ |

> **实施完成**：P1–P6 全部落盘，`pnpm build` 通过。后续扩展按 §16 预留接口接入，无需改动本清单。

---

## 16. 扩展点（本期不做，但接口先留好）

| 扩展 | 预留位置 | 将来怎么接 |
| --- | --- | --- |
| **新安装适配器**（如"安装为快捷方式"以外的类型） | `install.js` 的 `installPipeline` 按 `install_kind` 分派 | 加一个 `installers/<kind>.js`，注册表驱动 |
| **新快捷方式平台** | `infra-pwa/src/shortcut.js` 的 driver 表 | macOS 加 `shortcut-darwin.js`（`.app` 别名 + `LSUIElement`），Linux 加 `.desktop` |
| **per-app session 隔离** | `pwa_apps.session_partition` + `buildTabWebPreferences({ session })` | 安装时生成 `persist:pwa-<appId>`，窗口创建处按字段取 session |
| **`file_handlers`** | `manifest_json` 已存全量 | 加 `main/pwa/file-handlers.js`，在 `app.whenReady` 注册 `open-file` → 路由到对应应用窗 |
| **`protocol_handlers`** | 同上 | 用 `app.setAsDefaultProtocolClient` + argv 解析，复用 `pwa-args` 的模式 |
| **`share_target`** | 同上 | 安装时写注册表项，接收 `--share-target` 参数转成 POST |
| **`badging`** | `pwa_apps` 加 `badge_count` | Windows 用 `win.setOverlayIcon()`（不是真角标，如实标注） |
| **`display_override` / `launch_handler`** | `manifest.js#normalizeManifest` 的产出对象 | 加字段 + `window.js` 读取，不改调用方 |
| **插件侧扩展** | `pwa-service` 的 capabilities | 新能力直接加 key，provider id 自动生成 |

---

## 17. 已知坑与降级

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| **dev 态快捷方式启动失败** | 双击 `.lnk` 只开 Electron 空壳 | `target = process.execPath`，`args` 首位必须是 appRoot；`buildPwaArgs` 用 `app.isPackaged` 分支 |
| **任务栏出现两个图标** | 快捷方式 AUMID ≠ `setAppDetails.appId` | 两者由同一个 `makeAumid(appId)` 生成，禁止各写各的 |
| **`setAppDetails` 在窗口未创建时调用无效** | 无报错但分组不生效 | 必须在 `win` 创建后、`show()` 前调用 |
| **隐藏主窗导致进程不退出** | 关掉应用窗后进程常驻 | `pwaOnlyMode` + 应用窗 `closed` 事件显式 `app.quit()` |
| **冷启动读不到 profile** | 应用窗用了 default 库 | 必须在 L986-1012 分支里 `spaceRuntime.setCurrent`，且 `pwaRuntime.open` 晚于 `registerCoreIpc` |
| **协议请求拿不到 profile** | 图标 404 | `hira-pwa://` URL 必须带 `?p=<profileId>` |
| **图标是 SVG 时 `nativeImage` 缩放失败** | 图标空白 | SVG 直接当 `icon_path` 用，不参与 PNG/ICO 生成；ICO 回落默认图标 |
| **manifest 的 `start_url` 指向登录页** | 打开应用要求登录 | 正常现象；登录后留在 scope 内即可，不做特殊处理 |
| **站点改版后图标 404** | 管理页裂图 | 图标本地落盘，不热链；更新检测时才重下 |
| **已固定到任务栏的项删不掉** | 卸载后任务栏仍有一个死图标 | Windows 限制，UI 明确提示"请手动取消固定" |
| **多 profile 同名应用** | 快捷方式同名覆盖 | 快捷方式名追加 profile 名或序号，`sanitizeShortcutName` 后唯一化 |
| **`beforeinstallprompt` 不存在** | 无法复用浏览器安装 UI | 本文 §6/§7 自建；不要尝试注入 polyfill |
