# TOTP 2FA 验证器插件 —— 落地设计

> 目标：一个**可选、出厂默认关闭**的插件，带自己的侧栏面板，能导入/导出主流验证器的数据。
> 本文是落地时的对照清单：按 §5 的文件表逐项做完即可，不需要再回头做设计决策。

---

## 0. 结论速览

| 决策 | 结论 | 一句话理由 |
| --- | --- | --- |
| **TOTP 库** | `otpauth`（hectorm）v9.x | 同一个 API 同时给 TOTP + HOTP + **`otpauth://` URI 解析/生成** + `remaining()`；零运行时依赖；376 个下游包 |
| **码在哪算** | **主进程** | 密钥不出主进程 → 渲染层的任何 JS 泄漏都拿不到 2FA 密钥 |
| **密钥怎么存** | `safeStorage` 加密后进 SQLite | 与密码模块同一套（OS 钥匙串 / DPAPI），不自己造密码学 |
| **"兼容所有"怎么做** | 标准 `otpauth://` 为**唯一交换格式** + 每家一个**导入适配器**纯函数 | 各家的差异只在"导出格式"，不在算法；算法全走 RFC 6238 |
| **QR 解码** | 渲染层 `BarcodeDetector`（Chromium 内置） | Electron 43 自带，**零依赖** |
| **QR 生成** | 主进程出 SVG 字符串 | 导出时避免把密钥再送回渲染层 |
| **出厂默认关闭** | ✅ 机制已补（`defaultDisabled` + 播种） | 见 §6 |
| **safeStorage 适配器** | ✅ 已提升为 `infra/infra-secret` | 见 §4.3 |

---

## 1. 能力边界：先把"兼容"钉死

"兼容 Google/Microsoft/Authy/1Password/Bitwarden 等所有"这句话必须拆成两件事，否则会做出用户以为能做到、实际做不到的功能：

### ① 算法层 —— 全部兼容，无需特殊处理

所有主流验证器都实现 RFC 6238（TOTP）/ RFC 4226（HOTP）。差异只在参数：

| 参数 | 取值范围 | 备注 |
| --- | --- | --- |
| 算法 | SHA1（默认）/ SHA256 / SHA512 | **Microsoft Authenticator 静默忽略 URI 里的 algorithm/digits/period**，永远 SHA1+6+30 |
| 位数 | 6（默认）/ 8 | 同上 |
| 周期 | 30s（默认）/ 60s | 同上 |
| 密钥 | Base32，**不带 padding** | RFC 4648 要求 padding，但 Google Authenticator 不吃 padded secret |

### ② 导入导出层 —— 只有一部分家能直接导入

| 来源 | 格式 | 可否直接导入 | 做法 |
| --- | --- | --- | --- |
| **任意 App 的绑定二维码** | `otpauth://totp/...?secret=...` | ✅ | 扫码 / 粘贴，`URI.parse()` |
| **Google Authenticator** | `otpauth-migration://offline?data=<base64url protobuf>` | ✅ | 自研 ~60 行 protobuf 读取器（见 §1.1） |
| Aegis / Raivo / 2FAS 的"导出账户" | 同 `otpauth-migration` | ✅ | 免费搭车上一条 |
| **Bitwarden**（JSON 导出） | `items[].login.totp` = otpauth URI | ✅ | 遍历取字符串，逐个走通用解析 |
| **1Password**（CSV / 1PUX） | `otp` / `one-time password` 字段 = otpauth URI | ✅ | 同上 |
| Aegis 明文 JSON | `{version:1, entries:[{issuer,name,info:{secret,...}}]}` | ✅ | 专用适配器 |
| Aegis 加密 JSON | scrypt + AES-256-GCM | ⚠️ 二期 | 要引 node:crypto 的 scrypt，输入密码 |
| 2FAS JSON | `{services:[{name,secret,otp:{...}}]}` | ✅ | 专用适配器 |
| andOTP / FreeOTP+ | JSON | ✅ | 专用适配器 |
| 纯文本一堆 URI | 任意文本里的 `otpauth://` | ✅ | 正则兜底（覆盖"从别处复制粘贴"） |
| **Authy** | 只有专有加密备份，**无公开导出格式** | ❌ | 必须先借中间工具转成 otpauth，或重新绑定 |
| **Microsoft Authenticator** | 只有 iCloud/Google Drive 专有备份，**无导出** | ❌ | 只能重新扫码绑定 |

> **结论**：把"兼容所有"实现为「**otpauth:// URI 是唯一入口格式**」+「一堆把各家导出转成 URI 的适配器」。
> Authy / Microsoft 的限制是**它们自己不导出**，不是我们不做 —— 界面文案要如实说，不要承诺做不到的事。

### 1.1 Google 迁移格式（值得自研，不值得引 protobuf 库）

```
otpauth-migration://offline?data=<urlsafe-base64>
data 解码后是 MigrationPayload：
  repeated OtpParameters otp_parameters = 1;
    bytes  secret    = 1;   // 原始字节，不是 base32
    string name      = 2;   // 账号
    string issuer    = 3;
    enum   algorithm = 4;   // 0=SHA1 1=SHA256 2=SHA512 3=MD5
    enum   digits    = 5;   // 0=6 1=8
    enum   type      = 6;   // 0=TOTP 1=HOTP
    int64  counter   = 7;   // HOTP 用
  int32  version    = 2;
  int32  batch_size = 3;    // 一个导出可能拆成多张二维码
  int32  batch_index= 4;
  int32  batch_id   = 5;
```

只要 varint + length-delimited 两种 wire type，**手写 60 行读取器**即可（引 `protobufjs` 为一件事背一个大依赖不值）。
多张二维码要能**分批累积**：按 `batch_id` 归组、按 `batch_index` 拼，扫完 last 才算导入完成。

---

## 2. 库选型对照

