/**
 * 「功能面 → 提供它的引擎插件」映射 —— §10.4「UI 与引擎的联动禁用」的**唯一事实源**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是 §9 的另一半）
 * ══════════════════════════════════════════════════════════════════════
 * §9 解决了"开关为什么不起作用"（**实现层**）：禁用一个引擎后，它的 capability 会真的失败。
 * 但那只是把问题从"静默无效"换成了"点一下到处报错" —— 书签栏还在、星标还在、⋮ 菜单里
 * 「书签」还在，用户点进去才看到错。所以必须再补上**表达层**：
 * 引擎被禁用 → 依赖它的 UI 入口**自动隐藏**（而不是留着报错）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是"一张表 + 一个端口"，而不是让每个 UI 自己去问
 * ══════════════════════════════════════════════════════════════════════
 * 书签栏、星标、⋮ 菜单项、下载条、下载页… 大约二十个入口都想知道"书签引擎在不在"。
 * 让它们各自去查 `plugins.list` 会带来两个必然的后果：
 *   · 判断逻辑散落二十处 → 迟早漂移（有人用 `enabled`、有人用 `blocked`、有人忘了看 `autoDisabled`）；
 *   · 插件每次启停要逐个通知 → 漏掉一个就是"那个按钮永远不回来了"。
 * 所以：**映射只此一处**，通过 `features:availability` 一个端口查，用 `plugins:changed`
 * 一个事件订阅（见 `renderer/shared/features-client.js` 的单例 store）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 判定规则（fail-open 的精确形式）
 * ══════════════════════════════════════════════════════════════════════
 * 一个功能面**不可用** ⟺ 它的引擎插件**存在**、且处于「**被显式关掉**」的三种状态之一：
 *   `userDisabled`（用户关的）/ `autoDisabled`（连环坏停用）/ `blocked`（它的前置没起来）
 *
 * 刻意**不**包含以下两种"没在跑"，它们不该让 UI 消失：
 *   · **插件不存在**（目录里没有它）—— 那时功能由域服务直连兜底，**功能其实还在**。
 *     这与 §9.3 的 `blockedCapabilities` 判据完全同源（只由"被禁用的插件"贡献）。
 *   · **`failed`（启用时抛错）/ 尚未启用** —— 前者下次启动自愈，后者是启动过程中
 *     （`enableAll` 还在按拓扑序一个个启用）。把它们算作不可用会让整个界面在启动头
 *     几百毫秒里先隐藏再冒出（闪一下），而用户什么都没做。
 *
 * 这条规则的另一个好处：**不需要"插件系统就绪"标志位**。判定只看"是否被显式关掉"，
 * 而显式禁用状态在 `enableAll` **之前**就已恢复完毕（见 plugin-bootstrap.js），
 * 所以从第一帧起答案就是稳定的。
 */

/**
 * 功能面清单。`plugins` 是"提供该功能面所需的引擎插件"——**任何一个没启用，功能面即不可用**。
 *
 * 只登记**真的会被引擎禁用影响**的 UI 入口所在的功能面，不追求覆盖每个 capability：
 * 这张表的用途是"决定要不要渲染某个入口"，不是权限清单。
 *
 * ⚠ 登记的原则是「**按事实，不按愿望**」：只登记**真的会被引擎禁用影响**的 UI 入口所在的功能面。
 * 反面例子（曾经真实存在）：`space.*` 一度没有任何插件声明它，于是引擎启停**不会**影响
 * 空间切换器 —— 那时若把它挂到 `profiles` 上，只会让一个仍正常工作的入口被藏起来。
 * 正解是**先补上能力归属**（新增 `space-service` 插件），再在这里登记 `spaces`。
 */
interface PluginManifestInfo {
  id: string
}

interface PluginRegistryLike {
  getManifests: () => PluginManifestInfo[]
  isUserDisabled?: (pluginId: string) => boolean
  isAutoDisabled?: (pluginId: string) => boolean
  getState?: (pluginId: string) => { blocked?: boolean } | null
}

