# STAR Hira NG · PART 10

## 让 AI 完整理解所有文档并按预期执行的保障手册

## —— 契约行 + 必读块格式规范 + 5 层执行校验 + 3 套启动 Prompt 模板

生成时间: 2026-01-04
前置文档: PART1~PART9（尤其 PART9 §0 防误读 + PART8 UI 三铁律 + PART7 Provider-Service + PART3 4 层架构）

# ⚠️ 本文件就是 AI 启动会话的「总开关」——任何人和 AI 助手开始工作前，先读本文件再动手。⚠️

---

=========================================
10.0 先破题：为什么 AI 明明看了文档还是会"瞎写/漏功能/违反约束"？
=========================================

这不是"AI 不认真"，是 3 个结构性缺陷导致的，必须从格式和流程上堵：

缺陷 1：优先级淹没。11 份文档 4,300+ 行放在上下文里，"UI 不大改"这种最高级优先级，会被"Zod schema 怎么写"这种具体细节淹没 → AI 只记得最近几行，忘了最高指令。
缺陷 2：缺少可验证的硬约束。文档写了"保真 5 级锁" → AI 觉得"意思一下"就行，没有**强制要求它回答"你本次代码 L1 映射了哪几个 ID"**。
缺陷 3：上下文截断。会话拉长到 10+ 轮后，早期的 PART9 §0 防误读（npm 库不重写）可能已经不在上下文窗口里 → AI 又开始"自作主张重写 electron-chrome-extensions"。

解决方案：本文件规定的 **4 层保障 + 5 层校验**，从文档格式 → Prompt → 上下文注入 → 执行自检层层嵌套，不是靠 AI "自觉"。

=========================================
10.1 Layer 1：所有文档必须加入的 3 类「AI 强制识别锚点」
=========================================

**只有把格式写对了，AI 才会把它们当"硬约束"而不是"建议"。** 这 3 类标记必须出现在 PART1~PART10 每份文档的对应位置。后续执行 PART8 Day1 前先把这一步扫完。

--- 10.1.1 契约行（Contract Lines）：每个核心规则 = 一行不可协商的断言格式

# 写法格式（必须严格按此格式，不能改措辞）：

# [CONTRACT-XX] 规则内容。任何与本契约冲突的操作 → 立即 STOP，输出「违反 CONTRACT-XX：xx」并报告，不要瞎做。

# XX = 两位数字，全局唯一，PART10 统一分配编号。

# 本项目目前定义的 20 条最高级 CONTRACT（任何 AI 执行任何任务时，必须全部在上下文中）：

