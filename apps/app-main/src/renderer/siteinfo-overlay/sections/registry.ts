/**
 * SiteInfo Section Registry —— 站点信息聚合浮层的「信息块」注册表。
 *
 * ── 为什么要有注册表（插件化边界）────────────────────────────────────────
 * 浮层壳（view / model / main）只认识三件事：卡片几何、状态、动作路由。
 * 「站点信息具体有哪些块」是**可插拔的** —— 新增「站点白名单」「隐私统计」
 * 「密码保存状态」时，只加一个 section 文件并 `registerSection()`，不动壳、
 * 不动 navbar、不动主进程。这是本项目「插件化 + 解耦」主旨在本浮层的落点。
 *
 * ── 契约（与文档 7.3 逐字一致）────────────────────────────────────────────
 *   section = { id, order, create(ctx) → { element, update(state), destroy? } }
 *   ctx     = { doc, emit(action, payload), getState() }
 *
 * 硬约束：section **不直接 invoke IPC**，所有动作经 `emit()` 交给 model。
 * 一旦允许 section 自己发 IPC，"同一件事的实现"就会散落到每个文件里，
 * 最终无法统一管理 —— 这条纪律就是防止屎山的那道闸门。
 */

import type { SiteInfoState } from '../model.js'

export interface SiteInfoSectionContext {
  doc: Document
  emit(action: string, payload?: object): void
  getState(): SiteInfoState
}

export interface SiteInfoSectionHandle {
  element: HTMLElement
  update(state: SiteInfoState): void
  destroy?(): void
}

export interface SiteInfoSection {
  id: string
  order?: number
  create(ctx: SiteInfoSectionContext): SiteInfoSectionHandle | null | undefined
}

const sections: SiteInfoSection[] = []

/**
 * 注册一个 section。
 * 同 id 重复注册时**原位替换**（插件热重载 / 测试重置不会留下两份）。
 * @param {{ id: string, order?: number, create: Function }} section
 * @returns {() => void} 取消注册
 */
export function registerSection(section: SiteInfoSection) : () => void {
  if (!section || typeof section.id !== 'string' || !section.id) return () => {}
  if (typeof section.create !== 'function') return () => {}
  const normalized = {
    id: section.id,
    order: Number.isFinite(section.order) ? Number(section.order) : 0,
    create: section.create
  }
  const index = sections.findIndex((item) => item.id === normalized.id)
  if (index >= 0) sections[index] = normalized
  else sections.push(normalized)
  sections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return () => unregisterSection(normalized.id)
}

/** 按 id 取消注册（插件卸载用）。 */
export function unregisterSection(id: string): void {
  const index = sections.findIndex((item) => item.id === id)
  if (index >= 0) sections.splice(index, 1)
}

/** 当前注册的 section（只读快照，调试 / 插件列表用）。 */
export function listSections() {
  return sections.map(({ id, order }) => ({ id, order }))
}

/**
 * 挂载全部 section。
 *
 * 返回的 `host` 是壳与 section 之间的**唯一**通道：
 *   · `fragment` —— 一次性挂进卡片（只创建一次，避免每次数据更新都重建 DOM）；
 *   · `update(state)` —— 把整份状态广播给每个 section，由 section 自己决定画什么；
 *   · `destroy()` —— 释放 section 内部监听（ResizeObserver / timer 等）。
 *
 * 某个 section `create` 抛错时**只跳过它**，绝不让一个坏 section 拖垮整个浮层。
 * @param {{ doc: Document, emit: (action: string, payload?: object) => void, getState: () => unknown }} ctx
 */
export function createSectionHost(ctx: SiteInfoSectionContext) {
  const handles: Array<{ id: string, handle: SiteInfoSectionHandle, sep: HTMLElement|null }> = []
  const fragment = ctx.doc.createDocumentFragment()
  const HTMLElementCtor = ctx.doc.defaultView?.HTMLElement

  for (const section of sections) {
    try {
      const handle = section.create(ctx)
      if (!handle || !HTMLElementCtor || !(handle.element instanceof HTMLElementCtor)) continue

      // 分隔线由注册表统一插入（各浮层共用同一个 `.hira-overlay-sep`），
      // section 不需要知道「自己是不是最后一块」，新增区块也不会漏线或出现双线。
      let sep: HTMLDivElement | null = null
      if (handles.length > 0) {
        sep = ctx.doc.createElement('div')
        sep.className = 'hira-overlay-sep'
        sep.hidden = true
        fragment.appendChild(sep)
      }
      handles.push({ id: section.id, handle, sep })
      fragment.appendChild(handle.element)
    } catch (error) {
      console.error(`[siteinfo] section "${section.id}" create failed`, error)
    }
  }

  /**
   * 只让「前后两块都可见」的那条分隔线露出来。
   * 某些 section 会整块隐藏（无活动页面 / 权限域不可用），
   * 不在这里同步就会留下孤立的分隔线或两条叠在一起的线。
   */
  function syncSeparators() {
    for (let i = 1; i < handles.length; i += 1) {
      const sep = handles[i].sep
      if (!sep) continue
      const prevVisible = !handles[i - 1].handle.element.hidden
      const curVisible = !handles[i].handle.element.hidden
      sep.hidden = !(prevVisible && curVisible)
    }
  }

  return {
    fragment,
    update(state: SiteInfoState) {
      for (const { id, handle } of handles) {
        try {
          handle.update(state)
        } catch (error) {
          console.error(`[siteinfo] section "${id}" update failed`, error)
        }
      }
      syncSeparators()
    },
    destroy() {
      for (const { handle } of handles) {
        try {
          handle.destroy?.()
        } catch (_) {
          // section 的清理失败不应阻断其它 section 释放。
        }
      }
      handles.length = 0
    }
  }
}




