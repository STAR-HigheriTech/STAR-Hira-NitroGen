# STAR Hira NG · PART 9

## 为什么不在现有基础改（5 个结构性死局）

## + 全功能保真 5 级锁（细小功能也不丢、原版体验 1:1）

## + 底层 7 换 / 体验 8 不换 清单

生成时间: 2026-01-04
前置: PART1 (耦合扫描) + PART8 (逐周执行计划)

---

=========================================
⚠️ 【零号防误读声明 · 请任何人和模型先读本节】⚠️
"完全大重构重写 + 不耦合不依赖原本" 到底是什么意思？
—— 说清边界，保证不误解。
=========================================

定义（必须严格遵守，任何后续章节不得突破此定义）：
「原本」 = v7.5.0 仓库里 **旧系统团队自行编写的业务代码 / 构建脚本 / 全局函数 / 自写存储胶水 / 自写 IPC 路由**
（package.json standard.globals 里列的 66 个全局函数：tabs / settings / filterPopups / createPrompt /
createWindow / placesWindow / showFocusModeDialog1/2 / 等）+ 6 套 build*.js 自定义拼接脚本 + main/js/pages/parts 下所有自写 HTML 零件、CSS、组件
「npm 第三方库」= package.json dependencies / devDependencies 中的第三方包，与上面严格区分。

✅ 不耦合 / 不依赖的唯一对象 = 上面定义的「原本」：

- NG 43 个包**不 import 旧系统任何一行自写代码**
- NG 不调用任何旧系统全局函数、不碰旧系统存储路径、不 require 旧系统模块
- NG 的 PluginRegistry、Provider-Service、WindowFactory 全部新写，不继承原本
  → 这才叫"大换血"，不留下任何耦合根。

❌ **绝对不包括 npm 第三方库！ npm 行为敏感库不但保留，还锁同版本。**
插件兼容（electron-chrome-extensions）、弹窗拦截（@ghostery/adblocker-electron）、
PDF 查看（pdfjs-dist）、离线翻译（bergamot）、拖拽手感（sortablejs/dragula）、
地址栏模糊打分（quick-score）—— 这些库，行为一变用户手感就变，重写它们等于重写浏览器功能。
→ 下面给出 **A/B/C 三档依赖分类**，A 档全保留，B 档全重写，C 档明确替换。

→ 简单记：**旧代码一刀不碰，npm 库照用，存储/Dexie 只在结构原因替换不在库原因替换。**

=========================================
9.0 第三方依赖三档分类（防误读配套精确表，按 v7.5.0 package.json 25 个 deps + 12 个 devDeps）
=========================================

数据来源: 旧系统 package.json dependencies + devDependencies 全量盘点。

--- 【A 档：原样保留 + 锁同版本，完全不重写（~70% 依赖）】

# 这些直接决定插件兼容性、拦截行为、搜索排序、拖拽手感等—— 换 = 体验变 = 保真失败。

# 下面每一个都在 NG package.json 继续出现，且版本号与 v7.5.0 一致或次补丁兼容。

