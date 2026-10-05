/**
 * 可观测性：一次任务 = 一个 **trace**，每次 LLM / 工具调用 = 一个 **span**。
 *
 * 为什么必须有这个：没有 trace，线上排查「这次为什么没修好」只能靠猜。
 * 有了它才能回答：
 *  - 时间花在哪（LLM 往返 vs 工具执行）
 *  - 哪一步最贵（token / 成本）
 *  - 哪个工具总失败
 *  - 失败的 span 长什么样（可回放）
 *
 * 成本账本：优先用 API 返回的**真实 usage**，拿不到才退回估算，
 * 并在记录里标注 `usageSource`，避免把估算当真实值。
 */
import { randomUUID } from 'node:crypto'

export interface Span {
  id: string
  traceId: string
  parentId?: string
  name: string
  kind: 'llm' | 'tool' | 'plan'
  startMs: number
  endMs: number
  durationMs: number
  status: 'ok' | 'error'
  attrs: Record<string, unknown>
}

export interface TraceUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 命中 prompt cache 的 token 数（缓存命中率高 = 成本低） */
  cachedTokens: number
  /** 其中用于思考的 token 数 */
  reasoningTokens: number
  /** 'api' = 来自 API 真实 usage；'estimated' = 本地估算（长度/2） */
  source: 'api' | 'estimated' | 'mixed'
}

export interface TraceRecord {
  traceId: string
  sessionId: string
  task: string
  model: string
  startedAt: number
  endedAt: number
  durationMs: number
  spans: Span[]
  usage: TraceUsage
  /** 人民币，量级参考 */
  costCny: number
  /**
   * 该模型的单价是否已知。
   * false 时 costCny 无意义（不是 0 元，而是**不知道**）——
   * 报告里必须区分「免费」和「没配单价」，否则会误导成本决策。
   */
  priceKnown: boolean
  outcome: {
    finished: boolean
    steps: number
    toolCalls: number
    error?: string
  }
  /** 按 kind 汇总的耗时，一眼看出瓶颈在 LLM 还是工具 */
  timeByKind: Record<string, number>
}

// ===================== 成本账本 =====================

/**
 * 每 **100 万 token** 的价格（人民币）。
 *
 * ⚠️ 价格会变，这里只求量级正确，不要当账单用。
 * 可用环境变量 `MODEL_PRICES` 覆盖：{"模型名":{"in":1.0,"out":2.0}}
 */
const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  'glm-4-flash': { in: 0, out: 0 },
  'glm-4-air': { in: 0.5, out: 0.5 },
  'glm-4-plus': { in: 50, out: 50 },
  'gpt-4o-mini': { in: 1.1, out: 4.3 },
  'gpt-4o': { in: 18, out: 72 },
  'qwen-turbo': { in: 0.3, out: 0.6 },
  'qwen-plus': { in: 0.8, out: 2 },
  'deepseek-chat': { in: 1, out: 2 },
}

function priceOf(model: string): { in: number; out: number } {
  if (process.env.MODEL_PRICES) {
    try {
      const t = JSON.parse(process.env.MODEL_PRICES) as Record<string, { in: number; out: number }>
      if (t[model]) return t[model]
    } catch {
      /* 忽略非法配置 */
    }
  }
  // 前缀匹配（网关常带后缀，如 qwen3.8-max-2026xx）
  const key = Object.keys(PRICE_TABLE).find((k) => model.startsWith(k) || model.includes(k))
  return key ? PRICE_TABLE[key] : { in: 0, out: 0 }
}

/** 该模型是否有已知单价（没有就不要编一个数字出来） */
export function hasPrice(model: string): boolean {
  if (process.env.MODEL_PRICES) {
    try {
      const t = JSON.parse(process.env.MODEL_PRICES) as Record<string, unknown>
      if (t[model]) return true
    } catch {
      /* 忽略非法配置 */
    }
  }
  return Object.keys(PRICE_TABLE).some((k) => model.startsWith(k) || model.includes(k))
}

export function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceOf(model)
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out
}

// ===================== Tracer =====================

export class Tracer {
  readonly traceId: string
  private spans: Span[] = []
  private startedAt = Date.now()
  private promptTokens = 0
  private completionTokens = 0
  private cachedTokens = 0
  private reasoningTokens = 0
  private sawApiUsage = false
  private sawEstimate = false
  private error?: string
  private finished = false
  private steps = 0
  private toolCalls = 0

  constructor(
    readonly sessionId: string,
    readonly task: string,
    readonly model: string,
  ) {
    this.traceId = randomUUID()
  }

  /** 开一个 span，返回结束函数（用 finally 保证一定被调用） */
  startSpan(name: string, kind: Span['kind'], attrs: Record<string, unknown> = {}): SpanHandle {
    const span: Span = {
      id: randomUUID(),
      traceId: this.traceId,
      name,
      kind,
      startMs: Date.now(),
      endMs: 0,
      durationMs: 0,
      status: 'ok',
      attrs,
    }
    this.spans.push(span)
    return {
      end: (extra?: Record<string, unknown>, status: Span['status'] = 'ok') => {
        span.endMs = Date.now()
        span.durationMs = span.endMs - span.startMs
        span.status = status
        if (extra) Object.assign(span.attrs, extra)
      },
    }
  }

