# PART17 · NG AI 工作室（Studio）与自产出插件体系

> 目标：让 AI 助手像 Tabbit 一样**自己产出**浏览器插件 / 主题 / 用户脚本 / 技能，并直接装进浏览器、出现在插件列表里。
> 一句话产品语言：「一句话让 AI 帮你写插件，让浏览器变成你想要的样子」。

---

## 1. 结论先行：一切产物都是插件

不新开一套「AI 产物」的旁路体系。四种产物统一收敛到插件体系：

| 产物 | 落地形态 | manifest `type` | 能力 |
| --- | --- | --- | --- |
| 功能插件 | `userData/plugins/<id>/` | `feature-plugin` | `contributes.*` 声明式贡献；可选 `main`/`render` |
| 主题 | 主题插件 | `theme-plugin` | `contributes.themes[]` |
| 用户脚本 | 用户脚本插件 | `userscript-plugin` | `contributes.userscripts[]` |
| 技能 | 插件技能 **或** 用户技能 | `ai-skill-plugin` / DB | `contributes.skills[]` / `ai_skill` 表 |

这样做直接获得四件已经写好并验证过的事：

1. **插件列表**：装完就出现在插件中心（`plugins:changed` 广播 + 面板对账）。
2. **启停 / 卸载**：复用 `setPluginEnabled` / `uninstallPlugin` 的唯一实现。
3. **安全边界**：复用安装器的体检（id 合法性、入口存在性、体积/数量上限、zip-slip、签名分级）。
4. **主题目录刷新**：`afterInstallHook → notifyActivated → onPluginsActivated → refreshThemeSources()`。

**不新增第二条安装链路。** 新增的只有「生成产物 → 写暂存目录 → 交给 `installFromPath`」这一段。

---

## 2. 分层与模块（彻底解耦）

```
apps/app-main/plugins/ai/
  core/studio.cjs        纯逻辑：产物规整 / 校验 / 强制 local 信任级 / 生成文件清单
  main/studio.cjs        编排：暂存目录 → services.studio.install → 清理；技能委托 skillService
  core/studio-tools.cjs  工具声明：studio_* / skill_*（只做参数 → 服务调用）
```

三条边界：

- **core 不认识 fs / Electron / IPC**：只把「模型给的参数」变成「可落盘的文件清单 + manifest」。
- **main 不认识安装器的内部规则**：只调用注入端口 `services.studio`。
- **tools 不认识业务**：一条工具 = 一份 JSON Schema + 一次服务调用。

端口（`getDomainServices().studio`）：

```js
studio: {
  userDir(): string                  // 用户插件目录（暂存目录必须落在这里）
  install(target, { overwrite })     // → ipc/plugins.js#installFromPath（含 afterInstallHook）
  uninstall(id)                      // → ipc/plugins.js#uninstallPlugin
  installUserscript({ text, overwrite }) // → 同一条用户脚本安装链路
}
```

端口晚绑定：`registerCoreIpc` 之后回填 `studioPort`，与 `pluginHostPort` 同一时序。未就绪时工具返回明确原因，而不是静默失败。

---

## 3. 安全模型（不可协商）

### 3.1 信任级强制降级

AI 产出的任何 manifest **一律**改写为：

```json
{ "trustLevel": "local", "permissionLevel": "ui" }
```

- `trustLevel: "local"` → `isFirstParty = false` → **强制沙箱**、无法拿 `kernel`、无法 `require('electron')`。
- `permissionLevel` 只允许 `none | ui | network`，**`full` 被丢弃**。
- 模型即使写了 `"trustLevel": "internal"` 也会被覆盖 —— 信任级只能由我们自己给，不能由产物声明。

### 3.2 权限白名单

`requestedPermissions` 逐条对照 `infra-plugin` 的 `SCOPE_PERMISSIONS`：

- 未知 scope → **直接报错**并列出合法值（不静默忽略）；
- 不传 → 空数组（安装后不需要任何授权）。

### 3.3 文件边界

- 只接受**文本文件**，路径必须相对、无 `..`、无反斜杠、无盘符、不以 `.` 开头；
- 单文件 ≤ 256 KB，总大小 ≤ 2 MB，文件数 ≤ 40；
- 扩展名白名单：`js mjs cjs css html htm json svg txt md`；
- `hira-plugin.json` 由我们重建，**不接受模型直接写**（防止绕过归一化）。

### 3.4 审批

- `studio_create` / `studio_remove`：`approval: 'always'`（每次都要用户点头）。
- `skill_save`：`approval: 'site'`（同一会话记住一次）。
- 只读工具：`never`。