| npm 包                                         | 管什么                               | 为什么必须留（不能重写 / 不能换别的库）                                                           |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| electron-chrome-extensions@4.9.4               | Chrome 扩展 API 兼容层               | 几百个 chrome.tabs / chrome.bookmarks / chrome.storage 等 API 实现；重写 = 重做 Chromium 扩展平台 |
| electron-chrome-web-store                      | 扩展安装流程 + Chrome Web Store 集成 | 配套扩展系统                                                                                      |
| electron-chrome-context-menu@1.1.0             | 扩展自定义右键菜单渲染               | 配套扩展系统                                                                                      |
| @ghostery/adblocker-electron@^2.18.2           | 广告拦截 + 弹窗拦截规则引擎          | @browsermt 规则引擎，不是自写的拦截逻辑；重写 = 重写 Easylist 百万条规则匹配器                    |
| castlabs electron 43.2.0+wvcus (devDependency) | Widevine DRM 版 Chromium 运行时      | Netflix / Spotify / 影视 DRM 能播全靠它；**不是官方 npm 的 electron**                             |
| pdfjs-dist                                     | PDF 查看器（带 UI）                  | Mozilla 的 PDF 渲染引擎；重写 = 重做 PDF                                                          |
| @browsermt/bergamot-translator                 | 页面离线翻译（WASM 模型）            | 翻译模型 + 分词，重写不可能                                                                       |
| quick-score@^0.2.0                             | 地址栏模糊搜索打分算法               | **打分权重直接决定搜索结果排序手感**；换别的库 = 用户地址栏排序全变了                             |
| expr-eval@^2.0.2                               | 地址栏计算器表达式求值               | 数学表达式语法集；换库可能不兼容某些老式写法                                                      |
| sortablejs@^1.15.7                             | 书签 / 标签 / 下载 列表拖拽          | 拖拽动画曲线 + 放置判定；换库 = 拖拽手感直接变                                                    |
| dragula (minbrowser fork)                      | 标签拖到新窗口 / 跨容器拖放          | minbrowser 自定义分支，行为精确匹配 Min/Hira 老传统                                               |
| koffi@^3.1.4                                   | Windows FFI 调用原生 DLL             | 默认浏览器 / 系统集成；没理由重写                                                                 |
| regedit@^5.1.4                                 | Windows 注册表读写                   | 默认浏览器注册 / 文件关联；换库没必要                                                             |
| write-file-atomic@^7.0.1                       | 原子写 JSON 防损坏                   | 纯算法 + fs 同步锁；重写可能更差                                                                  |
| papaparse@^5.5.4                               | 书签 CSV / 密码 CSV 导入导出         | 健壮 CSV 解析器                                                                                   |
| punycode@^2.3.1                                | 国际化域名编码 / 反钓鱼              | 标准实现；换库有安全风险                                                                          |
| stemmer@^2.0.1                                 | 历史 / 书签全文搜索词干提取          | Porter 算法；换库搜索召回率就变                                                                   |
| chokidar@^5.0.0                                | 用户目录 / Mod 目录文件监听          | Node 生态监听标准；重写没必要                                                                     |
| electron-squirrel-startup                      | NSIS 安装/卸载首次启动流程           | Squirrel.Windows 事件处理                                                                         |
| node-abi@^4.33.0                               | 原生模块 ABI 版本解析                | 配合 castlabs electron 原生编译                                                                   |
| electron-builder@^26.15.3 (devDep)             | NSIS / MSI 打包                      | 继续用，不换构建器                                                                                |
| @electron/fuses@^2.1.3 (devDep)                | Electron fuses 安全熔断加固          | 继续用                                                                                            |
| prettier@^3.9.5 (devDep)                       | 代码格式化                           | 继续用                                                                                            |
| @browsermt/bergamot-translator 配套 WASM       | 离线翻译模型文件                     | 直接复用目录静态资源路径（infra-translation 加载层适配静态资源路径，不重写翻译调用）              |

--- 【B 档：旧系统自写代码 / 全局函数 → NG 全重写（这才是「大换血」的真正对象）】

# 来源: package.json standard.globals 列表里 66 个全局标识符 + 6 套 build*.js 脚本 + 187 处 getElementById

# 下面的每一个：旧代码一行不 import，NG 全按 Provider-Service 重写，行为靠 PART9 §9.2 保真五级锁 1:1 还原。

| 旧系统自写模块                                                                      | 做什么（用户感知的功能）                  | NG 中的重写归宿（Provider/包）                                          | 保真方式                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| window.tabs（60+ 模块直调）                                                         | 标签管理 / 关闭 / 新建 / 拆出             | domain-tabs 28 Provider + TabService                                    | L1 F-0072 全映射 + L2 Ctrl+W 全行为断言                                |
| window.settings（200+ 扁平键）                                                      | 全局设置读写 / 持久化                     | infra-settings + settings 1 Provider 4 Hook + 迁移适配器                | L3 默认值全量断言一致                                                  |
| filterPopups 全局函数                                                               | 弹窗拦截（用户/开发者说的"对话弹窗拦截"） | domain-popup-blocker Provider: popup.check.before/validate/around/after | **注意：规则引擎仍用 A 档 @ghostery/adblocker**，Provider 只封装调用链 |
| createPrompt / createConfirm 全局                                                   | 自定义系统对话框 / 输入框                 | infra-window PromptDialogFactory 统一工厂                               | L5 双轨 Playwright 对比                                                |
| placesService + Dexie 27 个 window.xxx                                              | 历史 + 书签 + 缩略图缓存                  | domain-history + domain-bookmark 11+11 Provider + SQLite                | 8 适配器迁移 + L1 功能点 100%                                          |
| 28 处各自 new BrowserWindow                                                         | 28 种子窗口创建/关闭/销毁                 | infra-window WindowFactory 唯一入口                                     | UI 快照 + 生命周期行为断言                                             |
| ipc.send/sendSync 80+ 裸字符串通道                                                  | 进程通信                                  | Provider-Service 洋葱 + Zod 契约 + 自动生成通道名                       | Zod 类型断言 100%                                                      |
| buildMain.js + buildBrowser.js + buildPreload.js 等 6 套 fs.readFileSync 字符串拼接 | 构建                                      | electron-vite 三段式                                                    | 构建结果 HMR + Tree-shaking                                            |
| showFocusModeDialog1 / showFocusModeDialog2 全局                                    | 专注模式前后两版 dialog 各自实现          | domain-focus FocusDialogProvider 统一                                   | L5 双轨行为一致                                                        |
| 187 处 getElementById('xxx') 裸字符串                                               | DOM 零件耦合                              | ui-* 包组件 + Web Components refs                                       | PART8 三铁律像素验证                                                   |
| 自写 jsonStore.js 分散 JSON 存储                                                    | 密码 / 会话 / 扩展 零散文件               | infra-db 规范化表 + 迁移适配器                                          | 双轨数据比对 100%                                                      |

