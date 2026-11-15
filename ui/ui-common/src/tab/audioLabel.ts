/**
 * 标签「静音 / 取消静音」的**唯一文案真源**。
 *
 * 同一句话出现在四个表面：横向标签条的音频按钮（aria-label）、纵向列表行尾按钮
 * （aria-label）、固定标签网格的角标（title + aria-label）、标签右键菜单项。
 * 此前三处各写一份 `muted ? '取消静音' : '静音标签'`，改词只会改到一处 —— 收在这里，
 * 四个表面同时生效。
 *
 */
export function audioToggleLabel(muted: boolean): string {
  return muted ? '取消静音' : '静音标签'
}