[CONTRACT-01] 「不耦合不依赖原本」仅指不依赖旧系统 v7.5.0 自写代码/构建脚本/全局函数/自写 IPC。A 档 npm 库（PART9 §9.0 A 档）锁同版本不重写。
[CONTRACT-02] UI 像素一致性优先级高于架构优化。任何写代码导致 UI 快照 <95% 匹配 → 先回滚代码修快照，架构再优雅也让路。
[CONTRACT-03] 保真 5 级锁的 L1：写任何 Provider/业务代码前，必须先列出 本次功能映射的 L1 功能点 ID（F-XXXX 或 C-XXX），并说明覆盖对应断言。
[CONTRACT-04] 所有 IPC 消息和 Provider 返回值必须有 Zod Schema。无 Zod 契约 = 代码不合格，不通过。
[CONTRACT-05] 0 个业务全局变量。任何 window.xxx = 业务对象 / global.xxx = 业务对象 → 代码不合格。
[CONTRACT-06] 窗口创建必须走 infra-window/WindowFactory 唯一入口。任何直接 new BrowserWindow() → 不合格。
[CONTRACT-07] 8 个 side-panel 插件必须声明 dependsOn side-panel-skeleton。不装骨架就装面板 → 启动期必须报错。
[CONTRACT-08] Ctrl+W 关闭最后 1 个标签时 = 关标签并加载 about:blank，**不能关闭窗口**。pinned 标签 Ctrl+W 不关闭。
[CONTRACT-09] 标签 hover 出缩略预览 = 精确 700ms；Zen rail hover 展开 = 精确 1000ms；side rail 判定区 = 外扩 16px。
[CONTRACT-10] Chrome 扩展兼容 = §9.0 A 档 electron-chrome-extensions@4.9.4 原库；拦截 = @ghostery/adblocker-electron 原库。任何提议重写这两个 = 违反 CONTRACT-01 + 10。
[CONTRACT-11] 4 层依赖方向：APPS → UI COMPONENTS → DOMAIN → INFRASTRUCTURE。任何反向依赖（domain import ui 组件等）= 代码不合格。
[CONTRACT-12] Provider-Service 洋葱模型 4 Hook 顺序 = before → validate → around → after。任何改顺序 = 不合格。
[CONTRACT-13] 存储必须走 infra-db SQLite + Drizzle 事务。任何直接写 IndexedDB / Dexie = 不合格。
[CONTRACT-14] npm 依赖迁移严格按 PART9 §9.0 A/B/C 三档。A 档列表外的任何库 → 必须单独写 RFC 评审。
[CONTRACT-15] 1,234 功能点映射覆盖率必须 100%（`pnpm fn:coverage`）。任何缺失 = 发布闸门不过。
[CONTRACT-16] Ctrl+Shift+T 恢复标签 = 到**原来的位置**，不是追加到末尾。
[CONTRACT-17] 地址栏选中文字后 Ctrl+Enter = 自动包装为 `www.{文字}.com`。
[CONTRACT-18] 关闭窗口红按钮 = 隐藏到托盘，不退出进程。
[CONTRACT-19] 存储迁移适配器 8 个：4 种数据集 (empty/2k bookmark/100k history/regression) 必须 100% 通过。
[CONTRACT-20] 任何代码提交前必须：①跑 pnpm fn:coverage 100% + ②pnpm plugin:coverage 100% + ③pnpm test:ui-snapshot ≥95%。任一不通过 = 不允许提交。

→ 使用方法：每份文档的**第一页可见位置**（PART3 写架构前 / PART4 写存储前）放对应的 CONTRACT 锚点。每次 AI 启动 Prompt 里把这 20 行全部贴上。

--- 10.1.2 必读块（MUST-READ Blocks）：任何任务开始前必须先过的交叉文档块

# 写法格式：

<!-- MUST-READ: <文档编号> §<章节号>「<一句话说明为什么必读>」 -->
<!-- FAIL-TO-READ-RISK: <不读会犯什么具体错误> -->

# 例子（做 UI 任务前 AI 必须能看到这两行）：

<!-- MUST-READ: PART8 §8.1「UI 像素冻结三铁律：基线快照 / CSS Tokens / pixelmatch ≥95%」 -->
<!-- FAIL-TO-READ-RISK: 你会自行"美化" UI 加动画/改颜色，导致快照差异率 >20% 然后返工 -->

# 例子（做 Provider 代码前 AI 必须看到）：

<!-- MUST-READ: PART7-Addendum §7.14「Provider 洋葱 4 Hook 顺序 + Wrapper 调用栈」 -->
<!-- FAIL-TO-READ-RISK: 你会把 validate 放在 around 后面，破坏 Mod 介入顺序，导致连环崩溃 -->

# 例子（做 npm 依赖/插件/拦截代码前 AI 必须看到）：

<!-- MUST-READ: PART9 §0 零号防误读 + §9.0 A/B/C 三档依赖分类 -->
<!-- FAIL-TO-READ-RISK: 你会"自作聪明"重写 electron-chrome-extensions 或 adblocker 导致保真直接失败 -->

--- 10.1.3 禁止指令块（DO-NOT Blocks）：明确告诉 AI 什么不要做（它很爱"发挥"）

# 写法格式（越具体越好，不要"别破坏体验"这种空话）：