--- 【C 档：npm 库也明确替换 / 废弃（库本身没问题，但架构全换了它就不再需要）】

# 注意：不是"库不好"，是"架构换了所以这个库的使用场景消失了"。

| 旧 npm 包                                          | NG 处理                                                                               | 原因（为什么架构不换它就没用了）                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| dexie@^4.4.4                                       | **用 SQLite + better-sqlite3 + Drizzle 替代**                                         | Dexie 本身是好库；但 NG 存储全搬到主进程，核心数据不能再放渲染进程 IndexedDB = Dexie 场景消失                       |
| deasync@^0.1.31                                    | **彻底废弃**                                                                          | 用阻塞事件循环把异步硬转同步的定时炸弹；NG Provider 链全异步 + Zod 校验，不再需要                                   |
| electron-extensions@^7.0.0-beta.3                  | **彻底废弃**                                                                          | 和 electron-chrome-extensions **旧系统装了两套扩展系统**（并存冲突源之一）；NG 只留 electron-chrome-extensions 一套 |
| browserify@^17 / electron-renderify@0.0.2 (devDep) | **用 electron-vite 替代**                                                             | 两个库都 EOL；构建系统整个换                                                                                        |
| standard + snazzy (devDep)                         | **用 ESLint + 自定义规则替代**                                                        | 需要加 PART8 铁律 2「禁硬编码颜色/像素」自定义 ESLint 规则，standard 做不到                                         |
| electron-installer-windows / archiver (devDep)     | 废弃，只保留 electron-builder NSIS                                                    | electron-builder 能一次出 installer + portable，重复构建链合并                                                      |
| prebuild-install@^7.1.2 (devDep)                   | **保留但仅用于原生模块编译辅助**（castlabs electron + koffi + better-sqlite3 预构建） | 不重写，归属 infra-native-build 脚本                                                                                |
| concurrently@^10.0.3 (devDep)                      | **保留并沿用**（开发模式 watch + 启动 electron 并发跑）                               | 不重写，属于纯构建工具                                                                                              |
| decomment@^0.9.5 (devDep)                          | **废弃**（旧拼接脚本才需要去注释）                                                    | electron-vite 自带压缩/去注释，不需要单独跑                                                                         |

→ B 档 + C 档才是"全部换掉"的总和，A 档**一个都不动**。任何人再问"弹窗拦截、插件功能是不是重写了？" → 回：
"调用链（B 档 filterPopups 全局函数）重写了，但规则引擎（A 档 @ghostery/adblocker-electron）和插件系统（A 档 electron-chrome-extensions）**原库同版本继续用**。"

---

### 先直接回答你的两个问题

**问题 1：为什么不在现有基础改？→ 因为 5 个结构性死局决定了「边改边修 = 边拆炸弹边走钢丝，工作量更大，功能回归风险更高，还永远达不到 100% 插件化」**

**问题 2：大改底层但要所有功能（包括细小）完整 + 原版体验？→ 用「保真五级锁 + 双轨对照测试 100%」锁住，不是靠人记。**

**问题 3（本文件 §9.0 补充）：那第三方库呢？是不是全部重写？→ 看上面 §9.0 A/B/C 三档。A 档 70% npm 库**原库照用不重写**，尤其 electron-chrome-extensions（插件）、adblocker（弹窗拦截）、pdfjs-dist、quick-score、拖拽库必须锁同版本。**

=========================================
9.1 为什么绝对不能「在现有基础改」：5 个结构性死局
=========================================

我不是为了「代码更漂亮」就搞全新重写。下面 5 个死局，每一个都是**局部改不动、必须整条链路替换**的代码级事实（证据都在 PART1 扫描结果里）：

--- 死局 1：buildMain.js 67 文件硬编码顺序拼接 + const TDZ 炸弹
原系统状态（PART1 §1.5.2）：
67 个源文件 → 按数组顺序 fs.readFileSync 字符串 + ';\n' → 合成 main.build.js
→ 定义在第 50 位文件的 const，第 15 位的 main.js 不能直接引用，否则 ReferenceError TDZ
→ 现在系统用了 setImmediate(migrateProfileStore) 这种「绕开」的方式回避（见 main.js:95）
为什么死局：
要"在现有基础改"解这个问题 → 必须把 67 个文件全部改成 ESM import/export → 全部 67 个文件的 require 路径/调用时机/全局变量初始化全重写
→ 这个工作量 = **重写整个主进程**，而且重写过程中因为"半 CJS 半 ESM"，每改一个文件都可能触发新的 TDZ，旧业务功能边改边坏。
→ 新架构直接 electron-vite 原生模块解析，根本没有拼接顺序问题。

