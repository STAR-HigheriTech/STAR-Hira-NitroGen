/**
 * 剪贴板写入 —— **跨面板共用的一处实现**（验证器面板、扫码器都要复制内容）。
 *
 * 为什么不是"各自写一份"：两级兜底（`navigator.clipboard` → `execCommand`）里
 * 有一堆容易搞错的细节（文档未聚焦时前者会 reject、兜底要建临时节点再删），
 * 复制成两份必然漂移，而漂移的表现是"某个面板的复制偶尔静默失败"——
 * 极难复现、极难定位。
 *
 * 为什么必须两级：`navigator.clipboard` 要求文档处于**聚焦**状态，
 * 侧栏面板被切走 / 窗口失焦时就会失败；此时老的 `execCommand` 在 Electron
 * 渲染进程里仍然可用。复制是这些面板最高频的动作，不该在窗口没聚焦时静默失败。
 *
 * `doc` 由调用方注入（不摸全局）：与 ui 包「一切从端口进来」同一纪律，也让它可测。
 *
 * @param {string} text
 * @param {Document|null} doc
 * @returns {Promise<boolean>} 是否写成功
 */
export async function copyText(text: unknown, doc: Document | null): Promise<boolean> {
  const value = String(text == null ? '' : text)
  if (!value) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (_) { /* 落到下面的兜底 */ }
  if (!doc || typeof doc.createElement !== 'function') return false
  try {
    const ta = doc.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand ? doc.execCommand('copy') : false
    doc.body.removeChild(ta)
    return ok === true
  } catch (_) {
    return false
  }
}