| | **otpauth** ✅ | otplib v13 | speakeasy |
| --- | --- | --- | --- |
| 最新版 / 活跃度 | 9.5.2（一个月内） | 13.5.0（一个月内） | 长期停更 |
| 下游包 | 376 | 635 | — |
| 依赖数 | 1 | 6 | 多个 |
| URI 解析**与**生成 | ✅ `URI.parse` / `toString()` | 需另装 `@otplib/uri` | ❌ |
| `remaining()`（面板倒计时要） | ✅ 直接给 | 要自己算 | ❌ |
| `validate()` 带时间窗 | ✅ 返回 delta | ✅ 返回 `{valid,delta}` | ✅ |
| HOTP | ✅ | ✅ | ✅ |
| 模块格式 | **纯 ESM** | ESM | CJS |
| Steam Guard 变体 | ❌ | ❌ | ❌ |

**选 `otpauth`。** 决定性的一条是 **URI 解析**：`otpauth://` 的坑全在解析细节上（issuer 同时出现在 label 与参数里、label 的 `issuer:account` 要以第一个 `:` 切分而 issuer 自己可能含 `:`、base32 padding、缺 algorithm/digits/period 时的默认值回落）。自己写这段是"看起来 20 行、实际一堆边角"，而这一块正是**兼容性成败所在**。

**✅ 已实测确认（推翻本文早先的猜测）**：`otpauth@9.5.2` **不是纯 ESM** ——
它的 `exports` 里有 CJS 分支：

```json
"exports": { ".": { "node": { "import": "./dist/otpauth.node.mjs",
                              "require": "./dist/otpauth.node.cjs" } } },
"main": "./dist/otpauth.node.cjs"
```

所以主进程直接 `require('otpauth')` 即可，**不需要 `await import()`**。运行时实测可用，
且 `TOTP.generate()` / `remaining()` / `toString()` / `URI.parse()` 全链路正确
（对得上 RFC 6238 附录 B 的 6 条官方向量）。

唯一依赖是 `@noble/hashes`（本仓库根目录已装 `2.4.0`，正好是它要的版本）。

---

## 3. 分层与数据流

```
渲染层（面板）                主进程                          存储
──────────────               ──────────                      ──────
 扫码/粘贴/各家导出
   ↓ 只做**解码与格式转换**
 得到一串 otpauth:// URI ──► totp.import({uris}) ──► 解析+校验
                                                    ↓
                                          safeStorage.encrypt ──► SQLite(密文)

 显示码  ◄─── totp.code({id?}) ── 解密→otpauth.TOTP.generate()
              ↑ 只回 {code, remaining, period, type}，**永不含密钥**
              ↑ HOTP 的 remaining/period 是 null（没有时间窗）
              │ 渲染层每秒本地重算倒计时；跨窗时才再问一次 ← 零定时器 IPC

 导出二维码 ◄─ totp.exportUri(id) ── 主进程生成 URI/SVG 回传（密钥不回渲染层）
```

**关键分工**（决定了"新增一家导入格式"要碰哪里）：

| 步骤 | 在哪 | 为什么 |
|---|---|---|
| 二维码图片 → 文本（`BarcodeDetector`） | 渲染层 | 是 DOM 能力 |
| 各家导出格式 → 一串 `otpauth://` URI | 渲染层 | 纯数据搬运，**不需要密码学库** → otpauth 不进渲染包 |
| `otpauth://` URI → 校验 → 加密 → 落库 | **主进程** | 永不信任渲染层的解析结果，校验只做一次 |

---

## 4. 安全边界

### 4.1 密钥的暴露面

- **展示码**：主进程算，渲染层只拿 `{code, remaining, period}`。
- **录入**：密钥必然经过渲染层（用户就在那儿扫码/粘贴），这是不可避免的一次。
- **导出**：主进程生成 SVG 回传 —— 不再把密钥送进渲染层。
- 于是"密钥在渲染层的存在时间"被压缩到**录入那一刻**，之后不出现。

### 4.2 `totp.revealSecret` 要单独成一个 capability

导出（= 显示已有条目的二维码）本质就是"把密钥亮出来"。把它做成**独立能力**而不是混在 `totp.export` 里，好处是：可审计、可单独弹确认、将来做沙箱时能单独收紧。

### 4.3 ✅ 前置重构：safeStorage 适配器已提升到 infra

**已完成。** 原 `domain/domain-password/src/crypto/safe-storage.js` 已整体搬到
`infra/infra-secret/src/index.js`（含测试）。理由：

TOTP 域要用它，但**域与域之间不能互相依赖**（`domain-totp → domain-password` 是反模式）。
且它本身是纯适配器（`safeStorage` 作参数注入，零 electron import），属于基础设施。

改动清单：新建 `infra/infra-secret`（package.json + src/index.js + src/index.test.mjs）；
`domain-password/src/index.js` 改 import 且**不再转出**这两个函数（删旧文件与空目录）；
`main.js` 直接从 `@hira-ng/infra-secret` 取 `createSafeStorageCrypto`。

---

## 5. 落地清单（按依赖顺序）

### 5.1 存储与域 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 1 | `infra/infra-db/src/schema.js` | ✅ 加 `totpEntries`（drizzle 定义 + 导出） |
| 2 | `infra/infra-db/src/index.js` | ✅ `SCHEMA_DDL` 加表 + `idx_totp_entries_profile` 索引 |
| 3 | `infra/infra-secret` | ✅ 已完成（见 §4.3） |
| 4 | `domain/domain-totp/` | ✅ `createTotpService(db, { crypto, getProfileId })` + `package.json`（deps: infra-db / infra-secret / shared-utils / otpauth） |

**实际落地的 table**：

```
totp_entries(
  id, profile_id, issuer, account,
  secret_cipher,        -- safeStorage 加密后的密钥（密文），明文绝不落盘
  algorithm, digits, period, type, counter,   -- 逐条存，不当全局默认
  created_at, updated_at
)
```

**服务方法**（对应 §5.2 要暴露的能力，一一对得上）：