  /** 记录一次 LLM 往返的 token 用量 */
  recordLlmUsage(
    usage:
      | {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          completion_tokens_details?: { reasoning_tokens?: number }
        }
      | undefined,
    estimatedTotal: number,
  ) {
    if (usage?.prompt_tokens != null || usage?.completion_tokens != null) {
      this.promptTokens += usage?.prompt_tokens ?? 0
      this.completionTokens += usage?.completion_tokens ?? 0
      this.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0
      this.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0
      this.sawApiUsage = true
    } else {
      // 拿不到真实 usage 时退回估算（长度/2），并标注来源，避免把估算当真实值
      this.completionTokens += estimatedTotal
      this.sawEstimate = true
    }
  }

  countStep() {
    this.steps++
  }

  countToolCall() {
    this.toolCalls++
  }

  fail(message: string) {
    this.error = message
  }

  finish(): TraceRecord {
    if (!this.finished) {
      this.finished = true
      this.endedAt = Date.now()
    }
    const timeByKind: Record<string, number> = {}
    for (const s of this.spans) timeByKind[s.kind] = (timeByKind[s.kind] ?? 0) + s.durationMs
    return {
      traceId: this.traceId,
      sessionId: this.sessionId,
      task: this.task.slice(0, 500),
      model: this.model,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.endedAt - this.startedAt,
      spans: this.spans,
      usage: {
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        totalTokens: this.promptTokens + this.completionTokens,
        cachedTokens: this.cachedTokens,
        reasoningTokens: this.reasoningTokens,
        source: this.sawApiUsage && this.sawEstimate ? 'mixed' : this.sawApiUsage ? 'api' : 'estimated',
      },
      costCny: costOf(this.model, this.promptTokens, this.completionTokens),
      priceKnown: hasPrice(this.model),
      outcome: { finished: !this.error, steps: this.steps, toolCalls: this.toolCalls, error: this.error },
      timeByKind,
    }
  }

  private endedAt = this.startedAt
}

// ===================== 聚合分析 =====================

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

export interface TraceSummary {
  count: number
  successRate: number
  latencyMs: { p50: number; p95: number; max: number }
  tokens: {
    prompt: number
    completion: number
    total: number
    cached: number
    reasoning: number
    /** prompt cache 命中率：越高越省钱 */
    cacheHitRate: number
  }
  costCny: number
  /** 有多少次运行的模型单价未知（这些的 costCny 不可信） */
  unknownPriceCount: number
  avgSteps: number
  avgToolCalls: number
  /** 时间都花在哪 */
  timeByKind: Record<string, number>
  /** 工具失败率（按工具名） */
  toolFailure: Record<string, { calls: number; errors: number; rate: number }>
  /** 最慢的 span */
  slowestSpans: { name: string; kind: string; durationMs: number }[]
}

export function summarize(traces: TraceRecord[]): TraceSummary {
  if (!traces.length) {
    return {
      count: 0, successRate: 0, latencyMs: { p50: 0, p95: 0, max: 0 },
      tokens: { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0, cacheHitRate: 0 },
      costCny: 0,
      unknownPriceCount: 0,
      avgSteps: 0, avgToolCalls: 0, timeByKind: {}, toolFailure: {}, slowestSpans: [],
    }
  }
  const durs = traces.map((t) => t.durationMs)
  const timeByKind: Record<string, number> = {}
  const toolFailure: Record<string, { calls: number; errors: number; rate: number }> = {}
  const allSpans: Span[] = []

  for (const t of traces) {
    for (const [k, v] of Object.entries(t.timeByKind)) timeByKind[k] = (timeByKind[k] ?? 0) + v
    for (const s of t.spans) {
      allSpans.push(s)
      if (s.kind === 'tool') {
        const e = (toolFailure[s.name] ??= { calls: 0, errors: 0, rate: 0 })
        e.calls++
        if (s.status === 'error') e.errors++
      }
    }
  }
  for (const e of Object.values(toolFailure)) e.rate = e.calls ? e.errors / e.calls : 0

  const promptTotal = traces.reduce((a, t) => a + t.usage.promptTokens, 0)
  const cachedTotal = traces.reduce((a, t) => a + (t.usage.cachedTokens ?? 0), 0)

  return {
    count: traces.length,
    successRate: traces.filter((t) => t.outcome.finished).length / traces.length,
    latencyMs: { p50: percentile(durs, 50), p95: percentile(durs, 95), max: Math.max(...durs) },
    tokens: {
      prompt: promptTotal,
      completion: traces.reduce((a, t) => a + t.usage.completionTokens, 0),
      total: traces.reduce((a, t) => a + t.usage.totalTokens, 0),
      cached: cachedTotal,
      reasoning: traces.reduce((a, t) => a + (t.usage.reasoningTokens ?? 0), 0),
      cacheHitRate: promptTotal ? cachedTotal / promptTotal : 0,
    },
    costCny: traces.reduce((a, t) => a + t.costCny, 0),
    unknownPriceCount: traces.filter((t) => t.priceKnown === false).length,
    avgSteps: traces.reduce((a, t) => a + t.outcome.steps, 0) / traces.length,
    avgToolCalls: traces.reduce((a, t) => a + t.outcome.toolCalls, 0) / traces.length,
    timeByKind,
    toolFailure,
    slowestSpans: allSpans
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10)
      .map((s) => ({ name: s.name, kind: s.kind, durationMs: s.durationMs })),
  }
}

export interface SpanHandle {
  end: (extra?: Record<string, unknown>, status?: Span['status']) => void
}
