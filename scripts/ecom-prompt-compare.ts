/**
 * 电商话术 Prompt 变体效果对比（可复现入口）。
 *
 * 为什么单独做成脚本：
 *   「Prompt 变体对比」是 JD 第 4 条（AI 工具/Prompt 的测试与优化）的核心交付，
 *   但它依赖 LLM，跑一次要花真实额度。做成脚本后：
 *     - 任何人 `bun run ecom:compare` 就能复现同一组对比
 *     - 结果落盘到 benchmarks/e2e/prompt-comparison.md，可进版本库做「历次对比」
 *     - 换商家样本/换变体只改这一处，不改库代码
 *
 * 用法：
 *   bun run ecom:compare              # 用内置 3 家样本商家
 *   bun run ecom:compare <in.csv>     # 用真实导出的 CSV（先清洗打标再对比）
 */
import fs from 'node:fs'
import path from 'node:path'
import { compareVariants, formatComparison } from '../src/lib/ecom/script'
import { diagnose } from '../src/lib/ecom/diagnosis'
import { tagMerchant, type MerchantRecord } from '../src/lib/ecom/tagging'
import { runPipelineFromCsv } from '../src/lib/ecom/pipeline'
import { chatStream } from '../src/lib/agent/llm'

const OUT_DIR = path.resolve(process.cwd(), 'benchmarks/e2e')
const OUT_MD = path.join(OUT_DIR, 'prompt-comparison.md')

/** 内置样本：刻意覆盖「高价值+风险」「中等+有诉求」「健康+想增长」三种典型情形 */
const SAMPLE: MerchantRecord[] = [
  { id: 'M001', name: '轻语女装', monthlyGmv: 220_000, conversionRate: 0.012, refundRate: 0.15, avgResponseSec: 95, traffic: 4200, note: '商家说转化率低、退款多' },
  { id: 'M002', name: '食光零食铺', monthlyGmv: 80_000, conversionRate: 0.018, refundRate: 0.06, avgResponseSec: 40, traffic: 2600, note: '想做直播但不会' },
  { id: 'M003', name: '木言家居', monthlyGmv: 600_000, conversionRate: 0.03, refundRate: 0.05, avgResponseSec: 25, traffic: 9000, note: '经营健康想争取大促' },
]

