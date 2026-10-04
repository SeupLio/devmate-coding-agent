/** 调试：跑一个真实任务并打印完整轨迹，用来看 Agent 到底卡在哪 */
import { downloadTarball } from '../src/lib/bench/github'
import { runBenchTask } from '../src/lib/bench/runner'
import type { BenchTask } from '../src/lib/bench/types'
import fs from 'node:fs'

const id = process.argv[2] ?? 'celjs-source-ranges'
const tasks = JSON.parse(fs.readFileSync('benchmarks/real-tasks.json', 'utf-8')) as BenchTask[]
const task = tasks.find((t) => t.id === id)!
console.log('task:', task.id, '| maxSteps:', task.maxSteps)
console.log('prompt 前 300 字:\n', task.prompt.slice(0, 300))
console.log('---')

const repoRoot = await downloadTarball(
  task.provenance.repo,
  task.provenance.baseCommit,
  `benchmarks/_work/${task.provenance.repo.replace(/\//g, '_')}-${task.provenance.baseCommit.slice(0, 10)}`,
)

let n = 0
const { result } = await runBenchTask(task, {
  repoRoot,
  sessionId: `dbg-${task.id}`,
  thinking: false,
  plan: 'auto',
  onEvent: (ev) => {
    if (ev.type === 'tool_call') {
      n++
      const a = JSON.stringify(ev.args ?? {})
      console.log(`[${n}] ${ev.name}  ${a.length > 160 ? a.slice(0, 160) + '…' : a}`)
    } else if (ev.type === 'tool_result') {
      const r = String(ev.result ?? '').replace(/\n/g, ' ⏎ ')
      console.log(`     ↳ ${r.length > 180 ? r.slice(0, 180) + '…' : r}`)
    } else if (ev.type === 'reasoning') {
      process.stdout.write('') // 思考内容不打印
    } else if (ev.type === 'final') {
      console.log(`\n=== final ===\n${ev.summary.slice(0, 1200)}`)
    } else if (ev.type === 'error') {
      console.log('ERROR:', ev.message)
    }
  },
})

console.log('\n=== 结果 ===')
console.log('success:', result.success, '| failureMode:', result.failureMode)
console.log('失败断言:', result.assertions.filter((a) => !a.ok).map((a) => a.name).slice(0, 6))
console.log('工具使用:', JSON.stringify(result.dimensions.toolUse))
