/**
 * 可观测性报告：聚合 traces/ 目录，输出延迟分位、成本账本、瓶颈与工具失败率。
 *
 *   bun scripts/trace-report.ts          # 最近 100 次运行
 *   bun scripts/trace-report.ts 20       # 最近 20 次
 *
 * 设计意图：把「Agent 跑完了」变成「Agent 跑得怎么样」——
 * 时间花在哪、钱花在哪、哪个工具总失败，一眼能看到。
 */
import { listTraces, summarizeRecent } from '../src/lib/agent/trace-store'

const limit = Number(process.argv[2]) || 100
const s = summarizeRecent(limit)
const idx = listTraces(Math.min(limit, 20))

if (!s.count) {
  console.log('还没有 trace。先跑一次任务（bun run dev 后在页面里发指令，或用 scripts/ 里的评测脚本）。')
  process.exit(0)
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`)

console.log('='.repeat(72))
console.log(`DevMate 可观测性报告（最近 ${s.count} 次运行）`)
console.log('='.repeat(72))
console.log('')
console.log('—— 结果与延迟 ——')
console.log(`  完成率        ${pct(s.successRate)}`)
console.log(`  延迟 P50/P95  ${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)}   （最大 ${ms(s.latencyMs.max)}）`)
console.log(`  平均步数      ${s.avgSteps.toFixed(1)}`)
console.log(`  平均工具调用  ${s.avgToolCalls.toFixed(1)}`)
console.log('')
console.log('—— 成本账本 ——')
console.log(`  总 token      ${s.tokens.total}（输入 ${s.tokens.prompt} / 输出 ${s.tokens.completion}）`)
console.log(`  prompt cache  ${s.tokens.cached} 命中（命中率 ${pct(s.tokens.cacheHitRate)}）`)
console.log(`  思考 token    ${s.tokens.reasoning}`)
if (s.unknownPriceCount > 0) {
  // 诚实：不知道就说不知道，不要显示 ¥0 让人误以为免费
  console.log(
    `  总成本        未配置单价（${s.unknownPriceCount}/${s.count} 次运行的模型不在价格表里）`,
  )
  console.log(`                设置 MODEL_PRICES='{"模型名":{"in":1.0,"out":2.0}}'（每百万 token 人民币）后可用`)
} else {
  console.log(`  总成本        ¥${s.costCny.toFixed(4)}   （单价可配，量级参考）`)
}
console.log('')
console.log('—— 时间花在哪（瓶颈定位）——')
const kinds = Object.entries(s.timeByKind).sort((a, b) => b[1] - a[1])
const total = kinds.reduce((a, [, v]) => a + v, 0) || 1
for (const [k, v] of kinds) {
  const bar = '█'.repeat(Math.max(1, Math.round((v / total) * 30)))
  console.log(`  ${k.padEnd(8)} ${ms(v).padStart(8)}  ${pct(v / total).padStart(4)}  ${bar}`)
}
console.log('')
console.log('—— 工具失败率（Top 8）——')
const tools = Object.entries(s.toolFailure).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8)
if (!tools.length) console.log('  （无工具调用）')
for (const [name, st] of tools) {
  const flag = st.rate > 0.3 ? ' ⚠' : ''
  console.log(`  ${name.padEnd(18)} ${String(st.calls).padStart(3)} 次  失败 ${st.errors}  (${pct(st.rate)})${flag}`)
}
console.log('')
console.log('—— 最慢的 span（Top 5）——')
for (const sp of s.slowestSpans.slice(0, 5)) {
  console.log(`  ${ms(sp.durationMs).padStart(8)}  [${sp.kind}] ${sp.name}`)
}
console.log('')
console.log('—— 最近运行 ——')
console.log('  耗时      成本        token   步数  工具  瓶颈     任务')
for (const t of idx) {
  const cost = t.priceKnown && t.costCny > 0 ? `¥${t.costCny.toFixed(4)}` : '—'
  console.log(
    `  ${ms(t.durationMs).padStart(7)}  ${cost.padStart(8)}  ${String(t.totalTokens).padStart(6)}  ` +
      `${String(t.steps).padStart(4)}  ${String(t.toolCalls).padStart(4)}  ${t.bottleneck.padEnd(8)} ${t.finished ? '✓' : '✗'} ${t.task.slice(0, 34)}`,
  )
}
console.log('')
