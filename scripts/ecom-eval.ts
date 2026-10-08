/**
 * 电商评测 CLI：跑金标准 + 挑战集 + 阈值校准，输出指标报告并落盘。
 *
 * 用法：
 *   bun run ecom:eval                # 跑回归集 + 挑战集 + 校准
 *   bun run ecom:eval --no-calibrate # 跳过校准（校准要跑上千次组合，稍慢）
 *
 * 产物：benchmarks/ecom-eval/report.md
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  calibrate, evaluateTagging, formatCalibration, formatTaggingEval,
} from '../src/lib/ecom/evaluate'
import { CHALLENGE_SET, GOLDEN_SET } from '../src/lib/ecom/golden'
import { DEFAULT_THRESHOLDS, describeThresholds } from '../src/lib/ecom/thresholds'

const OUT_DIR = path.resolve(process.cwd(), 'benchmarks/ecom-eval')
const OUT_MD = path.join(OUT_DIR, 'report.md')

function main() {
  const skipCalibrate = process.argv.includes('--no-calibrate')

  console.log('当前口径：')
  console.log(describeThresholds(DEFAULT_THRESHOLDS).split('\n').map((l) => '  ' + l).join('\n'))
  console.log()

  const regression = evaluateTagging(DEFAULT_THRESHOLDS, GOLDEN_SET)
  const challenge = evaluateTagging(DEFAULT_THRESHOLDS, CHALLENGE_SET)

  console.log('─'.repeat(64))
  console.log('【回归集】锁定口径，防止改动引入回归')
  console.log('─'.repeat(64))
  console.log(formatTaggingEval(regression))
  console.log()

  console.log('─'.repeat(64))
  console.log('【挑战集】测真实语言变体上的泛化能力（这才是诚实的能力上限）')
  console.log('─'.repeat(64))
  console.log(formatTaggingEval(challenge))
  console.log()

  let calibText = ''
  if (!skipCalibrate) {
    console.log('─'.repeat(64))
    console.log('【阈值校准】网格搜索')
    console.log('─'.repeat(64))
    const calib = calibrate(GOLDEN_SET, DEFAULT_THRESHOLDS)
    calibText = formatCalibration(calib)
    console.log(calibText)
    console.log()
  }

  const md: string[] = []
  md.push('# 电商打标/诊断 评测报告')
  md.push('')
  md.push(`> 生成时间：${new Date().toISOString()}`)
  md.push('> 复现命令：`bun run ecom:eval`')
  md.push('')
  md.push('## 评测设计')
  md.push('')
  md.push('| 集合 | 作用 | 说明 |')
  md.push('|---|---|---|')
  md.push(`| **回归集**（${GOLDEN_SET.length} 条） | 锁定口径 | 按同一份口径标注，**预期全对**；任何不一致都是回归缺陷 |`)
  md.push(`| **挑战集**（${CHALLENGE_SET.length} 条） | 测泛化 | 用真实口语变体（同义词/否定/文本数字）**故意为难规则** |`)
  md.push('')
  md.push('> ⚠️ **只看回归集的 100% 是自欺**：金标准与规则同源，属于循环论证。')
  md.push('> 真实能力要看**挑战集** —— 那里的失败才是可改进的空间。')
  md.push('')
  md.push('## 当前口径')
  md.push('')
  md.push('```')
  md.push(describeThresholds(DEFAULT_THRESHOLDS))
  md.push('```')
  md.push('')
  md.push('## 回归集结果')
  md.push('')
  md.push('```')
  md.push(formatTaggingEval(regression))
  md.push('```')
  md.push('')
  md.push('## 挑战集结果')
  md.push('')
  md.push('```')
  md.push(formatTaggingEval(challenge))
  md.push('```')
  md.push('')
  if (calibText) {
    md.push('## 阈值校准')
    md.push('')
    md.push('```')
    md.push(calibText)
    md.push('```')
    md.push('')
  }
  md.push('## 已知能力边界（不修，如实记录）')
  md.push('')
  md.push('| 边界 | 例子 | 为什么不在规则层修 | 正解 |')
  md.push('|---|---|---|---|')
  md.push('| 否定句 | 「已经没有仅退款问题了」被判为退款率高 | 关键词规则无法识别否定 | 接 LLM 兜底或引入否定检测 |')
  md.push('| 时态/改善语义 | 「之前退款多，现在已经降下来了」 | 同上 | 同上 |')
  md.push('| 文本内数字 | 「客服响应要 120 秒」不触发响应慢 | 规则只读结构化字段 | 文本数值抽取（正则 + 上下文）|')
  md.push('')
  md.push('**为什么如实记录而不隐藏**：这三类是关键词规则的**本质局限**，')
  md.push('不是「再补几个词」能解决的。把边界写清楚，才知道什么时候必须上 LLM。')
  md.push('')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8')
  console.log(`报告已写入 ${path.relative(process.cwd(), OUT_MD)}`)

  // 挑战集若出现「非已知边界」的失败，视为回归 → 非 0 退出，便于 CI
  const knownBoundary = new Set(['C03', 'C04', 'C09'])
  const unexpected = challenge.mismatches.filter((m) => !knownBoundary.has(m.id))
  if (unexpected.length) {
    console.error(`\n✗ 挑战集出现 ${unexpected.length} 处「非已知边界」失败（可能是回归）：`)
    for (const m of unexpected) console.error(`   ${m.id} [${m.dimension}] 人工=${m.expected} 规则=${m.predicted}`)
    process.exit(1)
  }
  if (regression.mismatches.length) {
    console.error(`\n✗ 回归集出现 ${regression.mismatches.length} 处不一致（口径回归）`)
    process.exit(1)
  }
  console.log('\n✓ 回归集全对；挑战集仅剩 3 处已知能力边界')
}

main()