| 方法 | 语义 |
| --- | --- |
| `list()` | 条目列表，**出口已剥离密文字段** |
| `code({id?})` | `{ codes:[{id,code,type,remaining,period}], now, unavailable }`；`now` 供渲染层对齐倒计时 |
| `add(input)` | 手动输入一条 |
| `importUris({uris})` | 批量（渲染层已把各家格式转成 URI），**尽力而为**：逐条报"第几条、为什么跳过" |
| `update(id, patch)` | 改元信息；传 `secret` 才改密钥 |
| `remove(id)` | 删除 |
| `exportUri(id)` | **唯一交出密钥的方法**（见 §4.2） |
| `subscribe(fn)` | 变更订阅，供 APPS 层转 `IPC_EVENTS.totpChanged` |
| `isEncryptionAvailable()` | 面板据此禁用"新增"并给出原因 |

**关键实现决策**：
- **otpauth 懒加载**（`let lib = null; function lib() { ... require('otpauth') }`）——
  插件出厂关闭，而 domain 在组合根是无条件创建的；顶层 require 等于"用户从没启用过却已加载一套密码学实现"。
- **不缓存解密结果** —— 密钥只活在这一次调用的栈上，不做会话级缓存（那会把明文驻留时间从微秒拉到整场会话）。
- **算法/位数收窄到 `SHA1|SHA256|SHA512` 与 `6|8`** —— 各家实际只认这些；放行更多值只会造出"在这个 App 对、在那个 App 错"的条目。
- **判重用 `issuer+account+algorithm+digits+period+type`** 而不是解密比密钥：错向"漏拦"（照常导入）而不是"误拦"（丢用户真数据）才是安全的。

单测 `domain/domain-totp/src/index.test.mjs`（22 条）含 RFC 6238 / RFC 4226 官方向量、
"明文不落盘"、"出口无密钥字段"、"profile 隔离"、"导两次判重"、"换机器解不开时报 unavailable 而不是静默少一条"。

### 5.2 协议层 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 5 | `packages/shared-types/src/ipc-channels.mjs` | ✅ `IPC_ROUTES.totp{List,Code,Add,Update,Remove,Import,ExportUri}` + `IPC_EVENTS.totpChanged` |
| 6 | `infra/infra-ipc/src/contracts/totp.js` | ✅ 7 条路由各一组 `{request,response}` |
| 7 | `infra/infra-ipc/src/contracts/index.js` | ✅ require + 登记 `ipcSchemas.totp` |

**契约在这里多担了一件事**：除了拦请求形状，它还**钉死"响应里不含密钥"**。

`entrySchema` 逐字段列出了对外形状（没有 `secretCipher`、没有 `secret`），
所以 domain 哪天不小心多回一个字段，**过 IPC 时会被直接剥掉**而不是漏到渲染层。
唯一的例外是 `exportUri` —— 它整个语义就是"把这条亮出来"，所以单独一条路由 + 单独的响应形状。

**关键形状**：

```
list      → Entry[]                                （Entry 无任何密钥字段）
code      → { codes:[{id,code,type,remaining,period}], now, unavailable }
            remaining/period 对 HOTP 是 null（无时间窗）；now 供渲染层对齐倒计时
add/update→ { ok, reason?, entry? }                 （失败是**正常路径**，不是异常）
remove    → { ok, reason? }
import    → { ok, added: Entry[], skipped:[{index, reason}] }   （尽力而为，逐条报因）
exportUri → { ok, reason?, uri? }                   （唯一交出密钥的路由）
```

**顺带核实的两件事**（省得 §5.3 踩空）：

- **preload 没有通道白名单** —— `shell-preload.js` 把任意 route 拼成
  `ngipc:invoke:<route>` 直接转发，所以新路由**不需要**改桥；唯一的闸是主进程有没有
  `typedMain.handle` 它。
- **仓库没有"路由声明了但没 handler"的门禁** —— 所以本阶段先声明路由、
  §5.3 再补 handler 不会卡在任何检查上。

验证：写了一段端到端脚本，把**真实 domain 的每一个输出**过一遍对应 zod schema
（含"条目不存在 / 非法密钥 / 空列表 / HOTP"等负路径），16 项全过 —— 这是最容易在
运行时才炸的接缝（"response validation failed"）。

### 5.3 主进程 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 8 | `apps/app-main/src/main/ipc/totp.js` | ✅ 7 条路由的 `typedMain.handle`，统一走 `createProviderInvoker` |
| — | `apps/app-main/src/main/ipc/totp-events.js` | ✅ **清单外补上的**：把 domain 的 `subscribe` 转成 `totp:changed` 广播。§5.2 声明了这个事件，不放它 = 事件永远不发（与 `notes-events.js` 逐字同构） |
| 9 | `apps/app-main/src/main/ipc-routes.js` | ✅ require 注册器 + 解构 `totpService` + 调用 `registerTotpIpc` |
| 10 | `apps/app-main/src/main/main.js` | ✅ `createTotpService` → 挂进 `getDomainServices()` → 注入 `registerCoreIpc`；并起事件中继 |

**顺手做的一处小重构**：`createSafeStorageCrypto(safeStorage)` 原本内联在 `createPasswordService` 里，
现在提成 `const secretCrypto = ...` 由**密码域与 TOTP 域共用同一个实例**（它无状态）。
这让"两域用的是同一套 OS 级密钥保护"在代码上可见，而不是两处各建一个。

**⚠ 一个必须说清的语义（它决定了"默认关闭"是否真的关得住）**：

`ipc/totp.js` 的 `invoke(capability, fallback)` 里那个 fallback 只能在
**没有任何插件声明该能力**时生效。`totp-service` 一旦被禁用（含出厂默认关闭），
`providerRegistry.isCapabilityBlocked('totp.*')` 为真 →
provider-bridge **直接抛"能力不可用"，不会回落到域服务**。

这正是想要的：**禁用 = 功能真的没了**，而不是"入口没了但 IPC 还能调"。
配合"面板 `dependsOn: totp-service` → 服务被禁则面板落 blocked → 贡献被摘"，
两处合起来就是一个干净的可选插件：**没启用时，连入口都不存在，IPC 也调不通。**
（这就是 provider-bridge 文件头说的"① 未安装走 fallback / ② 被显式禁用不走 fallback"那条分界。）

