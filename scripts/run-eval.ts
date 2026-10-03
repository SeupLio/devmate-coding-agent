/**
 * 命令行评测入口：bun scripts/run-eval.ts [任务ID...]
 * 在全新沙箱上逐任务运行 Agent 并输出通过率报告。
 *
 * 常用：
 *   bun scripts/run-eval.ts                 # 全部任务（含 held-out）
 *   bun scripts/run-eval.ts --only default  # 只跑常规集
 *   bun scripts/run-eval.ts --only holdout  # 只跑 held-out 集
 *   bun scripts/run-eval.ts --repeat 3      # 每任务重复 3 轮（观察方差）
 */
import { runEvaluation } from '../src/lib/eval/runner'
import { renderFailureSummary } from '../src/lib/eval/failure-modes'

function parseArgs(argv: string[]) {
  const taskIds: string[] = []
  let only: 'default' | 'holdout' | 'hard' | 'all' = 'all'
  let repeat = 1
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') only = (argv[++i] as typeof only) ?? 'all'
    else if (a === '--repeat') repeat = Number(argv[++i]) || 1
    else taskIds.push(a)
  }
  return { taskIds, only, repeat }
}

async function main() {
  const { taskIds, only, repeat } = parseArgs(process.argv.slice(2))
  console.log('========== DevMate 评测开始 ==========')
  console.log(`范围：${only}｜重复：${repeat} 轮${taskIds.length ? `｜任务：${taskIds.join(', ')}` : ''}\n`)
  for await (const ev of runEvaluation({ taskIds, only, repeat })) {
    if (ev.type === 'task_start') console.log(`▶ 开始任务：${ev.name}`)
    if (ev.type === 'task_done') {
      const r = ev.result!
      console.log(`  ${r.passed ? '✓ PASS' : '✗ FAIL'} — ${r.name}`)
      for (const a of r.assertionResults) {
        console.log(`    ${a.passed ? '✓' : '✗'} ${a.name}`)
      }
      if (!r.passed && r.diagnosis) {
        console.log(`    ⚑ 失败模式：${r.diagnosis.label}`)
        for (const e of r.diagnosis.evidence) console.log(`      · ${e}`)
        console.log(`      → ${r.diagnosis.suggestion}`)
      }
      if (r.stats) {
        console.log(`    [stats] ${r.stats.steps} 步 / ${r.stats.toolCalls} 次工具调用 / ${(r.stats.durationMs / 1000).toFixed(1)}s`)
      }
    }
    if (ev.type === 'run_done') {
      const rep = ev.report!
      console.log('\n========== 评测报告 ==========')
      console.log(`通过率：${rep.passRate}（${rep.passed}/${rep.total}）`)
      console.log(`平均步数：${rep.avgSteps}｜平均工具调用：${rep.avgToolCalls}｜平均耗时：${(rep.avgDurationMs / 1000).toFixed(1)}s`)
      console.log(`总用时：${(rep.durationMs / 1000).toFixed(0)}s`)
      console.log('')
      console.log(renderFailureSummary(rep.failureSummary))
      process.exit(rep.passed === rep.total ? 0 : 1)
    }
    if (ev.type === 'error') {
      console.error('评测异常：', ev.message)
      process.exit(2)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
