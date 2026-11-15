// @ts-check
/**
 * Calculator suggestor: evaluates simple arithmetic expressions.
 * e.g. "1+1", "2*3", "10/4", "(2+3)*4"
 */

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
import type { SuggestorContext, Suggestion } from '../types'
export function calcSuggestor(ctx: SuggestorContext): Suggestion[] {
  const q = ctx.query.trim()
  if (!q) return []

  // Must contain a digit and an operator
  if (!/\d/.test(q)) return []
  if (!/[+\-*/%()^]/.test(q)) return []

  // Only allow safe characters
  if (!/^[\d+\-*/%.()\s^]+$/.test(q)) return []

  try {
     
    const result = Function(`"use strict"; return (${q})`)()
    if (typeof result === 'number' && isFinite(result)) {
      const display = Number.isInteger(result) ? String(result) : String(parseFloat(result.toFixed(6)))
      return [{
        type: 'calc',
        expression: q,
        result: display,
        relevance: 600,
        source: 'calc'
      }]
    }
  } catch {
    // invalid expression, ignore
  }

  return []
}