验证：用桩 `typedMain` 真注册 7 条路由 ——
7/7 注册齐全、**每个 handler 的真实输出都过对应 zod schema**、
`providerRegistry = null` 时 fallback 生效（功能保留）、
中继正确发出 `totp:changed`（`update` / `import` / `remove` 各一条，`add` 不广播）。

### 5.4 插件侧 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 11 | `plugins/totp-service.cjs` | ✅ `createServicePlugin` 的 7 条能力薄映射 |
| 12 | `plugins/totp-service.hira-plugin.json` | ✅ `type: feature-plugin` + **`defaultDisabled: true`** + 7 条 `capabilities` |
| 13 | `plugins/panel-totp.hira-plugin.json` | ✅ `contributes.panels[{id:'totp-panel'}]` + `render` + `dependsOn: ['side-panel-skeleton','totp-service']` + **也标 `defaultDisabled`** |
| 14 | `plugins/panel-totp.renderer.js` | ✅ 装配 + 样式（`rendererPlugin.panels[0].id === 'totp-panel'`） |
| 15 | `plugins/panel-totp.model.js` | ✅ 状态 + 倒计时时钟 + 全部动作 |
| 16 | `plugins/panel-totp.view.js` | ✅ DOM 渲染与意图转译 |

**⚠ 计划外的一个决定：`panel-totp` 也标了 `defaultDisabled`。**

清单里只给 `totp-service` 标了。但只标服务会留下一个死角：用户在插件中心**只打开面板**时，
`enableAll` 早已跑完，面板仍停在 `blocked`（前置没启用），得重启一次才生效。

两个都标之后，用户打开面板那一下会走 `enableWithPrerequisites` ——
**它会把被用户禁用的前置一并恢复**（注册中心的既有机制），一次点击就装好。
实测确认：`restored = ["totp-service"]`，且用户的选择在重启后不再被播种覆盖。

**面板 UI 的两个关键设计**：

- **两条渲染路径**（model 的 `onChange` / `onTick` 一一对应）：
  结构性变化才重建列表；倒计时每秒**只改码文本与进度条的两个属性**。
  一屏十几条若每秒重建，输入框会失焦、滚动会跳、点击会丢 —— 这是流畅与否的关键，不是微优化。
- **进度条首帧与逐秒共用 `applyProgress()`**：只在 tick 里设值的话，渲染后有整整一秒
  进度条处于"没有 transform"状态（= 满格），看起来像"这条刚刷新过"。
- **剩余秒数（`applyCountdown()`）贴在码右侧**，与进度条同一份 `remaining`：
  条形只给"大概还剩多少"，而照着念/手输时需要**确切**判断"还来得及吗"。
  三个刻意的取舍：① HOTP 隐藏整块（显示 0 会让人以为要过期了）；
  ② 取 `Math.floor` 而非 `ceil`（显示 3 秒时至少还有 3 秒可用，多显示的那 1 秒会误事）；
  ③ 等宽 + `tabular-nums`（数字宽度不变，读秒时不会左右抖）。剩余 ≤5 秒转红，与进度条一致。
  它与进度条**共用同一个 `period`/`remaining` 真源**，不自己算时间 —— 时钟偏移
  （`state.clockSkew`）已经在 model 里校正过。

### 5.5 导入适配器 ✅ 已完成

**目录结构**（`plugins/totp-import/`，全部是**渲染侧纯函数** —— 不需要密码学库，所以 otpauth 不进渲染包）：

| # | 文件 | 状态 |
| --- | --- | --- |
| 17 | `totp-import/index.js` | ✅ 注册表 + `decodeImport(text)` + `listImportFormats()` |
| — | `totp-import/uri.js` | ✅ **共用工具**：`bytesToBase32` / `buildOtpauthUri` / `entriesToUris` |
| — | `totp-import/json-adapter.js` | ✅ **共用骨架**：`makeJsonAdapter`（判别式 + 取值两件事抽成参数） |
| 18 | `totp-import/otpauth-uri.js` | ✅ 通用 `otpauth://` 抽取（**兜底，永远最后**）|
| 19 | `totp-import/google-migration.js` | ✅ `otpauth-migration://` 手写 protobuf 读取器 + 分批合并 |
| 20 | `totp-import/aegis.js` | ✅ 明文 JSON；**加密备份明确认出并说清怎么办** |
| 20 | `totp-import/twofas.js` | ✅ |
| 20 | `totp-import/andotp.js` | ✅ |
| 20 | `totp-import/bitwarden.js` | ✅ **透传**它自带的 `login.totp` 链接；加密导出明确拒绝 |
| 20 | `totp-import/onepassword.js` | ✅ 1PUX 解压后的 `export.data`，**深度遍历找链接** |
| — | ~~`totp-import/qr-decode.js`~~ | ♻️ **已提升为共享内核**：`src/renderer/shared/qr-scan/`（见下） |
| — | ~~`totp-import/qr-scanner.js`~~ | ♻️ **已提升为共享内核**：`src/renderer/shared/qr-scan/`（见下） |

**二维码能力已抽取为共享内核**（`apps/app-main/src/renderer/shared/qr-scan/`）——
一份实现两个消费者：「验证器」面板的扫码导入 + 独立的「扫码器」插件。

```
qr-scan/
├── detector.js     双引擎：原生 BarcodeDetector → qr/decode.js 兜底（一帧多码 vs 一码由 kind 暴露）
├── frame.js        取帧：video / Blob → ImageData（willReadFrequently、长边 ≤1280）
├── image.js        图片 → 文本（多张、去重）
├── decoder.js      文本 → 内容类型（网址 / otpauth / Wi-Fi / 文本…）供"智能动作"用
├── screen.js       抓屏内核：抓一帧 → ImageData → 解码（触发式，见下）
└── scan-window.js  **取景框会话 = 扫码器引擎的可调用接口**（开框 / 收框 / 等放下 / 抓一帧）
```

**为什么必须有第二个引擎**：原生 `BarcodeDetector` 在 MDN 上的状态是
"Limited availability / Partial support" —— 桌面平台**不保证有条码识别后端**，
只靠它的话扫码在相当一部分机器上就是个点不动的按钮。所以：
① 原生可用就用（零体积）；② `qr/decode.js`（paulmillr/qr，7.3KB，零依赖）兜底。

