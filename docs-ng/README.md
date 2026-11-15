# STAR Hira NG · 完全大换血重写 + 启动执行计划 总文档索引

> 文档总数: **16 份**（PART1–PART12 + PART7-Addendum + 本 README；PART12 有两份不同主题）
> 目录: [docs-ng/](file:///e:/Desktop/OTHER/1A-STAR_Hira/docs-ng/)

> **状态提示（2026-09）**：PART12 的两份重构方案中，网页视图/chrome 归一、声明式图层与焦点仲裁、菜单归属、退出状态机（P1–P4）**均已完成**；命令面板、原生应用菜单、内容拦截、标签缩略图、光标边缘唤出等亦已落地。详见各自文档内的「落地状态」批注与 `1A-STAR_Hira_NG/docs/gap-vs-hira.md`。

> **新增规划（2026-11）**：编辑模式将升级为统一的积木式 Layout Studio。设计入口见
> [编辑模式重构/README.md](编辑模式重构/README.md)，覆盖现状/Shift 对照、数据契约、
> 交互视觉规范、连续实施清单与 PART19 性能门禁映射。

---

## 四份「自检结论」放在最前面

### 自检 1：Mod 接口在每一个功能接口位置 & 内部功能完全插件化？

→ **✓ YES（PART7 + Addendum 合计 1,264 行实现）**
Provider-Service 洋葱模型：11 领域 **168 个 Provider × 4 级钩子(before/validate/around/after) = 672 功能入口**；
INFRA 接口再补 200 个；自动化工具 `pnpm plugin:coverage` 要求覆盖率必须 **100%** 才允许发布。
详细: [PART7-Addendum §7.14~7.20](PART7-Addendum-%E5%86%85%E9%83%A8%E5%8A%9F%E8%83%BD%E6%8E%A5%E5%8F%A3%E7%BA%A7Mod%E5%8C%96%E5%85%A8%E8%A6%86%E7%9B%96-ProviderService%E7%9F%A9%E9%98%B5.md)

### 自检 2：如何具体重写？UI 不大改的约束怎么落地？

→ **PART8 (545 行) 逐周逐天地回答**：

- **UI 像素冻结三条铁律强制执行**：基线 100 快照库 + CSS Tokens 禁硬编码 + 每组件 pixelmatch ≥95%
- **Day1-Day5 具体 12 件事 + bat 脚本**：复制粘贴就能启动重写
- **Week 1~21 (5 个月) 逐周交付 + 验收**：每周明确产出、UI 像素检查点
- **6 级里程碑 M0~M5**：每一级都能打开实际浏览器用，不是纸上谈兵
- **UI 不大改每周流程**：周一先修快照差异 → 周三写逻辑 → 周五快照报告
- **附录 A UI 100 快照矩阵**：Day1 要拍的 100 张图完整分类
  详细: [PART8 §8.0~8.5 + 附录 A](PART8-%E5%90%AF%E5%8A%A8%E9%87%8D%E5%86%99%E9%80%90%E5%91%A8%E6%89%A7%E8%A1%8C%E8%AE%A1%E5%88%92-UI%E5%83%8F%E7%B4%A0%E5%86%BB%E7%BB%93%E4%B8%89%E9%93%81%E5%BE%8B.md)

### 自检 3：为什么不在现有基础改？怎么保证细小功能不丢 + 原版体验 1:1？

→ **PART9 开头直接钉「零号防误读声明 + §9.0 依赖 A/B/C 三档分类」，任何人/模型读了不会误解**：

- **⚠️ 防误读铁定义**："不耦合不依赖原本" = 不依赖旧系统**自写的**66 个全局函数/6 套构建脚本/187 DOM 耦合（§9.0 B 档全重写）；**≠ 重写 npm 库**
- **A 档 70% npm 库全保留锁同版本**：插件兼容 electron-chrome-extensions@4.9.4 / 弹窗拦截 @ghostery/adblocker-electron / pdfjs-dist / 拖拽 sortablejs+dragula / 地址栏打分 quick-score / 离线翻译 bergamot 等 —— 行为敏感库换 = 保真失败，**一个都不动**
- **C 档 8 个 npm 库明确替换**：只换架构原因消失的（Dexie→SQLite、deasync 炸弹废弃、Browserify EOL→vite、standard→ESLint），明确标注"不是库不好是场景没了"
- **保真 5 级锁自动化**：L1 1,234 功能点映射 / L2 行为 1:1 / L3 交互常量精确值 / L4 126 边角功能清单 / L5 双轨 Playwright 对照测试
- **底层 7 换 / 体验 8 不换 精确化**：每条后面都加了与 §9.0 A 档冲突时以 A 档为准的交叉引用
  详细: [PART9 §0 零号声明 + §9.0 A/B/C 三档 + §9.1~9.4](PART9-%E4%B8%BA%E4%BB%80%E4%B9%88%E4%B8%8D%E5%9C%A8%E7%8E%B0%E6%9C%89%E5%9F%BA%E7%A1%80%E6%94%B9-%E5%85%A8%E5%8A%9F%E8%83%BD%E4%BF%9D%E7%9C%9F%E4%BA%94%E7%BA%A7%E9%94%81-%E5%BA%95%E5%B1%827%E6%8D%A2%E4%BD%93%E9%AA%8C8%E4%B8%8D%E6%8D%A2.md)

### 自检 4：怎么让 AI（任何模型）完整读文档并按预期执行，不瞎发挥不漏约束？

→ **PART10 (289 行) 4 层执行保障，把「AI 不认真读」变成「格式+流程逼它读」**：

- **⚠️ L1 文档格式改造**：20 条 P0 级 `[CONTRACT-XX]` 硬断言（C01 不重写A档库 / C02 UI快照一票否决 / C03 写功能先列F号 / C08 Ctrl+W最后标签→about:blank / 等20条）+ MUST-READ 交叉引用块 + DO-NOT 具体禁止项，每类都有固定格式，AI 读到格式就知道不是"建议"是"铁律"
- **L2 三套可直接复制的 Prompt 模板**：模板 A（新项目/新模型启动）+ 模板 B（编码任务）+ 模板 C（UI像素保真任务）。每套都强制「先复述任务+列CONTRACT+列L1 ID+列MUST-READ，我确认后你再动手」，否则直接拒绝输出
- **L3 上下文注入机制**：「宪法 12 行精简版（250字）」>8 轮每轮重贴 + `.hira-ai/` 4 个记忆文件（constitution/contract-index/current-milestone/l1-coverage-tracker）会话开头必 Read
- **L4 执行后 5 层 17 问自检清单**：AI 输出代码后必须逐条 Y/N 回答（20条CONTRACT/L1覆盖率/快照匹配率/依赖方向/回滚），不答 = 不合格输出
- **L5 模型差异化技巧 + 最常见 5 大坑正反对照**：不同模型（GPT/Claude/Kimi）最敏感的 Prompt 贴法不同；还列了"帮我写个书签管理器" / "你觉得怎么好就怎么实现" 这 5 种必出错的 Prompt 写法以及正确写法
  详细: [PART10 §10.0~10.6 3套完整Prompt模板可直接复制](PART10-AI%E7%90%86%E8%A7%A3%E6%89%A7%E8%A1%8C%E4%BF%9D%E9%9A%9C%E6%89%8B%E5%86%8C-%E5%A5%91%E7%BA%A6%E8%A1%8C%E5%BF%85%E8%AF%BB%E5%9D%975%E5%B1%82%E8%87%AA%E6%A3%803%E5%A5%97Prompt%E6%A8%A1%E6%9D%BF.md)

---

## 文档关系（阅读路径，避免断档）

```
PART1–13 底盘/纪律  →  PART14 差距速查  →  PART15 逐项详解  →  PART17 定做法(加法/砍项)  →  PART16 profile 维度  →  PART18 工程红线
```

> ⚠ **PART14–PART18 已迁至 [`1A-STAR_Hira_NG/docs-new/`](../1A-STAR_Hira_NG/docs-new/) 并改为数字前缀文件名**（`1-`…`5-`）。下表 16–20 行即其新位置。

- 冲突仲裁：**做法看 PART17 · profile 看 PART16 · 实现约束看 PART18 · 底盘纪律看 PART1–13**。
- 同一件事的编号索引（PART14 ↔ PART15 ↔ PART17）：见 [5-文档地图与工程红线.md §2](../1A-STAR_Hira_NG/docs-new/5-%E6%96%87%E6%A1%A3%E5%9C%B0%E5%9B%BE%E4%B8%8E%E5%B7%A5%E7%A8%8B%E7%BA%A2%E7%BA%BF.md)。
- 新增文档必须在地图登记并与上下游互链。

## 全部文档索引（文件名以实际磁盘为准）

| #   | 文件                                                                | 解决什么                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PART1-全库耦合检测矩阵.md                                           | 400 文件扫描 / 161 全局变量 / 11 P0 耦合清单                                                                                          |
| 2   | PART2-RT现代化架构抽取.md                                           | Flow 浏览器架构 10 条可学习模式                                                                                                       |
| 3   | PART3-NG四层架构设计与Monorepo清单.md                               | 4 层严格依赖 · 43 包 monorepo · IHiraModule 接口                                                                                      |
| 4   | PART4-统一存储SQLite-Drizzle设计.md                                 | 5 组 20+ 表 Schema · FTS5 · 8 适配器迁移                                                                                              |
| 5   | PART5-双轨开发10阶段路线图.md                                       | S0~S9 10 阶段 · 30 项最终发布闸                                                                                                       |
| 6   | PART6-风险矩阵验证清单回滚策略-附录.md                              | 15 风险 · 11 P0 grep 验证 · 3 层回滚防线                                                                                              |
| 7   | PART7-DeepSeekHarness风格插件系统-功能面板全插件化与社区ModSDK.md   | 4 级插件 · 面板前置依赖 · 社区 Mod SDK                                                                                                |
| 8   | **PART7-Addendum-内部功能接口级Mod化全覆盖-ProviderService矩阵.md** | Provider 洋葱模型 · **168 Provider=672 功能入口** · pnpm plugin:coverage · 2 个内部 Mod 实码 · INFRA 接口 Mod 化                      |
| 9   | **PART8-启动重写逐周执行计划-UI像素冻结三铁律.md**                  | **Day1-5 启动 12 事 · UI 像素冻结三铁律 · Week1~~21 逐周拆解 · 6 里程碑 M0~~M5 · 100 快照基线矩阵 · Day1 bat 脚本**                   |
| 10  | **PART9-为什么不在现有基础改-全功能保真五级锁-底层7换体验8不换.md** | **⚠️ 零号防误读声明 · 依赖 A/B/C 三档 · 死局与代价表 · 保真 5 级锁 · 底层 7 换·体验 8 不换**                                          |
| 11  | **PART10-AI理解执行保障手册-契约行必读块5层自检3套Prompt模板.md**   | **20 条 CONTRACT-P0 铁则 · MUST-READ/DO-NOT 锚点 · 3 套 Prompt 模板 · 5 层 17 问自检 · 模型差异技巧 · 5 大坑正反对照**                |
| 12  | **PART11-RT架构融入NG-webContents进程级隔离UI架构.md**              | RT webContents 架构融入 · 进程级隔离 · 面板热重启（**注：其「UI Shell 独立 WebContentsView」模型已被 PART12 的 P1 chrome 归一取代**） |
| 13  | **PART12-NG-vs-HiraRT-vs-wexond-全维度对比与重构蓝图.md**           | NG vs RT vs wexond 逐维度对比 · E1~~E4 架构错误 · D1~~D13 缺陷清单 · 阶段 A~F 蓝图（**已标注落地状态**）                              |
| 14  | **PART12-网页视图与菜单全维度对比与重构方案.md**                    | 网页视图/菜单对比 · F1~~F9 缺陷 · P1~~P4 重构（**P1–P4 均已落地**）                                                                   |
| 15  | NG文件夹浏览器开发.md                                              | NG 开发过程对话记录（历史存档，非状态文档）                                                                                           |
| 16  | [**1-创新功能差距盘点与插件化融合方案.md**](../1A-STAR_Hira_NG/docs-new/1-%E5%88%9B%E6%96%B0%E5%8A%9F%E8%83%BD%E5%B7%AE%E8%B7%9D%E7%9B%98%E7%82%B9%E4%B8%8E%E6%8F%92%E4%BB%B6%E5%8C%96%E8%9E%8D%E5%90%88%E6%96%B9%E6%A1%88.md) | **PART14 · NG vs Zen/Arc/Vivaldi/HiraRT 创新功能差距矩阵 · 插件化融合落点 · 「还缺什么」执行清单** |
| 17  | [**2-缺失创新功能逐项详解.md**](../1A-STAR_Hira_NG/docs-new/2-%E7%BC%BA%E5%A4%B1%E5%88%9B%E6%96%B0%E5%8A%9F%E8%83%BD%E9%80%90%E9%A1%B9%E8%AF%A6%E8%A7%A3.md) | **PART15 · 每个缺失创新功能"是什么 / 怎么玩 / 对标怎么做 / 为什么算创新 / NG 落点"** |
| 18  | [**3-空间与配置文件隔离现状与完全独立方案.md**](../1A-STAR_Hira_NG/docs-new/3-%E7%A9%BA%E9%97%B4%E4%B8%8E%E9%85%8D%E7%BD%AE%E6%96%87%E4%BB%B6%E9%9A%94%E7%A6%BB%E7%8E%B0%E7%8A%B6%E4%B8%8E%E5%AE%8C%E5%85%A8%E7%8B%AC%E7%AB%8B%E6%96%B9%E6%A1%88.md) | **PART16 · "每 profile 完全独立"（已定 L2 物理独立）：现状矩阵 · 键位划分 · 文件级 6 步计划** |
| 19  | [**4-功能重叠分析与做加法改造方案.md**](../1A-STAR_Hira_NG/docs-new/4-%E5%8A%9F%E8%83%BD%E9%87%8D%E5%8F%A0%E5%88%86%E6%9E%90%E4%B8%8E%E5%81%9A%E5%8A%A0%E6%B3%95%E6%94%B9%E9%80%A0%E6%96%B9%E6%A1%88.md) | **PART17 · 应"做加法"的 16 项 · overlay→panel 重估 · 重复/非必要不做 · 砍项 · RT 实码参考** |
| 20  | [**5-文档地图与工程红线.md**](../1A-STAR_Hira_NG/docs-new/5-%E6%96%87%E6%A1%A3%E5%9C%B0%E5%9B%BE%E4%B8%8E%E5%B7%A5%E7%A8%8B%E7%BA%A2%E7%BA%BF.md) | **PART18 · 文档地图 · ID 交叉索引 · 工程红线（性能/内存/卸载/闪烁/解耦）· 准入检查表 · 反模式** |
| —   | README.md                                                           | 本索引 + 4 份自检结论 + 保真/AI 执行优先级                                                                                            |

---

## 怎么启动？——一句话

**对模型：用 PART10 模板 A 启动它，把 PART10 20 条 CONTRACT 贴在用户消息最开头，让它先 Read `.hira-ai/` 4 个文件，复述 + 列 ID 确认后再开工。**

**对人：** 第一步看 PART8 §8.5，复制 Day1 bat 脚本执行 → Day5 通过 DRM + 空窗口快照 ≥95% + 打包可安装 → 进入 Week2。

**优先级阶梯（P0 一票否决所有低位）**：
P0. PART10 20 条 CONTRACT（其中 C01 npm 不重写 + C02 UI 快照 ≥95% 为最高之最高）
P1. 原版 1,234 功能点 + 126 边角 **行为 100% 还原**（PART9 保真 5 级锁）
P2. 架构 100% Mod 化（PART3/7 Provider-Service）
P3. 代码整洁 / 模型「最佳实践」（可以为 P0~P2 让路，不要本末倒置）

→ 任何阶段发现 P0/P1 不满足，必须停手先修 P0/P1，代码再"优雅"也必须让路。
