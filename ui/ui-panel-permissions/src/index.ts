// @ts-check
/**
 * @hira-ng/ui-panel-permissions —— 站点权限侧边面板
 *
 * 哑组件：状态上行 setRules() / setPending()，意图下行 onIntent。
 * 与 ui-panel-history / ui-panel-downloads 严格同构 —— 本文件不 import electron、
 * 不直接调 IPC、不订阅事件：拉数据 / 订阅 permission:request|permission:cleared /
 * 转发意图全部在编排层（apps/app-main/src/renderer/panels/main.js）。
 *
 * 能力（与 hira:// 内部页 pages/permissions 同一交互规格）：
 *   - 当前站点聚合卡（地址栏锁图标点进来时的第一落点）：本站已有权限 + 「全部规则」
 *     （把站点灌进下方搜索框）。破坏性动作（重置本站权限 / 清除本站数据）不放在这里 ——
 *     它们属于站点设置，不该混进"查 / 改权限"的面板。它**不是**第二块面板 ——
 *     同一块面板因此同时覆盖「这一站」与「所有站」两个视角，站内规则只是下方总表的按站点切片。
 *   - 第一行：站点搜索框（本地过滤，输入即刷，无 IPC 往返 → 跟手）
 *   - 第二行：权限检索下拉（全中文名，首项「全部权限」）
 *   - 规则行 = 站点 + 权限中文名 + 当前状态（允许 / 阻止 / 询问）+ 允许 / 阻止 / 清除
 *     （「清除」走 permission:remove，语义是回到「询问」，不是删站点）
 *   - 待处理申请区：四档就地决定 —— 允许一次 / 始终允许 / 阻止一次 / 始终阻止
 *     （文案与 allow·persist 语义全部来自共享的 PERMISSION_CHOICES，与权限浮层逐字一致；
 *      编排层回 permission:respond）
 *
 * 权限中文名与「四档决定」一律走 @hira-ng/shared-types 的 permission-labels.mjs 单一真源 ——
 * 与内部页、权限浮层共用同一份映射与同一份选项规格。历史实现的缺陷（media 被错标成
 * 「媒体自动播放」、只覆盖 10 个类型、clipboard-sanitized-write 之类代码名直接裸露、
 * 面板只给「允许 / 拒绝」两档而浮层给四档）随之根治。
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import { injectPanelStyles, iconByName } from '@hira-ng/ui-common'
import {
  permissionLabel,
  permissionFilterOptions,
  PERMISSION_CHOICES,
  PERMISSION_SETTING_ACTIONS,
  PERMISSION_SETTING_LABELS,
  isValidPermissionSetting,
  hostOfOrigin
} from '@hira-ng/shared-types/src/permission-labels.mjs'
import { isSameSite, siteInfoOfUrl } from '@hira-ng/shared-types/src/site.mjs'

const STYLE_ID = 'hira-panel-permissions-styles'

/**
 * 站点卡上的动作：[action, label, hint]。
 * 只剩「全部规则」——它纯本地（灌搜索框）。重置权限 / 清除数据是破坏性动作，
 * 且需要在主进程做跨域删除，不属于本面板职责（面板只查 / 改已有规则）。
 */
const SITE_ACTIONS = [
  ['view-all', '全部规则', '在下方规则表中按该站点筛选']
]

/** 「全部权限」的筛选取值。真实选项都是中文名，不会与它撞车。 */
const FILTER_ALL = 'all'

type PermissionSetting = 'allow' | 'block' | 'ask'

interface PermissionRuleView {
  domain: string
  permissionType: string
  setting: PermissionSetting
}

interface PermissionRuleInput {
  domain?: unknown
  origin?: unknown
  permissionType?: unknown
  type?: unknown
  setting?: unknown
}

interface PendingRequestView {
  id: string
  origin: string
  type: string
  sensitive: boolean
}

interface PendingRequestInput {
  id?: unknown
  origin?: unknown
  type?: unknown
  sensitive?: unknown
}

type SiteInfo = NonNullable<ReturnType<typeof siteInfoOfUrl>>

interface PermissionIntent {
  type: string
  origin?: string
  permissionType?: string
  setting?: PermissionSetting
  id?: string
  allow?: boolean
  persist?: boolean
}

interface PermissionTabsPort {
  projection(): Promise<Array<{ active?: boolean; url?: string }>>
  onChanged(listener: () => void): () => void
}

interface PermissionBridge {
  provider: { invoke(route: string, payload?: unknown): Promise<unknown> }
}

type PermissionsPanelContext = Omit<PanelContext, 'clients' | 'bridge' | 'events' | 'on'> & {
  onIntent?: (intent: PermissionIntent) => void
  clients?: (PanelContext['clients'] & { tabs?: PermissionTabsPort }) | null
  bridge?: PermissionBridge
  events?: Record<string, string>
  on?: (route: string, listener: (payload: unknown) => void) => (() => void) | void
}