<!-- DO-NOT: <具体禁止行为 1> -->
<!-- DO-NOT: <具体禁止行为 2> -->
<!-- DO-NOT-REASON: <为什么这些禁止的东西不能做 + 对应 CONTRACT> -->

# 例子（做 Ctrl+W 关闭标签前）：

<!-- DO-NOT: 最后 1 个标签时直接关闭 BrowserWindow / quit() 进程 -->
<!-- DO-NOT: pinned 标签触发关闭动作 -->
<!-- DO-NOT: 关闭标签后自动选中右边的标签（原版是左边相邻） -->
<!-- DO-NOT-REASON: CONTRACT-08 明确规定的保真 L2 行为集，偏差 = L5 双轨测试直接 FAIL -->

=========================================
10.2 Layer 2：AI 启动 Prompt 3 套模板（每次新开会话**必须从这些模板开始**，不要自由发挥）
=========================================

**3 套模板分别对应最常见的 3 种工作流场景。把它们贴在会话最开头的用户消息里（不是系统提示，用户消息权重更高）。**

--- 模板 A：项目总框架启动 Prompt（第一次开始工作 / 新换模型 / 换会话时用）

```
# STAR Hira NG · 会话启动 · 模型角色契约 + 优先级 + 必读
## 你现在的身份：STAR Hira NG 重写项目的代码 & 规划助手
## 工作目标：执行 PART8 21 周计划；产出 NG 43 包 monorepo；按保真 5 级锁 1:1 还原 Hira v7.5.0 全部功能

# ⚠️ 优先级阶梯（任何冲突时按下面顺序，高优先级一票否决低优先级）
  P0 (铁): [CONTRACT-01~20] 共 20 条契约行（见本 Prompt 下方）
  P1 (硬): PART8 UI 像素冻结三铁律（快照/Tokens/pixelmatch ≥95%）
  P2 (硬): PART9 保真 5 级锁（L1~L5）
  P3 (常): PART3 4 层架构 + PART4 统一存储 + PART5 阶段闸门
  P4 (软): 代码整洁 / 架构优美 / 你自己的"最佳实践"
# → 记住：P4 永远可以为 P0-P2 让路。不要为了"代码整洁"违反 P0 契约。

# ⚠️ 20 条 CONTRACT（P0 铁则，任何一个违反立即停止输出并说明）
[CONTRACT-01]「不耦合不依赖原本」仅指不依赖旧系统 v7.5.0 自写代码/构建脚本/全局函数/自写 IPC。A 档 npm 库（PART9 §9.0 A 档）锁同版本不重写。
[CONTRACT-02] UI 像素一致性优先级高于架构优化。任何写代码导致 UI 快照 <95% 匹配 → 先回滚代码修快照。
[CONTRACT-03] 写任何 Provider/业务代码前，必须先列出本次功能映射的 L1 功能点 ID（F-XXXX 或 C-XXX）并说明覆盖断言。
[CONTRACT-04] 所有 IPC 消息和 Provider 返回值必须有 Zod Schema。无 Zod 契约 = 代码不合格。
[CONTRACT-05] 0 个业务全局变量。任何 window.xxx = 业务对象 / global.xxx = 业务对象 → 不合格。
[CONTRACT-06] 窗口创建必须走 infra-window/WindowFactory 唯一入口。任何直接 new BrowserWindow() → 不合格。
[CONTRACT-07] 8 个 side-panel 插件必须声明 dependsOn side-panel-skeleton。
[CONTRACT-08] Ctrl+W 关闭最后 1 个标签时 = 关标签并加载 about:blank，不能关闭窗口。pinned 标签 Ctrl+W 不关闭。
[CONTRACT-09] 标签 hover 预览=700ms；Zen rail hover 展开=1000ms；side rail 判定区=外扩 16px。
[CONTRACT-10] Chrome 扩展兼容 = §9.0 A 档 electron-chrome-extensions@4.9.4 原库；拦截 = @ghostery/adblocker-electron 原库。任何提议重写这两个 = 违反 CONTRACT-01+10。
[CONTRACT-11] 4 层依赖方向：APPS → UI → DOMAIN → INFRA。任何反向 = 不合格。
[CONTRACT-12] Provider 4 Hook 顺序 = before → validate → around → after。
[CONTRACT-13] 存储必须走 infra-db SQLite + Drizzle 事务。任何直接 Dexie/IndexedDB = 不合格。
[CONTRACT-14] npm 依赖迁移严格按 PART9 §9.0 A/B/C 三档。
[CONTRACT-15] 1,234 功能点映射覆盖率必须 100%（pnpm fn:coverage）。
[CONTRACT-16] Ctrl+Shift+T 恢复标签 = 到原来的位置，不是追加到末尾。
[CONTRACT-17] 地址栏选中文字后 Ctrl+Enter = 自动包装为 www.{文字}.com。
[CONTRACT-18] 关闭窗口红按钮 = 隐藏到托盘，不退出进程。
[CONTRACT-19] 8 个存储迁移适配器 4 种数据集必须 100% 通过。
[CONTRACT-20] 任何代码提交前必须通过 fn:coverage=100% + plugin:coverage=100% + ui-snapshot≥95%。

# ⚠️ 你现在要执行的任务：<把本次具体任务写在这里，例如 "执行 PART8 S0 Week1 Day1：生成 1A-STAR_Hira_NG 根 monorepo package.json + workspace 配置 + 43 包目录骨架">

# ⚠️ 执行前你必须做的第一件事（输出给我看）：
1. 用一段话复述本次任务的目标（确认你理解对了）
2. 列出本次任务会**直接涉及或影响**哪些 CONTRACT（至少编号，不确认 = 你没读懂）
3. 列出本次任务对应 L1 功能点 ID（F-XXXX / C-XXX 至少编号；如果属于 S0 脚手架无功能点，就明确写「S0 基础设施类 / 不涉及功能点」）
4. 列出哪些 MUST-READ 文档章节你会参考
—— 以上 4 条先写出来，我确认 / 修正后，你再开始动手写代码或改文档。任何跳过这 4 条直接输出代码 = 不合格输出，我会拒绝。

# ⚠️ 输出完代码/文档后你必须做的 5 层自检（见 §10.4）：
依次回答 CONTRACT 检查 → L1 覆盖检查 → 快照/保真检查 → 依赖检查 → 风险检查。
```

