/**
 * 报告聚合：按**维度 / 难度 / 类别 / 出处**分组，而不是只报一个通过率。
 *
 * 同时给出污染风险汇总 —— 任务若早于模型训练截止，其成绩不能当作
 * 「泛化能力」的证据（见 types.ts 的防泄露设计）。
 */
import type { BenchRunResult } from './types'

export interface GroupStat {
  n: number
  successRate: number
  avgToolUse: number
  avgSafety: number
  avgSteps: number
  avgMs: number
}

export interface BenchReport {
  generatedAt: string
  taskCount: number
  overall: GroupStat
  byDifficulty: Record<string, GroupStat>
  byCategory: Record<string, GroupStat>
  byProvenance: Record<string, GroupStat>
  /** 失败模式分布 */
  failureModes: Record<string, number>
  contamination: { atRisk: number; clean: number; note: string }
  results: BenchRunResult[]
}

function stat(rs: BenchRunResult[]): GroupStat {
  if (!rs.length) {
    return { n: 0, successRate: 0, avgToolUse: 0, avgSafety: 0, avgSteps: 0, avgMs: 0 }
  }
  const avg = (f: (r: BenchRunResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length
  return {
    n: rs.length,
    successRate: rs.filter((r) => r.success).length / rs.length,
    avgToolUse: avg((r) => r.dimensions.toolUse.score),
    avgSafety: avg((r) => r.dimensions.safety.score),
    avgSteps: avg((r) => r.dimensions.efficiency.steps),
    avgMs: avg((r) => r.dimensions.efficiency.ms),
  }
}

function group<K extends string>(rs: BenchRunResult[], key: (r: BenchRunResult) => K): Record<string, GroupStat> {
  const buckets: Record<string, BenchRunResult[]> = {}
  for (const r of rs) (buckets[key(r)] ??= []).push(r)
  const out: Record<string, GroupStat> = {}
  for (const [k, v] of Object.entries(buckets)) out[k] = stat(v)
  return out
}

export function buildReport(results: BenchRunResult[]): BenchReport {
  const failureModes: Record<string, number> = {}
  for (const r of results) failureModes[r.failureMode] = (failureModes[r.failureMode] ?? 0) + 1
  const atRisk = results.filter((r) => r.contaminationRisk).length
  return {
    generatedAt: new Date().toISOString(),
    taskCount: results.length,
    overall: stat(results),
    byDifficulty: group(results, (r) => r.difficulty),
    byCategory: group(results, (r) => r.category),
    byProvenance: group(results, (r) => r.provenanceKind),
    failureModes,
    contamination: {
      atRisk,
      clean: results.length - atRisk,
      note: 'atRisk = 任务提交时间早于其 modelCutoff，存在训练集污染可能，成绩不应作为泛化证据',
    },
    results,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

function fmtGroup(title: string, g: Record<string, GroupStat>): string[] {
  const lines = [`${title}:`]
  for (const [k, v] of Object.entries(g)) {
    lines.push(
      `  ${k.padEnd(14)} n=${String(v.n).padStart(2)}  通过率=${pct(v.successRate).padStart(4)}` +
        `  工具=${v.avgToolUse.toFixed(2)}  安全=${v.avgSafety.toFixed(2)}` +
        `  步数=${v.avgSteps.toFixed(1)}  耗时=${(v.avgMs / 1000).toFixed(1)}s`,
    )
  }
  return lines
}

export function formatReport(rep: BenchReport): string {
  const L: string[] = []
  L.push('='.repeat(78))
  L.push('DevMate 真实任务基准报告')
  L.push(`生成时间：${rep.generatedAt}｜任务数：${rep.taskCount}`)
  L.push('='.repeat(78))
  L.push('')
  L.push(
    `总体：通过率 ${pct(rep.overall.successRate)}｜工具使用 ${rep.overall.avgToolUse.toFixed(2)}` +
      `｜安全 ${rep.overall.avgSafety.toFixed(2)}｜平均步数 ${rep.overall.avgSteps.toFixed(1)}` +
      `｜平均耗时 ${(rep.overall.avgMs / 1000).toFixed(1)}s`,
  )
  L.push('')
  L.push(...fmtGroup('按难度', rep.byDifficulty))
  L.push('')
  L.push(...fmtGroup('按类别', rep.byCategory))
  L.push('')
  L.push(...fmtGroup('按出处（真实性）', rep.byProvenance))
  L.push('')
  L.push('失败模式分布：')
  for (const [k, v] of Object.entries(rep.failureModes).sort((a, b) => b[1] - a[1])) {
    L.push(`  ${k.padEnd(22)} ${v}`)
  }
  L.push('')
  L.push(`污染风险：${rep.contamination.atRisk} 条存疑 / ${rep.contamination.clean} 条未污染`)
  L.push(`  ${rep.contamination.note}`)
  L.push('')
  L.push('逐任务明细：')
  for (const r of rep.results) {
    const mark = r.success ? '✓' : '✗'
    L.push(
      `  ${mark} [${r.difficulty}/${r.category}] ${r.taskId}  ` +
        `工具=${r.dimensions.toolUse.score.toFixed(2)} 安全=${r.dimensions.safety.score.toFixed(2)} ` +
        `步数=${r.dimensions.efficiency.steps} 耗时=${(r.dimensions.efficiency.ms / 1000).toFixed(0)}s`,
    )
    if (!r.success) {
      const failed = r.assertions.filter((a) => !a.ok).map((a) => a.name)
      L.push(`      失败断言：${failed.slice(0, 3).join(' | ')}${failed.length > 3 ? ` …(+${failed.length - 3})` : ''}`)
      if (r.failureEvidence.length) L.push(`      证据：${r.failureEvidence.slice(0, 2).join('；')}`)
    }
  }
  return L.join('\n')
}
