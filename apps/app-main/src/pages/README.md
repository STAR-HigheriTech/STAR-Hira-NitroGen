# pages/ —— hira:// 内部页

这里放**所有** `hira://<host>` 内部页面的真实文件。协议层只负责分发，页面内容全部在本目录。

## 目录约定

```
pages/
├─ _shared/           公共层（不是页面，hira:// 下以 shared 别名暴露）
│   ├─ base.css           页面骨架：reset / body / h1 / toolbar / btn / list / row / empty
│   │                     ＋页头与分区原语：page-header / page-heading / page-sub / section / section-title
│   │                     ＋卡片与定义网格原语：card / card-title / def-grid
│   ├─ runtime.js         ESM 公共运行时：rpc() el() renderEmpty() fmtTime() fmtSize() faviconUrl()
│   ├─ icons.js           统一内部页图标（SVG）
│   ├─ shell-registry.mjs 左侧导航视图模型（从 pages.mjs 投影，不维护页面清单）
│   ├─ shell.js           导航挂载器（由 runtime.js 求值时调用一次）
│   ├─ tabs.js            分段选项卡控制器（一份实现，各页只写结构）
│   ├─ disclosure.js      折叠组唯一实现（cookies / 密码 / 扩展…共用）
│   ├─ bookmarks-client.js 书签页共享客户端
│   ├─ app-icon.png       关于 / 引导页的品牌图标
│   └─ （构建期同步）ipc-channels / permission-labels / extension-labels / download-view /
│       format-size / favicon-src / file-icon / theme-background / form-fill / automation /
│       space-icon / page-icon / keybindings / search-url / search-engines / layout /
│       settings-groups / pages / commands 等 .mjs —— 真源在 packages/shared-types，
│       登记在 electron.vite.config.js#SHARED_PAGES_MODULES，**不要在页面里手抄一份**
├─ <host>/            一个目录 = 一个页面 = hira://<host>
│   ├─ index.html
│   ├─ <host>.css     页面特有规则（后加载，可覆盖 _shared/base.css）
│   └─ <host>.js      页面脚本（ES module）
└─ ...
```

## 当前页面清单（与目录实况一致）

浏览器内置功能页（33 个，与目录实况一致）：

| host           | 说明                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `newtab`       | 新标签页                                                                     |
| `bookmarks`    | 书签管理                                                                     |
| `history`      | 历史记录                                                                     |
| `downloads`    | 下载管理                                                                     |
| `apps`         | 已安装应用（应用窗口 / 快捷方式 / 开机启动 / 更新与卸载）                     |
| `sessions`     | 会话管理（保存 / 恢复标签集，追加打开）                                      |
| `passwords`    | 密码管理                                                                     |
| `formfill`     | 地址与支付卡（本地加密存储，列表只显示掩码）                                 |
| `cookies`      | Cookie 明细                                                                  |
| `clear-data`   | 清除浏览数据                                                                 |
| `permissions`  | 站点权限                                                                     |
| `profiles`     | 配置文件（Profile）管理 + Profile 内 Space 列表                              |
| `spaces`       | 空间（Space）管理                                                            |
| `extensions`   | 扩展管理                                                                     |
| `certificates` | 来源站点完整证书链、本会话证书快照与证书校验失败记录                         |
| `crash-report` | 崩溃报告                                                                     |
| `page-info`    | 页面信息                                                                     |
| `automation`   | 自动化（命令链 / 鼠标手势）                                                  |
| `shortcuts`    | 键盘快捷键（录制 / 恢复默认，真源 `keybindings.mjs`）                        |
| `color-picker` | 颜色选择器                                                                   |
| `task-manager` | 任务管理器                                                                   |
| `print-preview` | 打印预览（纸张 / 方向 / 缩放，输出走 `webContents.print`）                  |
| `share`        | 分享页（二维码 + 链接，`hira://share?url=`）                                 |
| `games`        | 游戏库（游戏本体在 `external/games/`，走 `hira-game://`）                    |
| `about`        | 关于 Hira（含「软件更新」选项卡，不再有独立的更新页）                        |
| `settings`     | 设置（文件式内部页，非独立渲染窗口）                                         |
| `onboarding`   | 首次启动引导（OOBE，固定暗色、自带整屏布局）                                 |
| `import-data`  | 导入数据                                                                     |
| `view-source`  | 查看源代码                                                                   |
| `error`        | 网络/加载错误页                                                              |
| `pdf`          | 内置 PDF 查看器                                                              |
| `jsdialog`     | JS 对话框（alert/confirm/prompt）宿主页                                      |
| `http-auth`    | HTTP Basic / 代理认证弹窗页（窗口类型 `HTTP_AUTH`，非 modal、FIFO 一次一个） |

> 新增页面零改协议层：`main/hira-protocol.js` 会扫描 `out/pages/` 自动注册（`_` 开头目录除外）。

