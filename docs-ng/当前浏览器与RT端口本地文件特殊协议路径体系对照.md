# 当前浏览器与 RT：端口、本地文件、特殊协议、特殊页面与路径体系对照

> 分析日期：2026-11-18  
> NG：`E:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG`  
> RT：`E:/Desktop/OTHER/1A-STAR_Hira_RT`

## 0. 范围与事实边界

本文只对照两套代码的实现差异，以及已经直接观察到的页面行为。

明确事实：

- NG 中 `http://127.0.0.1:4173/higheripe.html` 当前没有正确显示页面内容；
- NG 的开发者工具目录、文件名和磁盘真实目录不能一一对应，存在缺项和名称不一致；
- 此前把隔离测试结果当成 NG 实际页面已修复，属于错误结论；
- 此前对白屏原因作出的推断不写入本文，除非有直接可验证证据。

本文不把以下内容当结论：

- “Sources 只显示 assets，所以访问只允许 assets”；
- “隔离窗口能加载，所以实际 NG 已正常”；
- “白屏一定由某个单独模块造成”；
- 未经 RT 实际运行验证的行为推断。

## 1. 直接观察到的 NG 状态

### 1.1 页面

实际 NG 标签页打开：

```text
http://127.0.0.1:4173/higheripe.html
```

地址栏、标签标题、历史记录能识别该 URL，但网页内容没有正确显示。

### 1.2 开发者工具

实际 DevTools 中看到的是 URL/调试资源命名空间，例如：

```text
127.0.0.1:4173
├─ assets
│  ├─ main.js
│  └─ style.css
└─ higheripe.html
```

而对应磁盘目录存在：

```text
STAR-HigheriTech/dist
├─ index.html
├─ products/higheripe/index.html
├─ products/hira/index.html
├─ images
└─ assets/images
```

两者的目录层级、入口文件和显示文件不同。该差异已确认存在。

### 1.3 本文不补充原因判断

目前不把以下任一现象单独认定为根因：

- Vite 或静态服务器 fallback；
- rewrite；
- source map；
- WebContentsView 尺寸；
- 协议注册；
- 文件/端口访问限制；
- 页面脚本、CSS 或布局初始化。

这些只能作为后续验证项，不能代替对照事实。

## 2. 端口页面

### 2.1 RT

RT 主进程外部 URL 入口：

```text
src/main/app/urls.ts
```

只接受：

```text
http:
https:
```

RT 地址栏 URL 判断：

```text
src/renderer/src/lib/omnibox-new/helpers.ts
```

行为：

- 显式 scheme 原样使用；
- `localhost`、IPv4 使用 `http://`；
- 普通域名使用 `https://`；
- 最终 URL 直接交给 `WebContents.loadURL()`。

RT 没有把普通 HTTP 页面转换为自定义协议。

### 2.2 NG

NG 有两层入口归一：

```text
ui/ui-searchbar/src/core/navigation.ts
ui/ui-searchbar/src/suggestors/verbatim.ts
infra/infra-window/src/tabUrl.ts
```

行为：

- localhost、IPv4、`[::1]`、`0.0.0.0` 使用 `http://`；
- 普通域名使用 `https://`；
- `http:/`、`https:/` 修正为标准双斜杠；
- 文件路径和 `file:/` 修正为标准 file URL；
- 普通端口 URL 仍直接交给 `WebContents.loadURL()`。

NG 没有为端口 URL 添加自定义协议。

### 2.3 差异表

| 项目 | RT | NG |
| --- | --- | --- |
| localhost/IPv4 | HTTP | HTTP |
| 普通域名 | HTTPS | HTTPS |
| 主进程外部 URL | 仅 http(s) | http(s) 与关联文件 |
| 地址归一位置 | Omnibox 为主 | Omnibox + TabManager |
| 端口页面 URL 转换 | 无 | 无 |
| 当前实际页面显示 | 未在本次对照中运行验证 | 已观察为未正确显示 |

## 3. 本地文件

### 3.1 RT

RT 主进程 URL 入口只允许 http(s)。

RT 默认程序注册表模板声明了：

```text
.htm .html .mhtml .shtml .xhtml .xhtm .pdf
```

模板注册的命令会传入 `%1`，但主进程 URL 入口 `isValidOpenerUrl()` 不接受 file
协议或本地路径。

RT Omnibox 的显式 scheme 判断会把 `file:///...` 当作 URL 原样保留，但这不是
系统文件关联入口。