const FEATURES = Object.freeze({
  bookmarks: Object.freeze({ plugins: Object.freeze(['bookmark-service']), label: '书签' }),
  bookmarkBackup: Object.freeze({ plugins: Object.freeze(['bookmark-backup-provider']), label: '书签备份' }),
  history: Object.freeze({ plugins: Object.freeze(['history-service']), label: '历史记录' }),
  downloads: Object.freeze({ plugins: Object.freeze(['download-service']), label: '下载' }),
  search: Object.freeze({ plugins: Object.freeze(['search-service']), label: '地址栏搜索建议' }),
  passwords: Object.freeze({ plugins: Object.freeze(['password-service']), label: '密码' }),
  permissions: Object.freeze({ plugins: Object.freeze(['permission-service']), label: '站点权限' }),
  profiles: Object.freeze({ plugins: Object.freeze(['profile-service']), label: '配置文件' }),
  // `space-service` 是后补的 —— 此前 `space.*` 没有任何插件声明（能力归属缺口，见 §6 缺口表），
  // 于是空间切换器 / 空间面板不受任何引擎开关约束。补上 owner 之后这里才能按事实登记。
  spaces: Object.freeze({ plugins: Object.freeze(['space-service']), label: '空间' }),
  session: Object.freeze({ plugins: Object.freeze(['session-service']), label: '会话' }),
  settings: Object.freeze({ plugins: Object.freeze(['settings-service']), label: '设置' }),
  keybindings: Object.freeze({ plugins: Object.freeze(['keybindings-service']), label: '快捷键' }),
  extensions: Object.freeze({ plugins: Object.freeze(['extensions-service']), label: '扩展' }),
  externalGames: Object.freeze({ plugins: Object.freeze(['external-games-service']), label: '外置游戏' }),
  totp: Object.freeze({ plugins: Object.freeze(['totp-service']), label: '验证器' }),
  tabs: Object.freeze({ plugins: Object.freeze(['tabs-service']), label: '标签' }),
  // 屏幕扫码（取景框）—— 抓屏能力由 `qr-scanner` 插件提供，而它是**可选、默认关闭**的。
  // 「验证器」面板据此决定给不给「扫描屏幕二维码」：装了但被禁用 = 功能真的没有
  // （`qr.captureScreen` 会抛），所以入口应该消失，而不是留一个点了就报错的按钮。
  qrScan: Object.freeze({ plugins: Object.freeze(['qr-scanner']), label: '屏幕扫码' }),
  // 站点应用（PWA）：地址栏安装按钮、应用菜单入口、管理页都挂在它上面。
  // 引擎被禁用 → 入口整体消失（`pwa.*` 能力会真的失败，不是"点了没反应"）。
  pwaApps: Object.freeze({ plugins: Object.freeze(['pwa-service']), label: '已安装应用' }),
  // 集锦（笔记）：⋮ 菜单的「集锦」入口同时依赖**引擎**与**面板插件** ——
  // 只关掉面板（panel-notes）时 rail 按钮会消失，若菜单项还留着就是"点了没反应"。
  // 两个插件任一被显式关掉都算不可用（`FEATURES` 的语义就是"全部启用才可用"）。
  notes: Object.freeze({ plugins: Object.freeze(['notes-service', 'panel-notes']), label: '集锦' }),
  // AI 助手：**所有 AI 入口**（网页 / 标签 / 书签 / 历史 / 笔记 / 媒体 / 会话 … 的右键菜单、
  // 地址栏「询问 AI」、新标签页动作、工具菜单、快捷键）都由引擎插件贡献实现、由面板插件
  // 承载落点。只关掉面板（panel-ai）而引擎仍在跑时，菜单项点下去会打开一个不存在的面板 ——
  // 「点了没反应」正是本表要消灭的形态，所以两个插件任一被显式关掉都算 AI 不可用。
  //
  // 这是 AI 入口的**唯一门禁**：插件侧（`ai/main/intent.cjs`）在每次生成菜单/建议/快捷键时
  // 现查 `isFeatureOn('ai')`，不各自判断「panel-ai 在不在」—— 判定规则只有这一份。
  ai: Object.freeze({ plugins: Object.freeze(['ai-engine', 'panel-ai']), label: 'AI 助手' })
}) as Readonly<Record<string, Readonly<{ plugins: readonly string[]; label: string }>>>

const FEATURE_IDS = Object.freeze(Object.keys(FEATURES))

/**
 * 某个插件是否处于「被显式关掉」的三种状态之一。
 * 判定细节见文件头的"判定规则"。
 */
function isExplicitlyOff(registry: PluginRegistryLike | null | undefined, pluginId: string): boolean {
  if (!registry || typeof registry.getManifests !== 'function') return false
  const manifests = registry.getManifests()
  // 插件**不存在** → 不算"关掉"：功能由域服务直连兜底，仍可用（fail-open）
  if (!manifests.some((m) => m.id === pluginId)) return false
  if (typeof registry.isUserDisabled === 'function' && registry.isUserDisabled(pluginId)) return true
  if (typeof registry.isAutoDisabled === 'function' && registry.isAutoDisabled(pluginId)) return true
  const st = typeof registry.getState === 'function' ? registry.getState(pluginId) : null
  return !!(st && st.blocked)
}

/**
 * 计算全部功能面的可用性。
 */
function resolveFeatureAvailability(
  registry: PluginRegistryLike | null | undefined
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of FEATURE_IDS) {
    const feature = FEATURES[id]
    out[id] = !feature.plugins.some((pid) => isExplicitlyOff(registry, pid))
  }
  return out
}

/**
 * 不可用功能面的**诊断视图**（日志 / 调试用；界面只用 `resolveFeatureAvailability`）。
 */
function describeUnavailableFeatures(
  registry: PluginRegistryLike | null | undefined
): Array<{ id: string; label: string; offPlugins: string[] }> {
  const out: Array<{ id: string; label: string; offPlugins: string[] }> = []
  for (const id of FEATURE_IDS) {
    const feature = FEATURES[id]
    const offPlugins = feature.plugins.filter((pid) => isExplicitlyOff(registry, pid))
    if (offPlugins.length) out.push({ id, label: feature.label, offPlugins })
  }
  return out
}

module.exports = {
  FEATURES,
  FEATURE_IDS,
  resolveFeatureAvailability,
  describeUnavailableFeatures,
  isExplicitlyOff
}