> 选型是**实测驱动**的，不是凭印象：1280×720 含码帧 —— `qr` **3.2ms** / jsQR **~351ms**。
> 我们的取景框每放一次只抓一帧，351ms 意味着一帧要等近半秒（界面像卡住），
> 而 `qr` 的这个耗时在任何路径上都感知不到；此外 jsQR 已停更 5 年，`qr` 与仓库里已有的
> `@noble/hashes` 同一作者。

**屏幕取景框（不再有摄像头）**：本面板的扫码走**屏幕**，不走摄像头。取景框是主进程的
独立置顶窗口（`WINDOW_TYPES.QR_SCAN_FRAME` + `screen:*` 通道），抓屏能力由「扫码器」插件提供
（`qr.captureScreen`，真正的 `desktopCapturer` 只在它那儿），解码复用 `detector.js`。三条要点：

1. **引擎是"可调用的接口"，不是"一个必须先打开的插件面板"**。`scan-window.js` 把
   「开框 → 等用户放下（`screen:frame-settled`）→ 抓一帧 → 框被关掉就收摊」这条时序封成一个
   **会话对象**（`open / close / rescan` + `onText / onScan / onError / onClosed / onCapture`）。
   「验证器」面板与「扫码器」面板**都是它的调用方**，谁都不需要对方先开着 ——
   验证器面板点「扫描屏幕二维码」直接调起取景框，扫到即导入。
   （反过来说：把关框、等放下、`frameSeen`（区分"框还没显示"与"框被关掉"）这套抄第二遍，
   就是第二个只会在它自己那儿出错的坑。两个面板现在共用同一份时序。）
2. **触发式，不是轮询**：只在三处抓**一帧** —— 开框落位后一拍（420ms）、用户把框放下、手动「重新扫描」。
   静止时零抓屏、零解码、零 IPC。这是血的教训：持续抓整屏要主进程回读 8MB 再塞过 IPC，
   结果是界面卡死、拖不动、鼠标都不动。
3. **能力协商（§10.4）**：抓屏能力由「扫码器」插件提供，而它**可选、默认关闭**。被显式禁用时
   `qr.captureScreen` 会抛（**禁用 = 功能真的没了**），所以这里查 `features:availability` 的
   `qrScan` 功能面：**不可用就不渲染那个按钮**，而不是留一个点了就报错的。启用后不必重开面板 ——
   可用性变化会回流（单例 store：一次桥订阅 + 一次去重请求）。

**三条导入入口**（粘贴文本 / 选图片 / **屏幕取景框**）**全部汇进同一个 `importText`** ——
后续的格式识别 / 落库 / 判重 / 报因完全一致，不存在"某条入口少了一道校验"。
取景框的产出是**待导入清单**，不是直接写库：

```
扫到 otpauth 码 ──► state.scan.pending（去重累积，只收 otpauth*）
                        │  卡片：大字「已扫到 N 张二维码，尚未添加」+ 条目清单 + 「导入 N 张」
                        ▼
                    用户点「导入」──► importText(全部一起) ──► 落库 ──► 收框 + 回列表
扫到别的码        ──► 琥珀色提示「这个二维码不是验证器的内容」，**不进清单**
```

**为什么必须让用户点一下（这是被否掉一版才改的）**：
取景框是"一直对准屏幕"的东西，用户把框从 A 码挪到 B 码的路上会连续命中 ——
扫到就写库等于**替用户做决定**，而且他连"刚加进去了什么"都来不及看；迁移码更狠
（一进去就是几十条账号）。所以"扫码"是取件、"导入"才是签收，两件事不能合成一件。
一起交（而不是逐张）也是 Google 迁移码的硬需求：分批二维码要靠"一起解析"才能合并。

> ⚠ **"提示不显眼"返工（第三版）**：第一版的待导入提示只是一行 10.5px 的灰字状态条 ——
> 用户的原话是"扫描出来自动添加的提示，也是不显眼"。改法：
> · 卡片挪到**导入屏最上面**（排在粘贴框下面会被当成说明文字扫过去）；
> · 待导入态是**主色实底 + 13px 粗体大字标题 + 条目清单 + 右对齐主按钮**，出现时还有一次
>   0.32s 的缩放/光圈动画 —— 它是"要用户做决定"的状态，必须比面板里任何别的东西显眼；
> · 三个形态的视觉刻意拉开：待导入（主色）/ 不是验证器内容（琥珀，与红色故障分开）/ 正常（安静）。
> 「扫码器」面板同理：命中时状态条变绿加粗 + 脉冲一圈，新记录从绿底渐隐一次
> （用户此刻目光在取景框上，面板只是余光）。