## 新增一个内部页

1. 建目录 `pages/<host>/`，放 `index.html` + `<host>.css` + `<host>.js`。
2. `index.html` 引用公共层：
   ```html
   <link rel="stylesheet" href="hira://shared/base.css" />
   <link rel="stylesheet" href="./<host>.css" />
   <script type="module" src="./<host>.js"></script>
   ```
3. 脚本里用公共运行时，不要直接摸 `window.hira`：
   ```js
   import {
     rpc,
     el,
     renderEmpty,
     faviconUrl,
     fmtTime,
     fmtSize,
   } from 'hira://shared/runtime.js';
   const items = await rpc('history:list', { limit: 200 });
   ```
4. **不需要改协议层**。`main/hira-protocol.js` 会扫描 `out/pages/` 自动注册
   （`_` 开头的目录除外），所以新增页面零代码改动即可访问 `hira://<host>`。

要注册一个「无法文件化」的动态页（按请求参数生成 HTML），调用：

```js
const { registerHiraPage } = require('./hira-protocol')
registerHiraPage({ host: 'foo', kind: 'dynamic', resolve: (url) => new Response(...) })
```

## 页面图标（favicon）—— 构建期统一注入，真源一份

每个内部页的 `index.html` 里都会有一行**由构建期注入**的图标声明（源码里搜不到，`out/pages/<host>/index.html` 里能看到）：

```html
<link rel="icon" href="hira://page-icon/?p=<host>" />
```

三条链路各管一段，**任何一段都只此一份**：

| 环节 | 在哪 | 说明 |
| ---- | ---- | ---- |
| host → 字形名 → 路径数据 | `packages/shared-types/src/page-icon.mjs` | **唯一真源**。字形照搬 rail / navbar（`ui-common#ICON_REGISTRY`）与 `pages/_shared/icons.js` 的同一份路径数据；项目里没有的字形取 Lucide 官方，不自己画 |
| 声明注入 | `electron.vite.config.js#injectPageIcon` | 落盘那一刻按 `pages/<host>/index.html` 注入（与 `rewriteSharedSpecifiers` 同一支插件、同一个时机）。页面**自己**写了 `link[rel=icon]` 就不动它 |
| 字节 | `main/hira-protocol.js#servePageIcon` | `hira://page-icon/?p=<host>` 现算现吐 SVG；未知 host 退兜底字形，**绝不 404** |

所以要**换某一个页面的图标**，只改 `page-icon.mjs` 里那一行（页面一行不动）；新增页面忘了登记也只是退到兜底字形，不会没有图标。

图标长这样：**黑字形 + 白底块**，而且**白底块画在图里**（和站点图标那种「CSS 白底 + 内边距」不同）：

- 为什么白底要画进图里：图片内容会被 Chromium 吸附到设备像素，CSS 背景不会 —— 两者最多差 1 个设备像素。站点图标的墨迹本来就铺满整格，看不出来；内部页是「线性字形 + 一圈白边」，那点偏移会被放大成"图形不在正中、有点偏右上"。放进同一张位图，相对位置就由构造保证。
- 因此渲染侧对这类图标**不再套 CSS 白底**（ui-tabbar 的 `[src^="hira://page-icon"]` 规则、`tabRowList` 的 `isPageIconUrl` 分支，盒子仍是 20x20，布局零变化）。
- 判据只有一份：`isPageIconUrl()`（与 `pageIconUrl()` 同一文件）。

- **不要**在页面目录里再放 `.svg`：那会立刻退化成"每个页面各画一份美术"，换个字形要改 N 个文件。
- 想让某一页用**完全自定义**的图标：在它自己的 `index.html` 里写 `link[rel=icon]`，注入会被跳过（作者意图优先）。

## 游戏库（`hira://games`）与外部 bundle（`hira-game://`）

`pages/games/` 是游戏库页面。**游戏本体不在这里**，它们属于「第三方静态 bundle」，
放在 `apps/app-main/src/external/games/`，由**另一条协议** `hira-game://` 承载。

```
apps/app-main/src/
├─ pages/games/                  ← 游戏库（我们自己的页面，hira://games）
│   ├─ index.html  games.css  games.js
└─ external/games/               ← 第三方 bundle（hira-game://<id>/）
    ├─ dino/     game.json + 上游原样文件…
    ├─ surf-v1/  game.json + …
    └─ surf-v2/  game.json + …
```

为什么要分成两条协议？见 `main/external-games/` 顶部注释，一句话版本：
**来源与权限都不同**。游戏是上游第三方代码，不能和内部页共享 origin，
更不能拿到 `window.hira` 这条直通主进程 domain 路由的 IPC 桥。

### 新增一个游戏（插件点）

