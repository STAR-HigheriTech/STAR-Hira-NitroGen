/**
 * FTS 查询构造 —— 纯函数，零 IO、零依赖。
 *
 * 书签（`bookmarks_fts`）与页面正文（`page_texts_fts`）共用同一套检索语义：
 *   · 按空白切词（query 里的多词 = AND）
 *   · 每个词加引号转义 + 前缀通配 `*`（"打一半也能命中"）
 *
 * 这段逻辑原本在 domain-bookmark / domain-history 各抄一份 —— 两处一旦对
 * 转义或前缀策略做出不同决定，同一次输入在两个域就会给出不同结果。
 * 抽到这里后，检索口径只有一份事实源；上层只负责"用不用 FTS"的能力开关。
 */

/**
 * 切词：按空白拆分、去空串。保留原始大小写（unicode61 自身不区分大小写）。
 * @param {string} query
 * @returns {string[]}
 */
function tokenize(query: unknown): string[] {
  return String(query || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

/**
 * 转义单个 FTS 词：内部双引号按 FTS5 规则翻倍。
 * 不能让用户输入的双引号穿透成语法 —— 那会让 MATCH 抛错（再由上层兜底成 LIKE）。
 * @param {string} token
 * @returns {string}
 */
function escapeFtsToken(token: unknown): string {
  return String(token == null ? '' : token).replace(/"/g, '""')
}

/**
 * 构造 FTS5 MATCH 表达式。
 * @param {string} query
 * @param {{ prefix?: boolean }} [options] prefix=false 时退化为精确词匹配
 * @returns {string} 空查询返回 ''（调用方应据此跳过 FTS 路径）
 */
function buildMatchQuery(query: unknown, { prefix = true }: { prefix?: boolean } = {}): string {
  const tokens = tokenize(query)
  if (tokens.length === 0) return ''
  return tokens
    .map((token) => `"${escapeFtsToken(token)}"${prefix ? '*' : ''}`)
    .join(' ')
}

export { tokenize, escapeFtsToken, buildMatchQuery }
export default { tokenize, escapeFtsToken, buildMatchQuery }
