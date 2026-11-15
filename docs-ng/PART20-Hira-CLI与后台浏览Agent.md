# PART20 · Hira CLI 与后台浏览 Agent

## 1. 产品目标

Hira CLI 不是第二个 Agent，也不是把浏览器标签“藏起来”。它是一层稳定的本机能力协议：

- Codex、Claude Code、DeepSeek Harness 或任意能执行 Shell 的 Agent，可以调用 `hira`。
- Hira 继续持有浏览器登录态、标签体系、页面读取、AI 工具与审批。
- 外部 Agent 负责理解用户意图与编排；Hira 负责真实网页执行与交付事实。
- 用户说“接入 Hira CLI”或安装后的 `/hira`，都能找到同一份接入说明。

核心原则：**外部 Agent 不接管 Hira 的浏览器 UI，CLI 也不另造模型内核。**

## 2. 从三套编码 Agent 学到什么

### OpenAI Codex

值得复用的底层模式：

- 工具契约是稳定的、可机器解析的，不把自然语言状态混进执行结果。
- 长任务允许多次工具往返，上下文按需展开，避免一开始灌入完整工具目录。
- 工作目录、项目指令、审批与执行日志都是 Agent 运行时的显式状态。
- 子任务共享同一条执行链，不复制模型客户端与工具实现。

Hira 的对应落地：

- CLI 统一走 `POST /v1/rpc`，所有命令返回稳定 JSON。
- 自然语言长任务复用现有 `turn-runner`，保存 `taskId / sessionId / turnId`。
- `agent_browser` 是独立工具声明，不把网站规则硬编码进模型提示。
- 后台浏览仍经过同一审批闸、审计表、取消信号与上下文预算。

### Claude Code

值得复用的底层模式：

- Shell 是 Agent 的通用执行平面；能力通过清晰命令暴露，而不是绑定单一 IDE。
- 项目级指令文件负责长期约束，临时任务不反复塞进每条 prompt。
- 命令输出必须简明、可组合，失败保留错误码，避免 Agent 猜状态。
- 危险动作应该有显式权限边界，而不是只靠模型自觉。

Hira 的对应落地：

- `hira agent install` 生成 Codex Skill、Codex Prompt、Claude Slash Command 与通用说明。
- 只读动作可直接执行；`click/fill` 默认拒绝，必须显式 `--allow-actions`。
- 错误统一为 `[CODE] message`；HTTP 层返回 `{ ok:false, error:{ code,message } }`。
- API 断开不杀任务，状态与最终结果持久化在 `ai_cli_task`。

### DeepSeek Harness

值得复用的底层模式：

- 模块边界围绕能力而不是页面：模型、上下文、工具、执行器、存储各负其责。
- 执行过程可观察、可取消，状态与结果分离。
- 推理与正文分离，工具调用可以在多步之间稳定回放。
- 长上下文优化靠裁剪与摘要，不靠无限增长。

Hira 的对应落地：

- `background-browser` 只管理隐藏窗口和页面动作。
- `cli-tasks` 只管理任务状态、AI 会话绑定和结果。
- `agent-bridge` 只管理本机传输、令牌和方法分发。
- `background-tools` 只把模型动作映射到浏览器端口。
- 回复约束把“结论、事实、推断、来源”分开，工具过程不进入最终交付。

## 3. 运行结构

```text
Codex / Claude Code / other Agent
                |
                |  hira ... --json
                v
        ~/.hira/cli/runtime.json
        127.0.0.1 + Bearer token
                |
                v
                  hira-cli 插件
              bridge + persistent tasks
                 /                 \
   ai-agent-browser 插件       ai-engine 受限运行时
   hidden BrowserWindow       sessions / turns / result
   current profile Session    no sqlite / no raw runner
          |
          +── agent_browser tool
          +── ai-skills-research
          +── ai-skills-business-ops

ai-agent-local 插件
  workspace / files / shell / Office tools
```

隐藏窗口使用当前 profile 的 Electron `Session`，因此登录态、Cookie、代理和站点权限与可见标签一致。窗口固定 `show:false / focusable:false / skipTaskbar:true`，不注册进标签条，也不调用 `focus/show/activate`。