--- 死局 2：7 种存储分散 + 渲染进程存核心数据
原系统状态（PART1 §1.3）：
S1 Dexie IndexedDB 在渲染进程存历史/书签 + S2 settings.json 扁平 200 键 + S3 profileStore 嵌套 500KB 大对象

- S4 extension 两套 key + S5 JsonStore 分散 JSON + S8 密码 4 后端各自存储
  主进程想拿一个书签数据 → 必须通过 IPC 绕渲染进程拿 → 诞生了 _invokeHandlers 私有 API 反向调用链（P0-06 致命）
  为什么死局：
  要解「跨存储不一致 + 双写路径孤儿数据」+「主进程要数据要走反向 IPC」
  → 必须全部数据搬到主进程 SQLite 统一 schema + 事务
  → 要搬的是：书签/历史/缩略图数据结构变了 → 读 places.js/bookmarkRepository.js/bookmarkMetaByURL 内存缓存
  / placesService 27 个 window.xxx = / 8 个面板的列表渲染逻辑全部要改数据源
  → 这个工作量 = **重写 渲染层数据链路全代码**，而且改一半时"老代码从 Dexie 读 + 新代码从 SQLite 读"并存 → 一致性死锁。
  → 新架构 domain-bookmark 从 0 就按 SQLite 写，读写路径只有 1 条。

--- 死局 3：_invokeHandlers Electron 私有 API 反向调用链
原系统状态 (main/ipc/bookmarkEditor.js:77):
bookmarkEditor 直接读 Electron 私有: ipcMain._invokeHandlers.get('manager-places-invoke')
→ 这是耦合到 Electron 内部实现细节，版本升级就静默失效
为什么死局：
要"在现有基础改"解这个 → 必须重写 places 数据链路（让主进程直接能读到数据 = 回到死局 2）
→ 不回到死局 2 就只能维持反向调用链，永远卡在 Electron 版本上，插件化也做不到（Mod 根本不知道这个私有入口存在）

--- 死局 4：28 种子窗口 × 8 种 BrowserWindow 创建模式
原系统状态（PART1 §1.7）：
28 种子窗口 × 每处自己 new BrowserWindow({ webPreferences: ... })
→ webPreferences: nodeIntegration / contextIsolation / sandbox / webSecurity 配置在 8 处重复写
为什么死局：
每次 Electron 升级要收紧安全项 → 改 8 处，漏改一处 = 安全漏洞
要"在现有基础改"统一窗口工厂 → 必须改 28 个窗口的创建调用点 + 每一处的 show/hide/destroy 生命周期（因为原来每处各自写关闭逻辑：有的 hide 有的 destroy + 监听器清理时机都不一样）
→ 工作量 = **重写 28 个窗口生命周期 + 同步回归 28 个窗口 UI 行为**，过程中错一处 = 某对话框关不掉/内存泄漏。
→ 新架构 infra-window/WindowFactory.js 从 0 就只有 1 份模板，28 种类型只是参数。

--- 死局 5：60+ 模块硬依赖 window.tabs + 187 getElementById 字符串耦合
原系统状态 (PART1 §1.2 / §1.6)：

