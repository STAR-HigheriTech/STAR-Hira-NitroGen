/**
 * 内部页外壳导航 · 视图模型
 *
 * 所有 `hira://` 管理页共用一条左侧导航（视觉模板 = 设置页的 `.sidebar`）。
 * 这里**不再维护页面清单** —— 身份（host / 中文名 / 分组 / 外壳策略）的唯一真源是
 * `packages/shared-types/src/pages.mjs#PAGES`，本文件只把它投影成侧栏要的形状。
 *
 * 于是「新增一个内部页」永远只有两步：`pages/<host>/` 放页面 + `PAGES` 加一行。
 * 侧栏、⋮ 菜单、设置页清单、命令表全部跟着变，不会再出现某处漏抄。
 *
 * ── 为什么是「逐页注入 + 原生跳转」而不是「容器页 + iframe」──────────
 *   内部页大量依赖 `window.location.href = <真实 URL>` 的主框架导航语义
 *   （history / bookmarks / settings…），塞进 iframe 会污染子框架；
 *   而且 iframe 里拿不到 preload（sandbox + contextIsolation + 非子框架注入），
 *   还得为 `window.hira` 再搭一层 postMessage 中继。
 *   逐页注入的代价只有一次模块求值，换来的是：深链接、前进/后退、中键/Ctrl+点击、
 *   收藏与历史记录全部保持原生行为。
 */

import { PAGES, PAGE_SHELL_OWN, SHELL_NAV_GROUPS, findPage } from '@hira-ng/shared-types/src/pages.mjs'

/** 外壳策略：注入公共导航 / 页面自带导航。 */
export const SHELL_SHARED = 'shared'
export const SHELL_OWN = PAGE_SHELL_OWN

/**
 * 「为侧栏让位」的开关标记（打在 `<html>` 上，CSS 见 `_shared/base.css` 末尾）。
 *
 * 名字只在这里写一次：构建期（`electron.vite.config.js#markShellPlaceholder` 把标记
 * 写进 `index.html`）与运行期（`shell.js#mountShell` 兜底补标记）都读这个常量，
 * 不会出现"两边拼错一个字母，于是某一页永远不让位"这种事故。
 */
export const SHELL_ATTR = 'data-hira-shell'

/**
 * 侧栏分组：顺序与成员都来自 `pages.mjs`，这里只补上每页的外壳策略。
 * @type {ReadonlyArray<Readonly<{ id: string, label: string, pages: ReadonlyArray<Readonly<{ host: string, label: string, shell: string }>> }>>}
 */
export interface ShellPageEntry {
  host: string
  label: string
  shell: string
}

export interface ShellSectionEntry {
  id: string
  label: string
  pages: ReadonlyArray<ShellPageEntry>
}

interface RawShellGroup { id?: unknown; label?: unknown; hosts?: readonly unknown[] }

export const SHELL_SECTIONS: ReadonlyArray<Readonly<ShellSectionEntry>> = Object.freeze(
  (SHELL_NAV_GROUPS as readonly RawShellGroup[]).flatMap((group): ShellSectionEntry[] => {
    const id = String(group.id || '')
    if (!id) return []
    const pages = (group.hosts || []).map((rawHost) => {
      const host = String(rawHost || '')
      if (!host) return null
      const page = findPage(host)
      return Object.freeze({ host, label: page ? page.label : host, shell: page ? page.shell : SHELL_SHARED })
    }).filter((page): page is Readonly<ShellPageEntry> => page !== null)
    return [Object.freeze({ id, label: String(group.label || ''), pages: Object.freeze(pages) })]
  })
)

/** host → 注册项（含它所在的分组）。扁平索引，查一次 O(1)。 */
const BY_HOST = new Map<string, ShellPageEntry & { sectionId: string }>(
  SHELL_SECTIONS.flatMap((section) =>
    section.pages.map((page) => [page.host, { ...page, sectionId: section.id }] as const)
  )
)

/**
 * 当前 host 是否登记过。
 * @param {string} host
 * @returns {{ host: string, label: string, shell: string, sectionId: string } | null}
 */
export function findShellPage (host?: string): ShellPageEntry & { sectionId: string } | null {
  const key = String(host == null ? '' : host).toLowerCase()
  return BY_HOST.get(key) || null
}

/**
 * 当前 host 是否要注入公共外壳（= 需要为左侧导航让位）。
 *
 * 这条判定是**构建期与运行期共用**的：构建期用它决定要不要把 `SHELL_ATTR` 写进
 * `index.html` 的 `<html>`（首帧就让位，见 `electron.vite.config.js#markShellPlaceholder`），
 * 运行期用它决定要不要建导航（`shell.js#mountShell`）。两边读同一个函数。
 *
 * @param {string} host
 * @returns {boolean}
 */
export function usesSharedShell (host?: string): boolean {
  const entry = findShellPage(host)
  return !!entry && entry.shell !== SHELL_OWN
}

/** 登记过的全部 host（便于诊断 / 未来的「页面搜索」）。 */
export const SHELL_HOSTS = Object.freeze(Array.from(BY_HOST.keys()))

/** 全部内部页身份（含不上侧栏的功能窗口），供页面级查表使用。 */
export { PAGES }