RT 代码中没有：

- 本地文件打开策略层；
- 文件拖入后按类型分类的 service；
- 本地文件打开失败后统一回退系统程序的逻辑；
- 任意本地 HTML 站点根协议。

### 3.2 NG

NG 当前使用 Chromium 原生 `file://`，没有 `hira-local` 或其他本地站点转发协议。

主要入口：

```text
apps/app-main/src/main/app/urls.ts
apps/app-main/src/main/file-open/policy.ts
apps/app-main/src/main/file-open/service.ts
apps/app-main/src/main/file-open/navigation-guard.ts
infra/infra-window/preload/file-drop/index.ts
```

NG 行为：

- `file://` URL 进入标签页原生加载；
- 系统关联的绝对路径通过 `pathToFileURL()` 转换；
- 普通命令行只接受登记过的文件扩展名；
- `--open-associated` 允许系统关联送来的路径进入文件分类；
- 文件由 policy 分为 tab、external、reveal；
- 支持的文件在标签页打开；
- 不支持或打开失败的文件回退系统默认程序；
- 拖入目录走系统文件管理器，不在网页中生成目录列表。

### 3.3 差异表

| 项目 | RT | NG |
| --- | --- | --- |
| `file://` 地址栏导航 | Omnibox 可保留显式 URL | 原生 file URL |
| 主进程外部 file URL | 拒绝 | 接受 |
| 文件关联入口 | 注册表声明，主进程入口未完整消费 | 完整进入文件策略层 |
| 拖入文件 | 无同等策略模块 | preload + IPC + policy + service |
| 本地站点自定义协议 | 无 | 当前无 |
| 任意目录浏览页 | 无 | 无 |

## 4. Special Protocol 对照

### 4.1 RT

RT 在：

```text
src/main/controllers/sessions-controller/protocols/index.ts
```

登记：

```text
hx
hirax-internal
hirax-external
```

特权特点：

| scheme | standard | secure | fetch | service worker | stream |
| --- | --- | --- | --- | --- | --- |
| `hx` | 是 | 是 | 否 | 否 | 否 |
| `hirax-internal` | 是 | 是 | 否 | 否 | 否 |
| `hirax-external` | 是 | 是 | 否 | 否 | 是 |

RT Session 注册：

- Profile Session：`hx`、`hirax-external`；
- Default Session：`hx`、`hirax-internal`、`hirax-external`。

### 4.2 NG

NG 在：

```text
apps/app-main/src/main/scheme-privileges.ts
```

集中登记：

```text
hira
hira-game
hira-plugin
hira-theme
hira-pwa
```

用途：

| scheme | 用途 |
| --- | --- |
| `hira` | 内部页面、共享资源、favicon、扩展图标、归档内容 |
| `hira-game` | 游戏 bundle |
| `hira-plugin` | 插件页面和插件资源 |
| `hira-theme` | 用户主题图片和视频 |
| `hira-pwa` | PWA 图标 |

### 4.3 差异表

| 项目 | RT | NG |
| --- | --- | --- |
| 协议总数 | 3 个自定义 scheme | 5 个自定义 scheme |
| 协议表位置 | protocols/index.ts | scheme-privileges.ts |
| 第三方静态 bundle | `hirax-external` | `hira-game` |
| 插件页面协议 | 无独立协议 | `hira-plugin` |
| 主题资产协议 | 无独立协议 | `hira-theme` |
| PWA 资产协议 | 无独立协议 | `hira-pwa` |
| 内部页与外部 bundle 隔离 | 协议级隔离 | 协议级隔离 |

## 5. 特殊页面

### 5.1 RT

页面由固定 host 表映射：

```text
hirax-internal://main-ui
hirax-internal://popup-ui
hirax-internal://settings
hirax-internal://omnibox
hirax-internal://onboarding

hx://new-tab
hx://error
hx://about
hx://games
hx://omnibox
hx://extensions
hx://history
hx://bangs
hx://pdf-viewer
```

静态 domain 配置：

```text
src/main/controllers/sessions-controller/protocols/static-domains/config.ts
```

路由型页面映射：

```text
host -> route-<routeName>.html
```

外部 bundle 映射：

```text
hirax-external://dino.chrome.game -> chrome-dino-game/
hirax-external://v1.surf.edge.game -> edge-surf-game-v1/
hirax-external://v2.surf.edge.game -> edge-surf-game-v2/
```

