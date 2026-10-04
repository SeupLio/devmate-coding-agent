/**
 * 在**真实任务**上跑 DevMate，产出多维报告。
 *
 *   bun scripts/bench-run.ts                  # 跑全部任务
 *   bun scripts/bench-run.ts pfe-whatwg-url   # 只跑指定任务
 *
 * 前置：先跑 `bun scripts/bench-build.ts` 生成 benchmarks/real-tasks.json
 * 产出：benchmarks/bench-report.txt / bench-report.json
 *
 * 环境变量：BENCH_NODE_BIN（跑测试用的 node 可执行文件）
 */
import fs from 'node:fs'
import path from 'node:path'
import { downloadTarball } from '../src/lib/bench/github'
import { runBenchTask } from '../src/lib/bench/runner'
import { buildReport, formatReport } from '../src/lib/bench/report'
import type { BenchTask, BenchRunResult } from '../src/lib/bench/types'

const ROOT = process.cwd()
const BENCH_DIR = path.join(ROOT, 'benchmarks')
const WORK_DIR = path.join(BENCH_DIR, '_work')
const TASKS_FILE = path.join(BENCH_DIR, 'real-tasks.json')

async function main() {
  if (!fs.existsSync(TASKS_FILE)) {
    console.error('✗ 未找到 benchmarks/real-tasks.json，请先运行：bun scripts/bench-build.ts')
    process.exit(1)
  }
  // 隐藏测试要在评测阶段从远端拉取；没有 token 会导致任务「无法判定」而被误判为失败
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    console.error('✗ 需要 GITHUB_TOKEN（或 GH_TOKEN）：评测阶段要用它拉取隐藏测试，否则结果不可信')
    process.exit(1)
  }
  const all = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')) as BenchTask[]
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const tasks = only.length ? all.filter((t) => only.includes(t.id)) : all
  if (!tasks.length) {
    console.error('✗ 没有匹配的任务')
    process.exit(1)
  }

  fs.mkdirSync(WORK_DIR, { recursive: true })
  const results: BenchRunResult[] = []

  for (const [i, task] of tasks.entries()) {
    console.log(`\n▶ [${i + 1}/${tasks.length}] ${task.id}  (${task.provenance.repo}@${task.provenance.baseCommit.slice(0, 10)})`)
    console.log(`  难度=${task.difficulty} 类别=${task.category} 出处=${task.provenance.kind}`)
    try {
      // 真实仓库快照（带缓存）
      const repoRoot = await downloadTarball(
        task.provenance.repo,
        task.provenance.baseCommit,
        path.join(WORK_DIR, `${task.provenance.repo.replace(/\//g, '_')}-${task.provenance.baseCommit.slice(0, 10)}`),
      )
      const { result } = await runBenchTask(task, {
        repoRoot,
        sessionId: `bench-${task.id}`,
        thinking: false,
        plan: 'auto',
        onEvent: (ev) => {
          if (ev.type === 'tool_call') process.stdout.write(`  · ${ev.name}\n`)
        },
      })
      results.push(result)
      const f2p = result.assertions.filter((a) => a.name.startsWith('FAIL_TO_PASS'))
      const p2p = result.assertions.filter((a) => a.name.startsWith('PASS_TO_PASS'))
      console.log(
        `  ${result.success ? '✓ PASS' : '✗ FAIL'}  F2P ${f2p.filter((a) => a.ok).length}/${f2p.length}` +
          `  P2P ${p2p.filter((a) => a.ok).length}/${p2p.length}` +
          `  工具=${result.dimensions.toolUse.score.toFixed(2)} 安全=${result.dimensions.safety.score.toFixed(2)}` +
          `  步数=${result.dimensions.efficiency.steps} 耗时=${(result.dimensions.efficiency.ms / 1000).toFixed(0)}s` +
          `  失败模式=${result.failureMode}`,
      )
    } catch (e) {
      console.error(`  ✗ 执行异常：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!results.length) {
    console.error('\n✗ 没有任何任务产出结果')
    process.exit(1)
  }

  const report = buildReport(results)
  const text = formatReport(report)
  console.log(`\n${text}`)
  fs.writeFileSync(path.join(BENCH_DIR, 'bench-report.txt'), text, 'utf-8')
  fs.writeFileSync(path.join(BENCH_DIR, 'bench-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\n✓ 已写入 benchmarks/bench-report.txt / bench-report.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