---

## 4. 工具面

| 工具 | 风险 | 审批 | 说明 |
| --- | --- | --- | --- |
| `studio_capabilities` | read | never | 可产出类型、权限白名单、体积上限、插件目录 |
| `studio_create` | write | always | 生成并安装插件 / 主题 / 用户脚本（也可写技能） |
| `studio_list` | read | never | 列出**用户目录**里已安装的产物（不含内置） |
| `studio_remove` | write | always | 卸载用户安装的产物（内置直接拒绝） |
| `skill_list` | read | never | 技能清单（插件技能 + 用户技能 + kind） |
| `skill_save` | write | site | 新建 / 更新用户技能（插件技能拒绝修改） |
| `skill_remove` | write | always | 删除用户技能 |
| `skill_toggle` | write | never | 单条启停（插件技能也可关） |

`studio_create` 的参数形状（扁平、容错）：

```jsonc
{
  "kind": "plugin | theme | userscript | skill",
  "id": "my-thing",              // 可选，缺省由 name 派生
  "overwrite": false,
  "name": "…", "description": "…", "version": "1.0.0",

  // kind=plugin
  "manifest": { },               // 可选，完整 manifest（会被强制归一化）
  "files": [{ "path": "main.cjs", "content": "…" }],  // 或 { "main.cjs": "…" }
  "permissions": ["tabs:read"],
  "contributes": { "bangs": [] },

  // kind=theme
  "theme": { "mode": "dark", "colors": { … }, "style": { … }, "background": { … } },

  // kind=userscript
  "userscript": "// ==UserScript== …",

  // kind=skill
  "skill": { "id": "…", "label": "…", "kind": "prompt", "prompt": "…" }
}
```

---

## 5. 安装时序（与手动安装完全一致）

```
studio_create
  → core.prepareArtifact        归一化 + 校验 + 文件清单
  → fs 写 userData/plugins/.install-studio-*
  → services.studio.install()
      → ipc/plugins.js#installFromPath
          → pluginInstaller.installDirectory   （体检 / 复制 / rename）
          → afterInstallHook
              → discover → enable/reload → 面板对账
              → notifyActivated → 迁移 / 语言包 / 主题源 / 贡献面刷新
              → notifyChanged({ installed: true })
  → finally rm -rf 暂存目录
```

主题的额外收益：`onPluginsActivated` 里已经有 `refreshThemeSources()`，**不需要**为 AI 主题再写一条刷新逻辑。

---

## 6. 关键改点（代码级）

1. `src/main/ipc/plugins.js`
   - 把卸载路由主体抽成具名 `uninstallPlugin(id)`；
   - 把 `userScriptInstaller` 提到安装器可用处，暴露 `installUserscript(req, event)`；
   - 返回值补 `installFromPath / uninstallPlugin / installUserscript`。
2. `src/main/ipc-routes.js`
   - 从 `pluginsIpc` 透出三个端口。
3. `src/main/main.js`
   - 新增 `let studioPort = null`；
   - `getDomainServices()` 增加 `studio` 域端口；
   - `pluginHostPort` 回填处同步回填 `studioPort`。
4. `plugins/ai/core/studio.cjs` / `plugins/ai/main/studio.cjs` / `plugins/ai/core/studio-tools.cjs`
   - 新增（见 §2）。
5. `plugins/ai/core/tools.cjs`
   - `.concat(createStudioTools(host))`。
6. `plugins/ai/main/engine.cjs`
   - 创建 `studioService`，注入 `createBuiltinTools({ studio })`。
7. `plugins/ai-skills-builtin.hira-plugin.json`
   - 新增「插件创作」提示词技能，教模型何时用 studio 工具、如何写 manifest。

---

## 7. 明确不做的事

- **不**让 AI 产物声明 `trustLevel: internal` / `permissionLevel: full`；
- **不**给 AI 产物一条绕过安装器的写盘路径；
- **不**为「AI 主题」单独维护一套主题目录；
- **不**在 `studio.cjs` 里复制插件安装器的校验（入口存在性、id 撞名等由安装器体检负责）。

---

## 8. 后续扩展位

- 新产物类型：`core/studio.cjs` 加一个 `prepare<Kind>` + `STUDIO_KINDS` 增加一项；工具面不变。
- 新技能 kind：沿用现有 `ai.skill.kind` 扩展点，studio 不感知。
- 插件市场联动：`studio_create` 已产出标准插件目录，后续可直接打包上架。
