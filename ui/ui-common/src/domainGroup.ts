/**
 * domainGroup —— 「按域名分组标签」的**唯一纯规则**（零依赖、零 IO、不碰 DOM、不 require electron）。
 *
 * 为什么单独一个文件：横向标签条（ui-tabbar）与所有纵向标签列表（ui-common#tabListHost）
 * 都要做同一件事 —— 从"当前列表 + 被点的标签"算出**同一站点**的全部标签 id。
 * 两处各写一份，判据必然漂移（一处去 `www.` 一处不去、一处只认 http(s) 一处不认），
 * 用户看到的就是"在标签条里能分一组、在侧栏里分出来不一样"。因此判据只此一份。
 *
 * 为什么放在 ui-common 而不是 apps：ui 层禁止 import apps（分层红线）。标签条与面板
 * 都住在 ui/，放这里两边都能用且不破坏依赖方向（与 tabStackActions 同款理由）。
 */
import { canGroupByDomain } from '@hira-ng/shared-types/src/tab-policy.mjs'
// 「站点键」的唯一判据在 shared-types（注入规则 host 归一、换站清图标也用它）。
// 本文件只负责「按站点分组」这一件事，不再自带一份 URL 解析。
import { siteKeyOf } from '@hira-ng/shared-types/src/url-protocols.mjs'

/**
 * 从**当前列表项**里算出「与被点标签同站点」的全部标签 id。
 *
 * 列表项可以是标签条投影 / 扁平标签数组：栈行（`type:'stack'`）没有 `tabId`/`url`，
 * 天然被过滤掉，不需要调用方先剥。被点的标签自己不在列表里（列表刚变过）时返回 null。
 *
 */
interface DomainGroupItem {
  tabId?: string | number | null
  url?: string
  pinned?: boolean
  [key: string]: unknown
}

export function domainGroupTabIds(
  items: DomainGroupItem[],
  tabId: string
): { domain: string; tabIds: string[] } | null {
  const list = Array.isArray(items) ? items : []
  const id = String(tabId == null ? '' : tabId)
  if (!id) return null
  const self = list.find((it) => it && it.tabId != null && String(it.tabId) === id)
  if (!self) return null
  // 种类裁决（真源 tab-policy）：固定标签不参与「按域名分组」——
  // 它已是固定文件夹成员，再按域名拉组等于把它从固定文件夹里拽出来。
  if (!canGroupByDomain(self)) return null
  const key = siteKeyOf(self.url)
  if (!key) return null
  const ids: string[] = []
  for (const it of list) {
    if (!it || it.tabId == null) continue
    if (siteKeyOf(it.url) !== key) continue
    if (!canGroupByDomain(it)) continue
    ids.push(String(it.tabId))
  }
  if (ids.length < 2) return null
  return { domain: key, tabIds: ids }
}
