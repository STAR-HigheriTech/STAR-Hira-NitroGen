# 扩展系统：RT 对照与多 Profile 归属

## 结论

NG 的 Chromium 扩展内核已完整保留 `@iamevan/electron-chrome-extensions@4.9.4`
和 `@iamevan/electron-chrome-web-store@0.13.5`，安装、卸载、启停、固定、弹窗、
选项页、开发者诊断、本地化、图标与内容拦截均已落地。剩余的关键问题不是继续增加
管理按钮，而是把扩展运行时从“全局活动 profile”收敛为“调用方所属 profile”。

RT 的归属链是：

```text
IPC sender
  → browser window
  → current space
  → profileId
  → LoadedProfile
  → ExtensionManager / ElectronChromeExtensions
```

NG 当前多数数据域已采用同一条链，但扩展域仍有四个入口直接读取全局
`extensionService`：

1. 扩展 IPC；
2. 扩展生命周期事件中继；
3. 窗口右键菜单、扩展页图标与新标签页覆盖；
4. `hira://extension-icon` 的动态读取口。

当两个窗口分别位于 A/B 两个 profile 时，这些入口可能把 B 的操作用到 A 的
`Session` 上。扩展本身不会串进另一个 profile，但管理结果、事件刷新与页面行为会串台。

## RT 对照

| 能力 | RT 实现 | NG 现状 | 本次处理 |
| --- | --- | --- | --- |
| profile 内扩展列表 | `getExtensionDataFromProfile(profileId)` | per-profile service 已存在，但 IPC 默认取全局活动服务 | IPC 按发送方 profile 解析服务 |
| 启停 / 固定 / 卸载 | 从 sender 解析当前 profile 后调用该 profile 的 `ExtensionManager` | 动作能力齐全，归属不完整 | 完整复用同一解析口 |
| `chrome.tabs.create` | 优先按 `tabDetails.windowId` 找窗口 | 之前总落到焦点窗口 | 按 windowId + 扩展 profile 选窗口 |
| `chrome.windows.create` | 新窗口与扩展 profile 绑定 | 之前直接返回焦点窗口 | 真实创建同 profile 窗口并装配标签 |
| 生命周期通知 | `extensions:on-updated` 带 profileId | relay 一次只订阅一个 service | relay 同时订阅全部已加载 profile |
| 新标签页覆盖 | `LoadedProfile.newTabUrl` | provider 读全局活动 service | provider 接受 profileId |
| 扩展图标 | `hx://extension-icon?...&profile=...` | 动态口只传扩展 id | URL 与协议口携带 profileId |
| 动作状态 | RT 由浏览器动作 provider 读取 | 工具栏此前只读 manifest 默认值 | 同步动态 icon / badge / title / popup |
| 检查视图 | RT 仍为 TODO | NG 已实现后台页检查、诊断与失败原因 | 保留 NG 现有实现 |
| 未打包目录导入 | RT 管理端未完整接通 | NG 已接通目录导入与持久恢复 | 保留 NG 现有实现 |

## 实施边界

- 每个 profile 仍然只有一个 `createExtensionService(profileId)` 实例。
- 找不到发送方所属 profile 的 service 时返回失败，不回退到另一个 profile。
- 扩展生命周期事件可以广播给所有渲染层，但载荷必须带 `profileId`；各页面刷新时
  仍按自己的发送方解析 profile。
- `chrome-extension://` 页面、弹窗和右键菜单都使用该窗口当前 profile 的服务。
- 容器标签与无痕标签不套用当前窗口的扩展新标签页覆盖。

## 不变量

1. IPC 是跨 profile 的操作边界，必须以 sender 为准。
2. `extensionService` 是缓存对象，不是身份事实；身份事实永远是 `profileId`。
3. 安装记录、Session、数据库目录与扩展目录必须来自同一个 profile。
4. 新加入的 profile service 必须自动进入生命周期中继，不要求重启或再次切换 profile。

## 故障与资源检查结论

| 问题类别 | 根因 | 修复 |
| --- | --- | --- |
| 启动恢复与打开页面并发加载 | 两条链同时调用 Electron `loadExtension` | 按扩展 id 合并为 single-flight |
| 重载失败却显示旧状态 | 先卸载后加载，失败分支未登记 `loadError` | 登记 `error` 并保留失败原因 |
| 启用失败无法重试 | 重试入口把 `enabled:false` 直接当作用户主动停用 | 有 `loadError` 时允许重试 |
| CRX 越界写入 / 压缩炸弹 | 直接 `extractAllTo`，无路径、条目和体积上限 | 入口校验、越界拒绝、符号链接拒绝、体积上限 |
| 清单页面越权 | `new URL()` 允许 `javascript:` / 外部站点 | 只接受同 id 的 `chrome-extension://` |
| 语言包路径穿越 | `default_locale` 可直接进入文件路径 | locale 白名单 + realpath 根目录校验 |
| 图标读取越界 | 扩展内符号链接可指向任意本地文件 | realpath 校验 + 单图标 8MB 上限 |
| 安装记录损坏即静默清空 | 直接覆盖 `installed.json` | 原子替换、损坏文件保留、旧临时文件清理 |
| 删除 profile 后对象常驻 | Session、ECE、identity worker 监听仍被强引用 | 统一销毁服务、摘监听、清 single-flight 缓存 |
| 退出丢失最后一次启停 | 安装记录异步写队列未等待 | 退出前 flush 全部已加载 profile |
| 全 profile 隐私清理遗漏 | 退出时只清活动 Session | 遍历全部已加载扩展 Session |
