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

// ===================== 摘要式压缩（P1）=====================

/**
 * 占位符压缩的问题：**被压掉的信息永久丢失**，Agent 后面还得重新读一遍同一文件
 * —— 实测里「步数全花在重复读取上」有一部分就是它造成的。
 *
 * 摘要式压缩把「即将丢弃的工具结果」交给 LLM 提炼成结构化事实，
 * 只丢原文、不丢信息。
 */

export interface SummarizeOptions {
  /** 触发压缩的 token 预算 */
  budget?: number
  /** 保留最近 N 条消息不压缩 */
  keepRecent?: number
}

export interface SmartCompressResult extends CompressResult {
  /** 是否真的用了 LLM 摘要（false = 退回占位符方案） */
  summarized: boolean
  /** 摘要正文（便于观测 / 调试） */
  summary?: string
  /** 被摘要替换掉的工具结果条数 */
  droppedCount: number
}

const SUMMARY_PROMPT = `你在为 Coding Agent 压缩上下文。下面是**即将被丢弃**的工具调用结果原文。

请提炼成结构化摘要，只保留对后续编码有用的信息：
- 已确认的事实（仓库/文件结构、函数位置与行为、测试组织方式）
- 已经做过的修改（改了哪个文件、改成什么）
- 关键代码位置（写成 文件:行 的形式）
- 尚未解决的问题 / 待验证的假设

**丢弃**：大段代码全文、与任务无关的输出、重复内容。

要求：Markdown、不超过 400 字、**不要编造未出现的信息**。如果原文里没有可用信息，就写「（无有效信息）」。`

/**
 * 摘要式压缩：把最早的一批工具结果交给 LLM 提炼成一段摘要。
 *
 * 保持**消息条数不变**（这点很重要：OpenAI 协议要求 tool 消息与 tool_calls 一一对应，
 * 删消息会破坏配对）。做法是把摘要写进**最早的那条**工具结果，其余换成短指针。
 *
 * LLM 调用失败时**自动退回占位符方案** —— 压缩失败不能让主流程挂掉。
 */
export async function compressContextSmart(
  messages: ChatMessageParam[],
  opts: SummarizeOptions = {},
): Promise<SmartCompressResult> {
  const budget = opts.budget ?? CONTEXT_TOKEN_BUDGET
  const keepRecent = opts.keepRecent ?? KEEP_RECENT
  const tokensBefore = totalTokens(messages)

  if (tokensBefore <= budget) {
    return { messages, tokensBefore, tokensAfter: tokensBefore, compressedCount: 0, summarized: false, droppedCount: 0 }
  }

  // 候选：靠前的、较大的工具结果
  const candidates: number[] = []
  messages.forEach((m, i) => {
    if (i >= messages.length - keepRecent) return
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400) candidates.push(i)
  })
  if (!candidates.length) {
    return { messages, tokensBefore, tokensAfter: tokensBefore, compressedCount: 0, summarized: false, droppedCount: 0 }
  }

  // 只摘「够腾出空间」的那一批，不要把所有历史都压掉
  const picked: number[] = []
  let projected = tokensBefore
  for (const i of candidates) {
    if (projected <= budget) break
    const len = (messages[i].content as string).length
    picked.push(i)
    projected -= Math.floor(len / 2) // 与 estimateTokens 同口径
  }

  const joined = picked
    .map((i) => `--- ${messages[i].name ?? 'tool'} ---\n${messages[i].content as string}`)
    .join('\n\n')

  const msgs = messages.map((m) => ({ ...m }))
  try {
    const { chatStream } = await import('./llm')
    const res = await chatStream(
      [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: joined.slice(0, 60_000) },
      ],
      undefined,
      {},
      { enableThinking: false },
    )
    const summary = res.content.trim()
    if (!summary || summary.length < 20) throw new Error('摘要过短，视为失败')

    // 摘要写进最早的那条工具结果，其余换成指针（条数不变）
    msgs[picked[0]].content = `[上下文摘要：以下 ${picked.length} 条较早的工具结果已被 LLM 提炼，原文已丢弃]\n\n${summary}`
    for (let k = 1; k < picked.length; k++) {
      msgs[picked[k]].content = `（已并入上方上下文摘要，原文见摘要）`
    }
    return {
      messages: msgs,
      tokensBefore,
      tokensAfter: totalTokens(msgs),
      compressedCount: picked.length,
      summarized: true,
      summary,
      droppedCount: picked.length,
    }
  } catch {
    // 摘要失败 → 退回占位符方案（宁可丢信息，也不能挂掉主流程）
    const fallback = compressContext(messages)
    return { ...fallback, summarized: false, droppedCount: fallback.compressedCount }
  }
}
