/**
 * Agent 执行循环核心：
 *   规划（结构化输出）→ 循环{ LLM+ToolCalling → 执行工具 → 回填 } → 最终总结
 *
 * 架构说明：LLM 流式回调（onToken）无法直接在 async generator 中 yield，
 * 因此采用「事件队列 + 并发泵」模式：回调实时 push 事件，外层 generator
 * 实时消费，保证 token 级流式输出与工具调用事件在同一事件流中交织输出。
 */
import { chatStream, estimateTokens, type ChatMessageParam } from './llm'
import { executeTool, filterTools, normalizeTodos, type TodoItem } from './tools'
import { callMcpTool, getMcpReadOnlySet, getMcpToolDefs, isMcpToolName } from './mcp-registry'
import { compressContext } from './context'
import { AGENT_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT } from './prompts'
import { readProjectMemory } from './workspace'

export type AgentEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'reasoning'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'todos'; todos: TodoItem[] }
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
  /**
   * 是否生成任务规划：
   *  - true（默认）：始终规划（评测用，行为确定）
   *  - false：跳过
   *  - 'auto'：短任务跳过（前端默认，省一次完整 LLM 往返，显著变快）
   */
  plan?: boolean | 'auto'
  /**
   * 是否允许模型深度思考（false 时请求体带 enable_thinking=false，显著更快）。
   * 默认 true（由环境变量 OPENAI_ENABLE_THINKING 兜底）。
   */
  thinking?: boolean
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

/**
 * 组装系统提示词：基础提示 + 沙箱内的项目记忆（DEVmate.md，对标 CLAUDE.md）。
 * 项目记忆让 Agent 知道这个仓库的约定（命令、风格、注意事项），无需每次重述。
 */
function buildSystemPrompt(sessionId: string): string {
  const memory = readProjectMemory(sessionId)
  if (!memory) return AGENT_SYSTEM_PROMPT
  return `${AGENT_SYSTEM_PROMPT}\n\n## 项目说明（来自 DEVmate.md，请优先遵循）\n${memory}`
}

/**
 * 判断任务是否值得单独跑一次规划。
 *
 * 规划是一次**完整的 LLM 往返**；对「重构 X 为 Y」这类短任务，
 * 规划几乎不产生新信息，却让用户多等一整个回合 —— 所以 auto 模式下跳过。
 */
export function needsPlan(task: string): boolean {
  const t = task.trim()
  if (t.length >= 50) return true
  // 真正的「多要求」信号（「然后提交」这类收尾语不算）
  return /[；;]|并且|同时|分别|依次|以及|所有|多个|逐个/.test(t)
}

/**
 * 只读、无共享状态的**内置**工具 —— 可以安全并发。
 *
 * 刻意不包含：`edit_file` / `multi_edit` / `write_file`（写文件，可能改同一路径）、
 * `run_command` / `run_tests`（起子进程，重且有副作用）、`git_operation`（改仓库状态）、
 * `todo_write`（共享 UI 状态）。这些并发会互相踩，必须串行。
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  'list_files',
  'read_file',
  'glob',
  'grep',
  'search_ast',
  'search_semantic',
])

/**
 * 该工具能否与其他只读工具并发执行。
 * MCP 工具必须由服务器显式声明 `readOnlyHint: true` 才允许 —— 保守默认。
 */
export function isConcurrencySafeTool(name: string, readOnlyMcp: Set<string> = new Set()): boolean {
  if (CONCURRENCY_SAFE_TOOLS.has(name)) return true
  return readOnlyMcp.has(name)
}