直接请求 `route-*.html` 会被拒绝。

### 5.2 NG

NG 页面路径由 `pageUrl()` 生成，页面目录位于：

```text
out/pages/<host>/
```

常见页面：

```text
hira://newtab
hira://settings
hira://history
hira://downloads
hira://bookmarks
hira://pdf
hira://error
```

NG 页面注册方式：

- 静态页面按 `out/pages` 子目录发现；
- 动态页面通过 `registerHiraPage()`；
- 插件贡献页面通过 `hira-plugin://`；
- 游戏通过 `hira-game://`。

### 5.3 名称与映射差异

| 项目 | RT | NG |
| --- | --- | --- |
| host 来源 | 固定表 | 页面注册表/目录发现 |
| route 名 | 固定 `route-*.html` | host 对应页面目录 |
| host 与入口文件名 | 明确解耦 | 默认按 host 与目录同名 |
| 大小写 | host 比较小写化 | host 强制小写、ASCII 正则 |
| 别名 | 固定表可直接表达 | 依赖页面描述符或额外注册 |

## 6. 路径处理

### 6.1 RT

文件：

```text
src/main/controllers/sessions-controller/protocols/static-domains/serve-static.ts
```

处理顺序：

1. 正则拒绝独立的 `..`；
2. `pathStr.split("/")`；
3. 每个组件执行 `trim()`；
4. 过滤空组件；
5. 目录请求再次追加 `index.html`；
6. `path.join(basePath, ...pathComponents)`；
7. `stat`；
8. 文件读取并按扩展名返回 MIME。

开发态另有一次 dev server 转发。

RT 静态域没有对每个结果执行 `realpath` 二次校验，也没有统一扩展名允许列表。

### 6.2 NG

通用静态路径文件：

```text
apps/app-main/src/main/static-serve.ts
```

处理顺序：

1. `decodeURIComponent(pathname)`；
2. `/`、空串映射到 `index.html`；
3. `path.normalize`；
4. 移除前导 `../`；
5. `path.resolve(baseDir, relative)`；
6. 前缀判断必须位于 baseDir；
7. 读取前执行 root 与目标 `realpath`；
8. 再次判断目标位于真实 root 内；
9. 文件大小、MIME、缓存和响应头由具体调用方补充。

插件协议另有：

- 根目录 realpath 守卫；
- 扩展名白名单；
- 单文件大小限制；
- HTML/XAML CSP；
- Range、ETag、缓存控制。

### 6.3 路径行为差异

| 项目 | RT | NG |
| --- | --- | --- |
| URL 解码 | 静态域依赖框架/路径字符串 | 明确 `decodeURIComponent` |
| 路径段空格 | `trim()`，会修改名称 | 不 `trim()` |
| 大小写 | host 小写比较 | Windows 比较归一，host 小写 |
| 目录穿越 | `..` 正则检查 | resolve + 真实路径前缀检查 |
| 符号链接守卫 | 无统一 realpath 检查 | 有 |
| 目录自动 index | 有 | 根路径有，任意子目录由调用方决定 |

## 7. 文件名与目录名

### 7.1 RT

RT 的名称关系：

```text
固定 host 名
固定 route 名
固定 route-*.html 入口名
固定外部 bundle 子目录名
```

因此 React 页面文件名不要求与 URL 完全同名，但新增页面必须同时修改固定名称表。

文件名大小写、空格和中文路径没有统一的“显示名/内部名/磁盘名”描述符。

### 7.2 NG

NG 的名称关系：

```text
page host
页面标题
out/pages 目录名
入口 index.html
插件 id
插件入口相对路径
游戏 bundle id
游戏资源相对路径
```

当前问题：

- `hira://` host 只允许小写 ASCII host 正则；
- 静态页面目录扫描默认使用目录名作为 host；
- 插件 ID、游戏 ID、host 都可能被小写化；
- UI 显示名不参与 URL 解析；
- 页面标题、目录名、入口文件名没有统一别名描述符；
- source map、fallback 和 HTTP rewrite 可继续改变 DevTools 中看到的名称。

结论只写到事实层：

- RT 的名称由固定表显式控制；
- NG 的名称来源分散在目录扫描、协议检查、插件 ID 和 URL 生成中；
- NG 当前实际存在 DevTools 目录、文件和磁盘不一致。

## 8. URL 与路径关联