--- 模板 B：代码编码任务 Prompt（在已启动的会话里追加一个具体编码任务时用）

```
## 编码任务
任务名称: <例如：domain-tabs Provider 16 个方法 + Zod 契约>
目标文件: <绝对路径，例如 1A-STAR_Hira_NG/packages/domain-tabs/src/TabServiceProvider.js>
前置依赖: <已完成哪些工作可以在此基础上，例如 "S0 脚手架已完成、infra-plugin/PluginRegistry.js 已完成">
L1 功能点范围: <必须列本次要覆盖的 F-XXXX/C-XXX，例如 F-0070~F-0098 共 28 个标签管理功能点，C-001/C-003/C-019>
CONTRACT 关注: <列出本次特别要注意的 CONTRACT，例如 CONTRACT-03/04/05/08/12>
MUST-READ: <必须读的文档章节，例如 PART7-Addendum §7.15 Provider 洋葱实现；PART9 §9.2 L2 Ctrl+W 行为>
DO-NOT: <本次具体禁止事项，例如 DO-NOT: 出现 window.tabs 全局 / DO-NOT: Ctrl+W 最后标签关窗>

## 验收标准（AI 输出后必须逐条满足）
[ ] 所有 28 个 F-XXXX 有映射说明
[ ] 每个 Provider 方法 before/validate/around/after 4 Hook 齐全
[ ] Zod Schema 文件与 Provider 同目录，文件名 <Method>Schema.js
[ ] 本次修改不引入 window.xxx 业务全局
[ ] 不出现 new BrowserWindow() 裸调用
[ ] 依赖方向检查：本包只 import infra-* 与 shared-*，不 import ui-* 或 apps-*

## 再次提醒：先输出 任务复述 + CONTRACT 列表 + L1 ID 列表 → 我确认后你再写代码。
```

