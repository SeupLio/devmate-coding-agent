/**
 * 上下文管理：对多轮 Agent 对话做 token 预算控制与压缩。
 * 策略（分层）：
 *  1. 工具结果在写入时就已截断（tools.ts 内的 truncate）；
 *  2. 当累计上下文超过预算时，从最早的 tool 消息开始，
 *     将其内容替换为「压缩占位符」，保留关键统计信息；
 *  3. 每次压缩后重新估算并报告 token，形成可观测的压缩链路。
 */
import { estimateTokens, type ChatMessageParam } from './llm'

export const CONTEXT_TOKEN_BUDGET = 16_000
/** 至少保留最近 N 条消息不压缩，保证当前任务的信息完整 */
const KEEP_RECENT = 8

export function totalTokens(messages: ChatMessageParam[]): number {
  return messages.reduce((acc, m) => {
    const content = typeof m.content === 'string' ? m.content : ''
    return acc + estimateTokens(content) + estimateTokens(m.tool_calls?.map((t) => JSON.stringify(t)).join('') ?? '')
  }, 0)
}

export interface CompressResult {
  messages: ChatMessageParam[]
  tokensBefore: number
  tokensAfter: number
  compressedCount: number
}

/**
 * 压缩历史：将较早的 tool 结果替换为占位符。
 * 保留 assistant 的 tool_calls（行为轨迹），只压缩 tool 返回的大段内容。
 */
export function compressContext(messages: ChatMessageParam[]): CompressResult {
  const tokensBefore = totalTokens(messages)
  if (tokensBefore <= CONTEXT_TOKEN_BUDGET) {
    return { messages, tokensBefore, tokensAfter: tokensBefore, compressedCount: 0 }
  }
  const msgs = messages.map((m) => ({ ...m }))
  let compressed = 0
  // 从最早的消息开始压缩 tool 结果，直到进入预算或无更多信息可压
  const candidates: number[] = []
  msgs.forEach((m, i) => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400) {
      candidates.push(i)
    }
  })
  for (const i of candidates) {
    if (totalTokens(msgs) <= CONTEXT_TOKEN_BUDGET) break
    if (i >= msgs.length - KEEP_RECENT) break
    const original = msgs[i].content as string
    msgs[i].content = `[上下文压缩：原工具结果 ${original.length} 字符已省略，前 200 字符摘要：${original.slice(0, 200)}...]`
    compressed++
  }
  return {
    messages: msgs,
    tokensBefore,
    tokensAfter: totalTokens(msgs),
    compressedCount: compressed,
  }
}
