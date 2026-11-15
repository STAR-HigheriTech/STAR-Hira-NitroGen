/**
 * 速览（Glance，A1）的**渲染侧动作表** —— apps 层唯一一处。
 *
 * 与 `tab-split-actions.js` 完全同款定位：ui-common 只认识"菜单里有哪些项、
 * 点了返回什么动作"，而"这个动作具体调哪个客户端方法"是 apps 层的知识。
 * 横竖两个列表宿主共用同一批接线，抄两遍必然漂移。
 *
 * 速览与分屏、标签栈三者**正交**（栈收纳 / 分屏并列 / 速览叠放），
 * 所以这里不 import 任何栈/分屏相关的动作表，各自独立。
 */

/**
 * 「速览」可用的**动作集合**（两个列表宿主共用一份接线）。
 * @param {{ glanceWithActive: Function, setGlanceFront: Function, dissolveGlance: Function }} tabsClient
 */
export function createGlanceMenuHandlers(tabsClient: { glanceWithActive: (tabId: string) => unknown; setGlanceFront: (glanceId: string, tabId: string) => unknown; dissolveGlance: (glanceId: string) => unknown }) {
  return {
    // 「与当前标签叠放」：只报被点的那个标签，另一个成员由主进程解析
    //（活动标签只有主进程是权威，与分屏 splitWithNext 同款口径）。
    onGlanceWith: (tabId: string) => tabsClient.glanceWithActive(String(tabId)),
    // 「置于速览前台」：把这一条提为前台大卡（交换前后）。
    onGlanceFront: (glanceId: string, tabId: string) => tabsClient.setGlanceFront(String(glanceId), String(tabId)),
    // 「退出速览」：两张标签都保留，只清归属（对齐分屏的"解散"）。
    onDissolveGlance: (glanceId: string) => tabsClient.dissolveGlance(String(glanceId))
  }
}