> ⚠ **可用性返工记录（值得记住）**：第一版工具条用的是**图标符号**（`＋` 新建 / `⇥` 导入），
> 空态也只写了句"把链接粘进来（⇥）"。结果用户直接问"按钮在哪" ——
> **`⇥` 没人认得出来是"导入"**，只能靠 hover 的 title 才知道，而"要点一下试试"本身就是失败。
>
> 改法（都是"把发现成本降到零"）：
> 1. 工具条改成**文字**按钮「新建」「导入」（侧栏虽窄，两个两字按钮挤得住，搜索框自己收缩）。
>    图标只留给**行内**的 `⋯`（行内空间紧，且 `⋯` 是通用惯例）。
> 2. **空态放真按钮**：第一版只有文字说明 → 改成「导入 / 扫码」「手动输入密钥」两个可点按钮。
>    空态是新用户看到的第一屏，"请点某处的某个东西"这种写法要求用户先去界面里找一遍，
>    而"找不到"正是这个面板最可能被放弃的地方。
> 3. **主次必须对**：工具条里**「导入」是主按钮**（填充色 + 更大的点击面），「新建」是安静的次级 ——
>    手动敲密钥是少数派，让它看起来像推荐做法是错的（用户原话：导入才是占大头的那个）。
> 4. **最短的一条路排在前面**：导入屏的入口行顺序是「扫描屏幕二维码」→「选择图片…」
>    （原来是「用摄像头扫码」排第一 —— 摄像头那一条已整条删除，见上）。
>
> ⚠ **两个"点了没反应"的坑（第二次返工，都值得记住）**：
>
> 1. **行菜单第一版是自绘的**（一个 `position:fixed` 的 div + 自己算 left/top + 挂 body +
>    点外面关闭的一次性监听）。问题不在样式，而在**层级**：面板内容区有自己的层叠上下文，
>    菜单可能被压在下层 —— 看得见、点不动，且只在某些面板布局下复现。
>    而且自绘永远追不上系统菜单（键盘导航、屏幕边缘自动翻转、快捷键提示）。
>    **改法：走宿主已有的原生菜单端口** `ctx.menu.popupMenu({ items, x, y })`
>    （`renderer/shared/menu-client.js` → 主进程 `Menu.popup`），与标签行菜单 / 笔记面板
>    是同一个东西。入口只留一处：`openRowMenu(entry, anchor)` —— 「⋯」按钮传锚点坐标，
>    **行内右键不传坐标**（让原生菜单用鼠标位置弹，反而没有坐标系换算误差）。
>
> 2. **删除确认框（前后踩了两次，最后整段改成 JS 对话框）**：
>    · 第一版 `ui-common` 的 `confirm()` **从没把模态框挂进 DOM** → 点删除毫无反应、
>      `Promise` 永远不 resolve（连报错都没有，最难查的失败形态）；
>    · 补上挂载后又是**样式**问题：模态框的 CSS 只在 `injectCommonStyles` 里、
>      面板只注入了 panel 那份 → 它退化成普通块级元素"跑到最下面、排版全乱"。
>    · 两次是同一类错误的两种长相（**自绘的东西要在每个宿主里都自己正确一遍**），
>      所以直接换成平台原语：`confirm()` 内部改为 `doc.defaultView.confirm(text)`
>      （网页里那个 `window.confirm`，tab 页由 `main/js-dialog/` 覆盖为应用风格对话框，
>      内部页走 Chromium 原生 —— 同一个 API，层级/居中/遮罩/焦点/Esc 全是系统的）。
>      自绘的 `createModal` + `Modal` 导出 + 那套 modal CSS **整段删除**（死代码清零）。
>      代价如实记：`danger` / `confirmLabel` 表达不了 —— 动作动词写进 `message` 问句里。
>    同时把 model 的 `removeEntry` 兜住整条链（确认框 / IPC / 写库都可能抛）——
>    失败必须落到提示上，而不是消失。

