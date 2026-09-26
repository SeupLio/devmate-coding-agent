/**
 * Agent 执行循环核心：
 *   规划（结构化输出）→ 循环{ LLM+ToolCalling → 执行工具 → 回填 } → 最终总结
 *
 * 架构说明：LLM 流式回调（onToken）无法直接在 async generator 中 yield，
 * 因此采用「事件队列 + 并发泵」模式：回调实时 push 事件，外层 generator
 * 实时消费，保证 token 级流式输出与工具调用事件在同一事件流中交织输出。
 */
import { chatStream, estimateTokens, type ChatMessageParam } from './llm'
import { TOOLS, executeTool, filterTools } from './tools'
import { compressContext } from './context'
import { AGENT_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT } from './prompts'

export type AgentEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'context'; tokensBefore: number; tokensAfter: number; compressedCount: number }
  | { type: 'step_start'; step: number }
  | { type: 'final'; summary: string; stats: AgentStats }
  | { type: 'error'; message: string }

export interface AgentStats {
  steps: number
  toolCalls: number
  tokensUsed: number
  durationMs: number
  finished: boolean
}

export interface RunAgentOptions {
  sessionId: string
  task: string
  history?: ChatMessageParam[]
  maxSteps?: number
  plan?: boolean
  // ===== 以下开关用于对照实验（ablation），默认全部开启 =====
  /** 是否启用上下文压缩 */
  useCompression?: boolean
  /** 只允许这些工具名参与编排（默认全部 7 个）；传空数组 = 无工具 */
  toolFilter?: string[]
}

/** 简单异步事件队列：生产者 push，消费者以 async generator 形式实时取出 */
class EventQueue<T> {
  private items: T[] = []
  private resolvers: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    while (this.resolvers.length) {
      this.resolvers.shift()?.({ value: undefined as never, done: true })
    }
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift() as T
      } else if (this.closed) {
        return
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve))
        if (result.done) return
        yield result.value
      }
    }
  }
}

function extractJson(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const queue = new EventQueue<AgentEvent>()

  // 生产者：完整执行 Agent 循环，将事件实时推入队列
  const producer = (async () => {
    const { sessionId, task, maxSteps = 14 } = opts
    const t0 = Date.now()
    const stats: AgentStats = { steps: 0, toolCalls: 0, tokensUsed: 0, durationMs: 0, finished: false }
    // 对照实验用：按需裁剪可用工具集（默认全部 7 个）
    const activeTools = filterTools(opts.toolFilter)
    const useCompression = opts.useCompression !== false

    const messages: ChatMessageParam[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...(opts.history ?? []),
      { role: 'user', content: task },
    ]

    try {
      // ===== 阶段 1：任务规划（结构化输出）=====
      if (opts.plan !== false) {
        const planRes = await chatStream([
          { role: 'system', content: PLAN_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ])
        stats.tokensUsed += estimateTokens(planRes.content)
        const parsed = extractJson(planRes.content)
        const steps = Array.isArray((parsed as { steps?: unknown })?.steps)
          ? ((parsed as { steps: string[] }).steps as string[]).slice(0, 6).map(String)
          : []
        if (steps.length) queue.push({ type: 'plan', steps })
      }

      // ===== 阶段 2：工具调用主循环 =====
      for (let step = 1; step <= maxSteps; step++) {
        queue.push({ type: 'step_start', step })
        stats.steps = step

        // 上下文压缩：超预算时压缩早期工具结果
        if (useCompression) {
          const compressed = compressContext(messages)
          if (compressed.compressedCount > 0) {
            messages.splice(0, messages.length, ...compressed.messages)
            queue.push({
              type: 'context',
              tokensBefore: compressed.tokensBefore,
              tokensAfter: compressed.tokensAfter,
              compressedCount: compressed.compressedCount,
            })
          }
        }

        // token 实时流式推入队列（与工具事件交织）
        const res = await chatStream(messages, activeTools.length ? activeTools : undefined, {
          onToken: (text) => queue.push({ type: 'token', text }),
        })
        stats.tokensUsed += estimateTokens(
          messages.map((m) => m.content ?? '').join('') + res.content,
        )

        if (!res.toolCalls.length) {
          // 没有工具调用 → 最终回答（内容已通过 token 事件流式输出）
          stats.finished = true
          stats.durationMs = Date.now() - t0
          queue.push({ type: 'final', summary: res.content, stats })
          return
        }

        // 记录 assistant 的工具调用决定
        messages.push({
          role: 'assistant',
          content: res.content || null,
          tool_calls: res.toolCalls,
        })

        // 逐个执行工具并回填结果
        for (const tc of res.toolCalls) {
          const args = safeJsonParse(tc.function.arguments)
          queue.push({ type: 'tool_call', id: tc.id, name: tc.function.name, args })
          stats.toolCalls++
          let result: string
          let ok = true
          try {
            result = await executeTool({ sessionId }, tc.function.name, args)
          } catch (e) {
            ok = false
            result = `工具执行异常：${e instanceof Error ? e.message : String(e)}`
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result })
          queue.push({ type: 'tool_result', id: tc.id, name: tc.function.name, result, ok })
        }
      }

      // 达到步数上限，要求模型直接总结
      messages.push({ role: 'user', content: '已达最大步数限制，请基于已有信息直接给出最终总结。' })
      const finalRes = await chatStream(messages, undefined, {
        onToken: (text) => queue.push({ type: 'token', text }),
      })
      stats.finished = true
      stats.durationMs = Date.now() - t0
      queue.push({ type: 'final', summary: finalRes.content, stats })
    } catch (e) {
      queue.push({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      queue.close()
    }
  })()

  // 消费者：外层 generator 实时转发事件
  try {
    yield* queue.iterate()
  } finally {
    producer.catch(() => undefined)
  }
}
