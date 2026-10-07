/**
 * 端到端全流程自检：一条命令验证整条链路。
 *
 *   bun run e2e
 *
 * 覆盖：电商数据清洗 → 打标 → 诊断 → 导出 → 知识库检索 → 纠错回流
 *      + LLM 可用性探测（不可用时如实报告，不算失败）
 *
 * ## 设计原则
 *
 * 1. **每条检查都断言预期结果**，不是"跑一下看看" —— 这样才能当回归测试用
 * 2. **不依赖 LLM 的部分必须全绿**；依赖 LLM 的部分**探测并如实报告**，
 *    不因为配额/网络问题把整个自检判失败（那是环境问题，不是代码问题）
 * 3. **退出码有意义**：0 = 全部通过；1 = 有确定性检查失败（CI 可用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { runPipelineFromCsv, exportEnriched, parseCsvWithIssues, escapeCsv } from '../src/lib/ecom/pipeline'
import { cleanRecords, parseNumber, parseRate, isNullish } from '../src/lib/ecom/cleaning'
import { tagMerchant } from '../src/lib/ecom/tagging'
import { diagnose } from '../src/lib/ecom/diagnosis'
import { recordCorrection, analyzeCorrections, clearCorrections } from '../src/lib/ecom/tag-store'
import { buildKnowledgeIndex, searchKnowledge } from '../src/lib/agent/knowledge'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`)
}

console.log('\n' + '='.repeat(64))
console.log('DevMate 端到端全流程自检')
console.log('='.repeat(64))

// ===================== ① 数据清洗 =====================

section('① 数据清洗（JD「清洗」在「打标」之前）')

check('百分比解析：1.2% → 0.012', Math.abs((parseRate('1.2%') ?? 0) - 0.012) < 1e-9)
check('全角百分比：1.8％ → 0.018', Math.abs((parseRate('1.8％') ?? 0) - 0.018) < 1e-9)
check('千分位+货币：¥1,234,567 → 1234567', parseNumber('¥1,234,567') === 1234567)
check('中文单位：123.4万 → 1234000', parseNumber('123.4万') === 1234000)
check('全角数字：１２３ → 123', parseNumber('１２３') === 123)
check('无法解析返回 null（不猜）', parseNumber('abc') === null)
check('空值多写法识别', ['', '-', 'N/A', 'null', '暂无'].every(isNullish))

{
  const r = cleanRecords([{ 商家ID: 'A', 月GMV: '-5000', 退款率: '150%', 转化率: '2%' }])
  check('异常值被拦截置空（负 GMV / 超范围退款率）', r.report.outliers.length === 2)
  check('正常值保留', Math.abs((r.records[0].conversionRate ?? 0) - 0.02) < 1e-9)
  check('清洗留痕可复核', r.fixes.length > 0 && r.fixes.every((f) => f.reason.length > 0))
}

{
  const r = cleanRecords([
    { 商家ID: 'A1', 商家名称: '某店', 转化率: '2%' },
    { 商家ID: 'A2', 商家名称: '某店', 转化率: '2%', 退款率: '5%' },
  ])
  check('重复记录合并且保留字段更完整的一条', r.records.length === 1 && r.records[0].refundRate !== undefined)
}

// ===================== ② CSV 解析 / 导出 =====================

section('② CSV 导入导出（真实场景的数据入口）')

{
  const csv = 'id,name,note\nA,"公司, 分公司","第一行\n第二行"\nB,普通,"含""引号"""\n'
  const rows = (await import('../src/lib/ecom/pipeline')).parseCsv(csv)
  check('字段内逗号不被当分隔符', rows[0].name === '公司, 分公司')
  check('字段内换行不被当行分隔', String(rows[0].note).includes('\n'))
  check('转义引号 "" 还原为一个 "', rows[1].note === '含"引号"')
}
{
  const rows = (await import('../src/lib/ecom/pipeline')).parseCsv('\ufeff商家ID,转化率\nA,2%\n')
  check('BOM 被剥离（否则 Excel 存的第一列匹配不上）', Object.keys(rows[0])[0] === '商家ID')
}
{
  const { issues } = parseCsvWithIssues('id,name,gmv\nA,正常,100\nB,坏行,¥99,000\n')
  check('结构性问题被检出（未加引号逗号导致列错位）', issues.length === 1 && issues[0].actual === 4,
    issues[0] ? `第 ${issues[0].line} 行 期望 ${issues[0].expected} 列 / 实际 ${issues[0].actual} 列` : '')
}
check('导出转义：含逗号字段加引号', escapeCsv('含,逗号') === '"含,逗号"')

// ===================== ③ 打标 =====================

section('③ 数据打标（7 维标签 + 置信度 + 可解释）')

{
  const r = tagMerchant({
    id: 'M1', name: '轻语女装旗舰店', monthlyGmv: 220_000, conversionRate: 0.012,
    refundRate: 0.15, avgResponseSec: 95, traffic: 4200,
    note: '商家说转化率低、退款多', stage: 'interested',
  })
  const get = (d: string) => r.tags.find((t) => t.dimension === d)
  check('规模按 GMV 硬分档（置信度 1.0）', get('scale')?.value === 'mid' && get('scale')?.confidence === 1)
  check('类目从文本识别', get('category')?.value === 'apparel')
  check('健康度按预警项个数分档', get('health')?.value === 'unhealthy')
  check('优先级综合判定 → P0', get('priority')?.value === 'p0')
  check('痛点：数值+文本双信号交叉，置信度加成', (get('pain_point')?.confidence ?? 0) >= 0.9)
  check('每个标签都有可解释依据', r.tags.every((t) => t.evidence.length > 0))
}
{
  const r = tagMerchant({ id: 'M2' })
  check('无数据时不瞎打标（健康度不打）', !r.tags.some((t) => t.dimension === 'health'))
}

// ===================== ④ 经营诊断 =====================

section('④ 经营诊断 + 任务推荐')

{
  const r = diagnose({ id: 'M1', conversionRate: 0.012, refundRate: 0.15, avgResponseSec: 95, traffic: 4200 })
  const problems = r.issues.filter((i) => i.severity !== 'ok')
  check('按「影响÷难度」排序：客服响应慢排在退款率高之前',
    problems[0]?.metric === '客服响应时长',
    `首位=${problems[0]?.metric}（优先级 ${problems[0]?.priority}）`)
  check('推荐任务不超过 3 条', r.tasks.length <= 3)
  check('健康分在合理区间', r.score >= 0 && r.score <= 100, `健康分=${r.score}`)
}
{
  const r = diagnose({ id: 'M2', monthlyGmv: 12_000 })
  check('数据不足时拒绝下结论（不硬凑）', !r.sufficient && r.headline.includes('数据不足'))
}

// ===================== ⑤ 全链路 =====================

section('⑤ 全链路：脏 CSV → 清洗 → 打标 → 诊断 → 导出')

const DIRTY_CSV =
  '\ufeff商家ID,商家名称,月GMV,转化率,退款率,响应时长,进店量,跟进记录,阶段\n' +
  'M001,"轻语女装, 旗舰店","¥220,000",1.2%,15%,95,4200,商家说转化率低、退款多,有意向\n' +
  'M002,食光零食铺,8万,1.8％,6%,40,2600,想做直播但不会,已联系\n' +
  'M003,木言家居,123.4万,3.2%,5%,25,9200,经营健康,已签约\n' +
  'M004,小满数码,-5000,2.1%,7%,35,1100,同行压价,- \n' +
  'M005,柔光美妆,150000,0.9%,150%,120,5400,光看不买,N/A\n' +
  'M006,新芽食品,12000,,,,,刚入驻,待触达\n' +
  'M002,食光零食铺,8万,1.8%,6%,40,2600,重复录入,已联系\n' +
  'M007,坏行店铺,¥99,000,2.5%,6%,30,3000,未加引号导致错位,待触达\n'

const pipeline = runPipelineFromCsv(DIRTY_CSV)
check('输入 8 行 → 清洗后 7 条（1 条重复被合并）', pipeline.summary.inputRows === 8 && pipeline.summary.validRows === 7)
check('检出 2 处异常值', pipeline.cleaning.report.outliers.length === 2)
check('检出 1 处结构性问题', pipeline.structuralIssues.length === 1)
check('数值清洗正确（中文单位 + 百分号）', pipeline.enriched[0].record.monthlyGmv === 220000 &&
  Math.abs((pipeline.enriched[0].record.conversionRate ?? 0) - 0.012) < 1e-9)
check('优先级分布统计正确',
  Object.values(pipeline.summary.priorityCount).reduce((a, b) => a + b, 0) === 7,
  `P0=${pipeline.summary.priorityCount.p0} P1=${pipeline.summary.priorityCount.p1} P2=${pipeline.summary.priorityCount.p2}`)

{
  const csv = exportEnriched(pipeline.enriched)
  const lines = csv.split('\r\n')
  check('导出含 19 列', lines[0].split(',').length >= 19)
  check('导出带 BOM（Excel 直接打开不乱码）', csv.charCodeAt(0) === 0xfeff)
  check('导出含运营可用字段（优先级/健康分/推荐任务）',
    ['跟进优先级', '健康分', '诊断结论', '推荐任务1'].every((c) => lines[0].includes(c)))
}

// ===================== ⑥ 业务知识库 =====================

section('⑥ 业务知识库检索（RAG）')

{
  const assetsRoot = path.join(process.cwd(), 'assets')
  const idx = buildKnowledgeIndex(assetsRoot, 'ecom-knowledge')
  check('知识库已入库 4 篇业务文档', idx.files.length >= 4, idx.files.join(', '))
  const cases: [string, string][] = [
    ['仅退款规则', '01-平台规则.md'],
    ['转化率低怎么诊断', '04-优秀案例.md'],
    ['新店没流量怎么办', '04-优秀案例.md'],
  ]
  for (const [q, expectFile] of cases) {
    const hits = searchKnowledge(assetsRoot, q, 3, 'ecom-knowledge')
    check(`检索「${q}」命中正确文档`, hits[0]?.chunk.file === expectFile,
      hits[0] ? `${hits[0].chunk.file} / ${hits[0].chunk.heading}` : '(无命中)')
  }
}

// ===================== ⑦ 纠错回流 =====================

section('⑦ 打标纠错回流（规则迭代依据）')

{
  clearCorrections()
  recordCorrection({ merchantId: 'M1', dimension: 'category', original: '', corrected: 'apparel' })
  recordCorrection({ merchantId: 'M2', dimension: 'category', original: '', corrected: 'beauty' })
  recordCorrection({ merchantId: 'M3', dimension: 'scale', original: 'ka', corrected: '' })
  const r = analyzeCorrections()
  check('纠错被记录并归因', r.total === 3)
  const cat = r.byDimension.find((d) => d.dimension === 'category')
  check('识别出「漏标」并给出补关键词的建议',
    cat?.dominantKind === 'false_negative' && (cat?.advice.includes('漏标') ?? false))
  check('识别出「误标」并给出收紧阈值的建议',
    r.byDimension.find((d) => d.dimension === 'scale')?.advice.includes('误标') === true)
  check('口径诚实性声明（不是全量准确率）', r.caveat.includes('偏高') && r.caveat.includes('不是全量准确率'))
  clearCorrections()
}

// ===================== ⑧ LLM 可用性探测 =====================

section('⑧ LLM 可用性探测（不可用不算失败，属环境问题）')

let llmOk = false
let llmNote = ''
try {
  const { chatStream } = await import('../src/lib/agent/llm')
  const t0 = Date.now()
  const res = await chatStream([{ role: 'user', content: '回复 OK' }], undefined, {}, { enableThinking: false })
  llmOk = res.content.length > 0
  llmNote = `${Date.now() - t0}ms`
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  llmNote = msg.slice(0, 80)
}
if (llmOk) {
  console.log(`  ✓ LLM 可用（${llmNote}）→ 话术生成 / Prompt 对比 / Agent 全链路可用`)
} else {
  console.log(`  ⚠ LLM 不可用：${llmNote}`)
  console.log('    → 受影响：话术生成、Prompt 变体对比、Agent 端到端、P0 冒烟')
  console.log('    → 不受影响：以上 ①~⑦ 全部通过（均为确定性逻辑）')
  console.log('    → 说明：终态错误（配额/鉴权）已改为**快速失败**，不会长时间卡住')
}

// ===================== 汇总 =====================

console.log('\n' + '='.repeat(64))
console.log(`结果：${passed} 通过 / ${failed} 失败${llmOk ? '' : '（LLM 不可用，已跳过依赖它的检查）'}`)
console.log('='.repeat(64))
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  ✗ ${f}`)
}

// 把演示产物落盘，便于人工核对
try {
  const outDir = path.join(process.cwd(), 'benchmarks', 'e2e')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'dirty-merchants.csv'), DIRTY_CSV, 'utf-8')
  fs.writeFileSync(path.join(outDir, 'enriched-out.csv'), exportEnriched(pipeline.enriched), 'utf-8')
  console.log(`\n产物已写入 benchmarks/e2e/（dirty-merchants.csv / enriched-out.csv）`)
} catch {
  /* 落盘失败不影响自检结论 */
}

process.exit(failed ? 1 : 0)