> ⚠ **界面密度返工（第四版）**：用户原话"验证器各界面还是复杂、拥挤"。
> 面板只有两三百像素宽，**省下的每一行都直接变成多看得见一条账号**。四条硬规矩：
> 1. **列表每条只占两行**：服务名与账号同一行（左名右号），下面只放验证码 ——
>    原来是"服务名 / 账号 / 验证码"三行，一屏只放得下四五条。
> 2. **表单标签与输入框同一行**（标签定宽 44px 对齐）：标签独占一行时三个字段就是六行，
>    在窄侧栏里等于把"高级"和按钮全推出屏幕外。标签同时写进 `title` / `aria-label`
>    （placeholder 输入后会消失，得留一条后路）。
> 3. **不重复给入口**：导入屏底部删掉「返回」（顶部标题行已有）；导出框删掉标题行
>    （红框 + 只读链接 + 复制按钮已经说明它是什么）。输入框 `rows` 从 6 降到 3。
> 4. **说明文字只留 placeholder / title 两处**：静态段落一律不写（见 §5.5 的清单）。
>
> ⚠ **待导入提示返工（第五版）**：上一版是"大字标题 + 说明句 + 条目清单 + 两个按钮"四段，
> 用户原话"又不显眼又杂乱"。最终形态：
> · **淡主色底 + 左侧 3px 主色强调条**（强对比留给"要打断用户"的事，提示卡只需"看得清 + 边界分明"）；
> · **文案一行、按钮换行右对齐** —— 侧栏太窄，"文案 + 清空 + 导入"挤一行必然把文字截断；
> · 文字用**正常字号/字重**（11px / 500，不放大加粗）：提示只是提示，不该比条目本身还大声；
> · 按钮复用面板标准样式（`totp-panel__btn`），扫到的具体条目挂整卡的 `title`（悬停即见）。
>
> ⚠ **补：内容摘要要露出来**（第六版）。只写"已扫到 N 张"不够 —— 用户的原话是
> "扫到的令牌的详细信息也要稍作保留"：看不到扫的是什么，就只能等点了「导入」才知道，
> 而那时已经落库了。折中是卡片里再加**一行 10.5px 灰字摘要**
> （一条直接列，两条并列，多条"xxx 等 N 项"），完整清单仍在 `title` 里。
> 于是卡片是三行、每行都短：`已扫到 N 张` / `内容摘要` / `[清空] [导入]`。
>
> ⚠ **界面拆分（第七版，用户要求的"大改界面"第一步）**：把「扫码」与「粘贴 / 选图」拆成
> **两个界面**，不再共用一个。理由：这是两个不同的任务 —— 扫码要盯着**屏幕上的取景框**
> （面板只是余光），粘贴要盯着**这个框**；挤在一起时互相分心，而且"扫码"这个小众路径
> 占掉了导入界面最显眼的位置。现在：
> ```
> mode: 'list' | 'form' | 'scan' | 'import'
>   工具条：[搜索] [扫码] [新建] [导入*]
>   'scan'   → 取景框状态 / 待导入卡 + [返回][重新扫描][收起取景框]（进去即自动开框）
>   'import' → 粘贴框 + [选择图片…] + [导入]（**不含任何扫码元素**）
>   空态    → [扫码导入*] [粘贴 / 选图] [手动输入密钥]（抓屏能力不可用时第一个不出现）
> ```
> **同一件事只在一个地方给出口**：卡片里只有"对这批待导入内容做什么"（清空 / 导入），
> "重新扫描 / 收起取景框"这类**界面级**动作只出现在界面底部那行。
>
> ⚠ **第八版（按用户逐条要求）**：
> · 工具条**换成两行**：搜索框独占一行，第二行「扫码」（**大按钮**，铺满剩余宽度）
>   +「新建」+「**截图导入**」（原「导入」改名，它管的就是截图/图片文件）；
> · 扫码界面**底部一个按钮都不留**：返回在标题行、重新扫描搬进**取景框自身的提示条**、
>   收起取景框多余（框上有 ✕，返回列表也会自动收）；只有"框没打开"时才出现「打开取景框」；
> · 扫到的令牌**逐条列在卡片下方**（学「扫码器」面板），不再是一行摘要 ——
>   用户要能核对"是不是我要的那些"，而摘要点完「导入」就落库了。
>
> ⚠ **第九版：每项自带按钮（与「扫码器」面板同一套行结构）**。上一版是顶部一张卡统管
> 「清空 / 导入」整批 —— 那是在替用户做"这一批一起处理"的决定，而扫到的每一条本来就是
> 独立的东西（"这张是给我的，那张是同事的"）。现在：
> ```
>   [已扫到 2 张                       全部导入]   ← 状态行；批量入口只在 >1 条时出现
>   ┌────────────────────────────────────────┐
>   │ [验证器密钥]                        [⋯] │   ← 中文类型 chip（与扫码器面板同一配色）
>   │ GitHub:alice@example.com                │   ← 标题（核对用）
>   │ otpauth://totp/GitHub:alice…            │   ← 原文（单行省略，悬停看全）
>   │ [导入]                                  │   ← 主动作**另起一行**、靠左
>   └────────────────────────────────────────┘
> ```
> 行结构（chip + ⋯ / 标题 / 原文 / 主动作换行）与「扫码器」面板的记录行**逐行对齐** ——
> 一行挤着显示是不行的：窄侧栏里"标签 + 导入 + ⋯"一挤，用户既看不清扫到的是什么、
> 也点不准按钮。中文类型名由 model 的 `describePending()` 给出
> （`otpauth://` → 「验证器密钥」、`otpauth-migration://` → 「迁移码」）。
> `state.scan.pending` 也从"两个平行数组"改成 `[{ text, chip, title, label }]`：
> 分开存就得在每处增删都同步两遍，迟早漏一处。
>
> ⚠ **命中反馈（第十版 + 第十二版修正）**：扫到一条时**只让状态行变绿**
> （淡绿底 + 深绿字 + 加粗 + 脉冲一圈，2.2 秒后由视图自己摘类，不重建整屏）。
> 判断"是不是新的一条"靠 model 给的 `lastAddedId`（视图比对后只提示一次，
> 重建不会重放）。
> 曾给**列表里那一条**也加了常驻高亮（绿底 + 绿描边 + 左绿条 + 滑入动画），
> 用户当场否掉："**为什么扫描成功的绿还弄到了详细项上？只要提示是绿色就够了啊**"。
> 记下来当规矩：**"刚发生了什么"用一次性提示表达；列表项只表达"它是什么"** ——
> 两处同时染色会让人分不清哪块是通知、哪块是内容。
>
> ⚠ **失败原因返工（第十一版，"无法正确显示导入失败原因"）**：三处叠加导致的：
> ① `importPendingAt` 里写死 `setNotice('未能添加（见下方）')`，把 `importText` 已经给出的
> **真实原因覆盖掉了**；② 而"下方"那个结果框只存在于**导入界面**，扫码界面根本没有它；
> ③ `res.reason` 在 `importText` 失败时**根本不存在**（失败时它返回 `null`，原因写在 notice 里）。
> 修法：两条失败路径分开接住 —— `importText` 失败 → 用 `state.notice.text`；
> 主进程逐条挡下 → 用 `res.skipped[0].reason`；**原因贴到对应项上**（可换行的红字），
> 同时状态行也说一句。批量导入**不按 `skipped[].index` 往项上贴**：那是解码后 **URI** 的序号
> （一张迁移码展开成几十条），与"第几张二维码"无对应关系 —— 贴错比不贴更糟。
> **「全部导入」保留的硬理由**：Google 迁移码按每批拆成多张二维码，适配器必须**一起解析**
> 才能合并（逐条会得到"已包含 1/2 批"的提醒）。

**两类适配器的本质差别**（决定了要不要重拼）：

| 类别 | 家 | 做法 |
| --- | --- | --- |
| 存**裸密钥** | Aegis / 2FAS / andOTP / Google 迁移 | 由我们 `buildOtpauthUri` 拼（label 的 `issuer:account` 两段分别编码） |
| 存**拼好的链接** | Bitwarden / 1Password | **原样透传** —— 重拼会在编码细节上引入偏差，透传零风险 |

**三个刻意的设计**：

1. **兜底适配器永远最后** —— `otpauth-uri` 几乎能匹配任何含 `otpauth://` 的东西，
   放前面会把各家全吃掉。
2. **判别式必须严格** —— 抢错格式的表现是"导入成功但条目全错"，比认不出来更糟
   （用户会以为自己的密钥就是这样）。
3. **加密备份给的是"该怎么做"，不是"认不出"** —— Aegis / Bitwarden 的加密导出
   被明确识别、并告知改用明文导出。含糊报错会让用户反复重试同一个文件。

**已知边界（如实写在代码注释与界面上）**：
- Google 迁移**多张二维码**要一起粘；只给一张时会提示"已包含 1/2 批"。
- **Authy / Microsoft Authenticator 没有导出格式**，用户只能重新绑定（见 §1 的兼容矩阵）。
- 1Password 的 **CSV 导出不含 TOTP** —— 只能逐条复制 OTP 链接（走通用兜底）。

**验证**：10 个用例（各家 + 三条负路径）全部符合预期，其中 Google 迁移是用**手工构造的真 protobuf**
（secret 取 ASCII `12345678901234567890`）解出，产物的 URI 再喂回主进程 `otpauth.URI.parse`
**往返无损**（issuer / label / `secret.base32` 全对）。

