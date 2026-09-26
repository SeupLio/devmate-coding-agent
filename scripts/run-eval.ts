/**
 * 命令行评测入口：bun scripts/run-eval.ts
 * 在全新沙箱上逐任务运行 Agent 并输出通过率报告。
 */
import { runEvaluation } from '../src/lib/eval/runner'

async function main() {
  const taskIds = process.argv.slice(2).length ? process.argv.slice(2) : undefined
  console.log('========== DevMate 评测开始 ==========')
  for await (const ev of runEvaluation(taskIds)) {
    if (ev.type === 'task_start') console.log(`\n▶ 开始任务：${ev.name}`)
    if (ev.type === 'task_done') {
      const r = ev.result
      console.log(`  ${r.passed ? '✓ PASS' : '✗ FAIL'} — ${r.name}`)
      for (const a of r.assertionResults) {
        console.log(`    ${a.passed ? '✓' : '✗'} ${a.name}`)
      }
      if (r.stats) {
        console.log(`    [stats] ${r.stats.steps} 步 / ${r.stats.toolCalls} 次工具调用 / ${(r.stats.durationMs / 1000).toFixed(1)}s`)
      }
    }
    if (ev.type === 'run_done') {
      const rep = ev.report
      console.log('\n========== 评测报告 ==========')
      console.log(`通过率：${rep.passRate}（${rep.passed}/${rep.total}）`)
      console.log(`总用时：${(rep.durationMs / 1000).toFixed(0)}s`)
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
