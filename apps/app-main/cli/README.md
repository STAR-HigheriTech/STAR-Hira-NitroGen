# Hira CLI

从源码安装：

```powershell
node ".\apps\app-main\cli\hira.cjs" setup
```

已安装的 Hira 可以直接用自带 Electron 运行时安装，不要求系统另装 Node：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:ProgramFiles\STAR Hira NitroGen\STAR Hira NitroGen.exe" `
  "$env:ProgramFiles\STAR Hira NitroGen\resources\cli\hira.cjs" setup
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

检查连接：

```powershell
hira doctor --json
```

让 Codex、Claude Code 和通用 Agent 识别 `/hira`：

```powershell
hira agent install --target all
```

核心用法：

```powershell
hira read https://example.com --json
hira run "阅读今天最相关的 AI 更新并汇总" --wait --json
hira task result <taskId> --json
```

CLI、后台浏览器、本地文件/Office 分别是独立插件。可在 `hira://plugins` 中单独启停；关闭 CLI 插件后，本机服务器与令牌会立即撤销，重新启用即可恢复。

完整命令：`hira --help`。Agent 接入与架构说明见 `docs-ng/PART20-Hira-CLI与后台浏览Agent.md`。