**闭环实测**：四个来源（Aegis / 2FAS / Bitwarden / andOTP）同时导入 → 各自被正确识别 →
真 domain 落库 4 条 → 参数逐条保留（`ACME/bob 8位 60s SHA256`）→ 算码与独立复算一致 →
**原始行里密文均不含明文密钥**。

**二维码入口实测**：支持时给「选择二维码图片…」按钮、不支持时不给按钮并给出替代提示；
Ctrl+V 粘图 → 解码 → 落库（`GitHub/alice`）；纯文本粘贴不被拦截；
认不出时提示指向"图不够清晰"（而不是含糊的"识别失败"）。

> ⚠ **踩过的坑（值得记住）**：这些提示走的是 `textContent`（纯文本），
> **不能写 Markdown 记号** —— 写了 `**加粗**` 会把星号原样显示给用户。
> 本次在 4 处写了星号（Aegis/Bitwarden 的拒绝原因、图片提示、导入屏 hint），已全部去掉。

### 5.6 渲染层管道 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 21 | `renderer/shared/totp-client.js` | ✅ 领域客户端（`onChanged` 用引用计数单例桥订阅，照 notes-client） |
| 22 | `renderer/shared/hira-client.js` | ✅ import + 转出 `totpClient` |
| 23 | `renderer/panels/main.js` | ✅ `ctx.clients.totp`（第 10 项） |

**端到端实测**（真实注册中心 `discover()` 真实插件目录 + 内存 state store）：

```
discover 到 29 个插件；只有 totp-service / panel-totp 的 defaultDisabled 为 true
validateDeps 通过
[首次启动播种]   newlySeeded = ["panel-totp","totp-service"]
                 注册中心 userDisabled / 磁盘 plugins.disabled / plugins.defaultsSeeded 三者一致
                 → enableAll 会跳过它们（不跑代码、不注册能力、面板不进目录）
[用户打开面板]   restored = ["totp-service"]   ← 一次点击把前置一并拉起
                 磁盘 plugins.disabled 清空
[重启再播种]     newlySeeded = []              ← seeded 标记拦住，用户的选择被尊重
```

渲染侧另用 mock DOM 跑通了完整交互：空态 → 粘贴导入（含一条坏链接被逐条报因）→
列表与码 → 逐秒 tick（**码节点未重建**、进度条推进）→ 点击整行复制 →
行内菜单（复制/编辑/导出/删除）→ 导出（**确认是被点那一行的密钥**）→
表单新增（密钥带空格/小写/padding 也被归一化接受）。

### 5.7 降级兜底 ✅ 已完成

| # | 文件 | 状态 |
| --- | --- | --- |
| 24 | `apps/app-main/src/main/panel-catalog.js` | ✅ `FALLBACK_PANELS` 补 `totp-panel`（`order: 200`, icon `ShieldCheck`）|

> 保底目录只在"插件系统完全不可用"（`plugins/` 目录缺失、discover 抛错）时接管 ——
> 此时若目录为空，用户会看到一个没有任何侧栏面板的浏览器。
> 该表里**没有**启用状态信息：真实开关由插件系统管，那时它只是一个可点的入口。

---

## 6. ✅ 框架机制：出厂默认关闭（已补）

**已完成。** 三个文件：

1. **manifest 字段**：`defaultDisabled: true` → `normalizeManifest` 多读一个布尔（缺省 `false`）。
2. **播种标记**：`plugin-state-store` 新增键 `plugins.defaultsSeeded: string[]`
   （`loadDefaultsSeeded()` / `saveDefaultsSeeded()`）。
3. **播种时机**：`plugin-bootstrap` 的 `seedDefaultDisabled(registry, store)`，
   在**恢复 userDisabled 之后、`enableAll` 之前**调用。

```
for (const m of manifests) {
  if (!m.defaultDisabled) continue
  if (seeded.has(m.id)) continue                                 // 已处理过 → 尊重用户现状
  seeded.add(m.id)
  if (registry.isNonDisableable(m.id)) continue                  // 没有"关"这个状态，只记标记
  registry.setUserDisabled(m.id, true)                           // 出厂关闭
}
persist(seeded); persist(registry.listUserDisabled())
```

**为什么必须有 `seeded` 标记**：只把 id 塞进 `disabled` 的话，用户手动启用 → 重启 → 又被关掉
（"磁盘上没记录"与"用户主动启用过"这两个结果长得一模一样，无法区分）。
标记把这两件事分开，是这一机制唯一的关键点。

**"出厂关闭"不是一种新状态**：它复用既有的 `userDisabled` —— 于是插件既不被 enable
（不跑代码、不注册能力、不加载 UI），又照旧出现在插件目录里，用户点一下就能打开。

单测见 `apps/app-main/src/main/plugin-bootstrap.test.mjs`（7 条，含"用户打开后重启不被关回去"）。

---

## 7. QR 的两个方向

- **解码（导入）**：`new BarcodeDetector({ formats: ['qr_code'] })` —— **Chromium 内置**，Electron 43 直接可用，**零依赖**。
  输入可以是 `ImageBitmap` / `Blob` / `<img>`。用户截图或选一张导出的二维码图片即可。
- **编码（导出）**：没有内置能力，需要一个 ~10KB 的编码库（`qrcode` / `qrcode-generator`）。
  放在**主进程**生成 SVG 字符串回传：渲染层只 `innerHTML` 注入，密钥不再经过渲染层（§4.1）。

---

## 8. 明确不做 / 留给二期

| 项 | 原因 |
| --- | --- |
| Authy / Microsoft Authenticator 的**专有备份解析** | 无公开格式；逆向后还得跟版本赛跑，收益不成比例。界面如实说明"请先用其导出/重新绑定" |
| Aegis **加密** JSON | 要 scrypt + 用户输入密码，单独一期 |
| Steam Guard 5 位码 | `otpauth` 不支持其字母表变体，要自己写；受众窄 |
| 云同步 | 密钥永不离开本机是这个功能的立身之本，不做 |
| `db.schema.migration` 扩展点 | 走 `SCHEMA_DDL`（仓库既有口径）；该扩展点至今无任何内置插件使用，不为这一个插件切换建表机制 |