--- 模板 C：UI 像素保真任务 Prompt（写任何 UI 组件前必须用）

```
## UI 组件任务
组件名称: <例如：ui-tabbar 标签栏组件>
前置基线快照路径: docs-ng/ui-baseline/v7.5.0/tabbar/（共 25 张：浅 13 + 深 12）
CSS Tokens 来源: shared-ui-tokens/src/colors.js + spacing.js（PART8 §8.1 铁律 2，禁止硬编码任何颜色/像素）
L1 功能点 + 交互: <例如 C-001 双击空白新建 / C-003 恢复原位 / CONTRACT-09 700ms 预览>
CONTRACT 关注: CONTRACT-02 > CONTRACT-03 > CONTRACT-09

## 验收铁律（不满足 = 直接返工不需要问）
[ ] 组件 CSS 里没有任何硬编码的 #xxxxxx 颜色值，全部 var(--token-*)
[ ] 组件 CSS 里没有任何硬编码的 margin:8px / padding:4px，全部 var(--spacing-*)
[ ] 组件 HTML 结构语义自由（可以 Web Components），但 getComputedStyle 下关键视觉元素：
    - tabbar 容器高度 = var(--tabbar-height) = 42px（和基线一致）
    - 激活标签底部高亮条高度 = var(--tab-active-indicator-h) = 3px
    - 标签 左右内边距 = var(--spacing-3) = 12px
[ ] 700ms hover 预览 = 常量化引用 InteractionTokens.TAB_PREVIEW_DELAY_MS，不是 setTimeout(700) 硬编码数字
[ ] pixelmatch 对比 25 张基线快照，平均匹配率 ≥95%。<95% 你自己先改，改到 95%+ 再输出。

## 再次提醒：
先输出「你打算如何逐个满足上面 5 条验收铁律」+ 列用到的 tokens 清单 → 我看 OK 你再写 CSS。
不要先写代码再等我指出"颜色写死了"。像素三铁律写在启动契约里，违反 = 返工。
```

=========================================
10.3 Layer 3：上下文注入机制 —— 保证会话拉长后 P0 契约不被"遗忘"
=========================================

会话长了（>8 轮）之后，开头的 20 条 CONTRACT 可能已经被模型"推"出窗口了。解决方法不是靠更长上下文，是**每一轮都用「宪法级 12 行超精简版」反复注入**。

--- 10.3.1 宪法精简版（固定 12 行 ≈250 字，放在每轮追加消息末尾 / 或项目系统提示里）

```
## STAR Hira NG · 宪法 12 条（每轮重新确认，忘记任一条 = 输出不合格）
C01 不碰旧系统自写代码，A 档 npm 库锁版本不重写 | C02 UI 像素快照 ≥95% 一票否决架构
C03 写功能前列 L1 F-XXXX/C-XXX 映射 ID       | C04 IPC/Provider 强制 Zod
C05 0 业务全局 window.xxx                    | C06 WindowFactory 唯一入口
C07 面板 dependsOn side-panel-skeleton       | C08 Ctrl+W 最后标签→about:blank 不关窗
C09 三个阈值: 预览700ms / Zen展开1000ms / rail判定16px  | C10 electron-chrome-extensions@4.9.4 + adblocker-electron 原库
C11 4 层单向依赖 APPS→UI→DOMAIN→INFRA         | C12 Provider 4 Hook = before→validate→around→after
```

--- 10.3.2 项目记忆文件（建议放在 1A-STAR_Hira_NG/.hira-ai/constitution.md，每次让 AI 先读）

# 结构建议：

