/**
 * 难任务集评测 CLI：bun scripts/run-hard.ts
 *
 * 在**多文件项目**（hard-project）上运行三类难任务，并输出：
 *   - 逐任务断言结果
 *   - 失败模式分类（为什么没通过）
 *   - 失败模式分布汇总
 *
 * 结果写入 reports/hard-report.json / reports/hard-report.txt。
 *
 * 用法：
 *   bun scripts/run-hard.ts                 # 全部 3 个难任务
 *   bun scripts/run-hard.ts hard-golden     # 只跑指定任务
 *   bun scripts/run-hard.ts --repeat 2      # 每任务重复 2 轮
 */
import fs from 'node:fs'
import path from 'node:path'
import { runEvaluation, type EvalRunResult } from '../src/lib/eval/runner'
import { renderFailureSummary, type FailureDiagnosis } from '../src/lib/eval/failure-modes'

function parseArgs(argv: string[]) {
  const taskIds: string[] = []
  let repeat = 1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat') repeat = Number(argv[++i]) || 1
    else if (!argv[i].startsWith('--')) taskIds.push(argv[i])
  }
  return { taskIds, repeat }
}

async function main() {
  const { taskIds, repeat } = parseArgs(process.argv.slice(2))

  console.log('========== DevMate 难任务集评测（多文件 / 长链路 / 环境反馈）==========')
  console.log(`重复：${repeat} 轮${taskIds.length ? `｜任务：${taskIds.join(', ')}` : '｜全部难任务'}\n`)

  let report: EvalRunResult | null = null

  for await (const ev of runEvaluation({ only: 'hard', taskIds, repeat })) {
    if (ev.type === 'run_start') console.log(`共 ${ev.total} 个任务待执行\n`)
    if (ev.type === 'task_start') console.log(`▶ 开始任务：${ev.name}`)
    if (ev.type === 'task_done') {
      const r = ev.result!
      console.log(`  ${r.passed ? '✓ PASS' : '✗ FAIL'} — ${r.name}`)
      for (const a of r.assertionResults) console.log(`    ${a.passed ? '✓' : '✗'} ${a.name}`)
      if (r.stats) {
        console.log(
          `    [stats] ${r.stats.steps} 步 / ${r.stats.toolCalls} 次工具调用 / ${(r.stats.durationMs / 1000).toFixed(1)}s`,
        )
      }
      if (!r.passed && r.diagnosis) {
        console.log(`    ⚑ 失败模式：${r.diagnosis.label}`)
        for (const e of r.diagnosis.evidence) console.log(`      · ${e}`)
        console.log(`      → ${r.diagnosis.suggestion}`)
      }
      console.log('')
    }
    if (ev.type === 'run_done' && ev.report) report = ev.report
    if (ev.type === 'error') {
      console.error('评测异常：', ev.message)
      process.exit(2)
    }
  }

  if (!report) return

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('DevMate 难任务集评测报告')
  lines.push(`开始：${report.startedAt}｜用时：${(report.durationMs / 1000).toFixed(0)}s`)
  lines.push('='.repeat(80))
  lines.push(`通过率：${report.passRate}（${report.passed}/${report.total}）`)
  lines.push(
    `平均步数：${report.avgSteps}｜平均工具调用：${report.avgToolCalls}｜平均耗时：${(report.avgDurationMs / 1000).toFixed(1)}s`,
  )
  lines.push('')
  lines.push(renderFailureSummary(report.failureSummary))
  lines.push('')
  lines.push('逐任务明细：')
  for (const r of report.results) {
    lines.push(`  ${r.passed ? '✓' : '✗'} ${r.name}`)
    for (const a of r.assertionResults) lines.push(`      ${a.passed ? '✓' : '✗'} ${a.name}`)
    const d = r.diagnosis as FailureDiagnosis | undefined
    if (!r.passed && d) lines.push(`      ⚑ ${d.label}：${d.evidence.join('；')}`)
  }
  const text = lines.join('\n')
  console.log('\n' + text)

  const outDir = path.join(process.cwd(), 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'hard-report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(outDir, 'hard-report.txt'), text)
  console.log('\n已写入 reports/hard-report.json / reports/hard-report.txt')
  process.exit(report.passed === report.total ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
