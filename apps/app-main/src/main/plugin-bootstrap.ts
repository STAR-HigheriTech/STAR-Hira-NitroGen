import path from 'node:path'
import {
  PluginRegistryV2,
  type PluginRegistryOptions,
  type UnknownRecord
} from '@hira-ng/infra-plugin'
import type { PluginStateStore } from './plugin-state-store'

interface SeedResult { newlySeeded: string[]; marked: string[] }

interface EnableAppPluginsOptions {
  appRoot: string
  pluginUserDir: string
  win: unknown
  webContents: unknown
  webContentsManager: unknown
  layoutCoordinator: unknown
  themeManager: unknown
  tabManager: unknown
  providerRegistry: PluginRegistryOptions['providerRegistry']
  contributions: PluginRegistryOptions['contributions']
  panelCatalog: unknown
  extensionPoints: PluginRegistryOptions['extensionPoints']
  pluginStateStore?: PluginStateStore | null
  onPluginAutoDisable?: PluginRegistryOptions['onAutoDisable']
  getDomainServices?: () => UnknownRecord | null | undefined
  kernel?: UnknownRecord | null
  createCapabilities?: PluginRegistryOptions['createCapabilities']
  loader?: PluginRegistryOptions['loader']
}

/**
 * 「出厂默认关闭」的**播种**（一次性）—— 在 `enableAll` **之前**调用。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 * `enableAll` 的判据只有 `_userDisabled` / `_autoDisabled` 两个集合 ——
 * **磁盘上没记录就是启用**。这对"浏览器要能跑"所必需的那批插件是对的，但对
 * 用户可能根本不需要的可选功能是错的：它会在用户从没同意过的时候就跑起来，
 * 占内存、出现在侧栏上。
 *
 * ── 做法：复用既有机制，不新增第 4 种状态 ────────────────────────────────
 * 声明了 `defaultDisabled` 的插件在这里被**写成"用户主动禁用"**。于是它
 * 既不被 enable（不跑代码、不注册能力、不加载 UI），又照旧出现在插件目录里
 * （图标 / 按钮位都在）—— 用户在插件中心点一下就能打开，与关掉一个普通插件
 * 之后的体验完全一致。**"出厂关闭"因此不是一种新状态，只是一个初始值。**
 *
 * ── ⚠ 要害：`seeded` 标记 ──────────────────────────────────────────────
 * 只在"从没播种过"时才写，写过就永远不再碰。没有这个标记的话，用户手动打开、
 * 下次启动又会被关回去 —— 因为"它不在 disabled 列表里"这个判据，与用户主动
 * 打开的结果长得一模一样，从数据上根本分不出是谁干的。
 *
 * 不可禁用的插件跳过写入（注册中心也会拒，但这里先不产生垃圾数据）：
 * 它们的"默认不跑"本来就没有意义 —— 不可禁用意味着没有"关"这个状态。
 *
 * @param {{ getManifests: Function, isNonDisableable: Function,
 *           setUserDisabled: Function, listUserDisabled: Function }} pluginRegistry
 * @param {{ loadDefaultsSeeded?: Function, saveDefaultsSeeded?: Function, saveDisabled?: Function }} pluginStateStore
 * @returns {{ newlySeeded: string[], marked: string[] }}
 *   `newlySeeded` = 本次真正被关上的；`marked` = 本次记入标记的全部（含跳过的不可禁用者）
 */
export function seedDefaultDisabled(pluginRegistry: PluginRegistryV2, pluginStateStore: PluginStateStore | null | undefined): SeedResult {
  const empty: SeedResult = { newlySeeded: [], marked: [] }
  if (!pluginRegistry || typeof pluginRegistry.getManifests !== 'function') return empty
  if (!pluginStateStore || typeof pluginStateStore.loadDefaultsSeeded !== 'function') return empty

  const seeded = new Set(pluginStateStore.loadDefaultsSeeded())
  const newlySeeded: string[] = []
  const marked: string[] = []
  for (const m of pluginRegistry.getManifests()) {
    if (!m || !m.defaultDisabled) continue
    if (seeded.has(m.id)) continue
    seeded.add(m.id)
    marked.push(m.id)
    if (pluginRegistry.isNonDisableable(m.id)) continue
    pluginRegistry.setUserDisabled(m.id, true)
    newlySeeded.push(m.id)
  }
  if (!marked.length) return empty

  if (typeof pluginStateStore.saveDefaultsSeeded === 'function') {
    pluginStateStore.saveDefaultsSeeded(Array.from(seeded))
  }
  /**
   * 落盘 `plugins.disabled`：走 `saveDisabled`（**整表覆盖**）而不是逐个 `setDisabled`。
   * 调用点已经把磁盘的 userDisabled 读回并灌进注册中心，所以这里写"注册中心当前的全集"
   * 才是对的；逐个读-改-写会在多次调用之间互相覆盖（后一次读到的是前一次之前的旧值）。
   */
  if (newlySeeded.length && typeof pluginStateStore.saveDisabled === 'function') {
    pluginStateStore.saveDisabled(pluginRegistry.listUserDisabled())
  }
  return { newlySeeded, marked }
}

