/**
 * 电商服务商工作台 CLI：批量处理商家数据。
 *
 * 真实场景里服务商是**批量跑**的，不是一个个点界面：
 *   bun run ecom <输入.csv> [输出.csv]
 *
 * 一条命令完成：读取 → 清洗 → 打标 → 诊断 → 导出。
 * 这是从「能演示」到「能上手用」的关键一步。
 *
 * 不带参数时跑内置的脏数据样例（演示清洗能力）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runPipelineFromCsv, formatPipeline, exportEnriched } from '../src/lib/ecom/pipeline'
import { formatQualityReport } from '../src/lib/ecom/cleaning'

/** 演示用脏数据：覆盖 BOM / 全角％ / 千分位 / 中文单位 / 空值不一 / 重复 / 异常值 / 未加引号逗号 */
const DEMO_CSV = '\ufeff商家ID,商家名称,月GMV,转化率,退款率,响应时长,进店量,跟进记录,阶段\n' +
  'M001,"轻语女装, 旗舰店","¥220,000",1.2%,15%,95,4200,商家说转化率低、退款多,有意向\n' +
  'M002,食光零食铺,8万,1.8％,6%,40,2600,想做直播但不会,已联系\n' +
  'M003,木言家居,123.4万,3.2%,5%,25,9200,经营健康，想争取大促资源位,已签约\n' +
  'M004,小满数码,-5000,2.1%,7%,35,1100,同行压价厉害利润薄,-\n' +
  'M005,柔光美妆,150000,0.9%,150%,120,5400,光看不买，加购不买,N/A\n' +
  'M006,新芽食品,12000,,,,,刚入驻很多数据还没有,待触达\n' +
  'M002,食光零食铺,8万,1.8%,6%,40,2600,重复录入的一条,已联系\n'

const argv = process.argv.slice(2)
const inFile = argv[0]
const outFile = argv[1]

let csv: string
let sourceLabel: string
if (inFile) {
  if (!fs.existsSync(inFile)) {
    console.error(`✗ 文件不存在：${inFile}`)
    process.exit(1)
  }
  csv = fs.readFileSync(inFile, 'utf-8')
  sourceLabel = inFile
} else {
  csv = DEMO_CSV
  sourceLabel = '(内置脏数据样例)'
}

console.log(`\n电商服务商工作台｜数据源：${sourceLabel}\n`)

const result = runPipelineFromCsv(csv)

console.log(formatQualityReport(result.cleaning.report))
console.log('\n' + '='.repeat(60) + '\n')
console.log(formatPipeline(result))

// 清洗留痕（只打印前几条，避免刷屏）
if (result.cleaning.fixes.length) {
  console.log('\n清洗动作明细（前 8 条，供运营复核）：')
  for (const f of result.cleaning.fixes.slice(0, 8)) {
    console.log(`  ${f.merchantId}.${f.field}：${f.from} → ${f.to}（${f.reason}）`)
  }
}

// 导出
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  fs.writeFileSync(outFile, exportEnriched(result.enriched), 'utf-8')
  console.log(`\n✓ 已导出打标+诊断结果：${outFile}（${result.enriched.length} 条，含 BOM 可直接用 Excel 打开）`)
} else {
  console.log('\n提示：传入第二个参数可导出结果表，如：bun run ecom data.csv out.csv')
}

// 有结构性问题时以非 0 退出，便于脚本化流程感知数据有问题
process.exit(result.structuralIssues.length ? 2 : 0)
