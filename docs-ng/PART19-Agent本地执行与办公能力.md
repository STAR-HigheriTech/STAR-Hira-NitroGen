# PART19 · Agent 本地执行与办公能力

生成时间：2026-11-12

## 1. 目标

让 Hira 的 AI 从“会聊天、会操作浏览器”升级为能在用户明确授权的工作区内完成真实任务：

- 搜索、读取、创建、编辑本地文件与代码；
- 运行构建、测试、Git、格式化命令；
- 读取和生成 DOCX / XLSX / PPTX / PDF；
- 自动加载工作区 `AGENTS.md` / `HIRA.md` 指令；
- 所有写入、命令和删除继续经过审批与审计；
- UI 从工具事实渲染状态，不从模型文字猜执行结果。

## 2. 对照结论

### OpenAI Codex

- Local shell、文件读写、patch 与 sandbox/approval 属于同一执行边界。
- sandbox 决定技术上能访问什么，approval 决定何时停下来询问。
- 默认模式应围绕工作区，而不是给模型任意绝对路径。
- 工具能力应稳定、可缓存，不必把全部内部能力教程塞进系统提示。

### Claude Code

- Agent loop 是 gather context → take action → verify results。
- 工具执行与最终回答分层；执行过程可中断、可 steer。
- 项目指令文件、自动记忆、skills 与上下文分层加载。
- prompt caching 要求稳定前缀；动态项目内容放在会话层，不能改写系统头。

### DeepSeek Harness

- turn / step、请求冻结、事件日志唯一真源。
- 工具结果先投影/裁剪，再进入上下文。
- 失败/取消必须补齐工具结果。
- token meter、compaction、工具结果 pruner 是独立能力。

## 3. 已落地架构

### 3.1 工作区

文件：`apps/app-main/plugins/ai/main/workspaces.cts`

- 用户通过原生目录选择器显式授权一个文件夹。
- 工作区登记在 `ai_workspace`，会话通过 `ai_session.workspace_id` 绑定。
- 路径解析使用 `path.resolve` + `realpath` 双重守卫，禁止 `../` 与符号链接逃逸。
- 根目录 `AGENTS.md` / `HIRA.md` / `.hira/AGENTS.md` 作为运行时项目指令加载，限制 12K 字符，文件变化自动刷新。
- 项目指令进入对话尾部隐藏上下文，不塞进稳定 system prompt，避免击穿缓存前缀。

### 3.2 文件与命令工具

文件：`apps/app-main/plugins/ai/core/local-tools.cts`

| 工具 | 能力 | 风险 |
|---|---|---|
| `workspace_open/use/list/current` | 选择、绑定、读取工作区 | read |
| `file_list` / `file_search` | 目录浏览、文件名与文本搜索 | read |
| `file_read` | 带行号分页读取 | read |
| `file_write` | 原子创建/覆盖文本文件 | write + approval |
| `file_edit` | 多组精确替换，一次原子提交 | write + approval |
| `file_mkdir/move` | 目录与路径整理 | write + approval |
| `file_delete` | 文件删除；目录需 recursive | destructive + approval |
| `shell_run` | `command + args[]`，工作区 cwd，超时/取消/输出裁剪 | destructive + approval |

- 自动拒绝 `.env`、私钥、凭据文件等明显敏感目标。
- 搜索跳过 `.git`、`node_modules`、`.pnpm-store`、缓存与构建目录，不跟随符号链接。
- 文件读取默认 2MB、写入 4MB，搜索结果和 shell 输出均有硬上限。
- `shell_run` 不接收 shell 拼接字符串；Windows `.cmd/.bat` 由 infra-process 安全包装，参数逐项引用，拒绝换行与命令解释字符。

### 3.3 Office

文件：`apps/app-main/plugins/ai/core/office.cts`

- `office_read`：
  - DOCX：`word/document.xml` 文本与段落；
  - XLSX：sharedStrings、inline strings、数值、布尔和多工作表；
  - PPTX：按页提取文本；
  - PDF：pdfjs-dist 文本层，限制页数。
- `office_create_document`：Markdown 结构 → DOCX 段落。
- `office_create_workbook`：多 sheet + 文本/数字/布尔类型 → XLSX。
- `office_create_presentation`：标题 + 要点 → 基础 PPTX。
- 拖入/`@` 引用的 Office/PDF 文件也会在主进程提取文本，不让渲染层接触二进制解析。
- 生成与提取不依赖本机 Word / Excel / PowerPoint。

### 3.4 Agent 行为

- 先确认工作区，再搜索、分段读取、编辑、验证。
- 简单问题先给结论；复杂代码/办公任务才结构化展示。
- 写入只有拿到成功工具结果后才能说“已完成”。
- 工具过程与最终答案分层：工具卡显示命令、路径、stdout/stderr、读取结果和生成文件。
- 工具卡对本地文件、搜索、命令和 Office 使用结构化摘要，不再把长 JSON 直接摊开。

## 4. 安全边界

- 工作区之外的路径默认不可访问。
- 文件写入、命令执行、删除全部进入现有一致性审批与审计。
- 审批模式 `allow` 可放行普通写入，但 `shell_run` / `file_delete` 声明为 destructive，仍需单独确认或“始终允许”。
- 页面与文件内容继续作为不可信输入包裹；不能改变系统规则。
- 不宣称系统级 sandbox：命令以当前用户权限运行，工作区是路径边界与审批边界，不是 OS 级隔离容器。

## 5. 后续

1. 为工具加入 `isConcurrencySafe(args)`，只并行纯查询，写操作保持独占屏障。
2. 增加 DOCX/XLSX/PPTX 的格式化编辑，而不只是读取与重建。
3. 增加压缩检查点 UI、上下文压力与缓存命中可视化。
4. 支持多工作区挂载与按任务切换。
5. 为代码任务加入结构化 diff 检查与回滚入口。

## 6. 参考

- OpenAI Tools: <https://developers.openai.com/api/docs/guides/tools>
- OpenAI Codex Sandbox: <https://learn.chatgpt.com/docs/sandboxing>
- Claude Code Agent Loop: <https://code.claude.com/docs/en/how-claude-code-works>
- Claude Code Context: <https://code.claude.com/docs/en/context-window>
- Claude Code Prompt Caching: <https://code.claude.com/docs/en/prompt-caching>
- DeepSeek Harness: <https://github.com/deepseek-ai/deepseek-harness>