export async function enableAppPlugins({
  appRoot,
  pluginUserDir,
  win,
  webContents,
  webContentsManager,
  layoutCoordinator,
  themeManager,
  tabManager,
  providerRegistry,
  contributions,
  panelCatalog,
  extensionPoints,
  pluginStateStore,
  onPluginAutoDisable,
  getDomainServices,
  /**
   * **内核端口**（仅第一方插件可见，见 PluginRegistryV2#_pluginContext）。
   *
   * 第一方插件在自己的 `enable()` 里需要注册 IPC / 读写库 / 广播 / 开窗，
   * 而 infra 的插件 ctx 刻意不含这些主进程原语 —— 这里是显式注入点：
   * 组合根把「可信代码才配拿的能力」装成一个对象传进来，注册中心只负责
   * 按 `manifest.isFirstParty` 决定给不给。缺省 null = 没有插件能用（不影响现有插件）。
   */
  kernel,
  /**
   * **能力门面工厂**（`ctx.browser` 的唯一实现，见 app-main/plugin-capabilities.js）。
   * 缺省 null = 插件拿不到 browser 命名空间（不影响既有 ctx）。
   *
   * @type {((manifest: object, grantedScopes: string[]) => object) | null}
   */
  createCapabilities,
  /**
   * **模块加载端口**（依赖注入，见 infra `_loadModule`）。
   *
   * 组合根（module-bootstrap）注入的是「进程级隔离」实现：非第一方插件送进
   * 独立 utilityProcess，第一方由端口委托回 infra 的默认策略。
   * 缺省为 null → 退回改造前的行为（第一方 require / 其余进程内沙箱），
   * 于是"隔离器没装"这件事在任何调用方都不需要 if 判断。
   */
  loader
}: EnableAppPluginsOptions): Promise<PluginRegistryV2> {
  const pluginDir = path.join(appRoot, 'build', 'plugins')
  // contributions / extensionPoints 都由 main.js 建好并注入：面板目录与插槽宿主
  // （主题、搜索聚合…）必须在 registerCoreIpc 之前就能读到，不能等插件启动才诞生。
  const pluginRegistry = new PluginRegistryV2({
    pluginDir,
    // 用户装的第三方插件（目录形态）。与内置插件**分开**：应用目录打包后只读，
    // 且卸载/更新应用绝不能把用户装的东西一起抹掉。见 PluginRegistryV2 的构造函数。
    pluginUserDir,
    providerRegistry,
    contributions,
    extensionPoints,
    // 加载策略端口：由组合根决定"哪些插件在独立进程里跑"。infra 对它零感知。
    loader: loader ?? undefined,
    // 能力门面：infra 只按插件决定"给不给"，实现全在 APPS。
    createCapabilities: createCapabilities ?? undefined,
    // 连环坏触顶时的副作用（卸载 + 落盘 + 广播）由 main.js 注入 ——
    // infra 只判定"该停用了"，那三件事需要 context / 存储 / 广播出口，都在 APPS。
    onAutoDisable: onPluginAutoDisable
  })
  pluginRegistry.discover()

  /**
   * 恢复上次的"用户主动禁用"与"自动停用"。
   *
   * 顺序不能反：必须在 enableAll **之前**灌进去 —— enableAll 会跳过这些插件，
   * 于是它们既不会被启用、也不会产生"找不到依赖"之类的连锁失败。
   *
   * 三种"不启用"的恢复策略各不相同（这是本块的核心区分）：
   *   userDisabled  恢复（用户意图）
   *   autoDisabled  恢复（系统判定；但用户点开关即可清除 —— 一键恢复）
   *   failed        不恢复 —— 每次启动重试，那就是失败自愈
   */
  if (pluginStateStore) {
    const disabled = typeof pluginStateStore.loadDisabled === 'function' ? pluginStateStore.loadDisabled() : []
    /**
     * ⚠ **不可禁用的插件会被注册中心拒绝写入**（见 `PluginRegistryV2#setUserDisabled`）。
     *
     * 这正是"用户升级后插件中心仍然是关着的"的来源：老版本的 `plugins.disabled` 里
     * 躺着 `panel-plugins`（那时它还允许被关）。注册中心拒了写入之后，内存里它会正常启用，
     * 但**磁盘上的残留还在** → 每次启动都要再拒一遍。
     * 所以把被拒的 id 收集起来、落盘清掉：一次性收尾，之后每次启动都是干净的。
     */
    const rejected: string[] = []
    for (const id of disabled) {
      if (pluginRegistry.setUserDisabled(id, true) === false) rejected.push(id)
    }
    if (rejected.length) {
      const kept = disabled.filter((id: string) => rejected.indexOf(id) === -1)
      if (typeof pluginStateStore.saveDisabled === 'function') pluginStateStore.saveDisabled(kept)
      console.log(`[plugin] 已清除磁盘上"不可禁用插件"的禁用残留（关掉就没有回头路）：${rejected.join(', ')}`)
    }
    if (disabled.length) console.log(`[plugin] restored ${disabled.length} user-disabled plugin(s):`, disabled.join(', '))

    const autoDisabled = typeof pluginStateStore.loadAutoDisabled === 'function' ? pluginStateStore.loadAutoDisabled() : []
    /**
     * ⚠ **与上面 `rejected` 完全同构的一遍** —— 自动停用同样会被注册中心拒绝写入
     * （见 `PluginRegistryV2#setAutoDisabled`）。
     *
     * 真实场景就是这次要修的那个 bug：老版本让 `tabs-service`（core）被连环坏判定停用了，
     * 磁盘的 `plugins.autoDisabled` 里躺着它。不清的话下次启动又灌一遍，
     * 用户永远卡在「导航不可用：能力 tabs.navigate 已被禁用」——
     * 而且点插件中心的开关也救不回来（那条 IPC 就在它提供的能力里）。
     */
    const rejectedAuto: string[] = []
    for (const id of autoDisabled) {
      if (pluginRegistry.setAutoDisabled(id, true) === false) rejectedAuto.push(id)
    }
    if (rejectedAuto.length) {
      if (typeof pluginStateStore.setAutoDisabled === 'function') {
        for (const id of rejectedAuto) pluginStateStore.setAutoDisabled(id, false)
      }
      console.log(`[plugin] 已清除磁盘上"不可禁用插件"的自动停用残留（关掉就没有回头路）：${rejectedAuto.join(', ')}`)
    }
    const autoKept = autoDisabled.filter((id: string) => rejectedAuto.indexOf(id) === -1)
    if (autoKept.length) console.log(`[plugin] restored ${autoKept.length} auto-disabled plugin(s):`, autoKept.join(', '))

    /**
     * 第三方插件的**权限授权**也要在 enableAll 之前恢复 —— 否则已授权的插件
     * 会在启动时先落进"等待授权"（enableAll 走授权闸门），
     * 用户重启后看到自己明明同意过的插件又在那儿等授权。
     */
    const granted = typeof pluginStateStore.loadGrantedPermissions === 'function' ? pluginStateStore.loadGrantedPermissions() : {}
    const grantedIds = Object.keys(granted)
    for (const id of grantedIds) pluginRegistry.setGrantedPermissions(id, granted[id])
    if (grantedIds.length) console.log(`[plugin] restored permission grants for ${grantedIds.length} plugin(s):`, grantedIds.join(', '))

    /**
     * 「出厂默认关闭」的播种 —— 必须排在**恢复 userDisabled 之后**（它要在那个集合上追加）、
     * `enableAll` **之前**（要能影响本次启动到底启用谁）。细节见 seedDefaultDisabled。
     */
    const seedResult = seedDefaultDisabled(pluginRegistry, pluginStateStore)
    if (seedResult.newlySeeded.length) {
      console.log(
        `[plugin] 已按出厂默认关闭 ${seedResult.newlySeeded.length} 个可选插件（可在插件中心打开）：`,
        seedResult.newlySeeded.join(', ')
      )
    }
  }

  const enableResult = await pluginRegistry.enableAll({
    pluginRegistry,
    providerRegistry: pluginRegistry.getProviderRegistry(),
    contributions: pluginRegistry.getContributions(),
    // 插槽调度器一并进 ctx：插件在自己的 `extensionPoints()` 钩子里可以直接查询 /
    // 声明 / 挂载，不需要再从别处拿引用。
    extensionPoints: pluginRegistry.getSlotRegistry(),
    win,
    webContents,
    webContentsManager,
    layoutCoordinator,
    themeManager,
    tabManager,
    panelCatalog,
    getDomainServices,
    // 内核端口：只在这里注入，注册中心按 isFirstParty 决定是否下发给插件。
    kernel,
    appRoot
  })

  /**
   * `enableAll` 的**底层自愈**兜底：它在循环前会把"不可禁用插件"从 `_userDisabled` 里剔掉，
   * 并把剔掉的 id 回传。上面基于 `setUserDisabled` 的返回值已经清过一遍磁盘，
   * 这里是第二道 —— 防的是"绕过 `setUserDisabled` 直接操作 `_userDisabled` 的路径"。
   */
  const healed = (enableResult && enableResult.healed) || []
  if (healed.length && pluginStateStore && typeof pluginStateStore.saveDisabled === 'function') {
    const current = typeof pluginStateStore.loadDisabled === 'function' ? pluginStateStore.loadDisabled() : []
    pluginStateStore.saveDisabled(current.filter((id: string) => healed.indexOf(id) === -1))
  }
  // 同一道兜底对"自动停用"再走一遍 —— 见上面 rejectedAuto 的说明。
  const healedAuto = (enableResult && enableResult.healedAuto) || []
  if (healedAuto.length && pluginStateStore && typeof pluginStateStore.setAutoDisabled === 'function') {
    for (const id of healedAuto) pluginStateStore.setAutoDisabled(id, false)
  }

  return pluginRegistry
}