1. 建目录 `external/games/<id>/`，把上游 bundle 原样丢进去。
2. 写一个 `game.json`（**只有 `name` 是必填**）：
   ```json
   {
     "id": "dino",
     "name": "Chrome 恐龙",
     "category": "经典",
     "icon": "🦖",
     "description": "……",
     "accent": "#9aa4b2",
     "tags": ["跑酷"],
     "entry": "index.html",
     "variants": [
       { "name": "奥运 · 跨栏", "entry": "1_hurdling.html", "icon": "🏃" }
     ],
     "source": "yell0wsuit/chrome-dino-enhanced",
     "license": "BSD-3-Clause"
   }
   ```
3. **不需要改任何代码**。主进程 `external-games/catalog.js` 会扫描
   `out/external/games/*/game.json` 生成目录，游戏库页通过 `game:list`
   渲染卡片，点击即以 `hira-game://<id>/<entry>` 在新标签打开。

约束（照着做能少踩坑）：

- bundle 内部资源请用**相对路径**（`icons/x.png`，不要 `/icons/x.png`）。
- 新增的资源扩展名要登记进 `electron.vite.config.js` 的 `COPY_EXTS`。
- 上游若引外链（CDN / 统计脚本），移植时**一律剥离** —— 这是离线浏览器。
- 上游缺失的 `manifest.json` / `appmanifest.webmanifest` 之类引用直接删掉，避免 404 噪音。

## 公共层使用纪律（宪法 C02：UI 像素一致性优先）

`_shared/base.css` 只放**各页面取值完全一致**的原语。任何页面若有不同取值，
必须在自己的 `<host>.css` 里**显式覆盖**，包括容易被忽略的 `cursor` 和 `:hover`
—— 例如 downloads / profiles 的行是不可点击的，就显式写了
`cursor: default` 与 `.row:hover { background: #fff; }`，否则会继承公共层的
`cursor: pointer` / hover 高亮，造成样式漂移。

`.card` 是「**有内边距的信息卡**」，卡片叠放间距由 `.card + .card` 统一给
（**不要**再各写 `margin-bottom` —— flex 列表里外边距不塌陷，会与 gap 叠加成双倍间距）。
若某页需要的是「**无内边距、由头/分区/脚各自负责内边距的复合卡片**」
（如 spaces 的 `profile-card`），**另起类名**，不要复用 `.card` —— 会被骨架的
`padding` 撑破内部结构。

## 已知注意事项

- **静态资源要进构建白名单**：`electron.vite.config.js` 的 `COPY_EXTS` 决定哪些
  扩展名会被拷到 `out/`。往 `pages/` 里放新类型的资源（如 `.mp4`）必须先登记，
  否则运行时 404。
- **跨 host 引用靠响应头**：`hira://<host>` 页面 import `hira://shared/*` 属跨源，
  协议层给静态响应加了 `Access-Control-Allow-Origin: *` 才能通过。不要去掉这个头。
- **内置动态路由**（由协议层注册、不在本目录）：`hira://pdfjs/*`（pdfjs-dist 产物）、
  `hira://favicon/?url=`（站点图标字节代理，供渲染层安全取色）、
  `hira://extension-icon?id=`（扩展清单图标）、`hira://page-icon/?p=`（内部页自己的图标）。
  它们的真源都在 `packages/shared-types/src/` 下的纯数据模块里。
- **应用桥按协议白名单注入**：`infra/infra-window/preload/tab-preload.js` 里
  `APP_BRIDGE_SCHEMES` 决定哪些协议能拿到 `window.hira` / `__jsDialogBridge`。
  默认拒绝 —— `hira-game://` 不在名单里，所以游戏拿不到应用桥。
  新增「外部 bundle 协议」时不需要改这里，保持默认拒绝即可。
- 内部页作为普通标签打开时挂的是完整的 `tab-preload`（含密码自动填充）。
  自动填充只对 `http:` / `https:` 生效，内部页不受影响。
- **新增自定义协议必须登记到协议注册中心**（否则点链接会被补成 `https://` → DNS 失败）：
  `TabManager#normalizeUrl()` 要把「用户输入的裸域名」补成 `https://`，靠
  `infra/infra-window/src/url-schemes.js` 的注册中心判断「这已经是完整 URL」。
  新协议在自己的 `registerXxxScheme()` 里调一次 `registerUrlScheme('<scheme>')` 即可，
  别去改 `infra`（依赖方向是反的）。
  真实事故：`hira-game://` 漏登记 → 点游戏卡片变成
  `https://hira-game//dino/index.html` → `ERR_NAME_NOT_RESOLVED (-105)`。
  回归脚本：`scripts/verify-tab-nav.cjs`。
- **`out/main/index.js` 只是薄启动器**：本地 `require('./hira-protocol')`、
  `require('./external-games')` 都**保持外置**（不被打包内联），
  所以运行时这些模块的 `__dirname` 就是它们在 `out/main/` 下的真实位置
  （`out/main` 或 `out/main/external-games`）。定位 `out/` 下资源时按此推算。