export function injectPermissionsPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .perm-panel__wrap { display: flex; flex-direction: column; height: 100%; gap: 8px; padding: 0; }
    .perm-panel__toolbar {
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
      padding: 2px 0 8px;
    }
    /* 第一行：站点搜索（占满整行）—— 站点是长文本，整行才看得清搜的是哪个域名 */
    .perm-panel__search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .perm-panel__search:focus-within { background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); box-shadow: var(--hira-focus-ring); }
    .perm-panel__search input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; padding: 0;
    }
    .perm-panel__search input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    /* 清空按钮：只在有输入时出现（见 syncSearchClear）—— 空框上挂个叉只是噪音 */
    .perm-panel__search-clear {
      flex-shrink: 0; width: 18px; height: 18px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: var(--hira-radius-xs, 6px); background: transparent;
      color: var(--hira-text-tertiary, #8b8b8b);
      font-size: 14px; line-height: 1; cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .perm-panel__search-clear:hover {
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-surface-soft, rgba(0,0,0,0.06));
    }
    /* display:flex 会盖掉 [hidden] 的 UA 样式，必须显式写回来 */
    .perm-panel__search-clear[hidden] { display: none; }
    /* 第二行：权限检索下拉 —— 无描边软底，与搜索框同一材质 */
    .perm-panel__type-filter {
      width: 100%; height: var(--hira-control-height, 32px);
      border: 0;
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border-radius: var(--hira-radius-md, 10px); padding: 0 12px;
      font-size: 12px; color: var(--hira-text-primary, #1a1a1a); outline: none; cursor: pointer;
      font-family: inherit;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .perm-panel__type-filter:focus-visible { box-shadow: var(--hira-focus-ring); background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); }
    .perm-panel__section-title {
      display: flex; align-items: center; gap: 8px; padding: 12px 10px 4px;
      font-size: 11px; font-weight: 500; color: var(--hira-text-tertiary, #8b8b8b);
      letter-spacing: 0.02em;
    }
    .perm-panel__section-title::after { content: none; }
    /* 待处理申请区：无申请时整块 display:none（见 renderPending 注释） */
    .perm-panel__pending { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
    /* ⚠ flex-wrap: wrap 是**必须**的，不是可选项。
       下面 .perm-panel__actions--choices 是 flex: 1 0 100%（整行独占、不收缩），
       而本行若不允许换行，它就会把带 flex:1; min-width:0 的文本**压成 0 宽** ——
       表现正是「站点与权限名整段空白，只剩右侧按钮」。规则行的 .perm-panel__row-body
       当初写了 wrap，这里漏了（历史 bug，已修）。 */
    .perm-panel__pending-row {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px;
      border-radius: var(--hira-radius-md, 10px);
      border: 0;
      background: var(--hira-warn-bg, rgba(245,158,11,0.12)); contain: layout style;
    }
    /* 申请文案允许换行：它是「站点 + 请求使用『权限名』」两段信息，窄面板（最窄 200px）
       一行放不下，压成单行必然被省略号截断 —— 用户看到的就是"字显示不全"。
       overflow-wrap:anywhere 兜住超长域名（不给它撑破面板的机会）。 */
    .perm-panel__pending-text {
      flex: 1; min-width: 0; font-size: 12px; line-height: 1.45;
      color: var(--hira-text-primary, #1a1a1a);
      white-space: normal; overflow-wrap: anywhere;
    }
    .perm-panel__sensitive {
      margin-left: 4px; font-size: 10.5px; color: var(--hira-warn, #d97706);
      border-radius: var(--hira-radius-xs, 6px); padding: 0 7px;
      background: var(--hira-warn-bg, rgba(245,158,11,0.12));
    }
    /* ⚠ min-height: 0 是滚动的前提（见 downloads 面板同一处注释）：
       缺它时 flex column 的子项按内容高度撑开，溢出被 #root 裁掉、滚轮无效。 */
    .perm-panel__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 0 0 8px; }
    .perm-panel__row {
      display: flex; flex-direction: column; gap: 6px; padding: 10px;
      border: 0;
      border-radius: var(--hira-radius-md, 10px);
      /* 行本身不可点击（动作全在右侧按钮上），显式 cursor 避免继承公共层的 pointer 造成误判 */
      cursor: default; transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease); contain: layout style;
    }
    .perm-panel__row:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.05));
    }
    .perm-panel__row-head { display: flex; align-items: center; gap: 10px; }
    .perm-panel__site { flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* 权限名一行、动作按钮一行。
       wrap + flex-basis:100% 是**恒换行**（不是"挤不下才换"）：三个按钮（允许 / 阻止 /
       清除）挤在权限名右侧时，权限名会被省略号截断、按钮也挨在一起容易点错；
       换到底部整行后权限名能完整显示，窄到 200px 也不局促。
       恒换行而非按需换行 —— 否则面板一拉宽又变回挤着的样子，用户看到的就是"没改"。 */
    .perm-panel__row-body { display: flex; align-items: center; gap: 8px 8px; flex-wrap: wrap; }
    .perm-panel__type { flex: 1; min-width: 0; font-size: 12px; color: var(--hira-text-secondary, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .perm-panel__actions { display: flex; gap: 6px; flex-shrink: 0; flex-basis: 100%; justify-content: flex-end; }
    .perm-panel__btn {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      border-radius: var(--hira-radius-sm, 8px); height: var(--hira-control-height, 32px); padding: 0 10px;
      font-size: 11px; font-weight: 500; cursor: pointer; white-space: nowrap;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .perm-panel__btn:hover { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .perm-panel__btn.is-active { color: var(--hira-accent, #3b82f6); background: var(--hira-accent-soft, rgba(59,130,246,0.14)); }
    /* ── 待处理申请的四档决定（允许一次 / 始终允许 / 阻止一次 / 始终阻止）──
       语义与文案来自共享的 PERMISSION_CHOICES（与权限浮层逐字一致），此处只负责配色：
       「一次」是浅底（轻决定），「始终」是同一软底加深一档（会写库、影响以后，
       所以更重），但**都不做成实心高饱和**——Web3 桌面端的强调靠色阶不靠色块，
       实心按钮在软面面板里会像贴上去的补丁。 */
    .perm-panel__actions--choices {
      display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
    }
    /* 四档决定：语义色全部走令牌（--hira-success / --hira-danger 的深浅两档由主题给值），
       本文件不再写 [data-theme='dark'] 覆盖 —— 一套规则管两种模式。 */
    .perm-panel__btn--allow-once { color: var(--hira-success, #15803d); background: var(--hira-success-bg, rgba(22,163,74,0.10)); }
    .perm-panel__btn--allow-always { color: var(--hira-success, #15803d); background: color-mix(in srgb, var(--hira-success, #16a34a) 18%, transparent); }
    .perm-panel__btn--deny-once { color: var(--hira-danger, #b91c1c); background: var(--hira-danger-bg, rgba(220,38,38,0.10)); }
    .perm-panel__btn--deny-always { color: var(--hira-danger, #b91c1c); background: color-mix(in srgb, var(--hira-danger, #dc2626) 18%, transparent); }
    /* 加深档的悬停同样要显式声明（理由同上：别被通用 hover 底灰盖掉） */
    .perm-panel__btn--allow-always:hover { color: var(--hira-success, #15803d); background: color-mix(in srgb, var(--hira-success, #16a34a) 26%, transparent); }
    .perm-panel__btn--deny-always:hover { color: var(--hira-danger, #b91c1c); background: color-mix(in srgb, var(--hira-danger, #dc2626) 26%, transparent); }
    /* 状态三态药丸：无描边，靠软底区分 */
    .perm-panel__state { flex-shrink: 0; font-size: 10.5px; line-height: 17px; padding: 0 8px; border-radius: var(--hira-radius-xs, 6px); border: 0; }
    .perm-panel__state--allow { color: var(--hira-success, #15803d); background: var(--hira-success-bg, rgba(22,163,74,0.12)); }
    .perm-panel__state--block { color: var(--hira-danger, #b91c1c); background: var(--hira-danger-bg, rgba(220,38,38,0.12)); }
    .perm-panel__state--ask { color: var(--hira-text-tertiary, #8b8b8b); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    /* ── 当前站点聚合卡 ──
       面板既有职责是「查 / 改全部站点规则」；从地址栏锁图标点进来时，用户想办的却是
       **这一站**的事。新开一块面板会与权限面板抢同一个入口，所以做成同一块面板顶部的
       一张卡：站内规则 + 「全部规则」，下方仍是完整规则表 —— 两个视角共用一份数据源，
       不会出现"两处各记一套"的漂移。
       视觉上是**软面**而不是描边卡：Web3 桌面端的分层靠色阶，不靠线。 */
    .perm-panel__site-card {
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
      padding: 10px 12px; border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.035));
      border: 0;
      contain: layout style;
    }
    .perm-panel__site-card-head { display: flex; align-items: center; gap: 10px; }
    .perm-panel__site-card-host {
      flex: 1; min-width: 0; font-size: 13px; font-weight: 500;
      color: var(--hira-text-primary, #1a1a1a);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .perm-panel__site-card-badge {
      flex-shrink: 0; font-size: 10.5px; line-height: 17px; font-weight: 500; padding: 0 8px;
      border-radius: var(--hira-radius-xs, 6px); color: var(--hira-success, #15803d); background: var(--hira-success-bg, rgba(22,163,74,0.12));
      border: 0;
    }
    .perm-panel__site-card-badge.is-insecure {
      color: var(--hira-warn, #b45309); background: var(--hira-warn-bg, rgba(245,158,11,0.14));
    }
    .perm-panel__site-card-meta { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); }
    /* 站内规则最多占一小段高度：卡在面板顶部是**固定区**（flex-shrink:0），
       不封顶的话规则一多就会把下方搜索与总表挤没。 */
    .perm-panel__site-card-rules { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
    /* 卡内规则行：卡的四周留白已经给足，行内不再叠加左右内距，
       否则「卡内距 14 + 行内距 10」会把文字推到离卡边 24px，反而更挤。 */
    .perm-panel__site-card-rules .perm-panel__row { padding: 8px 0; }
    .perm-panel__site-card-hint { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); padding: 4px 0; }
    /* 卡内行不重复站点名（卡头已经写了）：权限名与状态药丸同排，动作照旧整行靠右 */
    .perm-panel__row--no-site .perm-panel__state { margin-left: 2px; }
    .perm-panel__site-card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .perm-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
    }
  `
  doc.head.appendChild(style)
}

/**
 * 站点搜索的匹配键：把用户输入的域名 / URL 归一成裸域（去协议、端口、路径、www.）。
 * 只用于本地过滤，不写回任何数据 —— 真正的归一落库由 domain-permission 的
 * normalizeDomain 负责，这里刻意不重复实现那套校验，免得两处判定漂移。
 * @param {string} text
 * @returns {string}
 */
function siteQueryKey(text: unknown): string {
  let value = typeof text === 'string' ? text.trim().toLowerCase() : ''
  if (!value) return ''
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split(/[/:?#]/)[0]
  return value.replace(/^www\./, '')
}

/**
 * @param {Document} doc
 * @param {PermissionsPanelContext} [ctx]
 * @returns {{
 *   element: HTMLDivElement,
 *   setRules: (items: readonly PermissionRuleInput[]) => void,
 *   setPending: (items: readonly PendingRequestInput[]) => void,
 *   setSite: (site: SiteInfo|null|undefined) => void,
 *   setSiteStats: (stats?: {cookies?: number|null}) => void
 * }}
 */
export function createPermissionsPanel(doc: Document, ctx: PanelContext = {}) : {
  element: HTMLDivElement,
  setRules: (items: readonly PermissionRuleInput[]) => void,
  setPending: (items: readonly PendingRequestInput[]) => void,
  setSite: (site: SiteInfo|null|undefined) => void,
  setSiteStats: (stats?: {cookies?: number|null}) => void
} {
  const panelCtx = ctx as PermissionsPanelContext
  const onIntent = typeof panelCtx.onIntent === 'function' ? panelCtx.onIntent : () => {}
  const wrap = doc.createElement('div')
  wrap.className = 'perm-panel__wrap'

  // ── 当前站点聚合卡（在查询工具之前）──
  // 从地址栏锁图标点进来时，第一眼就该看到"我这一站现在是什么状态、能在这里做什么"；
  // 全局规则表在下方，两者共用同一份 rules 状态，不存在第二套数据。
  const siteCard = doc.createElement('div')
  siteCard.className = 'perm-panel__site-card'
  siteCard.hidden = true

  const siteHead = doc.createElement('div')
  siteHead.className = 'perm-panel__site-card-head'
  const siteHost = doc.createElement('span')
  siteHost.className = 'perm-panel__site-card-host'
  const siteBadge = doc.createElement('span')
  siteBadge.className = 'perm-panel__site-card-badge'
  siteHead.append(siteHost, siteBadge)

  const siteMeta = doc.createElement('div')
  siteMeta.className = 'perm-panel__site-card-meta'

  const siteRuleList = doc.createElement('div')
  siteRuleList.className = 'perm-panel__site-card-rules'

  const siteActionBar = doc.createElement('div')
  siteActionBar.className = 'perm-panel__site-card-actions'
  for (const [action, label, hint] of SITE_ACTIONS) {
    const btn = doc.createElement('button')
    btn.className = 'perm-panel__btn'
    btn.textContent = label
    btn.title = hint
    btn.setAttribute('data-site-action', action)
    siteActionBar.appendChild(btn)
  }

  siteCard.append(siteHead, siteMeta, siteRuleList, siteActionBar)
  wrap.appendChild(siteCard)

  // ── 查询工具（两行）：第一行站点搜索，第二行权限检索 ──
  // 原先这里是「新增站点授权」表单（填站点 + 选类型 + 选动作 + 添加），已按规格移除：
  // 站点的权限只应由网页自己发起请求、用户当场决定（navbar / 权限浮层），
  // 面板只负责查阅与更正已有规则。
  const toolbar = doc.createElement('div')
  toolbar.className = 'perm-panel__toolbar'

  const searchBox = doc.createElement('div')
  searchBox.className = 'perm-panel__search'
  const searchIcon = doc.createElement('span')
  const searchIconNode = iconByName('Search', doc, { size: 15 })
  if (searchIconNode) searchIcon.appendChild(searchIconNode)
  searchIcon.style.cssText = 'display:flex; align-items:center; color: var(--hira-text-secondary,#6b7280); flex-shrink:0;'
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索站点，如 example.com'
  searchInput.autocomplete = 'off'
  searchInput.spellcheck = false
  const searchClear = doc.createElement('button')
  searchClear.type = 'button'
  searchClear.className = 'perm-panel__search-clear'
  searchClear.textContent = '×'
  searchClear.title = '清空搜索'
  searchClear.setAttribute('aria-label', '清空搜索')
  searchClear.hidden = true
  searchBox.append(searchIcon, searchInput, searchClear)

  const typeFilterEl = doc.createElement('select')
  typeFilterEl.className = 'perm-panel__type-filter'
  typeFilterEl.setAttribute('aria-label', '按权限筛选')
  const allOption = doc.createElement('option')
  allOption.value = FILTER_ALL
  allOption.textContent = '全部权限'
  typeFilterEl.appendChild(allOption)
  // 选项只列中文名（同一语义的历史别名只出现一次，见 permissionFilterOptions）
  for (const label of permissionFilterOptions()) {
    const option = doc.createElement('option')
    option.value = label
    option.textContent = label
    typeFilterEl.appendChild(option)
  }
  toolbar.append(searchBox, typeFilterEl)
  wrap.appendChild(toolbar)

  // ── 待处理申请区 ──
  const pendingSection = doc.createElement('div')
  pendingSection.className = 'perm-panel__pending'
  const pendingTitle = doc.createElement('div')
  pendingTitle.className = 'perm-panel__section-title'
  pendingTitle.textContent = '待处理申请'
  const pendingList = doc.createElement('div')
  pendingList.className = 'perm-panel__pending-list'
  pendingSection.append(pendingTitle, pendingList)
  wrap.appendChild(pendingSection)

  // ── 规则列表 ──
  const list = doc.createElement('div')
  list.className = 'perm-panel__list'
  wrap.appendChild(list)

  let rules: PermissionRuleView[] = []
  let pending: PendingRequestView[] = []
  let currentSite: SiteInfo | null = null
  /** 该站点的 Cookie 数；null = 还没取到（显示时省略，不用 0 冒充"没有"）。 */
  let siteCookies: number | null = null
  let siteQuery = ''
  let typeFilter = FILTER_ALL

  /**
   * 灌 / 清搜索词：输入框、本地筛选、清空按钮三者**只走这一个入口** ——
   * 各改一处迟早漂移（比如「全部规则」灌了词、叉却还藏着）。
   */
  function setSiteQuery(value: string) {
    siteQuery = value
    searchInput.value = value
    syncSearchClear()
    renderRules()
  }

  /** 有输入才显示「×」：空框上挂个叉只是噪音。 */
  function syncSearchClear() {
    searchClear.hidden = !searchInput.value
  }

  searchInput.addEventListener('input', () => {
    siteQuery = searchInput.value
    syncSearchClear()
    renderRules()
  })
  searchClear.addEventListener('click', () => {
    setSiteQuery('')
    // 清空是为了接着搜下一站：焦点还回去，少一次点击
    searchInput.focus()
  })
  typeFilterEl.addEventListener('change', () => {
    typeFilter = typeFilterEl.value || FILTER_ALL
    renderRules()
  })

  // ── 事件委托：规则行三态 / 清除、申请行四档决定 ──
  wrap.addEventListener('click', (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const btn = target?.closest<HTMLButtonElement>('button')
    if (!btn) return
    // 站点卡动作优先：卡内规则行也带 data-origin/data-type，但它们没有 data-site-action，
    // 两类按钮不会互相命中（判据不同）。
    const siteAction = btn.getAttribute('data-site-action')
    if (siteAction) {
      if (!currentSite) return
      if (siteAction === 'view-all') {
        // 纯本地：把当前站点灌进搜索框，下方总表立即只看这一站 —— 不新开视图，
        // 也不走 IPC（搜索本来就是本地面板过滤）。
        setSiteQuery(currentSite.domain)
        list.scrollTop = 0
      }
      return
    }
    // 待处理行优先判定：它的 data-pending-id 与规则行的 data-origin 不会同时出现
    const pendingRow = btn.closest('[data-pending-id]')
    if (pendingRow) {
      respondToRequest(
        pendingRow.getAttribute('data-pending-id') || '',
        btn.getAttribute('data-allow') === '1',
        btn.getAttribute('data-persist') === '1'
      )
      return
    }
    const ruleRow = btn.closest('[data-origin][data-type]')
    if (!ruleRow) return
    const origin = ruleRow.getAttribute('data-origin') || ''
    const permissionType = ruleRow.getAttribute('data-type') || ''
    const action = btn.getAttribute('data-action')
    if (action === 'allow' || action === 'block') applySetting(origin, permissionType, action)
    else if (action === 'clear') clearRule(origin, permissionType)
  })

  function renderEmpty(hostEl: HTMLElement, message: string) {
    hostEl.textContent = ''
    const empty = doc.createElement('div')
    empty.className = 'perm-panel__empty'
    empty.textContent = message
    hostEl.appendChild(empty)
  }

  /**
   * 一条规则是否命中当前的本地筛选。
   * 权限侧按**中文名**比对：历史别名与规范名同名即命中，一个语义也不会漏。
   */
  function matches(rule: PermissionRuleView) {
    const query = siteQueryKey(siteQuery)
    if (query && !rule.domain.toLowerCase().includes(query)) return false
    if (typeFilter !== FILTER_ALL && permissionLabel(rule.permissionType) !== typeFilter) return false
    return true
  }

  /**
   * 一行 = 站点 + 权限中文名 + 当前状态 + 三个操作。
   * 权限名只走 permissionLabel：未识别类型由它兜底成「其它权限（…）」，
   * 代码名（如 clipboard-sanitized-write）绝不作为主标签出现。
   *
   * @param {PermissionRuleView} rule
   * @param {{ hideSite?: boolean }} [options] hideSite：站点卡内使用 —— 站点名已在卡头，
   *   行里再写一遍既占宽度又显得重复；此时状态药丸并入权限名那一行。
   */
  function buildRuleRow(rule: PermissionRuleView, options: { hideSite?: boolean } = {}) {
    const hideSite = options.hideSite === true
    const row = doc.createElement('div')
    row.className = `perm-panel__row${hideSite ? ' perm-panel__row--no-site' : ''}`
    row.setAttribute('data-origin', rule.domain)
    row.setAttribute('data-type', rule.permissionType)

    const state = doc.createElement('span')
    state.className = `perm-panel__state perm-panel__state--${rule.setting}`
    state.textContent = PERMISSION_SETTING_LABELS[rule.setting]

    if (!hideSite) {
      const head = doc.createElement('div')
      head.className = 'perm-panel__row-head'
      const site = doc.createElement('span')
      site.className = 'perm-panel__site'
      site.textContent = rule.domain
      site.title = rule.domain
      head.append(site, state)
      row.appendChild(head)
    }

    const body = doc.createElement('div')
    body.className = 'perm-panel__row-body'
    const type = doc.createElement('span')
    type.className = 'perm-panel__type'
    type.textContent = permissionLabel(rule.permissionType)
    body.appendChild(type)
    if (hideSite) body.appendChild(state)

    const actions = doc.createElement('div')
    actions.className = 'perm-panel__actions'
    for (const [setting, label] of PERMISSION_SETTING_ACTIONS) {
      const btn = doc.createElement('button')
      // 当前生效的那个动作常亮，一眼能看出这行现在是什么状态
      btn.className = `perm-panel__btn${rule.setting === setting ? ' is-active' : ''}`
      btn.textContent = label
      btn.title = `设为${label}`
      btn.setAttribute('data-action', setting)
      actions.appendChild(btn)
    }
    const clear = doc.createElement('button')
    clear.className = 'perm-panel__btn'
    const clearIcon = iconByName('Eraser', doc, { size: 13 })
    if (clearIcon) clear.appendChild(clearIcon)
    clear.appendChild(doc.createTextNode('清除'))
    clear.title = '清除该规则（回到「询问」）'
    clear.setAttribute('data-action', 'clear')
    actions.appendChild(clear)

    body.appendChild(actions)
    row.appendChild(body)
    return row
  }

  function renderRules() {
    const visible = rules.filter(matches)
    if (visible.length === 0) {
      // 空态按「为什么空」给不同的中文提示，用户看完就知道下一步该怎么调
      let message = '还没有任何已保存的站点权限'
      if (typeFilter !== FILTER_ALL) message = '没有符合筛选条件的权限记录'
      else if (siteQueryKey(siteQuery)) message = '该站点没有已保存的权限'
      renderEmpty(list, message)
      return
    }
    const frag = doc.createDocumentFragment()
    for (const rule of visible) frag.appendChild(buildRuleRow(rule))
    list.textContent = ''
    list.appendChild(frag)
  }

  /**
   * 站点卡：一切从 `currentSite + rules + siteCookies` **派生**，不另存一份站内规则 ——
   * 否则改完规则要在两处各自更新，迟早漏一处（正是用户在总表点「允许」、卡里却还是旧值）。
   */
  function renderSite() {
    if (!currentSite) {
      siteCard.hidden = true
      siteRuleList.textContent = ''
      return
    }
    siteCard.hidden = false
    siteHost.textContent = currentSite.domain
    siteHost.title = currentSite.url || currentSite.origin || currentSite.domain
    siteBadge.textContent = currentSite.secure ? 'HTTPS' : 'HTTP'
    siteBadge.classList.toggle('is-insecure', !currentSite.secure)

    const siteDomain = currentSite.domain
    const siteRules = rules.filter((rule) => isSameSite(rule.domain, siteDomain))
    const meta: string[] = []
    if (siteCookies !== null) meta.push(`${siteCookies} 个 Cookie`)
    meta.push(siteRules.length ? `${siteRules.length} 项权限设置` : '无权限设置')
    siteMeta.textContent = meta.join(' · ')

    siteRuleList.textContent = ''
    if (siteRules.length === 0) {
      const hint = doc.createElement('div')
      hint.className = 'perm-panel__site-card-hint'
      hint.textContent = '本站还没有已保存的权限设置'
      siteRuleList.appendChild(hint)
    } else {
      const frag = doc.createDocumentFragment()
      for (const rule of siteRules) frag.appendChild(buildRuleRow(rule, { hideSite: true }))
      siteRuleList.appendChild(frag)
    }
  }

  /** 申请行 = 站点 + 权限中文名 + 四档决定（与权限浮层同一份规格）。 */
  function buildPendingRow(request: PendingRequestView) {
    const row = doc.createElement('div')
    row.className = 'perm-panel__pending-row'
    row.setAttribute('data-pending-id', request.id)

    const text = doc.createElement('span')
    text.className = 'perm-panel__pending-text'
    // 可见文本只给 hostname（与浮层同一份可读化判据，绝不裸露协议 / 端口）；
    // 完整 origin 放进 title —— 窄面板里这行常被省略号截断，悬停还能核对是哪个站点。
    text.textContent = `${hostOfOrigin(request.origin)} 请求使用「${permissionLabel(request.type)}」`
    text.title = `${request.origin || hostOfOrigin(request.origin)} 请求使用「${permissionLabel(request.type)}」`
    // 敏感标记来自主进程 pendingWithFlags（与权限浮层同一判据），渲染层不自创
    if (request.sensitive) {
      const tag = doc.createElement('span')
      tag.className = 'perm-panel__sensitive'
      tag.textContent = '敏感'
      text.appendChild(tag)
    }
    row.appendChild(text)

    // 四档决定：文案 / allow / persist 全部来自共享的 PERMISSION_CHOICES，
    // 本面板只把 key 映射成自己的样式类 —— 三处界面因此不会各写一套说法。
    const actions = doc.createElement('div')
    actions.className = 'perm-panel__actions perm-panel__actions--choices'
    for (const choice of PERMISSION_CHOICES) {
      const btn = doc.createElement('button')
      btn.className = `perm-panel__btn perm-panel__btn--${choice.key}`
      btn.textContent = choice.label
      btn.title = choice.hint
      btn.setAttribute('data-allow', choice.allow ? '1' : '0')
      // persist 用属性带下去：语义是「这次决定要不要记住」，一次与始终靠它区分
      btn.setAttribute('data-persist', choice.persist ? '1' : '0')
      actions.appendChild(btn)
    }
    row.appendChild(actions)
    return row
  }

  function renderPending() {
    // 无申请时整块隐藏：窄面板（200~600px）里常驻一块空区块会挤掉规则表，
    // 而申请是事件驱动 —— 有申请才有内容要看，来了这块立刻出现。
    if (pending.length === 0) {
      pendingSection.style.display = 'none'
      pendingList.textContent = ''
      return
    }
    pendingSection.style.display = ''
    const frag = doc.createDocumentFragment()
    for (const request of pending) frag.appendChild(buildPendingRow(request))
    pendingList.textContent = ''
    pendingList.appendChild(frag)
  }

  /**
   * 行内改设置：先落本地状态并重绘（点一下立刻变色，不等 IPC 往返 —— 跟手优先），
   * 编排层随后 refresh 会用主进程真值覆盖回来，失败也能自愈。
   */
  function applySetting(origin: string, permissionType: string, setting: PermissionSetting) {
    const rule = rules.find((candidate) => candidate.domain === origin && candidate.permissionType === permissionType)
    if (rule) {
      rule.setting = setting
      renderRules()
      renderSite()
    }
    onIntent({ type: 'set', origin, permissionType, setting })
  }

  /**
   * 清除一条规则（回到「询问」）。
   * 契约上这一行对应单类型删除 permission:remove；整站清空是另一个通道
   * （permission:clear-site / permission:reset-site），本面板不提供整站清空入口。
   */
  function clearRule(origin: string, permissionType: string) {
    rules = rules.filter((rule) => !(rule.domain === origin && rule.permissionType === permissionType))
    renderRules()
    renderSite()
    onIntent({ type: 'remove', origin, permissionType })
  }

  /**
   * 就地响应申请：本地先移除（即时消失），再上报意图；编排层处理完会重拉
   * 主进程的 pending 列表覆盖回来 —— 这条请求可能已被别处（navbar / 浮层）响应掉。
   * @param {string} id
   * @param {boolean} allow
   * @param {boolean} persist true = 写库（始终），false = 仅本次（一次）
   */
  function respondToRequest(id: string, allow: boolean, persist: boolean) {
    if (!id) return
    pending = pending.filter((request) => request.id !== id)
    renderPending()
    onIntent({ type: 'respond', id, allow, persist })
  }

  /**
   * 状态上行：permission:list-all 的行 → 本地规则表。
   * 字段按契约取（domain / permissionType / setting）；脏 setting 归一成「询问」，
   * 与内部页 pages/permissions 同一口径（不让原始值漏到界面）。
   * @param {readonly PermissionRuleInput[]} items
   */
  function setRules(items: readonly PermissionRuleInput[]) {
    rules = (Array.isArray(items) ? items : [])
      .map((row) => ({
        domain: String(row.domain || row.origin || ''),
        permissionType: String(row.permissionType || row.type || ''),
        setting: isValidPermissionSetting(row.setting) ? row.setting as PermissionSetting : 'ask'
      }))
      .filter((rule) => rule.domain && rule.permissionType)
      .sort((a, b) => a.domain.localeCompare(b.domain) ||
        permissionLabel(a.permissionType).localeCompare(permissionLabel(b.permissionType), 'zh'))
    renderRules()
    renderSite()
  }

  /**
   * 状态上行：当前活动标签的站点信息（null = 不是普通网页，整卡隐藏）。
   * 同一站点重复上报时保留 Cookie 计数 —— 否则每次标签变化 / 刷新都会把数字闪成空。
   * @param {SiteInfo|null|undefined} site
   */
  function setSite(site: SiteInfo | null | undefined) {
    const next: SiteInfo | null = site && site.domain ? site : null
    const same = !!currentSite && !!next && isSameSite(currentSite.domain, next.domain)
    currentSite = next
    if (!same) siteCookies = null
    renderSite()
  }

  /**
   * 状态上行：站点统计（目前只有 Cookie 数）。null / 非法值 = 未知，界面省略该段。
   * @param {{cookies?: number|null}} [stats]
   */
  function setSiteStats(stats: { cookies?: number | null } = {}) {
    const count = typeof stats.cookies === 'number' ? stats.cookies : NaN
    siteCookies = Number.isFinite(count) && count >= 0 ? count : null
    renderSite()
  }

  /**
   * 状态上行：permission:pending-list 的请求 → 待处理申请区。
   * @param {readonly PendingRequestInput[]} items
   */
  function setPending(items: readonly PendingRequestInput[]) {
    pending = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        origin: String(item.origin || ''),
        type: String(item.type || ''),
        sensitive: item.sensitive === true
      }))
    renderPending()
  }

  return { element: wrap, setRules, setPending, setSite, setSiteStats }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'permissions-panel',
  injectStyles: injectPermissionsPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as PermissionsPanelContext
    const { bridge, events, on, clients } = panelCtx
    const tabs = clients?.tabs
    if (!bridge) throw new Error('permissions panel requires a renderer bridge')
    const rendererBridge = bridge

    /** 当前活动标签解析出的站点（null = 不是普通网页 / 还没拿到）。 */
    let currentSite: SiteInfo | null = null

    const panel = createPermissionsPanel(doc, {
      // 只转发意图，永不自己订阅/调 IPC 之外的事 —— 哑组件的下行事件
      onIntent({ type, origin, permissionType, setting, id, allow, persist }) {
        if (type === 'set' && origin && permissionType && setting) {
          rendererBridge.provider.invoke('permission:set', { origin, permissionType, setting })
            .catch(() => {}).then(refreshRules)
        } else if (type === 'remove' && origin && permissionType) {
          rendererBridge.provider.invoke('permission:remove', { origin, permissionType })
            .catch(() => {}).then(refreshRules)
        } else if (type === 'respond' && id) {
          // persist 由用户点的那一档决定（= 浮层的「允许一次 / 始终允许 / 阻止一次 / 始终阻止」）：
          // true 写库、之后不再询问；false 只在本次会话内生效。**不再统一写死 true** ——
          // 那等于替用户默认选了"始终"，是一个他没做过的决定。
          rendererBridge.provider.invoke('permission:respond', { id, allow: allow === true, persist: persist === true })
            .catch(() => {}).then(refreshPending)
        }
      }
    })

    async function refreshRules() {
      const rows = await rendererBridge.provider.invoke('permission:list-all', {}).catch(() => [])
      panel.setRules(Array.isArray(rows) ? rows as PermissionRuleInput[] : [])
    }
    async function refreshPending() {
      const list = await rendererBridge.provider.invoke('permission:pending-list', {}).catch(() => [])
      panel.setPending(Array.isArray(list) ? list as PendingRequestInput[] : [])
    }

    /**
     * 只刷新站点卡里的统计（Cookie 数）—— 权限规则由 refreshRules 管，
     * 两者数据源不同，别在一次操作后把所有东西都重拉一遍。
     */
    async function refreshSiteStats() {
      if (!currentSite) {
        panel.setSiteStats({})
        return
      }
      const site = currentSite
      const result = await rendererBridge.provider.invoke('cookie:list', { domain: site.hostname }).catch(() => null)
      // 等待期间活动标签可能已经换站：旧请求的结果不许盖到新站头上
      if (!currentSite || currentSite.domain !== site.domain) return
      const resultRecord = result && typeof result === 'object' ? result as { cookies?: unknown } : null
      const count = resultRecord && Array.isArray(resultRecord.cookies) ? resultRecord.cookies.length : null
      panel.setSiteStats({ cookies: count })
    }

    /**
     * 活动标签 → 站点卡。同站重复上报只更新卡头（setSite 自己会保留计数），
     * 跨站才重新数 Cookie —— 标签事件（加载进度 / 标题变化）频率很高，不能每次都打 IPC。
     */
    async function syncSite() {
      if (!tabs || typeof tabs.projection !== 'function') return
      const list = await tabs.projection().catch(() => [])
      const active = Array.isArray(list) ? list.find((item) => item && item.active) : null
      const site = active ? siteInfoOfUrl(active.url) : null
      const changed = (site && site.domain ? site.domain : '') !==
        (currentSite && currentSite.domain ? currentSite.domain : '')
      currentSite = site
      panel.setSite(site)
      if (changed) refreshSiteStats()
    }

    /** 标签事件的**节流**（首事件起 150ms 内只跑一次）：切标签立刻响应，加载进度不放大成 IPC 风暴。 */
    let syncTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleSyncSite() {
      if (syncTimer !== null) return
      syncTimer = setTimeout(() => {
        syncTimer = null
        syncSite()
      }, 150)
    }

    refreshRules()
    refreshPending()
    syncSite()
    if (tabs && typeof tabs.onChanged === 'function') tabs.onChanged(scheduleSyncSite)

    // 网页新发起申请 → 待处理区立刻出现；申请在别处（navbar / 权限浮层）被处理完 →
    // 待处理区移除，且若选了「记住」会新增/更新一条规则，顺手把规则表同步过来。
    if (typeof on === 'function' && events?.permissionRequest && events.permissionCleared) {
      on(events.permissionRequest, () => { refreshPending() })
      on(events.permissionCleared, () => { refreshRules(); refreshPending() })
    }

    // refresh：宿主在 profile 切换后统一调（见 panels/main.js）—— 本面板最清楚要重取什么
    return { element: panel.element, refresh: () => { refreshRules(); refreshPending(); syncSite() } }
  }
}
