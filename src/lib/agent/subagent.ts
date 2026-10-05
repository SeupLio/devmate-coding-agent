/**
 * 子 Agent 委派：把「探索型」子任务丢进**独立上下文**，只把结论带回主上下文。
 *
 * 解决什么问题：主 Agent 读 10 个文件去定位一处实现，这 10 份全文会永久占住
 * 主上下文，把后续推理挤出去（这也是实测里「步数全花在重复读取」的根因之一）。
 * 委派之后，主上下文只收到一段结论。
 *
 * 关键设计：
 *  - **默认只给只读工具**：子 Agent 的职责是「调研」，不是「改文件」。
 *    改文件留在主 Agent 做，避免子 Agent 在背后动主任务的文件。
 *  - **不传 `task` 工具** → 天然防无限递归（子 Agent 不能再派子 Agent）。
 *  - 子 Agent 看不到主对话，所以 prompt 必须自包含（工具描述里已强调）。
 *  - token / 步数消耗**如实回传**，让主 Agent 知道自己花了多少预算。
 */
import { runAgent, type AgentEvent } from './loop'

/** 子 Agent 默认可用工具：只读，且**不含 task**（防递归） */
export const SUBAGENT_READONLY_TOOLS = [
  'list_files',
  'read_file',
  'glob',
  'grep',
  'search_ast',
  'search_semantic',
]

export interface SubagentOptions {
  sessionId: string
  /** 子任务说明；必须自包含（子 Agent 看不到主对话） */
  task: string
  maxSteps?: number
  /** 覆盖默认工具集（仍会被强制剔除 task 以防递归） */
  toolFilter?: string[]
  /** 进度回调（默认不透传，保持主事件流干净） */
  onEvent?: (ev: AgentEvent) => void
  /** 是否允许深度思考（默认关：子 Agent 要快） */
  thinking?: boolean
}

export interface SubagentResult {
  summary: string
  steps: number
  toolCalls: number
  tokensUsed: number
  durationMs: number
  /** 子 Agent 实际用到的工具（便于主 Agent 判断结论可信度） */
  toolsUsed: string[]
  error?: string
}

/**
 * 跑一个子 Agent 并返回它的结论。
 * 子 Agent 使用**独立会话 id**，因此它的沙箱与主 Agent 相同（同一工作区），
 * 但**消息上下文完全隔离** —— 这正是「上下文隔离的委派」的含义。
 */
export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  // 防递归：无论调用方传什么，都剔除 task
  const tools = (opts.toolFilter ?? SUBAGENT_READONLY_TOOLS).filter((t) => t !== 'task')
  const toolsUsed = new Set<string>()
  let summary = ''
  let error: string | undefined
  let stats = { steps: 0, toolCalls: 0, tokensUsed: 0, durationMs: 0 }

  const t0 = Date.now()
  try {
    for await (const ev of runAgent({
      sessionId: opts.sessionId,
      task: opts.task,
      maxSteps: opts.maxSteps ?? 10,
      plan: false,
      thinking: opts.thinking ?? false,
      toolFilter: tools,
      // 只读工具在 default 模式下本来就放行，不需要审批（子 Agent 里弹审批会让人困惑）
      permissionMode: 'default',
    })) {
      opts.onEvent?.(ev)
      if (ev.type === 'tool_call') toolsUsed.add(ev.name)
      if (ev.type === 'final') {
        summary = ev.summary
        stats = ev.stats
      }
      if (ev.type === 'error') error = ev.message
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return {
    summary: summary.trim() || '（子 Agent 没有产出结论）',
    steps: stats.steps,
    toolCalls: stats.toolCalls,
    tokensUsed: stats.tokensUsed,
    durationMs: stats.durationMs || Date.now() - t0,
    toolsUsed: [...toolsUsed],
    error,
  }
}

/** 把子 Agent 结果渲染成给主 Agent 看的文本（明确边界：这是**结论**，不是原文） */
export function formatSubagentResult(r: SubagentResult, description: string): string {
  const lines = [
    `[子 Agent 调研结论｜${description}]`,
    r.summary,
    '',
    `（子 Agent 用了 ${r.steps} 步 / ${r.toolCalls} 次工具调用 / ${r.tokensUsed} tokens，`,
    `  工具：${r.toolsUsed.join(', ') || '无'}；这些中间过程的原文**没有**进入你的上下文）`,
  ]
  if (r.error) lines.push(`  ⚠ 子 Agent 报错：${r.error}`)
  return lines.join('\n')
}
