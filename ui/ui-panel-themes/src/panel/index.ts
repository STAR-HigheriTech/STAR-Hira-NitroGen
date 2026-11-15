// @ts-check
/**
 * panel/index.js —— 侧栏**主题面板**（窄栏形态）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 窄栏只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *   ① 当前主题（色点 + 名字 + 明暗）
 *   ② 色卡网格：**一格一个主题**，点一下即换 —— 一屏能放十几个
 *   ③ 「管理主题…」→ 打开 `hira://themes` 内部页（库 / 编辑器 / 调度 / 私密窗口 都在那边）
 *
 * ── 为什么编辑器不在这里 ──────────────────────────────────────────────
 * 200~600px 宽的栏里放"六格取色器 + 三条滑杆 + 背景设置 + 实时预览"，
 * 结果一定是每样都挤成半成品。判据只有一条：**这件事在窄栏里做得爽吗？**
 * 换主题（点一下色卡）爽 → 留；造主题（改颜色、看预览）不爽 → 归主题页。
 * 这与插件中心"看名单留面板、装/卸归页面"是同一条判据。
 *
 * ── 为什么是「全部主题」而不是「最近使用」 ─────────────────────────────
 * 侧栏是"随手换一下"的地方：列**全部**主题（按 内置 → 我的 → 插件 排序）
 * 才能一眼找到想要的那个；而"最近使用"要额外记一份历史，且主题总量通常
 * 只有个位数到十几个 —— 省下的那点空间换不来"翻了半天找不到"的代价。
 *
 * 意图只发 `emit`，落地在内核（shared/core.js）—— 与宽窗口共用同一段逻辑。
 */

import type { PanelContext, PanelDefinition, PanelIntent } from '../../../ui-common/src/panel-contract'
import { createThemesController } from '@hira-ng/shared-types/src/themes/core.js'
import type { ThemeClientPort } from '@hira-ng/shared-types/src/themes/core.js'
import { injectSharedStyles } from '@hira-ng/shared-types/src/themes/styles.js'
import { injectPanelStyles } from "./styles"
import { el, clear, button } from '@hira-ng/shared-types/src/themes/dom.js'
import { swatchBackground, modeLabel, sourceOf, SOURCE_LABELS, groupThemes } from '@hira-ng/shared-types/src/themes/format.js'
import type { ThemeSummary } from '@hira-ng/shared-types/src/themes/format.js'

type ThemeGroup = ReturnType<typeof groupThemes>[number]

interface ThemeCatalog {
  themes: readonly ThemeSummary[]
  groups?: readonly ThemeGroup[]
  activeId?: string
}

type ThemePanelContext = Omit<PanelContext, 'clients' | 'openPage'> & {
  clients?: (PanelContext['clients'] & { themes?: ThemeClientPort }) | null
  openPage?: (url: string) => unknown
}

/**
 * @param {Document} doc
 * @param {{ emit: (intent: PanelIntent) => void }} ports
 */
