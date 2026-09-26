export interface AgentStats {
  steps: number
  toolCalls: number
  tokensUsed: number
  durationMs: number
  finished: boolean
}

export type SSEEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'step_start'; step: number }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; ok: boolean }
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
  kind: 'user' | 'assistant' | 'tool' | 'plan' | 'error' | 'context'
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

export interface EvalTaskResultUI {
  taskId: string
  name: string
  passed: boolean
  assertionResults: EvalAssertionResult[]
  stats?: AgentStats
}

export interface EvalReportUI {
  runId: string
  passed: number
  total: number
  passRate: string
  durationMs: number
  results: EvalTaskResultUI[]
}
