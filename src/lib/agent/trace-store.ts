/**
 * Trace 落盘与读取。
 *
 * 存储：`traces/<traceId>.json`（一行一个完整记录，方便直接 grep / 回放）。
 * 刻意用文件而不是数据库：trace 是**运维数据**，应该能被 rsync 走、
 * 被 jq 查、被离线脚本聚合，而不该跟业务库耦合。
 */
import fs from 'node:fs'
import path from 'node:path'
import { summarize, type TraceRecord, type TraceSummary } from './trace'

const DIR = path.join(process.cwd(), 'traces')

function ensureDir(): string {
  fs.mkdirSync(DIR, { recursive: true })
  return DIR
}

export function saveTrace(rec: TraceRecord): string {
  ensureDir()
  const file = path.join(DIR, `${rec.traceId}.json`)
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf-8')
  return file
}

export interface TraceIndexItem {
  traceId: string
  task: string
  model: string
  startedAt: number
  durationMs: number
  costCny: number
  /** 单价是否已知；false 时 costCny 不可信（不是 0 元，是不知道） */
  priceKnown: boolean
  totalTokens: number
  finished: boolean
  steps: number
  toolCalls: number
  /** 最耗时的类别（llm / tool / plan） */
  bottleneck: string
}

export function listTraces(limit = 100): TraceIndexItem[] {
  if (!fs.existsSync(DIR)) return []
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)

  const out: TraceIndexItem[] = []
  for (const { f } of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')) as TraceRecord
      const bottleneck = Object.entries(r.timeByKind ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-'
      out.push({
        traceId: r.traceId,
        task: r.task,
        model: r.model,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        costCny: r.costCny,
        priceKnown: r.priceKnown !== false,
        totalTokens: r.usage?.totalTokens ?? 0,
        finished: r.outcome?.finished ?? false,
        steps: r.outcome?.steps ?? 0,
        toolCalls: r.outcome?.toolCalls ?? 0,
        bottleneck,
      })
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out
}

export function loadTrace(traceId: string): TraceRecord | null {
  // 防路径穿越：只允许 hex / uuid 形态
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(traceId)) return null
  const file = path.join(DIR, `${traceId}.json`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as TraceRecord
  } catch {
    return null
  }
}

/** 对最近的 trace 做聚合（P50/P95、成本、工具失败率、瓶颈） */
export function summarizeRecent(limit = 100): TraceSummary {
  if (!fs.existsSync(DIR)) return summarize([])
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
  const recs: TraceRecord[] = []
  for (const { f } of files) {
    try {
      recs.push(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')) as TraceRecord)
    } catch {
      /* ignore */
    }
  }
  return summarize(recs)
}