export function createPanelView(doc: Document, { emit }: { emit: (intent: PanelIntent) => void }) {
  const wrap = el(doc, 'div', 'thm-panel')
  const body = el(doc, 'div', 'thm-panel__body')

  // ── 当前主题 ───────────────────────────────────────────────────────
  const current = el(doc, 'div', 'thm-panel__current')
  const dot = el(doc, 'span', 'thm-panel__dot')
  const currentMeta = el(doc, 'div', 'thm-panel__current-meta')
  const currentName = el(doc, 'div', 'thm-panel__current-name', '—')
  const currentSub = el(doc, 'div', 'thm-panel__current-sub', '')
  currentMeta.append(currentName, currentSub)
  current.append(dot, currentMeta)

  // ── 色卡网格 ───────────────────────────────────────────────────────
  const label = el(doc, 'div', 'thm-panel__label', '快速切换')
  const swatches = el(doc, 'div', 'thm-panel__swatches')
  body.append(current, label, swatches)

  // ── 页脚：去主题页做重活 ───────────────────────────────────────────
  const foot = el(doc, 'div', 'thm-panel__foot')
  const manage = button(doc, '管理主题…', {
    variant: 'ghost',
    title: '在主题页里管理主题库、编辑器与调度',
    onClick: () => emit({ type: 'open-manager' })
  })
  const status = el(doc, 'div', 'thm-status')
  foot.append(manage, status)

  wrap.append(body, foot)

  /** 主题 id → 色卡节点（`paintActive` 靠它改高亮环，不查选择器、不比对文案）。 */
  const chipById = new Map<string, HTMLButtonElement>()
  /** 表头与高亮环**上一次画出来的**主题 id（`''` = 空态）。 */
  let newestActiveId = ''

  /**
   * 画"当前主题"：表头三件 + 色卡高亮。
   *
   * 表头与高亮是同一个事实的两处呈现，所以**只能由这一个函数写** —— 否则
   * `setCatalog` 画色卡、`setActive` 画表头时，任一处短路都会漏掉另一半。
   * 高亮只改"上一个 → 这一个"两个节点，不整片重画。
   */
  const paintActive = (theme: ThemeSummary | null, id: string) => {
    const prevId = newestActiveId
    newestActiveId = id
    if (!theme) {
      currentName.textContent = '—'
      currentSub.textContent = ''
      dot.style.background = 'transparent'
    } else {
      currentName.textContent = theme.name || theme.id || ''
      currentSub.textContent = `${SOURCE_LABELS[sourceOf(theme)]} · ${modeLabel(theme.mode)}`
      dot.style.background = swatchBackground(theme)
    }
    if (prevId && prevId !== id) {
      const prev = chipById.get(prevId)
      if (prev) prev.dataset.active = '0'
    }
    const next = chipById.get(id)
    if (next) next.dataset.active = '1'
  }

  return {
    element: wrap,

    setCatalog({ themes, groups, activeId }: ThemeCatalog) {
      clear(swatches)
      chipById.clear()
      const list: ThemeSummary[] = []
      // 分组只用来定顺序（内置 → 我的 → 插件），色卡本身平铺成一片网格：
      // 窄栏里再插小标题会把网格切碎，反而不如"顺序即分组"。
      for (const group of groups && groups.length ? groups : groupThemes(themes)) {
        for (const theme of group.themes) list.push(theme)
      }
      if (!list.length) {
        swatches.appendChild(el(doc, 'div', 'thm-empty', '没有可用主题'))
        paintActive(null, '')
        return
      }
      let activeTheme: ThemeSummary | null = null
      const frag = doc.createDocumentFragment()
      for (const theme of list) {
        const chipEl = el(doc, 'button', 'thm-panel__swatch')
        chipEl.type = 'button'
        chipEl.style.background = swatchBackground(theme)
        chipEl.title = `${theme.name || theme.id || ''}（${SOURCE_LABELS[sourceOf(theme)]} · ${modeLabel(theme.mode)}）`
        chipEl.dataset.active = '0'
        chipEl.addEventListener('click', () => emit({ type: 'apply', id: String(theme.id || '') }))
        chipById.set(String(theme.id || ''), chipEl)
        frag.appendChild(chipEl)
        if (theme.id === activeId) activeTheme = theme
      }
      swatches.appendChild(frag)
      /* 目录里能查到当前主题 → 顺手把表头也画了（内核紧跟着的 setActive 直接短路）。
         查不到（例如调度指向一个已不在列表里的临时主题）→ 留空 id，让 setActive 来画。 */
      paintActive(activeTheme, activeTheme ? String(activeTheme.id) : '')
    },

    setActive(theme: ThemeSummary | null | undefined) {
      const id = theme ? String(theme.id || '') : ''
      /* `setCatalog` 已经把同一个事实画全了（表头 + 高亮 + newestActiveId）——
         内核紧跟着的这次 setActive 就是同一件事，直接返回：点一下即换的手感
         不该被一次重复的写入拖慢。 */
      if (id === newestActiveId) return
      paintActive(theme || null, id)
    },

    setStatus(text: string, kind: 'ok' | 'error' = 'ok') {
      status.textContent = text
      status.dataset.kind = kind
    }
  }
}

/** 面板插件定义 —— 宿主（`renderer/panels/main.js`）按约定发现它并挂载。 */
export const panelDefinition: PanelDefinition = {
  id: 'themes-panel',

  injectStyles(doc: Document) {
    injectSharedStyles(doc)
    injectPanelStyles(doc)
  },

  mount(doc: Document, ctx: PanelContext) {
    const panelCtx = ctx as ThemePanelContext
    const { clients } = panelCtx
    let controller: ReturnType<typeof createThemesController> | null = null
    const view = createPanelView(doc, {
      emit: (intent: PanelIntent) => {
        if (intent.type === 'open-manager') {
          // 面板不认识页面路由，只发意图；宿主把它翻成「新标签打开 hira://themes」。
          if (typeof panelCtx.openPage === 'function') panelCtx.openPage('themes')
          return
        }
        if (controller && intent.type === 'apply') controller.applyTheme(String(intent.id || ''))
      }
    })
    controller = createThemesController({
      client: clients?.themes,
      view
    })
    controller.start()
    return {
      element: view.element,
      controller,
      refresh: () => controller?.load({ silent: true })
    }
  }
}
