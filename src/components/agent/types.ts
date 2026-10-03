export interface AgentStats {
  steps: number
  toolCalls: number
  tokensUsed: number
  durationMs: number
  finished: boolean
}

export interface TodoItemUI {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export type SSEEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'step_start'; step: number }
  | { type: 'reasoning'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'todos'; todos: TodoItemUI[] }
  | { type: 'context'; tokensBefore: number; tokensAfter: number; compressedCount: number }
  | { type: 'final'; summary: string; stats: AgentStats }
  | { type: 'error'; message: string }

export interface UIToolCall {
  id: string
  name: string
  args: unknown
  result?: string
  ok?: boolean
  status: 'running' | 'done'
}

export interface UIMessage {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'plan' | 'reasoning' | 'error' | 'context'
  text?: string
  tool?: UIToolCall
  steps?: string[]
  stats?: AgentStats
}

export interface SessionInfo {
  id: string
  title: string
  status: string
  updatedAt: string
  messages: { id: string }[]
}

export interface EvalAssertionResult {
  name: string
  passed: boolean
}

export interface FailureDiagnosisUI {
  mode: string
  label: string
  evidence: string[]
  suggestion: string
}

export interface FailureSummaryUI {
  total: number
  passed: number
  failed: number
  byMode: { mode: string; label: string; count: number }[]
}

export interface EvalTaskResultUI {
  taskId: string
  name: string
  passed: boolean
  assertionResults: EvalAssertionResult[]
  stats?: AgentStats
  diagnosis?: FailureDiagnosisUI
}

export interface EvalReportUI {
  runId: string
  passed: number
  total: number
  passRate: string
  durationMs: number
  failureSummary?: FailureSummaryUI
  results: EvalTaskResultUI[]
}

/** /api/eval SSE 事件（与 lib/eval/runner 的 EvalProgress 对应） */
export type EvalSSEEvent =
  | { type: 'run_start'; total: number; tasks: { id: string; name: string }[] }
  | { type: 'task_start'; taskId?: string; name?: string }
  | { type: 'task_done'; taskId?: string; name?: string; result: EvalTaskResultUI }
  | { type: 'run_done'; report: EvalReportUI }
  | { type: 'error'; message: string }