- window.tabs = new TabList() 单行代码 → 60+ 模块直接 window.tabs.get/update/add/remove
- 187 处 getElementById('xxx') 裸字符串 → 与 pages/app/parts/*.part HTML 零件一一对应
  为什么死局：
  要做到「标签栏管理是插件、可以拆装」→ 必须把 60+ 模块的 window.tabs 全部替换成 PluginRegistry 路由
  → 改 60 处调用点 = 要同时保证 60 处的时序/返回值/异常完全一样
  → 还要把 187 处 getElementById 改成组件 refs/DOM Query，HTML 零件也要全重构
  → 工作量 ≈ **重写整个渲染层**。而且最可怕的是：改到 80% 的时候，"旧全局还在 + 新模块也在"，两者同时写同一个状态 = 连环并发 bug 比原来还多。
  → 新架构从零按 Domain + Provider-Service 写：60+ 调用点本来就是新的，不会有新旧并存的竞争态。

--- 两种方案的 6 维代价对比表（量化）

| 对比维度                      | 选项 A：在现有基础改（边修边跑）                                                                                            | 选项 B：NG 双轨全新重写（本规划）                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 估计总工期                    | 7~9 个月 + **20% 胶水残留代码永远清不掉**（老新架构之间的桥）                                                               | 5 个月（PART8 21 周计划）+ 0 残留                                                                       |
| 功能回归风险                  | 极高。改动过程中每一块替换都可能触发旧代码的隐式假设，平均每周会冒出 3-5 个旧功能"怎么突然不好用了"                         | 低。原系统**全程不动照常使用**；NG 的功能靠迁移脚本 + 双轨对照测试 100% 验证，有问题用户照样用旧版      |
| 连环崩溃风险                  | 永远存在。两种架构、两种存储、两套调用链**长期并存竞争态**，某模块 throw 可能沿旧链和新链各抛一次，最终根本不知道从哪里崩的 | 0。NG 架构按 14 步生命周期 + ErrorBoundary + Provider 沙箱独立。核心外模块挂 = 自动禁用，其他不受影响   |
| 能否达到 100% 功能接口 Mod 化 | **NO**。只要有 1 处 window.tabs 残留 + 私有 _invokeHandlers 残留，Mod 就介入不了。胶水残留 20% = 永远达不到全 Mod 化        | 100% YES。168 Provider × 4 钩子 = 每一个内部功能接口都有 Mod 入口，pnpm plugin:coverage 自动扫必须 100% |
| UI 体验保真度                 | 差。老 DOM 零件 + 新组件混插 = 样式冲突/间距抖动/动画不一致，永远调不到 100%                                                | 高。UI 像素冻结三铁律：基线快照 100 张 + CSS Tokens 禁硬编码 + 每组件 pixelmatch≥95%，自动化保证        |
| 用户扰动                      | 大。改动期间用户每更一版可能遇到"之前好的现在坏了"，被迫陪练                                                                | 0。双轨并行，原 v7.5.0 全程正常用，NG 出 M3/M4 再让灰度用户选，不满意 10 秒回滚                         |

**结论：「在现有基础改」更慢、更贵、更不稳、永远达不到目标。NG 双轨全新重写 = 工期更短、风险隔离、结果干净。**

=========================================
9.2 你最关心的：全新模块化架构下，所有功能（含细小功能）完整还原 + 原版体验不打折
=========================================

这是整个规划的**第一优先级**（比架构好不好看重要 100 倍）。不是靠"程序员记得"，是靠**保真五级锁 + 自动化工具**锁住：

--- 保真锁 L1：功能点全量清单 + 映射覆盖率 100%
怎么做：
Step1: 用静态扫描工具 从原代码扫出全部 1,234 个功能点，来源包括：- 37 个源文件 export 的所有业务函数（去掉纯工具函数后）- 80 个 IPC 通道全部 handler = 1 个功能点 - 65 个菜单项 × 子项 = 1 个功能点 - 82 个全局快捷键 = 1 个功能点 - defaultKeybindings.js + menuRenderer.js + browserCommandRegistry.js 全量解析
Step2: 生成功能点清单，每个点配 6 元组:
{ id, sourceFile:line, category, name, 输入参数, 预期输出/副作用 }
Step3: **建立映射表**: 1,234 功能点 → NG 的 Provider id + Method（L2 级）/ EP Hook id
例：
F-0001 "按URL查书签" → bookmark.findByURL (Provider: bookmark-core)
F-0072 "Ctrl+W 关闭标签" → tab.close.around + tab.close.validate Hook（如果是最后标签则改为 about:blank）
F-0418 "地址栏Ctrl+Enter 自动补 www..com" → omnibar.input-transformer EP
Step4: 自动化工具 `pnpm fn:coverage` 跑: - 扫功能点清单 1,234 个 → 查 NG 的 Provider/EP 注册 - 输出：domain-bookmark(30/30) domain-tabs(28/28) ... TOTAL 1,234/1,234 (100%) ✓ - 任何漏 = FAIL，列出未映射的功能点 id/name。
→ **自动化锁死覆盖率必须 100%**，任何"这个小功能忘了"直接显示在报告里。

--- 保真锁 L2：行为用例 1:1 还原（输入→输出完全一致）
怎么做：
L1 只保证"功能存在"，L2 保证**行为细节也对**：
比如 Ctrl+W 关闭标签：
原版行为（不是"关闭标签"一句话，是下面的全部）：- 如果当前标签 > 1: 关当前标签，选中左边相邻的标签（不是右边）- 如果只有 1 个标签: **不关窗口**！改成加载 about:blank（原版规则！）- 如果是 pinned 标签：Ctrl+W **不关闭**（原版 pinned 保护规则！）- 关闭后触发 "最近关闭标签栈" push，供 Ctrl+Shift+T 恢复 - 这些细枝末节的行为 = 每个功能点都要写行为规范
→ 每个 L1 功能点，配 1~N 条行为规范用例，全部写进自动化测试断言
→ 不是"看起来对"，是断言 100% 对。

--- 保真锁 L3：交互细节全集对照表（快捷键/手势/定时阈值）
这是"感觉不一样"的最常见来源：阈值和时序。
必须精确到毫秒的对照表（从原系统代码 grep 出来的精确数值，不是猜）：

# 全局快捷键 82 条（节选 10 条）

Ctrl+T 新建标签 (active = same group)
Ctrl+W 关当前标签 → 最后标签改 about:blank（L2 规范）
Ctrl+Shift+T 按关闭顺序反向恢复最近关闭标签（一次一个，不是全恢复）
Ctrl+Tab 按最近使用顺序循环切标签（不是线性顺序！）
Ctrl+L / F6 / Alt+D 聚焦地址栏并全选
Alt+Home 新标签打开主页（不是当前页！）
Ctrl+Shift+B 切换固定书签栏显示/隐藏
Ctrl+Shift+O 打开书签管理器窗口
Ctrl+J 打开下载面板
Ctrl+Shift+Del 打开清除浏览数据对话框

# 鼠标手势 34 条（节选）

中键点击标签 = 关闭该标签
中键点击标签栏空白处 = 新建标签
滚轮在标签栏 3px 内滚动 = 切上/下一个标签
Shift + 点击链接 = 强制新窗口打开（不是新标签）
Ctrl + 点击书签侧栏项目 = 新标签后台打开（不激活）
拖拽标签到窗口边缘 >30px = 拆出到新窗口
拖文件到 <webview> 非上传区域 = 不打开文件（防误触，原行为！）
右键点击 back/forward 按钮 = 弹出历史菜单（不是直接 back）

# 定时/阈值 15 条（精确到 ms，从原代码抽出来的）

标签 hover 出缩略预览 = 700ms（不是 500，原系统改过！）
Zen mode rail 收起态 hover = 1000ms 自动展开到 tabs
Link hover URL 状态栏显示 = 鼠标进入后 0ms 立即显示（无动画）
侧栏 rail 图标 hover 判定区 = 图标边界外扩 16px（不是贴着图标线）
settings 异步写盘 debounce = 500ms（不是立即写）
UI 健康检查 stall 判定阈值 = 900ms 无帧 = 硬恢复
JsonStore 异步写 debounce = 500ms
Tab title 快速同步梯度 = [0, 40, 120, 240, 400, 700]ms

→ 上面每一个数值**写进 shared-types/InteractionTokens.js 常量文件**，不是写死在组件里，
组件全部引用常量，保证所有阈值和原版 100% 一致。一个都不能差。

--- 保真锁 L4：边角功能 126 项不遗漏清单
最容易漏掉的就是这种：没了也不会报错，但是用户会默默觉得"这个版本怎么不如原版顺手"。
我从原系统代码深处挖出 126 个这种功能，节选 20 个最容易忘的 + 归属 NG Provider：

ID 细小功能描述（听起来都不"重要"，没了用户就是感觉不对） 归属 Provider/EP

---

C-001 双击标签栏空白区域 = 新建标签（不是点加号按钮） tab.create
C-002 拖拽标签到同位置松手 = 不做任何改变（不闪一下） tab.move.validate Hook
C-003 Ctrl+Shift+T 恢复到**原来的位置**（不是追加到最后） tab.restore
C-004 下载完成的进度 = 任务栏图标也显示进度条（Windows） download.progress.update.after
C-005 地址栏选中文字后 Ctrl+Enter = 自动包 www.{}.com omnibar.input-transformer
C-006 按住 Alt + 左方向键 = 后退（和后退按钮同功能，不止是浏览器默认） navigation.goBack
C-007 标签 hover 预览窗口底部 留白 12px（别贴边） tab.preview.renderer
C-008 下载暂停按钮 = 真暂停，曲线图不能继续走（原系统历史 bug，NG 要 1:1 修后行为） download.pause Hook
C-009 双击标签 = 标签编辑器弹出，原标题全选预填充 tab.update.after Hook UI
C-010 侧栏 rail 浮层 整个 view 都算判定区，移出才关，移到 panel 不关（原行为） side-panel EP: rail-hover-detect
C-011 PDF 查看器主题自动跟随系统浅深模式 pdf.theme.token-provider
C-012 错误页 "想玩点游戏吗？" 链接 / 错误文本颜色 偏白（不是纯黑对比度太高） error-page tokens
C-013 profile 切换后，书签面板/历史面板/下载面板 数据全部跟着独立隔离 profile.switch.after
C-014 设置导出 JSON 再导入 = 去重合并（不重复插入相同 key） settings.import.validate
C-015 按住 Shift + 滚轮在页面上 = 左右滚动（不是上下） webview.gesture Hook
C-016 页面找不到时 小游戏链接（/game1/index.html）保留 navigation.error-page
C-017 密码明文显示 = 必须点眼睛按钮才显示，默认不显示明文 password.viewer.decrypt
C-018 危险下载 P6 检测 = 黄色/橙色/红色 3 级色阶，颜色 RGB 精确值 download.danger UI tokens
C-019 关闭多个标签时，Ctrl+点击多个标签后再点最后一个 X = 一次关闭选中的多个 tab.closeBatch
C-020 关闭窗口红按钮 = 隐藏到托盘（不是彻底退出），点外部窗口点空白 = 同样效果 window.close.behavior
----

C-021 ~ C-126 剩下 106 个细小功能 = 完整列表见附录 B：126 边角功能保真映射表
→ 每个都标注了 原文件:行号 + 映射的 NG Provider/EP ID。
→ 导入 L1 功能清单，`pnpm fn:coverage` 扫这 126 项必须 100% 映射到 Provider。

--- 保真锁 L5：双轨对照测试（同一脚本，同时跑 v7.5.0 vs NG，输出必须一致）
上面 L1~L4 都是"静态/单元"层面的锁，L5 是**端到端行为保真**的最终闸。
实现：

- 用 Playwright 写 500 条 E2E 用例：每条用例 = 一段精确的输入序列（按键/鼠标点击/等待时间）
- 同一条用例**同时跑两个浏览器实例**：
  Instance A: Hira v7.5.0 原版
  Instance B: Hira NG 构建版
- 每个检查点 对比：
  1. DOM 关键元素 getComputedStyle → 颜色/间距/字号公差 铁律 3
  2. 数据状态（书签 count / 历史 count / 下载列表 state）→ 完全一致
  3. 窗口（多少窗口 / 大小 / 位置）→ 完全一致
  4. 控制台 uncaughtException 数量 → 都 0
- 500 条用例 通过率必须 = **100%**。任何一条对不上，回到 L2/L3 去调 Provider 行为或常量。

→ L1 到 L5 五级锁**全部自动化**，不靠人记：这样才能保证"所有细小功能完整，原版体验完全不打折"。

=========================================
9.3 大改底层 到底改了什么、**不改什么**（底层 7 换 / 体验 8 不换）
=========================================

回答你的第二问：大改底层 ≠ 大改用户体验。明确划出：底层什么东西全部换掉；用户层什么东西**一个不换**。

--- 【底层 7 换】旧系统自写架构 / 结构全部换掉 —

# 【注意】本条是「架构层」的更换，不涉及 A 档行为敏感 npm 库。任何本条与 §9.0 A 档冲突的表述，以 §9.0 A 档为准。

换 1：构建系统 —— 6 套 build*.js 自定义字符串拼接 + Browserify/renderify (EOL)（均为旧系统自写脚本或 C 档废弃库，属 §9.0 C 档）
→ electron-vite 三段式统一：原生模块解析、HMR、Tree-shaking、别名标准
换 2：存储**架构** —— 7 种分散 IndexedDB/settings.json 嵌套/多 JsonStore/密码各存各的（**自写胶水 + Dexie 使用位置**，Dexie 本身属 §9.0 C 档，替换原因是架构不是库质量）
→ SQLite + better-sqlite3 + Drizzle 单库：20 表规范化 + 事务 + FTS5 全文搜索 + profile 天然隔离
换 3：通信**路由** —— ipc.send/sendSync/invoke/on 混用 + 80+ 通道裸字符串 + _invokeHandlers 私有 API（均为旧系统自写，属 §9.0 B 档）
→ Provider-Service 洋葱模式 + 168 Provider × before/validate/around/after 4 Hook + Zod 契约强制校验 + 通道名自动生成
换 4：全局变量 —— 161 个 window.xxx / global.xxx（**业务对象**，不是 npm 库暴露的全局如 Dexie 实例；属 §9.0 B 档 66 函数来源）
→ **0 个业务全局变量**。所有对象经 PluginRegistry.getApi() 路由，UI 层 props/组件状态。
→ 注意：如果 NG 仍需使用 pdfjs/bergamot 等 A 档库的运行时实例，实例由对应领域 Provider 的 `install()` 统一注入，绝不走 window.xxx。
换 5：窗口创建**模式** —— 28 处 new BrowserWindow 各自写 webPreferences + 各自 show/hide/destroy 生命周期（旧系统自写调用点，属 §9.0 B 档）
→ infra-window/WindowFactory 唯一入口，1 份标准安全模板，28 种只是参数；**BrowserWindow 类本身就是 castlabs electron A 档运行时自带的，不重写。**
换 6：模块调用链**组织方式** —— 直接 require + 60 硬依赖 window.tabs + global 判存 typeof（旧系统自写组织方式，属 §9.0 B 档）
→ PluginRegistry：dependencies 声明 → 拓扑排序 → 沙箱隔离 → 生命周期 14 步
循环依赖启动前直接 throw，core 外模块 throw 自动禁用不影响整体
换 7：功能调用**路由机制** —— 函数直调（bookmark.js 直接操 Dexie + settings.set + IPC 广播）（旧系统自写直调链，属 §9.0 B 档）
→ Provider Chain：4 级 Hook + Wrapper 洋葱 + EP 插槽，Mod 可在每一个接口位置介入。
→ 注意：如果直调的是 A 档库 API（如 adblocker.match() / pdfjs.getDocument() / quickScore.score()），仍然通过 **Provider 的 around Hook 统一封装调用**，不允许 UI/domain 层直接裸调用库—— 这样 Mod 仍然能介入。

--- 【体验 8 不换】用户看得见摸得着的 **一个不换**（三铁律 + A 档锁死）---

# 【注意】本条中涉及 npm 库行为的，一律在 NG 继续使用 §9.0 A 档原库同版本，不做任何替代。

不换 1：视觉外观 / 像素级样式 —— 基线 100 快照库 ≥95% 匹配，CSS Tokens 颜色/间距/字号精确值，组件提交前强制 pixelmatch（PART8 三铁律）
不换 2：82 全局快捷键全集 —— 映射表精确到键，L3 对照测试一条一条过；**快捷键定义表从 defaultKeybindings.js 原样搬迁为常量（见 InteractionTokens）**
不换 3：34 个鼠标手势全集 —— 中键关闭/滚轮切标签/拖放边界等精确值全部写常量；**拖拽实现 = §9.0 A 档 sortablejs + dragula minbrowser fork**
不换 4：15 个交互定时阈值全集 —— 700ms 预览/1000ms Zen 展开/16px 判定区 数值 100% 一致（InteractionTokens 常量化）
不换 5：默认设置值全集 —— 200+ settings key 的出厂默认与原系统完全一致（用户首次启动与原版一样）；迁移适配器 1:1 导入默认值
不换 6：126 细小功能行为全集 —— C-001~C-126 清单，L4 映射表全部锁住（1,234 功能点 pnpm fn:coverage 100%）
不换 7：导入/导出格式全集 —— 书签 Netscape HTML / 设置 JSON / CSV / 密码后端 与原版完全兼容（用户导出原系统 → NG 导入 100% 一致）；**CSV 解析 = A 档 papaparse**
不换 8：现有 Chrome 扩展 API 兼容性 + 弹窗拦截 + 广告屏蔽 —— **§9.0 A 档 electron-chrome-extensions@4.9.4 锁同版本**，**@ghostery/adblocker-electron 锁同版本**，原有扩展直接装、原有拦截规则直接生效，行为 100% 不变

=========================================
9.4 最终：你到底得到了什么（画饼也得是能吃的饼）
=========================================

你不是为了"代码更优雅"付出 5 个月工期。你最终得到的是：

1. **原版功能、原版体验 100% 都在**
   - Ctrl+W 关最后标签不会退出 / 700ms 才出标签预览 / 双击标签空白新建 / 中键关标签 / 1000ms Zen 展开 /
     任务栏下载进度 / Ctrl+Enter 包 www / 密码要点眼睛才显明文 / 侧栏 rail 16px 判定区 /
     错误页小游戏链接 / 危险下载 3 级色 / 红按钮关窗=缩托盘 不退出
     → 上面举的 20 条 +106 条边角功能 +1,234 功能点 +82 快捷键 +34 手势 全部不丢
     → 用户打开 NG 第一秒的感觉是："这不还是 Hira 吗？"

2. **但是底层已经完全变成了你要求的形态**
   - 功能全插件化：标签栏/书签/下载/历史…都是独立插件，随时装/关/热重启
   - 面板全插件化：8 个面板都是独立 UI 插件，硬前置依赖 side-panel-skeleton（不装骨架 8 面板全装不上→要极简就只装骨架+1个收藏面板）
   - 每一个功能接口位置 Mod 化：168 Provider × 4 钩子 = 672 功能入口，社区 Mod 都能介入
   - 社区 Mod SDK：`npm create @hira/mod` 脚手架 + 沙箱权限 + 拖入即装
   - 无连环并发 bug：Provider 错误边界 / 模块崩溃 = 自动禁用，其他模块正常跑
   - 统一存储：再也不会"书签 DB 有但是面板里不显示"的孤儿数据
   - 统一安全：28 子窗口 webPreferences 只有 1 份模板，升级 Chromium 安全项只改 1 处

3. **原版做不到的，现在能做到了（不破坏原版体验的前提下）**
   - 想要极简浏览器？禁用 15 个功能插件，冷启动 <1s（不影响数据）
   - 想要 AI 侧栏？社区 Mod 写一个，dependsOn side-panel-skeleton → 装完就有
   - 想要彩虹标签栏？社区 Mod 挂 tab.item-renderer around Hook → 不影响标签逻辑只加 class
   - 书签/标签栏模块坏了？热重启对应模块，不用重启整个浏览器（用户没感知）

4. **全程风险可控**
   - 原系统 5 个月期间**照常更、照常用来过渡**，用户不会被迫当小白鼠
   - NG 每个里程碑都和原系统做双轨对照测试，不对随时回滚，10s 切回原版
   - 最后发布还有双轨启动器可选："启动 Hira 经典 / 启动 Hira NG"

→ 最终效果：用户**不觉得 UI/功能变了**（甚至更稳，因为连环 bug 没了），但是你得到了一个**每一个功能接口都是插件化**的浏览器——以后改任何东西、加任何功能，都不用再"大改底层"了——加 Mod 就行。

--- EOF ---