/** 执行单个工具调用；异常收敛为结果字符串（并发时不能抛出而中断整批） */
async function runOneTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; ok: boolean }> {
  try {
    const result = isMcpToolName(name)
      ? await callMcpTool(name, args)
      : await executeTool({ sessionId }, name, args)
    return { result, ok: true }
  } catch (e) {
    return { result: `工具执行异常：${e instanceof Error ? e.message : String(e)}`, ok: false }
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
    // 内置工具 + **运行时**从 MCP 服务器动态发现的工具（未配置 MCP 时为空，零开销）
    const mcpTools = await getMcpToolDefs()
    const activeTools = [...filterTools(opts.toolFilter), ...mcpTools]
    // 只读 MCP 工具才允许并发（见 isConcurrencySafeTool）
    const readOnlyMcp = await getMcpReadOnlySet()
    const useCompression = opts.useCompression !== false
    const chatOpts = { enableThinking: opts.thinking }
    /** 步数将尽时只提醒一次，避免每步都注入消息 */
    let nudgedLowBudget = false

    const messages: ChatMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(sessionId) },
      ...(opts.history ?? []),
      { role: 'user', content: task },
    ]

    try {
      // ===== 阶段 1：任务规划（结构化输出）=====
      // 规划是一次完整 LLM 往返，简单任务跳过可显著降低首屏等待。
      const wantPlan = opts.plan === 'auto' ? needsPlan(task) : opts.plan !== false
      if (wantPlan) {
        // 规划阶段的思考过程也流式推出去，避免「静默空等」
        const planRes = await chatStream(
          [
            { role: 'system', content: PLAN_SYSTEM_PROMPT },
            { role: 'user', content: task },
          ],
          undefined,
          { onReasoning: (text) => queue.push({ type: 'reasoning', text }) },
          chatOpts,
        )
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

        // 预算感知：步数将尽时提醒模型「先落地改动」。
        // 真实任务基准实测：主要失败模式是 no_edit —— 步数全花在探索上，一次文件都没改。
        const remaining = maxSteps - step
        if (remaining <= 4 && remaining > 0 && !nudgedLowBudget) {
          nudgedLowBudget = true
          messages.push({
            role: 'user',
            content:
              `[系统提醒] 剩余步数仅 ${remaining} 步。请立刻把已确定的修改写入文件`
              + `（edit_file / multi_edit / write_file），然后调用 run_tests 验证；不要再继续探索。`,
          })
        }

        // token 实时流式推入队列（与工具事件交织）
        const res = await chatStream(messages, activeTools.length ? activeTools : undefined, {
          onToken: (text) => queue.push({ type: 'token', text }),
          onReasoning: (text) => queue.push({ type: 'reasoning', text }),
        }, chatOpts)
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

        // ===== 先按序把 tool_call 事件推出去（UI 立刻看到模型决定了什么）=====
        const calls = res.toolCalls.map((tc) => {
          const args = safeJsonParse(tc.function.arguments)
          queue.push({ type: 'tool_call', id: tc.id, name: tc.function.name, args })
          stats.toolCalls++
          // todo_write 额外发一个结构化事件，供前端渲染任务清单
          if (tc.function.name === 'todo_write') {
            const norm = normalizeTodos((args as { todos?: unknown }).todos)
            if (norm.ok) queue.push({ type: 'todos', todos: norm.todos })
          }
          return { tc, args }
        })

        // ===== 执行：连续的只读调用**并发**跑，其余串行 =====
        // 为什么要分批而不是全并发：写操作（edit_file/write_file/git_operation）
        // 之间可能有依赖，并发会互相踩。只对「无副作用」的工具并发才安全。
        const outcomes = new Array<{ result: string; ok: boolean }>(calls.length)
        let idx = 0
        while (idx < calls.length) {
          if (isConcurrencySafeTool(calls[idx].tc.function.name, readOnlyMcp)) {
            let end = idx
            while (end < calls.length && isConcurrencySafeTool(calls[end].tc.function.name, readOnlyMcp)) end++
            const batch = await Promise.all(
              calls.slice(idx, end).map(({ tc, args }) => runOneTool(sessionId, tc.function.name, args)),
            )
            batch.forEach((r, k) => (outcomes[idx + k] = r))
            idx = end
          } else {
            outcomes[idx] = await runOneTool(sessionId, calls[idx].tc.function.name, calls[idx].args)
            idx++
          }
        }

        // ===== 按**原始顺序**回填 =====
        // OpenAI 协议要求 tool 消息与 tool_calls 顺序一一对应，并发也不能乱序
        calls.forEach(({ tc }, k) => {
          const { result, ok } = outcomes[k]
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result })
          queue.push({ type: 'tool_result', id: tc.id, name: tc.function.name, result, ok })
        })
      }

      // 达到步数上限，要求模型直接总结
      messages.push({ role: 'user', content: '已达最大步数限制，请基于已有信息直接给出最终总结。' })
      const finalRes = await chatStream(messages, undefined, {
        onToken: (text) => queue.push({ type: 'token', text }),
        onReasoning: (text) => queue.push({ type: 'reasoning', text }),
      }, chatOpts)
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