### 插件边界

- `ai-engine`：只保留模型协议、上下文、回合执行、审批、工具注册表与技能调度；不再直接拥有 CLI、隐藏浏览器、本地文件或 Office 工具。
- `ai-agent-browser`：唯一后台浏览器实例，贡献 `agent_browser` 工具与 `ai.background-browser` 服务。
- `ai-agent-local`：本地工作区、文件、命令和 Office 工具；停用后这些工具从工具表立即消失。
- `hira-cli`：HTTP 桥、随机令牌、SQLite 任务、默认任务会话；停用即关闭监听、撤销令牌、取消任务并释放外部上下文。
- `ai-skills-research` / `ai-skills-business-ops`：按研究与业务运营拆分的 AI 技能插件。
- `ai-skills-builtin`：基础阅读、语言、研究、写作技能，并在插件中心按 group 细分展示。

插件页的启停不是只隐藏按钮：贡献注册表变化会广播 `plugins:changed`，插件页重新拉插件与技能清单，AI `/` 菜单也读取同一份贡献表。

## 4. 传输与安全

- 只监听 `127.0.0.1` 的随机端口。
- 每次 Hira 启动生成 32 字节随机令牌，令牌只写入当前用户目录，文件权限设为 `0600`。
- 拒绝带浏览器 `Origin` 请求头的调用，降低网页恶意访问本机服务的风险。
- 请求体上限 2 MB；页面正文有字符上限；批量读取上限 12 个 URL。
- CLI 不返回 AI API Key、Cookie、profile 数据库或内部密钥。
- 点击、填写、提交默认需要 `--allow-actions`。自然语言任务只有在用户主动提交 `hira run` 时才启用本次任务的操作权限。
- CLI 插件停用后再次运行 `hira doctor` 会明确返回 `HIRA_CLI_DISABLED`，不会把“插件已关闭”误报成“Hira 没启动”。
- CLI 只能列出和关闭自己创建的 external context，不能看到或关闭 AI 内部会话的后台页。
- 同一后台上下文最多排 8 个操作，后续请求返回 `CLI_CONTEXT_BUSY`；打开、读取、点击、填写、滚动、截图均有硬超时，超时后销毁失联上下文。
- CLI 请求与响应均有大小上限，主进程最多同时处理 64 个请求；慢客户端或超大响应不会无限占住消息循环。
- 文件写入使用不可预测临时名、独占创建与 `0600` 权限，避免不可信工作区预先放置符号链接抢占写入目标。
- 后台页面仍受现有工具审计、取消信号与模型回合上限约束。

## 5. 命令面

面向外部 Agent 的低层命令：

```powershell
hira doctor --json
hira open https://example.com --context research --json
hira read https://example.com/a https://example.com/b --max-chars 30000 --json
hira search "AI news today" --json
hira click --text "下一页" --allow-actions --json
hira fill "#search" "关键词" --allow-actions --json
hira scroll bottom --json
hira screenshot --out ./page.png
hira contexts --json
hira close --context research --json
```

面向“一句话交付”的任务命令：

```powershell
hira run "阅读以下网站今天最相关的 AI 更新并汇总：https://... https://..." --wait --json
hira task status <taskId>
hira task result <taskId> --json
hira task cancel <taskId>
```

`run` 使用 Hira 已配置的模型和完整工具面。外部 Agent 也可以不用 `run`，自己循环调用 `open/read/search/click/fill`，两种模式共用同一个后台浏览器实现。

## 6. 插件中心

打开 `hira://plugins`：

- 功能插件中可以开关“Hira CLI · Agent 接入”“AI Agent · 后台浏览器”“AI Agent · 本地文件与办公”。
- 关闭后台浏览器会级联关闭 CLI；关闭 AI 引擎会级联关闭所有依赖它的能力插件。
- AI 技能板块按“阅读提炼 / 语言处理 / 多源研究 / 情报监测 / 电商运营 / 表格维护 / 市场跟踪”等分组展示，并标出所属插件。
- 停用技能插件会移除整组技能；仍可在单条技能上做更细的启停。
- 运行时安装的第三方技能插件仍从“安装插件 / 插件源”安装，并能通过卸载按钮彻底移除。

