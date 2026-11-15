import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

export interface PluginManifestSummary extends JsonRecord {
  id: string
  name?: string
  version?: string
  enabled?: boolean
  render?: string | null
  renderUrl?: string | null
  contributes?: JsonRecord
  panelUi?: Array<{
    panelId: string
    entry: string
    kind: 'html' | 'xaml'
    url: string
    title?: string
  }>
  pages?: Array<{
    id: string
    pluginId: string
    title: string
    entry: string
    dir: string
    host: string
    url: string
    order: number
  }>
  permissionLevel?: string
  grantedPermissions?: string[]
  isFirstParty?: boolean
}

function isPluginManifest(value: unknown): value is PluginManifestSummary {
  return value !== null && typeof value === 'object' && typeof (value as JsonRecord).id === 'string'
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/**
 * 同一 tick 内的并发 `list()` 合并成一次 IPC。
 *
 * 面板冷启动路径上它会被**两处**同时要：插槽激活（决定 import 哪些渲染模块）与
 * 面板实现解析（决定插件有没有 `render` 入口）。同一份全量 manifest 每次都走一遍
 * IPC + 结构化克隆，两份结果却必然相同 —— 合并是纯赚（只发生在**尚未返回**期间，
 * 落地即清空，不存在缓存陈旧问题）。
 */
let listInflight: Promise<PluginManifestSummary[]> | null = null

export const pluginsClient = {
  /** 列出浏览器自身插件（manifest + 运行态）。 */
  list(): Promise<PluginManifestSummary[]> {
    if (listInflight) return listInflight
    const p = invoke(IPC_ROUTES.pluginsList).then((res) =>
      Array.isArray(res.plugins) ? res.plugins.filter(isPluginManifest) : []
    )
    listInflight = p
    const clear = () => { if (listInflight === p) listInflight = null }
    p.then(clear, clear)
    return p
  },
  /**
   * 启用 / 禁用单个插件。
   *
   * 返回 `{ ok, id, enabled, reason?, requiresCascade?, dependents? }`：
   * 禁用时若存在**已启用的下游**，主进程不会直接照做，而是回 `requiresCascade: true`
   * —— 调用方（插件中心）据此弹确认，用户同意后**带 `cascade: true` 再发一次**。
   * 见 infra-ipc/contracts/plugins.js 的 setEnabled 说明（§10.3 方案 b 两段式）。
   *
   * @param {string} id
   * @param {boolean} enabled
   * @param {{ cascade?: boolean }} [opts]
   */
  setEnabled(id: string, enabled: boolean, opts: JsonRecord = {}) {
    return invoke(IPC_ROUTES.pluginsSetEnabled, { id, enabled, cascade: opts.cascade === true })
  },
  /**
   * 授权第三方插件声明的权限（PART7 §7.5）。
   *
   * `scopes` 必须**原样回传**插件声明的那份清单（UI 无权自行增减）——
   * 主进程会与 manifest 取交集，越界项被忽略。传空数组 = 撤销授权。
   *
   * @param {string} id
   * @param {string[]} scopes
   */
  grantPermissions(id: string, scopes: readonly string[]) {
    return invoke(IPC_ROUTES.pluginsGrantPermissions, { id, scopes: Array.isArray(scopes) ? scopes : [] })
  },
  /**
   * 热重载一个插件（重读 manifest + 重新编译模块代码，原本在跑的重启）。
   *
   * 返回 `{ ok, id, enabled, reason? }`。**失败原因必须显示给用户** ——
   * 悄悄失败会让插件作者以为"我的改动生效了"，然后在错的方向上调半天。
   *
   * @param {string} id
   */
  reload(id: string) {
    return invoke(IPC_ROUTES.pluginsReload, { id })
  },
  /**
   * 在系统文件管理器里打开**用户插件目录**（`userData/plugins`）。
   *
   * 这是"社区市场"的最小可用入口：当前阶段安装一个第三方插件 =
   * 把它的目录拷进这个位置（每个插件一个子目录，内含 `hira-plugin.json`）。
   * 返回 `{ ok, path }` —— 失败时 UI 要能说清"没打开成"，而不是静默无反应。
   */
  openPluginDir() {
    return invoke(IPC_ROUTES.pluginsOpenDir, {})
  },
  /**
   * 安装一个插件（社区市场的落盘那一步）。
   *
   * `path` 省略时**由主进程弹系统选择框**（`source` 决定是选目录还是选 zip 文件）——
   * 渲染层因此不需要任何本地路径能力，也不必为了"选个文件"再学一套对话框 API。
   *
   * 返回 `{ ok, id, name, version, signature, warnings? }`；
   * 用户在对话框里取消时回 `{ ok: false, canceled: true }` —— **那不是失败**，
   * 调用方不要弹错误提示。
   *
   * `signature.status` 四态（`none` / `unknown-key` / `valid` / `invalid`）只是**提示**，
   * 不参与安装是否成功（理由见 main/plugin-installer.js 文件头）。
   *
   * @param {{ source: 'directory'|'archive', path?: string, overwrite?: boolean }} opts
   */
  installPlugin(opts: JsonRecord = {}) {
    const source = opts.source === 'archive' ? 'archive' : 'directory'
    const payload: JsonRecord = { source, overwrite: opts.overwrite === true }
    if (opts.path) payload.path = String(opts.path)
    return invoke(IPC_ROUTES.pluginsInstall, payload)
  },
  /**
   * 安装一个**用户脚本**（`.user.js`）—— 它是插件的一种（`userscript-plugin`）。
   *
   * 之所以单独开一个方法而不是复用 `installPlugin({ source })`：
   * 用户脚本的"来源"不是目录也不是 zip，而是**一段文本** —— 元数据头解析、
   * manifest 生成、暂存插件目录这些步骤都在主进程的 userscript-installer 里。
   * 渲染层只管把文本（或路径）递进去，剩下的全走同一条安装器 + 同一个收尾钩子。
   *
   * `text` 用于"粘贴安装"，优先于 `path`；两者都省略时由主进程弹选择框。
   * 取消 → `{ ok: false, canceled: true }`（不是失败）。
   *
   * @param {{ text?: string, path?: string, overwrite?: boolean }} opts
   */
  installUserscript(opts: JsonRecord = {}) {
    const payload: JsonRecord = { overwrite: opts.overwrite === true }
    if (opts.text) payload.text = String(opts.text)
    if (opts.path) payload.path = String(opts.path)
    return invoke(IPC_ROUTES.pluginsInstallUserscript, payload)
  },
  /**
   * 列出**全部用户脚本**（含被关掉的那些）。
   *
   * 与 `list()` 的差别：用户脚本在上百条时没必要塞进插件清单，且它有自己的
   * 单脚本开关（粒度比插件细一级）。这里**不过滤 disabled** —— 否则用户在面板里
   * 关掉一条，它就从列表消失、再也打不开。
   *
   * 返回的每条不含脚本正文（只给 `match / grant / require / enabled` 等元数据），
   * 正文只在主进程注入时拼装。
   *
   * @returns {Promise<Array<{key: string, id: string, pluginId: string, name: string,
   *   version: string, description: string, author: string, match: string[], include: string[],
   *   exclude: string[], grant: string[], require: string[], connect: string[],
   *   runAt: string, order: number, enabled: boolean, file: string}>>}
   */
  listUserScripts() : Promise<Array<{key: string, id: string, pluginId: string, name: string,
  version: string, description: string, author: string, match: string[], include: string[],
  exclude: string[], grant: string[], require: string[], connect: string[],
  runAt: string, order: number, enabled: boolean, file: string}>> {
    return invoke<{ scripts?: Array<{key: string, id: string, pluginId: string, name: string,
      version: string, description: string, author: string, match: string[], include: string[],
      exclude: string[], grant: string[], require: string[], connect: string[],
      runAt: string, order: number, enabled: boolean, file: string}> }>(IPC_ROUTES.pluginsListUserscripts, {})
      .then((res) => res.scripts || [])
  },
  /**
   * 单脚本启停（`key = <pluginId>/<scriptId>`，由主进程下发，UI 当不透明串处理）。
   *
   * 与插件级 `setEnabled` 是两层开关：插件停用 = 它名下所有脚本一起停；
   * 这里只停一条。返回 `{ ok, key, enabled, reason? }`。
   *
   * @param {string} key
   * @param {boolean} enabled
   */
  setUserScriptEnabled(key: string, enabled: boolean) {
    return invoke(IPC_ROUTES.pluginsSetUserscriptEnabled, { key: String(key), enabled: enabled !== false })
  },
  /**
   * 卸载一个**运行时安装**的插件（删掉 `userData/plugins/<id>/`）。
   *
   * 与"禁用"是两件事：禁用只是不跑（资产还在），卸载是把资产拿掉。
   * 内置插件会被主进程拒绝（它们在应用安装目录里）。
   *
   * @param {string} id
   */
  uninstallPlugin(id: string) {
    return invoke(IPC_ROUTES.pluginsUninstall, { id })
  },
  /**
   * 受信任的签名公钥（验签的**另一半**，分三级）。
   *
   * 没有它，`signature` 就只是摆设 —— 公钥要用户手工丢进 `plugin-trust` 目录，
   * 而那个目录藏在 `userData` 深处。
   */
  listTrustedKeys() {
    return invoke(IPC_ROUTES.pluginsTrustList, {}).then((res) => (res && res.keys) || [])
  },
  /**
   * 导入一把公钥（`.pem`）。`path` 省略时**由主进程弹选择框**。
   * 返回 `{ ok, keyId, level, fingerprint }`；取消 → `{ ok:false, canceled:true }`（不是失败）。
   *
   * `keyId` 取**文件名**（去掉 `.pem`）—— 因为 manifest 的 `signature.keyId` 就是按它找文件的，
   * 所以"作者告诉你用哪个 keyId"是这套约定的一半。
   *
   * `level`：`community`（默认，作者公布的公钥）/ `local`（自己生成、开发用）。
   * `official` 会被主进程拒绝 —— 那是"随应用分发"的同义词，界面上不该能往里写。
   */
  addTrustedKey(opts: JsonRecord = {}) {
    const payload: JsonRecord = { overwrite: opts.overwrite === true }
    if (opts.path) payload.path = String(opts.path)
    if (opts.level) payload.level = String(opts.level)
    return invoke(IPC_ROUTES.pluginsTrustAdd, payload)
  },
  /**
   * 移除一把受信任公钥（此后用它签的插件回落到 `unknown-key`，仍可安装）。
   * **必须带级别**：不同级别允许同名公钥，只给 keyId 无法确定删哪一个。
   */
  removeTrustedKey(keyId: string, level?: 'community' | 'local') {
    const payload: JsonRecord = { keyId: String(keyId) }
    if (level) payload.level = String(level)
    return invoke(IPC_ROUTES.pluginsTrustRemove, payload)
  },
  /**
   * 插件源（社区市场的**索引那一半**）—— 可以配**多个源**，顺序即优先级。
   *
   * 返回 `{ ok, sources: [{url, ok, name, reason, cached, skipped, count}], duplicates, entries }`；
   * 每个条目自带 `installed / installedVersion / updateAvailable`（**由主进程算好**，
   * UI 不自己比版本号）与 `sourceUrl / sourceName`（同 id 在多源出现时能看出装的是哪个源的包）。
   *
   * `ok:false` 且 `sources` 为空 = 还没配置源，**不是错误**（只用本地安装是完全可用的状态）。
   * 某一条源失败时 `sources[i].ok === false` 且带 `reason` —— **逐条看状态**，
   * 不要用顶层的 `ok` 去判断"哪个源坏了"。
   * @param {{ force?: boolean }} [opts] force = 跳过短期缓存（用户点"刷新"时用）
   */
  marketList(opts: JsonRecord = {}) {
    return invoke(IPC_ROUTES.pluginsMarketList, { force: opts.force === true })
  },
  /**
   * 设置**整个**源列表（增 / 删 / 排序都是它）。
   * 拆成 add/remove 三条会让"两条相继失败"留下一个界面上看不到的中间态；
   * 而顺序即优先级，顺序也必须能设置 —— 所以只有整表提交这一种语义是对的。
   * @param {string[]} sources
   */
  marketSetSources(sources: readonly string[]) {
    return invoke(IPC_ROUTES.pluginsMarketSetSources, {
      sources: Array.isArray(sources) ? sources.map((s) => String(s == null ? '' : s)) : []
    })
  },
  /**
   * 从源安装 / 更新一个插件。
   *
   * 落盘路径与"从压缩包安装"**完全相同**（体检 / 撞名 / 穿越 / 签名一个都不少），
   * 额外多一道索引声明的 `sha256` 校验。默认允许覆盖（"更新"就是要覆盖旧版本）。
   */
  marketInstall(id: string, opts: JsonRecord = {}) {
    return invoke(IPC_ROUTES.pluginsMarketInstall, {
      id: String(id),
      overwrite: opts.overwrite !== false,
      force: opts.force === true
    })
  },
  /**
   * 任何来源的插件变更（本窗口或其它窗口触发）→ 实时对账刷新。
   *
   * 返回**退订函数**：面板 / 视图卸载时必须解绑，否则面板销毁后回调仍会执行
   * （它闭包持有已分离的 DOM，表现为"改了开关但界面不动"或内存泄漏）。
   *
   * @param {(payload: unknown) => void} handler
   * @returns {() => void}
   */
  onChanged(handler: (payload: JsonRecord) => void) : () => void {
    return getHiraBridge().on.subscribe<JsonRecord>(IPC_EVENTS.pluginsChanged, handler)
  },

  // ── 插件键值存储（开放 API 的持久化面）────────────────────────────────
  //
  // 为什么这里做 JSON 编解码、而不是把"字符串"这件事暴露给调用方：
  // 落库列是 TEXT（契约 `value: z.string()`），而插件作者想存的是对象 / 数组 / 数字。
  // 编解码只写在这**一处**，`hira.storage.get` 与 `plugins.storageGet` 于是有同一个语义：
  // 存什么、取回来就是什么。
  //
  // 为什么不做"字符串原样存"的快路径：那样 `set('k', '"x"')` 与 `set('k', 'x')`
  // 会得到同一个值，读回时无法判断该不该 parse —— 类型信息就丢了。
  //
  // 隔离与配额**不在这里**：`pluginId` 是调用方传的，但主进程还有一道闸门
  // （第三方插件必须持有 `storage:read|write`）；沙箱面板走桥时 `pluginId` 由父侧覆写，
  // 面板无法读取别的插件的键。

  /**
   * 读取本插件的一条键值。
   * @returns {Promise<{ ok: boolean, value: unknown, updatedAt: number|null, reason?: string }>}
   */
  async storageGet(pluginId: string, key: string) : Promise<{ ok: boolean, value: unknown, updatedAt: number|null, reason?: string }> {
    const res = await invoke<{ ok: boolean, value: unknown, updatedAt: number|null, reason?: string }>(IPC_ROUTES.pluginsStorageGet, { pluginId: String(pluginId), key: String(key) })
    if (!res || res.ok !== true) return res || { ok: false, value: null, updatedAt: null }
    return { ...res, value: decodeStored(res.value) }
  },
  /**
   * 写入一条键值（任意可 JSON 序列化的值）。
   *
   * `value` 无法序列化（循环引用 / BigInt）时**直接返回失败**，不抛异常 ——
   * 面板里的 `await hira.storage.set(...)` 因此不必自己包 try/catch 也能拿到原因。
   * @returns {Promise<{ ok: boolean, keys?: number, bytes?: number, reason?: string }>}
   */
  storageSet(pluginId: string, key: string, value: unknown) : Promise<{ ok: boolean, keys?: number, bytes?: number, reason?: string }> {
    let encoded
    try {
      encoded = JSON.stringify(value === undefined ? null : value)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return Promise.resolve({ ok: false, reason: `值无法序列化为 JSON：${message}` })
    }
    return invoke(IPC_ROUTES.pluginsStorageSet, { pluginId: String(pluginId), key: String(key), value: encoded })
  },
  /** 删除一条键（键不存在也算成功，`removed` 为 0）。 */
  storageRemove(pluginId: string, key: string) {
    return invoke(IPC_ROUTES.pluginsStorageRemove, { pluginId: String(pluginId), key: String(key) })
  },
  /**
   * 列出本插件的键（可按前缀过滤）。
   * @returns {Promise<{ ok: boolean, keys: Array<{ key: string, updatedAt: number }>, reason?: string }>}
   */
  storageKeys(pluginId: string, prefix?: string) : Promise<{ ok: boolean, keys: Array<{ key: string, updatedAt: number }>, reason?: string }> {
    const payload: JsonRecord = { pluginId: String(pluginId) }
    if (prefix != null && String(prefix) !== '') payload.prefix = String(prefix)
    return invoke(IPC_ROUTES.pluginsStorageKeys, payload)
  },
  /** 清空本插件的全部键（卸载时主进程也会调同一条实现）。 */
  storageClear(pluginId: string) {
    return invoke(IPC_ROUTES.pluginsStorageClear, { pluginId: String(pluginId) })
  }
}

/** 反序列化：坏数据不炸面板，原样返回（那是**上一位作者**写进去的东西）。 */
function decodeStored(raw: unknown): unknown {
  if (raw == null) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (_) {
    return raw
  }
}