.hira-ai/constitution.md = 上面 20 条 CONTRACT + 宪法 12 行
.hira-ai/contract-index.json = { "CONTRACT-01": "文档位置", ... } 机器可读
.hira-ai/current-milestone.md = 当前里程碑（如 "M0 W2 空壳版：目标: 空窗口 + DRM + 快照95%"）
.hira-ai/l1-coverage-tracker.json = 1,234 功能点当前覆盖率：{ "F-0001": "domain-tabs v0.3 done", ... }

# 任何会话开始第一步：让 AI 先 Read 这 4 个文件（L1 tracker 尤其重要，防止重复做同样 Provider）

=========================================
10.4 Layer 4：执行后 5 层自检清单（AI 输出完代码，必须**按下面格式逐条过一遍回答**，不答 = 不合格）
=========================================

```
## ⚠️ AI 自检报告 · 请输出代码后 **立刻回答下面 5 层 17 问**，回答 Yes/No/部分+原因，不能跳过

### 第 1 层 · CONTRACT 20 条检查（Yes = 完全没违反 / No = 指出哪条 + 怎么修）
[C01] 我没有 import 旧系统 v7.5.0 任何自写代码，也没有重写 PART9 A 档 npm 库？ Y/N
[C02] 我本次修改没有引入任何可检测的 UI 像素漂移（如硬编码颜色/尺寸），或已在 CSS Tokens + 快照报告中注明？ Y/N
[C03] 我在输出开头已列出本次 L1 F-XXXX/C-XXX 功能点 ID 映射？ Y/N
[C04] 所有 IPC 消息和 Provider 返回值都有 Zod Schema 文件？ Y/N
[C05] grep "window\." 本次改动文件 → 只找到 DOM API，没有业务对象？ Y/N
[C06] grep "new BrowserWindow" 本次改动 → 0 个裸调用？ Y/N
[C07] side-panel 插件有 dependsOn side-panel-skeleton？（不涉及则 N/A）
[C08] Ctrl+W 行为完全符合 CONTRACT-08？（不涉及则 N/A）
[C09] 阈值常量引用 InteractionTokens 而不是数字字面量？ Y/N
[C10] 扩展/拦截功能使用的是 A 档原库？（不涉及则 N/A）
[C11] 4 层依赖方向检查通过？（grep imports: domain 不 import ui / apps） Y/N
[C12] Provider 4 Hook 顺序 before → validate → around → after？ Y/N
[C13] 存储操作全走 infra-db drizzle schema，无 Dexie/IndexedDB 直接写？ Y/N
[C14] 新增依赖 = PART9 A 档内？新增不在 A 档已单独列 RFC？ Y/N
[C15] 运行 pnpm fn:coverage，本次涉及功能点覆盖率 = 100%？ Y/N
[C16~18] 相关具体行为（C-016 原位恢复 / C-017 Ctrl+Enter / C-018 红按钮托盘）完全符合？ N/A / Y
[C19] 迁移适配器 4 种数据集通过？（不涉及则 N/A）
[C20] fn:coverage + plugin:coverage + ui-snapshot 三个闸门报告截图/文字？ Y/N

### 第 2 层 · L1 保真覆盖检查
涉及 L1 功能点总数：<N> 个（列出清单）
完全覆盖：<Y> 个 / 部分覆盖：<P> 个 / 未覆盖：<U> 个
未覆盖原因与补救计划：

### 第 3 层 · UI 像素保真检查（非 UI 任务填 N/A）
快照总数：<例如 25>
平均匹配率：<例如 96.3%>
<95% 的快照是哪几张：<列出，若无填 None>
打算怎么修 <95% 的：

### 第 4 层 · 依赖方向 & npm 库三档检查
新增 import 路径：<列出全部新增>
反向依赖检查（APPS←UI←DOMAIN←INFRA，有没有反向 import）：
新增/修改的 npm 依赖：<name@version>，属于 A/B/C 哪一档：
是否提交了 RFC 如果新增依赖不在 A 档：Y/N

### 第 5 层 · 风险与回滚检查（PART6 风险矩阵 15 条里相关的）
本次改动可能触碰的 PART6 P0~P2 风险 ID（如 P0-01 / P0-02）：
回滚步骤（出错时怎么一键回到改动前状态，例如 "revert commit a1b2c3"）：
是否需要在 current-milestone.md 更新进度百分比：Y/N
```