async function main() {
  // 0) 前置：LLM 必须可用，否则整个对比没有意义 —— 明确报错而不是输出空表
  try {
    await chatStream([{ role: 'user', content: '回复 OK' }], undefined, {}, { enableThinking: false })
  } catch (e) {
    console.error('✗ LLM 不可用，无法进行 Prompt 对比：', e instanceof Error ? e.message : String(e))
    process.exit(2)
  }

  // 1) 取样本：优先用传入的 CSV（走真实全链路），否则用内置样本
  //    支持 --repeat N：LLM 输出有随机性，单次对比的排名不可靠（实测 n=3 时
  //    「结构约束式」与「角色扮演式」会在两次运行间互换第一）。重复 N 次取均值才有意义。
  const args = process.argv.slice(2)
  const repeatIdx = args.findIndex((a) => a === '--repeat')
  const repeat = repeatIdx >= 0 ? Math.max(1, Number(args[repeatIdx + 1]) || 1) : 1
  const csvPath = args.find((a) => !a.startsWith('--') && a !== String(repeat))
  let records: MerchantRecord[] = SAMPLE
  if (csvPath) {
    if (!fs.existsSync(csvPath)) {
      console.error(`✗ 找不到 CSV：${csvPath}`)
      process.exit(2)
    }
    const r = runPipelineFromCsv(fs.readFileSync(csvPath, 'utf8'))
    records = r.enriched.map((e) => e.record)
    console.log(`已从 ${path.basename(csvPath)} 清洗出 ${records.length} 条记录（去重/异常值已处理）\n`)
  }

  // 2) 话术输入 = 打标 + 诊断（让模型「有据可依」，而不是凭空创作）
  const reqs = records.map((m) => ({
    merchantId: m.id,
    merchantName: m.name,
    intent: 'diagnose' as const,
    tags: tagMerchant(m).tags,
    diagnosis: diagnose(m),
  }))

  console.log(`开始对比 ${reqs.length} 家商家 × 3 个 Prompt 变体${repeat > 1 ? ` × ${repeat} 轮` : ''} …\n`)
  const started = Date.now()
  const runs: Awaited<ReturnType<typeof compareVariants>>[] = []
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.log(`—— 第 ${i + 1}/${repeat} 轮 ——`)
    runs.push(await compareVariants(reqs, undefined, 3))
  }
  const elapsed = Date.now() - started

  // 3) 汇总：单轮直接用 formatComparison；多轮则按变体聚合均值与波动范围
  const last = runs[runs.length - 1]
  let text: string
  if (repeat === 1) {
    text = formatComparison(last)
  } else {
    const agg = new Map<string, { name: string; scores: number[]; violations: number[]; samples: number }>()
    for (const r of runs) {
      for (const v of r.variants) {
        const cur = agg.get(v.variantId) ?? { name: v.variantName, scores: [], violations: [], samples: 0 }
        cur.scores.push(v.avgScore)
        cur.violations.push(v.violationRate)
        cur.samples += v.samples
        agg.set(v.variantId, cur)
      }
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
    const rows = [...agg.entries()]
      .map(([id, a]) => ({ id, name: a.name, mean: mean(a.scores), min: Math.min(...a.scores), max: Math.max(...a.scores), viol: mean(a.violations), samples: a.samples }))
      .sort((x, y) => y.mean - x.mean)
    const w = Math.max(...rows.map((r) => r.name.length))
    const out: string[] = []
    out.push(`Prompt 变体效果对比（${repeat} 轮重复，n=${reqs.length} 商家/轮）`)
    out.push('='.repeat(56))
    for (const r of rows) {
      out.push(
        `${r.name.padEnd(w + 2)}均值 ${r.mean.toFixed(2)}  区间 ${r.min.toFixed(2)}~${r.max.toFixed(2)}  违规率 ${(r.viol * 100).toFixed(0)}%  (n=${r.samples})`,
      )
    }
    out.push('')
    const spread = rows[0].max - rows[0].min
    out.push(
      `结论：「${rows[0].name}」均值最优（${rows[0].mean.toFixed(2)}，区间 ${rows[0].min.toFixed(2)}~${rows[0].max.toFixed(2)}）。` +
        (spread >= 0.06
          ? `注意：该变体单轮波动达 ${spread.toFixed(2)}，${repeat} 轮仍不足以稳定区分第一梯队，需加大样本或轮数。`
          : `波动 ${spread.toFixed(2)}，排序相对稳定。`),
    )
    text = out.join('\n')
  }
  console.log(text)

  // 4) 落盘：含结论 + 各变体样例，便于人工判断「哪句像人话」
  const lines: string[] = []
  lines.push('# 电商话术 Prompt 变体效果对比')
  lines.push('')
  lines.push(
    `> 生成时间：${new Date().toISOString()}　｜　样本：${reqs.length} 家商家　｜　轮数：${repeat}　｜　耗时：${(elapsed / 1000).toFixed(1)}s`,
  )
  lines.push('> 复现命令：`bun run ecom:compare`（或 `bun run ecom:compare <清洗后的CSV> --repeat 3`）')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('```')
  lines.push(text)
  lines.push('```')
  lines.push('')
  lines.push('## 各变体生成样例')
  lines.push('')
  for (const v of last.variants) {
    lines.push(`### ${v.variantName}（质量分 ${v.avgScore.toFixed(2)}，成功率 ${(v.successRate * 100).toFixed(0)}%）`)
    lines.push('')
    const first = v.details.find((d) => d.text)
    if (first) {
      lines.push(`> 商家：${first.merchantId}`)
      lines.push('')
      lines.push(first.text!.trim())
      lines.push('')
    } else {
      lines.push('（本次未产出内容）')
      lines.push('')
    }
  }
  lines.push('## 口径说明')
  lines.push('')
  lines.push('- **质量分**：5 项自动质检的加权得分（含具体数据 / 有下一步动作 / 不空泛 / 不承诺结果 / 不索要敏感信息）')
  lines.push('- **违规率**：命中 SOP 硬红线（承诺无法保证的结果、索要账号密码）的比例 —— 这是**一票否决**项')
  lines.push('- **成功率**：变体产出非空话术的比例；失败通常是 LLM 不可用或超时，不计入质量分')
  lines.push('- ⚠️ **单次运行的排名不可信**：LLM 输出有随机性，实测 n=3 时「结构约束式」与「角色扮演式」')
  lines.push('  会在两次运行间互换第一。判断哪个 Prompt 更好应加 `--repeat 3` 以上取均值 + 看波动区间。')
  lines.push('- ⚠️ 样本量小（n=' + reqs.length + '），只作**变体间相对排序**的依据，不代表线上效果；')
  lines.push('  线上效果需以真实转化/回复率为准，这里只解决「哪个 Prompt 更少犯低级错误」')
  lines.push('')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8')
  console.log(`\n报告已写入 ${path.relative(process.cwd(), OUT_MD)}`)
}

main().catch((e) => {
  console.error('运行失败：', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