## 7. Agent 接入

首次安装：

```powershell
node "E:\path\to\Hira\apps\app-main\cli\hira.cjs" setup
```

安装包内直接使用 Hira 自带 Electron，不依赖系统 Node：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:ProgramFiles\STAR Hira NitroGen\STAR Hira NitroGen.exe" `
  "$env:ProgramFiles\STAR Hira NitroGen\resources\cli\hira.cjs" setup
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

安装后：

```powershell
hira doctor --json
hira agent install --target all
```

安装后新开一个终端，并重启 Agent 产品（或至少新建会话），让它重新扫描 Skill / Prompt / Slash Command。

生成的接入文件：

- `~/.agents/skills/hira-cli/SKILL.md`
- `~/.agents/skills/hira-cli/agents/openai.yaml`
- `~/.codex/prompts/hira.md`（Codex 自定义 Prompt）
- `~/.claude/commands/hira.md`
- `~/.hira/agents/HIRA_CLI.md`

Claude Code 等支持同名 Slash Command 的 Agent，可直接输入 `/hira`。Codex 当前的
自定义 Prompt 入口是 `/prompts:hira`，Skill 入口是 `/skills` 或 `$hira-cli`；
Codex 也会根据 Skill 的 description 自动触发，因此“接入 Hira CLI”这类自然语言
同样可以进入这条路径。任务参数最终统一转成：

```powershell
hira run "<用户任务>" --wait --json
```

不支持 Slash Command 的产品只需在系统指令或项目 `AGENTS.md` 中写明：

```text
需要后台浏览或 /hira 时，先运行 hira doctor --json。
然后使用 hira run "<任务>" --wait --json，或按 hira guide --json 自行编排低层命令。
```

## 8. 如何扩展垂直场景

不新增 `feishu_login`、`amazon_orders`、`stock_watch` 这类写死能力。垂直场景优先由通用原语组合：

- AI 日报：`read_many` 读取多个来源 → 跟随页面链接 → 按日期筛选 → 汇总。
- 爆款收集：搜索 → 读取榜单/关键词 → 提取标题、链接、指标 → 结构化输出。
- 电商后台：复用登录态 → 打开后台 → 按文字/CSS 点击 → 填写筛选/表单。
- 飞书表格：打开表格页 → 读取当前视图 → 通过表格 UI 填写或导入；需要文件能力时由 Hira 的本地工具处理。
- 股价跟踪：批量读取行情页 → 记录时间戳与来源 → 交给任务定时器重复执行。

只有当某类场景产生了稳定的**新原语**时才扩展：

- 新传输能力：在 `agent-bridge` 注册方法。
- 新浏览器原语：在 `background-browser` 增加单一动作。
- 新模型动作：在 `background-tools` 增加声明，仍经过同一审批闸。
- 新持久状态：新增幂等 SQLite 迁移，不把状态塞进 UI 或进程内存。

## 9. 验证标准

- `hira doctor --json` 返回 `state=ready`。
- 执行 `read` 时当前标签不切换、窗口不聚焦、任务栏不出现新窗口。
- 同一 profile 内已登录站点在后台仍保持登录态。
- `run --wait` 关闭终端后，`task result` 仍能取得结果。
- `click/fill` 未带 `--allow-actions` 时明确失败，而不是静默执行。
- 页面正文为空、导航超时、网络失败都有稳定错误码，Agent 不需要解析中文猜测状态。

## 10. OpenAI 官方接入依据

- Skills（用户级位置、显式调用、隐式触发、渐进式披露）：
  https://learn.chatgpt.com/docs/build-skills
- Codex Custom Prompts（`~/.codex/prompts`、`$ARGUMENTS`、`/prompts:<name>`）：
  https://learn.chatgpt.com/docs/custom-prompts