### 8.1 RT

RT 系统关联声明：

```text
http
https
.htm
.html
.mhtml
.shtml
.xhtml
.xhtm
.pdf
```

RT 注册表模板会把 `%1` 传给应用。

RT 主进程 URL 入口只接受 http(s)，因此文件关联的 `%1` 没有在 URL 路由中完整消费。

### 8.2 NG

NG 的关联清单：

```text
packages/shared-types/src/associations.ts
```

内容包括：

- document/media 文件类型分层；
- URL 协议；
- 运行期 association contribution；
- 注册表计划；
- 安装器与运行时共用清单；
- `--open-associated` 命令行入口；
- Windows UserChoice 接管与回读。

NG 的文件关联与命令行消费形成完整链路。

## 9. 目录

### 9.1 RT

- 静态域请求目录时追加 `index.html`；
- 没有通用目录浏览页；
- 没有本地目录拖入分类层；
- 外部 bundle 使用固定子目录。

### 9.2 NG

- `hira://` 的 `/` 映射到 `index.html`；
- 通用静态服务原语不会对任意子目录无条件追加 `index.html`；
- 文件拖入目录时交给系统文件管理器；
- 没有通用本地目录浏览页；
- 页面的目录与 URL 之间没有单独的可视化映射面板。

## 10. 完整差异总表

| 项目 | RT | NG |
| --- | --- | --- |
| 端口 URL | 原生 http(s) | 原生 http(s) |
| 当前 NG 端口页面显示 | 本次未验证 | 未正确显示 |
| 本地 file URL | 主进程外部入口拒绝 | 原生 file URL |
| 本地文件策略层 | 无 | 有 |
| 本地文件拖入 | 无同等模块 | 有 |
| 本地文件关联命令行消费 | 不完整 | 完整 |
| 本地站点自定义协议 | 无 | 当前无 |
| 自定义协议数量 | 3 | 5 |
| 内部页面 host | 固定表 | 注册表/目录发现 |
| 内部页入口名 | 固定 `route-*` | 默认 `index.html` |
| 路径段处理 | `trim()` | 不 `trim()` |
| realpath 符号链接守卫 | 静态域无统一实现 | 有 |
| 目录自动 index | 是 | 根路径是，子目录依调用方 |
| 文件/协议关联 | 固定声明 | 动态贡献 |
| 关联状态回读 | Windows 固定 false | 真实 UserChoice 回读 |
| DevTools 目录与磁盘目录 | 源码没有自动枚举磁盘目录的实现 | 实际已观察到不一致 |
| 当前映射诊断 | 固定表可人工推导 | 无单独资源映射诊断 |

## 11. 源码索引

### RT

- `src/main/app/urls.ts`
- `src/main/app/instance.ts`
- `src/main/controllers/default-browser-controller/`
- `src/main/controllers/sessions-controller/protocols/index.ts`
- `src/main/controllers/sessions-controller/protocols/static-domains/`
- `src/renderer/src/lib/omnibox-new/helpers.ts`

### NG

- `infra/infra-window/src/tabUrl.ts`
- `infra/infra-window/src/tabEvents.ts`
- `apps/app-main/src/main/app/urls.ts`
- `apps/app-main/src/main/file-open/`
- `apps/app-main/src/main/scheme-privileges.ts`
- `apps/app-main/src/main/hira-protocol.ts`
- `apps/app-main/src/main/static-serve.ts`
- `apps/app-main/src/main/plugin-protocol.ts`
- `apps/app-main/src/main/theme-asset-protocol.ts`
- `apps/app-main/src/main/hira-pwa-protocol.ts`
- `apps/app-main/src/main/app/default-client.ts`
- `packages/shared-types/src/associations.ts`

## 12. 本轮已落地对齐

以下行为已按“RT 已有的对齐 RT，NG 新增的保留并适配”完成：

1. 公共页面名称向 RT 对齐：
   - 新标签页 canonical URL：`hira://new-tab`；
   - PDF 查看器 canonical URL：`hira://pdf-viewer`；
   - 旧 `hira://newtab`、`hira://pdf` 继续作为兼容入口。

2. 增加 RT 协议兼容入口：
   - `hx://...`；
   - `hirax-internal://...`；
   - `hirax-external://...`。