=========================================
10.5 Layer 5：模型分工 Map + 不同模型的 Prompt 差异化小技巧
=========================================

对应 PART9 模型建议。不同模型对 Prompt 格式敏感度不一样，下面微调：

| 模型                       | 最适合任务                                                  | Prompt 差异化技巧                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.2 / o3 系列          | 全部 60% 主力任务（尤其是 CONTRACT 03/04/11/12 架构规则类） | 把 CONTRACT 20 条放在**用户消息的第一个代码块最开头**（不要塞到系统提示末尾）；它对长 P0 列表记忆力最强。                                                                                                         |
| Claude 3.7 级              | UI CSS 像素 / Playwright E2E L5                             | 它对"像素细节"比 GPT 更稳；模板 C 验收铁律的数值（ΔE≤3、pixelmatch 95%、42px）**写在 Prompt 第一段**，它会严格遵守；但 CONTRACT 列表不用给太长，12 条宪法精简版就够。                                             |
| Kimi K3 级（长上下文）     | PART1 源码审计 / L1 1,234 功能点扫描 / 测试用例批量生成     | 它吃长文本最强；模板 A 的 CONTRACT 列表也给，但要加一句「**你的首要目标是不要漏掉任何一个功能点，不是让代码漂亮**」（不然它会过度抽象漏掉边角）；适合一次性 parse 50 个旧系统 .js 文件产出 F-0001~F-1234 映射表。 |
| 轻量模型（GPT-4o-mini 级） | L1 tracker 数据维护 / 文件移动 / 简单脚本                   | **绝对不要让它碰核心代码**，只让它做文件搬运 + 更新 .hira-ai/l1-coverage-tracker.json 这种体力活；模板里只给具体步骤不给原则。                                                                                    |

=========================================
10.6 最后：最容易导致 AI "乱来"的 5 种错误 Prompt 写法（对照检查，你有没有犯）
=========================================

错 1："帮我写个书签管理器" —— 没有 L1 F 号、没有 CONTRACT、没有验收标准 → AI 必然自由发挥，八成重写 electron-chrome-extensions 或 Dexie。
对 1：用模板 B，明确 F-0001~F-0030，C-013 隔离，验收 6 条。

错 2："你觉得怎么实现好就怎么实现" —— 大忌！AI 会把保真优先级让给它的"最佳实践"，UI 马上变漂亮 20% 像素全偏。
对 2：模板 A 第一行就把「P0-CONTRACT > P1-UI > P2-保真 > P4-整洁」写死，让它知道"你的最佳实践排在第 4 优先级"。

错 3：会话拉长 15 轮后没重新注入宪法 12 条 → AI 忘了 CONTRACT-08，Ctrl+W 最后标签真把窗口关了。
对 3：每做一个新子任务（>8 轮）就重新贴一次模板 B / C 开头 + 宪法 12 条代码块。不重贴等于裸奔。

错 4：允许 AI "先写代码再慢慢对齐快照" —— 它永远不会"慢慢"对齐，写出来的 CSS 就偏了。
对 4：模板 C 的铁律第 1~2 条：**CSS Tokens 不允许硬编码**，这条是提交前就必须满足的，不是"之后再改"。

错 5：没有让 AI 在输出前 / 输出后做 2 次自检（10.2 里"执行前先复述 4 条" + 10.4 里"输出后回答 17 问"）。
对 5：这两次自检是低成本高回报的保险，1 分钟自检时间省 30 分钟返工。不要偷懒。

--- EOF ---
