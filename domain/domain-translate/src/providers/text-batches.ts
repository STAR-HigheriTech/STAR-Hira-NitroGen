export interface TranslationTextGroup {
  indices: number[]
  texts: string[]
}

export function makeTranslationGroups(
  texts: readonly string[],
  maxTexts: number,
  maxChars: number
): TranslationTextGroup[] {
  const groups: TranslationTextGroup[] = []
  let current: TranslationTextGroup = { indices: [], texts: [] }
  let chars = 0

  const flush = (): void => {
    if (current.indices.length) groups.push(current)
    current = { indices: [], texts: [] }
    chars = 0
  }

  texts.forEach((text, index) => {
    // 换行是批量协议的边界标记，含换行文本单独请求，避免重新映射时产生歧义。
    if (/[\r\n]/.test(text)) {
      flush()
      groups.push({ indices: [index], texts: [text] })
      return
    }
    if (current.indices.length > 0 && (
      current.indices.length >= maxTexts ||
      chars + text.length > maxChars
    )) {
      flush()
    }
    current.indices.push(index)
    current.texts.push(text)
    chars += text.length
  })
  flush()
  return groups
}
