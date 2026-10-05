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

export type PermissionModeUI = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export type SSEEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'step_start'; step: number }
  | { type: 'reasoning'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
  | { type: 'todos'; todos: TodoItemUI[] }
  | { type: 'context'; tokensBefore: number; tokensAfter: number; compressedCount: number }
  /** 权限判定结果（审计用；deny 时值得在 UI 上提示） */
  | { type: 'permission'; tool: string; action: 'allow' | 'deny' | 'ask'; risk: string; reason: string }
  /** 需要人工审批：UI 弹卡片，用户决定后 POST /api/approvals */
  | { type: 'approval_required'; id: string; tool: string; args: unknown; risk: string; reason: string }
  /** 运行结束的可观测性摘要 */
  | {
      type: 'trace'
      traceId: string
      durationMs: number
      costCny: number
      usage: { promptTokens: number; completionTokens: number; totalTokens: number; source: string }
      timeByKind: Record<string, number>
    }
  | { type: 'final'; summary: string; stats: AgentStats }
  | { type: 'error'; message: string }

export interface UIApproval {
  id: string
  tool: string
  args: unknown
  risk: string
  reason: string
  /** 用户决定后的状态 */
  status: 'pending' | 'allowed' | 'denied' | 'expired'
}

export interface UITrace {
  traceId: string
  durationMs: number
  costCny: number
  totalTokens: number
  usageSource: string
  timeByKind: Record<string, number>
}

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
  kind:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'plan'
    | 'reasoning'
    | 'error'
    | 'context'
    | 'approval'
    | 'permission_denied'
    | 'trace'
  text?: string
  tool?: UIToolCall
  steps?: string[]
  stats?: AgentStats
  approval?: UIApproval
  trace?: UITrace
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
