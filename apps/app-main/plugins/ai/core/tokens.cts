/**
 * token 估算（PART15 §9「预算与裁剪」）。
 *
 * 刻意**不引 tokenizer**：BPE 词表是几 MB，而这里只需要"别把上下文撑爆"这个量级的
 * 精度。经验比值对中英混排足够稳（英文 ~4 字符/token，中文 ~1.5 字符/token）。
 * 真的算错 10% 也不致命 —— 裁剪留了 20% 余量。
 */

/** 粗估一段文本的 token 数。 */
import type { AiMessage } from '../types'

function estimateTokens(text: unknown): number {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/** 估一个消息数组。 */
function estimateMessages(messages: unknown): number {
  let n = 0
  for (const m of (Array.isArray(messages) ? messages : []) as AiMessage[]) {
    // role / separator / JSON framing 也消耗请求 token；固定留量比“只算正文”安全。
    n += 4
    if (m.role === 'user' || m.role === 'assistant') {
      for (const b of (m.blocks || [])) {
        n += 4
        if (b.type === 'text') n += estimateTokens(b.text)
        else if (b.type === 'image') n += 800 // 一张图按视觉 token 的保守下估算
        else if (b.type === 'tool-call') n += estimateTokens(JSON.stringify(b.args || {}))
      }
      // 思考模式的推理正文也会随请求发出去（同源服务端要求原样回传），
      // 必须计入预算，否则裁剪会以为这条消息"不要钱"。
      if (m.reasoning && typeof m.reasoning.text === 'string') n += estimateTokens(m.reasoning.text)
    } else if (m.role === 'tool-call') {
      n += 4 + estimateTokens(String(m.name || '')) + estimateTokens(JSON.stringify(m.args || {}))
    } else if (m.role === 'tool-result') {
      n += 4
      n += estimateTokens(typeof m.result === 'string' ? m.result : JSON.stringify(m.result || ''))
    }
  }
  return n
}

/**
 * 预算裁剪：**从最旧的一端丢**，并保证最后一轮用户消息一定在。
 *
 * 裁剪顺序（§9）：先丢 `context/injected` 的页面快照，再丢最早的历史消息。
 * 这里由调用方先把快照展开成消息前缀，所以统一按"丢最旧"处理；
 * 最后一条 user 消息（当前问题）无论如何保留 —— 丢它等于没回答。
 *
 * @param {{ messages: object[], budgetTokens: number }} args
 * @returns {{ messages: object[], dropped: number, usedTokens: number }}
 */
function trimToBudget({ messages, budgetTokens }: { messages: AiMessage[]; budgetTokens: number }) : {
  messages: AiMessage[]
  dropped: number
  usedTokens: number
  removed: AiMessage[]
} {
  const list = Array.isArray(messages) ? messages.slice() : []
  const removed: AiMessage[] = []
  let used = estimateMessages(list)
  let dropped = 0
  // 以 user 消息为轮次边界整段删除。不能逐条 shift：那会把 assistant /
  // tool-call / tool-result 拆散，下一请求直接违反工具协议，也会让思考回路失忆。
  // seq=0 的隐藏消息是压缩摘要，永远作为稳定前缀保留。
  const protectedHead = list[0] && list[0].seq === 0 ? 1 : 0
  const latestUser = list.reduce((at, message, index) => message.role === 'user' ? index : at, -1)

  /** 只压缩结果正文，保留头尾与工具调用协议结构。 */
  const shrinkResult = (text: string, limit: number): string => {
    if (text.length <= limit) return text
    const tail = Math.max(120, Math.floor(limit * 0.22))
    const head = Math.max(240, limit - tail)
    return `${text.slice(0, head)}\n…（旧工具结果已按上下文预算压缩）…\n${text.slice(-tail)}`
  }
  const compressToolResults = (end: number, limit: number): void => {
    for (let i = protectedHead; i < end; i += 1) {
      const message = list[i]
      if (!message || message.role !== 'tool-result' || typeof message.result !== 'string') continue
      if (message.result.length <= limit) continue
      const before = estimateMessages([message])
      const next = { ...message, result: shrinkResult(message.result, limit) }
      list[i] = next
      used -= before - estimateMessages([next])
    }
  }
  const compressHiddenContext = (limit: number): void => {
    for (let i = protectedHead; i < list.length; i += 1) {
      const message = list[i]
      if (!message || message.role !== 'user' || !Array.isArray(message.blocks)) continue
      let changed = false
      const blocks = message.blocks.map((block) => {
        if (block.type !== 'text' || !block.hidden || block.text.length <= limit) return block
        changed = true
        return { ...block, text: shrinkResult(block.text, limit) }
      })
      if (!changed) continue
      const before = estimateMessages([message])
      list[i] = { ...message, blocks }
      used -= before - estimateMessages([list[i]])
    }
  }

  // 先压历史工具结果，再压当前轮结果；只有这些都不够时才删除整个旧轮次。
  if (used > budgetTokens && latestUser >= protectedHead) {
    for (const limit of [6_000, 2_000, 800]) {
      compressToolResults(latestUser, limit)
      if (used <= budgetTokens) break
    }
  }
  if (used > budgetTokens) {
    for (const limit of [10_000, 4_000, 1_200]) {
      compressToolResults(list.length, limit)
      if (used <= budgetTokens) break
    }
  }
  if (used > budgetTokens) {
    for (const limit of [8_000, 3_000, 1_000]) {
      compressHiddenContext(limit)
      if (used <= budgetTokens) break
    }
  }

  while (used > budgetTokens) {
    let firstTurn = -1
    let nextTurn = -1
    for (let i = protectedHead; i < list.length; i += 1) {
      if (list[i].role !== 'user') continue
      if (firstTurn < 0) firstTurn = i
      else { nextTurn = i; break }
    }
    if (firstTurn < 0 || nextTurn < 0) break
    const part = list.splice(firstTurn, nextTurn - firstTurn)
    removed.push(...part)
    used -= estimateMessages(part)
    dropped += part.length
  }
  return { messages: list, dropped, removed, usedTokens: used }
}

module.exports = { estimateTokens, estimateMessages, trimToBudget }