3. RT 协议入口映射到 NG 已有公共页面：
   - `hx://new-tab` → `hira://new-tab`；
   - `hx://error` → `hira://error`；
   - `hx://about` → `hira://about`；
   - `hx://games` → `hira://games`；
   - `hx://extensions` → `hira://extensions`；
   - `hx://history` → `hira://history`；
   - `hx://pdf-viewer` → `hira://pdf-viewer`；
   - `hirax-internal://settings` → `hira://settings`；
   - `hirax-internal://onboarding` → `hira://onboarding`。

4. RT 外部 bundle host 映射：
   - `hirax-external://dino.chrome.game` → `hira-game://dino`；
   - `hirax-external://v1.surf.edge.game` → `hira-game://surf-v1`；
   - `hirax-external://v2.surf.edge.game` → `hira-game://surf-v2`。

5. 目录路径行为向 RT 对齐：
   - 请求目标为目录时，静态服务尝试读取该目录的 `index.html`；
   - 仍保留 NG 的 realpath 与根目录越界检查。

6. NG 新增能力保留：
   - 本地文件打开策略与拖放；
   - `hira-plugin`；
   - `hira-theme`；
   - `hira-pwa`；
   - 动态文件/协议关联；
   - 更严格的路径、大小、CSP 与 MIME 限制。

7. 已验证：
   - `hx://new-tab` 可加载 NG 新标签页；
   - `hira://new-tab` 兼容入口可加载；
   - `hx://pdf-viewer` 可加载 NG PDF 查看器；
   - Electron/Vite 构建通过。

## 13. 白屏根因复盘：Chromium 全局 `gc` 污染

此前把白屏归因于页面高度、View bounds 或本地资源路径，这是错误判断，已撤回。

实际证据链：

1. NG 真实 DevTools 中页面 URL、标题和 `assets/main.js` 均已识别；
2. `main.js` 在首行报 `Uncaught SyntaxError: Identifier 'gc' has already been declared`；
3. 磁盘上的 `assets/main.js` 单独执行 `node --check` 通过，说明脚本自身没有重复声明；
4. 该压缩产物在顶层声明 `const gc = "-"`；
5. NG 启动时曾全局设置 `app.commandLine.appendSwitch('js-flags', '--expose-gc')`。
   Chromium 的命令行开关作用于整个应用进程组，渲染进程也被注入 V8 全局 `gc`；
6. 页面脚本的 `const gc` 与 V8 注入的全局绑定冲突，整份脚本在解析阶段失败，React 无法挂载；
7. 主流浏览器和 RT 没有该全局开关，因此同一页面正常。

这里的关键教训是：**DevTools 的 Sources 只展示实际加载并成功进入资源图的内容，不能拿它反推磁盘目录是否完整。** 白屏时主文档和 `assets` 已出现，但页面脚本因语法错误没有执行，目录树自然也不会反映完整运行结果。页面高度、布局 bounds 与本次白屏没有因果关系。

已修复：

- 移除 Chromium 全局 `--expose-gc`；
- 移除因此永久无效的 `global.gc()` 调用；
- 重新构建 `out/main`，确认产物中不再包含 `--expose-gc` 或 `js-flags`。

该修复必须完整退出并重启 NG 后才生效，刷新页面无法移除已经注入到渲染进程启动参数中的 V8 全局。

## 14. 同类全局污染排查结果

排查范围包括 Chromium 启动参数、页面主世界脚本、导航层钩子和网络请求钩子。

- 未再发现 `js-flags`、`--expose-gc`、`global.gc`、关闭 `webSecurity`、忽略证书错误或开放 Node 集成等进程级污染。
- 仅保留平滑滚动开关和 `disable-features=FedCm`。前者是用户设置，后者与 RT 一致；FedCM 登录集成不可用是已知取舍，不会导致页面脚本编译失败。
- JS 对话框桥会覆盖 `alert` / `confirm` / `prompt`，指纹伪装会覆盖 Navigator / Canvas / WebGL / Audio，二者都是显式产品能力；指纹伪装默认关闭。
- 登录凭据捕获曾用未包裹的 `var origSubmit` 改写 `HTMLFormElement.prototype.submit`，这是同类全局泄漏风险。

本次已把该补丁收进 IIFE，并保证通知消息异常不会阻断网站原生提交。主框架和 iframe 只在“询问是否保存密码”开启后才安装该补丁；设置关闭时既不捕获也不改写表单原型，设置热切换会同步生效。登录检测、自动填充、保存提示以及开启状态下的捕获时机均未改变。

